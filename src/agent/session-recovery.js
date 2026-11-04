// Trusted Broker-side inspection. Transport loss and absent native sessions are
// observations, never termination receipts. No process is stopped by inspection.
export async function inspectTaskSession(broker, task, assignment = task.currentAgent) {
  const base = { taskId: task.id, workspaceId: task.workspaceId,
    provider: assignment?.provider ?? null, sessionId: assignment?.sessionId ?? null };
  const unknown = code => ({ ...base, stopped: false, state: 'unknown', code: code || 'SESSION_EXECUTION_UNCONFIRMED' });
  if (!broker) return unknown('AGENT_RECOVERY_UNAVAILABLE');
  if (!assignment) {
    // Startup can create an owned native process before Task attachment commits.
    // Inspect those durable bindings even when Task history is still empty.
    for (const id of broker.ids?.() ?? []) {
      const provider = broker.require?.(id);
      if (typeof provider?.verifyTaskQuiescence !== 'function') continue;
      try {
        if ((await provider.verifyTaskQuiescence({ taskId: task.id, workspaceId: task.workspaceId, allowEmpty: true }))?.stopped !== true) {
          return unknown('SESSION_EXECUTION_UNCONFIRMED');
        }
      } catch (error) { return unknown(error?.code); }
    }
    const reviews = task.recoveryReviews ?? [];
    let review = reviews.at(-1), index = reviews.length - 1;
    const last = task.agentHistory?.at(-1);
    // A release may be followed by another explicit review before a new Session
    // can be created. Follow only the exact prior review referenced by the
    // unbound proof, strictly backwards; never borrow an arbitrary old receipt.
    while (review && !review.previousAgent && review.sessionProof?.evidence === 'owner-retired-session') {
      if (review.sessionProof.stopped !== true || review.sessionProof.taskId !== task.id
        || review.sessionProof.workspaceId !== task.workspaceId) return unknown('SESSION_EXECUTION_UNCONFIRMED');
      const previousIndex = reviews.findIndex(row => row.id === review.sessionProof.receiptId);
      if (previousIndex < 0 || previousIndex >= index || reviews[previousIndex].at > review.at) return unknown('SESSION_EXECUTION_UNCONFIRMED');
      index = previousIndex; review = reviews[index];
    }
    const matchesRetired = review?.id && review.sessionProof?.stopped === true
      && review.sessionProof.taskId === task.id && review.sessionProof.workspaceId === task.workspaceId
      && last?.provider === review.previousAgent?.provider && last?.sessionId === review.previousAgent?.sessionId
      && last.detachedAt === review.at;
    if (matchesRetired) {
      try {
        const priorProvider = broker.require?.(last.provider);
        if (typeof priorProvider?.verifyTaskQuiescence === 'function') {
          const quiet = await priorProvider.verifyTaskQuiescence({ taskId: task.id, workspaceId: task.workspaceId });
          if (quiet?.stopped !== true) return unknown('SESSION_EXECUTION_UNCONFIRMED');
        } else if (last.provider !== 'cetamesh') return unknown('SESSION_EXECUTION_UNCONFIRMED');
      } catch (error) { return unknown(error?.code); }
      return { ...base, stopped: true, state: 'unbound', evidence: 'owner-retired-session', receiptId: reviews.at(-1).id };
    }
    if (!task.agentHistory?.length) return { ...base, stopped: true, state: 'unbound', evidence: 'no-prior-session' };
    if (last?.provider !== 'cetamesh') return unknown('SESSION_EXECUTION_UNCONFIRMED');
    assignment = last;
  }
  const provider = broker.require?.(assignment.provider);
  // Provider proof binds a persisted lifecycle generation to the exact Task.
  if (typeof provider?.verifyStoppedTask === 'function') {
    try {
      const proof = await provider.verifyStoppedTask({ taskId: task.id, workspaceId: task.workspaceId,
        sessionId: assignment.sessionId });
      if (proof?.stopped === true && proof.provider === assignment.provider && proof.taskId === task.id
        && proof.workspaceId === task.workspaceId && proof.sessionId === assignment.sessionId) {
        return { ...proof, state: 'stopped', code: null };
      }
      return unknown(proof?.code || 'SESSION_EXECUTION_UNCONFIRMED');
    } catch (error) { return unknown(error?.code || 'SESSION_EXECUTION_UNCONFIRMED'); }
  }
  // Native external process ownership requires a durable adapter proof. An idle
  // protocol response alone cannot certify its potentially surviving children.
  const boundary = broker.capabilities(assignment.provider)?.workspaceBoundary;
  if (assignment.provider === 'codex' || boundary === 'native-staged') return unknown('SESSION_EXECUTION_UNCONFIRMED');
  try {
    const status = await broker.status(assignment);
    if (status?.running !== false || Number(status.queued ?? 0) > 0 || status.waitingForApproval || status.approvalId
      || status.state === 'unknown' || status.lastRunStatus === 'unknown' || status.runtimeValid === false) {
      return { ...base, stopped: false, state: status?.running === true ? 'active' : 'unknown', code: 'SESSION_EXECUTION_UNCONFIRMED' };
    }
    return { ...base, stopped: true, state: 'stopped', evidence: 'provider-idle',
      lastRunStatus: status.lastRunStatus ?? null };
  } catch (error) {
    // Managed execution and promises belong to this Core. A missing managed
    // session after restart has no external process; tool effects are checked
    // separately by the recovery coordinator and remain non-replayable.
    if (assignment.provider === 'cetamesh' && error?.code === 'SESSION_NOT_FOUND') {
      return { ...base, stopped: true, state: 'stopped', evidence: 'core-owned-session-missing' };
    }
    return unknown(error?.code || 'SESSION_EXECUTION_UNCONFIRMED');
  }
}
