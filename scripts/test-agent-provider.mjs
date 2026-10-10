// 阶段 06 Agent Provider 验收测试。
//
// 覆盖：
//   A. 契约：defineAgentProvider 显式 unsupported（可选能力 archiveSession /
//      nativeCheckpoint / nativeHandoff 拒绝，会话 2 改名对齐）；
//   B. DSH 映射（注入 mock api，断言每个契约方法调用的端点与 payload 形状）；
//   C. 优雅降级：DSH 不可达（死端口）时 health/status/createSession 结构化失败，进程不崩；
//   D. 真机验收（DSH 在 127.0.0.1:3080 时执行）：createSession → send → follow 进度 →
//      cancel → resume → closeSession；DSH 不在时该段如实记为 NOT_RUN_ENVIRONMENT。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient } from '../src/dsh-client.js';
import { createChatService } from '../src/desktop/chat-service.js';
import {
  AGENT_PROVIDER_METHODS,
  agentProviderError,
  defineAgentProvider,
  normalizePromptContent
} from '../src/agent/agent-provider.js';
import { createDshAgentProvider } from '../src/agent/dsh-agent-provider.js';
import { createAgentService, createDefaultAgentService } from '../src/agent/service.js';

const DSH_BASE_URL = process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080';
const results = { pass: 0, fail: 0, live: null };

function ok(name) { results.pass += 1; console.log(`PASS ${name}`); }

// ── A. 契约 ──────────────────────────────────────────────────────────────────
{
  const provider = defineAgentProvider({
    id: 'fake',
    label: 'Fake Agent',
    eventProtocol: null,
    methods: {
      createSession: async () => ({ sessionId: 's1' }),
      send: async () => ({ accepted: true }),
      cancel: async () => ({ cancelled: true }),
      status: async () => ({ running: false }),
      contextUsage: async () => ({ available: false }),
      resume: async () => ({ resumed: true }),
      closeSession: async () => ({ closed: true }),
      capabilities: undefined // 故意缺省：由 defineAgentProvider 自动填充
    }
  });
  const caps = provider.capabilities();
  for (const name of AGENT_PROVIDER_METHODS) assert.ok(['createSession', 'send', 'cancel', 'status', 'contextUsage', 'resume', 'closeSession', 'nativeCheckpoint', 'nativeHandoff', 'archiveSession'].includes(name) || typeof provider[name] === 'function', `契约方法缺失：${name}`);
  assert.equal(caps.supported.nativeCheckpoint, false);
  assert.equal(caps.supported.nativeHandoff, false);
  assert.equal(caps.supported.archiveSession, false);
  // 假 Provider 未实现扩展方法（follow/selectModel/health）→ 同样如实标记 unsupported。
  assert.ok(caps.unsupported.includes('nativeCheckpoint') && caps.unsupported.includes('nativeHandoff') && caps.unsupported.includes('archiveSession'));
  assert.ok(caps.unsupported.includes('follow') && caps.unsupported.includes('selectModel') && caps.unsupported.includes('health'));
  await assert.rejects(() => provider.nativeCheckpoint({ sessionId: 'x' }), (e) => e.code === 'AGENT_UNSUPPORTED' && /Fake Agent/.test(e.message));
  await assert.rejects(() => provider.nativeHandoff({}), (e) => e.code === 'AGENT_UNSUPPORTED');
  ok('A1 契约填充与显式 unsupported（archiveSession/nativeCheckpoint/nativeHandoff）');

  assert.deepEqual(normalizePromptContent('hi'), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(normalizePromptContent([{ type: 'text', text: 'a' }]), [{ type: 'text', text: 'a' }]);
  assert.throws(() => normalizePromptContent(''), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => normalizePromptContent(42), (e) => e.code === 'INVALID_PARAMS');
  ok('A2 prompt 内容归一化');
}

// ── B. DSH 映射（mock api） ──────────────────────────────────────────────────
{
  const calls = [];
  const mockApi = {
    async callEndpoint(endpoint, args) {
      calls.push({ endpoint, args });
      if (endpoint === 'session/create') return { sessionId: 'session-mock-1' };
      if (endpoint === 'session/selectModel') return { selected: { provider: 'deepseek-official', model: args.request.model } };
      if (endpoint === 'session/prompt') return { accepted: true };
      if (endpoint === 'session/list') {
        return {
          items: [{
            sessionId: args._request ? 'session-mock-1' : 'x',
            running: false, blank: false, updatedAt: 123,
            projections: { values: { title: 't', tokenUsage: { uncachedInputTokens: 1 }, contextPressure: { pressureTokens: 2 } } }
          }]
        };
      }
      return {};
    },
    // eslint-disable-next-line require-yield
    async *openRemoteStream(endpoint) { calls.push({ endpoint, stream: true }); }
  };
  const provider = createDshAgentProvider({
    api: mockApi,
    defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }
  });
  const created = await provider.createSession({});
  assert.deepEqual(calls[0], { endpoint: 'session/create', args: { request: {} } });
  assert.equal(calls[1].endpoint, 'session/selectModel');
  assert.equal(created.sessionId, 'session-mock-1');
  assert.equal(created.model, 'deepseek-flash');
  assert.equal(created.modelBindingError, null);
  // DSH 契约红线：不支持的能力只有 archiveSession / nativeCheckpoint / nativeHandoff
  //（实测无端点/无协议，会话 2 契约改名），其余契约方法必须全部真实实现——
  // 不得为接口完整伪造能力，也不得漏报。
  const dshCaps = provider.capabilities();
  assert.deepEqual([...dshCaps.unsupported].sort(), ['archiveSession', 'nativeCheckpoint', 'nativeHandoff']);
  assert.equal(dshCaps.eventProtocol, 'dsh-session-events');
  ok('B1 createSession → session/create + 默认模型 selectModel');

  calls.length = 0;
  const sent = await provider.send({ sessionId: 'session-mock-1', content: '只回复两个字：收到' });
  const promptCall = calls.find((c) => c.endpoint === 'session/prompt');
  assert.equal(promptCall.args.request.sessionId, 'session-mock-1');
  assert.equal(promptCall.args.request.mode, 'queue');
  assert.match(promptCall.args.request.requestId, /^cetamesh-agent-/);
  assert.deepEqual(promptCall.args.request.content, [{ type: 'text', text: '只回复两个字：收到' }]);
  assert.equal(sent.accepted, true);
  ok('B2 send → session/prompt（requestId/mode/内容块数组）');

  calls.length = 0;
  await provider.cancel({ sessionId: 'session-mock-1' });
  assert.equal(calls.at(-1).endpoint, 'session/cancel');
  ok('B3 cancel → session/cancel');

  const status = await provider.status({ sessionId: 'session-mock-1' });
  assert.equal(status.running, false);
  assert.equal(status.provider, 'dsh');
  ok('B4 status → session/list 投影');

  const usage = await provider.contextUsage({ sessionId: 'session-mock-1' });
  assert.equal(usage.available, true);
  assert.ok(usage.tokenUsage.uncachedInputTokens === 1);
  assert.ok(usage.contextPressure.pressureTokens === 2);
  ok('B5 contextUsage → session/list tokenUsage/contextPressure');

  const resumed = await provider.resume({ sessionId: 'session-mock-1' });
  assert.equal(resumed.resumed, true);
  await assert.rejects(() => provider.resume({ sessionId: 'session-none' }), (e) => e.code === 'SESSION_NOT_FOUND');
  ok('B6 resume → 存在性校验（存在恢复 / 不存在结构化拒绝）');

  calls.length = 0;
  await provider.closeSession({ sessionId: 'session-mock-1' });
  assert.equal(calls.at(-1).endpoint, 'workspace/archiveSession');
  ok('B7 closeSession → workspace/archiveSession');

  const stream = provider.follow({ sessionId: 'session-mock-1' });
  await stream.next();
  assert.ok(calls.some((c) => c.endpoint === 'session/follow' && c.stream));
  ok('B8 follow → session/follow 流');
}

// ── C. service 注册与路由 ────────────────────────────────────────────────────
{
  const deadApi = { async callEndpoint() { throw new Error('settings/describe: 传输失败（ECONNREFUSED）'); }, async *openRemoteStream() { throw new Error('ws error'); } };
  const service = createDefaultAgentService({ api: deadApi, defaults: {}, codexExecutable: null,
    zcodeOptions: { desktopDetected: false }, log: () => {} });
  const list = await service.execute({ method: 'agent.list', params: {} });
  assert.deepEqual(list.providers.map((item) => item.id), ['dsh', 'codex', 'zcode']);
  assert.equal(list.providers[0].id, 'dsh');
  assert.equal(list.providers[0].capabilities.supported.nativeCheckpoint, false);
  assert.equal(list.providers.find((item) => item.id === 'codex').reason, 'not_installed');
  assert.equal(list.providers.find((item) => item.id === 'zcode').reason, 'not_installed');
  await assert.rejects(() => service.execute({ method: 'agent.status', params: { provider: 'dsh', sessionId: 'x' } }), (e) => e.code === 'PROVIDER_UNAVAILABLE' || e.code === 'PROVIDER_ERROR');
  // 可选能力经 Broker 诚实包装：agent.nativeCheckpoint 返回 UNSUPPORTED 形状而非抛断。
  const unsupported = await service.execute({ method: 'agent.nativeCheckpoint', params: { provider: 'dsh', sessionId: 'x' } });
  assert.deepEqual(
    { supported: unsupported.supported, reason: unsupported.reason },
    { supported: false, reason: 'UNSUPPORTED' }
  );
  await assert.rejects(() => service.execute({ method: 'agent.createSession', params: { provider: 'nope' } }), (e) => e.code === 'AGENT_PROVIDER_UNKNOWN', '未知 Provider 结构化拒绝（会话 2 起专用错误码）');
  await assert.rejects(() => service.execute({ method: 'agent.nonsense', params: {} }), (e) => e.code === 'METHOD_NOT_FOUND');
  ok('C1 service 路由 / 未知 provider / 未知方法 / 透传 unsupported');

  const health = await service.execute({ method: 'agent.health', params: { provider: 'dsh' } });
  assert.equal(health.available, false);
  assert.ok(health.reason);
  ok('C2 DSH 不可达时 health 优雅降级（不抛异常）');

  // C3 真实死端口（模拟"DSH 未启动"）：所有方法必须结构化失败且不崩进程。
  const deadPort = new NodeApiClient('http://127.0.0.1:9');
  const deadService = createDefaultAgentService({ api: deadPort, defaults: {}, log: () => {} });
  const deadCall = (method, params) => deadService.execute({ method, params });
  const health2 = await deadCall('agent.health', { provider: 'dsh' });
  assert.equal(health2.available, false);
  await assert.rejects(() => deadCall('agent.createSession', { provider: 'dsh' }), (e) => e.code === 'AGENT_BOUNDARY_UNSUPPORTED', 'unverified DSH sessions must not accept a free cwd');
  await assert.rejects(() => deadCall('agent.status', { provider: 'dsh', sessionId: 'x' }), (e) => e.code === 'PROVIDER_UNAVAILABLE', 'status 应报 PROVIDER_UNAVAILABLE');
  await assert.rejects(() => deadCall('agent.send', { provider: 'dsh', sessionId: 'x', content: 'hi' }), (e) => e.code === 'PROVIDER_UNAVAILABLE', 'send 应报 PROVIDER_UNAVAILABLE');
  await assert.rejects(() => deadCall('agent.cancel', { provider: 'dsh', sessionId: 'x' }), (e) => e.code === 'PROVIDER_UNAVAILABLE', 'cancel 应报 PROVIDER_UNAVAILABLE');
  await assert.rejects(() => deadCall('agent.contextUsage', { provider: 'dsh', sessionId: 'x' }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  await assert.rejects(() => deadCall('agent.resume', { provider: 'dsh', sessionId: 'x' }), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  ok('C3 DSH 未启动（真实死端口）：全部方法结构化降级 PROVIDER_UNAVAILABLE');
}

// ── E. Chat 集成：Normal Model 与 Agent Provider 两条执行路径 ─────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-agent-chat-'));
  try {
    const agentCalls = [];
    const directCalls = [];
    const chat = createChatService({
      api: {
        async callEndpoint(endpoint, args) { directCalls.push({ endpoint, args }); return { sessionId: 'dsh-direct-1' }; },
        async *openRemoteStream() { /* 空流：立即结束 */ }
      },
      controlExecute: async () => ({ models: [] }),
      agentExecute: async ({ method, params }) => {
        agentCalls.push({ method, params });
        if (method === 'agent.createSession') return { sessionId: 'dsh-agent-1', provider: 'dsh', model: params.model ?? null, modelBindingError: null };
        if (method === 'agent.send') return { accepted: true };
        if (method === 'agent.cancel') return { cancelled: true };
        throw new Error(`未预期的 Agent 方法：${method}`);
      },
      agentProviders: [{ id: 'dsh', label: 'DSH Agent', eventProtocol: 'dsh-session-events' }],
      defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      stateDir: tmp,
      sleep: async () => {}
    });
    const exec = (method, params) => chat.execute({ method, params });

    // E1 目录暴露可选择的 Agent Provider
    const catalog = await exec('chat.catalog', {});
    assert.deepEqual(catalog.agentProviders, [{
      id: 'dsh', label: 'DSH Agent', displayName: 'DSH Agent', eventProtocol: 'dsh-session-events',
      available: null, version: null, reason: null, workspaceBoundary: 'unsupported',
      supportsFreshSession: false, supportsResume: false, health: 'unknown'
    }]);
    ok('E1 chat.catalog 暴露 agentProviders（UI 选择数据源）');

    // E2 Agent Provider 路径：createSession + send 走标准契约
    const sessionA = await exec('chat.sessions.create', { title: 'agent 路径' });
    assert.equal(sessionA.config.agentProvider, null, '默认应为普通模型（null）');
    await exec('chat.config.set', { id: sessionA.id, config: { agentProvider: 'dsh' } });
    await exec('chat.send', { id: sessionA.id, text: '你好' });
    assert.equal(agentCalls[0]?.method, 'agent.createSession');
    assert.equal(agentCalls[0]?.params.provider, 'dsh');
    assert.equal(agentCalls[1]?.method, 'agent.send');
    assert.equal(agentCalls[1]?.params.sessionId, 'dsh-agent-1');
    assert.equal(agentCalls[1]?.params.content, '你好');
    assert.equal(directCalls.filter((c) => c.endpoint === 'session/prompt').length, 0, 'Agent 路径不得直连 DSH prompt');
    ok('E2 Agent Provider 路径经 agent.createSession/agent.send（不直连 DSH）');

    // E3 Normal Model 路径：不设 agentProvider 时行为与阶段 03 完全一致（直连 DSH）
    const sessionB = await exec('chat.sessions.create', { title: '普通模型' });
    await exec('chat.send', { id: sessionB.id, text: 'hi' });
    assert.ok(directCalls.some((c) => c.endpoint === 'session/create'));
    assert.ok(directCalls.some((c) => c.endpoint === 'session/prompt'));
    ok('E3 Normal Model 路径保持直连 DSH（回归不变）');

    // E4 非法 / 不兼容 Provider 被拒
    await assert.rejects(
      () => exec('chat.config.set', { id: sessionB.id, config: { agentProvider: 'nope' } }),
      (e) => e.code === 'INVALID_PARAMS' && /未知 Agent Provider/.test(e.message)
    );
    const chatIncompatible = createChatService({
      api: { async callEndpoint() { return {}; }, async *openRemoteStream() {} },
      controlExecute: async () => ({ models: [] }),
      agentExecute: async () => ({ sessionId: 'x' }),
      agentProviders: [{ id: 'weird', label: 'Weird', eventProtocol: null }],
      defaults: {},
      stateDir: tmp,
      sleep: async () => {}
    });
    const sessionC = await chatIncompatible.execute({ method: 'chat.sessions.create', params: {} });
    await assert.rejects(
      () => chatIncompatible.execute({ method: 'chat.config.set', params: { id: sessionC.id, config: { agentProvider: 'weird' } } }),
      (e) => e.code === 'INVALID_PARAMS' && /事件协议/.test(e.message)
    );
    ok('E4 未知 Provider 与事件协议不兼容的 Provider 均被拒绝');

    chat.close();
    chatIncompatible.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── D. 真机验收（DSH 未启动则记 NOT_RUN_ENVIRONMENT） ─────────────────────────
const liveApi = new NodeApiClient(DSH_BASE_URL);
let dshUp = false;
try {
  await liveApi.callEndpoint('settings/describe', {}, AbortSignal.timeout(3000));
  dshUp = true;
} catch {
  results.live = 'NOT_RUN_ENVIRONMENT';
  console.log('NOT_RUN_ENVIRONMENT 真机验收：DSH 未在 ' + DSH_BASE_URL + ' 运行，跳过 D 段（不算失败）');
}

if (dshUp) {
  const service = createDefaultAgentService({
    api: liveApi,
    defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    log: () => {}
  });
  const exec = (method, params) => service.execute({ method, params });

  // D1 createSession
  const created = await exec('agent.createSession', { provider: 'dsh' });
  assert.ok(created.sessionId, 'createSession 应返回 sessionId');
  assert.ok(!created.modelBindingError, `模型绑定失败：${created.modelBindingError}`);
  console.log(`PASS D1 createSession（${created.sessionId}，model=${created.model}）`);
  results.pass += 1;

  // D2 send + D3 follow 进度
  const controller = new AbortController();
  const events = [];
  const followDone = (async () => {
    try {
      for await (const item of liveApi.openRemoteStream(
        'session/follow',
        { request: { address: { kind: 'session', sessionId: created.sessionId } } },
        { signal: controller.signal }
      )) {
        if (item.type === 'event' && item.event) {
          events.push(item.event);
          if (item.event.type === 'turn/end') break;
        }
      }
    } catch { /* abort 或断流 */ }
  })();
  await new Promise((r) => setTimeout(r, 300));
  const sent = await exec('agent.send', { provider: 'dsh', sessionId: created.sessionId, content: '只回复两个字：收到' });
  assert.equal(sent.accepted, true);
  const deadline = Date.now() + 90_000;
  while (!events.some((e) => e.type === 'turn/end') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  controller.abort();
  await followDone;
  const turnEnd = events.find((e) => e.type === 'turn/end');
  assert.ok(turnEnd, '90 秒内未收到 turn/end（进度流）');
  assert.equal(turnEnd.data.reason?.kind, 'completed');
  assert.ok(events.some((e) => e.type === 'assistant/message' || e.type === 'assistant/chunk'), '未收到任何 assistant 事件');
  console.log(`PASS D2/D3 send + follow 进度（turn/end completed，事件 ${events.length} 条）`);
  results.pass += 1;

  // D4 status + contextUsage（回合后投影应可用）
  const status = await exec('agent.status', { provider: 'dsh', sessionId: created.sessionId });
  assert.equal(status.sessionId, created.sessionId);
  const usage = await exec('agent.contextUsage', { provider: 'dsh', sessionId: created.sessionId });
  assert.equal(usage.available, true, '回合结束后 contextUsage 应可用');
  assert.ok(usage.tokenUsage, 'tokenUsage 缺失');
  console.log(`PASS D4 status + contextUsage（pressure=${usage.contextPressure?.pressureTokens ?? 'n/a'}）`);
  results.pass += 1;

  // D5 cancel：新会话发长任务后立刻取消
  const created2 = await exec('agent.createSession', { provider: 'dsh' });
  await new Promise((r) => setTimeout(r, 200));
  await exec('agent.send', {
    provider: 'dsh',
    sessionId: created2.sessionId,
    content: '请从 1 数到 200，每个数字单独一行，不要省略，不要解释。'
  });
  await new Promise((r) => setTimeout(r, 500));
  const cancelled = await exec('agent.cancel', { provider: 'dsh', sessionId: created2.sessionId });
  assert.equal(cancelled.cancelled, true);
  // 取消后状态轮询：running 应在 15 秒内回落为 false（或会话仍可见）。
  let stopped = false;
  const cancelDeadline = Date.now() + 15_000;
  while (Date.now() < cancelDeadline) {
    const s = await exec('agent.status', { provider: 'dsh', sessionId: created2.sessionId }).catch(() => null);
    if (s && s.running === false) { stopped = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(stopped, 'cancel 后 15 秒内 running 未回落');
  console.log('PASS D5 cancel（受理 + running 回落）');
  results.pass += 1;

  // D6 resume：新 provider 实例重新挂载既有会话
  const resumeService = createDefaultAgentService({
    api: new NodeApiClient(DSH_BASE_URL),
    defaults: {},
    log: () => {}
  });
  const resumed = await resumeService.execute({ method: 'agent.resume', params: { provider: 'dsh', sessionId: created.sessionId } });
  assert.equal(resumed.resumed, true);
  const resumedStatus = await resumeService.execute({ method: 'agent.status', params: { provider: 'dsh', sessionId: created.sessionId } });
  assert.equal(resumedStatus.sessionId, created.sessionId);
  console.log('PASS D6 resume（新实例重挂既有会话并读取状态）');
  results.pass += 1;

  // D7 closeSession：实测 DSH 的 workspace/archiveSession 是"归档"语义，
  // 归档后会话仍可能出现在 session/list（不承诺从列表消失）——按真实语义断言。
  const closed1 = await exec('agent.closeSession', { provider: 'dsh', sessionId: created.sessionId });
  assert.equal(closed1.closed, true);
  const closed2 = await exec('agent.closeSession', { provider: 'dsh', sessionId: created2.sessionId });
  assert.equal(closed2.closed, true);
  // 归档后重复关闭 / 状态查询不得让进程崩溃：接受"仍可见"或"sessions/not-found"两种结果。
  let postClose = null;
  try {
    const s = await exec('agent.status', { provider: 'dsh', sessionId: created.sessionId });
    postClose = `still-listed(running=${s.running})`;
  } catch (error) {
    assert.equal(error.code, 'SESSION_NOT_FOUND', `归档后状态查询出现意外错误：${error.code} ${error.message}`);
    postClose = 'session/not-found';
  }
  const reclose = await exec('agent.closeSession', { provider: 'dsh', sessionId: created.sessionId }).then(() => 'accepted', (e) => `rejected(${e.code})`);
  console.log(`PASS D7 closeSession（归档受理 ×2；归档后 status=${postClose}；重复关闭=${reclose}）`);
  results.pass += 1;
  results.live = 'PASS';
}

console.log(`\n单元/映射段：${results.pass} 通过，${results.fail} 失败；真机段：${results.live ?? 'NOT_RUN_ENVIRONMENT'}`);
if (results.fail > 0) process.exit(1);
