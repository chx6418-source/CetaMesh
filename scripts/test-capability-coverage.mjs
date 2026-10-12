// v2 hardening / Phase D 验收：Capability Broker 覆盖扩展（Channel / Mesh adapter）。
//
// 正面：只读能力（channel.status / channel.declarations / mesh.status /
//       mesh.capabilities）经 Broker 完成；channel.send 命中白名单 + sendImpl 绑定时完成。
// 负面（攻击性向量）：未知 channel、非法 target.kind、目标白名单外、无白名单配置、
//       超长 text、sendImpl 未绑定、external actor。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelRegistry, CHANNEL_ADAPTERS } from '../src/channel/registry.js';
import { createChannelService } from '../src/channel/service.js';
import { createMeshService } from '../src/mesh/service.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { registerChannelMeshCapabilities, isAllowedTarget } from '../src/capability/adapters.js';
import { buildToolCatalog, LEGACY_RETIRED_TOOLS } from '../src/integrations/catalog.js';

const OWNER = { kind: 'owner', id: 'desktop' };
let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

{
  const tools = buildToolCatalog();
  assert.equal(tools.filter(tool => tool.restore === 'restored').length, 46);
  assert.equal(tools.filter(tool => tool.restore === 'partial').length, 5);
  assert.equal(tools.filter(tool => tool.restore === 'legacy-unsupported').length, 2);
  assert.equal(LEGACY_RETIRED_TOOLS.filter(tool => tool.restore === 'deprecated').length, 6);
  assert.equal(LEGACY_RETIRED_TOOLS.filter(tool => tool.restore === 'legacy-unsupported').length, 2);
  ok('Bionic 当前清单 46/5/2，历史条目保留 deprecated 与 legacy-unsupported 分类');
}
function makeEnv({ allow = { groups: ['111'], private: [] }, sendImpl = null } = {}) {
  const channelService = createChannelService();
  const meshService = createMeshService({ stateDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cov-')), 'state') });
  const broker = createCapabilityBroker({});
  const registered = registerChannelMeshCapabilities({
    broker, channelService, meshService,
    isTargetAllowed: (kind, id) => isAllowedTarget({ allow }, kind, id),
    sendImpl
  });
  return { broker, channelService, meshService, registered };
}

// ── 1. 注册面 ────────────────────────────────────────────────────────────────
{
  const { broker, registered } = makeEnv();
  assert.deepEqual([...registered.registered].sort(), ['channel.declarations', 'channel.send', 'channel.status', 'mesh.capabilities', 'mesh.status']);
  const list = broker.list();
  const send = list.find((c) => c.id === 'channel.send');
  assert.equal(send.risk, 'high');
  assert.equal(send.permission, 'message.send', 'channel.send 对齐 PERMISSIONS 词表的 message.send');
  ok('注册面：5 个能力进入 Registry；channel.send = message.send / high risk');
}

// ── 2. 只读能力 ──────────────────────────────────────────────────────────────
{
  const { broker } = makeEnv();
  const status = await broker.execute({ actor: OWNER, capability: 'channel.status', input: {}, reason: 't' });
  assert.ok(Array.isArray(status.result.channels));
  assert.equal(status.result.channels[0].id, 'qq');
  const decl = await broker.execute({ actor: OWNER, capability: 'channel.declarations', input: {}, reason: 't' });
  assert.equal(decl.result.declarations, CHANNEL_ADAPTERS);
  const mesh = await broker.execute({ actor: OWNER, capability: 'mesh.status', input: {}, reason: 't' });
  assert.ok(mesh.result, 'mesh.status 完成且携带节点状态');
  const manifest = await broker.execute({ actor: OWNER, capability: 'mesh.capabilities', input: {}, reason: 't' });
  assert.ok(manifest.result.manifest.capabilities.length > 0, 'mesh 能力清单可见');
  ok('只读能力：channel/mesh 状态与声明经 Broker 只读完成');
}

// ── 3. channel.send 正面：白名单内 + sendImpl 绑定 ────────────────────────────
{
  const sends = [];
  const { broker } = makeEnv({
    sendImpl: async (payload) => { sends.push(payload); return { messageId: 'm-1' }; }
  });
  const result = await broker.execute({
    actor: OWNER, capability: 'channel.send',
    input: { channelId: 'qq', kind: 'group', id: '111', text: '白名单内消息' },
    approved: true, reason: 'owner send'
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.messageId, 'm-1');
  assert.equal(sends[0].actor.id, 'desktop', 'sendImpl 收到可信 actor（来源注入，不可伪造）');
  ok('channel.send 正面：白名单内群目标 → sendImpl 收到 actor/channel/target');
}

// ── 4. channel.send 负面：白名单外 / 无白名单 / 未知通道 / 非法 kind / 超长 text ─
{
  const { broker } = makeEnv({ sendImpl: async () => ({}) });
  const send = (input, actor = OWNER) => broker.execute({ actor, capability: 'channel.send', input, approved: true, reason: 't' });
  await assert.rejects(() => send({ channelId: 'qq', kind: 'group', id: '999', text: 'hi' }),
    (e) => e.code === 'TARGET_NOT_ALLOWED', '白名单外目标拒绝');
  await assert.rejects(() => send({ channelId: 'telegram', kind: 'group', id: '111', text: 'hi' }),
    (e) => e.code === 'INVALID_PARAMS', '未注册 Channel 拒绝');
  await assert.rejects(() => send({ channelId: 'qq', kind: 'chat', id: '111', text: 'hi' }),
    (e) => e.code === 'INVALID_PARAMS', '非法 target.kind 拒绝');
  await assert.rejects(() => send({ channelId: 'qq', kind: 'group', id: '111', text: 'x'.repeat(8001) }),
    (e) => e.code === 'INVALID_PARAMS', '超长 text 拒绝');
  const noAllow = makeEnv({ allow: null, sendImpl: async () => ({}) });
  await assert.rejects(() => noAllow.broker.execute({
    actor: OWNER, capability: 'channel.send', input: { channelId: 'qq', kind: 'group', id: '111', text: 'hi' }, approved: true, reason: 't'
  }), (e) => e.code === 'TARGET_NOT_ALLOWED', '白名单未配置 → 一律拒绝（fail-closed）');
  ok('channel.send 负面：白名单外/未配置/未知通道/非法 kind/超长 text 全部拒绝');
}

// ── 5. sendImpl 未绑定：如实 PROVIDER_UNAVAILABLE（不伪造发送） ────────────────
{
  const { broker } = makeEnv({ sendImpl: null });
  await assert.rejects(
    () => broker.execute({ actor: OWNER, capability: 'channel.send', input: { channelId: 'qq', kind: 'group', id: '111', text: 'hi' }, approved: true, reason: 't' }),
    (e) => e.code === 'PROVIDER_UNAVAILABLE',
    '未绑定真实传输时必须如实报告不可用'
  );
  ok('sendImpl 未绑定：PROVIDER_UNAVAILABLE（QQ 发送仍走既有适配器边界）');
}

// ── 6. external actor 一律拒绝（策略层） ─────────────────────────────────────
{
  const { broker } = makeEnv({ sendImpl: async () => ({}) });
  await assert.rejects(
    () => broker.execute({ actor: { kind: 'external', id: 'stranger' }, capability: 'channel.status', input: {}, reason: 't' }),
    (e) => e.code === 'PERMISSION_DENIED',
    'external/device 调用者被统一策略拒绝'
  );
  ok('external actor：Channel/Mesh 能力同样不可达（受信任受限适配器才可代理）');
}

console.log(`\n🎉 Capability 覆盖扩展全部通过（${step} 组）`);
