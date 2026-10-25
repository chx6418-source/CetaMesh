import type {ChatRequest, MessageContent} from '../../domain/model/ModelProvider';

// Kept literal and versioned. Do not interpolate clocks, IDs, device state or usage here.
export const stablePromptPrefix =
  'You are CetaMesh. Answer clearly in the user’s language. Use headings, short paragraphs and lists when helpful. Present final results directly. Do not put tool progress or private reasoning in the final answer.';

// This is an internal context-admission estimate only. Provider-reported usage remains the
// sole source of Token Usage shown in the product.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_INPUT_CONTEXT_BUDGET_TOKENS = 96_000;
export const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const LARGE_INPUT_CONTEXT_BUDGET_TOKENS = 900_000;

export type ModelContextBudget = {
  contextWindowTokens: number;
  inputBudgetTokens: number;
};

export function contextBudgetForModel(modelId: string): ModelContextBudget {
  const normalized = modelId.trim().toLowerCase();
  const explicitlyLarge =
    /(?:^|[^a-z0-9])(?:1m|1000k|1024k|1048576)(?:$|[^a-z0-9])/.test(normalized);
  return explicitlyLarge
    ? {
        contextWindowTokens: LARGE_CONTEXT_WINDOW_TOKENS,
        inputBudgetTokens: LARGE_INPUT_CONTEXT_BUDGET_TOKENS,
      }
    : {
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        inputBudgetTokens: DEFAULT_INPUT_CONTEXT_BUDGET_TOKENS,
      };
}

function estimateTextTokens(text: string): number {
  let estimate = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    estimate += code <= 0x7f ? 0.3 : 1;
  }
  return Math.ceil(estimate);
}

function estimateContentTokens(content: MessageContent): number {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }
  return content.reduce((sum, part) => {
    if (part.type === 'text') {
      return sum + estimateTextTokens(part.text);
    }
    // Image tokenization varies by provider/model. Reserve a conservative fixed allowance
    // rather than treating base64 bytes as text tokens.
    return sum + (part.image_url.url.startsWith('data:') ? 4096 : 1024);
  }, 0);
}

export function estimatePromptMessageTokens(message: ChatRequest['messages'][number]): number {
  return 8 + estimateContentTokens(message.content);
}

export type ContextSelection = {
  history: ChatRequest['messages'];
  truncated: boolean;
  overBudget: boolean;
  estimatedInputTokens: number;
};

export function selectConversationHistory(
  history: ChatRequest['messages'],
  budgetTokens = DEFAULT_INPUT_CONTEXT_BUDGET_TOKENS,
): ContextSelection {
  const systemTokens = estimatePromptMessageTokens({role: 'system', content: stablePromptPrefix});
  let used = systemTokens;
  const selected: Array<ChatRequest['messages'][number]> = [];
  let truncated = false;
  let overBudget = false;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const cost = estimatePromptMessageTokens(message);
    if (used + cost > budgetTokens) {
      if (!selected.length) {
        selected.unshift(message);
        used += cost;
        overBudget = true;
      }
      truncated = index >= 0;
      break;
    }
    selected.unshift(message);
    used += cost;
  }

  return {
    history: selected,
    truncated,
    overBudget,
    estimatedInputTokens: used,
  };
}

export function buildConversationPrompt(history: ChatRequest['messages']): ChatRequest['messages'] {
  return [{role: 'system', content: stablePromptPrefix}, ...history];
}
