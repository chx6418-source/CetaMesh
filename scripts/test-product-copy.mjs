// CetaMesh Desktop —— 产品文案与 Provider 配置体验验收（产品化任务 D · 第八、九节）。
// 用法：node scripts/test-product-copy.mjs
//
// 覆盖验收项：
//   Empty state：Chat 无模型 / Agent 未安装 / 插件关闭 / 工具被拒 四条必需文案，
//                以及"技术错误绝不直接抛给用户"（message 恒为产品文案，技术串只进 detail）
//   Provider 配置体验：普通用户字段（服务商 / API Key / 模型）与高级字段分离
//   Provider 连接测试失败：401 / 网络失败 / HTTP 500 / 缺 Key 的友好文案

import {
  EMPTY_STATES,
  GENERIC_EMPTY_STATE_KEY,
  emptyStateFor,
  emptyStateForError
} from '../src/product/empty-states.js';
import {
  PROVIDER_BASIC_FIELD_KEYS,
  buildProviderView,
  describeProviderTestFailure,
  providerFieldGuidance
} from '../src/product/provider-view.js';
import { describeFields } from '../src/settings/schema.js';
import { createProductService } from '../src/product/service.js';

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
const captureError = async (fn) => {
  try { await fn(); return null; }
  catch (error) { return error; }
};

// ── 1. 四条必需空状态 ─────────────────────────────────────────────────
equal('Chat 无模型 → 先添加一个模型', EMPTY_STATES['chat.no-model'].title, '先添加一个模型');
equal('Agent 未安装 → Codex 未安装', EMPTY_STATES['agent.not-installed'].title, 'Codex 未安装');
equal('插件关闭 → 插件已关闭', EMPTY_STATES['plugin.disabled'].title, '插件已关闭');
equal('工具被拒 → 需要审批', EMPTY_STATES['capability.tool-denied'].title, '需要审批');
check('每条空状态都给 title/message/action 三件套',
  Object.values(EMPTY_STATES).every((state) => state.title && state.message && state.action));

// ── 2. 未知 key 不崩 ──────────────────────────────────────────────────
equal('未知 key 回落 generic', emptyStateFor('nope.nope').key, GENERIC_EMPTY_STATE_KEY);
equal('空 key 回落 generic', emptyStateFor(null).key, GENERIC_EMPTY_STATE_KEY);
check('generic 兜底文案仍可展示', emptyStateFor('nope.nope').message.length > 0);

// ── 3. 技术错误码 → 用户语言 ──────────────────────────────────────────
equal('MODEL_NO_MODEL → 先添加一个模型', emptyStateForError({ code: 'MODEL_NO_MODEL' }).title, '先添加一个模型');
equal('MODEL_PROVIDER_KEY_MISSING → 缺少 API Key', emptyStateForError({ code: 'MODEL_PROVIDER_KEY_MISSING' }).key, 'chat.no-provider-key');
equal('AGENT_NOT_INSTALLED → Codex 未安装', emptyStateForError({ code: 'AGENT_NOT_INSTALLED' }).title, 'Codex 未安装');
equal('EXTENSION_DISABLED → 插件已关闭', emptyStateForError({ code: 'EXTENSION_DISABLED' }).title, '插件已关闭');
equal('TOOL_DENIED → 需要审批', emptyStateForError({ code: 'TOOL_DENIED' }).title, '需要审批');
equal('APPROVAL_REQUIRED → 等待批准', emptyStateForError({ code: 'APPROVAL_REQUIRED' }).key, 'capability.approval-pending');
equal('CAPABILITY_DENIED → 需要审批', emptyStateForError({ code: 'CAPABILITY_DENIED' }).key, 'capability.tool-denied');

const rawTechnical = 'policy engine rejected: scope=filesystem path=C:\\secret\\file.txt';
const mapped = emptyStateForError({ code: 'TOOL_DENIED', message: rawTechnical });
check('技术串只出现在 detail，不污染产品文案',
  mapped.detail.includes(rawTechnical) && !mapped.message.includes(rawTechnical) && mapped.message.length > 0);
const unknownCode = emptyStateForError({ code: 'SOMETHING_NEW', message: 'boom' });
equal('未知 code 落 generic 并保留原始信息', [unknownCode.key, unknownCode.detail.includes('SOMETHING_NEW')], [GENERIC_EMPTY_STATE_KEY, true]);

// ── 4. Provider 配置体验：普通用户 vs 高级 ─────────────────────────────
const fields = describeFields();
const viewWithoutProvider = buildProviderView({ fields });
equal('未选定 Provider 时不推测高级字段', viewWithoutProvider.advanced.map(field => field.key), []);
const view = buildProviderView({ fields, settingsFields: [
  { key: 'baseUrl', label: 'Base URL', type: 'string' },
  { key: 'reasoningEffort', label: '推理强度', type: 'string', choices: ['off', 'low', 'high', 'max'] }
] });
equal('普通用户字段固定为 服务商 / API Key / 模型', view.basic.map((field) => field.key), ['provider', 'apiKey', 'model']);
equal('基础字段常量与视图一致', [...PROVIDER_BASIC_FIELD_KEYS], ['provider', 'apiKey', 'model']);
check('基础字段都标记必填', view.basic.every((field) => field.required === true));
check('每个基础字段都有人话说明', view.basic.every((field) => typeof field.description === 'string' && field.description.length > 0));
equal('高级字段只来自选中 Provider 元数据', view.advanced.map((f) => f.key), ['baseUrl', 'reasoningEffort']);
check('高级字段一律非必填（默认值可用）', view.advanced.every((field) => field.required === false));
const guidance = providerFieldGuidance(view);
check('配置指引说明普通用户只需三项',
  guidance.text.includes('服务商') && guidance.text.includes('API Key') && guidance.text.includes('模型'));
check('指引给出基础三项与高级项清单', guidance.basic.length === 3 && Array.isArray(guidance.advancedFieldKeys));

// ── 5. Provider 测试失败的友好文案 ────────────────────────────────────
const authFailure = describeProviderTestFailure({ provider: 'deepseek-official', ok: false, status: 401, message: '认证失败（API Key 无效或无权限）' });
equal('401 → PROVIDER_TEST_AUTH_FAILED', [authFailure.ok, authFailure.code], [false, 'PROVIDER_TEST_AUTH_FAILED']);
check('401 文案提到 API Key 且不含裸状态码', authFailure.message.includes('API Key') && !authFailure.message.includes('401'));
const networkFailure = describeProviderTestFailure({ provider: 'openai', ok: false, status: 0, message: '网络请求失败或超时' });
equal('网络失败 → PROVIDER_TEST_NETWORK', networkFailure.code, 'PROVIDER_TEST_NETWORK');
const httpFailure = describeProviderTestFailure({ provider: 'openai', ok: false, status: 500, message: 'provider 返回 HTTP 500' });
equal('HTTP 500 → PROVIDER_TEST_HTTP_ERROR', httpFailure.code, 'PROVIDER_TEST_HTTP_ERROR');
const missingKey = describeProviderTestFailure({ code: 'PROVIDER_SECRET_NOT_FOUND', message: 'provider openai 尚未配置 API Key' });
equal('缺 Key → PROVIDER_TEST_KEY_MISSING', missingKey.code, 'PROVIDER_TEST_KEY_MISSING');
const success = describeProviderTestFailure({ provider: 'openai', ok: true, status: 200, message: 'API Key 可用' });
check('成功结果如实返回 ok', success.ok === true);
check('各类失败都有人话 message', [authFailure, networkFailure, httpFailure, missingKey].every((item) => item.message.length > 0 && item.title.length > 0));

// ── 6. Product 服务（IPC product.* 的实现） ───────────────────────────
const product = createProductService();
const emptyResponse = await product.execute({ method: 'product.emptyState', params: { key: 'chat.no-model' } });
equal('product.emptyState 可达', emptyResponse.state.title, '先添加一个模型');
const errorResponse = await product.execute({ method: 'product.emptyStateForError', params: { code: 'TOOL_DENIED', message: 'denied' } });
equal('product.emptyStateForError 可达', errorResponse.state.title, '需要审批');
const viewResponse = await product.execute({ method: 'product.providerView', params: {} });
equal('product.providerView 可达', viewResponse.view.basic.map((field) => field.key), ['provider', 'apiKey', 'model']);
const failureResponse = await product.execute({ method: 'product.providerTestFailure', params: { provider: 'openai', status: 401 } });
equal('product.providerTestFailure 可达', failureResponse.failure.code, 'PROVIDER_TEST_AUTH_FAILED');
const copyResponse = await product.execute({ method: 'product.copy', params: {} });
equal('product.copy 暴露全部文案条目', copyResponse.emptyStates.length, Object.keys(EMPTY_STATES).length);
const unknownMethod = await captureError(() => product.execute({ method: 'product.nope', params: {} }));
check('未知方法报 METHOD_NOT_FOUND', unknownMethod?.code === 'METHOD_NOT_FOUND', String(unknownMethod?.code));

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('产品文案与配置体验（空状态 / 技术码映射 / 基础-高级字段分离 / 连接失败文案）验收全部通过');
