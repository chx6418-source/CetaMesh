// CetaMesh Desktop —— 更新清单与签名（阶段 12）。
//
// 更新流程的安全前提（对应阶段要求「不要」的三条）：
//   1) 客户端**不内嵌任何 GitHub Token**：检查更新走公开地址 + 用户可配签名公钥，不需要凭据；
//   2) **不绕过签名验证**：清单必须用内置/用户配置的 Ed25519 公钥验签通过才被采信；
//      没有配置公钥就一律不信任（fail-closed），而不是"先装上再说"；
//   3) **不静默执行未知安装程序**：本模块只产出"有新版 + release notes + 下载链接"，
//      没有任何 download/execute/install API。真正的安装由用户拿着链接走既有安装器。
//
// signManifest 是给发布侧用的（测试也用它构造合法清单），verify 侧在 verify.js。

import crypto from 'node:crypto';

export const UPDATE_MANIFEST_VERSION = 1;
export const UPDATE_CHANNELS = Object.freeze(['stable', 'beta']);

/** semver 主次修订比较（与其它模块同一语义；放在这里避免 update 反向依赖 extension）。 */
function parseVersion(value) {
  const raw = String(value ?? '').trim();
  const withoutBuild = raw.split('+')[0];
  const hyphen = withoutBuild.indexOf('-');
  const core = hyphen >= 0 ? withoutBuild.slice(0, hyphen) : withoutBuild;
  const preRelease = hyphen >= 0 ? withoutBuild.slice(hyphen + 1) : '';
  return {
    numbers: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
    preRelease: preRelease ? preRelease.split('.') : []
  };
}

function comparePreRelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  // A released version has higher precedence than any of its pre-releases.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1; // fewer identifiers = lower precedence
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (leftNumeric) {
      return -1; // numeric identifiers have lower precedence
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Semantic version comparison with pre-release precedence:
 * 1.0.0-rc.1 < 1.0.0-rc.2 < 1.0.0. Build metadata (`+...`) is ignored.
 * Malformed segments degrade to 0 instead of throwing, matching the previous parser.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa.numbers[i] || 0) - (pb.numbers[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return comparePreRelease(pa.preRelease, pb.preRelease);
}

export function updateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function text(value, label, maxChars, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw updateError('MANIFEST_INVALID', label + '不能为空');
    return '';
  }
  if (typeof value !== 'string') throw updateError('MANIFEST_INVALID', label + '必须是字符串');
  const trimmed = value.trim();
  if (required && !trimmed) throw updateError('MANIFEST_INVALID', label + '不能为空');
  if (trimmed.length > maxChars) throw updateError('MANIFEST_INVALID', label + '过长');
  return trimmed;
}

/**
 * 签名内容：**发布出来的那个 JSON 对象**除 signature 外的全部字段，键排序保证两端一致。
 * 因此发布侧应当对"即将发布的原始对象"签名（而不是先归一化再签名）。
 */
export function manifestSigningString(manifest) {
  const copy = {};
  for (const key of Object.keys(manifest).sort()) {
    if (key === 'signature') continue;
    copy[key] = manifest[key];
  }
  return JSON.stringify(copy);
}

export function signManifest(manifest, privateKeyPem) {
  const data = Buffer.from(manifestSigningString(manifest), 'utf8');
  return crypto.sign(null, data, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

// ── 统一 Release Manifest（分发运行时 v1）：平台中立，与既有单平台扁平字段兼容 ──
//
// 统一格式（Desktop / Mobile 共用同一份清单，避免两套互不兼容格式）：
//   { schemaVersion, product, channel, version, publishedAt, sourceCommit,
//     notes, artifacts: { "windows-x64": {filename,url,sha256,bytes}, "android": {...} }, signature }
// 兼容：仅有扁平 `downloadUrl` + `sha256`（无 artifacts）的旧清单照旧通过校验；
//       两者同时存在时全部校验，平台包选择由 selectArtifact(manifest, platform) 完成。
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const PLATFORM_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function artifactEntry(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw updateError('MANIFEST_INVALID', label + '必须是对象');
  }
  const filename = text(value.filename, label + '.filename', 200, { required: true });
  const url = text(value.url, label + '.url', 600, { required: true });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw updateError('MANIFEST_INVALID', '非法下载地址：' + url.slice(0, 120));
  }
  if (parsed.protocol !== 'https:') {
    throw updateError('MANIFEST_INSECURE_URL', label + ' 下载地址必须是 https');
  }
  const sha256 = text(value.sha256, label + '.sha256', 128, { required: true });
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw updateError('MANIFEST_INVALID', label + '.sha256 必须是 64 位十六进制');
  }
  const bytes = value.bytes;
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) {
    throw updateError('MANIFEST_INVALID', label + '.bytes 必须是合理的正整数');
  }
  return { filename, url, sha256: sha256.toLowerCase(), bytes };
}

function artifactSet(rawArtifacts) {
  if (rawArtifacts === undefined || rawArtifacts === null) return null;
  if (typeof rawArtifacts !== 'object' || Array.isArray(rawArtifacts)) {
    throw updateError('MANIFEST_INVALID', 'artifacts 必须是平台到安装包的映射对象');
  }
  const keys = Object.keys(rawArtifacts);
  if (!keys.length) throw updateError('MANIFEST_INVALID', 'artifacts 不能为空');
  const out = {};
  for (const key of keys) {
    if (!PLATFORM_KEY_RE.test(key)) throw updateError('MANIFEST_INVALID', '非法平台键：' + key);
    out[key] = artifactEntry(rawArtifacts[key], 'artifacts.' + key);
  }
  return out;
}

/**
 * 选出本平台安装包：优先 artifacts[platform]；否则回落到旧格式的扁平 downloadUrl+sha256。
 * 返回 null 表示清单里没有本平台可用的安装包（调用方应视为「该源不可用」，而不是「无更新」）。
 */
export function selectArtifact(manifest, platform) {
  const key = String(platform || '').trim();
  const entry = key && manifest && manifest.artifacts ? manifest.artifacts[key] : null;
  if (entry) {
    return { platform: key, filename: entry.filename, url: entry.url, sha256: entry.sha256, bytes: entry.bytes };
  }
  if (manifest && manifest.downloadUrl && manifest.sha256) {
    return { platform: 'legacy-flat', filename: '', url: manifest.downloadUrl, sha256: manifest.sha256, bytes: null };
  }
  return null;
}

/** 纯校验：返回 { ok, issues, manifest }，不抛错。 */
export function validateManifest(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw updateError('MANIFEST_INVALID', '清单根节点必须是对象');
    }
    if (Number(raw.schemaVersion) !== UPDATE_MANIFEST_VERSION) {
      throw updateError('MANIFEST_VERSION_UNSUPPORTED', '不支持的清单版本：' + String(raw.schemaVersion));
    }
    const channel = text(raw.channel, 'channel', 20, { required: true });
    if (!UPDATE_CHANNELS.includes(channel)) {
      throw updateError('MANIFEST_INVALID', '未知更新通道：' + channel);
    }
    const version = text(raw.version, 'version', 40, { required: true });
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw updateError('MANIFEST_INVALID', '非法版本号：' + version);
    }
    const artifacts = artifactSet(raw.artifacts);
    const flatPresent = raw.downloadUrl !== undefined || raw.sha256 !== undefined;
    let downloadUrl = '';
    let sha256 = '';
    if (!artifacts || flatPresent) {
      // 旧格式（无 artifacts）必须带扁平字段；统一格式若同时保留扁平字段也必须完整合法。
      downloadUrl = text(raw.downloadUrl, 'downloadUrl', 600, { required: true });
      let parsed;
      try {
        parsed = new URL(downloadUrl);
      } catch {
        throw updateError('MANIFEST_INVALID', '非法下载地址：' + downloadUrl.slice(0, 120));
      }
      if (parsed.protocol !== 'https:') {
        throw updateError('MANIFEST_INSECURE_URL', '下载地址必须是 https');
      }
      sha256 = text(raw.sha256, 'sha256', 128, { required: true });
      if (!/^[a-f0-9]{64}$/i.test(sha256)) {
        throw updateError('MANIFEST_INVALID', 'sha256 必须是 64 位十六进制');
      }
      sha256 = sha256.toLowerCase();
    }
    const signature = text(raw.signature, 'signature', 400, { required: true });
    const notes = Array.isArray(raw.notes) ? raw.notes.map((n) => String(n)).slice(0, 100) : [];
    return {
      ok: true,
      issues: [],
      manifest: {
        schemaVersion: UPDATE_MANIFEST_VERSION,
        product: text(raw.product, 'product', 40) || null,
        channel,
        version,
        releasedAt: text(raw.releasedAt, 'releasedAt', 40) || null,
        publishedAt: text(raw.publishedAt, 'publishedAt', 40) || null,
        sourceCommit: text(raw.sourceCommit, 'sourceCommit', 64) || null,
        notes,
        artifacts,
        downloadUrl,
        sha256,
        signature,
        minVersion: text(raw.minVersion, 'minVersion', 40) || null
      }
    };
  } catch (error) {
    return { ok: false, issues: [{ code: (error && error.code) || 'MANIFEST_INVALID', message: String(error && error.message) }], manifest: null };
  }
}

/** 仅允许从设置里声明的主机下载（防止清单把用户引到任意站点）。 */
export function hostAllowedForDownload(urlString, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(urlString));
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (allowedHosts || []).some((entry) => {
    const target = String(entry).trim().toLowerCase();
    return target && (host === target || host.endsWith('.' + target));
  });
}
