import {
  stablePromptPrefix,
  buildConversationPrompt,
  contextBudgetForModel,
  estimatePromptMessageTokens,
  selectConversationHistory,
} from '../runtime/chat/PromptBuilder';

test('keeps a deterministic prefix before dynamic history without timestamps or trace IDs', () => {
  const first = buildConversationPrompt([{role: 'user', content: '你好'}]);
  const second = buildConversationPrompt([{role: 'user', content: '另一个问题'}]);
  expect(first[0]).toEqual(second[0]);
  expect(first[0].content).toBe(stablePromptPrefix);
  expect(JSON.stringify(first[0])).not.toMatch(/timestamp|traceId|requestId|2026-/);
  expect(first.at(-1)?.content).toBe('你好');
});

test('keeps newest context and trims oldest messages to the internal input budget', () => {
  const systemCost = estimatePromptMessageTokens({role: 'system', content: stablePromptPrefix});
  const newest = {role: 'user' as const, content: '最新问题'};
  const result = selectConversationHistory([
    {role: 'user', content: 'old '.repeat(400)},
    {role: 'assistant', content: 'older '.repeat(400)},
    newest,
  ], systemCost + estimatePromptMessageTokens(newest) + 8);

  expect(result.history).toEqual([newest]);
  expect(result.truncated).toBe(true);
  expect(result.overBudget).toBe(false);
});

test('marks a single latest message that cannot fit instead of silently dropping it', () => {
  const systemCost = estimatePromptMessageTokens({role: 'system', content: stablePromptPrefix});
  const latest = {role: 'user' as const, content: '超长内容'.repeat(100)};
  const result = selectConversationHistory([latest], systemCost + 4);

  expect(result.history).toEqual([latest]);
  expect(result.truncated).toBe(true);
  expect(result.overBudget).toBe(true);
});


test('recognizes explicit 1M model context identifiers without changing the safe default', () => {
  expect(contextBudgetForModel('plain-model')).toEqual({
    contextWindowTokens: 128_000,
    inputBudgetTokens: 96_000,
  });
  expect(contextBudgetForModel('vendor/model-1m-preview')).toEqual({
    contextWindowTokens: 1_000_000,
    inputBudgetTokens: 900_000,
  });
  expect(contextBudgetForModel('vendor/model-1024k')).toEqual({
    contextWindowTokens: 1_000_000,
    inputBudgetTokens: 900_000,
  });
});
