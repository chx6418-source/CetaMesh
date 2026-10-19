// 阶段 03 验收：产品级 Desktop Chat 运行时（src/desktop/chat-service.js）。
// fixture DSH（可控注入 follow 事件）+ 隔离临时 stateDir，不触碰真实 DSH / 用户数据。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiEventBus, createDesktopUiService } from '../src/desktop/ui-service.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

const root = path.resolve(import.meta.dirname, '..');
const typedBridge = fs.readFileSync(path.join(root, 'desktop-ui/src/bridge/typed-client.ts'), 'utf8');
const tempRoot = process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'chat-product-test-'));
const stateDir = path.join(temp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }
async function waitFor(read, predicate, label, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

assert.match(typedBridge, /coreInstanceId !== response\.instanceId/);
assert.match(typedBridge, /cursor = 0;[\s\S]*core\.restarted/);
assert.match(typedBridge, /continue;[\s\S]*cursor = Math\.max/);
ok('Core restart changes event epoch, resets cursor, then replays the first new event');

/** 可控 DSH fixture：callEndpoint 记录调用；follow 流由 _injectEvent 驱动。 */
function fixtureApi() {
  const calls = [];
  const followSignals = [];
  let promptHandler = null;
  let selectModelHandler = null;
  let failEndpoints = null; // Set<endpoint>：命中即抛 ECONNREFUSED
  return {
    calls,
    followSignals,
    setPromptHandler: (fn) => { promptHandler = fn; },
    setSelectModelHandler: fn => { selectModelHandler = fn; },
    fail: (endpoints) => { failEndpoints = new Set(endpoints); },
    async callEndpoint(endpoint, args = {}) {
      calls.push({ endpoint, args });
      if (failEndpoints?.has(endpoint)) {
        throw new Error(`${endpoint}: 传输失败（ECONNREFUSED）`);
      }
      if (endpoint === 'session/create') {
        return { sessionId: `dsh-${calls.filter((c) => c.endpoint === 'session/create').length}` };
      }
      if (endpoint === 'session/selectModel') { await selectModelHandler?.(args); return {}; }
      if (endpoint === 'session/prompt') {
        await promptHandler?.(args.request.sessionId, args.request.content);
        return { accepted: true };
      }
      if (endpoint === 'session/cancel') return {};
      if (endpoint === 'workspace/archiveSession') return { closed: true };
      throw new Error(`unexpected endpoint: ${endpoint}`);
    },
    // follow 流永不产出；事件统一经 _injectEvent 注入，并遵守 signal 结束。
    async *openRemoteStream(_endpoint, _args, { signal } = {}) {
      followSignals.push(signal);
      await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
    }
  };
}

function fixtureControl(models) {
  return async ({ method }) => {
    if (method !== 'model.catalog.list') throw new Error(`unexpected control method: ${method}`);
    if (models === 'throw') throw new Error('settings/describe: 传输失败（ECONNREFUSED）');
    return { models: models ?? [] };
  };
}

let caseSeq = 0;
function makeService(overrides = {}) {
  const dir = overrides.stateDir ?? path.join(stateDir, 'case-' + (++caseSeq));
  fs.mkdirSync(dir, { recursive: true });
  return createChatService({
    api: overrides.api ?? fixtureApi(),
    controlExecute: overrides.controlExecute ?? fixtureControl(),
    defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    stateDir: dir,
    ...(overrides.options ?? {})
  });
}

const chunk = (id, text) => ({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } });
const message = (id, text, usage) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } }
});
const turnEnd = (id, kind, error) => ({ type: 'turn/end', data: { reason: { kind, ...(error ? { error: { message: error } } : {}) } } });

// ── 1. 会话 CRUD：创建 / 列表 / 重命名 / 归档 / 删除 ─────────────────────────
{
  const service = makeService();
  const created = await service.execute({ method: 'chat.sessions.create', params: {} });
  assert.equal(created.title, '新会话');
  assert.equal(created.config.model, 'deepseek-flash');
  assert.equal(created.config.mode, 'chat');
  const renamed = await service.execute({ method: 'chat.sessions.rename', params: { id: created.id, title: '项目讨论' } });
  assert.equal(renamed.title, '项目讨论');
  const archived = await service.execute({ method: 'chat.sessions.archive', params: { id: created.id, archived: true } });
  assert.equal(archived.archived, true);
  assert.equal((await service.execute({ method: 'chat.sessions.list', params: {} })).sessions.length, 0);
  assert.equal((await service.execute({ method: 'chat.sessions.list', params: { includeArchived: true } })).sessions.length, 1);
  const second = await service.execute({ method: 'chat.sessions.create', params: { title: '第二会话' } });
  assert.deepEqual((await service.execute({ method: 'chat.sessions.list', params: {} })).sessions.map((s) => s.title), ['第二会话']);
  const deleted = await service.execute({ method: 'chat.sessions.delete', params: { id: second.id } });
  assert.equal(deleted.deleted, true);
  await assert.rejects(
    service.execute({ method: 'chat.history', params: { id: second.id } }),
    (error) => error.code === 'SESSION_NOT_FOUND'
  );
  ok('会话 CRUD：创建/列表/重命名/归档过滤/删除');
  service.close();
}

// ── 2. 发送 + streaming（chunk 增量 / message 校准 / usage 透传） ────────────
{
  const api = fixtureApi();
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: { title: '流式' } });
  api.setPromptHandler(async (sessionId, content) => {
    assert.match(sessionId, /^dsh-/);
    assert.equal(content[0].type, 'text');
    service._injectEvent(session.id, { type: 'turn/start', data: { turn: 1 } });
    service._injectEvent(session.id, chunk(session.id, '你好'));
    service._injectEvent(session.id, chunk(session.id, '，正在'));
    service._injectEvent(session.id, message(session.id, '你好，正在', { inputTokens: 12, outputTokens: 3 }));
    service._injectEvent(session.id, chunk(session.id, '思考'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '测试流式' } });
  const final = await waitFor(
    () => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.turn === null,
    'completed DSH streaming turn'
  );
  assert.equal(final.turn, null, 'turn/end 后回合归档');
  assert.equal(final.lastState, 'idle');
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].role, 'user');
  assert.equal(history.messages[1].role, 'assistant');
  assert.equal(history.messages[1].text, '你好，正在思考', 'message 定稿段 + 后续 chunk 段连接');
  assert.deepEqual(history.messages[1].usage, { inputTokens: 12, outputTokens: 3 }, '真实 usage 透传');
  const clientId = 'client-send-001';
  const correlated = await service.execute({ method: 'chat.send', params: { id: session.id, text: '客户端关联消息', clientMessageId: clientId } });
  assert.equal(correlated.userMessageId, clientId, 'Core adopts the stable renderer message ID');
  const repeated = await service.execute({ method: 'chat.send', params: { id: session.id, text: '客户端关联消息', clientMessageId: clientId } });
  assert.equal(repeated.userMessageId, clientId, 'network retry with the same ID is idempotent');
  const correlatedHistory = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(correlatedHistory.messages.filter(message => message.id === clientId).length, 1, 'the correlated user message is stored once');
  // selectModel：新会话创建后绑定默认模型
  assert.ok(api.calls.some((c) => c.endpoint === 'session/selectModel' && c.args.request.model === 'deepseek-flash'));
  ok('发送 + streaming（chunk 增量 / message 校准）+ usage 透传 + 模型绑定');
  service.close();
}

// ── 4b. 创建/Prompt 尚未返回时，Stop 也必须请求取消真实 DSH 回合 ─────────────
{
  const api = fixtureApi();
  let releasePrompt;
  const gate = new Promise(resolve => { releasePrompt = resolve; });
  api.setPromptHandler(async () => gate);
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  const ack = await service.execute({ method: 'chat.send', params: { id: session.id, text: '慢启动 DSH 回合' } });
  assert.match(ack.requestId, /^cetamesh-chat-/);
  await waitFor(() => api.calls, calls => calls.some(call => call.endpoint === 'session/prompt'), 'pending DSH prompt');
  const stopped = await service.execute({ method: 'chat.stop', params: { id: session.id } });
  assert.equal(stopped.stopped, true);
  assert.equal(api.calls.filter(call => call.endpoint === 'session/cancel').length, 1,
    'Stop aborts the local pending request and explicitly cancels the DSH session');
  releasePrompt();
  service.close();
  ok('DSH operation cancellation reaches the remote session while prompt acknowledgement is pending');
}

// ── 3. 无 usage：显示未知，禁止伪造 ──────────────────────────────────────────
{
  const api = fixtureApi();
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, '没有 usage 的事件'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'hi' } });
  await waitFor(
    () => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.turn === null,
    'completed no-usage DSH turn'
  );
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].usage, null, '无 usage 数据时必须为 null（未知），不得伪造');
  ok('usage 未知时为 null（不伪造）');
  service.close();
}

// ── 4. 停止：cancel → cancelled → partial 保留 + DSH 会话丢弃 ────────────────
{
  const api = fixtureApi();
  const serviceStateDir = path.join(stateDir, 'stop-partial-session');
  const service = makeService({ api, stateDir: serviceStateDir });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, chunk(session.id, '长回答的前半段'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '写一篇长文' } });
  const streaming = await waitFor(
    () => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.turn?.state === 'streaming' && status.turn.displayText === '长回答的前半段',
    'streaming partial DSH answer'
  );
  assert.equal(streaming.turn.state, 'streaming');
  assert.equal(streaming.turn.displayText, '长回答的前半段');
  const stopped = await service.execute({ method: 'chat.stop', params: { id: session.id } });
  assert.equal(stopped.stopped, true);
  service._injectEvent(session.id, turnEnd(session.id, 'cancelled'));
  const after = await service.execute({ method: 'chat.status', params: { id: session.id } });
  assert.equal(after.turn, null);
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].cancelled, true, '取消的 partial 保留并标记');
  assert.equal(history.messages[1].text, '长回答的前半段');
  assert.equal(api.calls.filter((c) => c.endpoint === 'session/cancel').length, 1, 'cancel 已调用');
  // 取消成功后 DSH 会话被丢弃，下次发送创建新会话（隔离迟到事件）
  const record = JSON.parse(fs.readFileSync(path.join(serviceStateDir, 'desktop-chat', 'sessions.json'), 'utf8'));
  assert.equal(record.sessions.find((s) => s.id === session.id).dshSessionId, null);
  ok('停止：cancel → cancelled → partial 落盘 + DSH 会话重置');
  service.close();
}

// ── 5. 异常 Provider：DSH 不可达 → 明确错误 + 历史可 retry ───────────────────
{
  const api = fixtureApi();
  api.fail(['session/create']);
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  const ack = await service.execute({ method: 'chat.send', params: { id: session.id, text: 'DSH 关了' } });
  assert.match(ack.requestId, /^cetamesh-chat-/);
  const failed = await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.turn === null && status.lastErrorCode === 'DSH_UNAVAILABLE', 'DSH failure projection');
  assert.match(failed.lastError, /DSH 未连接或不可达/);
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].role, 'user');
  assert.equal(history.messages[1].errorCode, 'DSH_UNAVAILABLE');
  assert.equal(failed.lastState, 'error', 'failed assistant record keeps the error state observable');
  // DSH 恢复后 retry 成功：不重复 user 消息
  api.fail(null);
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, '恢复后的回答'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  const retryAck = await service.execute({ method: 'chat.retry', params: { id: session.id } });
  assert.match(retryAck.requestId, /^cetamesh-chat-/);
  await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.turn === null && status.lastState === 'idle', 'DSH retry completion');
  const history2 = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history2.messages.filter(message => message.role === 'user').length, 1, 'retry 不重复 user 消息');
  assert.equal(history2.messages.at(-1).text, '恢复后的回答');
  ok('异常 Provider：明确错误 + awaiting-reply + retry 恢复（不重复 user）');
  service.close();
}

// ── 6. 空 Provider：目录为空 / 目录不可用，不伪造 ─────────────────────────────
{
  const service = makeService({ controlExecute: fixtureControl([]) });
  const empty = await service.execute({ method: 'chat.catalog', params: {} });
  assert.deepEqual(empty.models, []);
  assert.equal(empty.error, null, '目录可用但为空：models 空、无 error');
  const broken = makeService({ controlExecute: fixtureControl('throw') });
  const failed = await broken.execute({ method: 'chat.catalog', params: {} });
  assert.deepEqual(failed.models, []);
  assert.match(failed.error, /ECONNREFUSED/);
  ok('空 Provider / 目录不可用：models 空 + 明确 error，不伪造列表');
  service.close();
  broken.close();
}

// ── 7. 切换模型：config.set → 立即 selectModel ───────────────────────────────
{
  const api = fixtureApi();
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  api.setPromptHandler(async () => {});
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '先建会话' } });
  service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  const bound = api.calls.filter((c) => c.endpoint === 'session/selectModel').length;
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { model: 'deepseek-reasoner', reasoning: 'high', mode: 'smart' } } });
  assert.ok(api.calls.filter((c) => c.endpoint === 'session/selectModel').length > bound, '模型变更立即重新 selectModel');
  const last = api.calls.filter((c) => c.endpoint === 'session/selectModel').pop();
  assert.equal(last.args.request.model, 'deepseek-reasoner');
  assert.equal(last.args.request.reasoningEffort, 'high');
  assert.equal(last.args.request.provider, 'deepseek-official', 'provider 由既有 DSH 配置解析');
  const updated = await service.execute({ method: 'chat.sessions.list', params: {} });
  assert.equal(updated.sessions[0].config.model, 'deepseek-reasoner');
  assert.equal(updated.sessions[0].config.mode, 'smart');

  let releaseSelection;
  let selectionStarted = false;
  const selectionGate = new Promise(resolve => { releaseSelection = resolve; });
  api.setSelectModelHandler(async () => { selectionStarted = true; await selectionGate; });
  const concurrentConfig = service.execute({ method: 'chat.config.set', params: {
    id: session.id, config: { model: 'deepseek-coder' }
  } });
  await waitFor(() => selectionStarted, value => value, 'first model configuration bind');
  const whileBinding = await service.execute({ method: 'chat.sessions.list', params: {} });
  assert.equal(whileBinding.sessions.find(item => item.id === session.id).config.model, 'deepseek-reasoner',
    'uncommitted configuration is not exposed while Provider binding is in flight');
  await assert.rejects(() => service.execute({ method: 'chat.config.set', params: {
    id: session.id, config: { model: 'deepseek-v4' }
  } }), error => error.code === 'CONFIG_BUSY', 'concurrent model changes cannot race the active Provider bind');
  releaseSelection();
  await concurrentConfig;
  api.setSelectModelHandler(null);
  const afterConcurrentBind = await service.execute({ method: 'chat.sessions.list', params: {} });
  assert.equal(afterConcurrentBind.sessions.find(item => item.id === session.id).config.model, 'deepseek-coder');

  api.fail(['session/selectModel']);
  await assert.rejects(() => service.execute({ method: 'chat.config.set', params: {
    id: session.id, config: { model: 'model-that-could-not-bind' }
  } }), error => error.code === 'MODEL_BIND_FAILED');
  const afterBindFailure = await service.execute({ method: 'chat.sessions.list', params: {} });
  assert.equal(afterBindFailure.sessions.find(item => item.id === session.id).config.model, 'deepseek-coder',
    'a failed provider binding leaves the persisted model configuration unchanged');
  api.fail([]);
  await assert.rejects(
    service.execute({ method: 'chat.config.set', params: { id: session.id, config: { reasoning: 'ultra' } } }),
    (error) => error.code === 'INVALID_PARAMS'
  );
  ok('切换模型/reasoning/mode：即时 selectModel + 持久化 + 参数校验');
  service.close();
}

// ── 7b. Tool Calling 快速 ACK + IPC 取消边界 ────────────────────────────────
{
  const dir = path.join(stateDir, 'agent-none-linked-task');
  fs.mkdirSync(dir, { recursive: true });
  const first = makeService({ stateDir: dir });
  const session = await first.execute({ method: 'chat.sessions.create', params: {} });
  await first.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'none' } } });
  first.close();
  const sessionsPath = path.join(dir, 'desktop-chat', 'sessions.json');
  const stored = readJsonFile(sessionsPath);
  stored.sessions.find(row => row.id === session.id).taskId = 'already-linked-task';
  writeJsonAtomic(sessionsPath, stored);
  let dispatched = 0;
  const service = makeService({ stateDir: dir, options: {
    platformRoute: async () => { dispatched += 1; throw new Error('Agent none dispatched'); },
    modelRuntime: {
      defaultProviderId: () => 'fixture-model', resolveProvider: id => ({ id }),
      supportsToolCalling: () => false,
      async *stream() {
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Model only.' } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      }
    }
  } });
  try {
    await service.execute({ method: 'chat.send', params: { id: session.id, text: 'Explain this task without Agent' } });
    await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }),
      status => status.turn === null, 'Agent none linked Task model turn');
    assert.equal(dispatched, 0, 'Agent none forbids dispatch even when Chat is linked to a Task');
  } finally { service.close(); }
  ok('Agent none with an existing Task remains on the Model path');
}

{
  const events = [];
  const modelRuntime = {
    defaultProviderId: () => 'fixture-model', resolveProvider: id => ({ id }),
    supportsToolCalling: () => true
  };
  const service = makeService({ options: { modelRuntime,
    onEvent: event => events.push(event),
    toolExecutionCoordinator: { run: async () => ({ status: 'completed', toolCalling: 'supported', text: 'Tool result is ready.' }),
      cancelSession: () => ({ cancelled: 0 }) }
  } });
  try {
    const session = await service.execute({ method: 'chat.sessions.create', params: {} });
    await service.execute({ method: 'chat.send', params: { id: session.id, text: 'Complete tool turn' } });
    await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }),
      status => status.turn === null, 'Tool Calling formal commit');
    const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
    const answer = history.messages.at(-1);
    assert.equal(answer.text, 'Tool result is ready.');
    assert.ok(events.some(row => row.event === 'chat.updated' && row.data?.sessionId === session.id
      && row.data?.messageId === answer.id), 'formal Tool Calling message commit notifies Harbor with message identity');
  } finally { service.close(); }
  ok('Tool Calling formal message commit emits chat.updated with message identity');
}

{
  const dir = path.join(stateDir, 'fast-ack');
  fs.mkdirSync(dir, { recursive: true });
  let toolSignal = null;
  const modelRuntime = {
    defaultProviderId: () => 'fixture-model',
    resolveProvider: id => ({ id }),
    supportsToolCalling: () => true
  };
  const service = makeService({ stateDir: dir, options: { modelRuntime,
    toolExecutionCoordinator: { run: ({ signal }) => {
      toolSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'INVOKE_CANCELLED' })), { once: true });
      });
    }, cancelSession: () => ({ cancelled: 0 }) }
  } });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  let sendPromise;
  try {
    sendPromise = service.execute({ method: 'chat.send', params: { id: session.id, text: 'Use a slow tool' } });
    const ack = await Promise.race([
      sendPromise.then(value => ({ value })),
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 100))
    ]);
    if (ack.timedOut) {
      await service.execute({ method: 'chat.stop', params: { id: session.id } });
      await sendPromise;
    }
    assert.ok(ack.value?.requestId, 'a slow Tool Calling turn returns a stable requestId before the tool completes');
    assert.ok(toolSignal && !toolSignal.aborted, 'the accepted operation continues after its fast IPC acknowledgement');
    await service.execute({ method: 'chat.stop', params: { id: session.id } });
    assert.equal(toolSignal.aborted, true, 'explicit Stop cancels the accepted Tool Calling operation');
    await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }), status => status.turn === null, 'fast-ack stop');

    const ui = createDesktopUiService({ services: { chatService: service } });
    const preCancelled = new AbortController();
    preCancelled.abort();
    const historyBefore = await service.execute({ method: 'chat.history', params: { id: session.id } });
    await assert.rejects(() => ui.execute({ method: 'ui.chat.send', params: { id: session.id, text: 'must not start' }, signal: preCancelled.signal }),
      error => error.code === 'INVOKE_CANCELLED', 'an IPC cancelled before acceptance does not start a Chat turn');
    const historyAfter = await service.execute({ method: 'chat.history', params: { id: session.id } });
    assert.equal(historyAfter.messages.length, historyBefore.messages.length, 'pre-acceptance cancellation persists no duplicate user message');
  } finally { service.close(); }
  ok('Tool Calling returns fast ACK; explicit Stop aborts the accepted turn and pre-acceptance IPC cancel is honored');
}

// ── 7c. 附件正文、指纹与重启后重试 ─────────────────────────────────────────
{
  const api = fixtureApi();
  const dir = path.join(stateDir, 'attachment-retry');
  fs.mkdirSync(dir, { recursive: true });
  const prompts = [];
  api.setPromptHandler(async (_sessionId, content) => prompts.push(content));
  let service = makeService({ api, stateDir: dir });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  const attachment = { name: 'notes.txt', mimeType: 'text/plain', content: 'the original attachment body' };
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'Summarize this', attachments: [attachment], clientMessageId: 'attachment-message-1' } });
  service._injectEvent(session.id, turnEnd(session.id, 'error', 'fixture failure'));
  await assert.rejects(() => service.execute({ method: 'chat.send', params: { id: session.id, text: 'Summarize this',
    attachments: [{ ...attachment, content: 'different body with same name' }], clientMessageId: 'attachment-message-1' } }),
  error => error.code === 'MESSAGE_ID_CONFLICT', 'same-name attachments with different content are not idempotent duplicates');
  service.close();
  service = makeService({ api, stateDir: dir });
  await service.execute({ method: 'chat.retry', params: { id: session.id } });
  await waitFor(() => prompts, rows => rows.length === 2, 'attachment retry prompt');
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(prompt => prompt[0]?.text?.includes(attachment.content)), 'retry after restart reuses the original attachment body');
  const storedHistory = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(JSON.stringify(storedHistory).includes(attachment.content), false, 'attachment bodies stay in their dedicated local payload file');
  const attachmentDirectory = path.join(service._store.dir, 'attachment-payloads', crypto.createHash('sha256').update(session.id).digest('hex'));
  assert.equal(fs.existsSync(attachmentDirectory), true);
  await service.execute({ method: 'chat.sessions.delete', params: { id: session.id } });
  assert.equal(fs.existsSync(attachmentDirectory), false, 'deleting a Chat removes its local attachment payloads');
  service.close();
  ok('Chat attachment bodies and fingerprints survive restart and retry without accepting changed content');
}

// ── 8. 长输出：大量 chunk 流式 + 完整定稿 ────────────────────────────────────
{
  const api = fixtureApi();
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  const part = '字'.repeat(500);
  const segments = Array.from({ length: 20 }, (_, i) => part + `-${i}-`);
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    for (const segment of segments) {
      service._injectEvent(session.id, chunk(session.id, segment));
      service._injectEvent(session.id, message(session.id, segment));
    }
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '长输出' } });
  await waitFor(
    () => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.turn === null,
    'completed long DSH response'
  );
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].text, segments.join(''), '20 段 × 500 字全部保留，无翻倍无丢失');
  ok('长输出：分段流式完整定稿（无翻倍/丢失）');
  service.close();
}

// ── 9. 重启后历史与会话存在（新实例同 stateDir） ─────────────────────────────
{
  const api = fixtureApi();
  const sharedDir = path.join(stateDir, 'case-restart');
  const service = makeService({ api, stateDir: sharedDir });
  const session = await service.execute({ method: 'chat.sessions.create', params: { title: '持久化' } });
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, '重启前的回答'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '记住我' } });
  await waitFor(() => service.execute({ method: 'chat.history', params: { id: session.id } }),
    history => history.messages.at(-1)?.text === '重启前的回答', 'DSH response persisted before restart');
  service.close();

  const revived = makeService({ api: fixtureApi(), stateDir: sharedDir });
  const listed = await revived.execute({ method: 'chat.sessions.list', params: {} });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].title, '持久化');
  const history = await revived.execute({ method: 'chat.history', params: { id: session.id } });
  assert.deepEqual(history.messages.map((m) => m.text), ['记住我', '重启前的回答']);
  assert.equal((await revived.execute({ method: 'chat.status', params: { id: session.id } })).lastState, 'idle', '重启后无在途回合（不伪造状态）');
  ok('重启后：会话与历史完整存在，在途回合如实归位');
  revived.close();
}

// ── 10. 并发防护 / continue / 参数校验 ───────────────────────────────────────
{
  const api = fixtureApi();
  const service = makeService({ api, options: { resolveWorkspace: async id => ({ id, root: 'C:\\fixture' }) } });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { workspaceId: 'workspace-a' } } });
  let releasePrompt;
  const gate = new Promise((resolve) => { releasePrompt = resolve; });
  api.setPromptHandler(async () => { await gate; });
  const pending = service.execute({ method: 'chat.send', params: { id: session.id, text: '慢回合' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: session.id, text: '并发' } }),
    (error) => error.code === 'TURN_BUSY'
  );
  await assert.rejects(service.execute({ method: 'chat.config.set', params: {
    id: session.id, config: { workspaceId: 'workspace-b' }
  } }), error => error.code === 'TURN_BUSY', 'CHAT-08: active turn cannot change Workspace binding');
  assert.equal((await service.execute({ method: 'chat.sessions.list', params: {} })).sessions[0].config.workspaceId, 'workspace-a');
  const stopProbe = await service.execute({ method: 'chat.stop', params: { id: session.id } });
  assert.equal(stopProbe.stopped, true, 'streaming 中 stop 被受理');
  releasePrompt();
  await pending;
  service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  // continue：对已完成会话发送"继续"
  api.setPromptHandler(async (sid, content) => {
    assert.equal(content[0].text, '继续');
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  const continued = await service.execute({ method: 'chat.continue', params: { id: session.id } });
  assert.equal(continued.continued, true);
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).role, 'assistant');
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: session.id, text: '' } }),
    (error) => error.code === 'INVALID_PARAMS'
  );
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: 'missing', text: 'x' } }),
    (error) => error.code === 'SESSION_NOT_FOUND'
  );
  ok('TURN_BUSY 并发防护 / continue / 参数与会话校验');
  service.close();
}

// ── 11. turn 异常结束（非 completed）→ error 态 + retry 路径 ─────────────────
{
  const api = fixtureApi();
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, chunk(session.id, '部分输出'));
    service._injectEvent(session.id, turnEnd(session.id, 'error', '模型服务中断'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '会失败的问题' } });
  await waitFor(
    () => service.execute({ method: 'chat.status', params: { id: session.id } }),
    status => status.lastState === 'error' && status.turn === null,
    'failed DSH turn'
  );
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].error, '模型服务中断');
  assert.equal(history.messages[1].text, '部分输出', 'error 回合的 partial 保留');
  assert.equal((await service.execute({ method: 'chat.status', params: { id: session.id } })).lastState, 'error', 'error 终态保留为可观测状态');
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, '重试后的回答'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  const retry = await service.execute({ method: 'chat.retry', params: { id: session.id } });
  assert.equal(retry.userMessageId, history.messages[0].id, '失败回合重试复用原 user 消息');
  await waitFor(
    () => service.execute({ method: 'chat.history', params: { id: session.id } }),
    value => value.messages.at(-1)?.text === '重试后的回答',
    'successful DSH retry'
  );
  const historyAfterRetry = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(historyAfterRetry.messages.filter(item => item.role === 'user').length, 1);
  assert.equal(historyAfterRetry.messages.at(-1).text, '重试后的回答');
  ok('turn 异常结束：partial + error 标记落盘，允许复用原 user 重试');
  service.close();
}

// ── 会话 1 扩展：Model Runtime 双通道（Standalone Chat / Smart Router / Agent）──
import { createOpenAiCompatibleModelProvider, createModelProviderRegistry, createModelRuntimeService } from '../src/model/index.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { createRouterService } from '../src/router/index.js';
import {
  createOpenAiCompatibleFixture,
  OPENAI_COMPATIBLE_FIXTURE_BASE_URL
} from './test-support/openai-compatible-fixture.mjs';

const API_KEY = 'sk-standalone-test-key-1234567890';
const MODEL_SSE = [
  'data: {"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}',
  '',
  'data: {"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"，独立世界"}}]}',
  '',
  'data: {"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}',
  '',
  'data: [DONE]',
  ''
].join('\n');

/** DSH 完全不可达的 api fixture：任何 DSH 端点调用都失败（Standalone Chat 的前提）。 */
function dshDownApi() {
  return {
    calls: [],
    async callEndpoint(endpoint) {
      this.calls.push({ endpoint });
      throw new Error(`${endpoint}: 传输失败（ECONNREFUSED）`);
    },
    async *openRemoteStream() { await new Promise(() => {}); }
  };
}

function sseFetch(text = MODEL_SSE) {
  const requests = [];
  return {
    requests,
    async fetch(url, init = {}) {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  };
}

function abortableSseFetch() {
  let controller = null;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"长回答前半段"}}]}\n\n`));
    }
  });
  return {
    async fetch(url, init = {}) {
      init.signal?.addEventListener('abort', () => {
        try { controller.error(new Error('aborted')); } catch { /* 已结束 */ }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  };
}

/** 组装带 Model Runtime / Router / Agent 的完整 chat-service（全 fixture，不联网不碰 DSH）。 */
function makeFullService({ withKey = true, fetchImpl, baseUrl = 'https://api.deepseek.test', router = true, api = dshDownApi(), agent = false, agentProviderId = 'dsh', agentBoundary = 'unsupported', stateDir: overrideDir, buildProductContext, defaultModelConfig, onEvent, platformRoute, agentSendResult = null } = {}) {
  const dir = overrideDir ?? path.join(stateDir, 's1-' + (++caseSeq));
  fs.mkdirSync(dir, { recursive: true });
  const secrets = createProviderSecrets({ root: dir });
  if (withKey) secrets.set({ provider: 'deepseek-official', apiKey: API_KEY, baseUrl });
  const modelRuntime = createModelRuntimeService({
    registry: createModelProviderRegistry({
      providers: [
        createOpenAiCompatibleModelProvider({
          id: 'deepseek-official', label: 'DeepSeek 官方', baseUrl,
          defaultModel: 'deepseek-chat', secrets, fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : fetchImpl?.fetch ?? fetch,
          supportsStreamOptions: true, log: () => {}
        }),
        createOpenAiCompatibleModelProvider({
          id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.test/v1',
          defaultModel: 'gpt-4o-mini', secrets, fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : fetchImpl?.fetch ?? fetch,
          reasoningParam: 'reasoning_effort', log: () => {}
        })
      ]
    }),
    secrets
  });
  const routerService = router ? createRouterService({ stateDir: dir, log: () => {} }) : null;
  const agentCalls = [];
  const agentLabel = agentProviderId === 'dsh' ? 'DSH Agent' : `${agentProviderId} Agent`;
  const agentExecute = agent
    ? async ({ method, params }) => {
      agentCalls.push({ method, params });
      if (method === 'agent.createSession') return { sessionId: `agent-${agentCalls.length}` };
      if (method === 'agent.send' && agentSendResult) return typeof agentSendResult === 'function'
        ? agentSendResult(params) : agentSendResult;
      if (method === 'agent.list') return { providers: [{ id: agentProviderId, label: agentLabel, displayName: agentProviderId === 'dsh' ? 'DSH' : agentProviderId, available: true, workspaceBoundary: agentBoundary, health: { available: true } }] };
      return { ok: true };
    }
    : null;
  const service = createChatService({
    api,
    controlExecute: fixtureControl('throw'), // DSH 模型目录不可用：Model Runtime 目录不受影响
    agentProviders: agent ? [{ id: agentProviderId, label: agentLabel, eventProtocol: 'dsh-session-events', workspaceBoundary: agentBoundary }] : [],
    agentExecute,
    modelRuntime,
    router: routerService,
    buildProductContext,
    defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    defaultModelConfig,
    stateDir: dir,
    platformRoute,
    onEvent
  });
  return { service, api, fetchImpl, agentCalls, dir, secrets };
}

// ── 14d. Smart Managed Agent 长操作快速 ACK，取消 signal 贯穿 Provider 创建路径 ─
{
  let completeRoute;
  let routeSignal = null;
  const routeGate = new Promise(resolve => { completeRoute = resolve; });
  const { service, agentCalls } = makeFullService({
    fetchImpl: sseFetch(), agent: true, agentProviderId: 'cetamesh',
    platformRoute: request => { routeSignal = request.signal; return routeGate; }
  });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'cetamesh' } } });
  const sending = service.execute({ method: 'chat.send', params: { id: session.id, text: 'slow managed route' } });
  let settleTimer;
  const ackResult = await Promise.race([
    sending.then(value => ({ value })),
    new Promise(resolve => { settleTimer = setTimeout(() => resolve({ timeout: true }), 150); })
  ]);
  clearTimeout(settleTimer);
  if (ackResult.timeout) {
    completeRoute({ kind: 'agent', provider: 'cetamesh', sessionId: 'late-managed-session', taskId: 'task-late' });
    await sending;
    await service.execute({ method: 'chat.sessions.delete', params: { id: session.id } });
    service.close();
    assert.fail('long Managed Agent startup returned no quick acknowledgement');
  }
  assert.equal(ackResult.timeout, undefined, 'long Managed Agent startup returns before the provider finishes');
  assert.match(ackResult.value.requestId, /^cetamesh-chat-/);
  assert.ok(routeSignal instanceof AbortSignal, 'the active route receives a cancellation signal');
  const deleted = await service.execute({ method: 'chat.sessions.delete', params: { id: session.id } });
  assert.equal(deleted.deleted, true);
  assert.equal(routeSignal.aborted, true, 'deleting the Chat aborts the pending managed operation');
  completeRoute({ kind: 'agent', provider: 'cetamesh', sessionId: 'late-managed-session', taskId: 'task-late' });
  await waitFor(() => agentCalls, calls => calls.some(call => call.method === 'agent.cancel'
    && call.params.sessionId === 'late-managed-session'), 'late managed session cancellation');
  service.close();
  ok('Managed Agent route returns a requestId immediately and delete cancels late-created sessions');
}

// ── 12. Standalone Chat：DSH 完全不可达，仅凭 Model Provider Key 完成整回合 ────
{
  const f = sseFetch();
  const { service } = makeFullService({ fetchImpl: f, defaultModelConfig: () => ({ provider: 'deepseek-official', defaultModel: 'deepseek-flash' }) });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  assert.equal(session.config.modelProvider, 'deepseek-official');
  assert.equal(session.config.model, 'deepseek-flash');
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '验证默认模型' } });
  assert.equal(f.requests[0].body.model, 'deepseek-flash', '显式保存的模型即使与 DSH 默认同名也必须传给 Model Runtime');
  ok('新会话继承首次设置保存的默认 Provider 和 Model');
  service.close();
}

{
  const f = sseFetch();
  const { service, api } = makeFullService({ fetchImpl: f });
  const session = await service.execute({ method: 'chat.sessions.create', params: { title: '独立聊天' } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '你好，不启动 DSH 试试' } });
  // v2 hardening：send 在首个流事件后返回（握手），等回合落定再断言（同真实 UI 轮询）。
  let status = null;
  for (let i = 0; i < 200; i += 1) {
    status = await service.execute({ method: 'chat.status', params: { id: session.id } });
    if (!status.turn) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status.turn, null);
  assert.equal(status.lastState, 'idle');
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[1].text, '你好，独立世界');
  assert.deepEqual(history.messages[1].usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }, '真实 usage 透传');
  assert.equal(api.calls.length, 0, 'DSH 零调用（未启动 DSH 也能完成 Chat）');
  assert.ok(!JSON.stringify(history).includes(API_KEY), 'API Key 不进入 Chat 历史');
  assert.equal(f.requests[0].body.model, 'deepseek-chat', 'DSH 缺省模型不外发，用 Provider 默认模型');
  assert.equal(f.requests[0].body.messages.at(-1).content, '你好，不启动 DSH 试试');
  ok('Standalone Chat：无 DSH → 配 Key → 发送 → 流式 → usage → 历史（DSH 零调用，Key 不落历史）');
  service.close();
}

// ── 13. Model 通道：停止（abort → cancelled partial）→ retry ─────────────────
{
  const f = abortableSseFetch();
  const { service } = makeFullService({ fetchImpl: f });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  const pending = service.execute({ method: 'chat.send', params: { id: session.id, text: '写一篇长文' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const streaming = await service.execute({ method: 'chat.status', params: { id: session.id } });
  assert.equal(streaming.turn.state, 'streaming');
  assert.equal(streaming.turn.displayText, '长回答前半段');
  const stopped = await service.execute({ method: 'chat.stop', params: { id: session.id } });
  assert.equal(stopped.stopped, true);
  await pending;
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].cancelled, true, '取消的 partial 保留并标记');
  assert.equal(history.messages[1].text, '长回答前半段');
  assert.equal(history.messages.length, 2);
  ok('Model 通道停止：abort → cancelled → partial 落盘');
  service.close();
}

// ── 14. Agent=DSH 显式选择：整回合走 Agent Provider，不走 Model Runtime ────────
{
  const f = sseFetch();
  const uiEvents = [];
  const { service, agentCalls } = makeFullService({ fetchImpl: f, agent: true, onEvent: event => uiEvents.push(event) });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'dsh' } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '走 DSH Agent' } });
  const running = await service.execute({ method: 'chat.status', params: { id: session.id } });
  assert.deepEqual(running.turn.agentActivity, { providerId: 'dsh', label: 'DSH Agent', status: 'running' }, 'the selected Agent is visible immediately while its turn runs');
  assert.ok(uiEvents.some(event => event.event === 'chat.streaming' && event.data.agentActivity?.providerId === 'dsh'), 'stream events carry the running Agent card');
  // DSH Agent 事件经 _injectEvent 注入（与真实 follow 流等价）。
  service._injectEvent(session.id, { type: 'turn/start', data: {} });
  service._injectEvent(session.id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DSH Agent 回答' }] } } });
  service._injectEvent(session.id, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].text, 'DSH Agent 回答', 'Agent Provider 路径回答落盘');
  assert.ok(agentCalls.some((c) => c.method === 'agent.createSession' && c.params.provider === 'dsh'));
  assert.ok(agentCalls.some((c) => c.method === 'agent.send'));
  assert.equal(f.requests.length, 0, '显式 Agent 时不请求 Model Provider');
  await assert.rejects(
    service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'nope' } } }),
    (error) => error.code === 'INVALID_PARAMS'
  );
  ok('Agent=DSH：显式选择 → Agent 契约路径（Model Runtime 零请求）+ 未知 Agent 拒绝');
  service.close();
}

// ── 14c. Agent 切换关闭旧 Session、停止旧 Follow，并新建目标 Provider Session ─
{
  const calls = [];
  const createdAgentSessionIds = [];
  const followRows = [];
  const service = createChatService({
    agentProviders: [
      { id: 'dsh', label: 'DSH Agent', eventProtocol: 'dsh-session-events', workspaceBoundary: 'unsupported' },
      { id: 'codex', label: 'Codex Agent', eventProtocol: 'agent-turn-events-v1', workspaceBoundary: 'unsupported' }
    ],
    agentExecute: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === 'agent.createSession') {
        const sessionId = `${params.provider}-session-${calls.length}`;
        createdAgentSessionIds.push({ provider: params.provider, sessionId });
        return { sessionId };
      }
      return { closed: true, accepted: true };
    },
    agentFollow: async function* (request) {
      followRows.push(request);
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    },
    defaults: {}, stateDir: path.join(stateDir, `agent-switch-${++caseSeq}`)
  });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'dsh' } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'first provider' } });
  service._injectEvent(session.id, { type: 'turn/start', data: {} });
  service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }),
    value => !value.turn, 'first Agent ACK and buffered end');
  for (let i = 0; i < 20 && !followRows.length; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  const oldSessionId = createdAgentSessionIds[0].sessionId;
  const switched = await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'codex' } } });
  assert.equal(switched.config.agentProvider, 'codex');
  assert.equal(switched.dshSessionId, null, 'switching Agent clears the old provider session identity');
  assert.equal(followRows[0].signal.aborted, true, 'switching Agent aborts the old follow stream');
  for (let attempt = 0; attempt < 20 && !calls.some(call => call.method === 'agent.closeSession'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(calls.some(call => call.method === 'agent.closeSession' && call.params.sessionId === oldSessionId && call.params.provider === 'dsh'),
    `the previous Agent session is closed through its own provider: ${JSON.stringify({ oldSessionId, calls })}`);
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'second provider' } });
  assert.ok(calls.some(call => call.method === 'agent.createSession' && call.params.provider === 'codex'),
    'the next message immediately creates a Codex session');
  assert.ok(calls.some(call => call.method === 'agent.send' && call.params.provider === 'codex'));
  service.close();
  ok('切换 Agent：旧 Follow 中止、旧 Session 关闭、下一条消息新建目标 Provider Session');
}

// ── 14a. 自动 DSH Session 切换 Agent：无显式 Agent 选择也必须关闭旧会话 ─────
{
  const api = fixtureApi();
  const calls = [];
  let service = null;
  let session = null;
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  service = makeService({ api, options: {
    agentProviders: [
      { id: 'dsh', label: 'DSH Agent', eventProtocol: 'dsh-session-events', workspaceBoundary: 'unsupported' },
      { id: 'codex', label: 'Codex Agent', eventProtocol: 'agent-turn-events-v1', workspaceBoundary: 'unsupported' }
    ],
    agentExecute: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === 'agent.createSession') return { sessionId: `${params.provider}-next-session` };
      return { accepted: true, closed: true };
    }
  } });
  session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'automatic DSH route' } });
  for (let attempt = 0; attempt < 20 && !api.followSignals.length; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await service.execute({ method: 'chat.status', params: { id: session.id } })).lastState, 'idle');
  const oldDshId = 'dsh-1';
  const switched = await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'codex' } } });
  assert.equal(switched.dshSessionId, null);
  assert.equal(api.followSignals[0]?.aborted, true, 'switch aborts the automatic DSH Follow');
  for (let attempt = 0; attempt < 20 && !calls.some(call => call.method === 'agent.closeSession'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(calls.some(call => call.method === 'agent.closeSession' && call.params.provider === 'dsh' && call.params.sessionId === oldDshId),
    'an automatic DSH session is closed using its actual DSH provider identity');
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'switch target is Codex' } });
  assert.ok(calls.some(call => call.method === 'agent.createSession' && call.params.provider === 'codex'));
  service.close();
  ok('自动 DSH → Agent：旧 Follow 中止、旧 DSH Session 关闭、下一条消息使用目标 Agent');
}

// ── 14b. Managed Agent 的 Provider 选择绑定到会话并在下一回合生效 ────────────
{
  const { service, agentCalls } = makeFullService({ fetchImpl: sseFetch(), agent: true, agentProviderId: 'cetamesh' });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: {
    agentProvider: 'cetamesh', modelProvider: 'deepseek-official', model: 'deepseek-flash'
  } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'first Managed Agent turn' } });
  const created = agentCalls.find(call => call.method === 'agent.createSession');
  const agentSessionId = `agent-${agentCalls.indexOf(created) + 1}`;
  assert.equal(created.params.modelProvider, 'deepseek-official', 'Managed Agent session creation receives its selected Provider');
  service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  await waitFor(() => service.execute({ method: 'chat.status', params: { id: session.id } }),
    value => !value.turn, 'Managed Agent ACK and buffered end');
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { modelProvider: 'openai', model: 'gpt-4o-mini' } } });
  const selected = agentCalls.find(call => call.method === 'agent.selectModel');
  assert.equal(selected.params.sessionId, agentSessionId);
  assert.equal(selected.params.provider, 'cetamesh');
  assert.equal(selected.params.modelProvider, 'openai', 'Provider switch is applied to the existing Managed Agent session');
  assert.equal(selected.params.model, 'gpt-4o-mini');
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'next turn after Provider switch' } });
  assert.ok(agentCalls.some(call => call.method === 'agent.send' && call.params.sessionId === agentSessionId),
    'the next turn reuses the session whose Provider was just changed');
  service.close();
  ok('Managed Agent：创建时传 Provider，切换后立即更新现有 Session');
}

// ── 14c. Harbor UI event bus 投影 chat.warning 和 bounded message ─────────────
{
  const eventBus = createDesktopUiEventBus();
  const ui = createDesktopUiService({ eventBus });
  const warning = '旧 Agent 会话未能关闭；请检查原 Agent 连接。'.repeat(20);
  assert.equal(eventBus.publish('chat.warning', { sessionId: 'chat-warning-fixture', message: warning }), true);
  const result = await ui.execute({ method: 'ui.events.next', params: { after: 0, waitMs: 0 } });
  const delivered = result.events.find(event => event.event === 'chat.warning');
  assert.ok(delivered, 'Harbor receives the session warning event');
  assert.equal(delivered.data.sessionId, 'chat-warning-fixture');
  assert.equal(delivered.data.message, warning.slice(0, 200), 'warning message is projected with the standard bounded string limit');
  ok('Harbor UI event bus：chat.warning 与 bounded message 可订阅');
}

// ── 14b. Chat 与 Agents 使用同一健康状态，并保留未验证边界原因 ───────────────
{
  const { service } = makeFullService({ agent: true, agentBoundary: 'unverified' });
  const ui = createDesktopUiService({ services: { chatService: service } });
  const catalog = await ui.execute({ method: 'ui.chat.catalog', params: {} });
  const dsh = catalog.agentProviders.find(provider => provider.id === 'dsh');
  assert.equal(dsh.available, true, 'DSH health remains visible as available');
  assert.equal(dsh.eligible, false, 'unverified workspace boundary blocks execution');
  assert.equal(dsh.reason, 'descriptor-incomplete', 'Composer receives the same actionable state as Agents');
  service.close();
}

// ── 15. Smart 路由：project 产生 agent-intent（只记录不执行）；你好 → simple ───
{
  const f = sseFetch();
  const contextCalls = [];
  const { service } = makeFullService({
    fetchImpl: f,
    buildProductContext: async (request) => {
      contextCalls.push(request);
      return JSON.stringify({ marker: 'ephemeral-product-context', call: contextCalls.length });
    }
  });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { mode: 'smart' } } });
  // v2 hardening：Model 通道 send 在首个流事件后返回，回合落定后读历史（同真实 UI）。
  const waitForIdle = async (id) => {
    for (let i = 0; i < 200; i += 1) {
      const status = await service.execute({ method: 'chat.status', params: { id } });
      if (!status.turn) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '修改这个项目并跑测试' } });
  await waitForIdle(session.id);
  let history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  const routing = history.messages[1].routing;
  assert.equal(routing.class, 'project');
  assert.equal(routing.route, 'agent');
  assert.equal(routing.agentIntent, true);
  assert.equal(routing.resolvedRoute, 'model', 'v1 无 Agent Broker：意图记录，回合仍由 Model 执行');
  assert.equal(routing.fallbackReason, 'agent-broker-not-available');
  assert.equal(contextCalls.length, 1, 'Smart Router 完成后为 Model 回合解析 Context');
  assert.equal(contextCalls[0].routing.class, 'project');
  assert.equal(contextCalls[0].routing.resolvedRoute, 'model');
  assert.equal(contextCalls[0].record.taskId, null, 'Model fallback 不会创建 Task');
  const modelRequest = f.requests.find((request) => request.body?.messages?.some((message) => message.role === 'user'));
  assert.match(modelRequest.body.messages[0].content, /You are operating inside CetaMesh/);
  assert.match(modelRequest.body.messages[1].content, /ephemeral-product-context/);
  assert.equal(JSON.stringify(history).includes('ephemeral-product-context'), false, 'Product Context 不落入 Chat 历史');
  assert.equal(routing.costPolicy, 'balanced');
  assert.equal(history.messages[1].text, '你好，独立世界', '回合适配完成');
  // 普通聊天 → simple → model，无 agent 意图
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '你好' } });
  await waitForIdle(session.id);
  history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  const simple = history.messages[3].routing;
  assert.equal(contextCalls.length, 2);
  assert.equal(contextCalls[1].routing.class, 'simple');
  assert.equal(simple.class, 'simple');
  assert.equal(simple.agentIntent, false);
  assert.equal(simple.fallbackReason, null);
  // Agent=Disabled：即使工程任务也不产生 agent 意图
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'none' } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '重构整个仓库' } });
  await waitForIdle(session.id);
  history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  const disabled = history.messages[5].routing;
  assert.equal(disabled.class, 'project');
  assert.equal(disabled.agentIntent, false);
  assert.equal(disabled.route, 'model');
  assert.equal(disabled.agentEnabled, false);
  ok('Smart 路由：project→agent-intent 记录/你好→simple/Disabled 不产生意图');
  service.close();
}

// ── 16. Model Provider 配置：无 Key 的自动路径明确使用 DSH，显式缺 Key 报错 ──
{
  const f = sseFetch();
  const { service } = makeFullService({ withKey: false, fetchImpl: f });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  // Automatic selection falls back to the existing DSH route only when no Model Provider is configured.
  const fallbackAck = await service.execute({ method: 'chat.send', params: { id: session.id, text: '没有 Key' } });
  assert.ok(fallbackAck.requestId, 'long DSH fallback acknowledges promptly with a requestId');
  const fallbackStatus = await waitFor(
    () => service.execute({ method: 'chat.status', params: { id: session.id } }),
    value => !value.turn && value.lastState === 'error', 'DSH fallback terminal error'
  );
  assert.equal(fallbackStatus.lastErrorCode, 'DSH_UNAVAILABLE');
  assert.match(fallbackStatus.lastError, /DSH/, 'missing-key fallback failure stays visible after the fast ACK');
  // 显式指定 openai（未配 Key）→ KEY_MISSING 明确指向设置页
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { modelProvider: 'openai' } } });
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: session.id, text: 'OpenAI 没有 Key' } }),
    (error) => error.code === 'MODEL_PROVIDER_KEY_MISSING' && /设置 → 模型/.test(error.message)
  );
  assert.equal((await service.execute({ method: 'chat.status', params: { id: session.id } })).lastState, 'awaiting-reply', '失败回合保留可重试');
  await assert.rejects(
    service.execute({ method: 'chat.config.set', params: { id: session.id, config: { modelProvider: 'nope' } } }),
    (error) => error.code === 'INVALID_PARAMS'
  );
  ok('Provider 配置：自动路径仅在无 Model Key 时尝试 DSH / 显式缺 Key 报错 / 非法 Provider 拒绝');
  service.close();
}

// ── 16b. Model Provider 切换：下一条消息立即使用新的 Provider 和 Model ────────
{
  const f = sseFetch();
  const { service, secrets } = makeFullService({ fetchImpl: f });
  secrets.set({ provider: 'openai', apiKey: API_KEY });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: {
    id: session.id, config: { modelProvider: 'openai', model: 'gpt-4.1-mini' }
  } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'use the selected OpenAI model now' } });
  const waitForIdle = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!(await service.execute({ method: 'chat.status', params: { id: session.id } })).turn) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('selected OpenAI turn did not finish');
  };
  await waitForIdle();
  assert.equal(f.requests[0].url, 'https://api.openai.test/v1/chat/completions');
  assert.equal(f.requests[0].body.model, 'gpt-4.1-mini');
  assert.equal((await service.execute({ method: 'chat.sessions.list', params: {} })).sessions[0].config.modelProvider, 'openai');
  ok('Provider/Model 选择立即进入下一回合的真实请求');
  service.close();
}

// ── 16c. DSH → Model Runtime Provider handover：停止 Follow、关闭 Session、隔离迟到事件 ─
{
  const apiCalls = [];
  let onPrompt = null;
  let oldFollowSignal = null;
  let releaseOldFollow = null;
  let markFollowStarted = null;
  const followStarted = new Promise(resolve => { markFollowStarted = resolve; });
  const api = {
    calls: apiCalls,
    async callEndpoint(endpoint, args = {}) {
      apiCalls.push({ endpoint, args });
      if (endpoint === 'session/create') return { sessionId: 'dsh-handoff-session' };
      if (endpoint === 'session/selectModel') return {};
      if (endpoint === 'session/prompt') { await onPrompt?.(); return { accepted: true }; }
      if (endpoint === 'workspace/archiveSession') return { closed: true };
      throw new Error(`unexpected endpoint: ${endpoint}`);
    },
    async *openRemoteStream(_endpoint, _args, { signal } = {}) {
      oldFollowSignal = signal;
      markFollowStarted();
      await new Promise(resolve => { releaseOldFollow = resolve; });
      // 代表 stop/abort 竞争窗口中已排队的旧 DSH 事件。
      yield { type: 'event', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'STALE DSH' } } } };
    }
  };
  let modelStreamController = null;
  const modelFetch = async () => new Response(new ReadableStream({
    start(controller) {
      modelStreamController = controller;
      controller.enqueue(new TextEncoder().encode('data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"MODEL"}}]}\n\n'));
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { service, secrets } = makeFullService({ withKey: false, fetchImpl: modelFetch, api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  onPrompt = async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, 'DSH first answer'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  };
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'start on DSH' } });
  await followStarted;
  secrets.set({ provider: 'openai', apiKey: API_KEY });
  const switched = await service.execute({ method: 'chat.config.set', params: {
    id: session.id, config: { modelProvider: 'openai', model: 'gpt-4o-mini' }
  } });
  assert.equal(switched.dshSessionId, null, 'provider-only channel change clears the prior DSH session');
  assert.equal(oldFollowSignal.aborted, true, 'provider handover stops the previous DSH Follow');
  for (let attempt = 0; attempt < 20 && !apiCalls.some(call => call.endpoint === 'workspace/archiveSession'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(apiCalls.some(call => call.endpoint === 'workspace/archiveSession' && call.args.request.sessionId === 'dsh-handoff-session'),
    'handover closes the abandoned DSH session');
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'use the selected Model Provider' } });
  releaseOldFollow();
  await new Promise(resolve => setTimeout(resolve, 20));
  const streaming = await service.execute({ method: 'chat.status', params: { id: session.id } });
  assert.equal(streaming.turn.displayText, 'MODEL', 'late DSH events cannot be appended to the new Model Runtime turn');
  modelStreamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  modelStreamController.close();
  for (let attempt = 0; attempt < 100 && (await service.execute({ method: 'chat.status', params: { id: session.id } })).turn; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).text, 'MODEL');
  service.close();
  ok('DSH → Model Runtime：Provider-only handover 关闭旧 Session/Follow，迟到事件不污染新回合');
}

// ── 17. catalog：Model Runtime 目录与 DSH 目录并存，无 Key 材料 ────────────────
{
  const f = sseFetch();
  const { service } = makeFullService({ fetchImpl: f });
  const catalog = await service.execute({ method: 'chat.catalog', params: {} });
  assert.match(catalog.error, /ECONNREFUSED/, 'DSH 目录不可用如实上报');
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.defaultModelProvider, 'deepseek-official');
  const deepseek = catalog.modelProviders.find((p) => p.id === 'deepseek-official');
  const openai = catalog.modelProviders.find((p) => p.id === 'openai');
  assert.equal(deepseek.hasKey, true);
  assert.equal(deepseek.catalogState, 'loaded');
  assert.equal(deepseek.inferencing, null, 'a successful catalog request does not claim the selected model has generated a response');
  assert.deepEqual(deepseek.models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(openai.hasKey, false, '未配 Key 的 Provider 如实标记');
  assert.deepEqual(openai.models, []);
  assert.ok(!JSON.stringify(catalog).includes(API_KEY), 'catalog 不含 Key 材料');
  ok('catalog：DSH 目录错误不阻塞 Model 目录 / hasKey 标记 / 无 Key 泄漏');
  service.close();
}

// ── 17a. 外部模型目录独立于 DSH 状态，并缓存且并行刷新 ─────────────────────
{
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async url => {
    calls.push(String(url));
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    const model = String(url).includes('api.openai.test') ? 'gpt-4o-mini' : 'deepseek-flash';
    return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { service, secrets } = makeFullService({ fetchImpl });
  secrets.set({ provider: 'openai', apiKey: 'sk-openai-12345678' });
  const first = await service.execute({ method: 'chat.catalog', params: {} });
  assert.equal(maxActive, 2, 'configured provider catalogs are requested concurrently');
  assert.deepEqual(first.modelProviders.map(provider => provider.catalogState), ['loaded', 'loaded']);
  assert.ok(first.error, 'DSH catalog error remains observable independently');
  const projected = await createDesktopUiService({ services: { chatService: service } }).execute({ method: 'ui.chat.catalog', params: {} });
  assert.equal(projected.available, false, 'the legacy available field describes DSH catalog only');
  assert.equal(projected.modelProviders[0].catalogState, 'loaded', 'DSH failure does not mark the independent Model catalog unavailable');
  assert.equal(projected.modelProviders[0].inferencing, null);
  const afterFirst = calls.length;
  await service.execute({ method: 'chat.catalog', params: {} });
  assert.equal(calls.length, afterFirst, 'normal catalog reads use the short-lived cache');
  await service.execute({ method: 'chat.catalog', params: { refresh: true } });
  assert.equal(calls.length, afterFirst + 2, 'explicit refresh bypasses the cache');
  service.close();
  ok('Model catalog state is separate from DSH; cached reads and explicit refresh use bounded parallel providers');
}

// ── 18. Provider 失败经 UI 投影可恢复，重试复用同一条 user 消息 ────────────────
{
  const text = 'Provider 暂时失败后的提问';
  const fixture = createOpenAiCompatibleFixture({ responses: [
    { kind: 'http-error', status: 503, body: { error: { message: `temporary ${API_KEY}` } } },
    { kind: 'sse', chunks: [
      'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"重试"}}]}\n\n',
      'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"成功"}}]}\n\n',
      'data: [DONE]\n\n'
    ] }
  ] });
  const eventBus = createDesktopUiEventBus();
  let service = null;
  try {
    service = makeFullService({
      fetchImpl: fixture.fetchImpl,
      baseUrl: OPENAI_COMPATIBLE_FIXTURE_BASE_URL,
      onEvent: event => eventBus.publish(event.event, event.data)
    }).service;
    const ui = createDesktopUiService({ services: { chatService: service }, eventBus });
    const session = await ui.execute({ method: 'ui.chat.sessions.create', params: { title: 'Provider retry' } });
    await assert.rejects(
      ui.execute({ method: 'ui.chat.send', params: { id: session.id, text } }),
      error => error.code === 'MODEL_PROVIDER_ERROR' && !error.message.includes(API_KEY)
    );
    const failedHistory = await ui.execute({ method: 'ui.chat.history', params: { id: session.id } });
    assert.equal(failedHistory.messages.length, 2, 'Provider 首次失败仍投影 user 和结构化错误回复');
    assert.equal(failedHistory.messages[0].role, 'user');
    assert.equal(failedHistory.messages[1].error.includes(API_KEY), false, '错误投影不得泄漏 Provider Key');
    const failedStatus = await ui.execute({ method: 'ui.chat.status', params: { id: session.id } });
    assert.ok(failedStatus.error, 'Harbor status projection exposes a retryable Provider error after the turn closes');
    assert.ok(!failedStatus.error.includes(API_KEY), 'status error is secret-free');
    const updates = await eventBus.next({ after: 0, waitMs: 0 });
    assert.ok(updates.events.some(event => event.event === 'chat.updated'), '首事件前失败也通知 Harbor 刷新会话');

    const retry = await ui.execute({ method: 'ui.chat.retry', params: { id: session.id } });
    assert.equal(retry.userMessageId, failedHistory.messages[0].id, 'retry 沿用原 user 消息 ID');
    for (let i = 0; i < 100; i += 1) {
      const status = await ui.execute({ method: 'ui.chat.status', params: { id: session.id } });
      if (status.state === 'idle') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const history = await ui.execute({ method: 'ui.chat.history', params: { id: session.id } });
    assert.equal(history.messages.filter(message => message.role === 'user').length, 1, '重试不能重复落盘 user 消息');
    assert.equal(history.messages.at(-1).text, '重试成功');
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests.map(request => request.url), [
      `${OPENAI_COMPATIBLE_FIXTURE_BASE_URL}/chat/completions`,
      `${OPENAI_COMPATIBLE_FIXTURE_BASE_URL}/chat/completions`
    ]);
    assert.deepEqual(
      fixture.requests[1].body.messages.filter(message => message.role === 'user').map(message => message.content),
      [text],
      'Provider retry request contains the prompt exactly once'
    );
    assert.ok(!JSON.stringify({ failedHistory, history, requests: fixture.requests }).includes(API_KEY));
    ok('Provider error → UI event/history projection → retry → one user message + streamed answer');
  } finally {
    service?.close();
    fixture.close();
  }
}

// ── 19. 历史分页：exclusive cursor / chronological order / bounded limits ───
{
  const service = makeService();
  const ui = createDesktopUiService({ services: { chatService: service } });
  const seedHistory = async (count) => {
    const session = await service.execute({ method: 'chat.sessions.create', params: { title: `history-${count}` } });
    const messages = Array.from({ length: count }, (_, index) => ({
      id: `history-${String(index).padStart(3, '0')}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message-${index}`,
      at: index,
      attachments: []
    }));
    writeJsonAtomic(path.join(service._store.historyDir, `${session.id}.json`), { schemaVersion: 1, messages });
    return { session, messages };
  };

  const emptySession = await service.execute({ method: 'chat.sessions.create', params: { title: 'empty-history' } });
  assert.deepEqual(await service.execute({ method: 'chat.history', params: { id: emptySession.id } }), {
    id: emptySession.id, total: 0, messages: [], nextBeforeMessageId: null, hasMore: false
  });

  for (const count of [100, 200, 500]) {
    const { session, messages } = await seedHistory(count);
    const defaultPage = await service.execute({ method: 'chat.history', params: { id: session.id } });
    assert.equal(defaultPage.total, count);
    assert.equal(defaultPage.messages.length, Math.min(count, 100), `${count}-message default page is 100 or less`);
    const first = await service.execute({ method: 'chat.history', params: { id: session.id, limit: 200 } });
    assert.equal(first.messages.length, Math.min(count, 200), `${count}-message page obeys 200 cap`);
    assert.deepEqual(first.messages.map(message => message.id), messages.slice(-Math.min(count, 200)).map(message => message.id));
    assert.equal(first.hasMore, count > 200);
    assert.equal(first.nextBeforeMessageId, count > 200 ? messages[count - 200].id : null);

    if (count === 500) {
      const loaded = first.messages.map(message => message.id);
      const seen = new Set(loaded);
      let cursor = first.nextBeforeMessageId;
      while (cursor) {
        const older = await service.execute({ method: 'chat.history', params: { id: session.id, limit: 200, beforeMessageId: cursor } });
        for (const item of older.messages) {
          assert.equal(seen.has(item.id), false, `cursor page must not overlap ${item.id}`);
          seen.add(item.id);
        }
        loaded.unshift(...older.messages.map(message => message.id));
        cursor = older.nextBeforeMessageId;
        assert.equal(older.hasMore, Boolean(cursor));
      }
      assert.deepEqual(loaded, messages.map(message => message.id), 'all pages remain chronological with no gaps or duplicates');
      const uiPage = await ui.execute({ method: 'ui.chat.history', params: { id: session.id, limit: 10, beforeMessageId: 'history-490' } });
      assert.deepEqual([uiPage.messages[0]?.id, uiPage.messages.at(-1)?.id, uiPage.nextBeforeMessageId, uiPage.hasMore],
        ['history-480', 'history-489', 'history-480', true], 'typed UI projection carries the exclusive cursor page contract');

      const limits = [[0, 1], [-1, 1], [201, 200], [NaN, 100]];
      for (const [limit, expected] of limits) {
        const page = await service.execute({ method: 'chat.history', params: { id: session.id, limit } });
        assert.equal(page.messages.length, expected, `limit ${String(limit)} clamps or falls back safely`);
        assert.equal(page.total, 500);
      }
      await assert.rejects(
        service.execute({ method: 'chat.history', params: { id: session.id, beforeMessageId: 'missing-message' } }),
        error => error.code === 'INVALID_CURSOR'
      );
    }
  }
  ok('历史分页：100/200/500 消息、exclusive cursor、顺序/无重叠、未知 cursor 与边界 limit');
  service.close();
}

// Phase 3: a Task-bound Chat switches its Agent only through a completed Continuity handoff.
{
  const dir = path.join(stateDir, 'phase3-chat-handoff');
  const initial = makeService({ stateDir: dir });
  const created = await initial.execute({ method: 'chat.sessions.create', params: {} });
  initial.close();
  const file = path.join(dir, 'desktop-chat', 'sessions.json');
  const saved = readJsonFile(file);
  const row = saved.sessions.find(item => item.id === created.id);
  row.taskId = 'task-chat-handoff';
  row.dshSessionId = 'dsh-old';
  row.runtimeProvider = 'dsh';
  row.config.agentProvider = 'dsh';
  row.config.workspaceId = 'ws-chat-handoff';
  writeJsonAtomic(file, saved);
  const api = fixtureApi();
  let shouldFail = true;
  const handoffs = [];
  const service = makeService({ stateDir: dir, api, options: {
    agentProviders: [
      { id: 'dsh', eventProtocol: 'dsh-session-events', workspaceBoundary: 'capability-broker' },
      { id: 'codex', eventProtocol: 'dsh-session-events', workspaceBoundary: 'capability-broker' }
    ],
    resolveTask: () => ({ id: 'task-chat-handoff', workspaceId: 'ws-chat-handoff',
      currentAgent: { provider: 'dsh', sessionId: 'dsh-old' } }),
    handoffTask: async request => {
      handoffs.push(request);
      if (shouldFail) throw Object.assign(new Error('target unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
      return { to: { provider: 'codex', sessionId: 'codex-new' } };
    },
    agentFollow: async function* ({ signal }) {
      await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
    }
  } });
  await assert.rejects(service.execute({ method: 'chat.config.set', params: { id: created.id,
    config: { agentProvider: 'codex' } } }), error => error.code === 'PROVIDER_UNAVAILABLE');
  let retained = (await service.execute({ method: 'chat.sessions.list', params: {} })).sessions[0];
  assert.equal(retained.config.agentProvider, 'dsh');
  assert.equal(api.calls.some(call => call.endpoint === 'workspace/archiveSession'), false);
  shouldFail = false;
  const switched = await service.execute({ method: 'chat.config.set', params: { id: created.id,
    config: { agentProvider: 'codex' } } });
  assert.equal(switched.taskId, 'task-chat-handoff');
  assert.equal(switched.dshSessionId, 'codex-new');
  assert.equal(handoffs.length, 2);
  assert.equal(api.calls.some(call => call.endpoint === 'workspace/archiveSession'), false,
    'Chat cannot close the old Task Agent before Continuity confirms the transfer');
  service.close();
  ok('Task-bound Chat Agent switch preserves old state on failure and uses Continuity on success');
}

{
  const recoveryDir = path.join(stateDir, 'non-task-recovery');
  const api = fixtureApi();
  const original = makeService({ stateDir: recoveryDir, api });
  const session = await original.execute({ method: 'chat.sessions.create', params: {} });
  original.close();
  const sessionsPath = original._store.sessionsFile;
  const saved = readJsonFile(sessionsPath);
  saved.sessions[0].dshSessionId = 'stale-after-core-restart';
  writeJsonAtomic(sessionsPath, saved);
  writeJsonAtomic(path.join(original._store.historyDir, `${session.id}.json`), {
    schemaVersion: 1,
    messages: [{ id: 'previous-owner-request', role: 'user', text: 'Analyze the saved project state', at: Date.now() }]
  });
  const recovered = makeService({ stateDir: recoveryDir, api });
  const status = await recovered.execute({ method: 'chat.status', params: { id: session.id } });
  assert.equal(status.lastState, 'interrupted');
  assert.equal(status.dshSessionAlive, false);
  await recovered.execute({ method: 'chat.continue', params: { id: session.id } });
  const prompt = await waitFor(() => api.calls.find(call => call.endpoint === 'session/prompt')?.args.request.content[0].text,
    value => typeof value === 'string', 'non-Task restart recovery prompt');
  assert.match(prompt, /Analyze the saved project state/);
  assert.match(prompt, /verify|核对/i);
  assert.notEqual(prompt, '继续');
  recovered.close();
  ok('non-Task Chat restart recovery sends bounded prior context rather than a bare continue');
}

// Native Codex/DSH turn IDs are distinct from Chat's UI request ID. The
// accepted provider identity must select one turn and reject stale output.
for (const provider of ['codex', 'dsh']) {
  const nativeTurn = `${provider}-current-native-turn`;
  const { service, agentCalls } = makeFullService({ agent: true, agentProviderId: provider,
    agentSendResult: provider === 'codex'
      ? { accepted: true, turnId: nativeTurn }
      : { accepted: true, requestId: `${provider}-provider-request` } });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: provider } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'analyze this task' } });
  await waitFor(() => agentCalls.some(call => call.method === 'agent.send'), value => value, `${provider} send`);
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  const inject = (type, turn, data = {}) => service._injectEvent(session.id, { type, data: { turn, ...data } });
  inject('assistant/message', `${provider}-old-turn`, { message: { content: [{ type: 'text', text: 'STALE' }] } });
  inject('turn/end', `${provider}-old-turn`, { reason: { kind: 'completed' } });
  assert.ok((await service.execute({ method: 'chat.status', params: { id: session.id } })).turn,
    `${provider} old turn must not finish the active Chat turn`);
  inject('turn/start', nativeTurn);
  inject('assistant/message', nativeTurn, { message: { content: [{ type: 'text', text: 'CURRENT' }] } });
  inject('turn/end', nativeTurn, { reason: { kind: 'completed' } });
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).text, 'CURRENT', `${provider} native turn must be correlated without stale output`);
  service.close();
}
ok('Codex and DSH native turn identities reject stale events and finish the accepted turn');

{
  let accept;
  const pendingAck = new Promise(resolve => { accept = resolve; });
  const turnId = 'codex-fast-native-turn';
  const { service, agentCalls } = makeFullService({ agent: true, agentProviderId: 'codex',
    agentSendResult: () => pendingAck });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'codex' } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'fast native response' } });
  await waitFor(() => agentCalls.some(call => call.method === 'agent.send'), value => value, 'Codex pending ACK');
  service._injectEvent(session.id, { type: 'turn/start', data: { turn: 'codex-old-native-turn' } });
  service._injectEvent(session.id, { type: 'turn/end', data: { turn: 'codex-old-native-turn', reason: { kind: 'completed' } } });
  assert.ok((await service.execute({ method: 'chat.status', params: { id: session.id } })).turn,
    'old native turn must not finish Chat before the accepted ACK identifies the new turn');
  service._injectEvent(session.id, { type: 'turn/start', data: { turn: turnId } });
  service._injectEvent(session.id, { type: 'assistant/message', data: { turn: turnId,
    message: { content: [{ type: 'text', text: 'FAST CURRENT' }] } } });
  service._injectEvent(session.id, { type: 'turn/end', data: { turn: turnId, reason: { kind: 'completed' } } });
  accept({ accepted: true, turnId });
  await waitFor(() => service.execute({ method: 'chat.history', params: { id: session.id } }),
    value => value.messages.at(-1)?.text === 'FAST CURRENT', 'Codex ACK-before-event replay');
  service.close();
}
ok('Agent events arriving before send ACK are replayed only after provider identity is known');

// Remote cancellation acknowledgement is not proof that its approval stopped.
{
  const { service, agentCalls } = makeFullService({ agent: true, agentProviderId: 'dsh' });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'dsh' } } });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: 'controlled remote approval' } });
  await waitFor(() => agentCalls.some(call => call.method === 'agent.send'), Boolean, 'remote send acknowledgement');
  await new Promise(resolve => setTimeout(resolve, 20));
  service._injectEvent(session.id, { type: 'tool/activity', data: { activity: { id: 'remote-write', status: 'waiting-approval', label: 'remote write' } } });
  service._injectEvent(session.id, { type: 'turn/end', data: { reason: { kind: 'waiting', approvalId: 'remote-approval' } } });
  await service.execute({ method: 'chat.stop', params: { id: session.id } });
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).toolActivity[0].status, 'waiting-approval', 'remote cancel ACK must not fabricate confirmed tool cancellation');
  assert.ok(agentCalls.some(call => call.method === 'agent.cancel'));
  service.close();
  ok('Remote cancel request preserves unconfirmed tool state');
}


// A rejected Workspace writer must end the Agent card and retain a review target.
{
 const {service}=makeFullService({agent:true,agentProviderId:'codex',agentBoundary:'staged-capability-broker',
  platformRoute:async()=>{throw Object.assign(new Error('Workspace writer requires review'),{code:'TASK_WORKSPACE_BUSY',blockingTaskId:'task-blocking-owner'});}});
 const session=await service.execute({method:'chat.sessions.create',params:{}});
 await service.execute({method:'chat.config.set',params:{id:session.id,config:{agentProvider:'codex'}}});
 await service.execute({method:'chat.send',params:{id:session.id,text:'hello'}});
 const h=await waitFor(()=>service.execute({method:'chat.history',params:{id:session.id}}),x=>x.messages.at(-1)?.errorCode==='TASK_WORKSPACE_BUSY','Workspace conflict terminal history');
 assert.equal(h.messages.at(-1).agentActivity.status,'failed','rejected startup must not leave a running Agent card');
 assert.equal(h.messages.at(-1).routing.blockingTaskId,'task-blocking-owner');
 const status=await service.execute({method:'chat.status',params:{id:session.id}});
 assert.equal(status.lastRouting.blockingTaskId,'task-blocking-owner','review target survives idle status refresh');
 service.close();ok('Workspace rejection finalizes Agent card and preserves blocking Task review target');
}


// Read compatibility for failed history already saved by an older build.
{
 const stale={id:'old-failed',role:'assistant',text:'',error:'Workspace writer requires review',agentActivity:{providerId:'codex',label:'Codex',status:'running'}};
 const ui=createDesktopUiService({services:{chatService:{execute:async()=>({id:'legacy-fixture',messages:[stale]})}}});
 const projected=await ui.execute({method:'ui.chat.history',params:{id:'legacy-fixture'}});
 assert.equal(projected.messages[0].agentActivity.status,'failed','old terminal error must never project a running badge');
 assert.equal(stale.agentActivity.status,'running','projection must not mutate legacy persisted data');
 ok('Legacy failed Agent history is displayed as terminal without rewriting data');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 阶段 03 Chat 运行时全部通过（${step} 组）`);
