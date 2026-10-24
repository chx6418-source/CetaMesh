import assert from 'node:assert/strict';
import { attachModelDiagnostics, modelRuntimeError } from '../src/model/types.js';
import { classifyAgentFailure } from '../src/agent/failure-recovery.js';

const rateLimit = attachModelDiagnostics(modelRuntimeError('MODEL_PROVIDER_ERROR', 'safe'),
  { category: 'rate-limit', httpStatus: 429, safeMessage: 'safe' });
assert.deepEqual(classifyAgentFailure(rateLimit), { category: 'RATE_LIMIT', recovery: 'WAIT_FOR_RETRY', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'MODEL_PROVIDER_UNAVAILABLE' }),
  { category: 'PROVIDER_NETWORK', recovery: 'CHECK_PROVIDER', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'MODEL_INVALID_TOOL_SCHEMA' }),
  { category: 'TOOL_SCHEMA', recovery: 'REVIEW_SCHEMA', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'AGENT_CONTEXT_LIMIT' }),
  { category: 'CONTEXT_OVERFLOW', recovery: 'FRESH_SESSION', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'WORKSPACE_CONFLICT' }),
  { category: 'WORKSPACE_CONFLICT', recovery: 'RECONCILE_WORKSPACE', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'APPROVAL_REJECTED' }),
  { category: 'APPROVAL_DENIED', recovery: 'STOP', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'INVOKE_CANCEL_UNCONFIRMED', effectStatus: 'unknown' }),
  { category: 'OUTCOME_UNKNOWN', recovery: 'RECONCILE_EFFECT', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'INVOKE_CANCELLED' }),
  { category: 'USER_CANCELLED', recovery: 'STOP', automaticRetries: 0 });
assert.deepEqual(classifyAgentFailure({ code: 'TOOL_FAILED' }),
  { category: 'TOOL_FAILURE', recovery: 'INSPECT_RESULT', automaticRetries: 0 });
console.log('agent failure recovery: classified, bounded, no uncertain replay');
