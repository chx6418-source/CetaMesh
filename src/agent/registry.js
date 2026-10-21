// Agent Provider 注册表（会话 2 / TASK-S2-002）。
//
// 唯一正式 Agent Provider 注册表：Chat / Task / Continuity 一律经 Agent Broker
// 使用这里登记的 Provider，不允许任何消费方绕过 Broker 直接持有 DSH 通道。
// 注册表只持有 Provider 实例与注册顺序，不做可用性判断（可用性走 provider.health）。
import { agentProviderError } from './agent-provider.js';

export function createAgentProviderRegistry({ providers = [] } = {}) {
  const byId = new Map();
  const order = [];

  function register(provider) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw agentProviderError('INVALID_PARAMS', 'Agent Provider 注册需要 id');
    }
    if (typeof provider.capabilities !== 'function') {
      throw agentProviderError(
        'INVALID_PARAMS',
        `Agent Provider「${provider.id}」缺少 capabilities()（须经 defineAgentProvider 定义）`
      );
    }
    if (byId.has(provider.id)) {
      throw agentProviderError('INVALID_PARAMS', `Agent Provider id 重复：${provider.id}`);
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
        throw agentProviderError(
          'AGENT_PROVIDER_UNKNOWN',
          `未知 Agent Provider：${String(id ?? '(空)')}`
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
