import { randomUUID } from 'node:crypto';

// Provider accounting is kept separate from normalized totals. null means not
// reported, never zero. OpenAI/DeepSeek cache and reasoning counts are subsets;
// Anthropic's input_tokens excludes cache read/write tokens.
const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const RAW_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'windowTokens', 'window_tokens', 'contextWindowTokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const first = (...values) => values.map(number).find(value => value !== null) ?? null;
export function normalizeModelUsage(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const cacheReadTokens = first(u.cacheReadTokens, u.prompt_tokens_details?.cached_tokens, u.input_tokens_details?.cached_tokens, u.prompt_cache_hit_tokens, u.cache_read_input_tokens);
  const cacheWriteTokens = first(u.cacheWriteTokens, u.cache_creation_input_tokens);
  let inputTokens = first(u.inputTokens, u.prompt_tokens, u.input_tokens);
  // Only the explicit Anthropic cache fields identify exclusive input semantics.
  if (number(u.prompt_tokens) === null && number(u.inputTokens) === null && number(u.input_tokens) !== null
    && ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u)) {
    inputTokens = cacheReadTokens !== null && cacheWriteTokens !== null
      ? u.input_tokens + cacheReadTokens + cacheWriteTokens : null;
  }
  const outputTokens = first(u.outputTokens, u.completion_tokens, u.output_tokens);
  const totalTokens = first(u.totalTokens, u.total_tokens,
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const reasoningTokens = first(u.reasoningTokens, u.completion_tokens_details?.reasoning_tokens, u.output_tokens_details?.reasoning_tokens, u.reasoning_tokens);
  const windowTokens = first(u.windowTokens, u.window_tokens, u.contextWindowTokens);
  return { inputTokens, outputTokens, totalTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
    ...(windowTokens > 0 ? { windowTokens: Math.round(windowTokens) } : {}),
    cacheHitRate: inputTokens > 0 && cacheReadTokens !== null && cacheReadTokens <= inputTokens ? cacheReadTokens / inputTokens : null };
}
export function safeRawUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const result = {};
  for (const key of RAW_FIELDS) if (number(raw[key]) !== null) result[key] = raw[key];
  for (const [key, childKey] of [['prompt_tokens_details', 'cached_tokens'], ['input_tokens_details', 'cached_tokens'], ['completion_tokens_details', 'reasoning_tokens'], ['output_tokens_details', 'reasoning_tokens']]) {
    if (number(raw[key]?.[childKey]) !== null) result[key] = { [childKey]: raw[key][childKey] };
  }
  return result;
}
// Only explicit adapter billing evidence is retained; arbitrary cost fields are not invoices.
export function safeBillingReceipt(value) {
  const label = v => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\x00-\x1f]/.test(v);
  if (value?.kind !== 'actual' || number(value.amount) === null || !/^[A-Z]{3}$/.test(value.currency ?? '')
    || !label(value.source) || !label(value.receiptId)) return null;
  return { kind: 'actual', amount: value.amount, currency: value.currency, source: value.source, receiptId: value.receiptId };
}
export function aggregateModelUsage(records) {
  const result = {};
  for (const field of FIELDS) result[field] = records.length && records.every(record => number(record?.[field]) !== null)
    ? records.reduce((sum, record) => sum + record[field], 0) : null;
  const lastWindow = records.findLast(record => number(record?.windowTokens) > 0)?.windowTokens;
  if (lastWindow !== undefined) result.windowTokens = lastWindow;
  result.cacheHitRate = result.inputTokens > 0 && result.cacheReadTokens !== null && result.cacheReadTokens <= result.inputTokens
    ? result.cacheReadTokens / result.inputTokens : null;
  return result;
}
export function accumulateModelUsage(previous, raw, { requestId, providerId = null, model = null } = {}) {
  requestId ??= randomUUID();
  const requests = Array.isArray(previous?.requests) ? [...previous.requests] : [];
  if (requestId && requests.some(row => row.requestId === requestId)) return previous;
  // Legacy persisted approval continuations have one snapshot, not a ledger.
  if (!requests.length && previous) requests.push({ requestId: `legacy:${requestId}`, providerId, model, rawUsage: safeRawUsage(previous), ...normalizeModelUsage(previous) });
  requests.push({ requestId: requestId ?? `request-${requests.length + 1}`, providerId, model, rawUsage: safeRawUsage(raw), billingReceipt: safeBillingReceipt(raw?.billingReceipt), ...normalizeModelUsage(raw) });
  const result = { ...aggregateModelUsage(requests), requestCount: requests.length, requests };
  for (const [rawKey, field] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']]) {
    if (result[field] !== null) result[rawKey] = result[field];
  }
  return result;
}
