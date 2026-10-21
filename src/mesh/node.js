// CetaMesh Desktop Node —— Mesh 节点运行时（阶段 11）。
//
// 把身份、配对、信任、在线、能力清单、远程请求授权链组装成一个标准 CetaMesh Node。
//
// 关键不变量（有测试锁住）：
//   Core readiness 不依赖任何对端，也不依赖 QQ / SnowLuma 等 Channel Adapter。
//   没有任何 peer、所有 peer 离线、channel adapter 出错 —— 本节点仍然是 ready。

import crypto from 'node:crypto';
import path from 'node:path';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { capabilityManifest } from './capabilities.js';
import {
  deriveNodeId,
  loadOrCreateIdentity,
  publicKeyPemToX963,
  signPayload,
  verifyPayload,
  x963ToPublicKeyPem
} from './identity.js';
import {
  authorizeCapabilityRequest,
  createEnvelope,
  signingString,
  validateEnvelope
} from './protocol.js';
import {
  PAIRING_LIMITS,
  createInvitationEnvelope,
  createMeshEnvelope,
  normalizeEndpointOrigin,
  normalizeIso,
  normalizeNonce,
  normalizePeerIdentity,
  normalizeSignature,
  normalizeTlsPin,
  transcript,
  validateCetameshEnvelope,
  validateMeshEnvelope
} from './pairing/protocol.js';
import { createInvitationStore } from './pairing/invitations.js';
import { createMeshPairingServer } from './pairing/server.js';
import { requestPeerMesh } from './pairing/client.js';
import { loadOrCreatePairingTls, pickLanAddress } from './pairing/tls.js';
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
  presenceTtlMs = () => MESH_LIMITS.presenceTtlMs,
  isEnabled = () => true,
  now = () => Date.now()
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMeshNode 需要 stateDir');
  const identity = loadOrCreateIdentity({ stateDir, name, role, now });
  const trust = createTrustStore({ stateDir, now, presenceTtlMs });
  const availableCapabilities = [...new Set(['mesh.presence', 'mesh.manifest',
    ...(typeof executeCapability === 'function' ? normalizeCapabilityList(available ?? []) : [])])];

  const nonces = new Map();      // nonce -> ts（重放防护）
  const approvals = new Map();   // requestId -> { state, ... }
  const invites = new Map();     // code -> { createdAt, expiresAt, usedAt }
  const audit = [];              // 最近的授权决策

  // 统一配对 v1.1（QR + HTTPS + token + 签名 transcript + TLS pinning）。
  const invitations = createInvitationStore({ stateDir, now });
  let pairingTls = null;         // 配对 TLS 身份（懒加载，持久化于 state/mesh/pairing-tls.json）
  let pairingServer = null;      // 配对服务器（首次会话时启动；重启后端口/证书稳定）
  let pendingPairing = null;     // exchange 已完成、等待 confirm 的配对
  const transportFile = path.join(stateDir, 'mesh', 'transport.json');
  let transport = { listening: false, endpoint: null, port: null, error: null };
  let transportOperation = Promise.resolve();
  let disposed = false;
  let closePromise = null;
  function serializeTransport(operation) {
    const result = transportOperation.then(operation, operation);
    transportOperation = result.catch(() => { /* Keep the lifecycle queue usable after a diagnosed failure. */ });
    return result;
  }
  function hasPairedTransport() {
    return trust.list().some(peer => peer.trust === 'trusted' && peer.transport === 'tcp' && trust.raw(peer.nodeId)?.peerDeviceId);
  }
  async function ensureTransport({ invitation = false } = {}) {
    requireEnabled();
    if (!invitation && !hasPairedTransport()) return { ...transport };
    try {
      const stored = readJsonFile(transportFile, { missing: null });
      // Restoring a paired listener must reuse its certificate and stable port.
      if (!invitation && !readJsonFile(path.join(stateDir, 'mesh', 'pairing-tls.json'), { missing: null })) {
        throw meshError('PAIRING_TRANSPORT_MISSING', 'Paired TLS transport configuration is missing');
      }
      if (!pairingTls) pairingTls = await loadOrCreatePairingTls({ stateDir, name: identity.name, now });
      requireEnabled();
      if (!pairingServer) pairingServer = createMeshPairingServer({
        tls: pairingTls,
        handlers: { exchange: handlePairingExchange, confirm: handlePairingConfirm, mesh: handlePairingMesh },
        log: entry => record({ direction: 'local', code: 'PAIRING_SERVER_' + entry.code, stage: 'pairing' })
      });
      const port = stored?.port ?? pairingTls.port;
      const started = await pairingServer.start({ port, fallbackPort: hasPairedTransport() ? null : 0 });
      if (disposed || isEnabled() !== true) { await pairingServer.stop(); requireEnabled(); }
      const address = stored?.endpoint ? new URL(stored.endpoint).hostname : pickLanAddress();
      if (!address) { await pairingServer.stop(); throw meshError('PAIRING_NO_LAN', 'No LAN address available for pairing'); }
      const endpoint = 'https://' + address + ':' + started.port;
      writeJsonAtomic(transportFile, { schemaVersion: 1, endpoint, port: started.port });
      transport = { listening: true, endpoint, port: started.port, error: null };
      return { ...transport, fallback: Boolean(started.fallback) };
    } catch (error) {
      if (error instanceof StorageError) error = meshError('PAIRING_TRANSPORT_' + error.code, 'Paired transport configuration could not be loaded or saved');
      transport = { ...transport, listening: Boolean(pairingServer?.listening()), error: { code: error.code ?? 'PAIRING_TRANSPORT_FAILED', message: String(error.message).slice(0, 300) } };
      throw error;
    }
  }
  function restoreTransport() {
    return serializeTransport(() => {
      if (disposed) throw meshError('MESH_CLOSED', 'Device Mesh service is closed');
      return isEnabled() === true ? ensureTransport() : { ...transport };
    });
  }
  function requireEnabled() {
    if (disposed) throw meshError('MESH_CLOSED', 'Device Mesh service is closed');
    if (isEnabled() !== true) throw meshError('MESH_DISABLED', 'Device Mesh is disabled in Settings');
  }

  // 配对完成后的默认授权（Trusted != Authorized：仅这两个低风险能力默认放行）。
  const PAIRING_DEFAULT_GRANTS = Object.freeze(['mesh.presence', 'mesh.manifest']);

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
    return capabilityManifest({ identity, available: isEnabled() === true ? availableCapabilities : [], extra: { now } });
  }

  /** 处理一条来自对端的信封。返回结构化结果，绝不抛给调用方（协议边界不能让异常穿透）。 */
  function handleEnvelope(raw) {
    requireEnabled();
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
        availableCapabilities,
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
      return { ok: false, decision: 'deny', stage: 'availability', code: 'CAPABILITY_UNAVAILABLE' };
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

  // ── 统一配对 v1.1：本机公开身份 / 邀请视图 / cetamesh 响应信封 ─────────────

  function localPeerIdentity() {
    return {
      deviceId: identity.nodeId,
      deviceName: identity.name,
      publicKey: publicKeyPemToX963(identity.publicKeyPem),
      keyAlgorithm: 'p256'
    };
  }

  function invitationPublicView(session) {
    return {
      invitationId: session.invitationId,
      endpoint: session.endpoint,
      peer: { deviceId: identity.nodeId, publicKey: publicKeyPemToX963(identity.publicKeyPem) },
      expiresAt: new Date(session.expiresAt).toISOString(),
      tlsPin: session.tlsPin || null
    };
  }

  function pairingEnvelope(type, payload, nowMs) {
    return {
      protocol: 'cetamesh',
      version: 1,
      id: 'desktop-pairing-' + crypto.randomBytes(8).toString('hex'),
      type,
      timestamp: new Date(nowMs).toISOString(),
      payload
    };
  }

  function parseCetameshRequest(rawText, { maxChars, expectedType }) {
    let parsed;
    try { parsed = JSON.parse(String(rawText || '')); } catch { throw meshError('REFUSED_REQUEST', '请求不是合法 JSON'); }
    const envelope = validateCetameshEnvelope(parsed, { nowMs: now(), maxChars });
    if (envelope.type !== expectedType) {
      throw meshError('REFUSED_REQUEST', '该端点不接受消息类型：' + envelope.type);
    }
    return envelope;
  }

  /** POST /cetamesh/v1/pairing/exchange：校验 token/签名/时效并原子消费，返回 challenge。 */
  function handlePairingExchange(rawText) {
    requireEnabled();
    const nowMs = now();
    pruneNonces(nowMs);
    const envelope = parseCetameshRequest(rawText, { maxChars: PAIRING_LIMITS.requestChars, expectedType: 'pairing.exchange' });
    const session = invitations.raw();
    if (!session) throw meshError('REFUSED_NOT_FOUND', '没有活动配对会话');
    if (nowMs > session.expiresAt) throw meshError('REFUSED_EXPIRED', '配对邀请已过期');

    const payload = envelope.payload;
    if (String(payload.invitationId) !== session.invitationId) {
      throw meshError('REFUSED_NOT_FOUND', '邀请编号不匹配');
    }
    const platform = String(payload.device && payload.device.platform || '');
    if (!['android', 'ios'].includes(platform)) throw meshError('REFUSED_REQUEST', '非法 platform');
    const createdAt = normalizeIso(payload.device && payload.device.createdAt);
    const device = { ...normalizePeerIdentity(payload.device), platform, createdAt };
    const peerPublicKeyPem = x963ToPublicKeyPem(device.publicKey);
    const peerNodeId = deriveNodeId(peerPublicKeyPem);
    if (peerNodeId === identity.nodeId) throw meshError('REFUSED_REQUEST', '不能与自身配对');
    const nonce = normalizeNonce(payload.nonce);
    const signature = normalizeSignature(payload.signature);

    const view = invitationPublicView(session);
    if (!verifyPayload(peerPublicKeyPem, transcript(view, device, nonce, 'exchange'), signature)) {
      record({ direction: 'in', code: 'REFUSED_SIGNATURE', stage: 'pairing', from: device.deviceId });
      throw meshError('REFUSED_SIGNATURE', 'exchange 签名校验失败');
    }
    invitations.consume({ invitationId: payload.invitationId, token: payload.token, peerDeviceId: device.deviceId });
    if (nonces.has('pairing:' + nonce)) throw meshError('REFUSED_REPLAY', '重复的 exchange nonce');
    nonces.set('pairing:' + nonce, nowMs);

    pendingPairing = {
      sessionId: session.sessionId,
      invitationId: session.invitationId,
      invitationView: view,
      nonce,
      expiresAt: session.expiresAt,
      device: { ...device, publicKeyPem: peerPublicKeyPem, nodeId: peerNodeId },
      endpoint: payload.endpoint ? normalizeEndpointOrigin(payload.endpoint) : null,
      tlsPin: payload.tlsPin ? normalizeTlsPin(payload.tlsPin) : null,
      finalized: false
    };
    record({ direction: 'in', code: 'PAIRING_EXCHANGE_OK', stage: 'pairing', from: device.deviceId });

    const challengeSignature = signPayload(identity.privateKeyPem, transcript(view, device, nonce, 'challenge'));
    return {
      envelope: pairingEnvelope('pairing.challenge', {
        invitationId: session.invitationId,
        nonce,
        peer: localPeerIdentity(),
        expiresAt: view.expiresAt,
        signature: challengeSignature
      }, nowMs)
    };
  }

  /** POST /cetamesh/v1/pairing/confirm：校验 confirm 签名；提交信任（幂等）后返回 accepted。 */
  function handlePairingConfirm(rawText) {
    requireEnabled();
    const nowMs = now();
    const envelope = parseCetameshRequest(rawText, { maxChars: PAIRING_LIMITS.requestChars, expectedType: 'pairing.confirm' });
    const pending = pendingPairing;
    if (!pending || !invitations.raw()) throw meshError('REFUSED_NOT_FOUND', '没有等待确认的配对');
    if (nowMs > pending.expiresAt) throw meshError('REFUSED_EXPIRED', '配对邀请已过期');

    const payload = envelope.payload;
    if (String(payload.invitationId) !== pending.invitationId) throw meshError('REFUSED_NOT_FOUND', '邀请编号不匹配');
    if (normalizeNonce(payload.nonce) !== pending.nonce) throw meshError('REFUSED_REQUEST', 'nonce 不匹配');
    if (String(payload.deviceId) !== pending.device.deviceId) throw meshError('REFUSED_REQUEST', 'deviceId 不匹配');
    const signature = normalizeSignature(payload.signature);
    if (!verifyPayload(pending.device.publicKeyPem, transcript(pending.invitationView, pending.device, pending.nonce, 'confirm'), signature)) {
      record({ direction: 'in', code: 'REFUSED_SIGNATURE', stage: 'pairing', from: pending.device.deviceId });
      throw meshError('REFUSED_SIGNATURE', 'confirm 签名校验失败');
    }

    if (!pending.finalized) {
      trust.addPending({
        nodeId: pending.device.nodeId,
        name: pending.device.deviceName,
        role: 'mobile',
        publicKeyPem: pending.device.publicKeyPem,
        transport: 'tcp',
        advertised: [],
        peerDeviceId: pending.device.deviceId,
        keyAlgorithm: pending.device.keyAlgorithm || 'p256',
        endpoint: pending.endpoint,
        tlsPin: pending.tlsPin,
        now: nowMs
      });
      trust.setTrust(pending.device.nodeId, 'trusted');
      trust.grant(pending.device.nodeId, [...PAIRING_DEFAULT_GRANTS]);
      pending.finalized = true;
      invitations.markFinalized({ peerNodeId: pending.device.nodeId, peerName: pending.device.deviceName });
      record({ direction: 'local', code: 'PAIRED_TRUSTED', stage: 'pairing', from: pending.device.nodeId });
    }

    const acceptedSignature = signPayload(identity.privateKeyPem, transcript(pending.invitationView, pending.device, pending.nonce, 'accepted'));
    return {
      envelope: pairingEnvelope('pairing.accepted', {
        invitationId: pending.invitationId,
        nonce: pending.nonce,
        peer: localPeerIdentity(),
        expiresAt: pending.invitationView.expiresAt,
        signature: acceptedSignature
      }, nowMs)
    };
  }

  /**
   * 配对完成后的远程能力请求 —— Trusted != Authorized 的同一条链：
   * 已声明 → 已显式授予（grants）→ 需要审批的能力必须有本地批准。
   */
  function meshCapabilityDecision(peer, capability, input, requestId, nowMs) {
    const name = String(capability || '');
    const declared = manifest().capabilities.find((item) => item.id === name);
    if (!declared) return { decision: 'deny', code: 'CAPABILITY_NOT_DECLARED' };
    if (declared.available !== true) return { decision: 'deny', code: 'CAPABILITY_UNAVAILABLE' };
    const grants = Array.isArray(peer.grants) ? peer.grants : [];
    if (!grants.includes(name)) return { decision: 'deny', code: 'CAPABILITY_NOT_AUTHORIZED' };
    const state = approvalStateFor(requestId);
    if (declared.requiresApproval === true) {
      if (!state || state === 'pending') {
        if (!approvals.has(requestId)) {
          approvals.set(requestId, {
            requestId,
            from: peer.nodeId,
            capability: name,
            input: input === undefined ? null : input,
            state: 'pending',
            at: nowMs,
            expiresAt: nowMs + MESH_LIMITS.approvalTimeoutMs
          });
          if (approvals.size > MESH_LIMITS.pendingApprovals) {
            const oldest = [...approvals.values()].sort((a, b) => a.at - b.at)[0];
            if (oldest) approvals.delete(oldest.requestId);
          }
        }
        return { decision: 'pending_approval', code: 'APPROVAL_REQUIRED' };
      }
      if (state === 'rejected') return { decision: 'deny', code: 'APPROVAL_REJECTED' };
      if (state === 'expired') return { decision: 'deny', code: 'APPROVAL_EXPIRED' };
      if (state !== 'approved') return { decision: 'deny', code: 'APPROVAL_UNKNOWN' };
    }
    if (name === 'mesh.presence') {
      return { decision: 'allow', code: 'ALLOWED', result: { presence: 'online', role: identity.role, nodeId: identity.nodeId } };
    }
    if (name === 'mesh.manifest') {
      return { decision: 'allow', code: 'ALLOWED', result: manifest() };
    }
    if (typeof executeCapability === 'function') {
      try {
        const result = executeCapability({ capability: name, input, from: peer.nodeId });
        return { decision: 'allow', code: 'ALLOWED', result: result === undefined ? null : result };
      } catch (error) {
        return { decision: 'allow', code: (error && error.code) || 'EXECUTION_FAILED' };
      }
    }
    return { decision: 'deny', code: 'CAPABILITY_UNAVAILABLE' };
  }

  /** POST /cetamesh/v1/mesh/envelope：配对后的 presence / manifest / capability 通道。 */
  function handlePairingMesh(rawText) {
    requireEnabled();
    const nowMs = now();
    pruneNonces(nowMs);
    let parsed;
    try { parsed = JSON.parse(String(rawText || '')); } catch { throw meshError('REFUSED_REQUEST', '请求不是合法 JSON'); }
    const message = validateMeshEnvelope(parsed, { nowMs, toDeviceId: identity.nodeId });

    const peer = trust.rawByPeerDeviceId(message.from);
    if (!peer) throw meshError('PEER_UNKNOWN', '未配对的对端：' + String(message.from).slice(0, 40));
    if (peer.trust !== 'trusted') throw meshError('PEER_UNTRUSTED', '对端未被信任（当前 ' + peer.trust + '）');
    if (!verifyPayload(peer.publicKeyPem, message.signingString, message.signature)) {
      throw meshError('REFUSED_SIGNATURE', 'Mesh 消息签名校验失败');
    }
    if (nonces.has('mesh:' + message.id) || nonces.has('mesh:' + message.nonce)) {
      throw meshError('REFUSED_REPLAY', '重复的 Mesh 消息');
    }
    nonces.set('mesh:' + message.id, nowMs);
    nonces.set('mesh:' + message.nonce, nowMs);

    let responseType;
    let responsePayload;
    if (message.type === 'mesh.presence.ping') {
      trust.touch(peer.nodeId);
      responseType = 'mesh.presence.pong';
      responsePayload = { presence: 'online', role: identity.role, nodeId: identity.nodeId, at: new Date(nowMs).toISOString() };
      record({ direction: 'in', code: 'PRESENCE_OK', stage: 'trust', from: peer.nodeId });
    } else if (message.type === 'mesh.manifest.request') {
      trust.touch(peer.nodeId);
      responseType = 'mesh.manifest.response';
      responsePayload = manifest();
      record({ direction: 'in', code: 'MANIFEST_OK', stage: 'trust', from: peer.nodeId });
    } else if (message.type === 'mesh.capability.request') {
      const capability = String(message.payload.capability || '');
      const requestId = String(message.payload.requestId || message.id);
      const decision = meshCapabilityDecision(peer, capability, message.payload.input, requestId, nowMs);
      record({ direction: 'in', code: decision.code, stage: 'capability', from: peer.nodeId, capability, decision: decision.decision });
      responseType = 'mesh.capability.response';
      responsePayload = {
        requestId,
        decision: decision.decision,
        code: decision.code,
        ...(decision.result === undefined ? {} : { result: decision.result })
      };
    } else {
      throw meshError('REFUSED_REQUEST', '该消息类型不接受入站请求：' + message.type);
    }

    return {
      envelope: createMeshEnvelope({
        type: responseType,
        from: identity.nodeId,
        to: message.from,
        payload: responsePayload,
        privateKeyPem: identity.privateKeyPem,
        nowMs
      })
    };
  }

  // ── 公开操作：配对会话 / 反向能力请求 / 关闭 ────────────────────────────────

  async function startPairingSession({ ttlMs } = {}) {
    requireEnabled();
    const started = await serializeTransport(() => ensureTransport({ invitation: true }));
    requireEnabled();
    const endpoint = started.endpoint;
    const session = invitations.createSession({
      endpoint,
      peer: localPeerIdentity(),
      tlsPin: pairingTls.fingerprint,
      ttlMs
    });
    const envelope = createInvitationEnvelope({
      invitationId: session.invitationId,
      endpoint,
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      peer: session.peer,
      tlsPin: session.tlsPin
    }, { nowMs: now() });
    pendingPairing = null;
    record({ direction: 'local', code: 'PAIRING_SESSION_STARTED', stage: 'pairing' });
    return {
      sessionId: session.sessionId,
      invitation: JSON.stringify(envelope),
      endpoint,
      port: started.port,
      portFallback: Boolean(started.fallback),
      expiresAt: session.expiresAt,
      tlsPin: pairingTls.fingerprint,
      tlsReused: Boolean(pairingTls.reused),
      deviceName: identity.name,
      nodeId: identity.nodeId
    };
  }

  function pairingStatus() {
    return invitations.active();
  }

  function cancelPairingSession() {
    const result = invitations.cancel();
    pendingPairing = null;
    if (result.cancelled) record({ direction: 'local', code: 'PAIRING_SESSION_CANCELLED', stage: 'pairing' });
    return { cancelled: result.cancelled };
  }

  /** 向已配对对端发起真实远程能力请求（如 notification.send）：pin 外联 + Mesh 通道签名请求。 */
  async function requestPeerCapability({ nodeId, capability, input = null } = {}) {    const peer = trust.raw(nodeId);
    requireEnabled();
    if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + String(nodeId));
    if (peer.trust !== 'trusted') throw meshError('PEER_UNTRUSTED', '对端未被信任（当前 ' + peer.trust + '）');
    const name = String(capability || '').trim();
    if (!name || name.length > 64) throw meshError('INVALID_PARAMS', 'capability 非法');
    if (Array.isArray(peer.advertised) && peer.advertised.length && !peer.advertised.includes(name)) {
      throw meshError('CAPABILITY_NOT_ADVERTISED', '对端未声明该能力：' + name);
    }
    const response = await requestPeerMesh({
      peer,
      identity,
      privateKeyPem: identity.privateKeyPem,
      type: 'mesh.capability.request',
      payload: { capability: name, input, requestId: 'req_' + crypto.randomBytes(6).toString('hex') },
      expectType: 'mesh.capability.response'
    });
    record({ direction: 'out', code: 'REMOTE_CAPABILITY_' + String(response.payload.decision || 'unknown').toUpperCase(), stage: 'capability', from: peer.nodeId, capability: name });
    return { nodeId: peer.nodeId, response: response.payload };
  }

  function suspendTransport({ revokePairing = true } = {}) {
    if (revokePairing) {
      pendingPairing = null;
      invitations.cancel();
      invites.clear();
      for (const approval of approvals.values()) if (approval.state === 'pending') approval.state = 'revoked';
    }
    return serializeTransport(async () => {
      if (pairingServer) await pairingServer.stop();
      transport = { ...transport, listening: false };
    });
  }

  function close() {
    if (closePromise) return closePromise;
    // Terminal before yielding: queued restores and pending TLS setup cannot reopen.
    disposed = true;
    closePromise = suspendTransport({ revokePairing: true });
    return closePromise;
  }

  /** 读取已配对对端的能力清单（pin 外联，对端需提供 endpoint+tlsPin）。 */
  async function requestPeerManifest({ nodeId } = {}) {
    requireEnabled();
    const peer = trust.raw(nodeId);
    if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + String(nodeId));
    if (peer.trust !== 'trusted') throw meshError('PEER_UNTRUSTED', '对端未被信任（当前 ' + peer.trust + '）');
    const response = await requestPeerMesh({
      peer,
      identity,
      privateKeyPem: identity.privateKeyPem,
      type: 'mesh.manifest.request',
      payload: {},
      expectType: 'mesh.manifest.response'
    });
    record({ direction: 'out', code: 'REMOTE_MANIFEST_OK', stage: 'capability', from: peer.nodeId });
    return { nodeId: peer.nodeId, manifest: response.payload };
  }

  return {
    stateDir,
    identity: () => ({
      nodeId: identity.nodeId,
      name: identity.name,
      role: identity.role,
      publicKeyPem: identity.publicKeyPem,
      keyAlgorithm: identity.keyAlgorithm || 'p256',
      createdAt: identity.createdAt,
      ...(identity.legacyNodeId ? { legacyNodeId: identity.legacyNodeId, migratedAt: identity.migratedAt } : {})
    }),
    publicKeyPem: () => identity.publicKeyPem,
    manifest,

    /** 供本地/测试构造发往其它节点的信封（本节点签发）。 */
    sign: (payload) => signPayload(identity.privateKeyPem, payload),

    createInvite({ ttlMs = 10 * 60 * 1000 } = {}) {
      requireEnabled();
      const code = crypto.randomBytes(16).toString('hex');
      const at = now();
      invites.set(code, { createdAt: at, expiresAt: at + Math.max(60_000, Math.min(ttlMs, 60 * 60 * 1000)), usedAt: null });
      record({ direction: 'local', code: 'INVITE_CREATED', stage: 'pairing' });
      return { code, expiresAt: invites.get(code).expiresAt };
    },

    /** 配对：消费一次性邀请码，登记对端为 pending（配对成功 != 已信任）。 */
    pair({ inviteCode, peerPublicKeyPem, peerName, peerRole = 'mobile', transport = 'loopback', advertised = [] } = {}) {
      requireEnabled();
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
      requireEnabled();
      const view = trust.setTrust(nodeId, 'trusted');
      record({ direction: 'local', code: 'TRUST_GRANTED', stage: 'trust', from: view.nodeId });
      return { peer: view };
    },

    blockNode: ({ nodeId } = {}) => ({ peer: trust.setTrust(nodeId, 'blocked') }),

    grant: ({ nodeId, capabilities } = {}) => {
      requireEnabled();
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
      requireEnabled();
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

    // ── 统一配对 v1.1（QR 邀请 / HTTPS 配对 / 配对后 Mesh 通道）────────────────
    startPairingSession,
    restoreTransport,
    suspendTransport,
    pairingStatus,
    cancelPairingSession,
    requestPeerCapability,
    requestPeerManifest,
    close,

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
        meshEnabled: isEnabled() === true,
        coreReady: true,
        transport: { ...transport },
        coreReadinessDependsOn: [],
        peerCount: peers.length,
        trustedCount: peers.filter((p) => p.trust === 'trusted').length,
        onlineCount: peers.filter((p) => p.presence === 'online').length,
        pendingApprovals: approvals.size,
        supportedTransports: ['loopback', 'tcp'],
        deferredTransports: ['pipe', 'relay']
      };
    }
  };
}
