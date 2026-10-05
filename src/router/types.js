// Smart Router v1 —— 类型与策略常量（会话 1 / TASK-S1-005）。
//
// 第一版是确定性路由：规则 + 用户显式选择 + 任务特征（附件/工程上下文），
// 不调用 LLM 预判。三类：simple / tool / project；
// 路由：simple→model、tool→model(+capability-intent)、project→agent-intent。

export const ROUTE_CLASSES = Object.freeze(['simple', 'tool', 'project']);
export const ROUTES = Object.freeze(['model', 'agent']);
export const COST_POLICIES = Object.freeze(['economy', 'balanced', 'quality', 'agent-first']);
export const DEFAULT_COST_POLICY = 'balanced';

export function routerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeCostPolicy(value) {
  const policy = String(value ?? '').trim().toLowerCase();
  if (!COST_POLICIES.includes(policy)) {
    throw routerError('INVALID_PARAMS', `costPolicy 必须是 ${COST_POLICIES.join('/')}`);
  }
  return policy;
}

/** 归一化一次路由决策（内部字段全部确定，序列化进会话历史）。 */
export function normalizeDecision(decision) {
  return {
    class: decision.class,
    route: decision.route,
    resolvedRoute: decision.resolvedRoute ?? decision.route,
    agentIntent: decision.agentIntent === true,
    capabilityIntent: decision.capabilityIntent === true,
    signals: {
      project: Array.isArray(decision.signals?.project) ? decision.signals.project.slice(0, 12) : [],
      tool: Array.isArray(decision.signals?.tool) ? decision.signals.tool.slice(0, 12) : []
    },
    costPolicy: decision.costPolicy,
    agentEnabled: decision.agentEnabled !== false,
    fallbackReason: decision.fallbackReason ?? null,
    reasons: Array.isArray(decision.reasons) ? decision.reasons.slice(0, 12) : []
  };
}
