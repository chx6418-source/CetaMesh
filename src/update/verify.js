// CetaMesh Desktop —— 更新清单签名验证（阶段 12）。
//
// 唯一的信任来源是**配置里的固定公钥**。没有公钥 -> 不信任（fail-closed）。

import crypto from 'node:crypto';
import { manifestSigningString } from './manifest.js';

export function verifyManifestSignature(manifest, pinnedPublicKeyPem) {
  if (!pinnedPublicKeyPem || !String(pinnedPublicKeyPem).trim()) {
    return { ok: false, code: 'NO_PINNED_KEY', message: '未配置更新签名公钥，拒绝信任任何更新清单' };
  }
  if (!manifest || typeof manifest.signature !== 'string' || !manifest.signature) {
    return { ok: false, code: 'SIGNATURE_MISSING', message: '清单没有签名' };
  }
  try {
    const data = Buffer.from(manifestSigningString(manifest), 'utf8');
    const key = crypto.createPublicKey(String(pinnedPublicKeyPem));
    const good = crypto.verify(null, data, key, Buffer.from(manifest.signature, 'base64'));
    return good
      ? { ok: true, code: 'SIGNATURE_OK', message: '签名验证通过' }
      : { ok: false, code: 'SIGNATURE_INVALID', message: '清单签名验证失败（内容可能被篡改）' };
  } catch (error) {
    return { ok: false, code: 'SIGNATURE_INVALID', message: '签名验证异常：' + (error && error.message) };
  }
}
