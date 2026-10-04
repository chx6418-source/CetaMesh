// CetaMesh Desktop —— 更新检查（阶段 12）。
//
// 设计红线：
//   - 只做「检查」：返回是否有新版、release notes、下载链接、以及交给用户确认的 installer handoff；
//   - **没有** download / execute / install / run 这类方法（测试会断言它们不存在）；
//   - 任何失败（网络、解析、验签、主机白名单、版本回退）都以结构化结果返回，**绝不抛给调用方**，
//     因此"网络异常"不会影响主应用启动或其它页面。
//   - 构造时不发起任何网络请求（惰性检查）。

import { compareVersions, hostAllowedForDownload, updateError, validateManifest } from './manifest.js';
import { verifyManifestSignature } from './verify.js';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 256 * 1024;

function ok(payload) {
  return { ok: true, ...payload };
}
function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

export function createUpdateChecker({
  currentVersion,
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!currentVersion || typeof currentVersion !== 'string') {
    throw new Error('createUpdateChecker 需要 currentVersion（单一事实源：package.json）');
  }
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  async function check({
    manifestUrl,
    pinnedPublicKey,
    channel = 'stable',
    allowedHosts = [],
    timeout = timeoutMs,
    current = currentVersion
  } = {}) {
    if (!manifestUrl || !String(manifestUrl).trim()) {
      return fail('NO_MANIFEST_URL', '未配置更新清单地址，已跳过检查');
    }
    if (!pinnedPublicKey || !String(pinnedPublicKey).trim()) {
      // 安全默认：没有固定公钥就不检查、不信任 —— 这属于配置状态，不是错误。
      return fail('NO_PINNED_KEY', '未配置更新签名公钥，已停用更新检查');
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(String(manifestUrl));
    } catch {
      return fail('NO_MANIFEST_URL', '更新清单地址非法');
    }
    if (parsedUrl.protocol !== 'https:') {
      return fail('INSECURE_MANIFEST_URL', '更新清单必须走 https');
    }
    if (!doFetch) return fail('NO_FETCH', '当前运行时不支持网络请求');

    let body;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(500, timeout));
      try {
        const response = await doFetch(parsedUrl.toString(), {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal
        });
        if (!response || response.status < 200 || response.status >= 300) {
          return fail('HTTP_ERROR', '更新服务返回 ' + (response ? response.status : '无响应'));
        }
        body = await response.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      return fail(aborted ? 'TIMEOUT' : 'NETWORK_ERROR', '检查更新失败：' + ((error && error.message) || String(error)));
    }

    if (typeof body !== 'string' || body.length > MAX_BODY_CHARS) {
      return fail('BODY_INVALID', '更新清单响应体异常');
    }
    let raw;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      return fail('BODY_INVALID', '更新清单不是合法 JSON');
    }

    const validated = validateManifest(raw);
    if (!validated.ok) {
      return fail(validated.issues[0].code, validated.issues[0].message);
    }
    const manifest = validated.manifest;

    // 先验签，再看内容 —— 未通过验签的清单连 notes 都不展示。
    // 注意：验签对象是**发布出来的那个对象**（raw），不是校验后的归一化结果。
    // 归一化会补齐/改写字段（例如 minVersion: null），拿它验签会导致发布侧与客户端
    // 对"签的是什么"产生分歧。归一化是 raw 的确定性函数，因此 raw 可信 => 结果可信。
    const signature = verifyManifestSignature(raw, pinnedPublicKey);
    if (!signature.ok) return fail(signature.code, signature.message);

    if (manifest.channel !== channel) {
      return ok({ updateAvailable: false, reason: 'CHANNEL_MISMATCH', channel, manifestChannel: manifest.channel });
    }
    if (manifest.minVersion && compareVersions(current, manifest.minVersion) < 0) {
      return fail('BELOW_MIN_VERSION', '当前版本 ' + current + ' 低于该更新要求的最低版本 ' + manifest.minVersion);
    }

    const comparison = compareVersions(manifest.version, current);
    if (comparison <= 0) {
      return ok({ updateAvailable: false, reason: 'UP_TO_DATE', current, latest: manifest.version });
    }

    if (!hostAllowedForDownload(manifest.downloadUrl, allowedHosts)) {
      return fail('DOWNLOAD_HOST_NOT_ALLOWED', '下载地址主机不在允许列表内：' + manifest.downloadUrl);
    }

    return ok({
      updateAvailable: true,
      current,
      latest: manifest.version,
      channel: manifest.channel,
      releasedAt: manifest.releasedAt,
      notes: manifest.notes,
      download: { url: manifest.downloadUrl, sha256: manifest.sha256 },
      // 交给用户确认的安装器接力信息；本模块不会去执行它。
      handoff: {
        kind: 'installer',
        requiresUserConfirmation: true,
        verify: 'sha256',
        sha256: manifest.sha256,
        note: '下载后请核对 sha256，并由你手动运行安装程序；CetaMesh 不会静默执行安装器。'
      }
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
