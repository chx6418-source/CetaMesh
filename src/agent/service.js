// Agent Provider 注册与 agent.* 私有方法族（阶段 06；会话 2 改为 Agent Broker 支撑）。
//
// 与 chat.* / memory.* / task.* 同一接入模式：桌面 Shell 经命名管道调用，
// 本模块只做 Provider 白名单 + 参数转发，不做主体判定（IPC 面仅桌面可达）。
// 方法名 = AgentProvider 契约方法名；provider id 是必填首参。
// 事件流（agent.follow）是有状态的 async generator，不经一元 IPC 暴露——
// 需要进度的进程内消费方直接经 Agent Broker（broker.follow）消费。
import { agentProviderError, defineAgentProvider } from './agent-provider.js';
import { createAgentProviderRegistry } from './registry.js';
import { createAgentBroker } from './broker.js';
import { createDshAgentProvider } from './dsh-agent-provider.js';
import { createStagedDshAgentProvider } from './staged-dsh-agent-provider.js';
import { createCodexAgentProvider } from './codex-agent-provider.js';
import { createZCodeAgentProvider } from './zcode-agent-provider.js';

function createUnavailableDshProvider() {
  const unavailable = async () => {
    throw agentProviderError('PROVIDER_UNAVAILABLE', 'DSH transport is not connected');
  };
  return defineAgentProvider({
    id: 'dsh', label: 'DSH Agent', eventProtocol: 'dsh-session-events',
    capabilityExtras: {
      displayName: 'DSH', available: false, reason: 'not_connected', version: null, health: 'unavailable',
      workspaceBoundary: 'unverified', supportsFreshSession: true, supportsResume: true,
      contextUsage: { available: true }
    },
    methods: {
      createSession: unavailable, send: unavailable, cancel: unavailable, status: unavailable,
      contextUsage: unavailable, resume: unavailable, closeSession: unavailable, selectModel: unavailable,
      health: async () => ({ provider: 'dsh', available: false, reason: 'not_connected' }),
      async *follow() { unavailable(); }
    }
  });
}

function summarizeProvider(provider, health = null) {
  const capabilities = provider.capabilities();
  const registryAvailable = typeof capabilities.available === 'boolean' ? capabilities.available : null;
  const healthAvailable = typeof health?.available === 'boolean' ? health.available : null;
  const available = healthAvailable ?? registryAvailable;
  const reason = health?.reason ?? capabilities.reason ?? null;
  return {
    id: provider.id,
    displayName: capabilities.displayName ?? (provider.id === 'dsh' ? 'DSH' : provider.label),
    label: provider.label,
    eventProtocol: provider.eventProtocol,
    available,
    version: capabilities.version ?? health?.version ?? null,
    reason,
    workspaceBoundary: capabilities.workspaceBoundary ?? 'unsupported',
    supportsFreshSession: capabilities.supportsFreshSession === true,
    supportsResume: capabilities.supportsResume === true,
    contextUsage: capabilities.contextUsage ?? { available: capabilities.supported?.contextUsage === true },
    health: health ?? { available: capabilities.available === true, status: capabilities.health ?? 'unknown' },
    capabilities
  };
}

/**
 * Compose the Agent registry and Broker. The desktop composition root injects a shared
 * NodeApiClient when the legacy runtime is present; Core may omit DSH entirely.
 * The returned .broker supports process-local turn-end wiring for Chat and Continuity.
 */
export function createDefaultAgentService({ api, defaults, log, dshOptions = {}, codexOptions = {}, codexExecutable,
  zcodeOptions = {}, zcodeExecutable, desktopStatus = null } = {}) {
  const dshProvider = api ? createDshAgentProvider({ api, defaults, log }) : createUnavailableDshProvider();
  const taskBoundDsh = api && typeof dshOptions.resolveTaskWorkspace === 'function' && typeof dshOptions.applyChanges === 'function'
    ? createStagedDshAgentProvider({ ...dshOptions, provider: dshProvider, log })
    : dshProvider;
  const registry = createAgentProviderRegistry({
    providers: [
      taskBoundDsh,
      createCodexAgentProvider({ ...codexOptions, ...(codexOptions.executable === undefined && codexExecutable !== undefined ? { executable: codexExecutable } : {}), log }),
      createZCodeAgentProvider({ ...zcodeOptions, ...(zcodeOptions.executable === undefined && zcodeExecutable !== undefined ? { executable: zcodeExecutable } : {}) })
    ]
  });
  const broker = createAgentBroker({ registry, log });
  const service = createAgentService({ broker, log, desktopStatus });
  return Object.assign(service, { broker, registry });
}

export function createAgentService({ broker, log = () => {}, desktopStatus = null } = {}) {
  if (!broker || typeof broker.require !== 'function' || typeof broker.registry !== 'object') {
    throw agentProviderError('INVALID_PARAMS', 'createAgentService 需要 Agent Broker');
  }
  const registry = broker.registry;

  const handlers = {
    'agent.list': async () => ({
      providers: await Promise.all(registry.list().map(async (provider) => {
        let health = null;
        try { health = await broker.health(provider.id); }
        catch (error) { health = { provider: provider.id, available: false, reason: error?.code ?? 'health_failed' }; }
        const summary = summarizeProvider(provider, health);
        if (provider.id === 'dsh' && typeof desktopStatus === 'function') {
          try {
            const desktop = await desktopStatus();
            if (desktop) summary.desktopApp = {
              status: desktop.status ?? 'unknown',
              installed: desktop.installed === true,
              running: desktop.running === true,
              version: desktop.version ?? null,
              lastCheckedAt: desktop.lastCheckedAt ?? null
            };
          } catch (error) {
            // Optional Desktop detection must never make the Agent directory unavailable.
            summary.desktopApp = { status: 'unknown', installed: false, running: false, version: null, reason: error?.code ?? 'detection_failed' };
          }
        }
        return summary;
      }))
    }),
    'agent.capabilities': (params) => ({ capabilities: broker.capabilities(params?.provider) }),
    'agent.health': (params) => broker.health(params?.provider, { refresh: params?.refresh === true }),
    'agent.createSession': (params) => {
      const boundary = broker.capabilities(params?.provider)?.workspaceBoundary;
      if (boundary === 'capability-broker' || boundary === 'staged-capability-broker') {
        throw agentProviderError('TASK_REQUIRED', 'Workspace-bound Agents must start through Task assignment');
      }
      if (boundary !== 'unsupported') {
        throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', 'Provider has no verified Task Workspace boundary');
      }
      return broker.createSession(params?.provider, {
        cwd: params?.cwd, model: params?.model,
        reasoningEffort: params?.reasoningEffort, modelProvider: params?.modelProvider,
        taskId: params?.taskId, workspaceId: params?.workspaceId
      });
    },
    'agent.send': (params) => broker.send({
      provider: params?.provider,
      sessionId: params?.sessionId,
      content: params?.content,
      mode: params?.mode
    }),
    'agent.cancel': (params) => broker.cancel({ provider: params?.provider, sessionId: params?.sessionId }),
    'agent.status': (params) => params?.sessionId
      ? broker.status({ provider: params?.provider, sessionId: params?.sessionId })
      : broker.health(params?.provider),
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
    'agent.nativeHandoff': (params) => broker.nativeHandoff({ provider: params?.provider, ...(params ?? {}) }),
    'agent.configure': (params) => {
      const provider = broker.require(params?.provider);
      if (typeof provider.configure !== 'function') {
        return { provider: provider.id, supported: false, reason: 'CONFIGURATION_UNSUPPORTED' };
      }
      const settings = params?.settings ?? {};
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw agentProviderError('INVALID_PARAMS', 'agent.configure.settings must be an object');
      }
      return provider.configure(settings);
    }
  };

  return {
    broker,
    registry,

    /** 供进程内消费方（chat-service 等）枚举可选择的 Provider（静态注册表，不含可用性）。 */
    listProviders() {
      return registry.list().map((provider) => {
        const capabilities = provider.capabilities();
        return {
          id: provider.id,
          label: provider.label,
          displayName: capabilities.displayName ?? provider.label,
          eventProtocol: provider.eventProtocol,
          available: typeof capabilities.available === 'boolean' ? capabilities.available : null,
          version: capabilities.version ?? null,
          reason: capabilities.reason ?? null,
          workspaceBoundary: capabilities.workspaceBoundary ?? 'unsupported',
          supportsFreshSession: capabilities.supportsFreshSession === true,
          supportsResume: capabilities.supportsResume === true,
          contextUsage: capabilities.contextUsage ?? null,
          health: capabilities.health ?? 'unknown'
        };
      });
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
      for (const provider of registry.list()) {
        try {
          const shutdown = provider.shutdown?.();
          if (shutdown?.catch) shutdown.catch((error) => log(`Agent Provider ${provider.id} shutdown failed: ${error?.code ?? 'PROVIDER_ERROR'}`));
        } catch (error) { log(`Agent Provider ${provider.id} shutdown failed: ${error?.code ?? 'PROVIDER_ERROR'}`); }
      }
      log('Agent Provider 服务已关闭');
    }
  };
}
