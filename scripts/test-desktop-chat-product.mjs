// 阶段 03 验收：产品级 Desktop Chat 运行时（src/desktop/chat-service.js）。
// fixture DSH（可控注入 follow 事件）+ 隔离临时 stateDir，不触碰真实 DSH / 用户数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiEventBus, createDesktopUiService } from '../src/desktop/ui-service.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'chat-product-test-'));
const stateDir = path.join(temp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

/** 可控 DSH fixture：callEndpoint 记录调用；follow 流由 _injectEvent 驱动。 */
function fixtureApi() {
  const calls = [];
  let promptHandler = null;
  let failEndpoints = null; // Set<endpoint>：命中即抛 ECONNREFUSED
  return {
    calls,
    setPromptHandler: (fn) => { promptHandler = fn; },
    fail: (endpoints) => { failEndpoints = new Set(endpoints); },
    async callEndpoint(endpoint, args = {}) {
      calls.push({ endpoint, args });
      if (failEndpoints?.has(endpoint)) {
        throw new Error(`${endpoint}: 传输失败（ECONNREFUSED）`);
      }
      if (endpoint === 'session/create') {
        return { sessionId: `dsh-${calls.filter((c) => c.endpoint === 'session/create').length}` };
      }
      if (endpoint === 'session/selectModel') return {};
      if (endpoint === 'session/prompt') {
        await promptHandler?.(args.request.sessionId, args.request.content);
        return { accepted: true };
      }
      if (endpoint === 'session/cancel') return {};
      throw new Error(`unexpected endpoint: ${endpoint}`);
    },
    // follow 流永不产出；事件统一经 _injectEvent 注入（abort 后进程退出即清理）。
    async *openRemoteStream() { await new Promise(() => {}); }
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
  const final = await service.execute({ method: 'chat.status', params: { id: session.id } });
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
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].usage, null, '无 usage 数据时必须为 null（未知），不得伪造');
  ok('usage 未知时为 null（不伪造）');
  service.close();
}

// ── 4. 停止：cancel → cancelled → partial 保留 + DSH 会话丢弃 ────────────────
{
  const api = fixtureApi();
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, chunk(session.id, '长回答的前半段'));
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '写一篇长文' } });
  const streaming = await service.execute({ method: 'chat.status', params: { id: session.id } });
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
  const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'case-4', 'desktop-chat', 'sessions.json'), 'utf8'));
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
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: session.id, text: 'DSH 关了' } }),
    (error) => error.code === 'PROVIDER_ERROR' && /ECONNREFUSED/.test(error.message)
  );
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].role, 'user');
  assert.equal((await service.execute({ method: 'chat.status', params: { id: session.id } })).lastState, 'awaiting-reply', '尾部 user 消息 → awaiting-reply（可重试）');
  // DSH 恢复后 retry 成功：不重复 user 消息
  api.fail(null);
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, '恢复后的回答'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  await service.execute({ method: 'chat.retry', params: { id: session.id } });
  const history2 = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history2.messages.length, 2, 'retry 不重复 user 消息');
  assert.equal(history2.messages[1].text, '恢复后的回答');
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
  await assert.rejects(
    service.execute({ method: 'chat.config.set', params: { id: session.id, config: { reasoning: 'ultra' } } }),
    (error) => error.code === 'INVALID_PARAMS'
  );
  ok('切换模型/reasoning/mode：即时 selectModel + 持久化 + 参数校验');
  service.close();
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
  const service = makeService({ api });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  let releasePrompt;
  const gate = new Promise((resolve) => { releasePrompt = resolve; });
  api.setPromptHandler(async () => { await gate; });
  const pending = service.execute({ method: 'chat.send', params: { id: session.id, text: '慢回合' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: session.id, text: '并发' } }),
    (error) => error.code === 'TURN_BUSY'
  );
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
  const history = await service.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages[1].error, '模型服务中断');
  assert.equal(history.messages[1].text, '部分输出', 'error 回合的 partial 保留');
  assert.equal((await service.execute({ method: 'chat.status', params: { id: session.id } })).lastState, 'idle', 'error 已终态化');
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: {} });
    service._injectEvent(session.id, message(session.id, '重试后的回答'));
    service._injectEvent(session.id, turnEnd(session.id, 'completed'));
  });
  const retry = await service.execute({ method: 'chat.retry', params: { id: session.id } });
  assert.equal(retry.userMessageId, history.messages[0].id, '失败回合重试复用原 user 消息');
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
function makeFullService({ withKey = true, fetchImpl, baseUrl = 'https://api.deepseek.test', router = true, api = dshDownApi(), agent = false, agentBoundary = 'unsupported', stateDir: overrideDir, buildProductContext, defaultModelConfig, onEvent } = {}) {
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
  const agentExecute = agent
    ? async ({ method, params }) => {
      agentCalls.push({ method, params });
      if (method === 'agent.createSession') return { sessionId: `agent-${agentCalls.length}` };
      if (method === 'agent.list') return { providers: [{ id: 'dsh', label: 'DSH Agent', displayName: 'DSH', available: true, workspaceBoundary: agentBoundary, health: { available: true } }] };
      return { ok: true };
    }
    : null;
  const service = createChatService({
    api,
    controlExecute: fixtureControl('throw'), // DSH 模型目录不可用：Model Runtime 目录不受影响
    agentProviders: agent ? [{ id: 'dsh', label: 'DSH Agent', eventProtocol: 'dsh-session-events', workspaceBoundary: agentBoundary }] : [],
    agentExecute,
    modelRuntime,
    router: routerService,
    buildProductContext,
    defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    defaultModelConfig,
    stateDir: dir,
    onEvent
  });
  return { service, api, fetchImpl, agentCalls, dir };
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

// ── 16. Model Provider 配置：显式指定 / Key 缺失明确报错 / 配好后恢复 ──────────
{
  const f = sseFetch();
  const { service, fetchImpl } = makeFullService({ withKey: false, fetchImpl: f });
  const session = await service.execute({ method: 'chat.sessions.create', params: {} });
  // Automatic model resolution never starts DSH when no Key is configured.
  await assert.rejects(
    service.execute({ method: 'chat.send', params: { id: session.id, text: '没有 Key' } }),
    (error) => error.code === 'MODEL_PROVIDER_KEY_MISSING' && /设置 → 模型/.test(error.message)
  );
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
  ok('Provider 配置：无 Key 明确报错且不启动 DSH / 显式缺 Key 报错 / 非法 Provider 拒绝');
  service.close();
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
  assert.deepEqual(deepseek.models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(openai.hasKey, false, '未配 Key 的 Provider 如实标记');
  assert.deepEqual(openai.models, []);
  assert.ok(!JSON.stringify(catalog).includes(API_KEY), 'catalog 不含 Key 材料');
  ok('catalog：DSH 目录错误不阻塞 Model 目录 / hasKey 标记 / 无 Key 泄漏');
  service.close();
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

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 阶段 03 Chat 运行时全部通过（${step} 组）`);
