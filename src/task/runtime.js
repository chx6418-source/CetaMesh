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
import { verifyTaskOutcome } from './outcome-verification.js';

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
      parentTaskId: null,
      parentFingerprint: null,
      childContract: null,
      attempts: [],
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

  function createChild({ parentTaskId, expectedParentRev, requestId, goal, requirements,
    workspaceId, contract, supersedesChildId } = {}) {
    const parent = requireTask(parentTaskId);
    if (parent.parentTaskId) throw taskError('TASK_CHILD_DEPTH_EXCEEDED', 'Child Tasks cannot have children');
    if (parent.status === 'running') throw taskError('TASK_PARENT_PAUSE_REQUIRED', 'Pause the parent writer before creating read-only children');
    if (!['queued', 'paused'].includes(parent.status)) throw taskError('TASK_PARENT_TERMINAL', 'Parent Task is not available for new children');
    const wantedWorkspace = normalizeWorkspaceId(workspaceId);
    if (!parent.workspaceId || wantedWorkspace !== parent.workspaceId) {
      throw taskError('TASK_WORKSPACE_CONFLICT', 'Child must remain in the parent Workspace');
    }
    const request = normalizeText(requestId, 'requestId', 160, { required: true });
    const childGoal = normalizeText(goal, 'goal', TASK_LIMITS.goalChars, { required: true });
    const childRequirements = normalizeStringList(requirements, 'requirements', TASK_LIMITS.requirements);
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)
      || contract.mode !== 'read-only'
      || !['analysis', 'tool'].includes(contract.outputKind)
      || !Array.isArray(contract.readScope) || !Array.isArray(contract.expectedEvidence)) {
      throw taskError('INVALID_PARAMS', 'Child requires an output and evidence contract');
    }
    const childContract = {
      mode: 'read-only',
      outputKind: contract.outputKind,
      readScope: normalizeStringList(contract.readScope, 'contract.readScope', TASK_LIMITS.requirements),
      expectedEvidence: normalizeStringList(contract.expectedEvidence, 'contract.expectedEvidence', TASK_LIMITS.requirements)
    };
    if (!childContract.readScope.length || !childContract.expectedEvidence.length
      || childContract.readScope.some(scope => {
      const rel = scope.replaceAll('\\', '/');
      return rel.startsWith('/') || rel.includes(':')
        || rel.split('/').some(part => !part || part === '.' || part === '..');
    })) throw taskError('TASK_CHILD_SCOPE_DENIED', 'Child read scope must contain safe relative paths');
    if (childContract.outputKind === 'tool' && (new Set(childContract.expectedEvidence).size !== childContract.expectedEvidence.length
      || childContract.expectedEvidence.some(item => !['filesystem.read', 'filesystem.search'].includes(item)))) {
      throw taskError('INVALID_PARAMS', 'Read-only tool child requires distinct read result capabilities');
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      parentTaskId: parent.id, goal: childGoal, requirements: childRequirements,
      workspaceId: wantedWorkspace, childContract, supersedesChildId: supersedesChildId || null
    })).digest('hex');
    const prior = store.listAll().find(row => row.createRequest?.id === request);
    if (prior) {
      if (prior.createRequest.fingerprint !== fingerprint || prior.parentTaskId !== parent.id) {
        throw taskError('REQUEST_ID_CONFLICT', 'Child creation request ID was reused with different data');
      }
      return prior;
    }
    if (!Number.isSafeInteger(expectedParentRev)) throw taskError('REVISION_REQUIRED', 'expectedParentRev is required');
    if (parent.rev !== expectedParentRev) throw taskError('TASK_CONFLICT', 'Parent Task revision changed');
    const children = store.listAll().filter(row => row.parentTaskId === parent.id);
    const superseded = new Set(children.map(row => row.supersedesChildId).filter(Boolean));
    const leaves = children.filter(row => !superseded.has(row.id));
    const replaced = supersedesChildId ? children.find(row => row.id === supersedesChildId) : null;
    const unverifiedCompleted = replaced?.status === 'completed'
      && replaced.result?.verification === 'NEEDS_REVIEW'
      && (replaced.attempts ?? []).length > 0
      && replaced.attempts.at(-1).state === 'completed';
    if (supersedesChildId && (!replaced || superseded.has(replaced.id)
      || (!['failed', 'cancelled'].includes(replaced.status) && !unverifiedCompleted)
      || (replaced.attempts ?? []).some(item => ['started', 'accepted', 'unknown'].includes(item.state)))) {
      throw taskError('TASK_CHILD_REPLACEMENT_UNSAFE', 'Only a confirmed terminal child may be replaced once');
    }
    if (children.length >= 6 || leaves.length - (replaced ? 1 : 0) >= 2) {
      throw taskError('TASK_CHILD_LIMIT', 'At most two current child Tasks and six lifetime children are allowed');
    }
    const timestamp = now();
    return store.insert({
      id: store.newId(), goal: childGoal, requirements: childRequirements,
      status: 'queued', currentPhase: '', progress: { percent: 0, note: '' },
      completedWork: [], pendingWork: [], workspaceId: wantedWorkspace,
      parentTaskId: parent.id,
      supersedesChildId: replaced?.id ?? null,
      parentFingerprint: createFingerprint({ goal: parent.goal, requirements: parent.requirements,
        workspaceId: parent.workspaceId }),
      childContract, attempts: [],
      createRequest: { id: request, fingerprint }, artifacts: [], executionEvidence: [],
      agentReports: [], decisions: [], memoryRefs: [], checkpoint: null,
      acceptance: childContract.expectedEvidence.map(text => ({ id: subId('acc'), text, met: false, metAt: null })),
      agentHistory: [], currentAgent: null, modelConfig: null, result: null, failure: null,
      createdAt: timestamp, updatedAt: timestamp, rev: 1
    });
  }

  function listChildren({ parentTaskId } = {}) {
    const parent = requireTask(parentTaskId);
    return { children: store.listAll().filter(row => row.parentTaskId === parent.id) };
  }

  function assertChildParentCurrent({ id, workspaceId } = {}) {
    const child = requireTask(id);
    if (!child.parentTaskId) return null;
    const parent = requireTask(child.parentTaskId);
    if (parent.workspaceId !== child.workspaceId || parent.workspaceId !== workspaceId
      || !['queued', 'running', 'paused'].includes(parent.status)) {
      throw taskError('TASK_PARENT_UNAVAILABLE', 'Parent Task is not active in this Workspace');
    }
    if (child.parentFingerprint !== createFingerprint({ goal: parent.goal,
      requirements: parent.requirements, workspaceId: parent.workspaceId })) {
      throw taskError('TASK_CHILD_PARENT_CHANGED', 'Parent objective changed after child assignment');
    }
    return parent;
  }

  function recordAttempt({ id, expectedRev, provider, sessionId, state, requestId, reason } = {}) {
    const current = requireTask(id);
    const request = normalizeText(requestId, 'requestId', 160, { required: true });
    const validStates = ['started', 'completed', 'failed', 'cancelled', 'unknown'];
    if (!validStates.includes(state)) throw taskError('INVALID_PARAMS', 'Invalid Attempt state');
    const agentProvider = normalizeProvider(provider);
    if (!agentProvider) throw taskError('INVALID_PROVIDER', 'Attempt requires provider');
    const nativeSession = normalizeText(sessionId, 'sessionId', TASK_LIMITS.idChars, { required: true });
    const prior = (current.attempts ?? []).find(row => row.requestId === request);
    if (prior) {
      if (prior.provider !== agentProvider || prior.sessionId !== nativeSession || prior.state !== state) {
        throw taskError('REQUEST_ID_CONFLICT', 'Attempt request ID was reused');
      }
      return current;
    }
    return mutate(id, expectedRev, draft => {
      draft.attempts ??= [];
      if (draft.attempts.length >= 32) throw taskError('TASK_ATTEMPT_LIMIT', 'Attempt limit reached');
      draft.attempts.push({ id: subId('attempt'), requestId: request, provider: agentProvider,
        sessionId: nativeSession, state, reason: normalizeText(reason, 'reason', TASK_LIMITS.noteChars),
        observedEvidenceIds: [], usageRequestIds: [], at: now(), taskRev: draft.rev + 1 });
      return draft;
    });
  }

  async function verifyChild({ id, expectedRev } = {}) {
    const child = requireTask(id);
    if (!child.parentTaskId || child.status !== 'completed') {
      throw taskError('TASK_CHILD_NOT_COMPLETE', 'A completed child Task is required');
    }
    if (!Number.isSafeInteger(expectedRev)) throw taskError('REVISION_REQUIRED', 'expectedRev is required');
    if (child.rev !== expectedRev) throw taskError('TASK_CONFLICT', 'Child Task revision changed');
    const kind = child.childContract.outputKind;
    const checks = kind === 'tool'
      ? await Promise.all(child.childContract.expectedEvidence.map(expectedCapability =>
        verifyOutcome({ id, kind, expectedCapability, evidenceCandidate: true })))
      : [await verifyOutcome({ id, kind })];
    const latestAttempt = child.attempts?.at(-1);
    const latestEvidence = kind !== 'tool' || (latestAttempt?.state === 'completed'
      && !(child.attempts ?? []).some(row => ['started', 'accepted', 'unknown'].includes(row.state))
      && checks.every(check => check.evidenceEventIds.length > 0 && check.evidenceEventIds.every(eventId =>
        (child.executionEvidence ?? []).some(row => row.eventId === eventId
          && row.sessionId === latestAttempt.sessionId && row.taskRev >= latestAttempt.taskRev
          && (!row.runId || row.runId === latestAttempt.requestId)))));
    const result = { status: latestEvidence && checks.every(row => row.status === 'VERIFIED') ? 'VERIFIED' : 'NEEDS_REVIEW',
      kind, evidenceEventIds: [...new Set(checks.flatMap(row => row.evidenceEventIds))],
      reasons: [...checks.flatMap((row, index) => row.reasons.map(reason =>
        kind === 'tool' ? `${child.childContract.expectedEvidence[index]}:${reason}` : reason)),
        ...(!latestEvidence ? ['LATEST_ATTEMPT_EVIDENCE_MISSING'] : [])] };
    mutate(id, expectedRev, draft => {
      draft.result ??= { summary: '', at: now() };
      draft.result.verification = result.status;
      draft.result.verificationReasons = result.reasons;
      draft.result.evidenceEventIds = result.evidenceEventIds;
      draft.result.verificationRev = draft.rev + 1;
      if (kind === 'tool' && result.status === 'VERIFIED') {
        for (const item of draft.acceptance) { item.met = true; item.metAt = now(); }
      }
      return draft;
    });
    return result;
  }

  function reviewChild({ id, expectedRev, approve, reviewSummary, evidenceEventIds } = {}) {
    const child = requireTask(id);
    if (!child.parentTaskId || child.childContract?.outputKind !== 'analysis' || child.status !== 'completed') {
      throw taskError('TASK_CHILD_REVIEW_NOT_ALLOWED', 'Only completed analysis children can receive Owner review');
    }
    if (!Number.isSafeInteger(expectedRev)) throw taskError('REVISION_REQUIRED', 'expectedRev is required');
    if (child.rev !== expectedRev) throw taskError('TASK_CONFLICT', 'Child Task changed before review');
    if (typeof approve !== 'boolean') throw taskError('INVALID_PARAMS', 'Owner review decision is required');
    const summary = normalizeText(redactText(reviewSummary), 'reviewSummary', TASK_LIMITS.noteChars, { required: true });
    const ids = Array.isArray(evidenceEventIds) ? evidenceEventIds : [];
    const observed = child.executionEvidence ?? [];
    const latestAttempt = child.attempts?.at(-1);
    const sameAttempt = row => row?.sessionId === latestAttempt?.sessionId
      && Number.isSafeInteger(row.taskRev) && row.taskRev >= latestAttempt.taskRev
      && (!row.runId || row.runId === latestAttempt.requestId);
    const lastRead = observed.filter(row => ['filesystem.read', 'filesystem.search'].includes(row.capability)).at(-1);
    if (approve && (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length
      || latestAttempt?.state !== 'completed' || !lastRead || lastRead.status !== 'completed'
      || !sameAttempt(lastRead) || !ids.includes(lastRead.eventId)
      || !ids.every(eventId => typeof eventId === 'string' && observed.some(row => row.eventId === eventId
        && row.status === 'completed' && ['filesystem.read', 'filesystem.search'].includes(row.capability)
        && sameAttempt(row)))
      || !(child.agentReports ?? []).some(row => sameAttempt(row))
      || observed.some(row => ['unknown', 'outcome-unknown', 'cancel-unconfirmed'].includes(row.status)))) {
      throw taskError('TASK_CHILD_EVIDENCE_REQUIRED', 'Owner review requires observed source evidence and an analysis result');
    }
    return mutate(id, expectedRev, draft => {
      draft.result ??= { summary: '', at: now() };
      draft.result.verification = approve ? 'VERIFIED' : 'NEEDS_REVIEW';
      draft.result.verificationReasons = approve ? [] : ['OWNER_REJECTED'];
      draft.result.evidenceEventIds = approve ? ids : [];
      draft.result.verificationRev = draft.rev + 1;
      draft.decisions.push({ at: now(), decision: approve ? 'Owner analysis review approved' : 'Owner analysis review rejected',
        rationale: summary });
      if (draft.decisions.length > TASK_LIMITS.decisions) draft.decisions.splice(0, draft.decisions.length - TASK_LIMITS.decisions);
      if (approve) for (const item of draft.acceptance) { item.met = true; item.metAt = now(); }
      return draft;
    });
  }

  function settleAttempt({ id, expectedRev, requestId, state, nativeRequestId, reason } = {}) {
    if (!['accepted', 'completed', 'failed', 'cancelled', 'unknown'].includes(state)) {
      throw taskError('INVALID_PARAMS', 'Invalid Attempt settlement');
    }
    const request = normalizeText(requestId, 'requestId', 160, { required: true });
    const current = requireTask(id);
    const existing = current.attempts?.find(row => row.requestId === request);
    if (existing && !['started', 'accepted'].includes(existing.state) && state === 'accepted') return current;
    return mutate(id, expectedRev, draft => {
      const attempt = draft.attempts?.find(row => row.requestId === request);
      if (!attempt) throw taskError('TASK_ATTEMPT_NOT_FOUND', 'Attempt was not recorded');
      if (attempt.state !== 'started' && attempt.state !== 'accepted') {
        throw taskError('TASK_ATTEMPT_TERMINAL', 'Terminal Attempt cannot be rewritten');
      }
      attempt.state = state;
      attempt.nativeRequestId = normalizeText(nativeRequestId, 'nativeRequestId', 240) || attempt.nativeRequestId || null;
      attempt.reason = normalizeText(reason, 'reason', TASK_LIMITS.noteChars) || attempt.reason;
      attempt.updatedAt = now();
      return draft;
    });
  }

  function acknowledgeUnknownAttempts({ id, expectedRev, reviewSummary } = {}) {
    const child = requireTask(id);
    if (!child.parentTaskId || child.childContract?.mode !== 'read-only' || child.status !== 'blocked') {
      throw taskError('TASK_ATTEMPT_REVIEW_NOT_ALLOWED', 'Only blocked read-only children can review unknown Attempts');
    }
    const summary = normalizeText(redactText(reviewSummary), 'reviewSummary', TASK_LIMITS.noteChars, { required: true });
    if (!(child.attempts ?? []).some(item => item.state === 'unknown')) return child;
    return mutate(id, expectedRev, draft => {
      for (const attempt of draft.attempts) {
        if (attempt.state !== 'unknown') continue;
        attempt.state = 'reviewed';
        attempt.reason = `Owner reviewed unknown read-only effect: ${summary}`.slice(0, TASK_LIMITS.noteChars);
        attempt.updatedAt = now();
      }
      return draft;
    });
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
    const linked = requireTask(id);
    if (workspaceId !== undefined && normalizeWorkspaceId(workspaceId) !== linked.workspaceId
      && (linked.parentTaskId || store.listAll().some(row => row.parentTaskId === linked.id))) {
      throw taskError('TASK_CHILD_LINKED', 'Linked Task Workspace cannot be changed');
    }
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
    const linked = requireTask(id);
    if (linked.parentTaskId || store.listAll().some(row => row.parentTaskId === linked.id)) {
      throw taskError('TASK_CHILD_LINKED', 'Linked Tasks cannot be deleted independently');
    }
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
    const matches = store.listAll().filter(row => !row.parentTaskId && row.workspaceId === wantedWorkspace
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

  function activeWorkspaceOwner({ workspaceId, exceptTaskId, forReadOnlyTaskId } = {}) {
    const wantedWorkspace = normalizeWorkspaceId(workspaceId);
    if (!wantedWorkspace) return null;
    return store.listAll().find(row => row.workspaceId === wantedWorkspace
      && row.id !== exceptTaskId && ['running', 'waiting', 'blocked'].includes(row.status) && row.currentAgent
      && !(forReadOnlyTaskId && row.parentTaskId && row.childContract?.mode === 'read-only')) ?? null;
  }

  function activeWorkspaceReaders({ workspaceId, exceptTaskId } = {}) {
    const wantedWorkspace = normalizeWorkspaceId(workspaceId);
    return store.listAll().filter(row => row.workspaceId === wantedWorkspace && row.id !== exceptTaskId
      && row.parentTaskId && row.childContract?.mode === 'read-only'
      && ['running', 'waiting', 'blocked'].includes(row.status) && row.currentAgent);
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
    const current = requireTask(id);
    if (!current.parentTaskId && store.listAll().some(row => row.parentTaskId === id
      && !isTerminalStatus(row.status))) {
      throw taskError('TASK_CHILD_ACTIVE', 'Child Tasks must finish before the parent writer starts');
    }
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
    if (store.listAll().some(row => row.parentTaskId === id && !isTerminalStatus(row.status))) {
      throw taskError('TASK_CHILD_ACTIVE', 'Stop and reconcile child Tasks before pausing the parent');
    }
    return applyStatus({ id, expectedRev, target: 'paused', mutateExtra: (draft) => {
      if (reason !== undefined) draft.progress.note = normalizeText(reason, 'reason', TASK_LIMITS.noteChars);
    } });
  }

  function resume({ id, expectedRev, provider, sessionId, note } = {}) {
    const current = requireTask(id);
    if (!current.parentTaskId && store.listAll().some(row => row.parentTaskId === id
      && !isTerminalStatus(row.status))) {
      throw taskError('TASK_CHILD_ACTIVE', 'Child Tasks must finish before the parent writer resumes');
    }
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
      const pendingChild = row.parentTaskId && (row.attempts ?? []).some(item => ['started', 'accepted'].includes(item.state));
      const result = block({ id: row.id, expectedRev: row.rev,
        reason: pendingChild ? 'needs-reconciliation: Child Attempt was accepted before Core restart; verify outcome before recovery'
          : 'Task interrupted after Core restart; verify Workspace and checkpoint before resuming' });
      let current = result.task;
      if (pendingChild) {
        for (const attempt of current.attempts.filter(item => ['started', 'accepted'].includes(item.state))) {
          current = settleAttempt({ id: current.id, expectedRev: current.rev,
            requestId: attempt.requestId, state: 'unknown', reason: 'Core restarted before effect confirmation' });
        }
      }
      recovered.push(result.task.id);
    }
    return recovered;
  }

  function recoveryCandidates() {
    return store.listAll().filter(row => row.status === 'blocked');
  }

  function complete({ id, expectedRev, summary } = {}) {
    const allChildren = store.listAll().filter(row => row.parentTaskId === id);
    const superseded = new Set(allChildren.map(row => row.supersedesChildId).filter(Boolean));
    const children = allChildren.filter(row => !superseded.has(row.id));
    if (children.some(row => row.status !== 'completed' || row.result?.verification !== 'VERIFIED'
      || row.result?.verificationRev !== row.rev)) {
      throw taskError('TASK_CHILD_UNVERIFIED', 'Child Tasks require verified results before parent completion');
    }
    if (children.length) {
      const parent = requireTask(id);
      const currentFingerprint = createFingerprint({ goal: parent.goal,
        requirements: parent.requirements, workspaceId: parent.workspaceId });
      if (children.some(row => row.parentFingerprint !== currentFingerprint)) {
        throw taskError('TASK_CHILD_PARENT_CHANGED', 'Parent objective changed after child assignment');
      }
    }
    return applyStatus({ id, expectedRev, target: 'completed', mutateExtra: (draft) => {
      draft.progress.percent = 100;
      draft.result = { summary: normalizeText(summary, 'summary', TASK_LIMITS.noteChars), at: now(),
        ...(children.length ? { childResultRefs: children.map(child => ({
          childId: child.id, verificationRev: child.result.verificationRev,
          evidenceEventIds: child.result.evidenceEventIds ?? [],
          artifactIds: (child.artifacts ?? []).map(item => item.id)
        })) } : {}),
        ...(superseded.size ? { priorFailedChildIds: allChildren.filter(child => superseded.has(child.id)
          && child.status === 'failed').map(child => child.id) } : {}) };
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) last.detachedAt = now();
      draft.currentAgent = null;
    } });
  }

  function fail({ id, expectedRev, reason } = {}) {
    if (store.listAll().some(row => row.parentTaskId === id && !isTerminalStatus(row.status))) {
      throw taskError('TASK_CHILD_ACTIVE', 'Stop and reconcile child Tasks before failing the parent');
    }
    return applyStatus({ id, expectedRev, target: 'failed', mutateExtra: (draft) => {
      draft.failure = { reason: normalizeText(reason, 'reason', TASK_LIMITS.noteChars, { required: true }), at: now() };
      const last = draft.agentHistory[draft.agentHistory.length - 1];
      if (last && last.detachedAt === null) last.detachedAt = now();
      draft.currentAgent = null;
    } });
  }

  function cancel({ id, expectedRev, reason } = {}) {
    if (store.listAll().some(row => row.parentTaskId === id && !isTerminalStatus(row.status))) {
      throw taskError('TASK_CHILD_ACTIVE', 'Stop and reconcile child Tasks before cancelling the parent');
    }
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
        summary: summary === undefined ? (task.checkpoint?.summary ?? '')
          : normalizeText(summary, 'checkpoint.summary', TASK_LIMITS.checkpointChars),
        nextAction: nextAction === undefined ? (task.checkpoint?.nextAction ?? '')
          : normalizeText(nextAction, 'checkpoint.nextAction', TASK_LIMITS.checkpointChars)
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
  function recordToolOutcome({ id, provider, sessionId, eventId, runId, phase, capability, status, filePath, tool, exitCode, hasChanges, retryCount } = {}) {
    const current = requireTask(id);
    const sourceId = normalizeText(eventId, 'eventId', 240, { required: true });
    if (current.executionEvidence?.some(item => item.eventId === sourceId && item.provider === provider && item.sessionId === sessionId)) return { task: current, changed: false };
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
      draft.executionEvidence.push({ eventId: sourceId, provider, sessionId,
        runId: normalizeText(runId, 'runId', 240) || null,
        phase: normalizeText(phase, 'phase', 40) || 'unknown', capability: name,
        status: resultStatus, tool: typeof tool === 'string' ? tool.slice(0, 100) : null,
        exitCode: observedExitCode, filePath: artifactPath,
        retryCount: Number.isSafeInteger(retryCount) && retryCount >= 0 && retryCount <= 1 ? retryCount : null,
        ...(name === 'git.diff' ? { hasChanges: resultStatus === 'completed' && hasChanges === true } : {}),
        at: now(), taskRev: draft.rev + 1 });
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

  async function verifyOutcome({ id, kind, expectedFile, expectedSha256, expectedCapability,
    evidenceCandidate = false } = {}) {
    const task = requireTask(id);
    let workspaceRoot = null;
    if (task.workspaceId) {
      try {
        const workspace = await resolveWorkspace(task.workspaceId);
        if (workspace?.id === task.workspaceId && typeof workspace.root === 'string') workspaceRoot = workspace.root;
      } catch {
        return { status: 'NEEDS_REVIEW', kind, evidenceEventIds: [], reasons: ['WORKSPACE_UNAVAILABLE'] };
      }
    }
    const candidate = evidenceCandidate && task.parentTaskId && task.childContract?.outputKind === 'tool'
      ? { ...task, acceptance: task.acceptance.map(item => ({ ...item, met: true })) } : task;
    return verifyTaskOutcome(candidate, { kind, expectedFile, expectedSha256, expectedCapability }, { workspaceRoot });
  }

  async function resolveArtifactOpen({ taskId, artifactId, forPreview = false } = {}) {
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

    return resolveTaskArtifactOpen({ artifact, workspaceRoot, ownedArtifactRoot, forPreview });
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
  function recordAgentReport({ id, expectedRev, provider, sessionId, eventId, runId, phase, text } = {}) {
    const sourceId = normalizeText(eventId, 'eventId', 240, { required: true });
    const content = normalizeText(redactText(text), 'text', 1600, { required: true });
    const current = requireTask(id);
    if ((current.agentReports ?? []).some(row => row.eventId === sourceId && row.provider === provider && row.sessionId === sessionId)) return current;
    if (current.currentAgent?.provider !== provider || current.currentAgent?.sessionId !== sessionId) {
      throw taskError('AGENT_ASSIGNMENT_EXPIRED', 'Agent report came from a stale Task assignment');
    }
    return mutate(id, expectedRev, task => {
      task.agentReports ??= [];
      task.agentReports.push({ eventId: sourceId, provider, sessionId,
        runId: normalizeText(runId, 'runId', 240) || null,
        phase: normalizeText(phase, 'phase', 40) || 'unknown', text: content,
        verified: false, at: now(), taskRev: task.rev + 1 });
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
    createChild,
    listChildren,
    assertChildParentCurrent,
    recordAttempt,
    verifyChild,
    reviewChild,
    settleAttempt,
    acknowledgeUnknownAttempts,
    get,
    list,
    findByAgent,
    findByGoalWorkspace,
    findByCreateRequestId,
    activeWorkspaceOwner,
    activeWorkspaceReaders,
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
    verifyOutcome,
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

