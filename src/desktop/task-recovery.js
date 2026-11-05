import crypto from 'node:crypto';
import { inspectTaskSession } from '../agent/session-recovery.js';
import { taskEvidenceReference, unreviewedTaskEffects } from '../task/recovery-evidence.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codeOf = value => /^[A-Z][A-Z0-9_]{0,99}$/.test(value ?? '') ? value : 'TASK_RECOVERY_REVIEW_REQUIRED';
const MAX_TOKENS = 128, REVIEW_TTL_MS = 5 * 60_000;
const recoverable = task => ['blocked', 'paused', 'waiting'].includes(task.status);

/** Owner-only coordinator over existing Task, Workspace and execution journals. */
export function createTaskRecovery({ services, now = () => Date.now() }) {
  const tokens = new Map(), committing = new Set();
  const runtime = services.taskService?.runtime;
  function journals(task) {
    const scope = { taskId: task.id, workspaceId: task.workspaceId };
    const pendingHandoff = services.continuityService?.runtime?.transactionReviewState?.(task.id) ?? null;
    const retainedHandoff = task.recoveryIntent?.sessionProof?.handoffReview ?? null;
    // A previous domain acknowledgement can succeed before the Task write. The
    // durable intent retains the reviewed scope, never reusable stopped=true.
    if (retainedHandoff && (!task.recoveryIntent.operationIds.includes('handoff:' + digest(retainedHandoff))
      || (pendingHandoff && digest(pendingHandoff) !== digest(retainedHandoff)))) {
      fail('HANDOFF_RECOVERY_REQUIRED', '中断交接与原核对范围不一致，请保留原记录供核查');
    }
    if (!pendingHandoff && !retainedHandoff && task.recoveryIntent?.sessionProof?.handoffProofs?.length) {
      fail('HANDOFF_RECOVERY_REQUIRED', '原交接核查缺少完整归属记录，不能复用历史停止凭据');
    }
    return { capabilities: services.capabilityService.taskReviewState?.(scope) ?? null,
      tools: services.toolExecutionCoordinator?.taskReviewState?.(task.id) ?? null,
      handoff: pendingHandoff ?? retainedHandoff,
      taskEvidence: unreviewedTaskEffects(task).map(row => ({ reference: taskEvidenceReference(task, row),
        provider: row.provider, sessionId: row.sessionId })),
      intent: task.recoveryIntent ?? null };
  }
  function operationIds(review) {
    const ids = new Set();
    for (const id of review.intent?.operationIds ?? []) ids.add(id);
    for (const row of review.taskEvidence) ids.add(row.reference);
    if (review.handoff) ids.add('handoff:' + digest(review.handoff));
    for (const row of review.capabilities?.dispatches ?? []) ids.add('dispatch:' + String(row.requestId ?? row.operationId ?? row.id));
    for (const row of review.capabilities?.requests ?? []) ids.add('request:' + row[0]);
    for (const row of review.capabilities?.decisions ?? []) ids.add('approval-operation:' + row[0]);
    // The complete serialized tool review is bound too. It may include raw tool
    // details; expose only one opaque reference, never those details in the DTO.
    if (review.tools && JSON.stringify(review.tools) !== JSON.stringify({ executions: [], continuations: [] })
      && services.toolExecutionCoordinator?.recoveryForTask?.(review.taskId)) ids.add('model-tools:' + digest(review.tools).slice(0, 24));
    return [...ids].sort();
  }
  function ownership(task, reviewIds = []) {
    return { taskId: task.id, provider: task.currentAgent?.provider ?? null, taskStatus: task.status,
      reason: task.recoveryReservation ? 'recovery-dispatch-pending' : task.currentAgent ? 'assigned-executor' : 'retained-execution-evidence',
      unconfirmedOperations: reviewIds.length, safeActions: ['inspect-task', 'inspect-workspace', 'review-recovery'] };
  }
  async function collect(task) {
    const blockers = [];
    if (!recoverable(task)) blockers.push({ code: 'TASK_RECOVERY_NOT_REQUIRED', message: '此任务当前没有可核对的中断状态。' });
    if ((runtime.listChildren?.({ parentTaskId: task.id }).children ?? []).some(child => !['completed', 'failed', 'cancelled'].includes(child.status))) {
      blockers.push({ code: 'TASK_CHILD_ACTIVE', message: '请先处理仍在执行的子任务，再核对父任务的执行归属。' });
    }
    if (services.capabilityService.isTaskProvisioning?.(task.id) || committing.has(task.id)) {
      blockers.push({ code: 'TASK_EXECUTION_UNCONFIRMED', message: '任务派发或恢复尚未结束，请等待实际结算。' });
    }
    const review = journals(task);
    review.taskId = task.id;
    if (review.capabilities?.active) blockers.push({ code: 'OPERATION_STILL_RUNNING', message: '原工具调用仍在运行，结束前不能核对或重派发。' });
    for (const fence of review.capabilities?.workspaceFences ?? []) {
      if (fence.provider === 'cetamesh') continue;
      let stopped = false;
      try {
        const provider = services.agentBroker.require(fence.provider);
        stopped = (await provider.verifyTaskQuiescence?.({ taskId: task.id,
          workspaceId: task.workspaceId, allowEmpty: true }))?.stopped === true;
      } catch { stopped = false; /* Unknown startup ownership is never a stop receipt. */ }
      if (!stopped) blockers.push({ code: 'SESSION_EXECUTION_UNCONFIRMED',
        message: '新建会话曾中断，尚未确认其进程已结束。请保留任务和工作区，确认停止凭据后再核查。' });
    }
    if (review.capabilities?.approvals?.length || services.toolExecutionCoordinator?.recoveryForTask?.(task.id)?.state === 'approval-pending') {
      blockers.push({ code: 'APPROVAL_RECOVERY_REQUIRED', message: '请先在审批中心处理原有审批，再重新核查。' });
    }
    const handoffProofs = [];
    if (review.handoff) {
      const handoff = review.handoff;
      const participants = [handoff.from, handoff.to];
      const valid = handoff.state === 'prepared' && handoff.taskId === task.id && handoff.workspaceId === task.workspaceId
        && typeof handoff.from?.provider === 'string' && typeof handoff.from?.sessionId === 'string'
        && typeof handoff.to?.provider === 'string'
        && (handoff.to.sessionId === null || typeof handoff.to.sessionId === 'string')
        && participants.some(row => row.provider === task.currentAgent?.provider && row.sessionId === task.currentAgent?.sessionId);
      if (!valid) blockers.push({ code: 'HANDOFF_RECOVERY_REQUIRED',
        message: '中断交接的任务、工作区或执行归属无法完整对应，请保留原记录供核查。' });
      else for (const assignment of participants) {
        let proof;
        if (assignment.sessionId) {
          const scope = { taskId: task.id, workspaceId: task.workspaceId, ...assignment };
          try {
            const provider = services.agentBroker.require(assignment.provider);
            proof = typeof provider.inspectStoppedHandoffSession === 'function'
              ? await provider.inspectStoppedHandoffSession({ ...scope, handoff })
              : await inspectTaskSession(services.agentBroker, task, assignment);
            const exact = proof?.stopped === true && proof.taskId === task.id && proof.workspaceId === task.workspaceId
              && proof.provider === assignment.provider && proof.sessionId === assignment.sessionId;
            proof = { ...proof, ...scope, stopped: exact, state: exact ? 'stopped' : 'unknown' };
          } catch { proof = { ...scope, stopped: false, state: 'unknown' }; }
        }
        else {
          // Creation can fail after an external process has started but before
          // its Session id is returned. Absence needs a Task-scoped stop proof.
          let stopped = assignment.provider === 'cetamesh';
          try {
            const provider = services.agentBroker.require(assignment.provider);
            if (typeof provider.verifyTaskQuiescence === 'function') stopped = (await provider.verifyTaskQuiescence({
              taskId: task.id, workspaceId: task.workspaceId, allowEmpty: true }))?.stopped === true;
          } catch { stopped = false; }
          proof = { taskId: task.id, workspaceId: task.workspaceId, ...assignment, stopped,
            evidence: assignment.provider === 'cetamesh' ? 'core-owned-startup-settled' : 'provider-task-quiescence' };
        }
        handoffProofs.push(proof);
        if (!proof.stopped) blockers.push({ code: 'HANDOFF_EXECUTION_UNCONFIRMED',
          message: '交接的一方尚未确认停止。请保留原任务，确认双方执行结束后重新核查。' });
      }
    }
    const inspectedSession = handoffProofs.find(proof => proof.provider === task.currentAgent?.provider
      && proof.sessionId === task.currentAgent?.sessionId) ?? await inspectTaskSession(services.agentBroker, task);
    const session = handoffProofs.length ? { ...inspectedSession, handoffProofs, handoffReview: review.handoff } : inspectedSession;
    if (review.taskEvidence.some(row => row.provider !== task.currentAgent?.provider || row.sessionId !== task.currentAgent?.sessionId)) {
      blockers.push({ code: 'TASK_EFFECT_SCOPE_UNCONFIRMED',
        message: '存在不属于当前执行者的未知工具记录，不能借用当前会话的停止凭据核销。请保留原任务和执行记录。' });
    }
    if (!session.stopped) blockers.push({ code: 'SESSION_EXECUTION_UNCONFIRMED',
      message: '旧执行尚无完整停止凭据，不能续接或释放写入权。保留任务和结果，等待原执行结束后重新核查。' });
    let workspace = null;
    try {
      // Import rollback can write files. Inspecting an active/unknown executor
      // must stay read-only until every execution/operation blocker is settled.
      workspace = blockers.length
        ? await services.workspaceService.collectContentProof?.(task.workspaceId) ?? null
        : await services.workspaceService.collectRecoveryProof(task.workspaceId);
    }
    catch (error) { blockers.push({ code: codeOf(error?.code), message: '工作区内容无法完整核验，请检查项目可访问性、边界及保留的操作记录后重新核查。' }); }
    const latest = runtime.get({ id: task.id }).task;
    const stable = journals(latest); stable.taskId = latest.id;
    if (latest.rev !== task.rev || digest(stable) !== digest(review)) {
      blockers.push({ code: 'TASK_RECOVERY_REVIEW_STALE', message: '核查期间任务或操作记录已变化，请重新核查。' });
    }
    return { task, session, workspace, review, reviewOperationIds: operationIds(review), blockers };
  }
  function fingerprint(row) {
    return digest({ taskId: row.task.id, taskRev: row.task.rev, workspaceId: row.task.workspaceId,
      assignment: row.task.currentAgent, session: row.session, workspace: row.workspace, journals: row.review });
  }
  async function inspect(task) {
    const row = await collect(task), ready = row.blockers.length === 0;
    let reviewToken = null, expiresAt = null;
    if (ready) {
      reviewToken = crypto.randomUUID(); expiresAt = now() + REVIEW_TTL_MS;
      tokens.set(reviewToken, { taskId: task.id, fingerprint: fingerprint(row), expiresAt });
      while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    }
    return { taskId: task.id, taskRev: task.rev, reviewToken, expiresAt,
      session: { state: row.session.state, stopped: row.session.stopped, provider: row.session.provider,
        sessionId: row.session.sessionId, code: row.session.code ?? null },
      workspace: row.workspace, blockers: row.blockers, reviewOperationIds: row.reviewOperationIds,
      canResume: ready, canRelease: ready, ownership: ownership(task, row.reviewOperationIds) };
  }
  async function commit(task, params, beforeCommit) {
    const token = tokens.get(params.reviewToken);
    if (!recoverable(task)) fail('TASK_RECOVERY_NOT_REQUIRED', '任务当前不需要中断恢复');
    if (!token || token.taskId !== task.id || token.expiresAt <= now()) fail('TASK_RECOVERY_REVIEW_REQUIRED', '请先核查当前执行、文件和操作凭据，再确认恢复');
    if (committing.has(task.id)) fail('TASK_RECOVERY_IN_FLIGHT', '恢复已在处理，请等待结果');
    const action = params.action ?? 'resume';
    if (!['resume', 'release'].includes(action) || params.reviewed !== true || !String(params.reviewSummary ?? '').trim()
      || (action === 'resume' && (!String(params.nextInstruction ?? '').trim() || !String(params.requestId ?? '').trim()))) {
      fail('INVALID_PARAMS', '需要明确核对结果；续接还需要新指令和唯一请求 ID');
    }
    const row = await collect(task);
    if (row.blockers.length || fingerprint(row) !== token.fingerprint) fail('TASK_RECOVERY_REVIEW_STALE', '执行、文件或待核对操作已变化，请重新核查');
    if (!Array.isArray(params.reviewedOperationIds) || digest([...new Set(params.reviewedOperationIds)].sort()) !== digest(row.reviewOperationIds)) {
      fail('TASK_RECOVERY_OPERATIONS_REQUIRED', '需要逐项确认当前列出的未确认操作；它们不会被标记为成功或自动重放');
    }
    if (beforeCommit) await beforeCommit();
    // Provider readiness/consent may await external state. Recheck all evidence
    // afterwards; token consumption and the journal/Task commits are synchronous.
    const final = await collect(task);
    if (token.expiresAt <= now() || final.blockers.length || fingerprint(final) !== token.fingerprint) fail('TASK_RECOVERY_REVIEW_STALE', '核对证据已变化，请重新核查');
    committing.add(task.id); tokens.delete(params.reviewToken);
    try {
      const intent = runtime.prepareOwnerRecovery({ id: task.id, expectedRev: task.rev,
        reviewId: params.reviewToken, summary: String(params.reviewSummary).trim(), workspaceProof: final.workspace,
        sessionProof: final.session, operationIds: final.reviewOperationIds, journalSha256: digest(final.review) });
      services.capabilityService.acknowledgeTaskRecovery(task.id);
      services.toolExecutionCoordinator?.acknowledgeTaskRecovery(task.id);
      if (final.review.handoff) services.continuityService.runtime.acknowledgeTransactionRecovery(task.id);
      const reviewed = runtime.applyOwnerRecovery({ id: task.id, expectedRev: intent.rev, action,
        reviewId: params.reviewToken, summary: String(params.reviewSummary).trim(), workspaceProof: final.workspace,
        sessionProof: final.session, operationIds: final.reviewOperationIds, journalSha256: digest(final.review) });
      return { task: reviewed, action };
    } finally { committing.delete(task.id); }
  }
  return { inspect, commit, ownership, isInFlight: taskId => committing.has(taskId) };
}
