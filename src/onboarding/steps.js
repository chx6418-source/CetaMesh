// CetaMesh Desktop —— 首次运行引导（First Run Onboarding）步骤定义。
//
// 产品决策（WHY，必须保持）：
//   1. 完成引导 = 配好一个 Model Provider（连接可用）+ 选定默认模型。
//      QQ / DSH / 移动端 / Agent / 扩展 一律**不是**完成条件 —— 它们是可选增项。
//      缺任何外部服务时引导都能走完，否则「没有 QQ 就没法进入 CetaMesh」会变成
//      事实上的强制捆绑，这是本项目最明确要拆掉的东西。
//   2. 必填步骤有严格顺序（welcome → provider → connection → model → done）：
//      后面的必填步骤依赖前面的产物（没有 Key 就测不了连接、没测通就选不了模型）。
//   3. 可选步骤（agent / integration）无论「完成」还是「跳过」都不影响 canFinish。

/** 步骤状态机取值：pending=未做，completed=完成，skipped=用户显式跳过。 */
export const STEP_STATES = Object.freeze(['pending', 'completed', 'skipped']);

/**
 * 引导步骤（数组顺序即用户看到的顺序，也是必填步骤的依赖顺序）。
 * - required：完成引导的必要条件；optional：可完成、可跳过、也可完全不管。
 * - label / description 面向用户（zh-CN），UI 直接渲染，不再自行拼文案。
 */
export const ONBOARDING_STEPS = Object.freeze([
  Object.freeze({
    id: 'welcome',
    order: 1,
    label: '欢迎使用 CetaMesh',
    description: 'CetaMesh 是本地优先的 AI 工作台：模型与数据默认留在你自己的机器上。',
    optional: false,
    required: true
  }),
  Object.freeze({
    id: 'provider',
    order: 2,
    label: '配置模型服务商',
    description: '填写一个 Model Provider 的 API Key（可选自定义 baseUrl），用于驱动对话与 Agent。',
    optional: false,
    required: true,
    collects: 'providerCredential'
  }),
  Object.freeze({
    id: 'connection',
    order: 3,
    label: '测试连接',
    description: '用刚配置的凭据真实请求一次服务商接口，确认 Key 可用；失败会给出中文原因与排查提示。',
    optional: false,
    required: true,
    needs: ['provider']
  }),
  Object.freeze({
    id: 'model',
    order: 4,
    label: '选择默认模型',
    description: '选定新会话默认使用的模型；之后可在「设置 → 模型」随时更改。',
    optional: false,
    required: true,
    needs: ['provider']
  }),
  Object.freeze({
    id: 'agent',
    order: 5,
    label: '连接 Agent（可选）',
    description: '可选：接入 Codex 之类的 Agent Provider。没有 Agent 也能正常使用 CetaMesh。',
    optional: true,
    required: false
  }),
  Object.freeze({
    id: 'integration',
    order: 6,
    label: '启用 Integration（可选）',
    description: '可选：安装或启用一个扩展 Integration。不安装任何扩展也能正常使用 CetaMesh。',
    optional: true,
    required: false
  }),
  Object.freeze({
    id: 'done',
    order: 7,
    label: '完成',
    description: '标记引导流程结束。只有全部必填步骤完成后才能收尾。',
    optional: false,
    required: true,
    final: true
  })
]);

/** 完成引导的必要步骤（顺序即依赖顺序）。 */
export const REQUIRED_STEP_IDS = Object.freeze(ONBOARDING_STEPS.filter((step) => step.required).map((step) => step.id));

/** 可选步骤：可跳过，也是唯一允许 skipStep 的集合。 */
export const OPTIONAL_STEP_IDS = Object.freeze(ONBOARDING_STEPS.filter((step) => step.optional).map((step) => step.id));

/** 按 id 取步骤定义；未知 id 返回 null（是否报错由调用方 Domain 决定）。 */
export function stepById(id) {
  const wanted = String(id ?? '');
  return ONBOARDING_STEPS.find((step) => step.id === wanted) ?? null;
}

/** 是否为已知步骤 id。 */
export function isKnownStepId(id) {
  return stepById(id) !== null;
}

/**
 * 给定「已完成的步骤 id 集合」，返回下一个应展示的步骤 id。
 * 规则：按定义顺序取第一个既未完成也未跳过的步骤；全部处理完返回 null。
 */
export function nextStepId(completed = [], skipped = []) {
  const done = new Set(Array.isArray(completed) ? completed.map(String) : []);
  const passed = new Set(Array.isArray(skipped) ? skipped.map(String) : []);
  for (const step of ONBOARDING_STEPS) {
    if (!done.has(step.id) && !passed.has(step.id)) return step.id;
  }
  return null;
}

/**
 * 必填步骤的顺序校验：请求完成 stepId 时，是否还有更早的必填步骤未完成。
 * 返回 { ok: true } 或 { ok: false, missing: [更早的必填步骤 id...] }。
 */
export function checkRequiredOrder(stepId, completed = []) {
  const done = new Set(Array.isArray(completed) ? completed.map(String) : []);
  const index = REQUIRED_STEP_IDS.indexOf(String(stepId ?? ''));
  if (index < 0) return { ok: true, missing: [] };
  const missing = REQUIRED_STEP_IDS.slice(0, index).filter((id) => !done.has(id));
  return { ok: missing.length === 0, missing };
}

/** 未完成的必填步骤（onboarding.finish 的判定依据）。 */
export function missingRequiredStepIds(completed = []) {
  const done = new Set(Array.isArray(completed) ? completed.map(String) : []);
  return REQUIRED_STEP_IDS.filter((id) => !done.has(id));
}
