// Agent Provider 注册与 agent.* 私有方法族（阶段 06）。
//
// 与 chat.* / memory.* / task.* 同一接入模式：桌面 Shell 经命名管道调用，
// 本模块只做 Provider 白名单 + 参数转发，不做主体判定（IPC 面仅桌面可达）。
// 方法名 = AgentProvider 契约方法名；provider id 是必填首参。
// 事件流（agent.follow）是有状态的 async generator，不经一元 IPC 暴露——
// 需要进度的进程内消费方直接持有 provider 对象（chat-service / 后续 Task Runtime）。
import { agentProviderError } from './agent-provider.js';
import { createDshAgentProvider } from './dsh-agent-provider.js';

/**
 * 便捷组合：标准 AgentProvider 服务 + 内置 DSH Provider（复用 bridge 的共享
 * NodeApiClient）。bridge.js 只需导入这一个符号，避免与 continuity 侧同名的
 * 窄接口 DSH provider 产生导入冲突。
 */
export function createDefaultAgentService({ api, defaults, log } = {}) {
  return createAgentService({
    providers: [createDshAgentProvider({ api, defaults, log })],
    log
  });
}

export function createAgentService({ providers, log = () => {} } = {}) {
  const byId = new Map();
  for (const provider of providers ?? []) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new Error('createAgentService 的 provider 缺少 id');
    }
    if (byId.has(provider.id)) {
      throw new Error(`createAgentService 的 provider id 重复：${provider.id}`);
    }
    byId.set(provider.id, provider);
  }

  function providerOrThrow(id) {
    const provider = byId.get(String(id ?? ''));
    if (!provider) {
      throw agentProviderError('INVALID_PARAMS', `未知 Agent Provider：${String(id ?? '(空)')}`);
    }
    return provider;
  }

  function requireSessionId(params) {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw agentProviderError('INVALID_PARAMS', 'sessionId 不能为空');
    }
    return sessionId;
  }

  const handlers = {
    'agent.list': () => ({
      providers: [...byId.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        eventProtocol: provider.eventProtocol,
        capabilities: provider.capabilities()
      }))
    }),
    'agent.capabilities': (params) => ({ capabilities: providerOrThrow(params?.provider).capabilities() }),
    'agent.health': async (params) => {
      const provider = providerOrThrow(params?.provider);
      if (typeof provider.health !== 'function') return { available: true, provider: provider.id };
      return provider.health();
    },
    'agent.createSession': (params) => {
      const provider = providerOrThrow(params?.provider);
      return provider.createSession({
        cwd: params?.cwd,
        model: params?.model,
        reasoningEffort: params?.reasoningEffort,
        modelProvider: params?.modelProvider
      });
    },
    'agent.send': (params) => {
      const provider = providerOrThrow(params?.provider);
      return provider.send({ sessionId: requireSessionId(params), content: params?.content, mode: params?.mode });
    },
    'agent.cancel': (params) => providerOrThrow(params?.provider).cancel({ sessionId: requireSessionId(params) }),
    'agent.status': (params) => providerOrThrow(params?.provider).status({ sessionId: requireSessionId(params) }),
    'agent.contextUsage': (params) => providerOrThrow(params?.provider).contextUsage({ sessionId: requireSessionId(params) }),
    // checkpoint / handoff：契约要求显式 unsupported —— 直接透传 Provider 的拒绝桩。
    'agent.checkpoint': (params) => providerOrThrow(params?.provider).checkpoint({ sessionId: params?.sessionId }),
    'agent.handoff': (params) => providerOrThrow(params?.provider).handoff(params ?? {}),
    'agent.resume': (params) => providerOrThrow(params?.provider).resume({ sessionId: requireSessionId(params) }),
    'agent.closeSession': (params) => providerOrThrow(params?.provider).closeSession({ sessionId: requireSessionId(params) }),
    'agent.selectModel': (params) => {
      const provider = providerOrThrow(params?.provider);
      return provider.selectModel({
        sessionId: requireSessionId(params),
        model: params?.model,
        reasoningEffort: params?.reasoningEffort,
        modelProvider: params?.modelProvider
      });
    }
  };

  return {
    /** 供进程内消费方（chat-service 等）枚举可选择的 Provider（静态注册表，不含可用性）。 */
    listProviders() {
      return [...byId.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        eventProtocol: provider.eventProtocol
      }));
    },

    getProvider(id) {
      return byId.get(String(id ?? '')) ?? null;
    },

    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(agentProviderError('METHOD_NOT_FOUND', `未知 Agent 方法：${String(method ?? '')}`));
      }
      return Promise.resolve().then(() => handler(params ?? {}));
    },

    close() {
      // DshAgentProvider 无常驻资源（follow 流由消费方持有并自行 abort）；
      // 预留：引入有常驻资源的 Provider 时在此统一收口。
      log('Agent Provider 服务已关闭');
    }
  };
}
