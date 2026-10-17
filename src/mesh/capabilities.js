// CetaMesh Desktop Node —— 本节点能力清单（阶段 11）。
//
// Capability Manifest 描述"本节点能对外提供什么"，是给对端看的**声明**。
// 声明不等于授权：对端拿到清单后仍然要逐项被本节点授权（见 trust.js 的 grants）。

import { CAPABILITY_NAMES, MESH_PROTOCOL_VERSION, NODE_CAPABILITIES } from './types.js';

/** 能力词表；是否可用由 Node 的实际执行器接线决定。 */
export function allCapabilities() {
  return [...CAPABILITY_NAMES];
}

export function capabilityManifest({ identity, available = null, extra = {} } = {}) {
  if (!identity || !identity.nodeId) throw new Error('capabilityManifest 需要 identity');
  const usable = new Set(available === null || available === undefined ? ['mesh.presence', 'mesh.manifest'] : available);
  return {
    protocolVersion: MESH_PROTOCOL_VERSION,
    nodeId: identity.nodeId,
    name: identity.name,
    role: identity.role,
    generatedAt: extra.now ? extra.now() : Date.now(),
    capabilities: CAPABILITY_NAMES.map((id) => ({
      id,
      available: usable.has(id),
      requiresApproval: NODE_CAPABILITIES[id].requiresApproval === true,
      summary: NODE_CAPABILITIES[id].summary
    }))
  };
}

/** 校验对端送来的能力声明（对端自称会什么）。未知能力直接丢弃，不做"猜"。 */
export function normalizeRemoteManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
      .map((item) => (item && typeof item === 'object' ? String(item.id || '') : String(item || '')))
      .filter((id) => CAPABILITY_NAMES.includes(id))
    : [];
  return {
    protocolVersion: Number(raw.protocolVersion) || 0,
    nodeId: raw.nodeId ? String(raw.nodeId) : null,
    name: raw.name === undefined || raw.name === null ? '' : String(raw.name),
    role: raw.role === undefined || raw.role === null ? '' : String(raw.role),
    capabilities
  };
}
