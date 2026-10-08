// CetaMesh 统一配对 v1.1 —— 一次性配对会话与 token 消费（协议文档 §2/§4）。
//
// 约束（与 Mobile 端同样严格）：
//   · 原始 token 只存在内存（会话对象）与发出去的邀请里，绝不写入日志或磁盘；
//   · 已消费记录只持久化 sha256(token 的 base64 文本) 指纹，且必须**先落盘再回包**
//     —— 跨重启的一次性保证不依赖内存；
//   · 同时只有一个活动会话（对应"Desktop 显示二维码"这一件事）。

import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError, readJsonFile, writeJsonAtomic } from '../../storage/json-file.js';
import { meshError } from '../types.js';
import { PAIRING_LIMITS, tokenFingerprint } from './protocol.js';

const USED_SCHEMA_VERSION = 1;
const USED_MAX_RECORDS = 200;
const USED_KEEP_MS = 24 * 60 * 60 * 1000;

function loadUsedFile(file) {
  try {
    const raw = readJsonFile(file, { missing: null });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Array.isArray(raw.used) ? raw.used.filter((item) => item && typeof item.fingerprint === 'string') : [];
  } catch (error) {
    if (error instanceof StorageError) {
      // 消费记录是安全状态：损坏时 fail-closed（拒绝新配对），绝不静默重置。
      if (error.code === 'CORRUPT') throw meshError('PAIRING_STATE_CORRUPT', '配对消费记录解析失败：' + file);
      throw meshError('PAIRING_STATE_UNREADABLE', '配对消费记录读取失败：' + file);
    }
    throw error;
  }
}

export function createInvitationStore({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createInvitationStore 需要 stateDir');
  const file = path.join(stateDir, 'mesh', 'pairing-used.json');
  let session = null;
  let sequence = 0;

  function persistUsed(records) {
    writeJsonAtomic(file, { schemaVersion: USED_SCHEMA_VERSION, updatedAt: now(), used: records });
  }

  function prune(records) {
    const cutoff = now() - USED_KEEP_MS;
    const kept = records.filter((item) => Number(item.expiresAt || 0) >= cutoff);
    return kept.slice(-USED_MAX_RECORDS);
  }

  return {
    file,

    /** 创建（并替换）唯一活动配对会话。返回邀请对象（含一次性 token，仅内存）。 */
    createSession({ endpoint, peer, tlsPin = null, ttlMs = PAIRING_LIMITS.invitationTtlMs } = {}) {
      const at = now();
      const ttl = Math.max(60_000, Math.min(Number(ttlMs) || PAIRING_LIMITS.invitationTtlMs, PAIRING_LIMITS.maxTtlMs));
      session = {
        sessionId: 'pair_' + crypto.randomBytes(8).toString('hex'),
        invitationId: 'inv_' + crypto.randomBytes(12).toString('hex'),
        token: crypto.randomBytes(32).toString('base64'),
        createdAt: at,
        expiresAt: at + ttl,
        endpoint: String(endpoint || ''),
        peer,
        tlsPin: tlsPin ? String(tlsPin) : null,
        consumedAt: null,
        consumedBy: null,
        finalizedAt: null,
        peerNodeId: null
      };
      sequence += 1;
      return {
        sessionId: session.sessionId,
        invitationId: session.invitationId,
        token: session.token,
        expiresAt: session.expiresAt,
        peer,
        tlsPin: session.tlsPin
      };
    },

    /** 对外状态投影：绝不包含 token。 */
    active() {
      if (!session) return { active: false, sessionId: null, expiresAt: null, consumedBy: null, peerNodeId: null, expired: false };
      return {
        active: true,
        sessionId: session.sessionId,
        invitationId: session.invitationId,
        endpoint: session.endpoint,
        expiresAt: session.expiresAt,
        consumedBy: session.consumedBy,
        peerNodeId: session.peerNodeId,
        expired: now() > session.expiresAt
      };
    },

    raw() {
      return session ? { ...session } : null;
    },

    /**
     * 原子消费：invitationId 匹配 + token 指纹未用过 + 未过期。
     * 指纹先持久化再返回；此后任何重复使用都会被拒绝（跨重启亦然）。
     */
    consume({ invitationId, token, peerDeviceId = null } = {}) {
      const current = session;
      if (!current) throw meshError('REFUSED_NOT_FOUND', '没有活动配对会话');
      if (current.consumedAt) throw meshError('REFUSED_CONSUMED', '该邀请已被使用');
      if (now() > current.expiresAt) throw meshError('REFUSED_EXPIRED', '配对邀请已过期');
      if (String(invitationId) !== current.invitationId) throw meshError('REFUSED_NOT_FOUND', '邀请编号不匹配');
      const presented = tokenFingerprint(token);
      const expected = tokenFingerprint(current.token);
      const match = crypto.timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
      if (!match) throw meshError('REFUSED_REQUEST', '配对 token 校验失败');

      const records = loadUsedFile(file);
      if (records.some((item) => item.fingerprint === presented)) {
        throw meshError('REFUSED_CONSUMED', '该配对 token 已被消费');
      }
      const next = prune(records.concat([{
        fingerprint: presented,
        invitationId: current.invitationId,
        expiresAt: current.expiresAt,
        consumedAt: now(),
        consumedBy: peerDeviceId ? String(peerDeviceId).slice(0, 100) : null
      }]));
      persistUsed(next);

      current.consumedAt = now();
      current.consumedBy = peerDeviceId ? { deviceId: String(peerDeviceId).slice(0, 100) } : null;
      return { sessionId: current.sessionId, consumedAt: current.consumedAt };
    },

    markFinalized({ peerNodeId = null, peerName = null } = {}) {
      if (!session) return;
      session.finalizedAt = now();
      session.peerNodeId = peerNodeId;
      if (peerName) session.consumedBy = { ...(session.consumedBy || {}), name: String(peerName).slice(0, 100) };
    },

    cancel() {
      const had = Boolean(session);
      session = null;
      return { cancelled: had };
    },

    /** 测试/审计用：已消费指纹。 */
    usedFingerprints() {
      return loadUsedFile(file).map((item) => item.fingerprint);
    }
  };
}
