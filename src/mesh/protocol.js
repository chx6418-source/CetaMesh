// CetaMesh Desktop Node —— 协议校验与远程能力请求授权链（阶段 11）。
//
// 阶段要求：remote capability request 必须经过
//     Peer Trust -> Protocol validation -> Capability availability -> Local policy -> Approval if required
//
// 实现顺序上把 **protocol 放在最前**（结构 / 版本 / 时效 / 重放），因为"信任谁"这件事
// 必须先知道"这条消息在语法上是谁发的、是否被篡改"。完整链路：
//     1. protocol     —— 信封结构、协议版本、时间偏移、重放
//     2. trust        —— 对端存在、trust==='trusted'、签名有效
//     3. availability —— 能力在本节点清单里且当前确实可用
//     4. policy       —— 该能力已显式授予该对端（Trusted != Authorized）
//     5. approval     —— 需要审批的能力必须有已批准的请求
// 每一步失败都返回带 stage 的决策，便于审计与 UI 展示"卡在哪一步"。

import crypto from 'node:crypto';
import {
  CAPABILITY_NAMES,
  MESH_LIMITS,
  MESH_PROTOCOL_VERSION,
  meshError,
  normalizeNodeId
} from './types.js';

export const ENVELOPE_TYPES = Object.freeze([
  'pair.request', 'pair.accept', 'presence.ping', 'manifest.request', 'manifest.response', 'capability.request'
]);

const MAX_SKEW_MS = 5 * 60 * 1000;

/** 签名内容：除 sig 外的全部字段，键排序以保证两端一致。 */
export function signingString(envelope) {
  const copy = {};
  for (const key of Object.keys(envelope).sort()) {
    if (key === 'sig') continue;
    copy[key] = envelope[key];
  }
  return JSON.stringify(copy);
}

export function createEnvelope({ type, from, to, payload = {}, privateKeyPem, sign, nowMs = Date.now() } = {}) {
  if (!ENVELOPE_TYPES.includes(type)) throw meshError('UNKNOWN_MESSAGE_TYPE', '未知消息类型：' + String(type));
  const envelope = {
    v: MESH_PROTOCOL_VERSION,
    type,
    id: 'msg_' + crypto.randomBytes(8).toString('hex'),
    from: normalizeNodeId(from),
    to: normalizeNodeId(to),
    ts: nowMs,
    nonce: crypto.randomBytes(12).toString('hex'),
    payload
  };
  if (typeof sign === 'function') envelope.sig = sign(signingString(envelope));
  else if (privateKeyPem) throw meshError('INTERNAL', 'createEnvelope 需要注入 sign 函数');
  return envelope;
}

/** 结构 + 版本 + 时效校验（不含签名，签名在 trust 阶段用对端公钥验证）。 */
export function validateEnvelope(raw, { nowMs = Date.now(), toNodeId = null } = {}) {
  const issues = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ code: 'PROTOCOL_NOT_OBJECT', message: '信封必须是对象' }] };
  }
  if (Number(raw.v) !== MESH_PROTOCOL_VERSION) {
    issues.push({ code: 'PROTOCOL_VERSION_MISMATCH', message: '协议版本不匹配：' + String(raw.v) });
  }
  if (!ENVELOPE_TYPES.includes(raw.type)) {
    issues.push({ code: 'UNKNOWN_MESSAGE_TYPE', message: '未知消息类型：' + String(raw.type) });
  }
  for (const field of ['id', 'from', 'to', 'nonce']) {
    if (typeof raw[field] !== 'string' || !raw[field]) {
      issues.push({ code: 'PROTOCOL_MISSING_FIELD', message: '缺少字段：' + field });
    }
  }
  if (typeof raw.sig !== 'string' || !raw.sig) {
    issues.push({ code: 'PROTOCOL_UNSIGNED', message: '消息未签名' });
  }
  if (!raw.payload || typeof raw.payload !== 'object' || Array.isArray(raw.payload)) {
    issues.push({ code: 'PROTOCOL_INVALID_PAYLOAD', message: 'payload 必须是对象' });
  }
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts)) {
    issues.push({ code: 'PROTOCOL_INVALID_TS', message: 'ts 非法' });
  } else if (Math.abs(nowMs - ts) > MAX_SKEW_MS) {
    issues.push({ code: 'PROTOCOL_STALE', message: '消息时间超出允许偏移（' + MAX_SKEW_MS + 'ms）' });
  }
  if (toNodeId && typeof raw.to === 'string' && raw.to !== toNodeId) {
    issues.push({ code: 'PROTOCOL_WRONG_RECIPIENT', message: '消息不是发给本节点的' });
  }
  if (raw.from === raw.to && typeof raw.from === 'string') {
    issues.push({ code: 'PROTOCOL_SELF_ADDRESSED', message: '消息不能发给自己' });
  }
  if (JSON.stringify(raw).length > MESH_LIMITS.envelopeChars) {
    issues.push({ code: 'PROTOCOL_TOO_LARGE', message: '信封超过大小上限' });
  }
  return { ok: issues.length === 0, issues };
}

function deny(stage, code, message) {
  return { decision: 'deny', stage, code, message };
}

/**
 * 远程能力请求授权链（纯函数，便于穷举测试）。
 * 返回 { decision: 'allow' | 'deny' | 'pending_approval', stage, code, message }。
 */
export function authorizeCapabilityRequest({
  envelope,
  peer = null,
  publicKeyPem = null,
  localManifest = null,
  availableCapabilities = null,
  duplicateNonce = false,
  verify = null,
  approvalState = null,
  nowMs = Date.now()
} = {}) {
  // 1. protocol
  const validation = validateEnvelope(envelope, { nowMs });
  if (!validation.ok) {
    return deny('protocol', validation.issues[0].code, validation.issues[0].message);
  }
  if (duplicateNonce) {
    return deny('protocol', 'PROTOCOL_REPLAY', '重复 nonce：疑似重放消息');
  }
  const payload = envelope.payload || {};
  const capability = String(payload.capability || '');
  if (!CAPABILITY_NAMES.includes(capability)) {
    return deny('protocol', 'UNKNOWN_CAPABILITY', '请求了未知能力：' + capability.slice(0, 40));
  }

  // 2. trust（身份可信 + 签名有效）
  if (!peer) {
    return deny('trust', 'PEER_UNKNOWN', '对端未配对：' + String(envelope.from).slice(0, 40));
  }
  if (peer.trust !== 'trusted') {
    return deny('trust', 'PEER_UNTRUSTED', '对端未被信任（当前 ' + peer.trust + '）');
  }
  const checker = verify || (() => false);
  if (!checker(publicKeyPem, signingString(envelope), envelope.sig)) {
    return deny('trust', 'SIGNATURE_INVALID', '消息签名校验失败');
  }

  // 3. availability（本节点确实提供这个能力）
  const declared = (localManifest && Array.isArray(localManifest.capabilities))
    ? localManifest.capabilities.find((item) => item.id === capability)
    : null;
  if (!declared) {
    return deny('availability', 'CAPABILITY_NOT_DECLARED', '本节点未声明该能力：' + capability);
  }
  const usable = availableCapabilities === null || availableCapabilities === undefined
    ? null
    : new Set(availableCapabilities);
  if (usable && !usable.has(capability)) {
    return deny('availability', 'CAPABILITY_UNAVAILABLE', '能力当前不可用：' + capability);
  }

  // 4. policy（Trusted != Authorized：必须显式授予）
  const grants = Array.isArray(peer.grants) ? peer.grants : [];
  if (!grants.includes(capability)) {
    return deny('policy', 'CAPABILITY_NOT_AUTHORIZED', '该对端未被授予能力：' + capability);
  }

  // 5. approval
  const requiresApproval = declared.requiresApproval === true;
  if (requiresApproval) {
    if (!approvalState || approvalState === 'pending') {
      return { decision: 'pending_approval', stage: 'approval', code: 'APPROVAL_REQUIRED', message: '该能力需要本地用户逐次批准' };
    }
    if (approvalState === 'rejected') {
      return deny('approval', 'APPROVAL_REJECTED', '本地用户拒绝了该请求');
    }
    if (approvalState === 'expired') {
      return deny('approval', 'APPROVAL_EXPIRED', '审批请求已超时');
    }
    if (approvalState !== 'approved') {
      return deny('approval', 'APPROVAL_UNKNOWN', '未知审批状态：' + String(approvalState));
    }
  }

  return { decision: 'allow', stage: 'done', code: 'ALLOWED', message: '授权通过' };
}
