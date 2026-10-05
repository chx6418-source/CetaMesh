// Agent Provider 注册与 agent.* 私有方法族（阶段 06；会话 2 改为 Agent Broker 支撑）。
//
// 与 chat.* / memory.* / task.* 同一接入模式：桌面 Shell 经命名管道调用，
// 本模块只做 Provider 白名单 + 参数转发，不做主体判定（IPC 面仅桌面可达）。
// 方法名 = AgentProvider 契约方法名；provider id 是必填首参。
// 事件流（agent.follow）是有状态的 async generator，不经一元 IPC 暴露——
// 需要进度的进程内消费方直接经 Agent Broker（broker.follow）消费。
import { agentProviderError } from './agent-provider.js';
import { createAgentProviderRegistry } from './registry.js';
import { createAgentBroker } from './broker.js';
import { createDshAgentProvider } from './dsh-agent-provider.js';

/**
 * 便捷组合：注册表 + Agent Broker + 内置 DSH Provider（复用 bridge 的共享
 * NodeApiClient）。返回的服务对象带 .broker 引用——bridge 需要它接线回合结束
 * 事件（chat-service onTurnEnd → broker.reportTurnEnd → Continuity）。
 */
export function createDefaultAgentService({ api, defaults, log } = {}) {
  const registry = createAgentProviderRegistry({
    providers: [createDshAgentProvider({ api, defaults, log })]
  });
  const broker = createAgentBroker({ registry, log });
  const service = createAgentService({ broker, log });
  return Object.assign(service, { broker, registry });
}

export function createAgentService({ broker, log = () => {} } = {}) {
  if (!broker || typeof broker.require !== 'function' || typeof broker.registry !== 'object') {
    throw agentProviderError('INVALID_PARAMS', 'createAgentService 需要 Agent Broker');
  }
  const registry = broker.registry;

  const handlers = {
    'agent.list': () => ({
      providers: registry.list().map((provider) => ({
        id: provider.id,
        label: provider.label,
        eventProtocol: provider.eventProtocol,
        capabilities: provider.capabilities()
      }))
    }),
    'agent.capabilities': (params) => ({ capabilities: broker.capabilities(params?.provider) }),
    'agent.health': (params) => broker.health(params?.provider),
    'agent.createSession': (params) => broker.createSession(params?.provider, {
      cwd: params?.cwd,
      model: params?.model,
      reasoningEffort: params?.reasoningEffort,
      modelProvider: params?.modelProvider
    }),
    'agent.send': (params) => broker.send({
      provider: params?.provider,
      sessionId: params?.sessionId,
      content: params?.content,
      mode: params?.mode
    }),
    'agent.cancel': (params) => broker.cancel({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.status': (params) => broker.status({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.contextUsage': (params) => broker.contextUsage({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.resume': (params) => broker.resume({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.closeSession': (params) => broker.closeSession({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.selectModel': (params) => broker.selectModel({
      provider: params?.provider,
      sessionId: params?.sessionId,
      model: params?.model,
      reasoningEffort: params?.reasoningEffort,
      modelProvider: params?.modelProvider
    }),
    // 可选能力：Broker 包装为 { supported:false, reason:'UNSUPPORTED' } 形状，不伪造。
    'agent.archiveSession': (params) => broker.archiveSession({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.nativeCheckpoint': (params) => broker.nativeCheckpoint({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.nativeHandoff': (params) => broker.nativeHandoff({ provider: params?.provider, ...(params ?? {}) })
  };

  return {
    broker,
    registry,

    /** 供进程内消费方（chat-service 等）枚举可选择的 Provider（静态注册表，不含可用性）。 */
    listProviders() {
      return registry.list().map((provider) => ({
        id: provider.id,
        label: provider.label,
        eventProtocol: provider.eventProtocol
      }));
    },

    getProvider(id) {
      return registry.get(id);
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
      // Broker.close 清空回合结束监听器。
      broker.close();
      log('Agent Provider 服务已关闭');
    }
  };
}
