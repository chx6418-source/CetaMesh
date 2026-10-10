// Model Runtime 服务（会话 1 / TASK-S1-001/002）。
//
// 职责：Provider 解析（显式指定或按 Key 配置自动选择）、模型目录、回合执行入口、
// health；并把少量方法以 model.* 私有方法族暴露给桌面 Shell（模型列表 / 健康）。
// 回合执行（chat/stream）只供进程内消费方（desktop/chat-service.js）直接调用，
// 与 agent.* 的 follow 流同理不经一元 IPC 暴露。
//
// Key 纪律：本层只返回 hasKey 布尔，任何列表/目录/错误都不携带 Key 材料。
import { modelRuntimeError, MODEL_ERROR_CODES } from './types.js';

export function createModelRuntimeService({ registry, secrets, log = () => {} } = {}) {
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

  /** 解析 Provider：显式 id 必须已注册且已配置 Key；null 时按注册顺序取第一个有 Key 的。 */
  function resolveProvider(providerId) {
    if (providerId === null || providerId === undefined || providerId === '') {
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
    for (const id of registry.ids()) {
      if (hasKey(id)) return id;
    }
    return null;
  }

  function listProviders() {
    return registry.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      hasKey: hasKey(provider.id)
    }));
  }

  async function listModels(providerId) {
    const provider = resolveProvider(providerId);
    try {
      const models = await provider.listModels({});
      return { provider: provider.id, models, error: null };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : MODEL_ERROR_CODES.MODEL_PROVIDER_ERROR;
      return { provider: provider.id, models: [], error: String(error?.message ?? error), code };
    }
  }

  async function health(providerId) {
    const provider = resolveProvider(providerId);
    try {
      return await provider.health({});
    } catch (error) {
      return { available: false, provider: provider.id, reason: String(error?.message ?? error) };
    }
  }

  /** 回合流入口：chat-service 传 providerId（已解析）或 null（自动）。 */
  function stream({ providerId, model, messages, reasoning, signal }) {
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
    return provider.stream({
      model: effectiveModel,
      requestedModel: typeof model === 'string' && model.trim() ? model.trim() : 'provider-default',
      messages,
      reasoning,
      signal
    });
  }

  async function chat({ providerId, model, messages, reasoning, signal, tools, toolChoice }) {
    const provider = resolveProvider(providerId);
    const effectiveModel = typeof model === 'string' && model.trim() ? model.trim() : provider.defaultModel;
    if (!effectiveModel) {
      throw modelRuntimeError(
        MODEL_ERROR_CODES.MODEL_NO_MODEL,
        `Model Provider「${provider.label}」未指定模型且没有默认模型`
      );
    }
    if (Array.isArray(tools) && tools.length && provider.supportsTools !== true) {
      throw modelRuntimeError('MODEL_TOOL_CALLING_UNSUPPORTED', 'This Model Provider does not support structured tool calling');
    }
    const response = await provider.chat({ model: effectiveModel, messages, reasoning, signal, tools, toolChoice });
    return {
      ...(response && typeof response === 'object' ? response : { text: String(response ?? '') }),
      providerId: provider.id,
      requestedModel: typeof model === 'string' && model.trim() ? model.trim() : 'provider-default',
      resolvedModel: typeof response?.model === 'string' && response.model.trim() ? response.model.trim() : null,
      toolCalling: provider.supportsTools === true ? 'supported' : 'unsupported'
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
    resolveProvider,
    defaultProviderId,
    listProviders,
    hasKey,
    supportsToolCalling(providerId) {
      return resolveProvider(providerId).supportsTools === true;
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
