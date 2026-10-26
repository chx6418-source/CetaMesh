// Agent Broker（会话 2 / TASK-S2-002）。
//
// 唯一的 Agent 会话门面：Chat / Task / Continuity 只依赖 Broker，不直接依赖任何
// 具体 Agent Runtime（DSH 只是第一个真实 Provider）。职责：
//   1) 注册表收口（registry.js）——单一 AgentProvider 契约的事实源；
//   2) 会话操作统一分发（createSession/send/cancel/status/contextUsage/resume/
//      closeSession/selectModel/follow/health），provider id 是必填首参；
//   3) 可选能力的诚实包装——archiveSession / nativeCheckpoint / nativeHandoff
//      不支持时返回 { supported:false, reason:'UNSUPPORTED' } 形状，不抛断、不伪造；
//   4) 回合结束事件扇出（onTurnEnd / reportTurnEnd）——回合机（chat-service、
//      未来的 Task 执行器）上报真实 usage / 字符估算，Continuity 据此驱动
//      Context Monitor 与自动 rollover。Broker 不知道 Continuity 的存在，
//      依赖方向仍然是 Continuity → Broker。
import crypto from 'node:crypto';
import { describeAgentExecutionSecurity, isNativePermissionSecurity } from './execution-security.js';
import { AGENT_PROVIDER_OPTIONAL_METHODS, agentProviderError } from './agent-provider.js';

const TASK_WORKSPACE_BOUNDARIES = new Set(['capability-broker', 'staged-capability-broker', 'native-staged']);

export function createAgentBroker({ registry, log = () => {}, resolveWorkspaceIdentity = () => null, resolveExecutionTask = null, isTaskHandoffInFlight = () => false } = {}) {
  if (!registry || typeof registry.require !== 'function' || typeof registry.register !== 'function') {
    throw agentProviderError('INVALID_PARAMS', 'createAgentBroker 需要 Agent Provider 注册表');
  }
  const executionConsents = new Map();
  const executionBindings = new Map();
  let taskExecutionObserver = null;
  const consentKey = (provider, workspaceId) => JSON.stringify([provider, workspaceId]);
  function securityScope(providerId, workspaceId) {
    const scope = describeAgentExecutionSecurity(requireProvider(providerId), workspaceId, resolveWorkspaceIdentity(workspaceId));
    return { ...scope, authorized: !scope.required || executionConsents.get(consentKey(providerId, workspaceId)) === scope.fingerprint };
  }
  function assertExecutionConsent(providerId, { workspaceId } = {}) {
    const scope = securityScope(providerId, workspaceId);
    if (!scope.required) return scope;
    if (scope.security.mode === 'native-permissions') {
      if (!isNativePermissionSecurity(scope.security)) throw agentProviderError('AGENT_NATIVE_PERMISSION_POLICY_UNVERIFIED', 'Native per-tool approval policy has not been verified');
    } else {
      if (scope.security.mode === 'isolated' && scope.security.strictIsolationVerified !== true) throw agentProviderError('ISOLATED_ENVIRONMENT_UNVERIFIED', 'Strict isolation has not been verified');
      if (scope.security.nativeSandboxSupported !== true) throw agentProviderError('AGENT_NATIVE_SANDBOX_UNSUPPORTED', 'Selected native sandbox is not supported');
    }
    if (!workspaceId || !scope.authorized) throw agentProviderError('AGENT_SECURITY_CONFIRMATION_REQUIRED', '请先确认此 Agent 的原生执行范围；确认不会授予新的平台工具权限');
    return scope;
  }
  const turnEndListeners = new Set();
  // Native request IDs are local to a Session; retain bounded Core provenance.
  const runMetadata = new Map();
  const nativeDispatching = new Set();
  const runKey = (provider, sessionId, kind, id) => JSON.stringify([provider, sessionId, kind, String(id)]);
  function rememberRun(provider, sessionId, result, metadata) {
    for (const [kind, id] of [['request', result?.requestId], ['turn', result?.turnId]]) {
      if (id === undefined || id === null) continue;
      runMetadata.set(runKey(provider, sessionId, kind, id), metadata);
    }
    while (runMetadata.size > 4096) runMetadata.delete(runMetadata.keys().next().value);
  }

  function requireProvider(providerId) {
    try {
      return registry.require(providerId);
    } catch (error) {
      if (error?.code === 'AGENT_PROVIDER_UNKNOWN') throw error;
      throw error;
    }
  }

  function requireSessionId(params) {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw agentProviderError('INVALID_PARAMS', 'sessionId 不能为空');
    }
    return sessionId;
  }

  /**
   * 可选能力的包装：Provider 支持 → 透传结果并标 supported:true；
   * 显式 unsupported 桩（AGENT_UNSUPPORTED）→ 结构化 { supported:false }，不抛断。
   * 其他错误（传输/业务）原样上抛——包装只收敛"能力缺失"，不吞真错误。
   */
  async function optionalCall(provider, method, params) {
    try {
      const value = await provider[method](params);
      return { ...(value ?? {}), provider: provider.id, supported: true };
    } catch (error) {
      if (error?.code === 'AGENT_UNSUPPORTED') {
        return {
          provider: provider.id,
          supported: false,
          reason: 'UNSUPPORTED',
          note: `Agent Provider「${provider.label}」不支持 ${method}`
        };
      }
      throw error;
    }
  }

  return {
    registry,
    setTaskExecutionObserver(observer) { taskExecutionObserver = observer; },

    describeExecutionSecurity: securityScope,
    assertExecutionConsent,
    // Trusted in-process hook, called only by the existing high-risk Owner capability.
    // Public Agent IPC never exposes this operation.
    authorizeExecution(providerId, workspaceId, fingerprint) {
      const scope = securityScope(providerId, workspaceId);
      if (!workspaceId || !scope.required || fingerprint !== scope.fingerprint) throw agentProviderError('AGENT_SECURITY_POLICY_CHANGED', 'Agent execution policy changed; review again');
      if (scope.security.mode === 'native-permissions') {
        if (!isNativePermissionSecurity(scope.security)) throw agentProviderError('AGENT_NATIVE_PERMISSION_POLICY_UNVERIFIED', 'Native per-tool approval policy has not been verified');
      } else {
        if (scope.security.mode === 'isolated' && scope.security.strictIsolationVerified !== true) throw agentProviderError('ISOLATED_ENVIRONMENT_UNVERIFIED', 'Strict isolation has not been verified');
        if (scope.security.nativeSandboxSupported !== true) throw agentProviderError('AGENT_NATIVE_SANDBOX_UNSUPPORTED', 'Selected native sandbox is unsupported');
      }
      executionConsents.set(consentKey(providerId, workspaceId), fingerprint);
      while (executionConsents.size > 256) executionConsents.delete(executionConsents.keys().next().value);
      return { authorized: true, fingerprint };
    },

    // ── Provider 管理 ────────────────────────────────────────────────────────
    register(provider) {
      return registry.register(provider);
    },
    get(id) {
      return registry.get(id);
    },
    require(id) {
      return registry.require(id);
    },
    has(id) {
      return registry.has(id);
    },
    ids() {
      return registry.ids();
    },
    listProviders() {
      return registry.list().map((provider) => ({
        id: provider.id,
        label: provider.label,
        eventProtocol: provider.eventProtocol
      }));
    },
    capabilities(providerId) {
      return requireProvider(providerId).capabilities();
    },

    // ── 会话操作（统一入口；provider id 必填首参） ────────────────────────────
    async createSession(providerId, params = {}) {
      const provider = requireProvider(providerId);
      const capabilities = provider.capabilities();
      const boundary = capabilities?.workspaceBoundary;
      if (boundary !== undefined && boundary !== null && !TASK_WORKSPACE_BOUNDARIES.has(boundary) && boundary !== 'unverified' && boundary !== 'unsupported') {
        throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', `Provider ${provider.id} declares an unknown workspace boundary`);
      }
      if (boundary === 'unverified' || boundary === undefined || boundary === null) {
        throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', `Provider ${provider.id} has no verified Task Workspace boundary`);
      }
      if (TASK_WORKSPACE_BOUNDARIES.has(boundary)) {
        if (typeof params?.taskId !== 'string' || !params.taskId.trim()
          || typeof params?.workspaceId !== 'string' || !params.workspaceId.trim()) {
          throw agentProviderError('TASK_REQUIRED', 'Workspace-bound Agents require a Task and Workspace binding');
        }
      }
      const executionSecurity = assertExecutionConsent(providerId, params);
      const created = await provider.createSession({
        ...(['staged-capability-broker', 'native-staged'].includes(boundary) ? {} : { cwd: params?.cwd }),
        taskId: params?.taskId,
        workspaceId: params?.workspaceId,
        model: params?.model,
        reasoningEffort: params?.reasoningEffort,
        modelProvider: params?.modelProvider,
        purpose: params?.purpose
      });
      if (created?.sessionId) {
        executionBindings.set(consentKey(providerId, created.sessionId), { workspaceId: params.workspaceId, taskId: params.taskId,
          securityRequired: executionSecurity.required, securityFingerprint: executionSecurity.fingerprint });
        while (executionBindings.size > 4096) executionBindings.delete(executionBindings.keys().next().value);
      }
      return created;
    },

    async send({ provider: providerId, sessionId, content, mode, phase = 'user', runId = crypto.randomUUID() } = {}) {
      const provider = requireProvider(providerId);
      requireSessionId({ sessionId });
      if (!['user', 'bootstrap', 'system', 'approval'].includes(phase)
        || typeof runId !== 'string' || !runId || runId.length > 240) {
        throw agentProviderError('INVALID_PARAMS', 'Agent run requires a bounded Core identity and phase');
      }
      const binding = executionBindings.get(consentKey(providerId, sessionId));
      const declaredSecurity = provider.capabilities()?.security;
      if (binding?.securityRequired || (declaredSecurity !== undefined && declaredSecurity !== null)) {
        if (!binding) throw agentProviderError('AGENT_SECURITY_SESSION_UNBOUND', 'Native Session must be created through the authorized Broker');
        const scope = assertExecutionConsent(providerId, binding);
        if (binding.securityRequired && (!scope.required || binding.securityFingerprint !== scope.fingerprint)) {
          throw agentProviderError('AGENT_SECURITY_POLICY_CHANGED', 'Session execution policy changed; create a fresh authorized Session');
        }
        if (phase !== 'bootstrap' && isTaskHandoffInFlight(binding.taskId)) {
          throw agentProviderError('TASK_HANDOFF_IN_PROGRESS', 'Task execution is owned by an active Handoff');
        }
        if (typeof resolveExecutionTask === 'function') {
          const task = resolveExecutionTask(binding.taskId);
          if (!task || task.workspaceId !== binding.workspaceId
            || task.currentAgent?.provider !== providerId || task.currentAgent?.sessionId !== sessionId
            || (phase !== 'bootstrap' && task.status !== 'running')
            || ['completed', 'failed', 'cancelled'].includes(task.status)) {
            throw agentProviderError('TASK_NOT_AUTHORIZED', 'Native Session no longer owns an executable Task');
          }
        }
      }
      const observation = { taskId: binding?.taskId, provider: providerId, sessionId, runId, phase };
      const singleFlight = provider.capabilities()?.workspaceBoundary === 'native-staged';
      const dispatchKey = consentKey(providerId, sessionId);
      if (singleFlight && nativeDispatching.has(dispatchKey)) throw agentProviderError('TURN_BUSY', 'Native Session already has a dispatch in progress');
      if (singleFlight) nativeDispatching.add(dispatchKey);
      let observed = false;
      try {
        // Known pre-effect busy/unknown state must not replace the real current run
        // or allocate a Follow obligation for a turn that will never exist.
        if (singleFlight) {
          const status = await provider.status({ sessionId });
          if (status.running || status.waitingForApproval || status.approvalId || Number(status.queued) > 0) throw agentProviderError('TURN_BUSY', 'Native Session is active or waiting for approval');
          if (status.running !== false || status.runtimeValid === false || status.state === 'unknown' || status.lastRunStatus === 'unknown') throw agentProviderError('AGENT_OUTCOME_UNKNOWN', 'Native Session requires reconciliation before dispatch');
        }
        if (binding?.taskId && phase === 'user') { taskExecutionObserver?.({ ...observation, state: 'running' }); observed = true; }
        const metadata = { phase, runId };
        const result = await provider.send({ sessionId, content, mode, phase, runId,
          onRequestId: requestId => rememberRun(providerId, sessionId, { requestId }, metadata) });
        if (result?.accepted === true) rememberRun(providerId, sessionId, result, { phase, runId });
        else if (binding?.taskId) taskExecutionObserver?.({ ...observation, state: 'unknown' });
        return result;
      } catch (error) {
        if (observed) taskExecutionObserver?.({ ...observation, state: 'unknown' });
        throw error;
      } finally { if (singleFlight) nativeDispatching.delete(dispatchKey); }
    },

    async cancel({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return provider.cancel({ sessionId: requireSessionId({ sessionId }) });
    },

    async status({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return provider.status({ sessionId: requireSessionId({ sessionId }) });
    },

    async contextUsage({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return provider.contextUsage({ sessionId: requireSessionId({ sessionId }) });
    },

    async resume({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return provider.resume({ sessionId: requireSessionId({ sessionId }) });
    },

    async closeSession({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return provider.closeSession({ sessionId: requireSessionId({ sessionId }) });
    },

    async selectModel({ provider: providerId, sessionId, model, reasoningEffort, modelProvider } = {}) {
      const provider = requireProvider(providerId);
      return provider.selectModel({
        sessionId: requireSessionId({ sessionId }),
        model,
        reasoningEffort,
        modelProvider
      });
    },

    follow({ provider: providerId, sessionId, signal, sinceSequence } = {}) {
      const provider = requireProvider(providerId);
      const source = provider.follow({ sessionId: requireSessionId({ sessionId }), signal, sinceSequence });
      return (async function* () {
        for await (const item of source) {
          const event = item?.type === 'event' ? item.event : item;
          const data = event?.data;
          const metadata = data && (runMetadata.get(runKey(providerId, sessionId, 'request', data.requestId))
            ?? runMetadata.get(runKey(providerId, sessionId, 'turn', data.turn)));
          if (!metadata) { yield item; continue; }
          const enriched = { ...event, data: { ...data, ...metadata } };
          yield item?.type === 'event' ? { ...item, event: enriched } : enriched;
        }
      })();
    },

    async health(providerId, options = {}) {
      const provider = requireProvider(providerId);
      if (typeof provider.health !== 'function') return { available: null, provider: provider.id, status: 'unverified',
        configured: null, reachable: null, authenticated: null, sessionCapable: null };
      return provider.health(options);
    },

    // ── 可选能力（诚实包装） ─────────────────────────────────────────────────
    archiveSession({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return optionalCall(provider, 'archiveSession', { sessionId: requireSessionId({ sessionId }) });
    },
    nativeCheckpoint({ provider: providerId, sessionId } = {}) {
      const provider = requireProvider(providerId);
      return optionalCall(provider, 'nativeCheckpoint', { sessionId: requireSessionId({ sessionId }) });
    },
    nativeHandoff({ provider: providerId, ...params } = {}) {
      const provider = requireProvider(providerId);
      return optionalCall(provider, 'nativeHandoff', params);
    },

    // ── 回合结束事件（自动 Context Monitoring 的事实入口） ────────────────────
    /**
     * 回合机在 Agent 回合结束后调用。payload：
     *   { provider, sessionId, usage?, promptChars?, outputChars?, windowTokens?, source? }
     * usage 为 Provider 真实回传（原始形状，消费方归一化）；无真实 usage 时给字符数，
     * 由 Continuity 明确标记 estimated。绝不在这里编造数字。
     */
    async reportTurnEnd(payload = {}) {
      const providerId = String(payload?.provider ?? '');
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
      if (!providerId || !sessionId) {
        throw agentProviderError('INVALID_PARAMS', 'reportTurnEnd 需要 provider 与 sessionId');
      }
      const listeners = [...turnEndListeners];
      // Promise.resolve().then 包装：同步抛错的监听器也收敛为 rejection，
      // 单个监听器失败绝不阻断其他监听器或回合机。
      const results = await Promise.allSettled(
        listeners.map((listener) => Promise.resolve().then(() => listener(payload)))
      );
      const failed = results.filter((entry) => entry.status === 'rejected');
      for (const failure of failed) {
        log(`Agent Broker 回合结束监听器失败：${String(failure.reason?.message ?? failure.reason)}`);
      }
      return { delivered: listeners.length - failed.length, failed: failed.length };
    },

    /** 订阅回合结束事件；返回退订函数。 */
    onTurnEnd(listener) {
      if (typeof listener !== 'function') {
        throw agentProviderError('INVALID_PARAMS', 'onTurnEnd 需要回调函数');
      }
      turnEndListeners.add(listener);
      return () => turnEndListeners.delete(listener);
    },

    /** Provider 的 rollover 策略声明（capabilityExtras.rolloverStrategy）；无声明返回 null。 */
    rolloverStrategy(providerId) {
      const capabilities = requireProvider(providerId).capabilities();
      const strategy = capabilities?.rolloverStrategy ?? null;
      return strategy && typeof strategy === 'object' ? strategy : null;
    },

    /** 供 close 钩子与诊断使用。 */
    optionalMethods: AGENT_PROVIDER_OPTIONAL_METHODS,

    close() {
      turnEndListeners.clear();
      runMetadata.clear();
      log('Agent Broker 已关闭（监听器清空；Provider 无常驻资源）');
    }
  };
}

