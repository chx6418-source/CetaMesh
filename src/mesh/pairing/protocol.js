// CetaMesh 统一配对协议 v1.1 —— 线缆层（事实源：docs/protocol/UNIFIED_PAIRING_V1_1.md）。
//
// 本模块只做纯函数：cetamesh 信封 / 邀请 / transcript / Mesh 通道签名的校验与构造。
// 校验规则与 Mobile 端（src/protocol/PairingProtocol.ts）逐条对应；两端任何一侧改动
// 都必须同步协议文档、fixtures 与对端实现。
//
// 拒绝语义：所有拒绝都抛出带 code 的 meshError，code 取协议文档 §4 的 REFUSED_* 集合。

import crypto from 'node:crypto';
import { meshError } from '../types.js';
import { publicKeyAlgorithm, signPayload, x963ToPublicKeyPem } from '../identity.js';

export const PAIRING_PROTOCOL_TAG = 'cetamesh';
export const PAIRING_ENVELOPE_VERSION = 1;
export const PAIRING_PHASES = Object.freeze(['exchange', 'challenge', 'confirm', 'accepted']);
export const KEY_ALGORITHMS = Object.freeze(['p256', 'ed25519']);

export const PAIRING_LIMITS = Object.freeze({
  requestChars: 16384,
  responseChars: 32768,
  invitationChars: 8192,
  invitationTtlMs: 270000,
  maxTtlMs: 300000,
  futureSkewMs: 30000,
  meshSkewMs: 300000
});

export const REFUSAL_CODES = Object.freeze([
  'REFUSED_NOT_FOUND', 'REFUSED_EXPIRED', 'REFUSED_CONSUMED',
  'REFUSED_SIGNATURE', 'REFUSED_REQUEST', 'REFUSED_REPLAY'
]);

export function isPairingRefusal(error) {
  return Boolean(error && REFUSAL_CODES.includes(error.code));
}

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const X963_RE = /^B[A-Za-z0-9+/]{85}[AEIMQUYcgkosw048]=$/;
const SIG_RE = /^[A-Za-z0-9+/]{12,96}={0,2}$/;
const TLS_PIN_RE = /^[0-9a-f]{64}$/;
const ENDPOINT_RE = /^https:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/;

const refused = (code, message) => meshError(code, message);

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw refused('REFUSED_REQUEST', '协议对象非法');
  }
  return value;
}

export function normalizeIdentifier(value) {
  const text = typeof value === 'string' ? value : '';
  if (!IDENTIFIER_RE.test(text)) throw refused('REFUSED_REQUEST', '非法 identifier');
  return text;
}

export function normalizeIso(value) {
  const text = typeof value === 'string' ? value : '';
  if (!ISO_RE.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw refused('REFUSED_REQUEST', '非法 ISO 时间');
  }
  return text;
}

export function normalizeToken(value) {
  const text = typeof value === 'string' ? value : '';
  if (!TOKEN_RE.test(text)) throw refused('REFUSED_REQUEST', '非法 token/nonce');
  return text;
}

export const normalizeNonce = normalizeToken;

export function normalizeTlsPin(value) {
  const text = typeof value === 'string' ? value : '';
  if (!TLS_PIN_RE.test(text)) throw refused('REFUSED_REQUEST', '非法 tlsPin');
  return text;
}

export function normalizeX963PublicKey(value) {
  const text = typeof value === 'string' ? value : '';
  if (!X963_RE.test(text)) throw refused('REFUSED_REQUEST', '非法 X9.63 公钥');
  return text;
}

export function normalizeSignature(value) {
  const text = typeof value === 'string' ? value : '';
  if (!SIG_RE.test(text)) throw refused('REFUSED_SIGNATURE', '非法签名编码');
  return text;
}

/** endpoint 文法与 Mobile 端一致：仅 https、小写 DNS 标签或完整十进制 IPv4，端口非 443。 */
export function normalizeEndpointOrigin(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length > 512) throw refused('REFUSED_REQUEST', 'endpoint 过长');
  const match = ENDPOINT_RE.exec(text);
  if (!match) throw refused('REFUSED_REQUEST', '非法 endpoint');
  const host = match[1];
  const port = match[2];
  const labelsValid = host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (host.length > 253 || host === 'localhost' || host.endsWith('.localhost') || !labelsValid
    || (port && (Number(port) > 65535 || Number(port) === 443))) {
    throw refused('REFUSED_REQUEST', '非法 endpoint');
  }
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    const digitsValid = parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
    if (parts.length !== 4 || !digitsValid || parts[0] === '127' || parts[0] === '0') {
      throw refused('REFUSED_REQUEST', '非法 endpoint（IPv4 必须是完整十进制）');
    }
  }
  return text;
}

/** 对端身份投影：keyAlgorithm 缺省视为 p256（v1 兼容）。 */
export function normalizePeerIdentity(value, { allowAlgorithm = true } = {}) {
  const record = asRecord(value);
  const deviceName = typeof record.deviceName === 'string' ? record.deviceName : '';
  const hasControlChar = Array.from(deviceName).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!deviceName.trim() || deviceName.length > 100 || hasControlChar) {
    throw refused('REFUSED_REQUEST', '非法 deviceName');
  }
  const identity = {
    deviceId: normalizeIdentifier(record.deviceId),
    deviceName,
    publicKey: normalizeX963PublicKey(record.publicKey)
  };
  if (allowAlgorithm) {
    if (record.keyAlgorithm === undefined || record.keyAlgorithm === null) identity.keyAlgorithm = 'p256';
    else {
      const algorithm = String(record.keyAlgorithm);
      if (!KEY_ALGORITHMS.includes(algorithm)) throw refused('REFUSED_REQUEST', '非法 keyAlgorithm');
      identity.keyAlgorithm = algorithm;
    }
  }
  return identity;
}

/** 邀请 payload 校验（对应 Mobile v1 invitation()，外加 v1.1 可选字段）。 */
export function normalizeInvitationPayload(value, { nowMs, timestampMs }) {
  const record = asRecord(value);
  const expiresAt = normalizeIso(record.expiresAt);
  const expiry = Date.parse(expiresAt);
  if (expiry <= nowMs || expiry > nowMs + PAIRING_LIMITS.maxTtlMs) {
    throw refused('REFUSED_EXPIRED', '邀请已过期或超出有效期上限');
  }
  if (expiry > timestampMs + PAIRING_LIMITS.maxTtlMs || expiry <= timestampMs) {
    throw refused('REFUSED_REQUEST', '邀请有效期与时间戳不一致');
  }
  const invitation = {
    invitationId: normalizeIdentifier(record.invitationId),
    endpoint: normalizeEndpointOrigin(record.endpoint),
    token: normalizeToken(record.token),
    expiresAt,
    peer: normalizePeerIdentity(record.peer)
  };
  if (record.tlsPin !== undefined && record.tlsPin !== null) {
    invitation.tlsPin = normalizeTlsPin(record.tlsPin);
  }
  return invitation;
}

/** cetamesh 通用信封校验（不含 payload 语义）。 */
export function validateCetameshEnvelope(raw, { nowMs = Date.now(), maxChars = PAIRING_LIMITS.responseChars } = {}) {
  const envelope = asRecord(raw);
  if (envelope.protocol !== PAIRING_PROTOCOL_TAG || envelope.version !== PAIRING_ENVELOPE_VERSION) {
    throw refused('REFUSED_REQUEST', '信封 protocol/version 不匹配');
  }
  if (JSON.stringify(envelope).length > maxChars) throw refused('REFUSED_REQUEST', '信封超过大小上限');
  const id = normalizeIdentifier(envelope.id);
  const timestamp = normalizeIso(envelope.timestamp);
  if (Date.parse(timestamp) > nowMs + PAIRING_LIMITS.futureSkewMs) {
    throw refused('REFUSED_REQUEST', '信封时间戳超前');
  }
  if (typeof envelope.type !== 'string' || !envelope.type) throw refused('REFUSED_REQUEST', '信封缺少 type');
  const payload = asRecord(envelope.payload);
  return { protocol: PAIRING_PROTOCOL_TAG, version: PAIRING_ENVELOPE_VERSION, id, type: envelope.type, timestamp, payload };
}

/** 从文本解析邀请（二维码与"粘贴配对邀请"共用入口）。 */
export function parseInvitation(rawText, nowMs = Date.now()) {
  if (typeof rawText !== 'string' || rawText.length > PAIRING_LIMITS.invitationChars) {
    throw refused('REFUSED_REQUEST', '邀请文本非法或超长');
  }
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { throw refused('REFUSED_REQUEST', '邀请不是合法 JSON'); }
  const envelope = validateCetameshEnvelope(parsed, { nowMs, maxChars: PAIRING_LIMITS.invitationChars });
  if (envelope.type !== 'pairing.invitation') throw refused('REFUSED_REQUEST', '信封不是配对邀请');
  const invitation = normalizeInvitationPayload(envelope.payload, { nowMs, timestampMs: Date.parse(envelope.timestamp) });
  return { invitation, envelope };
}

/** 构造邀请信封（Desktop 作为邀请方）。 */
export function createInvitationEnvelope(invitation, { nowMs = Date.now(), id } = {}) {
  return {
    protocol: PAIRING_PROTOCOL_TAG,
    version: PAIRING_ENVELOPE_VERSION,
    id: id || ('pairing-invite-' + crypto.randomBytes(8).toString('hex')),
    type: 'pairing.invitation',
    timestamp: new Date(nowMs).toISOString(),
    payload: {
      invitationId: invitation.invitationId,
      endpoint: invitation.endpoint,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
      peer: {
        deviceId: invitation.peer.deviceId,
        deviceName: invitation.peer.deviceName,
        publicKey: invitation.peer.publicKey,
        keyAlgorithm: invitation.peer.keyAlgorithm || 'p256'
      },
      ...(invitation.tlsPin ? { tlsPin: invitation.tlsPin } : {})
    }
  };
}

/**
 * transcript：邀请含 tlsPin ⇒ v1.1（末尾追加 pin），否则与 v1 完全一致。
 * `device` 只使用 deviceId/publicKey 两个字段。
 */
export function transcript(invitation, device, nonce, phase) {
  if (!PAIRING_PHASES.includes(phase)) throw refused('REFUSED_REQUEST', '未知配对阶段');
  const base = ['cetamesh-pairing-v1.1', phase,
    invitation.invitationId, invitation.endpoint,
    invitation.peer.deviceId, invitation.peer.publicKey,
    device.deviceId, device.publicKey, nonce, invitation.expiresAt];
  if (invitation.tlsPin) return JSON.stringify(base.concat(invitation.tlsPin));
  return JSON.stringify(['cetamesh-pairing-v1', phase,
    invitation.invitationId, invitation.endpoint,
    invitation.peer.deviceId, invitation.peer.publicKey,
    device.deviceId, device.publicKey, nonce, invitation.expiresAt]);
}

export function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(Buffer.from(String(token), 'utf8')).digest('hex');
}

// ── 配对完成后的 Mesh 通道（协议文档 §6）─────────────────────────────────────

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload), 'utf8')).digest('hex');
}

export function meshSigningString(type, id, from, to, timestamp, nonce, ph) {
  return JSON.stringify(['cetamesh-mesh-v1', type, id, from, to, timestamp, nonce, ph]);
}

export const MESH_CHANNEL_TYPES = Object.freeze([
  'mesh.presence.ping', 'mesh.presence.pong',
  'mesh.manifest.request', 'mesh.manifest.response',
  'mesh.capability.request', 'mesh.capability.response'
]);

/** 构造并签名一条 Mesh 通道信封（发送方）。 */
export function createMeshEnvelope({ type, from, to, payload = {}, privateKeyPem, sign, nowMs = Date.now() } = {}) {
  if (!MESH_CHANNEL_TYPES.includes(type)) throw refused('REFUSED_REQUEST', '未知 Mesh 消息类型');
  const envelope = {
    protocol: PAIRING_PROTOCOL_TAG,
    version: PAIRING_ENVELOPE_VERSION,
    id: 'mesh-msg-' + crypto.randomBytes(8).toString('hex'),
    type,
    timestamp: new Date(nowMs).toISOString(),
    from: normalizeIdentifier(from),
    to: normalizeIdentifier(to),
    nonce: crypto.randomBytes(32).toString('base64'),
    payload,
    ph: payloadHash(payload)
  };
  if (typeof sign === 'function') envelope.signature = sign(meshSigningString(type, envelope.id, envelope.from, envelope.to, envelope.timestamp, envelope.nonce, envelope.ph));
  else if (privateKeyPem) envelope.signature = signPayload(privateKeyPem, meshSigningString(type, envelope.id, envelope.from, envelope.to, envelope.timestamp, envelope.nonce, envelope.ph));
  else throw refused('REFUSED_REQUEST', 'createMeshEnvelope 需要 privateKeyPem 或 sign');
  return envelope;
}

/** 校验一条 Mesh 通道信封（接收方）：结构 + ph + 时效；签名交由信任层用对端公钥验证。 */
export function validateMeshEnvelope(raw, { nowMs = Date.now(), toDeviceId = null } = {}) {
  const envelope = validateCetameshEnvelope(raw, { nowMs, maxChars: PAIRING_LIMITS.responseChars });
  if (!MESH_CHANNEL_TYPES.includes(envelope.type)) throw refused('REFUSED_REQUEST', '未知 Mesh 消息类型');
  const from = normalizeIdentifier(raw.from);
  const to = normalizeIdentifier(raw.to);
  if (toDeviceId && to !== toDeviceId) throw refused('REFUSED_REQUEST', 'Mesh 消息收件人不是本机');
  if (from === to) throw refused('REFUSED_REQUEST', 'Mesh 消息不能发给自己');
  const nonce = normalizeNonce(raw.nonce);
  const ph = normalizeTlsPin(raw.ph); // ph 与 tlsPin 同为 64 位小写 hex
  const timestampMs = Date.parse(envelope.timestamp);
  if (Math.abs(nowMs - timestampMs) > PAIRING_LIMITS.meshSkewMs) throw refused('REFUSED_REQUEST', 'Mesh 消息时间偏移超限');
  if (payloadHash(envelope.payload) !== ph) throw refused('REFUSED_REQUEST', 'payload 哈希不匹配（疑似篡改）');
  const signature = normalizeSignature(raw.signature);
  return { ...envelope, from, to, nonce, ph, signature, timestampMs, signingString: meshSigningString(envelope.type, envelope.id, from, to, envelope.timestamp, nonce, ph) };
}

/** 对端 keyAlgorithm → 校验其公钥编码可用（x963 → SPKI PEM），返回可用于 crypto.verify 的 PEM。 */
export function peerPublicKeyPem(identity) {
  return x963ToPublicKeyPem(identity.publicKey);
}

export function describeKeyAlgorithm(publicKeyPem) {
  return publicKeyAlgorithm(publicKeyPem);
}
