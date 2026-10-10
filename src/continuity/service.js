// CetaMesh Continuity —— 桌面 IPC 服务（阶段 09；会话 2 改为 Agent Broker 支撑）。
//
// 分层：IPC(continuity.*) → 本模块（方法白名单 + 参数转发）→ Continuity Runtime。
// 与 task/memory/chat 同一约定：只经桌面 Shell 的命名管道暴露；上下文水位上报
// 由回合机经 Agent Broker 的回合结束事件驱动（也可经 continuity.turn.observe 显式上报）。
//
// 会话 2：移除 continuity 自带的窄 AgentProvider 注册表——会话操作只走
// Agent Broker（唯一正式契约）；Workspace Reconciliation 经注入的 reconciler。

import { createContinuityRuntime } from './runtime.js';
import { continuityError } from './types.js';

export { createContextMonitor } from './monitor.js';
export { createWorkspaceReconciler } from './reconcile.js';

export function createContinuityService({
  taskRuntime, stateDir, agentBroker, reconciler, workspaceService, capabilityService, policy, now, canRollover, listPendingApprovals, log
} = {}) {
  if (!taskRuntime) throw continuityError('INVALID_PARAMS', 'createContinuityService 需要 taskRuntime');
  if (!stateDir || typeof stateDir !== 'string') throw continuityError('INVALID_PARAMS', 'createContinuityService 需要 stateDir');
  if (!agentBroker) throw continuityError('INVALID_PARAMS', 'createContinuityService 需要 Agent Broker');

  const runtime = createContinuityRuntime({
    taskRuntime, agentBroker, stateDir, policy, now, canRollover, reconciler, listPendingApprovals, log
  });

  const handlers = {
    'continuity.status': (p) => runtime.evaluate({ taskId: p.taskId }),
    'continuity.policy.get': () => runtime.getPolicy(),
    'continuity.policy.set': (p) => runtime.setPolicy(p.policy),
    'continuity.context.record': (p) => runtime.monitor.record(p.sessionKey, {
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      promptChars: p.promptChars,
      outputChars: p.outputChars,
      windowTokens: p.windowTokens
    }),
    // 显式回合结束上报（不经 Broker 事件的调用方用；参数语义同 observeAgentTurn）。
    'continuity.turn.observe': (p) => runtime.observeAgentTurn({
      provider: p.provider,
      sessionId: p.sessionId,
      usage: p.usage,
      promptChars: p.promptChars,
      outputChars: p.outputChars,
      windowTokens: p.windowTokens,
      source: p.source
    }),
    'continuity.evaluate': (p) => runtime.evaluate({ taskId: p.taskId }),
    'continuity.rollover': (p) => runtime.rollover({
      taskId: p.taskId,
      reason: p.reason,
      targetProvider: p.targetProvider,
      coding: p.coding,
      relevantFiles: p.relevantFiles,
      workspaceFacts: p.workspaceFacts,
      model: p.model,
      reasoningEffort: p.reasoningEffort
    }),
    'continuity.reconcile': (p) => runtime.reconcile({ taskId: p.taskId }),
    'continuity.workspace.resolve': (p, actor) => {
      if (actor?.kind !== 'owner') throw continuityError('PERMISSION_DENIED', 'Owner authorization is required');
      const task = taskRuntime.get({ id: p.taskId }).task;
      const observed = String(p.observedWorkspaceId ?? '').trim();
      if (!workspaceService?.describeWorkspace(observed)) throw continuityError('WORKSPACE_NOT_FOUND', 'Observed Workspace is not registered');
      const result = taskRuntime.reconcileWorkspace({
        id: task.id,
        expectedRev: p.expectedRev,
        expectedWorkspaceId: p.expectedWorkspaceId,
        observedWorkspaceId: observed,
        resolution: 'use-observed'
      });
      capabilityService?.refreshTaskWorkspaceGrant?.(task.id);
      return { task: result.task, reconciliation: result.task.checkpoint?.workspaceReconciliation ?? null };
    },
    'continuity.packet.build': (p) => ({ packet: runtime.buildHandoffPacket({
      taskId: p.taskId,
      reason: p.reason,
      sequence: p.sequence,
      coding: p.coding,
      relevantFiles: p.relevantFiles,
      workspaceFacts: p.workspaceFacts
    }) }),
    'continuity.packet.latest': (p) => runtime.latestPacket({ taskId: p.taskId }),
    'continuity.history': (p) => runtime.history({ taskId: p.taskId }),
    'continuity.providers': () => ({ providers: agentBroker.ids() })
  };

  return {
    runtime,
    broker: agentBroker,
    execute({ method, params, actor } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(continuityError('METHOD_NOT_FOUND', '未知 Continuity 方法：' + String(method)));
      }
      return Promise.resolve().then(() => handler(params || {}, actor));
    },
    close() {}
  };
}
