// CetaMesh Desktop —— 更新检查（阶段 12 / 分发运行时 v1）。
//
// 设计红线（保持阶段 12，不放开静默安装）：
//   - 只做「检查」：返回是否有新版、release notes、下载链接（含 sha256）以及交给用户确认的 installer handoff；
//   - **没有** download / execute / install / run 这类方法（测试会断言它们不存在）。
//     下载是独立模块 `download.js`（只下载 + SHA256 校验 + 原子落盘，从不执行），本模块不发起下载；
//   - 任何失败（网络、解析、验签、主机白名单、版本回退）都以结构化结果返回，**绝不抛给调用方**；
//   - 构造时不发起任何网络请求（惰性检查）。
//
// 多更新源（UpdateSource）：
//   - 按优先级依次尝试（默认部署：GitCode → GitHub，见 sources.js）；
//   - 某个源返回**合法且验签通过**的清单时，其判定即权威：合法「无更新」直接返回，不再访问后续源；
//   - 源不可用（超时 / 非 2xx / 清单损坏 / 验签失败 / 缺本平台安装包 / 下载主机被拒）
//     一律**结构化记录**并降级到下一个源；全部失败时返回每个源的结构化失败（sources 数组），
//     **绝不**把 404 / JSON 损坏 / SHA 不匹配静默当作「无更新」。

import { compareVersions, hostAllowedForDownload, selectArtifact, validateManifest } from './manifest.js';
import { compareReleaseVersions } from '../release/version.js';
import { DEFAULT_SOURCE_TIMEOUT_MS, buildUpdateSources } from './sources.js';
import { verifyManifestSignature } from './verify.js';

const DEFAULT_TIMEOUT_MS = DEFAULT_SOURCE_TIMEOUT_MS;
const MAX_BODY_CHARS = 256 * 1024;
const DEFAULT_PLATFORM = 'windows-x64';

function ok(payload) {
  return { ok: true, ...payload };
}
function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// Public configuration readiness only; never expose the key itself to the UI.
export function updateConfigurationIssue(config = {}) {
  if (!buildUpdateSources(config).length) {
    return { code: 'NO_MANIFEST_URL', message: '发行方尚未配置更新清单地址，请前往官方发布页查看版本。' };
  }
  if (!config.pinnedPublicKey || !String(config.pinnedPublicKey).trim()) {
    return { code: 'NO_PINNED_KEY', message: '发行方尚未配置更新签名公钥，软件内更新检查暂不可用。请前往官方发布页查看版本。' };
  }
  return null;
}

export function createUpdateChecker({
  currentVersion,
  currentBuildNumber = 0,
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!currentVersion || typeof currentVersion !== 'string') {
    throw new Error('createUpdateChecker 需要 currentVersion（单一事实源：package.json）');
  }
  if (!Number.isSafeInteger(Number(currentBuildNumber)) || Number(currentBuildNumber) < 0) {
    throw new Error('createUpdateChecker requires a non-negative currentBuildNumber');
  }
  currentBuildNumber = Number(currentBuildNumber);
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  /** 单个源：取回并解析 JSON。不判断内容语义；失败返回结构化 code（不抛出）。 */
  async function fetchSourceManifest(source, timeout, allowedHosts) {
    let parsedUrl;
    try {
      parsedUrl = new URL(String(source.manifestUrl));
    } catch {
      return { ok: false, code: 'NO_MANIFEST_URL', message: source.id + ' 更新清单地址非法' };
    }
    if (parsedUrl.protocol !== 'https:') {
      return { ok: false, code: 'INSECURE_MANIFEST_URL', message: source.id + ' 更新清单必须走 https' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(500, timeout));
      try {
        let response;
        for (let redirects = 0; ; redirects += 1) {
          response = await doFetch(parsedUrl.toString(), {
            method: 'GET', headers: { accept: 'application/json' },
            signal: controller.signal, redirect: 'manual'
          });
          if (![301, 302, 303, 307, 308].includes(response?.status)) break;
          await response.body?.cancel();
          if (redirects >= 5) return { ok: false, code: 'TOO_MANY_REDIRECTS', message: source.id + ' 更新清单重定向超过上限' };
          const location = response.headers?.get?.('location');
          if (!location) return { ok: false, code: 'REDIRECT_INVALID', message: source.id + ' 更新清单重定向缺少地址' };
          let target;
          try { target = new URL(location, parsedUrl); }
          catch { return { ok: false, code: 'REDIRECT_INVALID', message: source.id + ' 更新清单重定向地址非法' }; }
          if (target.protocol !== 'https:') return { ok: false, code: 'REDIRECT_INSECURE', message: source.id + ' 更新清单禁止降级 HTTPS' };
          if (target.username || target.password) return { ok: false, code: 'REDIRECT_INVALID', message: source.id + ' 更新清单重定向不得携带凭据' };
          if (target.host !== parsedUrl.host && !hostAllowedForDownload(target.href, allowedHosts)) {
            return { ok: false, code: 'REDIRECT_HOST_NOT_ALLOWED', message: source.id + ' 更新清单重定向来源未授权' };
          }
          parsedUrl = target;
        }
        if (!response || response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            code: 'HTTP_ERROR',
            message: source.id + ' 更新服务返回 ' + (response ? response.status : '无响应')
          };
        }
        const body = await response.text();
        if (typeof body !== 'string' || body.length > MAX_BODY_CHARS) {
          return { ok: false, code: 'BODY_INVALID', message: source.id + ' 更新清单响应体异常' };
        }
        let raw;
        try {
          raw = JSON.parse(body);
        } catch {
          return { ok: false, code: 'BODY_INVALID', message: source.id + ' 更新清单不是合法 JSON' };
        }
        return { ok: true, raw };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      return {
        ok: false,
        code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: source.id + ' 检查更新失败：' + ((error && error.message) || String(error))
      };
    }
  }

  async function check({
    manifestUrl,
    fallbackManifestUrl,
    sources,
    pinnedPublicKey,
    channel = 'stable',
    allowedHosts = [],
    timeout = timeoutMs,
    current = currentVersion,
    currentBuild = currentBuildNumber,
    platform = DEFAULT_PLATFORM
  } = {}) {
    const list = buildUpdateSources({ manifestUrl, fallbackManifestUrl, sources });
    const configurationIssue = updateConfigurationIssue({ manifestUrl, fallbackManifestUrl, sources, pinnedPublicKey });
    if (configurationIssue) return fail(configurationIssue.code, configurationIssue.message, { status: 'not_configured' });
    if (!doFetch) return fail('NO_FETCH', '当前运行时不支持网络请求');

    const failures = [];
    for (const source of list) {
      const fetched = await fetchSourceManifest(source, timeout, allowedHosts);
      if (!fetched.ok) {
        failures.push({ id: source.id, code: fetched.code, message: fetched.message });
        continue;
      }

      const validated = validateManifest(fetched.raw);
      if (!validated.ok) {
        failures.push({ id: source.id, code: validated.issues[0].code, message: validated.issues[0].message });
        continue;
      }

      // 先验签，再看内容 —— 未通过验签的清单连 notes 都不展示。
      // 注意：验签对象是**发布出来的那个对象**（raw），不是校验后的归一化结果。
      // 归一化会补齐/改写字段（例如 minVersion: null），拿它验签会导致发布侧与客户端
      // 对"签的是什么"产生分歧。归一化是 raw 的确定性函数，因此 raw 可信 => 结果可信。
      const signature = verifyManifestSignature(fetched.raw, pinnedPublicKey);
      if (!signature.ok) {
        failures.push({ id: source.id, code: signature.code, message: signature.message });
        continue;
      }

      // 到这里清单合法且可信 —— 该源的判定即权威，不再访问后续源。
      const manifest = validated.manifest;
      if (manifest.channel !== channel) {
        return ok({ updateAvailable: false, reason: 'CHANNEL_MISMATCH', source: source.id, channel, manifestChannel: manifest.channel });
      }
      if (manifest.minVersion && compareVersions(current, manifest.minVersion) < 0) {
        return fail('BELOW_MIN_VERSION', '当前版本 ' + current + ' 低于该更新要求的最低版本 ' + manifest.minVersion, {
          source: source.id
        });
      }

      const comparison = compareReleaseVersions(
        { productVersion: manifest.version, buildNumber: manifest.buildNumber },
        { productVersion: current, buildNumber: currentBuild }
      );
      if (comparison <= 0) {
        // 即使无更新也带上公告字段：About 页要显示「最近一次更新公告」，
        // 而这份清单此刻已经验签通过，是可信的 —— 不需要为了展示公告再请求一次网络。
        return ok({
          updateAvailable: false,
          reason: 'UP_TO_DATE',
          source: source.id,
          current,
          latest: manifest.version,
          currentBuildNumber: currentBuild,
          latestBuildNumber: manifest.buildNumber,
          title: manifest.title,
          publishedAt: manifest.publishedAt,
          notes: manifest.notes
        });
      }

      const artifact = selectArtifact(manifest, platform);
      if (!artifact) {
        failures.push({
          id: source.id,
          code: 'NO_PLATFORM_ARTIFACT',
          message: source.id + ' 清单没有 ' + platform + ' 平台的安装包'
        });
        continue;
      }
      if (!hostAllowedForDownload(artifact.url, allowedHosts)) {
        failures.push({
          id: source.id,
          code: 'DOWNLOAD_HOST_NOT_ALLOWED',
          message: '下载地址主机不在允许列表内：' + artifact.url
        });
        continue;
      }

      return ok({
        updateAvailable: true,
        source: source.id,
        current,
        latest: manifest.version,
        currentBuildNumber: currentBuild,
        latestBuildNumber: manifest.buildNumber,
        channel: manifest.channel,
        title: manifest.title,
        publishedAt: manifest.publishedAt,
        releasedAt: manifest.releasedAt,
        notes: manifest.notes,
        download: { url: artifact.url, sha256: artifact.sha256, bytes: artifact.bytes, filename: artifact.filename },
        // 交给用户确认的安装器接力信息；本模块不会去执行它。
        handoff: {
          kind: 'installer',
          requiresUserConfirmation: true,
          verify: 'sha256',
          sha256: artifact.sha256,
          note: '下载后请核对 sha256，并由你手动运行安装程序；CetaMesh 不会静默执行安装器。'
        }
      });
    }

    const first = failures[0] || { code: 'ALL_SOURCES_FAILED', message: '没有可用的更新源' };
    return fail(first.code, '所有更新源均失败：' + failures.map((item) => item.id + '=' + item.code).join('，'), {
      sources: failures,
      tried: list.map((item) => item.id)
    });
  }

  return {
    currentVersion,
    check,
    /** 只描述能力边界，便于 UI 与测试确认"没有下载/执行入口"。 */
    capabilities() {
      return {
        canCheck: true,
        canCompareVersions: true,
        canShowReleaseNotes: true,
        canHandoffToInstaller: true,
        canDownload: false,
        canExecuteInstaller: false,
        requiresPinnedKey: true
      };
    }
  };
}
