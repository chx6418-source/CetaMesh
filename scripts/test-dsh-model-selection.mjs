// 回归测试：DSH provider 归一化（src/dsh-model-selection.js）。
//
// 复现用户实际故障：config.json 里 dsh.provider=llm-deepseek（DSH 适配器配置
// 命名空间，不是可路由 provider），session/selectModel 报
//   session/model-unavailable: no adapter registered for provider "llm-deepseek"
// 期望：按官方 session/modelCatalog 解析为 deepseek-official 并成功绑定；
// 其他错误（模型不存在、传输失败）不得被吞掉或错误重试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isNoAdapterError,
  resolveModelSelection,
  selectDshSessionModel,
  fetchDshModelCatalog
} from '../src/dsh-model-selection.js';
import { createChatService } from '../src/desktop/chat-service.js';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'model-selection-test-'));
const stateDir = path.join(temp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

// 与运行中的真实 DSH（0.1.5+）session/modelCatalog 同构的 fixture。
const CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official', 'vision-http', 'deepseek-vision'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
        { id: 'deepseek-v4-flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
        { id: 'deepseek-v4-pro', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } }
      ]
    },
    {
      id: 'deepseek-vision',
      name: 'DeepSeek + 自动识图',
      models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }]
    }
  ]
};

const noAdapter = (provider) => new Error(`session/selectModel failed: session/model-unavailable: no adapter registered for provider "${provider}"`);

// ── 1. NO_ADAPTER 判定 ───────────────────────────────────────────────────────
{
  assert.equal(isNoAdapterError(noAdapter('llm-deepseek')), true);
  assert.equal(isNoAdapterError(new Error('session/model-unavailable: model not found')), false);
  assert.equal(isNoAdapterError(new Error('session/selectModel: 传输失败（ECONNREFUSED）')), false);
  assert.equal(isNoAdapterError(null), false);
  ok('NO_ADAPTER 判定：只识别 provider 未注册错误，不误判模型/传输错误');
}

// ── 2. 目录解析 ──────────────────────────────────────────────────────────────
{
  const keep = resolveModelSelection(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.equal(keep.provider, 'deepseek-official');
  assert.equal(keep.changed, false);
  assert.deepEqual(keep.notes, []);

  const fromLegacy = resolveModelSelection(CATALOG, { provider: 'llm-deepseek', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.equal(fromLegacy.provider, 'deepseek-official');
  assert.equal(fromLegacy.changed, true);
  assert.match(fromLegacy.notes[0], /llm-deepseek/);

  // 模型同时存在于 deepseek-official 与 deepseek-vision：默认 provider 优先。
  const ambiguous = resolveModelSelection(CATALOG, { provider: 'llm-deepseek', model: 'deepseek-v4-flash' });
  assert.equal(ambiguous.provider, 'deepseek-official');

  const placeholder = resolveModelSelection(CATALOG, { provider: 'dsh', model: 'deepseek-v4-pro' });
  assert.equal(placeholder.provider, 'deepseek-official');

  const emptyProvider = resolveModelSelection(CATALOG, { provider: '', model: 'deepseek-flash' });
  assert.equal(emptyProvider.provider, 'deepseek-official');

  // 未知模型：不瞎猜模型，换到默认 provider 让 DSH 报真实的 model-unavailable。
  const unknownModel = resolveModelSelection(CATALOG, { provider: 'llm-deepseek', model: 'no-such-model' });
  assert.equal(unknownModel.provider, 'deepseek-official');
  assert.equal(unknownModel.model, 'no-such-model');

  // reasoning 非法时退回模型默认强度。
  const badEffort = resolveModelSelection(CATALOG, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'ultra' });
  assert.equal(badEffort.reasoningEffort, 'high');
  assert.equal(badEffort.changed, true);
  ok('目录解析：历史 provider / 占位符 / 未知模型 / 非法 reasoning 均有确定行为');
}

// ── 3. selectDshSessionModel：直连成功不查目录 ──────────────────────────────
function fakeApi(handler) {
  const calls = [];
  return {
    calls,
    async callEndpoint(endpoint, args = {}) {
      calls.push({ endpoint, request: args?.request });
      return handler(endpoint, args, calls);
    }
  };
}
{
  const api = fakeApi((endpoint) => {
    if (endpoint === 'session/selectModel') return { selected: { provider: 'deepseek-official', model: 'deepseek-flash' } };
    throw new Error(`unexpected ${endpoint}`);
  });
  const result = await selectDshSessionModel(api, { sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.equal(result.changed, false);
  assert.equal(result.value.selected.provider, 'deepseek-official');
  assert.equal(api.calls.length, 1, '快乐路径不应查询模型目录');
  ok('selectDshSessionModel：provider 合法时单次调用，无额外目录请求');
}

// ── 4. selectDshSessionModel：NO_ADAPTER → 查目录 → 重试一次 ────────────────
{
  const api = fakeApi((endpoint, args) => {
    if (endpoint === 'session/selectModel') {
      const provider = args.request.provider;
      if (provider !== 'deepseek-official') throw noAdapter(provider);
      return { selected: { provider, model: args.request.model, reasoningEffort: args.request.reasoningEffort } };
    }
    if (endpoint === 'session/modelCatalog') return CATALOG;
    throw new Error(`unexpected ${endpoint}`);
  });
  const notes = [];
  const result = await selectDshSessionModel(api, { sessionId: 's2', provider: 'llm-deepseek', model: 'deepseek-flash', reasoningEffort: 'high' }, { log: (note) => notes.push(note) });
  assert.equal(result.changed, true);
  assert.equal(result.request.provider, 'deepseek-official');
  assert.equal(result.value.selected.provider, 'deepseek-official');
  const bindCalls = api.calls.filter((call) => call.endpoint === 'session/selectModel');
  assert.equal(bindCalls.length, 2);
  assert.equal(bindCalls[0].request.provider, 'llm-deepseek');
  assert.equal(bindCalls[1].request.provider, 'deepseek-official');
  assert.equal(notes.length, 1);
  ok('selectDshSessionModel：llm-deepseek → deepseek-official 自动重试成功并记录说明');
}

// ── 5. 其他错误不重试、不吞错 ───────────────────────────────────────────────
{
  const modelError = new Error('session/selectModel failed: session/model-unavailable: unknown model "no-such-model" for provider "deepseek-official"');
  const api = fakeApi((endpoint) => {
    if (endpoint === 'session/selectModel') throw modelError;
    throw new Error(`unexpected ${endpoint}`);
  });
  await assert.rejects(
    selectDshSessionModel(api, { sessionId: 's3', provider: 'deepseek-official', model: 'no-such-model' }),
    (error) => error === modelError
  );
  assert.equal(api.calls.filter((call) => call.endpoint === 'session/modelCatalog').length, 0, '模型错误不应触发目录重试');

  const api2 = fakeApi((endpoint) => {
    if (endpoint === 'session/selectModel') throw noAdapter('llm-deepseek');
    if (endpoint === 'session/modelCatalog') throw new Error('session/modelCatalog: 传输失败（ECONNREFUSED）');
    throw new Error(`unexpected ${endpoint}`);
  });
  await assert.rejects(
    selectDshSessionModel(api2, { sessionId: 's4', provider: 'llm-deepseek', model: 'deepseek-flash' }),
    (error) => isNoAdapterError(error)
  );
  ok('其他错误原样上抛；目录不可用时保留原始 NO_ADAPTER 错误');
}

// ── 6. fetchDshModelCatalog 归一化 ──────────────────────────────────────────
{
  const api = fakeApi((endpoint) => {
    if (endpoint === 'session/modelCatalog') return CATALOG;
    throw new Error(`unexpected ${endpoint}`);
  });
  const catalog = await fetchDshModelCatalog(api);
  assert.deepEqual(catalog.routableProviders, CATALOG.routableProviders);
  assert.equal(catalog.groups[0].models[0].efforts.length, 4);
  assert.equal(catalog.groups[0].models[0].defaultEffort, 'high');
  ok('fetchDshModelCatalog：provider/模型/强度结构归一化');
}

// ── 7. 端到端回归：Chat 页面切换模型（截图场景） ─────────────────────────────
{
  const calls = [];
  let promptHandler = null;
  const api = {
    calls,
    setPromptHandler: (fn) => { promptHandler = fn; },
    async callEndpoint(endpoint, args = {}) {
      calls.push({ endpoint, request: args?.request });
      if (endpoint === 'session/create') return { sessionId: 'dsh-user-1' };
      if (endpoint === 'session/selectModel') {
        const provider = args?.request?.provider;
        if (provider !== 'deepseek-official') throw noAdapter(provider);
        return { selected: { provider, model: args.request.model, reasoningEffort: args.request.reasoningEffort ?? 'high' } };
      }
      if (endpoint === 'session/modelCatalog') return CATALOG;
      if (endpoint === 'session/prompt') { await promptHandler?.(); return { accepted: true }; }
      if (endpoint === 'session/cancel') return {};
      throw new Error(`unexpected ${endpoint}`);
    },
    async *openRemoteStream() { await new Promise(() => {}); }
  };
  // 用户实际配置：dsh.provider=llm-deepseek, model=deepseek-flash, reasoning=high
  const service = createChatService({
    api,
    controlExecute: async ({ method }) => {
      if (method !== 'model.catalog.list') throw new Error(`unexpected control ${method}`);
      return { models: [] };
    },
    defaults: { provider: 'llm-deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
    stateDir: path.join(stateDir, 'chat-regression')
  });
  const session = await service.execute({ method: 'chat.sessions.create', params: { title: '回归' } });
  api.setPromptHandler(async () => {
    service._injectEvent(session.id, { type: 'turn/start', data: { turn: 1 } });
    service._injectEvent(session.id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到' }] } } });
    service._injectEvent(session.id, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  });
  await service.execute({ method: 'chat.send', params: { id: session.id, text: '你好' } });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await service.execute({ method: 'chat.status', params: { id: session.id } });
    if (status.state === 'completed' || status.state === 'idle') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  // 截图操作：会话配置里把自定义模型改成 deepseek-v4-flash 并应用。
  const updated = await service.execute({ method: 'chat.config.set', params: { id: session.id, config: { model: 'deepseek-v4-flash' } } });
  assert.equal(updated.config.model, 'deepseek-v4-flash');
  const rebind = api.calls.filter((call) => call.endpoint === 'session/selectModel').at(-1);
  assert.equal(rebind.request.provider, 'deepseek-official');
  assert.equal(rebind.request.model, 'deepseek-v4-flash');
  ok('端到端回归：llm-deepseek 配置下新建会话/切换模型均成功绑定 deepseek-official');
  service.close();
}

console.log(`\n✅ test-dsh-model-selection 全部通过（${step} 组断言）`);
