// 会话 2 / TASK-S2-001 + S2-002 验收：统一 AgentProvider 契约 + Agent Broker。
//
// 覆盖：
//   A. 契约：核心方法 / 可选方法（archiveSession / nativeCheckpoint / nativeHandoff）
//      显式 unsupported；capabilityExtras（rolloverStrategy）真实透传；
//   B. normalizeUsageTokens：多种 Provider usage 形状归一化；凑不出 token → null（不伪造）；
//   C. Registry：注册 / 重复 id 拒绝 / 未知 Provider 结构化错误；
//   D. Broker 分发：会话操作路由到正确 Provider；可选能力诚实包装
//      （supported:false / reason:'UNSUPPORTED'），真错误原样上抛；
//   E. 回合结束事件扇出：监听器收到 payload、退订生效、监听器失败不阻断其他监听器；
//   F. agent.* IPC 服务经 Broker：list / createSession / archiveSession /
//      nativeCheckpoint（unsupported 形状）/ 未知方法 METHOD_NOT_FOUND；
//   G. Cross Provider 结构就绪：两个 fixture Provider 经同一 Broker 注册与寻址。
import assert from 'node:assert/strict';
import {
  AGENT_PROVIDER_METHODS,
  AGENT_PROVIDER_CORE_METHODS,
  AGENT_PROVIDER_OPTIONAL_METHODS,
  agentProviderError,
  defineAgentProvider,
  normalizeUsageTokens
} from '../src/agent/agent-provider.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentService, createDefaultAgentService } from '../src/agent/service.js';

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

/** 正式契约 fixture Provider：全核心能力 + 可选 archiveSession（仅在 withArchive 时）。 */
function fixtureProvider(id, { label, eventProtocol = null, withArchive = false, log = [], capabilityExtras = null } = {}) {
  let seq = 0;
  const sessions = new Set();
  return defineAgentProvider({
    id,
    label: label ?? `Fixture ${id}`,
    eventProtocol,
    capabilityExtras: { workspaceBoundary: 'capability-broker', ...(capabilityExtras ?? {}) },
    methods: {
      async createSession({ model } = {}) {
        seq += 1;
        const sessionId = `${id}-s${seq}`;
        sessions.add(sessionId);
        log.push({ kind: 'create', provider: id, model });
        return { sessionId, provider: id, model: model ?? `default-${id}` };
      },
      async send({ sessionId, content }) {
        log.push({ kind: 'send', provider: id, sessionId, content });
        return { accepted: true, sessionId };
      },
      async cancel({ sessionId }) {
        log.push({ kind: 'cancel', provider: id, sessionId });
        return { cancelled: true };
      },
      async status({ sessionId }) {
        return { sessionId, running: sessions.has(sessionId) };
      },
      async contextUsage({ sessionId }) {
        return { sessionId, available: true, tokenUsage: { inputTokens: 10, outputTokens: 2 } };
      },
      async resume({ sessionId }) {
        return { resumed: sessions.has(sessionId), sessionId };
      },
      async closeSession({ sessionId }) {
        sessions.delete(sessionId);
        return { closed: true };
      },
      async selectModel({ sessionId, model }) {
        return { sessionId, selected: { model } };
      },
      async health() {
        return { available: true, provider: id };
      },
      follow() {
        throw agentProviderError('AGENT_UNSUPPORTED', 'fixture 无事件流');
      },
      ...(withArchive ? {
        async archiveSession({ sessionId }) {
          log.push({ kind: 'archive', provider: id, sessionId });
          return { archived: true, sessionId };
        }
      } : {})
    }
  });
}

// ── A. 契约 ──────────────────────────────────────────────────────────────────
{
  const core = defineAgentProvider({
    id: 'core-only', label: 'Core Only',
    methods: Object.fromEntries(AGENT_PROVIDER_CORE_METHODS.map((name) => [name, name === 'follow' ? () => {} : async () => ({})]))
  });
  const caps = core.capabilities();
  for (const name of AGENT_PROVIDER_CORE_METHODS) {
    assert.equal(caps.supported[name], true, `核心方法应被识别为支持：${name}`);
  }
  for (const name of AGENT_PROVIDER_OPTIONAL_METHODS) {
    assert.equal(caps.supported[name], false, `可选方法缺省必须显式 unsupported：${name}`);
    assert.ok(caps.unsupported.includes(name));
    await assert.rejects(() => core[name]({ sessionId: 'x' }), (e) => e.code === 'AGENT_UNSUPPORTED');
  }
  assert.equal(AGENT_PROVIDER_METHODS.length, AGENT_PROVIDER_CORE_METHODS.length + AGENT_PROVIDER_OPTIONAL_METHODS.length);

  const withExtras = defineAgentProvider({
    id: 'extras', label: 'Extras',
    capabilityExtras: { rolloverStrategy: { preferred: 'fresh-session', note: 'x' } },
    methods: { createSession: async () => ({ sessionId: 's' }) }
  });
  assert.deepEqual(withExtras.capabilities().rolloverStrategy, { preferred: 'fresh-session', note: 'x' });
  ok('契约：核心/可选方法显式 unsupported + capabilityExtras 透传（不伪造能力）');
}

// ── B. usage 归一化 ─────────────────────────────────────────────────────────
{
  assert.deepEqual(normalizeUsageTokens({ inputTokens: 12, outputTokens: 3 }), { inputTokens: 12, outputTokens: 3 });
  assert.deepEqual(normalizeUsageTokens({ prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }), { inputTokens: 7, outputTokens: 4, totalTokens: 11 });
  assert.deepEqual(normalizeUsageTokens({ input_tokens: 5, output_tokens: 1 }), { inputTokens: 5, outputTokens: 1 });
  assert.equal(normalizeUsageTokens({ inputTokens: -3 }), null, '负数/非法值不算 token，凑不出 → null');
  assert.equal(normalizeUsageTokens(null), null);
  assert.equal(normalizeUsageTokens('12'), null);
  assert.equal(normalizeUsageTokens({ hello: 'world' }), null, '凑不出任何 token 数 → null（不伪造）');
  assert.deepEqual(normalizeUsageTokens({ windowTokens: 128000 }), { windowTokens: 128000 });
  ok('usage 归一化：inputTokens/input_tokens/prompt_tokens 形状统一；无 token → null');
}

// ── C. Registry ─────────────────────────────────────────────────────────────
{
  const registry = createAgentProviderRegistry({ providers: [fixtureProvider('alpha'), fixtureProvider('beta')] });
  assert.deepEqual(registry.ids(), ['alpha', 'beta']);
  assert.equal(registry.has('alpha'), true);
  assert.equal(registry.get('ghost'), null);
  assert.throws(() => registry.require('ghost'), (e) => e.code === 'AGENT_PROVIDER_UNKNOWN');
  assert.throws(() => registry.register({ id: 'alpha', capabilities: () => ({}) }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => registry.register({ id: 'no-caps' }), (e) => e.code === 'INVALID_PARAMS', '非 defineAgentProvider 产物必须拒绝');
  ok('Registry：注册/顺序/未知 Provider AGENT_PROVIDER_UNKNOWN/重复与非契约对象拒绝');
}

// ── D. Broker 分发 + 可选能力诚实包装 ────────────────────────────────────────
{
  const log = [];
  const registry = createAgentProviderRegistry({
    providers: [fixtureProvider('alpha', { log, withArchive: true }), fixtureProvider('beta', { log })]
  });
  const broker = createAgentBroker({ registry, log: () => {} });

  const createdA = await broker.createSession('alpha', { taskId: 'task-a', workspaceId: 'ws-a', model: 'm1' });
  const createdB = await broker.createSession('beta', { taskId: 'task-b', workspaceId: 'ws-b' });
  assert.match(createdA.sessionId, /^alpha-s\d+$/);
  assert.match(createdB.sessionId, /^beta-s\d+$/);

  await broker.send({ provider: 'alpha', sessionId: createdA.sessionId, content: 'hi' });
  assert.equal(log[log.length - 1].provider, 'alpha', 'send 路由到正确 Provider');

  assert.equal((await broker.health('beta')).available, true);
  assert.equal((await broker.contextUsage({ provider: 'beta', sessionId: createdB.sessionId })).available, true);
  await assert.rejects(() => broker.send({ provider: 'ghost', sessionId: 'x', content: 'hi' }), (e) => e.code === 'AGENT_PROVIDER_UNKNOWN');
  await assert.rejects(() => broker.send({ provider: 'alpha', sessionId: '', content: 'hi' }), (e) => e.code === 'INVALID_PARAMS');

  // 可选能力：支持 → supported:true；不支持 → { supported:false, reason:'UNSUPPORTED' }
  const archived = await broker.archiveSession({ provider: 'alpha', sessionId: createdA.sessionId });
  assert.equal(archived.supported, true);
  assert.equal(archived.archived, true);
  const notArchived = await broker.archiveSession({ provider: 'beta', sessionId: createdB.sessionId });
  assert.deepEqual(
    { supported: notArchived.supported, reason: notArchived.reason, archived: notArchived.archived ?? false },
    { supported: false, reason: 'UNSUPPORTED', archived: false },
    '不支持的能力必须诚实报告，不得伪造'
  );
  const noCheckpoint = await broker.nativeCheckpoint({ provider: 'alpha', sessionId: createdA.sessionId });
  assert.equal(noCheckpoint.supported, false);

  // 真错误不吞：Provider 抛非 AGENT_UNSUPPORTED 错误必须原样上抛。
  const exploding = fixtureProvider('boom');
  registry.register(defineAgentProvider({
    id: 'boom', label: 'Boom',
    methods: {
      ...Object.fromEntries(AGENT_PROVIDER_CORE_METHODS.filter((n) => n !== 'follow').map((name) => [name, async () => ({})])),
      follow: () => {},
      async archiveSession() { throw agentProviderError('PROVIDER_ERROR', '归档失败：传输错误'); }
    }
  }));
  await assert.rejects(
    () => broker.archiveSession({ provider: 'boom', sessionId: 's' }),
    (e) => e.code === 'PROVIDER_ERROR',
    '能力包装只收敛 UNSUPPORTED，不吞真错误'
  );

  // rolloverStrategy：Provider 声明透传，无声明返回 null。
  assert.equal(broker.rolloverStrategy('beta'), null);
  ok('Broker：分发路由 / 未知 Provider 拒绝 / 可选能力诚实包装 / 真错误上抛 / 策略声明');
}

// ── E. 回合结束事件扇出 ─────────────────────────────────────────────────────
{
  const broker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [fixtureProvider('alpha')] }) });
  const seen = [];
  const unsubscribeA = broker.onTurnEnd(async (payload) => { seen.push(['a', payload.provider]); });
  broker.onTurnEnd(() => { throw new Error('监听器炸了也不影响别人'); });
  const unsubscribeB = broker.onTurnEnd((payload) => { seen.push(['b', payload.sessionId]); });

  const delivered = await broker.reportTurnEnd({ provider: 'alpha', sessionId: 's1', usage: { inputTokens: 5 } });
  assert.equal(delivered.delivered, 2, '失败监听器不计入 delivered');
  assert.equal(delivered.failed, 1);
  assert.deepEqual(seen, [['a', 'alpha'], ['b', 's1']]);

  unsubscribeA();
  unsubscribeB();
  const after = await broker.reportTurnEnd({ provider: 'alpha', sessionId: 's2' });
  assert.equal(after.delivered, 0);
  await assert.rejects(() => broker.reportTurnEnd({ provider: 'alpha' }), (e) => e.code === 'INVALID_PARAMS');
  ok('回合结束事件：扇出 / 单个监听器失败不阻断 / 退订生效 / 缺参拒绝');
}

// ── F. agent.* IPC 服务经 Broker ────────────────────────────────────────────
{
  const log = [];
  const service = createDefaultAgentService({
    api: { callEndpoint: async (method) => { throw new Error(`不应触达 DSH：${method}`); }, openRemoteStream: () => {} },
    defaults: {},
    log
  });
  // 换成 fixture 注册表验证（不经 DSH）。
  const registry = createAgentProviderRegistry({
    providers: [fixtureProvider('alpha', { log, withArchive: true }), fixtureProvider('beta', { log })]
  });
  const broker = createAgentBroker({ registry });
  const fixtureService = createAgentService({ broker });

  const listed = await fixtureService.execute({ method: 'agent.list' });
  assert.deepEqual(listed.providers.map((p) => p.id), ['alpha', 'beta']);
  assert.equal(listed.providers[0].capabilities.supported.archiveSession, true);
  assert.equal(listed.providers[1].capabilities.supported.archiveSession, false);

  await assert.rejects(() => fixtureService.execute({ method: 'agent.createSession', params: { provider: 'alpha', model: 'm9' } }),
    (error) => error.code === 'TASK_REQUIRED');
  const created = await broker.createSession('alpha', { taskId: 'task-fixture', workspaceId: 'ws-fixture', model: 'm9' });
  assert.match(created.sessionId, /^alpha-s\d+$/);
  const archived = await fixtureService.execute({ method: 'agent.archiveSession', params: { provider: 'alpha', sessionId: created.sessionId } });
  assert.equal(archived.supported, true);
  const nativeCheckpoint = await fixtureService.execute({ method: 'agent.nativeCheckpoint', params: { provider: 'alpha', sessionId: 'x' } });
  assert.equal(nativeCheckpoint.supported, false, 'nativeCheckpoint 不支持时给 UNSUPPORTED 形状');
  await assert.rejects(
    () => fixtureService.execute({ method: 'agent.nonsense' }),
    (e) => e.code === 'METHOD_NOT_FOUND'
  );
  assert.equal(typeof service.broker, 'object', '默认服务必须暴露 broker（bridge 接线回合结束事件用）');
  ok('agent.* IPC：白名单经 Broker / archiveSession 诚实形状 / METHOD_NOT_FOUND');
}

// ── G. Cross Provider 结构就绪（同一 Broker 内多 Provider 寻址） ─────────────
{
  const registry = createAgentProviderRegistry({
    providers: [fixtureProvider('prov-a'), fixtureProvider('prov-b')]
  });
  const broker = createAgentBroker({ registry });
  const sessionA = await broker.createSession('prov-a', { taskId: 'task-a', workspaceId: 'ws-a' });
  await broker.cancel({ provider: 'prov-a', sessionId: sessionA.sessionId });
  await broker.closeSession({ provider: 'prov-a', sessionId: sessionA.sessionId });
  const sessionB = await broker.createSession('prov-b', { taskId: 'task-b', workspaceId: 'ws-b' });
  assert.match(sessionB.sessionId, /^prov-b-s\d+$/);
  assert.equal(broker.ids().length, 2);
  ok('Cross Provider 结构：A/B 两 Provider 同一 Broker 注册、独立寻址、互不串扰');
}

console.log(`\n🎉 Agent Broker 统一契约全部通过（${step} 组）`);


// Core-owned run metadata survives adapters that do not natively echo it.
{
  const registry=createAgentProviderRegistry();
  const provider=fixtureProvider('phase-fixture');
  let supplied;
  registry.register({...provider, send:async params=>{supplied=params;return {accepted:true,requestId:'native-phase-request'};},
    follow:async function*(){yield {seq:1,type:'turn/end',data:{requestId:'native-phase-request',reason:{kind:'completed'}}};}});
  const broker=createAgentBroker({registry});
  await broker.send({provider:'phase-fixture',sessionId:'phase-session',content:'recover',phase:'bootstrap',runId:'core-bootstrap-run'});
  assert.equal(supplied.phase,'bootstrap');
  assert.equal(supplied.runId,'core-bootstrap-run');
  const events=[];for await(const event of broker.follow({provider:'phase-fixture',sessionId:'phase-session'})) events.push(event);
  assert.equal(events[0].data.phase,'bootstrap','native events must retain Core phase ownership');
  assert.equal(events[0].data.runId,'core-bootstrap-run');
  broker.close();
  ok('Broker preserves Core phase and run identity on native terminal events');
}
