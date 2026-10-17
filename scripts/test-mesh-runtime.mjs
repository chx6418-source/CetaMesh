// CetaMesh Desktop — Device Mesh Desktop 验收测试（阶段 11）。
// 用法：node scripts/test-mesh-runtime.mjs
//
// 覆盖：Device Identity / Node Role / Pairing / Trust / Presence / Capability Manifest /
//       Peer status / Disconnect / Remove Trust，以及远程能力请求的完整授权链与
//       Channel Adapter 的 Core 独立性不变量。
//
// 传输说明（重要）：本测试用**两个真实的 MeshNode 实例在进程内互发信封**——
// 协议、签名、信任、授权、审批、在线判定全部是真跑的，只有 transport 是 loopback。
// 真正的跨设备链路（pipe/tcp/relay）需要第二台 CetaMesh Node，本阶段不做，标 PENDING_NATIVE_VERIFICATION。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createMeshNode,
  createMeshService,
  createEnvelope,
  createTrustStore,
  authorizeCapabilityRequest,
  deriveNodeId,
  loadOrCreateIdentity,
  validateEnvelope,
  MESH_PROTOCOL_VERSION,
  CAPABILITY_NAMES,
  NODE_CAPABILITIES
} from '../src/mesh/index.js';
import { presenceOf } from '../src/mesh/types.js';
import { createChannelRegistry, createChannelService, CHANNEL_ADAPTERS } from '../src/channel/index.js';
import { startIpcProtocol, IPC_PROTOCOL_VERSION } from '../src/control/ipc-protocol.js';
import { createSettingsStore } from '../src/settings/store.js';
import { coerceField } from '../src/settings/schema.js';

let passed = 0;
let failed = 0;
const check = (name, condition, extra = '') => {
  if (condition) { passed += 1; console.log('PASS ' + name + (extra ? ' — ' + extra : '')); }
  else { failed += 1; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : 'got ' + a + ' want ' + b);
};
const capture = (fn) => {
  try { return { threw: false, value: fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};
const asyncCapture = async (fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};

let clock = 1700000000000;
const now = () => clock;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-mesh-test-'));

function send(fromNode, toNode, type, payload, options = {}) {
  const envelope = createEnvelope({
    type,
    from: fromNode.identity().nodeId,
    to: toNode.identity().nodeId,
    payload,
    sign: (text) => fromNode.sign(text),
    nowMs: options.nowMs === undefined ? now() : options.nowMs
  });
  return toNode.handleEnvelope(options.patch ? options.patch(envelope) : envelope);
}

try {
  const nodeA = createMeshNode({ stateDir: path.join(root, 'node-a'), name: 'Desktop A', role: 'desktop', now,
    available: ['mesh.presence', 'mesh.manifest', 'memory.query', 'task.manage'],
    executeCapability: ({ capability }) => ({ executed: true, capability }) });
  const nodeB = createMeshNode({ stateDir: path.join(root, 'node-b'), name: 'Peer B', role: 'mobile', now });
  const idA = nodeA.identity().nodeId;
  const idB = nodeB.identity().nodeId;

  // ── 1. Device Identity ────────────────────────────────────────────────
  check('节点 id 格式正确', /^node_[a-f0-9]{32}$/.test(idA), idA);
  equal('node id 由公钥派生（可独立复算）', deriveNodeId(nodeA.publicKeyPem()), idA);
  check('两个节点身份不同', idA !== idB);
  equal('Node Role 为 desktop', nodeA.identity().role, 'desktop');
  const reopened = loadOrCreateIdentity({ stateDir: path.join(root, 'node-a'), now });
  equal('重启后身份不变', reopened.nodeId, idA);

  // ── 2. Capability Manifest ────────────────────────────────────────────
  const manifest = nodeA.manifest();
  equal('清单协议版本', manifest.protocolVersion, MESH_PROTOCOL_VERSION);
  equal('清单列出全部能力', manifest.capabilities.map((c) => c.id).sort(), [...CAPABILITY_NAMES].sort());
  equal('清单标注是否需要审批', manifest.capabilities.find((c) => c.id === 'memory.query').requiresApproval, true);
  equal('mesh.presence 不需要审批', manifest.capabilities.find((c) => c.id === 'mesh.presence').requiresApproval, false);

  // ── 3. Pairing ────────────────────────────────────────────────────────
  const noInvite = capture(() => nodeA.pair({ inviteCode: 'nope', peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'B' }));
  check('无效邀请码被拒绝', noInvite.threw && noInvite.code === 'INVITE_NOT_FOUND', String(noInvite.code));
  const selfPair = capture(() => { const inv = nodeA.createInvite({}); return nodeA.pair({ inviteCode: inv.code, peerPublicKeyPem: nodeA.publicKeyPem(), peerName: 'self' }); });
  check('不能与自身配对', selfPair.threw && selfPair.code === 'SELF_PAIRING', String(selfPair.code));

  const invite = nodeA.createInvite({});
  const paired = nodeA.pair({ inviteCode: invite.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'Peer B', peerRole: 'mobile', transport: 'loopback' });
  equal('配对登记的是对端节点 id', paired.peer.nodeId, idB);
  equal('配对后信任状态为 pending（配对 != 信任）', paired.peer.trust, 'pending');
  equal('配对后默认没有任何授权', paired.peer.grants, []);
  const reuse = capture(() => nodeA.pair({ inviteCode: invite.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'B' }));
  check('邀请码一次性', reuse.threw && reuse.code === 'INVITE_ALREADY_USED', String(reuse.code));

  clock += 1000;
  const expiredCode = (() => { const inv = nodeA.createInvite({ ttlMs: 60 * 1000 }); clock += 61 * 1000; return inv; })();
  const expired = capture(() => nodeA.pair({ inviteCode: expiredCode.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'B' }));
  check('过期邀请码被拒绝', expired.threw && expired.code === 'INVITE_EXPIRED', String(expired.code));
  clock -= 61 * 1000;

  // ── 4. Trust：未信任前一切拒绝 ────────────────────────────────────────
  const beforeTrust = send(nodeB, nodeA, 'presence.ping', {});
  check('未信任对端被拒绝', beforeTrust.ok === false && beforeTrust.code === 'PEER_UNTRUSTED', String(beforeTrust.code));
  const unknownPeer = createMeshNode({ stateDir: path.join(root, 'node-c'), name: 'C', role: 'mobile', now });
  const stranger = send(unknownPeer, nodeA, 'presence.ping', {});
  check('未配对节点被拒绝', stranger.ok === false && stranger.code === 'PEER_UNKNOWN', String(stranger.code));

  nodeA.trustNode({ nodeId: idB });
  clock += 1000;
  const ping = send(nodeB, nodeA, 'presence.ping', {});
  check('信任后 presence.ping 成功', ping.ok === true && ping.code === 'PRESENCE_OK', String(ping.code));
  equal('presence.ping 回带本节点角色', ping.result.role, 'desktop');

  const peerView = nodeA.peer({ nodeId: idB });
  equal('Peer status 显示在线', peerView.presence, 'online');
  check('Peer status 记录 last seen', peerView.lastSeenAt > 0);
  equal('Peer status 保留传输类型', peerView.transport, 'loopback');

  // ── 5. Trusted != Authorized ──────────────────────────────────────────
  const trustedButNotAuthorized = send(nodeB, nodeA, 'capability.request', { capability: 'memory.query', requestId: 'r1' });
  check('已信任但未授权 -> policy 阶段拒绝',
    trustedButNotAuthorized.ok === false && trustedButNotAuthorized.stage === 'policy'
    && trustedButNotAuthorized.code === 'CAPABILITY_NOT_AUTHORIZED', JSON.stringify(trustedButNotAuthorized));

  nodeA.grant({ nodeId: idB, capabilities: ['memory.query'] });
  const needsApproval = send(nodeB, nodeA, 'capability.request', { capability: 'memory.query', requestId: 'r2' });
  check('授权后仍需本地审批 -> pending_approval',
    needsApproval.ok === true && needsApproval.decision === 'pending_approval' && needsApproval.requestId === 'r2', JSON.stringify(needsApproval));

  const pending = nodeA.approvals();
  equal('审批队列有 1 条待处理', pending.length, 1);
  equal('审批项记录请求方与能力', [pending[0].from, pending[0].capability], [idB, 'memory.query']);

  const approvePending = send(nodeB, nodeA, 'capability.request', { capability: 'memory.query', requestId: 'r2' });
  check('未批准前重复请求仍是 pending', approvePending.decision === 'pending_approval');
  equal('重复请求不产生重复审批项', nodeA.approvals().length, 1);

  nodeA.decideApproval({ requestId: 'r2', decision: 'approve' });
  clock += 1000;
  const allowed = send(nodeB, nodeA, 'capability.request', { capability: 'memory.query', requestId: 'r2' });
  check('批准后同一请求被放行', allowed.ok === true && allowed.decision === 'allow', JSON.stringify(allowed));
  equal('已接线执行器返回真实执行结果', allowed.result, { executed: true, capability: 'memory.query' });

  const doubleDecide = capture(() => nodeA.decideApproval({ requestId: 'r2', decision: 'reject' }));
  check('审批不可重复决定', doubleDecide.threw && doubleDecide.code === 'APPROVAL_DECIDED', String(doubleDecide.code));

  // 拒绝路径
  nodeA.grant({ nodeId: idB, capabilities: ['task.manage'] });
  const rejectedReq = send(nodeB, nodeA, 'capability.request', { capability: 'task.manage', requestId: 'r3' });
  equal('task.manage 进入待审批', rejectedReq.decision, 'pending_approval');
  nodeA.decideApproval({ requestId: 'r3', decision: 'reject' });
  clock += 1000;
  const rejected = send(nodeB, nodeA, 'capability.request', { capability: 'task.manage', requestId: 'r3' });
  check('被拒绝后请求被拒', rejected.ok === false && rejected.code === 'APPROVAL_REJECTED', String(rejected.code));

  // 无需审批的能力：授权后直接放行
  nodeA.grant({ nodeId: idB, capabilities: ['mesh.manifest'] });
  const manifestReq = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.manifest', requestId: 'r4' });
  check('无需审批的能力授权后直接放行', manifestReq.ok === true && manifestReq.decision === 'allow', JSON.stringify(manifestReq));
  equal('放行后返回本节点能力清单', Array.isArray(manifestReq.result.capabilities), true);

  // ── 6. 授权链各阶段拒绝 ────────────────────────────────────────────────
  const wrongVersion = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.presence', requestId: 'r5' },
    { patch: (e) => ({ ...e, v: 99 }) });
  check('协议版本不匹配 -> protocol', wrongVersion.stage === 'protocol' && wrongVersion.code === 'PROTOCOL_VERSION_MISMATCH', String(wrongVersion.code));

  const tampered = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.presence', requestId: 'r6' },
    { patch: (e) => ({ ...e, payload: { ...e.payload, capability: 'workspace.files' } }) });
  check('篡改载荷 -> 签名校验失败（trust 阶段）', tampered.stage === 'trust' && tampered.code === 'SIGNATURE_INVALID', String(tampered.code));

  const stale = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.presence', requestId: 'r7' },
    { nowMs: now() - 10 * 60 * 1000 });
  check('过期消息 -> PROTOCOL_STALE', stale.stage === 'protocol' && stale.code === 'PROTOCOL_STALE', String(stale.code));

  const wrongRecipient = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.presence', requestId: 'r8' },
    { patch: (e) => ({ ...e, to: idB }) });
  check('非本节点收件人 -> PROTOCOL_WRONG_RECIPIENT', wrongRecipient.stage === 'protocol' && wrongRecipient.code === 'PROTOCOL_WRONG_RECIPIENT', String(wrongRecipient.code));

  const unknownCap = send(nodeB, nodeA, 'capability.request', { capability: 'kernel.escape', requestId: 'r9' });
  check('未知能力 -> UNKNOWN_CAPABILITY', unknownCap.stage === 'protocol' && unknownCap.code === 'UNKNOWN_CAPABILITY', String(unknownCap.code));

  const replayEnv = createEnvelope({ type: 'capability.request', from: idB, to: idA, payload: { capability: 'mesh.presence', requestId: 'r10' }, sign: (t) => nodeB.sign(t), nowMs: now() });
  nodeA.handleEnvelope(replayEnv);
  const replay = nodeA.handleEnvelope(replayEnv);
  check('重放同一信封 -> PROTOCOL_REPLAY', replay.stage === 'protocol' && replay.code === 'PROTOCOL_REPLAY', String(replay.code));

  // availability：本节点声明了该能力但当前不可用
  const limited = createMeshNode({ stateDir: path.join(root, 'node-limited'), name: 'Limited', role: 'desktop', available: ['mesh.presence'], now });
  const limitedInvite = limited.createInvite({});
  limited.pair({ inviteCode: limitedInvite.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'B', peerRole: 'mobile' });
  limited.trustNode({ nodeId: idB });
  limited.grant({ nodeId: idB, capabilities: ['memory.query'] });
  const unavailable = send(nodeB, limited, 'capability.request', { capability: 'memory.query', requestId: 'r11' });
  check('能力当前不可用 -> availability', unavailable.stage === 'availability' && unavailable.code === 'CAPABILITY_UNAVAILABLE', String(unavailable.code));

  const unwired = createMeshNode({ stateDir: path.join(root, 'node-unwired'), name: 'Unwired', role: 'desktop', now });
  equal('未接线的远程能力在 Manifest 中不可用', unwired.manifest().capabilities.find(c => c.id === 'memory.query').available, false);
  const unwiredInvite = unwired.createInvite({});
  unwired.pair({ inviteCode: unwiredInvite.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'B' });
  unwired.trustNode({ nodeId: idB });
  unwired.grant({ nodeId: idB, capabilities: ['memory.query'] });
  const unwiredResult = send(nodeB, unwired, 'capability.request', { capability: 'memory.query', requestId: 'unwired' });
  equal('未接线能力授权后仍拒绝且不进入审批', [unwiredResult.ok, unwiredResult.stage, unwiredResult.code],
    [false, 'availability', 'CAPABILITY_UNAVAILABLE']);
  equal('未接线能力不会创建待审批请求', unwired.approvals().length, 0);

  const ttlStateDir = path.join(root, 'ttl-service');
  const ttlSettings = createSettingsStore({ stateDir: ttlStateDir });
  ttlSettings.update('devices', { presenceTtlMs: 10000 });
  const ttlService = createMeshService({ stateDir: ttlStateDir, settingsStore: ttlSettings, now });
  const ttlInvite = ttlService.node.createInvite({});
  ttlService.node.pair({ inviteCode: ttlInvite.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'B' });
  ttlService.node.trustNode({ nodeId: idB });
  ttlService.node.touch({ nodeId: idB });
  clock += 15000;
  equal('设置 TTL 10s 后 15s 的 peer 离线', ttlService.node.peer({ nodeId: idB }).presence, 'offline');
  ttlSettings.update('devices', { presenceTtlMs: 20000 });
  equal('TTL 更新后在线投影立即重算', ttlService.node.peer({ nodeId: idB }).presence, 'online');
  equal('未来时间戳不会伪装为在线', presenceOf({ lastSeenAt: now() + 1000 }, now(), 10000), 'unknown');
  equal('非法 TTL 不会伪装为在线', presenceOf({ lastSeenAt: now() }, now(), NaN), 'unknown');
  equal('设置拒绝小数 TTL', capture(() => coerceField('devices', 'presenceTtlMs', 10000.5)).code, 'SETTINGS_INVALID');
  equal('设置拒绝字符串 TTL', capture(() => coerceField('devices', 'presenceTtlMs', '10000')).code, 'SETTINGS_INVALID');
  await ttlService.close();
  const disabledService = createMeshService({ stateDir: path.join(root, 'disabled-service'), now,
    isEnabled: () => false });
  const disabledStatus = await disabledService.execute({ method: 'mesh.status', params: {} });
  equal('Mesh 关闭时状态明确显示关闭而 Core 仍 ready', [disabledStatus.meshEnabled, disabledStatus.coreReady], [false, true]);
  equal('Mesh 关闭时 Manifest 不宣称能力可用', disabledService.node.manifest().capabilities.filter(c => c.available).length, 0);
  const disabledInvite = await asyncCapture(() => disabledService.execute({ method: 'mesh.invite.create', params: {} }));
  equal('Mesh 关闭时拒绝新配对', disabledInvite.code, 'MESH_DISABLED');
  await disabledService.close();

  // blocked 对端
  nodeA.blockNode({ nodeId: idB });
  const blocked = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.manifest', requestId: 'r12' });
  check('被拉黑对端被拒绝', blocked.stage === 'trust' && blocked.code === 'PEER_UNTRUSTED', String(blocked.code));
  nodeA.trustNode({ nodeId: idB });

  // ── 7. Presence / Disconnect ──────────────────────────────────────────
  clock += 200 * 1000;
  equal('超过 TTL 判定为离线', nodeA.peer({ nodeId: idB }).presence, 'offline');
  clock += 1000;
  send(nodeB, nodeA, 'presence.ping', {});
  equal('心跳后恢复在线', nodeA.peer({ nodeId: idB }).presence, 'online');

  nodeA.disconnect({ nodeId: idB });
  const disconnected = nodeA.peer({ nodeId: idB });
  equal('断开后 last seen 清空', disconnected.lastSeenAt, null);
  equal('断开不改变信任', disconnected.trust, 'trusted');
  check('断开不清空授权', disconnected.grants.includes('mesh.manifest'));

  // ── 8. Remove Trust ───────────────────────────────────────────────────
  nodeA.removeTrust({ nodeId: idB });
  const removed = nodeA.peer({ nodeId: idB });
  equal('撤销信任后状态 blocked', removed.trust, 'blocked');
  equal('撤销信任清空全部授权', removed.grants, []);
  const afterRemove = send(nodeB, nodeA, 'capability.request', { capability: 'mesh.presence', requestId: 'r13' });
  check('撤销信任后请求被拒', afterRemove.ok === false && afterRemove.code === 'PEER_UNTRUSTED', String(afterRemove.code));

  // ── 9. Core 独立性（不依赖对端，也不依赖 Channel Adapter） ─────────────
  const lonely = createMeshNode({ stateDir: path.join(root, 'node-lonely'), name: 'Lonely', role: 'desktop', now });
  const lonelyStatus = lonely.status();
  equal('零对端时 Core 仍 ready', lonelyStatus.coreReady, true);
  equal('Core readiness 不依赖任何东西', lonelyStatus.coreReadinessDependsOn, []);
  equal('零对端时 peerCount 为 0', lonelyStatus.peerCount, 0);
  // 统一配对 v1.1 起：tcp（局域网 TLS 配对通道）已实现并有真实 socket 验收
  // （见 scripts/test-mesh-pairing-interop.mjs）；pipe/relay 仍未实现。
  check('已实现传输 = loopback + tcp；未实现 = pipe/relay', lonelyStatus.supportedTransports.join(',') === 'loopback,tcp' && lonelyStatus.deferredTransports.join(',') === 'pipe,relay');

  const registry = createChannelRegistry({ now });
  const independence = registry.independence();
  equal('没有任何 Channel 参与 Core readiness', independence.coreGatedByChannels, false);
  equal('Channel 列表包含 qq', independence.channels, ['qq']);
  registry.setState('qq', 'error', 'SnowLuma 未运行');
  equal('Channel 出错不影响 Core ready', lonely.status().coreReady, true);
  check('Channel 如实上报错误', registry.list()[0].lastError === 'SnowLuma 未运行');

  // QQ 已有能力必须保留：直接对源码取证
  const bridgeSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'bridge.js'), 'utf8');
  for (const tool of ['qq_send_group_message', 'qq_send_private_message', 'qq_get_card_msg', 'qq_memory_append']) {
    check('QQ 能力仍存在（' + tool + '）', bridgeSource.includes(tool));
  }
  check('Channel Adapter 声明了 kind', CHANNEL_ADAPTERS.every((a) => a.kind === 'channel-adapter'));
  check('Channel Adapter 声明为非 Core 依赖', CHANNEL_ADAPTERS.every((a) => a.coreDependency === false));

  // ── 10. 重启持久化 ────────────────────────────────────────────────────
  const restarted = createMeshNode({ stateDir: path.join(root, 'node-a'), name: 'Desktop A', role: 'desktop', now });
  equal('重启后 node id 不变', restarted.identity().nodeId, idA);
  const restartedPeer = restarted.peer({ nodeId: idB });
  equal('重启后对端仍在', restartedPeer.nodeId, idB);
  equal('重启后信任状态保持', restartedPeer.trust, 'blocked');
  equal('重启后授权状态保持', restartedPeer.grants, []);
  const trustStore = createTrustStore({ stateDir: path.join(root, 'node-a'), now });
  check('信任库可独立读取', trustStore.list().length === 1);

  // ── 11. 纯函数授权链（可穷举，不依赖节点状态） ─────────────────────────
  const pureEnv = createEnvelope({ type: 'capability.request', from: idB, to: idA, payload: { capability: 'mesh.presence', requestId: 'p1' }, sign: (t) => nodeB.sign(t), nowMs: now() });
  const pureDeny = authorizeCapabilityRequest({
    envelope: pureEnv, peer: { trust: 'trusted', grants: [] }, publicKeyPem: nodeB.publicKeyPem(),
    localManifest: nodeA.manifest(), verify: () => true, nowMs: now()
  });
  equal('纯函数：无授权 -> policy 拒绝', [pureDeny.decision, pureDeny.stage], ['deny', 'policy']);
  const pureTrust = authorizeCapabilityRequest({
    envelope: pureEnv, peer: null, localManifest: nodeA.manifest(), verify: () => true, nowMs: now()
  });
  equal('纯函数：无对端 -> trust 拒绝', [pureTrust.decision, pureTrust.stage], ['deny', 'trust']);
  const pureUnwiredEnv = createEnvelope({ type: 'capability.request', from: idB, to: idA,
    payload: { capability: 'memory.query', requestId: 'pure-unwired' }, sign: (t) => nodeB.sign(t), nowMs: now() });
  const pureUnwired = authorizeCapabilityRequest({
    envelope: pureUnwiredEnv, peer: { trust: 'trusted', grants: ['memory.query'] },
    publicKeyPem: nodeB.publicKeyPem(), localManifest: unwired.manifest(), verify: () => true, nowMs: now()
  });
  equal('纯函数：Manifest 标记不可用则拒绝', [pureUnwired.decision, pureUnwired.stage, pureUnwired.code],
    ['deny', 'availability', 'CAPABILITY_UNAVAILABLE']);

  // ── 12. Service + IPC 往返 ────────────────────────────────────────────
  const svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-mesh-svc-'));
  const service = createMeshService({ stateDir: svcDir, name: 'SvcDesktop', role: 'desktop', now });
  const svcStatus = await service.execute({ method: 'mesh.status', params: {} });
  equal('service mesh.status 可用', svcStatus.coreReady, true);
  const svcInvite = await service.execute({ method: 'mesh.invite.create', params: {} });
  check('service mesh.invite.create 可用', typeof svcInvite.code === 'string');
  const svcPair = await service.execute({ method: 'mesh.pair', params: { inviteCode: svcInvite.code, peerPublicKeyPem: nodeB.publicKeyPem(), peerName: 'Peer B', peerRole: 'mobile' } });
  equal('service mesh.pair 可用', svcPair.peer.nodeId, idB);
  await service.execute({ method: 'mesh.trust', params: { nodeId: idB } });
  await service.execute({ method: 'mesh.grant', params: { nodeId: idB, capabilities: ['mesh.presence'] } });
  const svcManifest = await service.execute({ method: 'mesh.manifest', params: {} });
  check('service mesh.manifest 可用', Array.isArray(svcManifest.manifest.capabilities));
  const svcSnapshot = await service.execute({ method: 'mesh.snapshot', params: {} });
  equal('service mesh.snapshot 一次返回状态', svcSnapshot.status.coreReady, true);
  check('service mesh.snapshot 一次返回对端与审批', Array.isArray(svcSnapshot.peers) && Array.isArray(svcSnapshot.approvals));

  const svcUnknown = await asyncCapture(() => service.execute({ method: 'mesh.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', svcUnknown.threw && svcUnknown.code === 'METHOD_NOT_FOUND', String(svcUnknown.code));

  const channelService = createChannelService({ now });
  const svcChannels = await channelService.execute({ method: 'channel.list', params: {} });
  equal('service channel.list 可用', svcChannels.channels.map((c) => c.id), ['qq']);
  const svcIndependence = await channelService.execute({ method: 'channel.independence', params: {} });
  equal('service channel.independence 可用', svcIndependence.coreGatedByChannels, false);

  const ipcMesh = createMeshService({ stateDir: svcDir, name: 'SvcDesktop', role: 'desktop', now });
  const ipcChannels = createChannelService({ now });
  const dispatch = ({ method, params }) => {
    if (method.startsWith('mesh.')) return ipcMesh.execute({ method, params });
    if (method.startsWith('channel.')) return ipcChannels.execute({ method, params });
    throw new Error('unexpected method ' + method);
  };
  const input = new PassThrough({ autoDestroy: false });
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(Buffer.from(c)));
  const ipc = startIpcProtocol({ input, output, dispatch });
  const encode = (payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); return frame;
  };
  const req = (id, method, params) => ({ version: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params }) });
  input.write(encode(req('m1', 'mesh.status', {})));
  input.write(encode(req('m2', 'mesh.peers', {})));
  input.write(encode(req('m3', 'channel.list', {})));
  input.end();
  await ipc.done;
  const frames = [];
  {
    const buffer = Buffer.concat(chunks); let offset = 0;
    while (offset + 4 <= buffer.length) {
      const size = buffer.readUInt32LE(offset);
      frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString('utf8')));
      offset += 4 + size;
    }
  }
  check('IPC mesh.status 往返成功', Boolean(frames.find((f) => f.id === 'm1' && f.ok === true)));
  check('IPC mesh.peers 往返成功', Boolean(frames.find((f) => f.id === 'm2' && f.ok === true)));
  check('IPC channel.list 往返成功', Boolean(frames.find((f) => f.id === 'm3' && f.ok === true)));
  equal('IPC mesh.peers 返回已配对对端', frames.find((f) => f.id === 'm2').result.peers.length, 1);
  fs.rmSync(svcDir, { recursive: true, force: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('Device Mesh Desktop 验收全部通过（阶段 11）');
console.log('跨设备真实链路（pipe/tcp/relay）：PENDING_NATIVE_VERIFICATION');
