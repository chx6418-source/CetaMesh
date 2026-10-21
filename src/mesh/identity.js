// CetaMesh Desktop Node —— 设备身份（阶段 11；统一配对 v1.1 迁移到 P-256 / schema v2）。
//
// 一个 CetaMesh Node 的身份 = 一对设备密钥 + 由公钥派生的稳定 node id。
// node id 由公钥派生（而不是随机数），因此对端可以独立复算并验证"这个 id 确实是这把钥匙的"。
//
// v2（当前）：P-256（prime256v1），与 Mobile 硬件身份（Keystore/Secure Enclave）算法一致；
//   公钥在线缆上使用 X9.63 未压缩 65 字节 base64。
// v1（历史）：Ed25519。发现 v1 身份时按受控 pre-1.0 迁移：备份旧文件 → 生成 v2 → 记录 legacyNodeId，
//   旧对端需要重新确认（见 docs/protocol/UNIFIED_PAIRING_V1_1.md §7）。
//
// 持久化：私钥单独存成 identity.key，公钥与元数据存 identity.json，重启后身份不变。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError, readJsonFile, writeTextAtomic } from '../storage/json-file.js';
import { meshError, normalizeName, normalizeRole } from './types.js';

export const IDENTITY_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function loadIdentityFile(file, fallback) {
  try {
    return readJsonFile(file, { missing: fallback });
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === 'CORRUPT') throw meshError('IDENTITY_CORRUPT', '设备身份解析失败：' + file);
      throw meshError('IDENTITY_UNREADABLE', '设备身份读取失败：' + file);
    }
    throw error;
  }
}

function writeFilePrivate(file, text) {
  writeTextAtomic(file, text);
}

/** node id 由公钥 DER 的 sha256 派生：对端可独立复算。 */
export function deriveNodeId(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return 'node_' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/** 从公钥（PEM 或 KeyObject）识别算法：p256 / ed25519；其他算法一律拒绝。 */
export function publicKeyAlgorithm(key) {
  const obj = typeof key === 'string' ? crypto.createPublicKey(key) : key;
  if (obj.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (obj.asymmetricKeyType === 'ec' && obj.asymmetricKeyDetails && obj.asymmetricKeyDetails.namedCurve === 'prime256v1') return 'p256';
  throw meshError('UNSUPPORTED_KEY_ALGORITHM', '不支持的设备密钥算法：' + String(obj.asymmetricKeyType));
}

/** SPKI PEM（P-256）→ X9.63 未压缩 65 字节 base64（线缆编码）。 */
export function publicKeyPemToX963(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (der.length !== P256_SPKI_PREFIX.length + 65 || !der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)) {
    throw meshError('UNSUPPORTED_KEY_ALGORITHM', '仅支持 P-256 身份导出 X9.63 公钥');
  }
  const point = der.subarray(P256_SPKI_PREFIX.length);
  if (point[0] !== 0x04) throw meshError('UNSUPPORTED_KEY_ALGORITHM', '仅支持未压缩 P-256 公钥');
  return point.toString('base64');
}

/** X9.63 未压缩 65 字节 base64（线缆编码）→ SPKI PEM（本地校验用）。 */
export function x963ToPublicKeyPem(x963) {
  const point = Buffer.from(String(x963 || ''), 'base64');
  if (point.length !== 65 || point[0] !== 0x04) {
    throw meshError('INVALID_PUBLIC_KEY', '非法 X9.63 P-256 公钥');
  }
  const der = Buffer.concat([P256_SPKI_PREFIX, point]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();
}

/** 签名（算法感知）：P-256 → ECDSA-SHA256 DER；Ed25519 → 原生签名（兼容 v1 对端）。 */
export function signPayload(privateKeyPem, payload) {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType === 'ed25519') return crypto.sign(null, data, key).toString('base64');
  return crypto.sign('sha256', data, key).toString('base64');
}

export function verifyPayload(publicKeyPem, payload, signature) {
  try {
    const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    const key = crypto.createPublicKey(publicKeyPem);
    const sig = Buffer.from(String(signature), 'base64');
    if (key.asymmetricKeyType === 'ed25519') return crypto.verify(null, data, key, sig);
    return crypto.verify('sha256', data, key, sig);
  } catch {
    return false;
  }
}

function createV2Identity({ name, role, now, legacyNodeId = null, createdAt = null }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const record = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    keyAlgorithm: 'p256',
    nodeId: deriveNodeId(publicKeyPem),
    name: normalizeName(name, '设备名称'),
    role: normalizeRole(role),
    publicKeyPem,
    createdAt: createdAt || now()
  };
  if (legacyNodeId) {
    record.legacyNodeId = legacyNodeId;
    record.migratedAt = now();
  }
  return { record, privateKeyPem };
}

/**
 * 读取或创建本机设备身份（schema v2 / P-256）。
 * - 已是 v2：原样复用（重启后 node id 不变）；
 * - 发现 v1（Ed25519）：受控迁移 —— 备份旧身份 → 生成 v2 → 记录 legacyNodeId（旧对端需重新确认）；
 * - 不存在：生成 v2。
 */
export function loadOrCreateIdentity({ stateDir, name = 'CetaMesh Desktop', role = 'desktop', now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('loadOrCreateIdentity 需要 stateDir');
  const dir = path.join(stateDir, 'mesh');
  const metaFile = path.join(dir, 'identity.json');
  const keyFile = path.join(dir, 'identity.key');

  const meta = loadIdentityFile(metaFile, null);
  if (meta && typeof meta === 'object' && meta.nodeId && fs.existsSync(keyFile)) {
    const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
    if (Number(meta.schemaVersion) >= IDENTITY_SCHEMA_VERSION) {
      const derived = deriveNodeId(meta.publicKeyPem);
      if (derived !== meta.nodeId) {
        throw meshError('IDENTITY_MISMATCH', '设备身份损坏：node id 与公钥不一致');
      }
      return { ...meta, privateKeyPem, dir, metaFile, keyFile };
    }

    // ── v1 → v2 受控迁移 ───────────────────────────────────────────────────
    // 先备份旧 metadata 与私钥，绝不静默丢失；trust store 不在这里改动。
    const backupMetaFile = path.join(dir, 'identity.v1-ed25519.json');
    const backupKeyFile = path.join(dir, 'identity.v1-ed25519.key');
    writeFilePrivate(backupMetaFile, JSON.stringify(meta, null, 2) + '\n');
    writeFilePrivate(backupKeyFile, privateKeyPem);

    if (publicKeyAlgorithm(meta.publicKeyPem) === 'ed25519') {
      const { record, privateKeyPem: nextKey } = createV2Identity({
        name: meta.name || name,
        role: meta.role || role,
        now,
        legacyNodeId: String(meta.nodeId),
        createdAt: meta.createdAt || null
      });
      writeFilePrivate(keyFile, nextKey);
      writeFilePrivate(metaFile, JSON.stringify(record, null, 2) + '\n');
      return { ...record, privateKeyPem: nextKey, migrated: true, backupMetaFile, backupKeyFile, dir, metaFile, keyFile };
    }

    // 元数据是 v1 但密钥已是 P-256（异常组合）：只升级元数据，不换钥匙、不换 nodeId。
    const upgraded = {
      ...meta,
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      keyAlgorithm: 'p256',
      upgradedAt: now(),
      legacySchemaVersion: LEGACY_SCHEMA_VERSION
    };
    writeFilePrivate(metaFile, JSON.stringify(upgraded, null, 2) + '\n');
    return { ...upgraded, privateKeyPem, migrated: false, backupMetaFile, backupKeyFile, dir, metaFile, keyFile };
  }

  const { record, privateKeyPem } = createV2Identity({ name, role, now });
  writeFilePrivate(keyFile, privateKeyPem);
  writeFilePrivate(metaFile, JSON.stringify(record, null, 2) + '\n');
  return { ...record, privateKeyPem, dir, metaFile, keyFile };
}
