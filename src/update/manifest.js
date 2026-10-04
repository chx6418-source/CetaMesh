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
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
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
    const downloadUrl = text(raw.downloadUrl, 'downloadUrl', 600, { required: true });
    let parsed;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      throw updateError('MANIFEST_INVALID', '非法下载地址：' + downloadUrl.slice(0, 120));
    }
    if (parsed.protocol !== 'https:') {
      throw updateError('MANIFEST_INSECURE_URL', '下载地址必须是 https');
    }
    const sha256 = text(raw.sha256, 'sha256', 128, { required: true });
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw updateError('MANIFEST_INVALID', 'sha256 必须是 64 位十六进制');
    }
    const signature = text(raw.signature, 'signature', 400, { required: true });
    const notes = Array.isArray(raw.notes) ? raw.notes.map((n) => String(n)).slice(0, 100) : [];
    return {
      ok: true,
      issues: [],
      manifest: {
        schemaVersion: UPDATE_MANIFEST_VERSION,
        channel,
        version,
        releasedAt: text(raw.releasedAt, 'releasedAt', 40) || null,
        notes,
        downloadUrl,
        sha256: sha256.toLowerCase(),
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
