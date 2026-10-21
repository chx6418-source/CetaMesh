// DSH 会话模型绑定解析（session/selectModel 的 provider 归一化）。
//
// 背景：config.json 的 dsh.provider 是 CetaMesh 侧的历史配置项，可能保存的是
// DSH 的「LLM 适配器配置命名空间」（如 "llm-deepseek"）或早期占位符（"dsh"），
// 而 session/selectModel 只接受 session/modelCatalog 里登记的可路由 provider
// （内置适配器为 "deepseek-official"）。把 llm-deepseek 直接传过去会得到：
//   session/model-unavailable: no adapter registered for provider "llm-deepseek"
//
// 这里统一做一次「请求值 → 可路由值」解析：先按请求值尝试，只有确认是
// NO_ADAPTER 时才查询官方模型目录并按模型归属重试一次；其他错误（模型不存在、
// 传输失败等）原样抛出，不掩盖真实原因。
//
// 只依赖注入的 NodeApiClient（api.callEndpoint），不持有全局状态。

const DEFAULT_TIMEOUT_MS = 2500;
const NO_ADAPTER_RE = /no adapter registered for provider/i;

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** DSH 的 NO_ADAPTER 业务错误（provider 未注册）判定。 */
export function isNoAdapterError(error) {
  return NO_ADAPTER_RE.test(String(error?.message ?? error ?? ''));
}

/**
 * 读取 DSH 官方模型目录（session/modelCatalog）。
 * 返回 { default, routableProviders, groups:[{ id, models:[{ id, inputModalities, efforts, defaultEffort }] }] }。
 */
export async function fetchDshModelCatalog(api, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (!api?.callEndpoint) throw new Error('fetchDshModelCatalog 需要 DSH api 客户端');
  const requestSignal = signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  const catalog = await api.callEndpoint('session/modelCatalog', {}, requestSignal);
  return {
    default: catalog?.default && typeof catalog.default === 'object' ? catalog.default : null,
    routableProviders: (Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : [])
      .map(text).filter(Boolean),
    groups: (Array.isArray(catalog?.groups) ? catalog.groups : []).map((group) => ({
      id: text(group?.id),
      models: (Array.isArray(group?.models) ? group.models : []).map((model) => ({
        id: text(model?.id),
        inputModalities: (Array.isArray(model?.inputModalities) ? model.inputModalities : []).map(text),
        efforts: (Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []).map((effort) => text(effort?.id)).filter(Boolean),
        defaultEffort: text(model?.reasoning?.defaultEffort)
      })).filter((model) => model.id)
    })).filter((group) => group.id)
  };
}

/**
 * 按官方目录把请求值解析成「可路由 provider + 合法 reasoning effort」。
 * - 请求 provider 已在 routableProviders 中：原样保留；
 * - 否则（含空值、"dsh"、llm-deepseek 等历史值）：优先选能提供该模型的 provider，
 *   默认 provider 优先，其次目录顺序；模型不在任何分组时退回默认 provider，
 *   让 DSH 报出真实的 model-unavailable 而不是 provider NO_ADAPTER；
 * - reasoning effort 不在模型声明的可选强度内时退回该模型默认强度。
 */
export function resolveModelSelection(catalog, { provider, model, reasoningEffort } = {}) {
  const requestedProvider = text(provider);
  const requestedModel = text(model);
  const requestedEffort = text(reasoningEffort);
  const routable = Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : [];
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const defaultProvider = text(catalog?.default?.provider);
  const notes = [];

  const groupOf = (id) => groups.find((group) => group.id === id);
  const providerHasModel = (id, modelId) => Boolean(id && modelId
    && groupOf(id)?.models.some((entry) => entry.id === modelId));
  // 兼容两种输入：fetchDshModelCatalog 的归一化结构（efforts 为字符串数组）
  // 与 DSH 原始结构（efforts 为 { id } 对象、强度在 reasoning 下）。
  const effortIdsOf = (entry) => {
    const source = Array.isArray(entry?.efforts) ? entry.efforts : entry?.reasoning?.efforts;
    return (Array.isArray(source) ? source : [])
      .map((effort) => (typeof effort === 'string' ? text(effort) : text(effort?.id)))
      .filter(Boolean);
  };
  const defaultEffortOf = (entry) => text(entry?.defaultEffort ?? entry?.reasoning?.defaultEffort);

  let resolvedProvider = requestedProvider;
  if (!routable.includes(resolvedProvider)) {
    const candidates = [];
    const push = (value) => {
      const id = text(value);
      if (id && !candidates.includes(id)) candidates.push(id);
    };
    if (requestedModel) {
      if (providerHasModel(defaultProvider, requestedModel)) push(defaultProvider);
      for (const id of routable) if (providerHasModel(id, requestedModel)) push(id);
    }
    push(defaultProvider);
    for (const id of routable) push(id);
    resolvedProvider = candidates[0] ?? resolvedProvider;
    if (resolvedProvider && resolvedProvider !== requestedProvider) {
      notes.push(`provider "${requestedProvider || '(空)'}" 不是 DSH 可路由 provider，已按模型目录改用 "${resolvedProvider}"`);
    }
  }

  let resolvedEffort = requestedEffort;
  const modelEntry = groupOf(resolvedProvider)?.models.find((entry) => entry.id === requestedModel);
  const modelEfforts = effortIdsOf(modelEntry);
  if (modelEntry && modelEfforts.length && requestedEffort && !modelEfforts.includes(requestedEffort)) {
    const modelDefaultEffort = defaultEffortOf(modelEntry);
    resolvedEffort = modelEfforts.includes(modelDefaultEffort) ? modelDefaultEffort : modelEfforts[0];
    notes.push(`模型 ${requestedModel} 不支持 reasoning "${requestedEffort}"，已改用 "${resolvedEffort}"`);
  }

  return {
    provider: resolvedProvider,
    model: requestedModel,
    reasoningEffort: resolvedEffort,
    changed: resolvedProvider !== requestedProvider || resolvedEffort !== requestedEffort,
    notes
  };
}

/**
 * 绑定会话模型：先按请求值调用 session/selectModel；仅当错误是 NO_ADAPTER 时
 * 才查官方目录、解析 provider 并重试一次。
 * 返回 { value, request, changed, notes }；value 即 DSH 的 { selected } 响应。
 */
export async function selectDshSessionModel(api, request, { timeoutMs = 0, signal, log } = {}) {
  if (!api?.callEndpoint) throw new Error('selectDshSessionModel 需要 DSH api 客户端');
  const state = {
    sessionId: text(request?.sessionId),
    provider: text(request?.provider),
    model: text(request?.model),
    reasoningEffort: text(request?.reasoningEffort)
  };
  if (!state.sessionId) throw new Error('selectDshSessionModel 需要 sessionId');
  const requestSignal = signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  const call = (next) => api.callEndpoint('session/selectModel', {
    request: {
      sessionId: state.sessionId,
      provider: next.provider,
      model: state.model,
      ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {})
    }
  }, requestSignal);

  try {
    const value = await call(state);
    return { value, request: { ...state }, changed: false, notes: [] };
  } catch (error) {
    if (!isNoAdapterError(error)) throw error;
    let catalog;
    try {
      catalog = await fetchDshModelCatalog(api, {
        timeoutMs: timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        signal
      });
    } catch {
      // 目录也查不到：保留原始 NO_ADAPTER 错误（对排障更准确）。
      throw error;
    }
    const resolved = resolveModelSelection(catalog, state);
    const unchanged = resolved.provider === state.provider && resolved.reasoningEffort === state.reasoningEffort;
    if (!resolved.provider || unchanged) throw error;
    const retryRequest = {
      sessionId: state.sessionId,
      provider: resolved.provider,
      model: state.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {})
    };
    const value = await call(retryRequest);
    for (const note of resolved.notes) log?.(note);
    return { value, request: retryRequest, changed: true, notes: resolved.notes };
  }
}
