import crypto from 'node:crypto';

const uncertain = row => ['unknown', 'outcome-unknown', 'cancel-unconfirmed'].includes(row.status);

/** An opaque reference to one immutable observation, not a successful effect receipt. */
export function taskEvidenceReference(task, row) {
  return 'task-evidence:' + crypto.createHash('sha256').update(JSON.stringify({
    taskId: task.id, workspaceId: task.workspaceId, evidence: row
  })).digest('hex');
}

function wasReviewed(task, row) {
  if (!row.provider || !row.sessionId || !Number.isSafeInteger(row.at)) return false;
  // A review can retire an old execution only. It cannot bless the current
  // Session, a later observation, or a different Task's identical tool result.
  if (task.currentAgent?.provider === row.provider && task.currentAgent?.sessionId === row.sessionId) return false;
  const ref = taskEvidenceReference(task, row);
  return (task.recoveryReviews ?? []).some(review => {
    const proof = review.sessionProof;
    return ['resume', 'release'].includes(review.action) && row.at <= review.at
      && review.previousAgent?.provider === row.provider && review.previousAgent?.sessionId === row.sessionId
      && proof?.stopped === true && proof.taskId === task.id && proof.workspaceId === task.workspaceId
      && proof.provider === row.provider && proof.sessionId === row.sessionId
      && /^[a-f0-9]{64}$/.test(review.workspaceProof?.sha256 ?? '')
      && review.intent?.reviewIds?.includes(review.id) && review.intent.operationIds.includes(ref)
      && review.operationIds?.includes(ref);
  });
}

// Recovery records are validated by the Task store. Keep the original unknown
// rows unchanged; their exact Owner-reviewed references only stop them blocking
// acceptance of a later, independently evidenced execution.
export function unreviewedTaskEffects(task) {
  return (task.executionEvidence ?? []).filter(row => uncertain(row) && !wasReviewed(task, row));
}
