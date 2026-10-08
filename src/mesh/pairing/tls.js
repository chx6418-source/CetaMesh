// CetaMesh 统一配对 v1.1 —— Desktop 侧配对 TLS 身份（协议文档 §5/§11）。
//
// 每安装实例唯一：首次需要时生成自签 P-256... 说明——证书算法用 RSA-2048 还是 P-256
// 不影响 pinning 语义（pin 是证书 DER 的 sha256），这里用成熟小型库（selfsigned）生成，
// 私钥与证书只落在 state/mesh/（writeTextAtomic 0600），绝不随安装包分发同一把私钥。
//
// 证书指纹（sha256(DER) 小写 hex）进入配对邀请的 tlsPin；端口同样随安装持久化，
// 使"重启后无需重新扫码"成立（endpoint + pin 都稳定）。

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import { StorageError, readJsonFile, writeTextAtomic } from '../../storage/json-file.js';
import { meshError } from '../types.js';

const TLS_SCHEMA_VERSION = 1;
const PAIRING_PORT_MIN = 45000;
const PAIRING_PORT_MAX = 55000;

function isPrivateIpv4(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** 本机可用局域网 IPv4（私网地址优先），排除 internal / 链路本地。 */
export function listLanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const family = typeof entry.family === 'string' ? entry.family : 'IPv' + String(entry.family);
      if (family !== 'IPv4' || entry.internal) continue;
      const address = String(entry.address || '');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || address.startsWith('169.254.')) continue;
      out.push({ name, address, private: isPrivateIpv4(address) });
    }
  }
  return out.sort((a, b) => Number(b.private) - Number(a.private));
}

export function pickLanAddress() {
  const candidates = listLanAddresses();
  return candidates.length ? candidates[0].address : null;
}

export function certificateFingerprint(certPem) {
  const der = new crypto.X509Certificate(certPem).raw;
  return crypto.createHash('sha256').update(der).digest('hex');
}

function loadTlsFile(file) {
  try {
    return readJsonFile(file, { missing: null });
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === 'CORRUPT') throw meshError('PAIRING_TLS_CORRUPT', '配对 TLS 身份解析失败：' + file);
      throw meshError('PAIRING_TLS_UNREADABLE', '配对 TLS 身份读取失败：' + file);
    }
    throw error;
  }
}

/**
 * 读取或创建配对 TLS 身份（证书 + 私钥 + 指纹 + 稳定端口）。
 * 已存在则原样复用（重启后 pin 与 endpoint 不变）。
 */
export async function loadOrCreatePairingTls({ stateDir, name = 'CetaMesh Desktop', now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('loadOrCreatePairingTls 需要 stateDir');
  const dir = path.join(stateDir, 'mesh');
  const file = path.join(dir, 'pairing-tls.json');

  const existing = loadTlsFile(file);
  if (existing && typeof existing === 'object' && existing.certPem && existing.keyPem && existing.fingerprint) {
    const fingerprint = certificateFingerprint(existing.certPem);
    if (fingerprint !== existing.fingerprint) {
      throw meshError('PAIRING_TLS_CORRUPT', '配对 TLS 身份损坏：证书指纹与记录不一致');
    }
    return { ...existing, file, reused: true };
  }

  const altNames = listLanAddresses().map((entry) => ({ type: 7, ip: entry.address }));
  const pems = await selfsigned.generate(
    [
      { name: 'commonName', value: name },
      { name: 'organizationName', value: 'CetaMesh' }
    ],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        ...(altNames.length ? [{ name: 'subjectAltName', altNames }] : [])
      ]
    }
  );

  const record = {
    schemaVersion: TLS_SCHEMA_VERSION,
    createdAt: now(),
    subject: { commonName: name, organizationName: 'CetaMesh' },
    algorithm: 'RSA-2048',
    certPem: pems.cert,
    keyPem: pems.private,
    fingerprint: certificateFingerprint(pems.cert),
    port: crypto.randomInt(PAIRING_PORT_MIN, PAIRING_PORT_MAX),
    altNames: altNames.map((entry) => entry.ip)
  };
  writeTextAtomic(file, JSON.stringify(record, null, 2) + '\n');
  return { ...record, file, reused: false };
}
