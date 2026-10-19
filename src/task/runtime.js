// CetaMesh Persistent Task v1 —— 任务运行时（阶段 07）。
//
// 定位：Task 是 CetaMesh 自己持有的长期工作对象，**不是** Agent Session 的投影。
//   一个 Task 可以先后由多个 Agent Provider 的 Session 推进；
//   attachAgent 只追加 agentHistory 并更新 currentAgent，任务 id 永不改变。
//
// 生命周期：queued → running → (waiting|blocked|paused) → running → completed|failed|cancelled
// 迁移合法性由 types.js 的迁移表强制；非法迁移抛 TASK_INVALID_TRANSITION。
// 重复设置同一状态是幂等 no-op（不写库、不递增 rev），避免 UI 重复点击产生垃圾版本。
//
// 落库：任何变更都经 store 的原子写 + rev 冲突检测；重启后 Task/Progress/Checkpoint/
// Agent History/Workspace 关联全部保留。
//
// 边界（按阶段要求有意不做）：不做 cron 调度、不做云端任务编排、不做多 Agent 自动编排。

import crypto from 'node:crypto';
import { buildOwnerContext } from './owner-context.js';
import { redactText } from '../logging/redact.js';
import {
  ATTENTION_STATUSES,
  TASK_LIMITS,
  TASK_STATUSES,
  assertTransition,
  isTerminalStatus,
  needsAttention,
  normalizeAcceptance,
  normalizePercent,
  normalizeProvider,
  normalizeStatus,
  normalizeStringList,
  normalizeText,
  normalizeWorkspaceId,
  taskError
} from './types.js';
import { createTaskStore } from './store.js';
import { resolveTaskArtifactOpen } from './artifact-open.js';

function subId(prefix) {
  return prefix + '_' + crypto.randomBytes(4).toString('hex');
}

export function createTaskRuntime({ stateDir, now = () => Date.now(), idFactory,
  resolveWorkspace = () => null, ownedArtifactRoot = null } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createTaskRuntime 需要 stateDir');
  const store = createTaskStore({ stateDir, now, idFactory });

  function requireTask(id) {
    const task = store.get(id);
    if (!task) throw taskError('TASK_NOT_FOUND', '任务不存在：' + String(id));
    return task;
  }

  function mutate(id, expectedRev, fn) {
    return store.update(id, expectedRev, (task) => fn(task));
  }

  /**
   * 状态迁移统一入口：合法则写库，同状态则幂等返回。
   * 返回 { task, changed }。
   */
  function applyStatus({ id, expectedRev, target, mutateExtra }) {
    const current = requireTask(id);
    if (current.status === target) return { task: current, changed: false };
    assertTransition(current.status, target);
    const task = mutate(current.id, expectedRev, (draft) => {
      draft.status = target;
      if (typeof mutateExtra === 'function') mutateExtra(draft);
      return draft;
    });
    return { task, changed: true };
  }

  // ── 创建 / 读取 / 修改 ─────────────────────────────────────────────────
  function create({
    goal, requirements, workspaceId, currentPhase, acceptanceCriteria, status, note, requestId, requestedAgentProvider
  } = {}) {
    const initialStatus = status === undefined || status === null ? 'queued' : normalizeStatus(status);
    const timestamp = now();
    const normalizedGoal = normalizeText(goal, 'goal', TASK_LIMITS.goalChars, { required: true });
    const normalizedRequirements = normalizeStringList(requirements, 'requirements', TASK_LIMITS.requirements);
    const normalizedWorkspace = normalizeWorkspaceId(workspaceId);
    const priorRequest = findByCreateRequestId({ requestId, goal: normalizedGoal,
      requirements: normalizedRequirements, workspaceId: normalizedWorkspace, requestedAgentProvider });
    if (priorRequest) return priorRequest;
    if (normalizedWorkspace) {
      const existing = findByGoalWorkspace({ goal: normalizedGoal, workspaceId: normalizedWorkspace });
      if (existing) {
        if (normalizedRequirements.length && JSON.stringify(normalizedRequirements) !== JSON.stringify(existing.requirements)) {
          throw taskError('TASK_REQUIREMENTS_CONFLICT', 'Matching active Task has different requirements');
        }
        return existing;
      }
    }
    const task = {
      id: store.newId(),
      goal: normalizedGoal,
      requirements: normalizedRequirements,
      status: initialStatus,
      currentPhase: normalizeText(currentPhase, 'currentPhase', TASK_LIMITS.phaseChars),
      progress: { percent: 0, note: normalizeText(note, 'note', TASK_LIMITS.noteChars) },
      completedWork: [],
      pendingWork: [],
      workspaceId: normalizedWorkspace,
      createRequest: requestId ? { id: normalizeText(requestId, 'requestId', 160, { required: true }),
        fingerprint: createFingerprint({ goal: normalizedGoal, requirements: normalizedRequirements,
          workspaceId: normalizedWorkspace, requestedAgentProvider }) } : null,
      artifacts: [],
      executionEvidence: [],
      agentReports: [],
      decisions: [],
      memoryRefs: [],
      checkpoint: null,
      acceptance: normalizeAcceptance(acceptanceCriteria).map((item) => ({ ...item, id: item.id || subId('acc') })),
      agentHistory: [],
      currentAgent: null,
      modelConfig: null,
      result: null,
      failure: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      rev: 1
    };
    return store.insert(task);
  }

  function get({ id } = {}) {
    return { task: requireTask(id) };
  }

  function list({ status, statuses, workspaceId, onlyNeedsAttention, query, limit } = {}) {
    let rows = store.listAll();
    if (status !== undefined && status !== null) {
      const wanted = normalizeStatus(status);
      rows = rows.filter((task) => task.status === wanted);
    }
    if (Array.isArray(statuses) && statuses.length) {
      const wanted = statuses.map(normalizeStatus);
      rows = rows.filter((task) => wanted.includes(task.status));
    }
    if (workspaceId !== undefined && workspaceId !== null && String(workspaceId).trim()) {
      const wanted = normalizeWorkspaceId(workspaceId);
      rows = rows.filter((task) => task.workspaceId === wanted);
    }
    if (onlyNeedsAttention === true) {
      rows = rows.filter((task) => needsAttention(task));
    }
    const text = query === undefined || query === null ? '' : String(query).trim().toLowerCase();
    if (text) {
      rows = rows.filter((task) => task.goal.toLowerCase().includes(text)
        || task.currentPhase.toLowerCase().includes(text)
        || task.requirements.some((item) => item.toLowerCase().includes(text)));
    }
    rows.sort((a, b) => {
      const attention = (needsAttention(b) ? 1 : 0) - (needsAttention(a) ? 1 : 0);
      if (attention !== 0) return attention;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const max = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, TASK_LIMITS.listItems) : 50;
    return { tasks: rows.slice(0, max), total: rows.length };
  }

  function update({ id, expectedRev, goal, requirements, workspaceId, currentPhase, progress, note } = {}) {
    const patch = {};
    if (goal !== undefined) patch.goal = normalizeText(goal, 'goal', TASK_LIMITS.goalChars, { required: true });
    if (requirements !== undefined) patch.requirements = normalizeStringList(requirements, 'requirements', TASK_LIMITS.requirements);
    if (workspaceId !== undefined) patch.workspaceId = normalizeWorkspaceId(workspaceId);
    if (currentPhase !== undefined) patch.currentPhase = normalizeText(currentPhase, 'currentPhase', TASK_LIMITS.phaseChars);
    if (progress !== undefined) {
      const percent = normalizePercent(progress === null || typeof progress !== 'object' ? progress : progress.percent);
      patch.progressPercent = percent;
      if (progress && typeof progress === 'object' && progress.note !== undefined) {
        patch.progressNote = normalizeText(progress.note, 'progress.note', TASK_LIMITS.noteChars);
      }
    }
    if (note !== undefined) patch.progressNote = normalizeText(note, 'note', TASK_LIMITS.noteChars);
    if (Object.keys(patch).length === 0) throw taskError('INVALID_PARAMS', '没有需要修改的字段');
    return mutate(id, expectedRev, (task) => {
      if (patch.goal !== undefined) task.goal = patch.goal;
      if (patch.requirements !== undefined) task.requirements = patch.requirements;
      if (patch.workspaceId !== undefined) task.workspaceId = patch.workspaceId;
      if (patch.currentPhase !== undefined) task.currentPhase = patch.currentPhase;
      if (patch.progressPercent !== undefined && patch.progressPercent !== null) task.progress.percent = patch.progressPercent;
      if (patch.progressNote !== undefined) task.progress.note = patch.progressNote;
      return task;
    });
  }

  function remove({ id, expectedRev } = {}) {
    return store.remove(id, expectedRev);
  }

  function setProgress({ id, expectedRev, percent, note } = {}) {
    const nextPercent = normalizePercent(percent);
    return mutate(id, expectedRev, (task) => {
      if (nextPercent !== null) task.progress.percent = nextPercent;
      if (note !== undefined) task.progress.note = normalizeText(note, 'note', TASK_LIMITS.noteChars);
      if (task.progress.percent >= 100 && !isTerminalStatus(task.status)) task.progress.percent = 100;
      return task;
    });
  }

  function setModelConfig({ id, expectedRev, modelProvider, model, reasoningEffort } = {}) {
    const modelConfig = {
      modelProvider: normalizeText(modelProvider, 'modelProvider', 80) || null,
      model: normalizeText(model, 'model', 160) || null,
      reasoningEffort: normalizeText(reasoningEffort, 'reasoningEffort', 40) || null
    };
    return mutate(id, expectedRev, (task) => {
      task.modelConfig = modelConfig;
      return task;
    });
  }

  // ── Agent Provider / Session 绑定（切换 Provider 不新建 Task） ──────────
  /** 只读反查：按当前绑定的 Agent (provider, sessionId) 找任务；找不到返回 null。 */
  function findByAgent({ provider, sessionId } = {}) {
    const wantedProvider = normalizeProvider(provider);
    const wantedSession = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!wantedProvider || !wantedSession) return null;
    for (const task of store.listAll()) {
      if (task.currentAgent?.provider === wantedProvider && task.currentAgent?.sessionId === wantedSession) {
        return task;
      }
    }
    return null;
  }

  function findByGoalWorkspace({ goal, workspaceId } = {}) {
    const canonicalGoal = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
    const wantedGoal = canonicalGoal(goal);
    const wantedWorkspace = normalizeWorkspaceId(workspaceId);
    if (!wantedGoal || !wantedWorkspace) return null;
    const matches = store.listAll().filter(row => row.workspaceId === wantedWorkspace
      && canonicalGoal(row.goal) === wantedGoal && !isTerminalStatus(row.status));
    if (matches.length > 1) throw taskError('TASK_AMBIGUOUS', 'Multiple active Tasks share this Workspace goal');
    return matches[0] ?? null;
  }

  function createFingerprint({ goal, requirements, workspaceId, requestedAgentProvider } = {}) {
    return crypto.createHash('sha256').update(JSON.stringify({
      goal: String(goal ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase(),
      requirements: normalizeStringList(requirements, 'requirements', TASK_LIMITS.requirements),
      workspaceId: normalizeWorkspaceId(workspaceId),
      requestedAgentProvider: normalizeProvider(requestedAgentProvider) || null
    })).digest('hex');
  }

  function findByCreateRequestId({ requestId, goal, requirements, workspaceId, requestedAgentProvider } = {}) {
    if (!requestId) return null;
    const id = normalizeText(requestId, 'requestId', 160, { required: true });
    const match = store.listAll().find(row => row.createRequest?.id === id);
    if (!match) return null;
    if (match.createRequest.fingerprint !== createFingerprint({ goal, requirements, workspaceId, requestedAgentProvider })) {
      throw taskError('REQUEST_ID_CONFLICT', 'Task creation request ID was reused with different data');
    }
    return match;
  }

  function activeWorkspaceOwner({ workspaceId, exceptTaskId } = {}) {
    const wantedWorkspace = normalizeWorkspaceId(workspaceId);
    if (!wantedWorkspace) return null;
    return store.listAll().find(row => row.workspaceId === wantedWorkspace
      && row.id !== exceptTaskId && ['running', 'waiting', 'blocked'].includes(row.status) && row.currentAgent) ?? null;
  }

  function attachAgent({ id, expectedRev, provider, sessionId, note } = {}) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) throw taskError('INVALID_PROVIDER', 'attachAgent 需要 provider');
    const normalizedSession = normalizeText(sessionId, 'sessionId', TASK_LIMITS.idChars, { required: true });
    const current = requireTask(id);
    if (current.currentAgent
      && current.currentAgent.provider === normalizedProvider
      && current.currentAgent.sessionId === normalizedSession) {
      return { task: current, changed: false };
    }
    const task = mutate(current.id, expectedRev, (draft) => {
      const timestamp = now();
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) last.detachedAt = timestamp;
      draft.agentHistory.push({
        provider: normalizedProvider,
        sessionId: normalizedSession,
        attachedAt: timestamp,
        detachedAt: null,
        note: normalizeText(note, 'note', TASK_LIMITS.noteChars)
      });
      if (draft.agentHistory.length > TASK_LIMITS.agentHistory) {
        draft.agentHistory = draft.agentHistory.slice(-TASK_LIMITS.agentHistory);
      }
      draft.currentAgent = { provider: normalizedProvider, sessionId: normalizedSession };
      return draft;
    });
    return { task, changed: true };
  }

  function detachAgent({ id, expectedRev, note } = {}) {
    const current = requireTask(id);
    if (!current.currentAgent) return { task: current, changed: false };
    const task = mutate(current.id, expectedRev, (draft) => {
      const timestamp = now();
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) {
        last.detachedAt = timestamp;
        if (note !== undefined) last.note = normalizeText(note, 'note', TASK_LIMITS.noteChars);
      }
      draft.currentAgent = null;
      return draft;
    });
    return { task, changed: true };
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────
  function start({ id, expectedRev, provider, sessionId, note } = {}) {
    const result = applyStatus({ id, expectedRev, target: 'running', mutateExtra: (draft) => {
      draft.failure = null;
      if (note !== undefined) draft.progress.note = normalizeText(note, 'note', TASK_LIMITS.noteChars);
    } });
    if (provider !== undefined && provider !== null) {
      return attachAgent({ id: result.task.id, expectedRev: result.task.rev, provider, sessionId, note });
    }
    return result;
  }

  function pause({ id, expectedRev, reason } = {}) {
    return applyStatus({ id, expectedRev, target: 'paused', mutateExtra: (draft) => {
      if (reason !== undefined) draft.progress.note = normalizeText(reason, 'reason', TASK_LIMITS.noteChars);
    } });
  }

  function resume({ id, expectedRev, provider, sessionId, note } = {}) {
    const result = applyStatus({ id, expectedRev, target: 'running', mutateExtra: (draft) => {
      if (note !== undefined) draft.progress.note = normalizeText(note, 'note', TASK_LIMITS.noteChars);
    } });
    if (provider !== undefined && provider !== null) {
      return attachAgent({ id: result.task.id, expectedRev: result.task.rev, provider, sessionId, note });
    }
    return result;
  }

  function wait({ id, expectedRev, reason } = {}) {
    return applyStatus({ id, expectedRev, target: 'waiting', mutateExtra: (draft) => {
      if (reason !== undefined) draft.progress.note = normalizeText(reason, 'reason', TASK_LIMITS.noteChars);
    } });
  }

  function block({ id, expectedRev, reason } = {}) {
    return applyStatus({ id, expectedRev, target: 'blocked', mutateExtra: (draft) => {
      if (reason !== undefined) draft.progress.note = normalizeText(reason, 'reason', TASK_LIMITS.noteChars);
    } });
  }

  function recoverInterrupted() {
    const recovered = [];
    for (const row of store.listAll()) {
      if (row.status !== 'running' && row.status !== 'waiting') continue;
      const result = block({ id: row.id, expectedRev: row.rev,
        reason: 'Task interrupted after Core restart; verify Workspace and checkpoint before resuming' });
      recovered.push(result.task.id);
    }
    return recovered;
  }

  function recoveryCandidates() {
    return store.listAll().filter(row => row.status === 'blocked');
  }

  function complete({ id, expectedRev, summary } = {}) {
    return applyStatus({ id, expectedRev, target: 'completed', mutateExtra: (draft) => {
      draft.progress.percent = 100;
      draft.result = { summary: normalizeText(summary, 'summary', TASK_LIMITS.noteChars), at: now() };
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) last.detachedAt = now();
      draft.currentAgent = null;
    } });
  }

  function fail({ id, expectedRev, reason } = {}) {
    return applyStatus({ id, expectedRev, target: 'failed', mutateExtra: (draft) => {
      draft.failure = { reason: normalizeText(reason, 'reason', TASK_LIMITS.noteChars, { required: true }), at: now() };
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) last.detachedAt = now();
      draft.currentAgent = null;
    } });
  }

  function cancel({ id, expectedRev, reason } = {}) {
    return applyStatus({ id, expectedRev, target: 'cancelled', mutateExtra: (draft) => {
      draft.failure = { reason: normalizeText(reason, 'reason', TASK_LIMITS.noteChars), at: now(), cancelled: true };
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) last.detachedAt = now();
      draft.currentAgent = null;
    } });
  }

  // ── Checkpoint ─────────────────────────────────────────────────────────
  function setCheckpoint({ id, expectedRev, summary, nextAction } = {}) {
    return mutate(id, expectedRev, (task) => {
      task.checkpoint = {
        at: now(),
        summary: normalizeText(summary, 'checkpoint.summary', TASK_LIMITS.checkpointChars),
        nextAction: normalizeText(nextAction, 'checkpoint.nextAction', TASK_LIMITS.checkpointChars)
      };
      return task;
    });
  }

  /** Restore an exact prior checkpoint during an internal multi-step rollback. */
  function restoreCheckpoint({ id, expectedRev, checkpoint } = {}) {
    if (checkpoint !== null && (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint))) {
      throw taskError('INVALID_PARAMS', 'checkpoint must be an object or null');
    }
    const snapshot = checkpoint === null ? null : structuredClone(checkpoint);
    return mutate(id, expectedRev, (task) => {
      task.checkpoint = snapshot;
      return task;
    });
  }

  /** Explicitly resolves a Task/execution Workspace conflict with optimistic concurrency. */
  function reconcileWorkspace({ id, expectedRev, expectedWorkspaceId, observedWorkspaceId, resolution } = {}) {
    const current = requireTask(id);
    const expected = expectedWorkspaceId === undefined ? null : normalizeWorkspaceId(expectedWorkspaceId);
    const observed = normalizeWorkspaceId(observedWorkspaceId);
    if (resolution !== 'use-observed' || !observed) {
      throw taskError('INVALID_PARAMS', 'Workspace resolution requires use-observed and a registered Workspace id');
    }
    if ((current.workspaceId ?? null) !== expected) {
      throw taskError('WORKSPACE_RECONCILIATION_STALE', 'Task Workspace changed before resolution');
    }
    if (expected === observed) return { task: current, changed: false };
    const resolvedAt = now();
    const task = mutate(current.id, expectedRev, (draft) => {
      if ((draft.workspaceId ?? null) !== expected) throw taskError('WORKSPACE_RECONCILIATION_STALE', 'Task Workspace changed before resolution');
      draft.workspaceId = observed;
      draft.checkpoint = {
        at: resolvedAt,
        summary: draft.checkpoint?.summary ?? '',
        nextAction: draft.checkpoint?.nextAction ?? '',
        workspaceReconciliation: {
          expectedWorkspaceId: expected,
          observedWorkspaceId: observed,
          resolution: 'use-observed',
          resolvedAt
        }
      };
      return draft;
    });
    return { task, changed: true };
  }

  // ── 工作项 / 产物 / 决策 / 记忆引用 / 验收标准 ──────────────────────────
  function addWork({ id, expectedRev, kind, text } = {}) {
    if (kind !== 'completed' && kind !== 'pending') {
      throw taskError('INVALID_PARAMS', 'work.kind 只能是 completed / pending');
    }
    const item = { at: now(), text: normalizeText(text, 'text', TASK_LIMITS.noteChars, { required: true }) };
    return mutate(id, expectedRev, (task) => {
      const bucket = kind === 'completed' ? task.completedWork : task.pendingWork;
      bucket.push(item);
      if (bucket.length > TASK_LIMITS.listItems) bucket.splice(0, bucket.length - TASK_LIMITS.listItems);
      return task;
    });
  }

  function addArtifact({ id, expectedRev, kind, label, ref } = {}) {
    const artifact = {
      id: subId('art'),
      kind: normalizeText(kind, 'artifact.kind', 60) || 'file',
      label: normalizeText(label, 'artifact.label', 300, { required: true }),
      ref: normalizeText(ref, 'artifact.ref', 1000),
      createdAt: now()
    };
    return mutate(id, expectedRev, (task) => {
      task.artifacts.push(artifact);
      if (task.artifacts.length > TASK_LIMITS.artifacts) {
        task.artifacts = task.artifacts.slice(-TASK_LIMITS.artifacts);
      }
      return task;
    });
  }

  /** Persist one observed Broker tool result against the current Task owner. */
  function recordToolOutcome({ id, provider, sessionId, eventId, capability, status, filePath, tool, exitCode } = {}) {
    const current = requireTask(id);
    const sourceId = normalizeText(eventId, 'eventId', 240, { required: true });
    if (current.executionEvidence?.some(item => item.eventId === sourceId)) return { task: current, changed: false };
    if (current.status !== 'running' || current.currentAgent?.provider !== provider
      || current.currentAgent?.sessionId !== sessionId) {
      throw taskError('AGENT_ASSIGNMENT_EXPIRED', 'Tool outcome came from a stale Task Agent');
    }
    const name = normalizeText(capability, 'capability', 100, { required: true });
    const resultStatus = normalizeText(status, 'status', 40, { required: true });
    const relative = typeof filePath === 'string' ? filePath.replaceAll('\\', '/').trim() : '';
    const artifactPath = resultStatus === 'completed' && name === 'filesystem.write'
      && relative && !relative.startsWith('/') && !/^[A-Za-z]:/.test(relative)
      && relative.split('/').every(segment => segment && segment !== '.' && segment !== '..') ? relative : null;
    const observedExitCode = Number.isSafeInteger(exitCode) ? exitCode : null;
    const task = mutate(id, current.rev, draft => {
      draft.executionEvidence ??= [];
      draft.executionEvidence.push({ eventId: sourceId, provider, sessionId, capability: name,
        status: resultStatus, tool: typeof tool === 'string' ? tool.slice(0, 100) : null,
        exitCode: observedExitCode, filePath: artifactPath, at: now(), taskRev: draft.rev + 1 });
      if (draft.executionEvidence.length > 200) draft.executionEvidence.splice(0, draft.executionEvidence.length - 200);
      if (artifactPath && !draft.artifacts.some(item => item.ref === artifactPath)) {
        draft.artifacts.push({ id: subId('art'), kind: 'file', label: artifactPath,
          ref: artifactPath, createdAt: now(), sourceEventId: sourceId });
        if (draft.artifacts.length > TASK_LIMITS.artifacts) draft.artifacts.splice(0, draft.artifacts.length - TASK_LIMITS.artifacts);
      }
      return draft;
    });
    return { task, changed: true };
  }

  async function resolveArtifactOpen({ taskId, artifactId } = {}) {
    const safeTaskId = normalizeText(taskId, 'taskId', TASK_LIMITS.idChars, { required: true });
    const safeArtifactId = normalizeText(artifactId, 'artifactId', TASK_LIMITS.idChars, { required: true });
    const task = requireTask(safeTaskId);
    const artifact = task.artifacts.find(item => item.id === safeArtifactId);
    if (!artifact) throw taskError('ARTIFACT_NOT_FOUND', 'Artifact 不属于指定 Task');

    const ownedReference = typeof artifact.ref === 'string'
      && artifact.ref.toLowerCase().startsWith('cetamesh-artifact:');
    let workspaceRoot = null;
    if (!ownedReference && task.workspaceId) {
      const workspace = await resolveWorkspace(task.workspaceId);
      if (!workspace || workspace.id !== task.workspaceId || typeof workspace.root !== 'string' || !workspace.root.trim()) {
        throw taskError('TASK_WORKSPACE_UNAVAILABLE', 'Task 绑定的 Workspace 当前不可用');
      }
      workspaceRoot = workspace.root;
    }

    return resolveTaskArtifactOpen({ artifact, workspaceRoot, ownedArtifactRoot });
  }

  function addDecision({ id, expectedRev, decision, rationale } = {}) {
    const item = {
      at: now(),
      decision: normalizeText(decision, 'decision', TASK_LIMITS.noteChars, { required: true }),
      rationale: normalizeText(rationale, 'rationale', TASK_LIMITS.noteChars)
    };
    return mutate(id, expectedRev, (task) => {
      task.decisions.push(item);
      if (task.decisions.length > TASK_LIMITS.decisions) {
        task.decisions = task.decisions.slice(-TASK_LIMITS.decisions);
      }
      return task;
    });
  }

  /** Store a native Agent claim separately; do not upgrade it to a verified Task checkpoint. */
  function recordAgentReport({ id, expectedRev, provider, sessionId, eventId, text } = {}) {
    const sourceId = normalizeText(eventId, 'eventId', 240, { required: true });
    const content = normalizeText(redactText(text), 'text', 1600, { required: true });
    const current = requireTask(id);
    if ((current.agentReports ?? []).some(row => row.eventId === sourceId)) return current;
    if (current.currentAgent?.provider !== provider || current.currentAgent?.sessionId !== sessionId) {
      throw taskError('AGENT_ASSIGNMENT_EXPIRED', 'Agent report came from a stale Task assignment');
    }
    return mutate(id, expectedRev, task => {
      task.agentReports ??= [];
      task.agentReports.push({ eventId: sourceId, provider, sessionId, text: content,
        verified: false, at: now() });
      if (task.agentReports.length > TASK_LIMITS.agentReports) {
        task.agentReports.splice(0, task.agentReports.length - TASK_LIMITS.agentReports);
      }
      return task;
    });
  }

  function recordOwnerContext({ id, expectedRev, sessionId, messages } = {}) {
    const current = requireTask(id);
    const sid = normalizeText(sessionId, 'sessionId', TASK_LIMITS.idChars, { required: true });
    const ownerContext = buildOwnerContext({ sessionId: sid, messages });
    if (JSON.stringify(current.ownerContext ?? null) === JSON.stringify(ownerContext)) return current;
    return mutate(id, expectedRev, draft => { draft.ownerContext = ownerContext; return draft; });
  }

  function linkMemory({ id, expectedRev, memoryId, scope, type, authorizedBy, note } = {}) {
    const item = {
      at: now(),
      memoryId: normalizeText(memoryId, 'memoryId', TASK_LIMITS.idChars, { required: true }),
      ...(scope ? { scope: normalizeText(scope, 'scope', 160, { required: true }) } : {}),
      ...(type ? { type: normalizeText(type, 'type', 40, { required: true }) } : {}),
      ...(authorizedBy ? { authorizedBy: normalizeText(authorizedBy, 'authorizedBy', 160, { required: true }) } : {}),
      note: normalizeText(note, 'note', TASK_LIMITS.noteChars)
    };
    return mutate(id, expectedRev, (task) => {
      const existing = task.memoryRefs.findIndex(ref => ref.memoryId === item.memoryId);
      if (existing >= 0) task.memoryRefs[existing] = item;
      else task.memoryRefs.push(item);
      return task;
    });
  }

  function addAcceptance({ id, expectedRev, text } = {}) {
    const item = {
      id: subId('acc'),
      text: normalizeText(text, 'text', TASK_LIMITS.requirementChars, { required: true }),
      met: false,
      metAt: null
    };
    return mutate(id, expectedRev, (task) => {
      task.acceptance.push(item);
      return task;
    });
  }

  function setAcceptance({ id, expectedRev, acceptanceId, text, met } = {}) {
    const targetId = acceptanceId === undefined || acceptanceId === null ? '' : String(acceptanceId);
    const targetText = text === undefined || text === null ? '' : String(text).trim();
    return mutate(id, expectedRev, (task) => {
      const item = task.acceptance.find((entry) => (targetId && entry.id === targetId)
        || (!targetId && targetText && entry.text === targetText));
      if (!item) throw taskError('ACCEPTANCE_NOT_FOUND', '找不到验收标准：' + (targetId || targetText));
      if (met !== undefined) {
        item.met = met === true;
        item.metAt = item.met ? now() : null;
      }
      return task;
    });
  }

  /** 页面聚合查询：一次往返拿到列表 + 计数 + 需要关注的任务。 */
  function overview({ status, workspaceId, query, limit } = {}) {
    const listed = list({ status, workspaceId, query, limit });
    const all = store.listAll();
    const counts = {};
    for (const name of TASK_STATUSES) counts[name] = 0;
    for (const task of all) counts[task.status] = (counts[task.status] || 0) + 1;
    return {
      tasks: listed.tasks,
      total: listed.total,
      counts,
      needsAttention: all.filter((task) => needsAttention(task)).map((task) => task.id),
      attentionStatuses: [...ATTENTION_STATUSES]
    };
  }

  return {
    recordOwnerContext,
    recordAgentReport,
    create,
    get,
    list,
    findByAgent,
    findByGoalWorkspace,
    findByCreateRequestId,
    activeWorkspaceOwner,
    update,
    remove,
    setProgress,
    setModelConfig,
    start,
    pause,
    resume,
    wait,
    block,
    recoverInterrupted,
    recoveryCandidates,
    complete,
    fail,
    cancel,
    attachAgent,
    detachAgent,
    setCheckpoint,
    restoreCheckpoint,
    reconcileWorkspace,
    addWork,
    addArtifact,
    recordToolOutcome,
    resolveArtifactOpen,
    addDecision,
    linkMemory,
    addAcceptance,
    setAcceptance,
    overview,
    countAll: () => store.count(),
    _store: store
  };
}
