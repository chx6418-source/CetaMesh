import crypto from 'node:crypto';

// Private diagnostic metadata only. Never accept exception text, stack, tool
// input, paths, prompts or provider payloads as report content.
export const RUNTIME_FAILURE_LIMIT = 20;
export const RUNTIME_FAILURE_CODES = Object.freeze([
  'TASK_WORKSPACE_BUSY', 'TASK_WORKSPACE_REQUIRED', 'TASK_WORKSPACE_MISMATCH',
  'TASK_RECOVERY_REVIEW_REQUIRED', 'TASK_RECOVERY_REVIEW_STALE', 'TASK_RECOVERY_OPERATIONS_REQUIRED',
  'TASK_RECOVERY_INSTRUCTION_REQUIRED', 'TASK_RECOVERY_NOT_REQUIRED', 'TASK_RECOVERY_LIMIT', 'TASK_RECOVERY_IN_FLIGHT',
  'TASK_CONFLICT', 'TASK_NOT_FOUND', 'TASK_RECOVERY_WORKSPACE_BOUND',
  'SESSION_TRANSPORT_UNKNOWN', 'SESSION_NOT_FOUND', 'SESSION_EXECUTION_UNCONFIRMED',
  'TASK_EXECUTION_UNCONFIRMED', 'OPERATION_STILL_RUNNING', 'OPERATION_REPLAY_DENIED',
  'NEEDS_RECONCILIATION', 'APPROVAL_RECOVERY_REQUIRED', 'APPROVAL_REQUIRED', 'RECOVERY_USE_NEW_INSTRUCTION',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR', 'PROVIDER_CLOSE_UNKNOWN', 'ACP_CLOSE_UNKNOWN',
  'INVOKE_CANCEL_UNCONFIRMED', 'INVOKE_CANCELLED', 'TASK_HANDOFF_IN_FLIGHT',
  'WORKSPACE_RECONCILIATION_FAILED', 'WORKSPACE_CONTENT_PROOF_UNAVAILABLE', 'STAGING_READ_FAILED',
  'CODEX_LIFECYCLE_STORE_INVALID', 'CODEX_LIFECYCLE_WRITE_FAILED', 'CODEX_STOP_PROOF_INVALID',
  'CORE_DIAGNOSTICS_BLOCKED', 'RUNTIME_FAILURE'
]);
const codes = new Set(RUNTIME_FAILURE_CODES);
const sources = new Set(['task', 'chat', 'agent', 'workspace', 'capability', 'continuity']);
const stages = new Set(['pre-dispatch', 'execution', 'unknown']);
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'i');
const requestPattern = new RegExp(`^(?:${uuid}|cetamesh-chat-${uuid}-${uuid}|sha256:[a-f0-9]{64})$`, 'i');
const taskPattern = /^task_[a-z0-9]{1,20}_[a-f0-9]{10}$/i;
const taskId = value => typeof value === 'string' && taskPattern.test(value) ? value : null;
const requestId = value => typeof value === 'string' && requestPattern.test(value) ? value : null;

export function projectRuntimeFailures(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const row of value.slice(-RUNTIME_FAILURE_LIMIT)) {
    if (!row || !codes.has(row.code) || !sources.has(row.source)
      || typeof row.correlationId !== 'string' || !uuidPattern.test(row.correlationId)
      || typeof row.at !== 'string' || row.at.length > 32 || !Number.isFinite(Date.parse(row.at))) continue;
    result.push({ at: new Date(row.at).toISOString(), code: row.code, source: row.source,
      taskId: taskId(row.taskId), blockingTaskId: taskId(row.blockingTaskId),
      requestId: requestId(row.requestId), correlationId: row.correlationId,
      failureStage: stages.has(row.failureStage) ? row.failureStage : 'unknown' });
  }
  return result;
}

export function createRuntimeFailureRegistry({ now = Date.now } = {}) {
  const rows = [], listeners = new Set();
  return Object.freeze({
    record({ code, source, taskId: task, blockingTaskId, requestId: request, correlationId, failureStage } = {}) {
      if (!sources.has(source)) return null;
      // Owner request IDs can be arbitrary text. Preserve product-generated
      // identifiers; hash every other bounded identity instead of exporting it.
      const boundedRequest = typeof request === 'string' && request.length > 0 && request.length <= 1024 ? request : null;
      const safeRequest = requestId(boundedRequest) ?? (boundedRequest ? 'sha256:' + crypto.createHash('sha256').update(boundedRequest).digest('hex') : null);
      const safe = projectRuntimeFailures([{ at: new Date(now()).toISOString(), code: codes.has(code) ? code : 'RUNTIME_FAILURE',
        source, taskId: task, blockingTaskId, requestId: safeRequest,
        correlationId: uuidPattern.test(correlationId ?? '') ? correlationId : crypto.randomUUID(), failureStage }])[0];
      const same = safeRequest && rows.find(row => row.code === safe.code && row.source === safe.source
        && row.taskId === safe.taskId && row.blockingTaskId === safe.blockingTaskId && row.requestId === safeRequest);
      if (same) return { ...same };
      rows.push(safe); if (rows.length > RUNTIME_FAILURE_LIMIT) rows.shift();
      for (const listener of listeners) { try { listener(); } catch { continue; /* Diagnostics never changes dispatch outcome. */ } }
      return { ...safe };
    },
    list: () => rows.map(row => ({ ...row })),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
}
