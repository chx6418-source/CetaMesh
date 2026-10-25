// Capacity is provider-owned metadata, never a request/model-generated claim.
// Estimates are deliberately conservative, NOT a tokenizer or guaranteed bound.
import { modelRuntimeError } from '../model/types.js';
const positive = value => Number.isSafeInteger(value) && value > 0;
function invalid() { throw modelRuntimeError('MODEL_CONTEXT_BUDGET_INVALID', 'Invalid provider context capacity or output reservation'); }
export function calculateModelContextBudget({ provider, model, messages, tools = [], maxOutputTokens } = {}) {
  const capacity = provider.contextCapabilities?.(model);
  if (!capacity || capacity.status === 'unknown') return {
    status: 'unknown', counting: 'unknown', contextWindowTokens: null, inputTokens: null,
    reservedOutputTokens: null, remainingTokens: null, source: null
  };
  if (!['declared', 'verified'].includes(capacity.status)
    || !positive(capacity.contextWindowTokens) || !positive(capacity.maxOutputTokens)
    || !positive(capacity.defaultOutputTokens) || typeof capacity.source !== 'string' || !capacity.source.trim() || capacity.source.length > 512
    || typeof capacity.version !== 'string' || !capacity.version.trim() || capacity.version.length > 128
    || capacity.defaultOutputTokens > capacity.maxOutputTokens) invalid();
  const reservedOutputTokens = maxOutputTokens ?? capacity.defaultOutputTokens;
  if (!positive(reservedOutputTokens) || reservedOutputTokens > capacity.maxOutputTokens
    || reservedOutputTokens >= capacity.contextWindowTokens) invalid();
  const exact = provider.countInputTokens?.({ model, messages, tools });
  let inputTokens, counting, estimator;
  if (exact != null) {
    // Counter must include model framing, tool schemas and native continuation.
    if (exact.exact !== true || !Number.isSafeInteger(exact.tokens) || exact.tokens < 0
      || typeof exact.tokenizer !== 'string' || !exact.tokenizer) invalid();
    inputTokens = exact.tokens; counting = 'exact'; estimator = exact.tokenizer;
  } else {
    if (Array.isArray(messages) && messages.some(m => Array.isArray(m?.content)
      && m.content.some(part => part?.type !== 'text'))) {
      throw modelRuntimeError('MODEL_CONTEXT_COUNT_UNAVAILABLE', 'This model requires a modality-aware token counter before context preflight');
    }
    // Full serialization preserves tool IDs, continuation and schema text in accounting.
    // Extra framing is a safety allowance, not a claim about provider tokenizer internals.
    inputTokens = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8')
      + 64 + (Array.isArray(messages) ? messages.length * 16 : 0)
      + (Array.isArray(tools) ? tools.length * 32 : 0);
    counting = 'estimated'; estimator = 'utf8-conservative-v1';
  }
  const remainingTokens = capacity.contextWindowTokens - reservedOutputTokens - inputTokens;
  return { status: remainingTokens < 0 ? 'exceeded' : 'within-budget', counting, estimator,
    contextWindowTokens: capacity.contextWindowTokens, inputTokens, reservedOutputTokens,
    remainingTokens, source: capacity.source, version: capacity.version, capacityStatus: capacity.status };
}
export function enforceModelContextBudget(options) {
  const budget = calculateModelContextBudget(options);
  if (budget.status === 'exceeded') {
    const error = modelRuntimeError('MODEL_CONTEXT_BUDGET_EXCEEDED', 'Context budget exceeded; compact with retained evidence or select a verified larger model before retrying');
    error.contextBudget = budget; // numeric/provider metadata only; never prompt contents
    throw error;
  }
  return budget;
}
