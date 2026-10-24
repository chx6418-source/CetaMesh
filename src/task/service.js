// CetaMesh Persistent Task v1 —— 桌面 Tasks 服务（阶段 07）。
//
// 分层：IPC(task.*) → 本模块（方法白名单 + 参数转发）→ Task Runtime。
// 与 memory/service.js 同一约定：task.* 只经桌面 Shell 的命名管道暴露，
// 因此这里不做主体判定；但任务不会因为某个 Agent 会话结束而消失——生命周期由本 Runtime 持有。

import { createTaskRuntime } from './runtime.js';
import { taskError } from './types.js';

export function createTaskService({ stateDir, now, resolveWorkspace, resolveMemory, ownedArtifactRoot } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createTaskService 需要 stateDir');
  const runtime = createTaskRuntime({ stateDir, now, resolveWorkspace, ownedArtifactRoot });
  runtime.recoverInterrupted();

  const handlers = {
    // 页面聚合：一次往返拿到列表 + 计数 + 需要关注
    'task.overview': (p) => runtime.overview(p),
    'task.list': (p) => runtime.list(p),
    'task.get': (p) => runtime.get({ id: p.id }),
    'task.outcome.verify': (p) => runtime.verifyOutcome({ id: p.id, kind: p.kind,
      expectedFile: p.expectedFile, expectedSha256: p.expectedSha256,
      expectedCapability: p.expectedCapability }),
    'task.create': (p) => runtime.create({
      goal: p.goal,
      requirements: p.requirements,
      workspaceId: p.workspaceId,
      requestId: p.requestId,
      requestedAgentProvider: p.requestedAgentProvider,
      currentPhase: p.currentPhase,
      acceptanceCriteria: p.acceptanceCriteria,
      status: p.status,
      note: p.note
    }),
    'task.update': (p) => runtime.update({
      id: p.id,
      expectedRev: p.expectedRev,
      goal: p.goal,
      requirements: p.requirements,
      workspaceId: p.workspaceId,
      currentPhase: p.currentPhase,
      progress: p.progress,
      note: p.note
    }),
    'task.delete': (p) => runtime.remove({ id: p.id, expectedRev: p.expectedRev }),
    'task.progress.set': (p) => runtime.setProgress({
      id: p.id, expectedRev: p.expectedRev, percent: p.percent, note: p.note
    }),

    // 生命周期
    'task.start': (p) => runtime.start({
      id: p.id, expectedRev: p.expectedRev, provider: p.provider, sessionId: p.sessionId, note: p.note
    }),
    'task.pause': (p) => runtime.pause({ id: p.id, expectedRev: p.expectedRev, reason: p.reason }),
    'task.resume': (p) => runtime.resume({
      id: p.id, expectedRev: p.expectedRev, provider: p.provider, sessionId: p.sessionId, note: p.note
    }),
    'task.wait': (p) => runtime.wait({ id: p.id, expectedRev: p.expectedRev, reason: p.reason }),
    'task.block': (p) => runtime.block({ id: p.id, expectedRev: p.expectedRev, reason: p.reason }),
    'task.complete': (p) => runtime.complete({ id: p.id, expectedRev: p.expectedRev, summary: p.summary }),
    'task.fail': (p) => runtime.fail({ id: p.id, expectedRev: p.expectedRev, reason: p.reason }),
    'task.cancel': (p) => runtime.cancel({ id: p.id, expectedRev: p.expectedRev, reason: p.reason }),

    // Agent Provider / Session 绑定：切换 Provider 不新建 Task
    'task.agent.attach': (p) => runtime.attachAgent({
      id: p.id, expectedRev: p.expectedRev, provider: p.provider, sessionId: p.sessionId, note: p.note
    }),
    'task.agent.detach': (p) => runtime.detachAgent({
      id: p.id, expectedRev: p.expectedRev, note: p.note
    }),

    // 领域明细
    'task.checkpoint.set': (p) => runtime.setCheckpoint({
      id: p.id, expectedRev: p.expectedRev, summary: p.summary, nextAction: p.nextAction
    }),
    'task.work.add': (p) => runtime.addWork({
      id: p.id, expectedRev: p.expectedRev, kind: p.kind, text: p.text
    }),
    'task.artifact.add': (p) => runtime.addArtifact({
      id: p.id, expectedRev: p.expectedRev, kind: p.kind, label: p.label, ref: p.ref
    }),
    'task.artifact.resolveOpen': (p) => runtime.resolveArtifactOpen({
      taskId: p.taskId, artifactId: p.artifactId
    }),
    'task.artifact.resolvePreview': (p) => runtime.resolveArtifactOpen({
      taskId: p.taskId, artifactId: p.artifactId, forPreview: true
    }),
    'task.decision.add': (p) => runtime.addDecision({
      id: p.id, expectedRev: p.expectedRev, decision: p.decision, rationale: p.rationale
    }),
    'task.memory.link': (p) => {
      if (typeof resolveMemory !== 'function') throw taskError('MEMORY_UNAVAILABLE', 'Memory resolver unavailable');
      const memory = resolveMemory(p.memoryId);
      if (!memory) throw taskError('MEMORY_NOT_FOUND', 'Memory not found');
      return runtime.linkMemory({ id: p.id, expectedRev: p.expectedRev, memoryId: memory.id,
        scope: memory.scope, type: memory.type, authorizedBy: 'user:desktop', note: p.note });
    },
    'task.acceptance.add': (p) => runtime.addAcceptance({
      id: p.id, expectedRev: p.expectedRev, text: p.text
    }),
    'task.acceptance.set': (p) => runtime.setAcceptance({
      id: p.id, expectedRev: p.expectedRev, acceptanceId: p.acceptanceId, text: p.text, met: p.met
    })
  };

  return {
    stateDir,
    runtime,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(taskError('METHOD_NOT_FOUND', '未知 Task 方法：' + String(method)));
      }
      return Promise.resolve().then(() => handler(params || {}));
    },
    close() {}
  };
}
