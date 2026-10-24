import { safeModelErrorDetails } from '../model/types.js';

/** A bounded recovery recommendation. Classification never executes or retries an effect. */
export function classifyAgentFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const details = safeModelErrorDetails(error);
  const result = (category, recovery) => ({ category, recovery, automaticRetries: 0 });
  if (error?.effectStatus === 'unknown' || ['INVOKE_CANCEL_UNCONFIRMED', 'OUTCOME_UNKNOWN',
    'REQUEST_RECOVERY_REQUIRED'].includes(code)) return result('OUTCOME_UNKNOWN', 'RECONCILE_EFFECT');
  if (['ABORT_ERR', 'ABORTED', 'INVOKE_CANCELLED'].includes(code) || error?.name === 'AbortError') {
    return result('USER_CANCELLED', 'STOP');
  }
  if (['APPROVAL_REJECTED', 'APPROVAL_DENIED', 'APPROVAL_EXPIRED'].includes(code)) {
    return result('APPROVAL_DENIED', 'STOP');
  }
  if (['WORKSPACE_CONFLICT', 'WORKSPACE_RECONCILIATION_REQUIRED'].includes(code)) {
    return result('WORKSPACE_CONFLICT', 'RECONCILE_WORKSPACE');
  }
  if (['AGENT_CONTEXT_LIMIT', 'MODEL_CONTEXT_BUDGET_INVALID', 'MODEL_CONTEXT_OVERFLOW'].includes(code)
    || details?.category === 'context-overflow') return result('CONTEXT_OVERFLOW', 'FRESH_SESSION');
  if (['MODEL_INVALID_TOOL_SCHEMA', 'TOOL_ARGUMENTS_INVALID', 'TOOL_SCHEMA_INVALID',
    'MODEL_TOOL_PROTOCOL_MISMATCH'].includes(code)) return result('TOOL_SCHEMA', 'REVIEW_SCHEMA');
  if (details?.category === 'rate-limit' || details?.httpStatus === 429) {
    return result('RATE_LIMIT', 'WAIT_FOR_RETRY');
  }
  if (code === 'MODEL_PROVIDER_UNAVAILABLE' || details?.category === 'server') {
    return result('PROVIDER_NETWORK', 'CHECK_PROVIDER');
  }
  return result('TOOL_FAILURE', 'INSPECT_RESULT');
}
