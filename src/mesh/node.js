// CetaMesh Desktop Node —— Mesh 节点运行时（阶段 11）。
//
// 把身份、配对、信任、在线、能力清单、远程请求授权链组装成一个标准 CetaMesh Node。
//
// 关键不变量（有测试锁住）：
//   Core readiness 不依赖任何对端，也不依赖 QQ / SnowLuma 等 Channel Adapter。
//   没有任何 peer、所有 peer 离线、channel adapter 出错 —— 本节点仍然是 ready。

import crypto from 'node:crypto';
import { capabilityManifest, allCapabilities } from './capabilities.js';
import { deriveNodeId, loadOrCreateIdentity, signPayload, verifyPayload } from './identity.js';
import {
  authorizeCapabilityRequest,
  createEnvelope,
  signingString,
  validateEnvelope
} from './protocol.js';
import { createTrustStore } from './trust.js';
import {
  MESH_LIMITS,
  MESH_PROTOCOL_VERSION,
  meshError,
  normalizeCapabilityList,
  normalizeName,
  normalizeRole,
  normalizeTransport
} from './types.js';

export function createMeshNode({
  stateDir,
  name = 'CetaMesh Desktop',
  role = 'desktop',
  available = null,
  executeCapability = null,
  now = () => Date.now()
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMeshNode 需要 stateDir');
  const identity = loadOrCreateIdentity({ stateDir, name, role, now });
  const trust = createTrustStore({ stateDir, now });

  const nonces = new Map();      // nonce -> ts（重放防护）
  const approvals = new Map();   // requestId -> { state, ... }
  const invites = new Map();     // code -> { createdAt, expiresAt, usedAt }
  const audit = [];              // 最近的授权决策

  function record(entry) {
    audit.push({ at: now(), ...entry });
    if (audit.length > MESH_LIMITS.audit) audit.shift();
  }

  function pruneNonces(nowMs) {
    const cutoff = nowMs - 10 * 60 * 1000;
    for (const [nonce, ts] of nonces) if (ts < cutoff) nonces.delete(nonce);
  }

  function expiryOf(approval) {
    return approval.at + MESH_LIMITS.approvalTimeoutMs;
  }

  function approvalStateFor(requestId) {
    if (!requestId) return null;
    const approval = approvals.get(String(requestId));
    if (!approval) return null;
    if (approval.state === 'pending' && now() > expiryOf(approval)) {
      approval.state = 'expired';
    }
    return approval.state;
  }

  function manifest() {
    return capabilityManifest({ identity, available, extra: { now } });
  }

  /** 处理一条来自对端的信封。返回结构化结果，绝不抛给调用方（协议边界不能让异常穿透）。 */
  function handleEnvelope(raw) {
    const nowMs = now();
    pruneNonces(nowMs);

    const structural = validateEnvelope(raw, { nowMs, toNodeId: identity.nodeId });
    if (!structural.ok) {
      record({ direction: 'in', code: structural.issues[0].code, stage: 'protocol', from: raw && raw.from ? String(raw.from) : null });
      return { ok: false, stage: 'protocol', code: structural.issues[0].code, message: structural.issues[0].message };
    }

    const fromId = String(raw.from);
    const peer = trust.raw(fromId);

    if (nonces.has(String(raw.nonce))) {
      record({ direction: 'in', code: 'PROTOCOL_REPLAY', stage: 'protocol', from: fromId });
      return { ok: false, stage: 'protocol', code: 'PROTOCOL_REPLAY', message: '重复 nonce：疑似重放消息' };
    }

    // 签名校验（用对端公钥）。对端未配对时无法校验，交给授权链在 trust 阶段拒绝。
    const signatureOk = peer && peer.publicKeyPem
      ? verifyPayload(peer.publicKeyPem, signingString(raw), raw.sig)
      : false;

    if (raw.type === 'capability.request') {
      const requestId = String(raw.payload.requestId || raw.id);
      const state = approvalStateFor(requestId);
      const decision = authorizeCapabilityRequest({
        envelope: raw,
        peer,
        publicKeyPem: peer ? peer.publicKeyPem : null,
        localManifest: manifest(),
        availableCapabilities: available === null || available === undefined ? allCapabilities() : available,
        duplicateNonce: false,
        verify: (_pem, payload, sig) => verifyPayload(peer ? peer.publicKeyPem : null, payload, sig),
        approvalState: state,
        nowMs
      });

      nonces.set(String(raw.nonce), nowMs);
      record({ direction: 'in', code: decision.code, stage: decision.stage, from: fromId, capability: raw.payload.capability, decision: decision.decision });

      if (decision.decision === 'pending_approval') {
        if (!approvals.has(requestId)) {
          approvals.set(requestId, {
            requestId,
            from: fromId,
            capability: String(raw.payload.capability || ''),
            input: raw.payload.input === undefined ? null : raw.payload.input,
            state: 'pending',
            at: nowMs,
            expiresAt: nowMs + MESH_LIMITS.approvalTimeoutMs
          });
          if (approvals.size > MESH_LIMITS.pendingApprovals) {
            const oldest = [...approvals.values()].sort((a, b) => a.at - b.at)[0];
            if (oldest) approvals.delete(oldest.requestId);
          }
        }
        return { ok: true, decision: 'pending_approval', stage: 'approval', code: decision.code, requestId, message: decision.message };
      }
      if (decision.decision === 'deny') {
        if (peer) trust.touch(fromId, { error: decision.code });
        return { ok: false, decision: 'deny', stage: decision.stage, code: decision.code, message: decision.message };
      }

      // allowed：能自己处理的能力直接处理，其余交给注入的执行器（未注入则如实返回未接线）。
      if (peer) trust.touch(fromId);
      const capability = String(raw.payload.capability);
      if (capability === 'mesh.presence') {
        return { ok: true, decision: 'allow', stage: 'done', code: 'ALLOWED', result: { presence: 'online', role: identity.role, nodeId: identity.nodeId } };
      }
      if (capability === 'mesh.manifest') {
        return { ok: true, decision: 'allow', stage: 'done', code: 'ALLOWED', result: manifest() };
      }
      if (typeof executeCapability === 'function') {
        try {
          const result = executeCapability({ capability, input: raw.payload.input, from: fromId });
          return { ok: true, decision: 'allow', stage: 'done', code: 'ALLOWED', result: result === undefined ? null : result };
        } catch (error) {
          const code = (error && error.code) || 'EXECUTION_FAILED';
          if (peer) trust.touch(fromId, { error: code });
          return { ok: false, decision: 'allow', stage: 'execution', code, message: String(error && error.message) };
        }
      }
      return { ok: true, decision: 'allow', stage: 'done', code: 'ALLOWED', result: { executed: false, reason: 'executor_not_wired' } };
    }

    if (raw.type === 'presence.ping') {
      if (!peer || peer.trust !== 'trusted' || !signatureOk) {
        const code = !peer ? 'PEER_UNKNOWN' : peer.trust !== 'trusted' ? 'PEER_UNTRUSTED' : 'SIGNATURE_INVALID';
        record({ direction: 'in', code, stage: 'trust', from: fromId });
        return { ok: false, stage: 'trust', code, message: 'presence.ping 未通过信任校验' };
      }
      nonces.set(String(raw.nonce), nowMs);
      const view = trust.touch(fromId);
      record({ direction: 'in', code: 'PRESENCE_OK', stage: 'trust', from: fromId });
      return { ok: true, decision: 'allow', stage: 'done', code: 'PRESENCE_OK', result: { presence: view.presence, role: identity.role, nodeId: identity.nodeId } };
    }

    if (raw.type === 'manifest.request') {
      if (!peer || peer.trust !== 'trusted' || !signatureOk) {
        const code = !peer ? 'PEER_UNKNOWN' : peer.trust !== 'trusted' ? 'PEER_UNTRUSTED' : 'SIGNATURE_INVALID';
        record({ direction: 'in', code, stage: 'trust', from: fromId });
        return { ok: false, stage: 'trust', code, message: 'manifest.request 未通过信任校验' };
      }
      nonces.set(String(raw.nonce), nowMs);
      trust.touch(fromId);
      return { ok: true, decision: 'allow', stage: 'done', code: 'MANIFEST_OK', result: manifest() };
    }

    // pair.* 由配对流程单独处理（见 pair / createInvite）。
    record({ direction: 'in', code: 'UNSUPPORTED_VIA_ENVELOPE', stage: 'protocol', from: fromId, type: raw.type });
    return { ok: false, stage: 'protocol', code: 'UNSUPPORTED_VIA_ENVELOPE', message: '该消息类型不通过 handleEnvelope 处理：' + raw.type };
  }

  return {
    stateDir,
    identity: () => ({ nodeId: identity.nodeId, name: identity.name, role: identity.role, publicKeyPem: identity.publicKeyPem, createdAt: identity.createdAt }),
    publicKeyPem: () => identity.publicKeyPem,
    manifest,

    /** 供本地/测试构造发往其它节点的信封（本节点签发）。 */
    sign: (payload) => signPayload(identity.privateKeyPem, payload),

    createInvite({ ttlMs = 10 * 60 * 1000 } = {}) {
      const code = crypto.randomBytes(16).toString('hex');
      const at = now();
      invites.set(code, { createdAt: at, expiresAt: at + Math.max(60_000, Math.min(ttlMs, 60 * 60 * 1000)), usedAt: null });
      record({ direction: 'local', code: 'INVITE_CREATED', stage: 'pairing' });
      return { code, expiresAt: invites.get(code).expiresAt };
    },

    /** 配对：消费一次性邀请码，登记对端为 pending（配对成功 != 已信任）。 */
    pair({ inviteCode, peerPublicKeyPem, peerName, peerRole = 'mobile', transport = 'loopback', advertised = [] } = {}) {
      const code = String(inviteCode || '');
      const invite = invites.get(code);
      if (!invite) throw meshError('INVITE_NOT_FOUND', '邀请码不存在或已被使用');
      if (invite.usedAt) throw meshError('INVITE_ALREADY_USED', '邀请码已被使用');
      if (now() > invite.expiresAt) throw meshError('INVITE_EXPIRED', '邀请码已过期');
      if (!peerPublicKeyPem) throw meshError('INVALID_PARAMS', '缺少对端公钥');
      const peerNodeId = deriveNodeId(String(peerPublicKeyPem));
      if (peerNodeId === identity.nodeId) throw meshError('SELF_PAIRING', '不能与自身配对');
      if (trust.count() >= MESH_LIMITS.peers) throw meshError('PEER_LIMIT', '对端数量已达上限');
      invite.usedAt = now();
      const view = trust.addPending({
        nodeId: peerNodeId,
        name: normalizeName(peerName || peerNodeId, '对端名称'),
        role: normalizeRole(peerRole),
        publicKeyPem: String(peerPublicKeyPem),
        transport: normalizeTransport(transport),
        advertised,
        now: now()
      });
      record({ direction: 'local', code: 'PAIRED', stage: 'pairing', from: peerNodeId });
      return { peer: view, inviteCode: code };
    },

    trustNode: ({ nodeId } = {}) => {
      const view = trust.setTrust(nodeId, 'trusted');
      record({ direction: 'local', code: 'TRUST_GRANTED', stage: 'trust', from: view.nodeId });
      return { peer: view };
    },

    blockNode: ({ nodeId } = {}) => ({ peer: trust.setTrust(nodeId, 'blocked') }),

    grant: ({ nodeId, capabilities } = {}) => {
      const view = trust.grant(nodeId, normalizeCapabilityList(capabilities));
      record({ direction: 'local', code: 'CAPABILITY_GRANTED', stage: 'policy', from: view.nodeId, capabilities: normalizeCapabilityList(capabilities) });
      return { peer: view };
    },

    revoke: ({ nodeId, capabilities } = {}) => ({ peer: trust.revoke(nodeId, capabilities) }),

    disconnect: ({ nodeId } = {}) => ({ peer: trust.disconnect(nodeId) }),

    removeTrust: ({ nodeId } = {}) => {
      const view = trust.removeTrust(nodeId);
      record({ direction: 'local', code: 'TRUST_REMOVED', stage: 'trust', from: view.nodeId });
      return { peer: view };
    },

    forget: ({ nodeId } = {}) => trust.remove(nodeId),

    touch: ({ nodeId, error = null } = {}) => ({ peer: trust.touch(nodeId, { error }) }),

    peers: () => trust.list(),
    peer: ({ nodeId } = {}) => trust.view(nodeId),

    handleEnvelope,

    approvals: () => {
      const nowMs = now();
      return [...approvals.values()].map((approval) => ({
        ...approval,
        state: approval.state === 'pending' && nowMs > expiryOf(approval) ? 'expired' : approval.state
      }));
    },

    decideApproval({ requestId, decision } = {}) {
      const approval = approvals.get(String(requestId));
      if (!approval) throw meshError('APPROVAL_NOT_FOUND', '审批请求不存在：' + String(requestId));
      if (decision !== 'approve' && decision !== 'reject') {
        throw meshError('INVALID_PARAMS', 'decision 只接受 approve / reject');
      }
      if (approval.state !== 'pending') throw meshError('APPROVAL_DECIDED', '审批已处理：' + approval.state);
      if (now() > expiryOf(approval)) {
        approval.state = 'expired';
        throw meshError('APPROVAL_EXPIRED', '审批请求已超时');
      }
      approval.state = decision === 'approve' ? 'approved' : 'rejected';
      approval.decidedAt = now();
      record({ direction: 'local', code: 'APPROVAL_' + approval.state.toUpperCase(), stage: 'approval', from: approval.from, capability: approval.capability });
      return { approval: { ...approval } };
    },

    audit: () => audit.map((entry) => ({ ...entry })),

    /**
     * 节点状态。**不依赖任何对端，也不依赖 Channel Adapter**：
     * 这是「不让 QQ 生命周期决定 Desktop Core 生命周期」在代码里的落点。
     */
    status() {
      const peers = trust.list();
      return {
        nodeId: identity.nodeId,
        name: identity.name,
        role: identity.role,
        protocolVersion: MESH_PROTOCOL_VERSION,
        coreReady: true,
        coreReadinessDependsOn: [],
        peerCount: peers.length,
        trustedCount: peers.filter((p) => p.trust === 'trusted').length,
        onlineCount: peers.filter((p) => p.presence === 'online').length,
        pendingApprovals: approvals.size,
        supportedTransports: ['loopback'],
        deferredTransports: ['pipe', 'tcp', 'relay']
      };
    }
  };
}
