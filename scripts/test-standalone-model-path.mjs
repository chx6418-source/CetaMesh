// v2 hardening / TASK-B 系列验收：真实 Standalone Model 路径。
//
// 真实 Provider（DeepSeek/OpenAI 官方端点）回合需要用户真实 Key：本机
// state/provider-keys.json 不存在 → 该项如实记 NOT_RUN_ENVIRONMENT（见文件末尾与
// DESKTOP_V2_HARDENING_REPORT.md），不伪造。
//
// 本脚本验证的是不依赖真实 Key 也能真实成立的工程事实（全部走真实 TCP/HTTP，
// 不是 stub 函数替换）：
//   1. 零 DSH 依赖：chat-service 在没有任何 DSH api/controlExecute 的情况下，
//      经本地真实 HTTP 的 OpenAI 兼容 Provider 完成完整 Chat 回合（流式 → 定稿 →
//      usage 落盘）；源码级断言 src/model/ 无 DSH 导入。
//   2. 应用重启后会话与历史仍在（sessions.json/history 重新加载）。
//   3. 停止（abort）→ cancelled partial 落盘，不崩溃。
//   4. Retry → 新回合成功。
//   5. 无效 Key（fixture 返回 401）→ 结构化错误、Key 字符串绝不出现在错误文本。
//   6. Provider 不可达（连接拒绝）→ 结构化 PROVIDER_UNAVAILABLE，不崩溃、不偷偷回退 DSH。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChatService } from '../src/desktop/chat-service.js';
import { createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider } from '../src/model/index.js';
import { createProviderSecrets } from '../src/providers/secrets.js';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(root, 'output', 'standalone-model-'));
const VALID_KEY = 'sk-fixture-standalone-000000000000';
const BAD_KEY = 'sk-wrong-key-abcdefghijklmnop';
let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

/** 真实 TCP HTTP 服务器：模拟 OpenAI 兼容 Provider（流式 SSE + 校验 Authorization）。 */
function startProviderServer({ mode = 'ok', latencyMs = 0 } = {}) {
  const state = { mode };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      if (state.mode === 'unauthorized' || !auth.includes(VALID_KEY)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key provided', type: 'invalid_request_error' } }));
        return;
      }
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fixture-model-a' }, { id: 'fixture-model-b' }] }));
        return;
      }
      const payload = JSON.parse(body || '{}');
      const respond = () => {
        if (mode === 'stream-abort-hang') {
          // 先吐两个增量然后挂住不结束：客户端 abort 的真实测试点。
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"model":"fixture-model-a","choices":[{"delta":{"content":"第一段"}}]}\n\n');
          res.write('data: {"model":"fixture-model-a","choices":[{"delta":{"content":"第二段"}}]}\n\n');
          return; // 故意不 end
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"model":"fixture-model-a","choices":[{"delta":{"content":"你好"}}]}\n\n');
        res.write('data: {"model":"fixture-model-a","choices":[{"delta":{"content":"，收到。"}}]}\n\n');
        res.write('data: {"model":"fixture-model-a","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":4,"total_tokens":25}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (latencyMs > 0) setTimeout(respond, latencyMs); else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      setMode: (next) => { state.mode = next; },
      // closeAllConnections：挂住的 abort fixture socket 不结束，必须强断，
      // 否则 close() 永不返回、测试进程悬死。
      close: () => new Promise((r) => {
        server.close(() => r());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      })
    }));
  });
}

/** 无 DSH 的 Chat 服务：api 显式 null，controlExecute 缺省——Standalone 唯一通道是 Model Runtime。 */
function makeChatService(stateDir, port) {
  const secrets = createProviderSecrets({ root: stateDir });
  secrets.set({ provider: 'fixture-provider', apiKey: VALID_KEY });
  const registry = createModelProviderRegistry({
    providers: [createOpenAiCompatibleModelProvider({
      id: 'fixture-provider',
      label: 'Fixture Provider',
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: 'fixture-model-a',
      secrets,
      supportsStreamOptions: true,
      log: () => {}
    })]
  });
  const modelRuntime = createModelRuntimeService({ registry, secrets, log: () => {} });
  return createChatService({
    api: null,             // 无 DSH 客户端对象：任何 DSH 路径都必然 requireDshApi 报错
    controlExecute: null,  // 无 DSH 模型目录
    modelRuntime,
    defaults: { provider: 'deepseek-official', model: '', reasoningEffort: 'max' },
    stateDir
  });
}

// ── 1. 零 DSH 依赖的完整 Chat 回合（真实 HTTP 流式） ─────────────────────────
{
  const { server, port, close } = await startProviderServer();
  const stateDir = path.join(temp, 'case1');
  const service = makeChatService(stateDir, port);
  const created = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: created.id, config: { modelProvider: 'fixture-provider', model: 'fixture-model-a', reasoning: 'off' } } });
  await service.execute({ method: 'chat.send', params: { id: created.id, text: '只回复两个字：收到' } });

  let status = null;
  for (let i = 0; i < 100; i += 1) {
    status = await service.execute({ method: 'chat.status', params: { id: created.id } });
    if (!status.turn) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.turn, null, '回合应正常结束');
  const history = await service.execute({ method: 'chat.history', params: { id: created.id } });
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[1].text, '你好，收到。', '流式增量组装为最终文本');
  assert.deepEqual(history.messages[1].usage, { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 }, '真实 usage 透传');
  await close();
  ok('零 DSH 依赖：无 api/controlExecute 构造的 Chat 完成真实 HTTP 流式回合 + usage 落盘');
}

// ── 2. 重启后会话仍在 ────────────────────────────────────────────────────────
{
  const { server, port, close } = await startProviderServer();
  const stateDir = path.join(temp, 'case2');
  const first = makeChatService(stateDir, port);
  const created = await first.execute({ method: 'chat.sessions.create', params: { title: '重启保留' } });
  await first.execute({ method: 'chat.send', params: { id: created.id, text: 'hi' } });
  for (let i = 0; i < 100; i += 1) {
    const status = await first.execute({ method: 'chat.status', params: { id: created.id } });
    if (!status.turn) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const second = makeChatService(stateDir, port); // 全新实例 = 模拟应用重启
  const list = await second.execute({ method: 'chat.sessions.list', params: {} });
  assert.ok(list.sessions.some((s) => s.id === created.id && s.title === '重启保留'), '重启后会话仍在');
  const history = await second.execute({ method: 'chat.history', params: { id: created.id } });
  assert.equal(history.messages.length, 2, '重启后历史仍在');
  await close();
  ok('应用重启：会话与历史完整保留（全新服务实例重载）');
}

// ── 3. 停止（abort）→ cancelled partial ─────────────────────────────────────
{
  const { server, port, close } = await startProviderServer({ mode: 'stream-abort-hang' });
  const stateDir = path.join(temp, 'case3');
  const service = makeChatService(stateDir, port);
  const created = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: created.id, config: { modelProvider: 'fixture-provider' } } });
  await service.execute({ method: 'chat.send', params: { id: created.id, text: '讲个长故事' } });
  await new Promise((resolve) => setTimeout(resolve, 300)); // 等首段增量到达
  const stopped = await service.execute({ method: 'chat.stop', params: { id: created.id } });
  assert.equal(stopped.stopped, true);
  for (let i = 0; i < 100; i += 1) {
    const status = await service.execute({ method: 'chat.status', params: { id: created.id } });
    if (!status.turn) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const history = await service.execute({ method: 'chat.history', params: { id: created.id } });
  const partial = history.messages.find((m) => m.role === 'assistant');
  assert.ok(partial, '中止后 partial 落盘');
  assert.equal(partial.cancelled, true, '标记 cancelled');
  assert.equal(partial.text, '第一段第二段', '已收到的增量保留为 partial');
  await close();
  ok('停止：真实 TCP 流上 abort → cancelled partial，不崩溃');
}

// ── 4. Retry：失败回合（无文本产出）后重试成功 ────────────────────────────────
{
  const { server, port, close, setMode } = await startProviderServer({ mode: 'unauthorized' });
  const stateDir = path.join(temp, 'case4');
  const service = makeChatService(stateDir, port);
  const created = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: created.id, config: { modelProvider: 'fixture-provider' } } });
  // 首事件前的失败（401）同步拒绝 send：会话 1 契约保持。
  await assert.rejects(
    () => service.execute({ method: 'chat.send', params: { id: created.id, text: '第一轮' } }),
    (error) => ['MODEL_PROVIDER_ERROR', 'MODEL_PROVIDER_UNAVAILABLE'].includes(error.code)
  );
  let history = await service.execute({ method: 'chat.history', params: { id: created.id } });
  assert.deepEqual(history.messages.map((m) => m.role), ['user'], '失败回合只留 user 消息（可重试）');
  setMode('ok'); // 修复凭据后重试同一消息
  await service.execute({ method: 'chat.retry', params: { id: created.id } });
  await waitForIdle(service, created.id);
  history = await service.execute({ method: 'chat.history', params: { id: created.id } });
  assert.deepEqual(history.messages.map((m) => m.role), ['user', 'assistant'], 'retry 重发同一 user 消息（不重复落盘）');
  assert.equal(history.messages[1].text, '你好，收到。');
  await close();
  ok('Retry：失败回合 → 修复后重试 → 新回合成功，user 消息不重复');
}

// ── 5. 无效 Key：结构化错误 + Key 不泄漏（send 同步拒绝，会话 1 契约） ────────
{
  const { server, port, close } = await startProviderServer();
  const stateDir = path.join(temp, 'case5');
  const secrets = createProviderSecrets({ root: stateDir });
  secrets.set({ provider: 'fixture-provider', apiKey: BAD_KEY });
  const registry = createModelProviderRegistry({
    providers: [createOpenAiCompatibleModelProvider({
      id: 'fixture-provider', label: 'Fixture Provider', baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: 'fixture-model-a', secrets, supportsStreamOptions: true, log: () => {}
    })]
  });
  const service = createChatService({
    api: null, controlExecute: null,
    modelRuntime: createModelRuntimeService({ registry, secrets, log: () => {} }),
    defaults: { model: '', reasoningEffort: 'max' }, stateDir
  });
  const created = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: created.id, config: { modelProvider: 'fixture-provider' } } });
  await assert.rejects(
    () => service.execute({ method: 'chat.send', params: { id: created.id, text: 'hi' } }),
    (error) => {
      assert.ok(['MODEL_PROVIDER_ERROR', 'MODEL_PROVIDER_UNAVAILABLE'].includes(error.code), `结构化错误码：${error.code}`);
      const text = JSON.stringify({ message: error.message, cause: String(error.cause ?? '') });
      assert.ok(!text.includes(BAD_KEY), '错误信息绝不含 Key 字符串');
      return true;
    },
    '无效 Key 必须结构化失败'
  );
  const status = await service.execute({ method: 'chat.status', params: { id: created.id } });
  assert.equal(status.lastState, 'awaiting-reply', '失败回合保留可重试');
  const list = await service.execute({ method: 'chat.sessions.list', params: {} });
  assert.equal(list.sessions.length, 1, '失败不摧毁会话');
  await close();
  ok('无效 Key：401 → send 同步结构化拒绝；Key 字符串零泄漏；会话保留可重试');
}

// ── 6. Provider 不可达：连接拒绝 → send 同步拒绝，不偷偷回退 DSH ──────────────
{
  // 占位后立即释放端口 → 后续连接被拒绝（真实 TCP RST 路径）。
  const { server, close, port } = await startProviderServer();
  await close();
  const stateDir = path.join(temp, 'case6');
  const secrets = createProviderSecrets({ root: stateDir });
  secrets.set({ provider: 'fixture-provider', apiKey: VALID_KEY });
  const registry = createModelProviderRegistry({
    providers: [createOpenAiCompatibleModelProvider({
      id: 'fixture-provider', label: 'Fixture Provider', baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: 'fixture-model-a', secrets, supportsStreamOptions: true, log: () => {}
    })]
  });
  const service = createChatService({
    api: null, controlExecute: null,
    modelRuntime: createModelRuntimeService({ registry, secrets, log: () => {} }),
    defaults: { model: '', reasoningEffort: 'max' }, stateDir
  });
  const created = await service.execute({ method: 'chat.sessions.create', params: {} });
  await service.execute({ method: 'chat.config.set', params: { id: created.id, config: { modelProvider: 'fixture-provider' } } });
  await assert.rejects(
    () => service.execute({ method: 'chat.send', params: { id: created.id, text: 'hi' } }),
    (error) => {
      assert.ok(['MODEL_PROVIDER_UNAVAILABLE', 'MODEL_PROVIDER_ERROR'].includes(error.code), `连接失败结构化：${error.code}`);
      assert.equal(String(error.message).includes('DSH'), false, '错误与 DSH 无关（不回退 DSH）');
      return true;
    }
  );
  ok('Provider 不可达：真实连接拒绝 → send 同步结构化拒绝，无 DSH 回退');
}

/** 等待回合离开 streaming（后台回合的通用等待）。 */
async function waitForIdle(service, id) {
  let status = null;
  for (let i = 0; i < 200; i += 1) {
    status = await service.execute({ method: 'chat.status', params: { id } });
    if (!status.turn) return { turn: { state: 'idle-done' } };
    if (status.turn.state !== 'streaming' && status.turn.state !== 'cancelling') return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return status;
}

// ── 7. 源码级红线：src/model/ 不依赖 DSH ─────────────────────────────────────
{
  const files = fs.readdirSync(path.join(root, 'src', 'model'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, 'src', 'model', file), 'utf8');
    assert.doesNotMatch(source, /dsh-client|dsh-model-selection|dsh-auth/i, `${file} 不得依赖 DSH 模块`);
    assert.doesNotMatch(source, /127\.0\.0\.1:3080/, `${file} 不得硬编码 DSH 端点`);
  }
  ok('源码级：src/model/** 零 DSH 导入、零 DSH 端点');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log('\n真实 Provider（DeepSeek/OpenAI 官方端点、真实 Key）回合：NOT_RUN_ENVIRONMENT');
console.log('（本机 state/provider-keys.json 不存在；未向用户索要 Key，未伪造验证）');
console.log(`\n🎉 Standalone Model 真实路径验证通过（${step} 组，全部真实 TCP/HTTP）`);
