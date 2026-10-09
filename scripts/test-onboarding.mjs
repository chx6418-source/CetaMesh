// CetaMesh Desktop —— 首次运行引导验收（产品化任务 D · 第七节 / 第十节）。
// 用法：node scripts/test-onboarding.mjs
//
// 覆盖验收项：
//   完成引导（在**没有 QQ / DSH / 移动端 / Agent / 扩展**的环境下）
//   可选步骤跳过 / 必填步骤不可跳 / 必填顺序
//   进度持久化 / 损坏文件如实处理 / reset
//   Provider 连接测试失败（友好中文 + 稳定错误码）
//   默认模型写入设置 / 引导进度绝不落 API Key

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ONBOARDING_STEPS,
  OPTIONAL_STEP_IDS,
  REQUIRED_STEP_IDS,
  createOnboardingService
} from '../src/onboarding/index.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { createSettingsService } from '../src/settings/index.js';

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

const dirs = [];
const tmp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
const stepState = (status, id) => status.steps.find((step) => step.id === id)?.state ?? null;
const okFetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

try {
  // ── 1. 步骤定义（完成条件里没有 QQ / DSH / 移动端） ──────────────────────
  equal('引导共 7 步', ONBOARDING_STEPS.length, 7);
  equal('必填步骤顺序', [...REQUIRED_STEP_IDS], ['welcome', 'provider', 'connection', 'model', 'done']);
  equal('可选步骤只有 agent 与 integration', [...OPTIONAL_STEP_IDS], ['agent', 'integration']);
  const copyText = ONBOARDING_STEPS.map((step) => step.id + ' ' + step.label + ' ' + step.description).join(' ');
  check('引导文案不要求 QQ / DSH / 移动端', !/(^|\W)(qq|dsh|mobile|移动端)(\W|$)/i.test(copyText.replace(/Agent/g, 'agent')), copyText.slice(0, 80));
  check('可选步骤明确标注"可选"', ONBOARDING_STEPS.filter((step) => step.optional).every((step) => step.label.includes('可选')));

  // ── 2. 无 QQ / DSH / 移动端 / Agent / 扩展也能完成引导 ──────────────────
  const bareDir = tmp('cetamesh-onb-bare-');
  const bare = createOnboardingService({ stateDir: bareDir }); // 注意：只有 stateDir，没有任何外部服务
  const initial = await bare.execute({ method: 'onboarding.status', params: {} });
  equal('初始状态为 not_started', initial.status, 'not_started');
  await bare.execute({ method: 'onboarding.start', params: {} });
  await bare.execute({ method: 'onboarding.completeStep', params: { stepId: 'welcome' } });
  await bare.execute({
    method: 'onboarding.completeStep',
    params: { stepId: 'provider', data: { provider: 'deepseek-official', apiKey: 'sk-live-should-not-be-stored' } }
  });
  await bare.execute({ method: 'onboarding.completeStep', params: { stepId: 'connection' } });
  await bare.execute({ method: 'onboarding.completeStep', params: { stepId: 'model', data: { model: 'deepseek-chat' } } });
  const finished = await bare.execute({ method: 'onboarding.finish', params: {} });
  equal('无 QQ/DSH/移动端/Agent 也能完成引导', [finished.status, typeof finished.completedAt === 'string'], ['completed', true]);
  equal('可选步骤未处理不影响完成', finished.optionalPending, ['agent', 'integration']);
  const storedText = fs.readFileSync(path.join(bareDir, 'onboarding.json'), 'utf8');
  check('引导进度绝不落 API Key', !storedText.includes('sk-live-should-not-be-stored'));
  check('未注入 Agent/扩展服务时可选步骤不阻塞', (await bare.execute({ method: 'onboarding.connectAgent', params: { provider: 'codex' } })).ok === true);

  // ── 3. 顺序 / 跳过 / 收尾约束 ─────────────────────────────────────────
  const rulesDir = tmp('cetamesh-onb-rules-');
  const rules = createOnboardingService({ stateDir: rulesDir });
  await rules.execute({ method: 'onboarding.start', params: {} });
  const skippedAgent = await rules.execute({ method: 'onboarding.skipStep', params: { stepId: 'agent' } });
  equal('可选步骤可跳过', stepState(skippedAgent, 'agent'), 'skipped');
  const skipRequired = await captureError(() => rules.execute({ method: 'onboarding.skipStep', params: { stepId: 'provider' } }));
  check('必填步骤不能跳过', skipRequired?.code === 'ONBOARDING_STEP_REQUIRED', String(skipRequired?.code));
  const outOfOrder = await captureError(() => rules.execute({ method: 'onboarding.completeStep', params: { stepId: 'model' } }));
  check('必填步骤顺序被强制', outOfOrder?.code === 'ONBOARDING_STEP_ORDER' && outOfOrder.missing.includes('provider'), JSON.stringify(outOfOrder?.missing ?? null));
  const finishEarly = await captureError(() => rules.execute({ method: 'onboarding.finish', params: {} }));
  check('必填未完成时拒绝收尾', finishEarly?.code === 'ONBOARDING_INCOMPLETE' && finishEarly.missing.includes('provider'), JSON.stringify(finishEarly?.missing ?? null));
  const unknownStep = await captureError(() => rules.execute({ method: 'onboarding.completeStep', params: { stepId: 'nope' } }));
  check('未知步骤报 ONBOARDING_STEP_NOT_FOUND', unknownStep?.code === 'ONBOARDING_STEP_NOT_FOUND', String(unknownStep?.code));
  const unknownMethod = await captureError(() => rules.execute({ method: 'onboarding.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknownMethod?.code === 'METHOD_NOT_FOUND', String(unknownMethod?.code));

  // ── 4. 进度持久化 ────────────────────────────────────────────────────
  const reloaded = createOnboardingService({ stateDir: bareDir });
  equal('进度跨实例持久化', (await reloaded.execute({ method: 'onboarding.status', params: {} })).status, 'completed');
  const afterReset = await reloaded.execute({ method: 'onboarding.reset', params: {} });
  equal('reset 回到 not_started', [afterReset.status, afterReset.completed.length], ['not_started', 0]);

  // ── 5. Provider 连接测试 ─────────────────────────────────────────────
  const testDir = tmp('cetamesh-onb-test-');
  const providerSecrets = createProviderSecrets({ root: testDir });
  const probe = createOnboardingService({ stateDir: testDir, providerSecrets });
  const networkFailure = await probe.execute({
    method: 'onboarding.testProvider',
    params: { provider: 'deepseek-official', apiKey: 'sk-test-abcdefgh', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.deepseek.com'); } }
  });
  equal('网络失败 → PROVIDER_TEST_NETWORK', [networkFailure.ok, networkFailure.code], [false, 'PROVIDER_TEST_NETWORK']);
  check('失败文案是用户可读的中文', String(networkFailure.message).includes('网络') && networkFailure.message !== 'getaddrinfo ENOTFOUND api.deepseek.com');
  const authFailure = await probe.execute({
    method: 'onboarding.testProvider',
    params: { provider: 'deepseek-official', apiKey: 'sk-test-abcdefgh', fetchImpl: async () => ({ ok: false, status: 401 }) }
  });
  equal('认证失败 → PROVIDER_TEST_AUTH_FAILED', [authFailure.ok, authFailure.code], [false, 'PROVIDER_TEST_AUTH_FAILED']);
  check('认证失败文案提到 API Key', String(authFailure.message).includes('API Key'));
  const httpFailure = await probe.execute({
    method: 'onboarding.testProvider',
    params: { provider: 'deepseek-official', apiKey: 'sk-test-abcdefgh', fetchImpl: async () => ({ ok: false, status: 500 }) }
  });
  equal('服务端错误 → PROVIDER_TEST_HTTP_ERROR', [httpFailure.ok, httpFailure.code], [false, 'PROVIDER_TEST_HTTP_ERROR']);
  const badKey = await probe.execute({ method: 'onboarding.testProvider', params: { provider: 'deepseek-official', apiKey: 'short' } });
  equal('非法 Key → PROVIDER_TEST_KEY_INVALID', [badKey.ok, badKey.code], [false, 'PROVIDER_TEST_KEY_INVALID']);
  const success = await probe.execute({
    method: 'onboarding.testProvider',
    params: { provider: 'deepseek-official', apiKey: 'sk-test-abcdefgh', fetchImpl: okFetch }
  });
  equal('连接成功返回可用结果', [success.ok, success.message.includes('成功')], [true, true]);

  // 测试成功后自动标记 connection 步骤（顺序前提满足时）
  const autoDir = tmp('cetamesh-onb-auto-');
  const auto = createOnboardingService({ stateDir: autoDir, providerSecrets: createProviderSecrets({ root: autoDir }) });
  await auto.execute({ method: 'onboarding.start', params: {} });
  await auto.execute({ method: 'onboarding.completeStep', params: { stepId: 'welcome' } });
  await auto.execute({ method: 'onboarding.completeStep', params: { stepId: 'provider', data: { provider: 'deepseek-official' } } });
  const autoTest = await auto.execute({
    method: 'onboarding.testProvider',
    params: { provider: 'deepseek-official', apiKey: 'sk-test-abcdefgh', fetchImpl: okFetch }
  });
  check('测试成功后自动完成 connection 步骤', autoTest.connectionStepCompleted === true);

  // ── 6. 默认模型写入设置 ──────────────────────────────────────────────
  const modelDir = tmp('cetamesh-onb-model-');
  const settingsService = createSettingsService({ stateDir: modelDir });
  const modelService = createOnboardingService({ stateDir: modelDir, settingsService });
  const setModel = await modelService.execute({ method: 'onboarding.setModel', params: { provider: 'deepseek-official', model: 'deepseek-chat' } });
  equal('默认模型写入设置并生效', [setModel.persisted, settingsService.store.get().settings.models.defaultModel], [true, 'deepseek-chat']);

  // ── 7. 损坏的进度文件 ────────────────────────────────────────────────
  const corruptDir = tmp('cetamesh-onb-corrupt-');
  fs.writeFileSync(path.join(corruptDir, 'onboarding.json'), '{ not json', 'utf8');
  const corrupt = createOnboardingService({ stateDir: corruptDir });
  const corruptStatus = await corrupt.execute({ method: 'onboarding.status', params: {} });
  check('损坏时按全新进度继续并如实上报', corruptStatus.status === 'not_started' && typeof corruptStatus.lastError === 'string' && corruptStatus.lastError.length > 0);
  const blockedWrite = await captureError(() => corrupt.execute({ method: 'onboarding.completeStep', params: { stepId: 'welcome' } }));
  check('损坏后拒绝静默覆写', blockedWrite?.code === 'ONBOARDING_STORE_CORRUPT', String(blockedWrite?.code));
  const resetAfterCorrupt = await corrupt.execute({ method: 'onboarding.reset', params: {} });
  equal('reset 是唯一的显式重建入口', resetAfterCorrupt.status, 'not_started');
  const continueAfterReset = await corrupt.execute({ method: 'onboarding.completeStep', params: { stepId: 'welcome' } });
  equal('重建后可继续完成步骤', stepState(continueAfterReset, 'welcome'), 'completed');
} finally {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('首次运行引导（无 QQ/DSH/移动端完成 / 顺序 / 持久化 / 连接测试失败 / 损坏恢复）验收全部通过');
