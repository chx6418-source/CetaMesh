// Model Runtime 服务（会话 1 / TASK-S1-001/002）。
//
// 职责：Provider 解析（显式指定或按 Key 配置自动选择）、模型目录、回合执行入口、
// health；并把少量方法以 model.* 私有方法族暴露给桌面 Shell（模型列表 / 健康）。
// 回合执行（chat/stream）只供进程内消费方（desktop/chat-service.js）直接调用，
// 与 agent.* 的 follow 流同理不经一元 IPC 暴露。
//
// Key 纪律：本层只返回 hasKey 布尔，任何列表/目录/错误都不携带 Key 材料。
import { calculateModelContextBudget, enforceModelContextBudget } from '../context/model-budget.js';
import { modelRuntimeError, MODEL_ERROR_CODES } from './types.js';

export function createModelRuntimeService({ registry, secrets, preferredProviderId = null, log = () => {} } = {}) {
  if (!registry || typeof registry.require !== 'function') {
    throw new Error('createModelRuntimeService 需要 registry（src/model/registry.js）');
  }
  if (!secrets || typeof secrets.list !== 'function') {
    throw new Error('createModelRuntimeService 需要 secrets（src/providers/secrets.js）');
  }

  function configuredProviderIds() {
    try {
      return new Set(secrets.list().map((entry) => entry.provider));
    } catch {
      // 凭据文件损坏时 fail-closed：视为没有任何 Key（secrets.list 自身会带 code 抛错）。
      return new Set();
    }
  }

  function hasKey(providerId) {
    return configuredProviderIds().has(String(providerId ?? ''));
  }

  function preferredConfiguredProviderId() {
    const id = typeof preferredProviderId === 'function' ? preferredProviderId() : preferredProviderId;
    return id && registry.has(id) && hasKey(id) ? id : null;
  }

  /** 解析 Provider：显式 id 必须已注册且已配置 Key；null 时按注册顺序取第一个有 Key 的。 */
  function resolveProvider(providerId) {
    if (providerId === null || providerId === undefined || providerId === '') {
      const preferred = preferredConfiguredProviderId();
      if (preferred) return registry.require(preferred);
      for (const id of registry.ids()) {
        if (hasKey(id)) return registry.require(id);
      }
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_PROVIDER_KEY_MISSING,
        '尚未配置任何 Model Provider API Key：普通聊天无法发送。请在「设置 → 模型」中配置 DeepSeek/OpenAI API Key'
      );
    }
    const provider = registry.require(providerId);
    if (!hasKey(provider.id)) {
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_PROVIDER_KEY_MISSING,
        `Model Provider「${provider.label}」尚未配置 API Key：请在「设置 → 模型」中配置`
      );
    }
    return provider;
  }

  /** 自动解析默认 Provider id（无 Key 配置时返回 null，调用方回退 DSH 直连路径）。 */
  function defaultProviderId() {
    const preferred = preferredConfiguredProviderId();
    if (preferred) return preferred;
    for (const id of registry.ids()) {
      if (hasKey(id)) return id;
    }
    return null;
  }

  function listProviders() {
    return registry.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      hasKey: hasKey(provider.id),
      toolCalling: provider.supportsTools === true,
      settingsFields: typeof provider.settingsFields === 'function' ? provider.settingsFields() : []
    }));
  }

  const metadataText = (value, limit = 512) => typeof value === 'string' && value.trim()
    && value.length <= limit && !/[\x00-\x1f]/.test(value) ? value : null;
  const positiveTokens = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  function contextCapacity(capacity) {
    const known = ['verified', 'declared'].includes(capacity?.status)
      && positiveTokens(capacity.contextWindowTokens) && positiveTokens(capacity.maxOutputTokens)
      && positiveTokens(capacity.defaultOutputTokens) && metadataText(capacity.source) && metadataText(capacity.version, 128);
    return { status: known ? capacity.status : 'unknown',
      contextWindowTokens: known ? capacity.contextWindowTokens : null,
      maxOutputTokens: known ? capacity.maxOutputTokens : null,
      defaultOutputTokens: known ? capacity.defaultOutputTokens : null,
      outputTokenParameter: known && ['max_tokens', 'max_completion_tokens'].includes(capacity.outputTokenParameter) ? capacity.outputTokenParameter : null,
      source: known ? capacity.source : null, version: known ? capacity.version : null };
  }
  function booleanCapability(value) {
    const known = ['verified', 'declared', 'unsupported'].includes(value?.status) && typeof value?.supported === 'boolean';
    return { supported: known ? value.supported : null, status: known ? value.status : 'unknown',
      source: known ? metadataText(value.source) : null };
  }
  function modelCapabilities(providerId, model = null) {
    const provider = resolveProvider(providerId);
    const effectiveModel = model || provider.defaultModel;
    const declared = provider.modelCapabilities?.(effectiveModel) ?? {};
    const image = provider.imageInputCapabilities?.(effectiveModel) ?? {};
    const tools = typeof provider.supportsToolsForModel === 'function'
      ? provider.supportsToolsForModel(effectiveModel) : provider.supportsTools;
    const reasoning = declared.reasoning;
    const reasoningKnown = ['declared', 'verified', 'unsupported'].includes(reasoning?.status)
      && Array.isArray(reasoning.levels) && reasoning.levels.length <= 16
      && reasoning.levels.every(level => typeof level === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(level));
    return {
      vision: booleanCapability(declared.vision ?? image),
      tools: booleanCapability(declared.tools ?? { supported: typeof tools === 'boolean' ? tools : null,
        status: typeof tools === 'boolean' ? tools ? 'declared' : 'unsupported' : 'unknown', source: 'provider-declaration' }),
      reasoning: { levels: reasoningKnown ? [...new Set(reasoning.levels)] : [], status: reasoningKnown ? reasoning.status : 'unknown',
        source: reasoningKnown ? metadataText(reasoning.source) : null },
      context: contextCapacity(provider.contextCapabilities?.(effectiveModel))
    };
  }

  function contextObservation(provider, model, messages, tools, maxOutputTokens, budget) {
    const unknownComposition = () => Object.fromEntries(['messages', 'system', 'tools', 'other'].map(key => [key, { tokens: null, status: 'unknown' }]));
    let composition = unknownComposition();
    // Partition the same conservative estimator, never reinterpret an exact total as exact bucket counts.
    if (budget.counting === 'estimated') {
      try {
        const estimationProvider = { contextCapabilities: value => provider.contextCapabilities?.(value),
          imageInputCapabilities: value => provider.imageInputCapabilities?.(value) };
        const estimate = (subsetMessages, subsetTools) => {
          const part = calculateModelContextBudget({ provider: estimationProvider, model, messages: subsetMessages, tools: subsetTools,
            maxOutputTokens: budget.reservedOutputTokens ?? maxOutputTokens });
          if (part.counting !== 'estimated' || part.source !== budget.source || part.version !== budget.version
            || part.contextWindowTokens !== budget.contextWindowTokens || part.reservedOutputTokens !== budget.reservedOutputTokens) return null;
          return part.inputTokens;
        };
        const base = estimate([], []);
        const values = { messages: estimate((messages ?? []).filter(message => message.role !== 'system'), []),
          system: estimate((messages ?? []).filter(message => message.role === 'system'), []), tools: estimate([], tools ?? []) };
        if (base !== null && Object.values(values).every(value => Number.isSafeInteger(value) && value >= base)) {
          const counts = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value - base]));
          counts.other = budget.inputTokens - counts.messages - counts.system - counts.tools;
          if (Number.isSafeInteger(counts.other) && counts.other >= 0) composition = Object.fromEntries(
            Object.entries(counts).map(([key, tokens]) => [key, { tokens, status: 'estimated' }]));
        }
      } catch {
        // Optional composition cannot weaken admission; retain unknown buckets and the enforced total.
        composition = unknownComposition();
      }
    }
    return { schemaVersion: 1, providerId: provider.id, model, at: Date.now(),
      status: budget.counting === 'exact' ? 'actual' : budget.counting === 'estimated' ? 'estimated' : 'unknown',
      inputTokens: budget.inputTokens ?? null, windowTokens: budget.contextWindowTokens ?? null,
      reservedOutputTokens: budget.reservedOutputTokens ?? null, capacityStatus: budget.capacityStatus ?? 'unknown',
      source: budget.source ?? null, version: budget.version ?? null, estimator: budget.estimator ?? null, composition };
  }
  function notifyContext(callback, provider, model, messages, tools, maxOutputTokens, budget) {
    if (typeof callback !== 'function') return;
    const failed = () => log('Model context observer failed; request admission and provider cancellation remain authoritative');
    try {
      const result = callback(contextObservation(provider, model, messages, tools, maxOutputTokens, budget));
      if (result && typeof result.catch === 'function') result.catch(failed);
    } catch { failed(); }
  }

  async function listModels(providerId) {
    const provider = resolveProvider(providerId);
    try {
      const models = await provider.listModels({});
      return { provider: provider.id, models: models.map(model => ({ ...model, capabilities: modelCapabilities(provider.id, model.id) })), error: null };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR;
      return { provider: provider.id, models: [], error: String(error?.message ?? error), code };
    }
  }

  async function health(providerId) {
    const provider = registry.require(providerId);
    const configured = hasKey(provider.id);
    if (!configured) return {
      provider: provider.id, status: 'needs-setup', available: null,
      configured: false, reachable: null, authenticated: null, inferencing: null
    };
    try {
      return { ...(await provider.health({})), provider: provider.id, configured: true };
    } catch (error) {
      return { available: null, provider: provider.id, configured: true, status: 'error', reason: String(error?.message ?? error) };
    }
  }

  /** 回合流入口：chat-service 传 providerId（已解析）或 null（自动）。 */
  function stream({ providerId, model, messages, reasoning, signal, tools, toolChoice, maxOutputTokens, onContext }) {
    const provider = resolveProvider(providerId);
    const effectiveModel = typeof model === 'string' && model.trim()
      ? model.trim()
      : provider.defaultModel;
    if (!effectiveModel) {
      return (async function* () {
        throw modelRuntimeError(
          MODEL_ERROR_CODES.MODEL_NO_MODEL,
          `Model Provider「${provider.label}」未指定模型且没有默认模型`
        );
      })();
    }
    log(`Model Runtime 回合开始（provider=${provider.id} model=${effectiveModel}）`);
    let budget;
    try { budget = enforceModelContextBudget({ provider, model: effectiveModel, messages, tools, maxOutputTokens }); }
    catch (error) { return (async function* () { throw error; })(); }
    notifyContext(onContext, provider, effectiveModel, messages, tools, maxOutputTokens, budget);
    // Preserve the provider stream's established cancellation/finalization path.
    // An extra async-generator relay adds observable microtask delay to abort.
    return provider.stream({
      maxOutputTokens: budget.reservedOutputTokens ?? maxOutputTokens,
      model: effectiveModel,
      requestedModel: typeof model === 'string' && model.trim() ? model.trim() : 'provider-default',
      messages,
      reasoning,
      tools,
      toolChoice,
      signal
    });
  }

  async function chat({ providerId, model, messages, reasoning, signal, tools, toolChoice, maxOutputTokens, onContext }) {
    const provider = resolveProvider(providerId);
    const effectiveModel = typeof model === 'string' && model.trim() ? model.trim() : provider.defaultModel;
    if (!effectiveModel) {
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_NO_MODEL,
        `Model Provider「${provider.label}」未指定模型且没有默认模型`
      );
    }
    if (Array.isArray(tools) && tools.length && (typeof provider.supportsToolsForModel === 'function'
      ? provider.supportsToolsForModel(effectiveModel) !== true : provider.supportsTools !== true)) {
      throw modelRuntimeError('MODEL_TOOL_CALLING_UNSUPPORTED', 'This Model Provider does not support structured tool calling');
    }
    const contextBudget = enforceModelContextBudget({ provider, model: effectiveModel, messages, tools, maxOutputTokens });
    notifyContext(onContext, provider, effectiveModel, messages, tools, maxOutputTokens, contextBudget);
    const response = await provider.chat({ model: effectiveModel, messages, reasoning, signal, tools, toolChoice, maxOutputTokens: contextBudget.reservedOutputTokens ?? maxOutputTokens });
    return {
      ...(response && typeof response === 'object' ? response : { text: String(response ?? '') }),
      contextBudget,
      providerId: provider.id,
      requestedModel: typeof model === 'string' && model.trim() ? model.trim() : 'provider-default',
      resolvedModel: typeof response?.model === 'string' && response.model.trim() ? response.model.trim() : null,
      toolCalling: (typeof provider.supportsToolsForModel === 'function'
        ? provider.supportsToolsForModel(effectiveModel) : provider.supportsTools) === true ? 'supported' : 'unsupported'
    };
  }

  // IPC 家族命名说明：控制面早已有 model.defaults.* / model.catalog.*（DSH 模型管理，
  // 经 control.execute 走 controlService）。为避免前缀碰撞，Model Runtime 的私有方法族
  // 使用 modelrt.* —— 二级白名单见 bridge.js dispatchCommand。
  const handlers = {
    'modelrt.providers.list': () => ({ providers: listProviders() }),
    'modelrt.models.list': (params) => listModels(params?.provider ?? null),
    'modelrt.health': (params) => health(params?.provider ?? null)
  };

  return {
    imageInputCapabilities(providerId,model=null){const p=resolveProvider(providerId);return p.imageInputCapabilities?.(model||p.defaultModel)??{supported:false,status:'unknown'};},
    modelCapabilities,
    resolveProvider,
    defaultProviderId,
    listProviders,
    hasKey,
    contextBudget(providerId, model = null, request = {}) {
      const provider = resolveProvider(providerId);
      return calculateModelContextBudget({ ...request, provider, model: model || provider.defaultModel });
    },
    promptCacheCapabilities(providerId, model = null) {
      const provider = resolveProvider(providerId);
      return provider.promptCacheCapabilities(model || provider.defaultModel);
    },
    supportsToolCalling(providerId, model = null) {
      const provider = resolveProvider(providerId);
      return typeof provider.supportsToolsForModel === 'function'
        ? provider.supportsToolsForModel(model || provider.defaultModel) === true
        : provider.supportsTools === true;
    },
    listModels,
    health,
    stream,
    chat,
    providerIds: () => registry.ids(),
    isRegistered: (id) => registry.has(id),
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(modelRuntimeError('METHOD_NOT_FOUND', `未知 Model Runtime 方法：${String(method ?? '')}`));
      }return Promise.resolve().then(() => handler(params ?? {}));
    }
  };
}
