// CetaMesh Desktop Node —— 设备身份（阶段 11）。
//
// 一个 CetaMesh Node 的身份 = 一对 Ed25519 密钥 + 由公钥派生的稳定 node id。
// node id 由公钥派生（而不是随机数），因此对端可以独立复算并验证"这个 id 确实是这把钥匙的"。
//
// 持久化：私钥单独存成 identity.key（0600），公钥与元数据存 identity.json，重启后身份不变。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError, readJsonFile, writeTextAtomic } from '../storage/json-file.js';
import { meshError, normalizeName, normalizeRole } from './types.js';

const IDENTITY_SCHEMA_VERSION = 1;

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

export function signPayload(privateKeyPem, payload) {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return crypto.sign(null, data, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyPayload(publicKeyPem, payload, signature) {
  try {
    const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    return crypto.verify(null, data, crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature), 'base64'));
  } catch {
    return false;
  }
}

/**
 * 读取或创建本机设备身份。
 * 已存在则原样复用（重启后 node id 不变）；不存在则生成 Ed25519 密钥对。
 */
export function loadOrCreateIdentity({ stateDir, name = 'CetaMesh Desktop', role = 'desktop', now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('loadOrCreateIdentity 需要 stateDir');
  const dir = path.join(stateDir, 'mesh');
  const metaFile = path.join(dir, 'identity.json');
  const keyFile = path.join(dir, 'identity.key');

  const meta = loadIdentityFile(metaFile, null);
  if (meta && typeof meta === 'object' && meta.nodeId && fs.existsSync(keyFile)) {
    const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
    const derived = deriveNodeId(meta.publicKeyPem);
    if (derived !== meta.nodeId) {
      throw meshError('IDENTITY_MISMATCH', '设备身份损坏：node id 与公钥不一致');
    }
    return { ...meta, privateKeyPem, dir, metaFile, keyFile };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const nodeId = deriveNodeId(publicKeyPem);
  const record = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    nodeId,
    name: normalizeName(name, '设备名称'),
    role: normalizeRole(role),
    publicKeyPem,
    createdAt: now()
  };
  writeFilePrivate(keyFile, privateKeyPem);
  writeFilePrivate(metaFile, JSON.stringify(record, null, 2) + '\n');
  return { ...record, privateKeyPem, dir, metaFile, keyFile };
}
