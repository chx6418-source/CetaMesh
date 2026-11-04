// Continuity owns the latest effective request occupancy, not cumulative billing.
// Model usage ledgers retain costs and receipts. Historical monitor files without
// snapshotVersion contain cumulative totals and cannot establish current context.
import { DEFAULT_CONTEXT_POLICY, bandFor, continuityError } from './types.js';

export function createContextMonitor({ policy, initialSessions = {}, onChange = null } = {}) {
  const active = policy ?? DEFAULT_CONTEXT_POLICY;
  const sessions = new Map(Object.entries(initialSessions && typeof initialSessions === 'object' ? initialSessions : {})
    .filter(([key, value]) => key && value && typeof value === 'object' && !Array.isArray(value)));
  const persist = () => onChange?.(Object.fromEntries(sessions));
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  function normalizeKey(key) {
    const text = String(key ?? '').trim();
    if (!text) throw continuityError('INVALID_PARAMS', 'sessionKey is required');
    return text;
  }
  return {
    // Explicit record callers may provide the full effective input's character
    // count. Turn observers must never substitute only the latest user message.
    record(sessionKey, { inputTokens, outputTokens, promptChars, outputChars, windowTokens, requestId, accountingComplete } = {}) {
      const key = normalizeKey(sessionKey);
      const actualInput = number(inputTokens), actualOutput = number(outputTokens);
      const estimatedInput = actualInput === null && number(promptChars) > 0
        ? Math.ceil(promptChars / active.charsPerToken) : null;
      const estimatedOutput = actualOutput === null && number(outputChars) > 0
        ? Math.ceil(outputChars / active.charsPerToken) : 0;
      const input = actualInput ?? estimatedInput;
      const capacity = number(windowTokens) > 0 ? Math.round(windowTokens) : null;
      // Cache read/write and reasoning are subsets of normalized request usage.
      // They are deliberately absent here and cannot be added a second time.
      const usedTokens = input === null ? null : input + (actualOutput ?? estimatedOutput);
      const estimated = input !== null && (estimatedInput !== null || estimatedOutput > 0);
      sessions.set(key, { snapshotVersion: 1, usedTokens, windowTokens: capacity,
        source: input === null ? 'unknown' : estimated ? (actualInput !== null || actualOutput !== null ? 'mixed' : 'estimated') : 'usage',
        estimated: input === null || estimated,
        ...(typeof requestId === 'string' && requestId ? { requestId: requestId.slice(0, 512) } : {}),
        ...(accountingComplete === false ? { accountingComplete: false } : {}) });
      persist();
      return this.level(key);
    },
    level(sessionKey) {
      const state = sessions.get(normalizeKey(sessionKey));
      const current = state?.snapshotVersion === 1;
      const usedTokens = current ? number(state.usedTokens) : null;
      const windowTokens = current && number(state.windowTokens) > 0 ? state.windowTokens : null;
      const percent = usedTokens !== null && windowTokens !== null
        ? Math.min(100, Math.round(usedTokens / windowTokens * 100)) : null;
      return { usedTokens, windowTokens, percent, band: percent === null ? 'unknown' : bandFor(percent),
        source: current ? state.source : 'unknown', estimated: current ? state.estimated : true,
        ...(state?.accountingComplete === false ? { accountingComplete: false } : {}) };
    },
    reset(sessionKey) { sessions.delete(normalizeKey(sessionKey)); persist(); },
    forget(sessionKey) { this.reset(sessionKey); }
  };
}
