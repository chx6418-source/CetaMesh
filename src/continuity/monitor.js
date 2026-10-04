// CetaMesh Continuity —— Context Monitor（阶段 09，TASK-D6-001/002）。
//
// 跟踪每个 Agent Session 的上下文使用率并映射到阈值带：
//   - 真实 usage（provider 回传 inputTokens/outputTokens）优先；
//   - 没有真实 usage 时按字符数估算（chars/charsPerToken），并标记 estimated:true；
//   - window 未知时用 policy.defaultWindowTokens。
// 不伪造任何数字：估算值永远带 estimated 标记，真实值带 source:'usage'。

import { DEFAULT_CONTEXT_POLICY, bandFor, continuityError } from './types.js';

export function createContextMonitor({ policy } = {}) {
  const active = policy ?? DEFAULT_CONTEXT_POLICY;
  const sessions = new Map(); // key -> { inputTokens, outputTokens, promptChars, outputChars, windowTokens, real }

  function normalizeKey(key) {
    const text = String(key ?? '').trim();
    if (!text) throw continuityError('INVALID_PARAMS', 'sessionKey 不能为空');
    return text;
  }

  function stateOf(key) {
    const normalized = normalizeKey(key);
    let state = sessions.get(normalized);
    if (!state) {
      state = { inputTokens: 0, outputTokens: 0, promptChars: 0, outputChars: 0, windowTokens: null, real: false };
      sessions.set(normalized, state);
    }
    return state;
  }

  return {
    /**
     * 记录一次使用增量。字段均可选：
     *   inputTokens/outputTokens —— provider 真实回传（优先，标记 real）；
     *   promptChars/outputChars  —— 无真实 usage 时的估算输入；
     *   windowTokens             —— provider/model 已知窗口（覆盖 policy 默认）。
     */
    record(sessionKey, { inputTokens, outputTokens, promptChars, outputChars, windowTokens } = {}) {
      const state = stateOf(sessionKey);
      const safePositive = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      if (inputTokens !== undefined || outputTokens !== undefined) {
        state.inputTokens += safePositive(inputTokens);
        state.outputTokens += safePositive(outputTokens);
        state.real = state.real || (safePositive(inputTokens) + safePositive(outputTokens) > 0);
      }
      state.promptChars += safePositive(promptChars);
      state.outputChars += safePositive(outputChars);
      if (Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0) {
        state.windowTokens = Math.round(Number(windowTokens));
      }
      return this.level(sessionKey);
    },

    /** 当前使用率与阈值带。tokens 真实值优先，否则字符估算（estimated:true）。 */
    level(sessionKey) {
      const state = stateOf(sessionKey);
      const estimatedTokens = active.charsPerToken > 0
        ? Math.ceil((state.promptChars + state.outputChars) / active.charsPerToken)
        : 0;
      const usedTokens = state.real ? state.inputTokens + state.outputTokens : estimatedTokens;
      const windowTokens = state.windowTokens ?? active.defaultWindowTokens;
      const percent = windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;
      return {
        usedTokens,
        windowTokens,
        percent,
        band: bandFor(percent),
        source: state.real ? 'usage' : 'estimated',
        estimated: !state.real
      };
    },

    reset(sessionKey) {
      sessions.delete(normalizeKey(sessionKey));
    },

    forget(sessionKey) {
      this.reset(sessionKey);
    }
  };
}
