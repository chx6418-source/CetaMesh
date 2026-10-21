import {cacheHitRate, type TokenUsage} from '../../domain/model/TokenUsage';
export {cacheHitRate};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  const raw = record(value);
  const inputTokens = count(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = count(raw.completion_tokens ?? raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {return undefined;}
  const totalTokens = count(raw.total_tokens) ?? inputTokens + outputTokens;
  const details = record(raw.prompt_tokens_details ?? raw.input_tokens_details);
  const cachedInputTokens = count(raw.prompt_cache_hit_tokens ?? details.cached_tokens);
  const explicitMiss = count(raw.prompt_cache_miss_tokens);
  // OpenAI Chat Completions and DeepSeek prompt_tokens include cached input.
  const cacheMissInputTokens = explicitMiss ?? (cachedInputTokens !== undefined && cachedInputTokens <= inputTokens ? inputTokens - cachedInputTokens : undefined);
  return {
    inputTokens, outputTokens, totalTokens, providerReported: true,
    ...(cachedInputTokens !== undefined && cacheMissInputTokens !== undefined && cachedInputTokens + cacheMissInputTokens <= inputTokens
      ? {cachedInputTokens, cacheMissInputTokens} : {}),
  };
}
