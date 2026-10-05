// 阶段 03 验收：产品级 Desktop Chat 运行时（src/desktop/chat-service.js）。
// fixture DSH（可控注入 follow 事件）+ 隔离临时 stateDir，不触碰真实 DSH / 用户数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createChatService } from '../src/desktop/chat-service.js';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, 'output', 'chat-product-test-'));
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
  // 回合已结束（error 是终态），最后一落盘消息是 assistant → NOTHING_TO_RETRY
  await assert.rejects(
    service.execute({ method: 'chat.retry', params: { id: session.id } }),
    (error) => error.code === 'NOTHING_TO_RETRY'
  );
  ok('turn 异常结束：partial + error 标记落盘，retry 语义正确');
  service.close();
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 阶段 03 Chat 运行时全部通过（${step} 组）`);
