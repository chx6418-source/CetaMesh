export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  providerReported: boolean;
};

export type SessionUsage = TokenUsage & {turns: number; partial: boolean};

export function cacheHitRate(usage: (Partial<TokenUsage> & {partial?: boolean}) | undefined): number | null {
  if (!usage || usage.partial || usage.cachedInputTokens === undefined || usage.cacheMissInputTokens === undefined) {return null;}
  const total = usage.cachedInputTokens + usage.cacheMissInputTokens;
  return total > 0 ? usage.cachedInputTokens / total * 100 : null;
}
