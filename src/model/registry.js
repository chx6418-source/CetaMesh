// Model Provider 注册表（会话 1 / TASK-S1-001）。
//
// 注册顺序即解析优先级（defaultProviderId 从前往后找第一个已配置 Key 的 Provider）。
// 注册表只持有 Provider 实例，不持有任何凭据。
import { modelRuntimeError, MODEL_ERROR_CODES } from './types.js';

export function createModelProviderRegistry({ providers = [] } = {}) {
  const byId = new Map();
  const order = [];

  function register(provider) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new Error('createModelProviderRegistry.register 需要 provider.id');
    }
    if (byId.has(provider.id)) {
      throw new Error(`Model Provider id 重复：${provider.id}`);
    }
    byId.set(provider.id, provider);
    order.push(provider.id);
    return provider;
  }

  for (const provider of providers) register(provider);

  return Object.freeze({
    register,
    get(id) {
      return byId.get(String(id ?? '')) ?? null;
    },
    require(id) {
      const provider = byId.get(String(id ?? ''));
      if (!provider) {
        throw modelRuntimeError(
          MODEL_ERROR_CODES.MODEL_PROVIDER_UNKNOWN,
          `未知 Model Provider：${String(id ?? '(空)')}`
        );
      }
      return provider;
    },
    has(id) {
      return byId.has(String(id ?? ''));
    },
    ids() {
      return [...order];
    },
    list() {
      return order.map((id) => byId.get(id));
    }
  });
}
