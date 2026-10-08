// CetaMesh Desktop Node —— 信任与授权（阶段 11）。
//
// 关键区分（本文件的核心）：
//   trust  = "我对这个身份的可信判断"（pending / trusted / blocked）
//   grants = "我允许它调用哪些能力"（授权）
// 两者分离，所以"已信任"的节点默认仍然**没有任何能力**——必须显式授予。
// 撤销信任 = 信任状态改 blocked + 清空 grants（一次性收回全部授权）。

import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import {
  MESH_LIMITS,
  meshError,
  normalizeCapabilityList,
  normalizeNodeId,
  normalizeRole,
  normalizeTransport,
  normalizeTrustState,
  presenceOf
} from './types.js';

const TRUST_SCHEMA_VERSION = 1;

function loadTrustFile(file, fallback) {
  try {
    return readJsonFile(file, { missing: fallback });
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === 'CORRUPT') throw meshError('TRUST_CORRUPT', '信任库解析失败：' + file);
      throw meshError('TRUST_UNREADABLE', '信任库读取失败：' + file);
    }
    throw error;
  }
}

export function createTrustStore({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createTrustStore 需要 stateDir');
  const dir = path.join(stateDir, 'mesh');
  const file = path.join(dir, 'trust.json');
  const peers = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    const raw = loadTrustFile(file, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const item of Array.isArray(raw.peers) ? raw.peers : []) {
      if (item && typeof item.nodeId === 'string' && item.nodeId) peers.set(item.nodeId, item);
    }
  }

  function persist() {
    writeJsonAtomic(file, {
      schemaVersion: TRUST_SCHEMA_VERSION,
      updatedAt: now(),
      peers: [...peers.values()]
    });
  }

  function clone(peer) {
    return peer ? JSON.parse(JSON.stringify(peer)) : null;
  }

  /** 对外投影：UI 需要 Device / Role / Trust / Transport / Last seen / Capabilities / Status / Last error。 */
  function view(peer) {
    const presence = presenceOf(peer, now());
    return {
      nodeId: peer.nodeId,
      name: peer.name,
      role: peer.role,
      trust: peer.trust,
      transport: peer.transport,
      presence,
      status: peer.trust === 'blocked' ? 'blocked' : presence,
      lastSeenAt: peer.lastSeenAt,
      lastError: peer.lastError,
      grants: [...(peer.grants || [])],
      advertised: [...(peer.advertised || [])],
      pairedAt: peer.pairedAt,
      updatedAt: peer.updatedAt
    };
  }

  return {
    file,

    list() {
      load();
      return [...peers.values()].map(view);
    },

    /** 对外投影视图（含 presence / status / 派生字段），供 UI 与节点状态使用。 */
    view(nodeId) {
      load();
      const peer = peers.get(String(nodeId));
      return peer ? view(peer) : null;
    },

    raw(nodeId) {
      load();
      return clone(peers.get(String(nodeId)));
    },

    upsert(peer) {
      load();
      peers.set(normalizeNodeId(peer.nodeId), peer);
      persist();
      return view(peer);
    },

    /** 首次配对：登记为 pending（还没被信任）。 */
    addPending({ nodeId, name, role, publicKeyPem, transport, advertised, now: at, peerDeviceId = null, keyAlgorithm = null, endpoint = null, tlsPin = null }) {
      load();
      const id = normalizeNodeId(nodeId);
      const existing = peers.get(id);
      const peer = {
        nodeId: id,
        name: String(name || '').slice(0, MESH_LIMITS.nameChars) || id,
        role: normalizeRole(role || 'mobile'),
        publicKeyPem: String(publicKeyPem || ''),
        trust: 'pending',
        transport: normalizeTransport(transport || 'loopback'),
        advertised: normalizeCapabilityList(advertised || []),
        grants: existing ? [...(existing.grants || [])] : [],
        pairedAt: at || now(),
        lastSeenAt: null,
        lastError: null,
        updatedAt: now()
      };
      // 统一配对 v1.1（可选）：对端自己的 deviceId / 算法 / 可直连端点 + 证书 pin。
      if (peerDeviceId) peer.peerDeviceId = String(peerDeviceId).slice(0, 100);
      if (keyAlgorithm) peer.keyAlgorithm = String(keyAlgorithm).slice(0, 16);
      if (endpoint) peer.endpoint = String(endpoint).slice(0, 512);
      if (tlsPin) peer.tlsPin = String(tlsPin).slice(0, 64);
      peers.set(id, peer);
      persist();
      return view(peer);
    },

    /** 按对端自己的 deviceId（如手机 UUID）查找原始记录；找不到再按 nodeId 精确查（loopback/桌面对桌面）。 */
    rawByPeerDeviceId(deviceId) {
      load();
      const text = String(deviceId || '');
      if (!text) return null;
      for (const peer of peers.values()) {
        if (peer.peerDeviceId === text) return clone(peer);
      }
      return clone(peers.get(text));
    },

    setTrust(nodeId, state) {
      load();
      const id = normalizeNodeId(nodeId);
      const peer = peers.get(id);
      if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + id);
      peer.trust = normalizeTrustState(state);
      peer.updatedAt = now();
      persist();
      return view(peer);
    },

    grant(nodeId, capabilities) {
      load();
      const id = normalizeNodeId(nodeId);
      const peer = peers.get(id);
      if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + id);
      const next = normalizeCapabilityList(capabilities);
      const merged = [...new Set([...(peer.grants || []), ...next])];
      peer.grants = merged;
      peer.updatedAt = now();
      persist();
      return view(peer);
    },

    revoke(nodeId, capabilities) {
      load();
      const id = normalizeNodeId(nodeId);
      const peer = peers.get(id);
      if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + id);
      const drop = new Set(normalizeCapabilityList(capabilities));
      peer.grants = (peer.grants || []).filter((name) => !drop.has(name));
      peer.updatedAt = now();
      persist();
      return view(peer);
    },

    touch(nodeId, { error = null } = {}) {
      load();
      const id = normalizeNodeId(nodeId);
      const peer = peers.get(id);
      if (!peer) return null;
      peer.lastSeenAt = now();
      peer.lastError = error === null || error === undefined ? null : String(error).slice(0, 400);
      peer.updatedAt = now();
      persist();
      return view(peer);
    },

    /** 断开：只影响在线状态，不改变信任，也不清授权。 */
    disconnect(nodeId) {
      load();
      const id = normalizeNodeId(nodeId);
      const peer = peers.get(id);
      if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + id);
      peer.lastSeenAt = null;
      peer.updatedAt = now();
      persist();
      return view(peer);
    },

    /** 撤销信任：信任置 blocked 并清空全部授权。 */
    removeTrust(nodeId) {
      load();
      const id = normalizeNodeId(nodeId);
      const peer = peers.get(id);
      if (!peer) throw meshError('PEER_NOT_FOUND', '对端不存在：' + id);
      peer.trust = 'blocked';
      peer.grants = [];
      peer.lastSeenAt = null;
      peer.updatedAt = now();
      persist();
      return view(peer);
    },

    remove(nodeId) {
      load();
      const id = normalizeNodeId(nodeId);
      const existed = peers.delete(id);
      if (existed) persist();
      return { nodeId: id, removed: existed };
    },

    count() {
      load();
      return peers.size;
    }
  };
}
