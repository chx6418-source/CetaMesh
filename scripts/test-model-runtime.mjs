// 会话 1 验收：Model Runtime（src/model/）。
// 全部经 fixture fetch（真实 Response/ReadableStream）与隔离临时凭据库，不联网、不触碰真实 Key。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createModelProviderRegistry,
  createModelRuntimeService,
  createOpenAiCompatibleModelProvider,
  createSseLineParser,
  defineModelProvider
} from '../src/model/index.js';
import { createProviderSecrets } from '../src/providers/secrets.js';

const allowedTestTempRoot = path.resolve(process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir());
fs.mkdirSync(allowedTestTempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(allowedTestTempRoot, 'model-runtime-test-'));
assert.equal(path.dirname(temp), allowedTestTempRoot, 'model runtime fixtures stay inside the aggregate test sandbox or OS Temp');

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

const API_KEY = 'sk-test-1234567890abcdefSECRET';
const SSE = [
  'data: {"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}',
  '',
  'data: {"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"，世界"}}]}',
  '',
  'data: {"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}',
  '',
  'data: [DONE]',
  ''
].join('\n');

/** fixture fetch：记录请求；handler(url, init) 返回 Response（或抛错模拟网络失败）。 */
function fixtureFetch(handler) {
  const requests = [];
  return {
    requests,
    async fetch(url, init = {}) {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      return handler(url, init);
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 可控 SSE 流：先发第一块，随后挂起；abort 时以 AbortError 结束流（模拟真实 fetch 取消）。 */
function abortableSseFetch() {
  let controller = null;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n`));
    }
  });
  return {
    async fetch(url, init = {}) {
      init.signal?.addEventListener('abort', () => {
        try { controller.error(new Error('The operation was aborted')); } catch { /* 已结束 */ }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  };
}

function makeSecrets(withKey = true) {
  const dir = fs.mkdtempSync(path.join(temp, 'secrets-'));
  const secrets = createProviderSecrets({ root: dir });
  if (withKey) {
    secrets.set({ provider: 'deepseek-official', apiKey: API_KEY });
    secrets.set({ provider: 'openai', apiKey: 'sk-openai-9999abcdefgh' });
  }
  return secrets;
}

function makeService({ withKey = true, fetchImpl } = {}) {
  const secrets = makeSecrets(withKey);
  const deepseek = createOpenAiCompatibleModelProvider({
    id: 'deepseek-official',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.test',
    defaultModel: 'deepseek-chat',
    secrets,
    fetchImpl: fetchImpl?.fetch ?? fetch,
    supportsStreamOptions: true,
    log: () => {}
  });
  const openai = createOpenAiCompatibleModelProvider({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.test/v1',
    defaultModel: 'gpt-4o-mini',
    secrets,
    fetchImpl: fetchImpl?.fetch ?? fetch,
    reasoningParam: 'reasoning_effort',
    supportsStreamOptions: true,
    log: () => {}
  });
  const registry = createModelProviderRegistry({ providers: [deepseek, openai] });
  const service = createModelRuntimeService({ registry, secrets });
  return { service, registry, secrets, deepseek, openai };
}

// ── 1. 注册表：注册 / 获取 / 重复 / 未知 ─────────────────────────────────────
{
  const { registry } = makeService();
  assert.deepEqual(registry.ids(), ['deepseek-official', 'openai']);
  assert.equal(registry.get('openai').label, 'OpenAI');
  assert.equal(registry.get('nope'), null);
  assert.throws(() => registry.require('nope'), (error) => error.code === 'MODEL_PROVIDER_UNKNOWN');
  assert.throws(() => registry.register(registry.get('openai')), /重复/);
  assert.throws(
    () => defineModelProvider({ id: 'x', label: 'X', methods: { listModels: () => {} } }),
    /缺少必需方法 chat/,
    'listModels/chat/stream 缺失时 defineModelProvider 拒绝（不造假桩）'
  );
  ok('注册表：注册顺序 / get / require / 重复与未知拒绝 / 契约方法强制');
}

// ── 2. resolveProvider：无 Key / 显式未知 / 有 Key ───────────────────────────
{
  const noKey = makeService({ withKey: false });
  assert.throws(
    () => noKey.service.resolveProvider(null),
    (error) => error.code === 'MODEL_PROVIDER_KEY_MISSING' && /尚未配置任何 Model Provider/.test(error.message)
  );
  assert.throws(
    () => noKey.service.resolveProvider('deepseek-official'),
    (error) => error.code === 'MODEL_PROVIDER_KEY_MISSING' && /DeepSeek 官方/.test(error.message)
  );
  const withKey = makeService({});
  assert.equal(withKey.service.resolveProvider(null).id, 'deepseek-official', '自动解析按注册顺序取第一个有 Key 的');
  assert.equal(withKey.service.defaultProviderId(), 'deepseek-official');
  assert.equal(withKey.service.resolveProvider('openai').id, 'openai');
  ok('resolveProvider：无 Key fail-closed / 自动解析按优先级 / 显式指定');
}

// ── 3. listModels：映射 / 无伪造 ─────────────────────────────────────────────
{
  const f = fixtureFetch(() => jsonResponse({ object: 'list', data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }));
  const { service } = makeService({ fetchImpl: f });
  const listing = await service.listModels('deepseek-official');
  assert.equal(listing.error, null);
  assert.deepEqual(listing.models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner'], '按 id 排序');
  assert.ok(!JSON.stringify(listing).includes(API_KEY), '模型列表不携带 Key');
  assert.equal(f.requests[0].url, 'https://api.deepseek.test/models');
  assert.equal(f.requests[0].init.headers.authorization, `Bearer ${API_KEY}`, 'Key 只出现在请求头');
  ok('listModels：/models 映射排序 + 不携带 Key');
}

// ── 4. chat()：非流式 + usage ───────────────────────────────────────────────
{
  const f = fixtureFetch(() => jsonResponse({
    model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  }));
  const { service } = makeService({ fetchImpl: f });
  const result = await service.chat({
    providerId: 'deepseek-official',
    messages: [{ role: 'user', content: '问题' }]
  });
  assert.equal(result.text, '答案');
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.equal(f.requests[0].body.model, 'deepseek-chat', '未指定模型时使用 Provider 默认模型');
  assert.equal(f.requests[0].body.stream, false);
  ok('chat()：非流式回合 + 默认模型 + usage');
}

// ── 5. stream()：统一事件格式 + 文本聚合 + usage ─────────────────────────────
{
  const f = fixtureFetch(() => sseResponse(SSE));
  const { service } = makeService({ fetchImpl: f });
  const events = [];
  for await (const event of service.stream({
    providerId: 'deepseek-official',
    messages: [{ role: 'user', content: '你好' }],
    signal: new AbortController().signal
  })) {
    events.push(event);
  }
  assert.equal(events[0].type, 'turn/start');
  const chunks = events.filter((e) => e.type === 'assistant/chunk');
  assert.deepEqual(chunks.map((e) => e.data.chunk.text), ['你好', '，世界']);
  const message = events.find((e) => e.type === 'assistant/message');
  assert.equal(message.data.message.content[0].text, '你好，世界', '完整组装文本（供状态机校准，不翻倍）');
  assert.deepEqual(message.data.message.usage, { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
  const end = events.at(-1);
  assert.equal(end.type, 'turn/end');
  assert.equal(end.data.reason.kind, 'completed');
  assert.deepEqual(end.data.reason.usage, message.data.message.usage);
  assert.equal(f.requests[0].body.stream_options.include_usage, true, '内置 Provider 携带 include_usage');
  ok('stream()：turn/start → chunk 增量 → message 校准+usage → turn/end(completed)');
}

// ── 6. Abort：取消以 turn/end(aborted) 收尾，不悬挂 ──────────────────────────
{
  const f = abortableSseFetch();
  const { service } = makeService({ fetchImpl: f });
  const controller = new AbortController();
  const events = [];
  for await (const event of service.stream({
    providerId: 'deepseek-official',
    messages: [{ role: 'user', content: '长回答' }],
    signal: controller.signal
  })) {
    events.push(event);
    if (event.type === 'assistant/chunk') controller.abort();
  }
  const end = events.at(-1);
  assert.equal(end.type, 'turn/end');
  assert.equal(end.data.reason.kind, 'aborted', '取消以 aborted 收尾（Chat 状态机映射为 cancelled）');
  ok('Abort：流式取消 → turn/end(aborted)，无悬挂无未处理拒绝');
}

// ── 7. Provider 错误统一映射 + Key 不泄漏 ────────────────────────────────────
{
  const f = fixtureFetch((url) => {
    if (url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${API_KEY}` } }), { status: 401 });
    }
    return jsonResponse({ data: [] });
  });
  const { service } = makeService({ fetchImpl: f });
  await assert.rejects(
    service.chat({ providerId: 'deepseek-official', messages: [{ role: 'user', content: 'x' }] }),
    (error) => {
      assert.equal(error.code, 'MODEL_PROVIDER_ERROR');
      assert.match(error.message, /认证失败/);
      assert.ok(!error.message.includes(API_KEY), '错误信息绝不包含原始 Key');
      return true;
    }
  );
  const rate = fixtureFetch(() => new Response('{"error":{"message":"rate limited"}}', { status: 429 }));
  const rateService = makeService({ fetchImpl: rate }).service;
  await assert.rejects(
    rateService.chat({ providerId: 'deepseek-official', messages: [{ role: 'user', content: 'x' }] }),
    (error) => error.code === 'MODEL_PROVIDER_ERROR' && /过于频繁或配额不足/.test(error.message)
  );
  const server = fixtureFetch(() => new Response('boom', { status: 503 }));
  const serverService = makeService({ fetchImpl: server }).service;
  await assert.rejects(
    serverService.chat({ providerId: 'deepseek-official', messages: [{ role: 'user', content: 'x' }] }),
    (error) => error.code === 'MODEL_PROVIDER_ERROR' && /暂时不可用（HTTP 503）/.test(error.message)
  );
  const net = fixtureFetch(() => { throw new TypeError('fetch failed'); });
  const netService = makeService({ fetchImpl: net }).service;
  await assert.rejects(
    netService.chat({ providerId: 'deepseek-official', messages: [{ role: 'user', content: 'x' }] }),
    (error) => error.code === 'MODEL_PROVIDER_UNAVAILABLE' && /无法连接/.test(error.message)
  );
  ok('错误映射：401 认证 / 429 限频 / 5xx 服务 / 网络不可用；Key 在源头 scrub');
}

// ── 8. Secret 不泄漏：service 面只返回 hasKey 布尔 ───────────────────────────
{
  const { service } = makeService({});
  const providers = service.listProviders();
  assert.deepEqual(providers, [
    { id: 'deepseek-official', label: 'DeepSeek 官方', hasKey: true },
    { id: 'openai', label: 'OpenAI', hasKey: true }
  ]);
  const health = await service.health('deepseek-official');
  assert.equal(health.available, true);
  const serialized = JSON.stringify({ providers, health });
  assert.ok(!serialized.includes(API_KEY), 'service 输出不含 Key 材料');
  ok('Secret 纪律：list/health 只含 hasKey 布尔，无 Key 材料');
}

// ── 9. Reasoning 参数映射：off 不携带 / max→high / DeepSeek 不带该参数 ────────
{
  const f = fixtureFetch(() => sseResponse(SSE));
  const { service } = makeService({ fetchImpl: f });
  const collect = async (reasoning, providerId) => {
    const before = f.requests.length;
    for await (const _ of service.stream({ providerId, messages: [{ role: 'user', content: 'x' }], reasoning, signal: new AbortController().signal })) { void _; }
    return f.requests[before].body;
  };
  const offBody = await collect('off', 'openai');
  assert.ok(!('reasoning_effort' in offBody), 'off → 不携带 reasoning 参数');
  const maxBody = await collect('max', 'openai');
  assert.equal(maxBody.reasoning_effort, 'high', 'max → OpenAI 语义上限 high');
  const lowBody = await collect('low', 'openai');
  assert.equal(lowBody.reasoning_effort, 'low');
  const deepseekBody = await collect('high', 'deepseek-official');
  assert.ok(!('reasoning_effort' in deepseekBody), 'DeepSeek 以模型区分 reasoning，不携带 effort 参数');
  ok('Reasoning 映射：off 省略 / max→high / DeepSeek 无该参数');
}

// ── 10. OpenAI 兼容自定义端点：无 baseUrl 拒绝；默认不带 stream_options ───────
{
  const secrets = makeSecrets({});
  secrets.set({ provider: 'openai-compatible', apiKey: 'sk-custom-1234567890' });
  const custom = createOpenAiCompatibleModelProvider({
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    baseUrl: '',
    secrets,
    fetchImpl: fixtureFetch(() => sseResponse(SSE)).fetch
  });
  await assert.rejects(() => custom.listModels({}), (error) => /服务地址（baseUrl）/.test(error.message), '无 baseUrl fail-closed');
  // secrets 提供 baseUrl 后可用（Settings 支持可选 baseUrl）
  secrets.set({ provider: 'openai-compatible', apiKey: 'sk-custom-1234567890', baseUrl: 'https://relay.test/v1' });
  const registry = createModelProviderRegistry({ providers: [custom] });
  const service = createModelRuntimeService({ registry, secrets });
  const f2 = fixtureFetch(() => sseResponse(SSE));
  const custom2 = createOpenAiCompatibleModelProvider({
    id: 'openai-compatible', label: 'OpenAI 兼容', baseUrl: '', secrets, fetchImpl: f2.fetch
  });
  const registry2 = createModelProviderRegistry({ providers: [custom2] });
  const service2 = createModelRuntimeService({ registry: registry2, secrets });
  const events = [];
  for await (const e of service2.stream({ providerId: 'openai-compatible', messages: [{ role: 'user', content: 'x' }], model: 'm1', signal: new AbortController().signal })) events.push(e);
  assert.equal(events.at(-1).data.reason.kind, 'completed');
  assert.equal(f2.requests[0].url, 'https://relay.test/v1/chat/completions', 'baseUrl 来自凭据条目');
  assert.ok(!('stream_options' in f2.requests[0].body), '自定义兼容端点默认不带 stream_options（兼容面最大）');
  ok('OpenAI 兼容：baseUrl fail-closed / 凭据 baseUrl 生效 / 不带 stream_options');
}

// ── 11. SSE 行解析器：跨 chunk 缓冲 / \r\n / flush ───────────────────────────
{
  const parser = createSseLineParser();
  assert.deepEqual(parser.push('data: {"a"'), []);
  assert.deepEqual(parser.push(':1}\ndata: [DONE]\r\n'), ['data: {"a":1}', 'data: [DONE]']);
  assert.deepEqual(parser.flush(), []);
  assert.deepEqual(parser.push('data: tail'), []);
  assert.deepEqual(parser.flush(), ['data: tail']);
  ok('SSE 行解析：跨 chunk 缓冲 / \\r\\n / flush');
}

// ── 12. modelrt.* IPC 方法族（model.* 前缀留给控制面 DSH 模型管理，避免碰撞）────
{
  const f = fixtureFetch(() => jsonResponse({ data: [{ id: 'deepseek-chat' }] }));
  const { service } = makeService({ fetchImpl: f });
  const list = await service.execute({ method: 'modelrt.providers.list' });
  assert.equal(list.providers.length, 2);
  const models = await service.execute({ method: 'modelrt.models.list', params: { provider: 'deepseek-official' } });
  assert.equal(models.error, null);
  assert.deepEqual(models.models.map((m) => m.id), ['deepseek-chat']);
  const broken = makeService({ fetchImpl: fixtureFetch(() => { throw new TypeError('fetch failed'); }) }).service;
  const failed = await broken.execute({ method: 'modelrt.models.list', params: { provider: 'deepseek-official' } });
  assert.deepEqual(failed.models, [], '目录失败不伪造列表');
  assert.match(failed.error, /无法连接/);
  await assert.rejects(service.execute({ method: 'modelrt.nope' }), (error) => error.code === 'METHOD_NOT_FOUND');
  ok('modelrt.* IPC：providers.list / models.list（失败不伪造）/ 未知方法拒绝');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 Model Runtime 全部通过（${step} 组）`);
