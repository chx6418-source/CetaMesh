// CetaMesh Continuity —— Context Monitor（阶段 09，TASK-D6-001/002）。
//
// 跟踪每个 Agent Session 的上下文使用率并映射到阈值带：
//   - 真实 usage（provider 回传 inputTokens/outputTokens）优先；
//   - 没有真实 usage 时按字符数估算（chars/charsPerToken），并标记 estimated:true；
//   - window 未知时用 policy.defaultWindowTokens。
// 不伪造任何数字：估算值永远带 estimated 标记，真实值带 source:'usage'。

import { DEFAULT_CONTEXT_POLICY, bandFor, continuityError } from './types.js';

export function createContextMonitor({ policy, initialSessions = {}, onChange = null } = {}) {
  const active = policy ?? DEFAULT_CONTEXT_POLICY;
  const sessions = new Map(Object.entries(initialSessions && typeof initialSessions === 'object' ? initialSessions : {})
    .filter(([key, value]) => key && value && typeof value === 'object' && !Array.isArray(value)));
  function persist() { onChange?.(Object.fromEntries(sessions)); }

  function normalizeKey(key) {
    const text = String(key ?? '').trim();
    if (!text) throw continuityError('INVALID_PARAMS', 'sessionKey 不能为空');
    return text;
  }

  function stateOf(key) {
    const normalized = normalizeKey(key);
    let state = sessions.get(normalized);
    if (!state) {
      state = { inputTokens: 0, outputTokens: 0, estimatedTokens: 0,
        promptChars: 0, outputChars: 0, windowTokens: null, real: false };
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
      const realInput = safePositive(inputTokens), realOutput = safePositive(outputTokens);
      if (realInput + realOutput > 0) {
        state.inputTokens += realInput;
        state.outputTokens += realOutput;
        state.real = true;
        if (active.charsPerToken > 0) {
          const missingChars = (inputTokens === undefined || inputTokens === null ? safePositive(promptChars) : 0)
            + (outputTokens === undefined || outputTokens === null ? safePositive(outputChars) : 0);
          state.estimatedTokens = (state.estimatedTokens ?? 0) + Math.ceil(missingChars / active.charsPerToken);
        }
      } else if (active.charsPerToken > 0) {
        state.estimatedTokens = (state.estimatedTokens ?? 0)
          + Math.ceil((safePositive(promptChars) + safePositive(outputChars)) / active.charsPerToken);
      }
      state.promptChars += safePositive(promptChars);
      state.outputChars += safePositive(outputChars);
      if (Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0) {
        state.windowTokens = Math.round(Number(windowTokens));
      }
      persist();
      return this.level(sessionKey);
    },

    /** 当前使用率与阈值带。tokens 真实值优先，否则字符估算（estimated:true）。 */
    level(sessionKey) {
      const state = stateOf(sessionKey);
      const estimatedTokens = state.estimatedTokens ?? (state.real ? 0 : active.charsPerToken > 0
        ? Math.ceil((state.promptChars + state.outputChars) / active.charsPerToken) : 0);
      const usedTokens = state.inputTokens + state.outputTokens + estimatedTokens;
      const windowTokens = state.windowTokens ?? active.defaultWindowTokens;
      const percent = windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;
      return {
        usedTokens,
        windowTokens,
        percent,
        band: bandFor(percent),
        source: state.real ? (estimatedTokens > 0 ? 'mixed' : 'usage') : 'estimated',
        estimated: !state.real || estimatedTokens > 0
      };
    },

    reset(sessionKey) {
      sessions.delete(normalizeKey(sessionKey));
      persist();
    },

    forget(sessionKey) {
      this.reset(sessionKey);
    }
  };
}
