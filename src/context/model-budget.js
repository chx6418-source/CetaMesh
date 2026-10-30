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
    let imageTokens=0;
    const countedMessages=structuredClone(messages);
    for(const m of countedMessages??[])if(Array.isArray(m?.content))for(let i=0;i<m.content.length;i++){
      const part=m.content[i];if(part?.type==='text')continue;const cap=provider.imageInputCapabilities?.(model);
      const imageBound=part.image_url?.detail==='low'?cap?.lowDetailTokens:cap?.maxImageTokens;
      if(part?.type!=='image_url'||!['low','auto','high','original'].includes(part.image_url?.detail)||cap?.supported!==true||!positive(imageBound))throw modelRuntimeError('MODEL_CONTEXT_COUNT_UNAVAILABLE','此模型缺少当前图像输入模式的预算信息');
      imageTokens+=imageBound;m.content[i]={type:'text',text:'[bounded image input]'};
    }
    // Full serialization preserves tool IDs, continuation and schema text in accounting.
    // Extra framing is a safety allowance, not a claim about provider tokenizer internals.
    inputTokens = imageTokens+Buffer.byteLength(JSON.stringify({ messages:countedMessages, tools }), 'utf8')
      + 64 + (Array.isArray(messages) ? messages.length * 16 : 0)
      + (Array.isArray(tools) ? tools.length * 32 : 0);
    counting = 'estimated'; estimator = imageTokens?'utf8-plus-declared-image-upper-bound-v1':'utf8-conservative-v1';
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
