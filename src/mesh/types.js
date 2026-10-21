// CetaMesh Desktop Node —— Device Mesh 领域契约（阶段 11）。
//
// 目标：让 Desktop 成为标准 CetaMesh Node（不是 Mobile 的遥控器，也不是 QQ 的附属）。
// 本文件只定义词表与纯函数：节点角色、信任状态、在线状态、传输类型、协议版本、能力清单校验。
//
// 两条必须区分的原则：
//   Trusted != Authorized        —— 信任一个节点，不等于授权它调用任何能力。
//   Capability Advertised != Authorized —— 对端"声称"有能力，不等于本地必须响应。

export const MESH_PROTOCOL_VERSION = 1;

export const NODE_ROLES = Object.freeze(['desktop', 'mobile', 'server', 'edge']);

/** 信任状态。trusted 只表示"身份可信"，能力另由 grants 决定。 */
export const TRUST_STATES = Object.freeze(['pending', 'trusted', 'blocked']);

export const PRESENCE_STATES = Object.freeze(['unknown', 'online', 'offline']);

/**
 * 传输类型。
 * loopback 是进程内/本地自测用的真实传输；pipe/tcp/relay 是跨设备形态，
 * 本阶段**只声明不实现**——真实跨设备链路需要另一台 CetaMesh Node，属 PENDING_NATIVE_VERIFICATION。
 */
export const TRANSPORT_KINDS = Object.freeze(['loopback', 'pipe', 'tcp', 'relay']);

/** 本节点可以对外提供的能力。Advertised != Authorized：默认不授予任何对端。 */
export const NODE_CAPABILITIES = Object.freeze({
  'mesh.presence': { requiresApproval: false, summary: '查询本节点在线状态与角色' },
  'mesh.manifest': { requiresApproval: false, summary: '读取本节点能力清单' },
  'chat.session': { requiresApproval: true, summary: '在 CetaMesh Chat 中创建/继续会话' },
  'memory.query': { requiresApproval: true, summary: '在授权范围内检索 CetaMesh Memory' },
  'task.manage': { requiresApproval: true, summary: '读取与推进 CetaMesh Persistent Task' },
  'workspace.files': { requiresApproval: true, summary: '在 Workspace 边界内读写文件' },
  'extension.invoke': { requiresApproval: true, summary: '调用已安装扩展的能力' }
});

export const CAPABILITY_NAMES = Object.freeze(Object.keys(NODE_CAPABILITIES));

export const MESH_LIMITS = Object.freeze({
  nameChars: 80,
  nodeIdChars: 80,
  inviteCodeChars: 64,
  peers: 200,
  grants: 32,
  pendingApprovals: 100,
  approvalTimeoutMs: 10 * 60 * 1000,
  presenceTtlMs: 90 * 1000,
  envelopeChars: 256 * 1024,
  audit: 500
});

export function meshError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function isKnownCapability(name) {
  return Object.hasOwn(NODE_CAPABILITIES, name);
}

export function capabilityRequiresApproval(name) {
  const entry = NODE_CAPABILITIES[name];
  return entry ? entry.requiresApproval === true : true; // 未知能力一律按需要审批（fail-closed）
}

const NODE_ID_RE = /^node_[a-f0-9]{8,64}$/;

export function normalizeNodeId(value) {
  const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!NODE_ID_RE.test(text)) {
    throw meshError('INVALID_NODE_ID', '非法节点 id：' + text.slice(0, 40));
  }
  return text;
}

export function normalizeRole(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!NODE_ROLES.includes(text)) throw meshError('INVALID_ROLE', '未知节点角色：' + text.slice(0, 40));
  return text;
}

export function normalizeTrustState(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!TRUST_STATES.includes(text)) throw meshError('INVALID_TRUST_STATE', '未知信任状态：' + text.slice(0, 40));
  return text;
}

export function normalizeTransport(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!TRANSPORT_KINDS.includes(text)) throw meshError('INVALID_TRANSPORT', '未知传输类型：' + text.slice(0, 40));
  return text;
}

export function normalizeName(value, label = 'name') {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) throw meshError('INVALID_PARAMS', label + '不能为空');
  if (text.length > MESH_LIMITS.nameChars) throw meshError('INVALID_PARAMS', label + '超过 ' + MESH_LIMITS.nameChars + ' 字符');
  return text;
}

export function normalizeCapabilityList(value, label = 'capabilities') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw meshError('INVALID_PARAMS', label + '必须是数组');
  const out = [];
  for (const raw of value) {
    const name = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!name) continue;
    if (!isKnownCapability(name)) throw meshError('UNKNOWN_CAPABILITY', '未知能力：' + name.slice(0, 40));
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MESH_LIMITS.grants) throw meshError('INVALID_PARAMS', label + '最多 ' + MESH_LIMITS.grants + ' 项');
  return out;
}

/** 在线判定：基于 lastSeenAt 与 TTL。 */
export function presenceOf(peer, nowMs, ttlMs = MESH_LIMITS.presenceTtlMs) {
  if (!peer || peer.lastSeenAt === null || peer.lastSeenAt === undefined) return 'unknown';
  const lastSeen = Number(peer.lastSeenAt);
  if (!Number.isSafeInteger(lastSeen) || lastSeen < 0 || !Number.isSafeInteger(nowMs) || nowMs < lastSeen
    || !Number.isSafeInteger(ttlMs) || ttlMs < 10000 || ttlMs > 600000) return 'unknown';
  return nowMs - lastSeen <= ttlMs ? 'online' : 'offline';
}
