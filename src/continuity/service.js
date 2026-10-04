// CetaMesh Continuity —— 桌面 IPC 服务（阶段 09）。
//
// 分层：IPC(continuity.*) → 本模块（方法白名单 + 参数转发）→ Continuity Runtime。
// 与 task/memory/chat 同一约定：只经桌面 Shell 的命名管道暴露；上下文水位上报
// （context.record）由回合机（chat/task 的回合结束钩子）调用。

import { createProviderRegistry } from './provider.js';
import { createContinuityRuntime } from './runtime.js';
import { continuityError } from './types.js';

export { createProviderRegistry, createDshAgentProvider } from './provider.js';
export { createContextMonitor } from './monitor.js';

export function createContinuityService({ taskRuntime, stateDir, providers, dshProvider, policy, now, canRollover } = {}) {
  if (!taskRuntime) throw continuityError('INVALID_PARAMS', 'createContinuityService 需要 taskRuntime');
  if (!stateDir || typeof stateDir !== 'string') throw continuityError('INVALID_PARAMS', 'createContinuityService 需要 stateDir');

  const registry = providers ?? createProviderRegistry();
  if (dshProvider) registry.register(dshProvider);
  const runtime = createContinuityRuntime({ taskRuntime, providers: registry, stateDir, policy, now, canRollover });

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
    'continuity.providers': () => ({ providers: registry.ids() })
  };

  return {
    runtime,
    registry,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(continuityError('METHOD_NOT_FOUND', '未知 Continuity 方法：' + String(method)));
      }
      return Promise.resolve().then(() => handler(params || {}));
    },
    close() {}
  };
}
