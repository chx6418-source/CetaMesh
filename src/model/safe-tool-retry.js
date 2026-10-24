// A narrow, server-owned allowlist. Model input cannot opt a capability into retry.
const READ_ONLY = new Set(['filesystem.read', 'git.diff', 'git.status', 'context.evidence.read']);
const TRANSIENT = new Set(['EAGAIN', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN']);
import { capabilityError } from '../capability/types.js';

export const SAFE_TOOL_RETRY = Object.freeze({ maxAttempts: 2, delayMs: 40, deadlineMs: 250 });

export function mayRetrySafeTool({ capability, error, attempt, startedAt, signal, dispatchStatus } = {}) {
  return READ_ONLY.has(capability)
    && TRANSIENT.has(error?.code)
    && error?.effectStatus !== 'unknown'
    && !signal?.aborted
    && attempt + 1 < SAFE_TOOL_RETRY.maxAttempts
    && Date.now() - startedAt + SAFE_TOOL_RETRY.delayMs <= SAFE_TOOL_RETRY.deadlineMs
    && (!dispatchStatus || dispatchStatus.status === 'failed');
}

/** End a retried read at its short deadline even if a provider ignores abort. */
export async function runBoundedRetryAttempt(execute, { signal, remainingMs }) {
  if (signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Tool execution was cancelled');
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw capabilityError('TOOL_RETRY_DEADLINE', 'Bounded read retry deadline elapsed before dispatch');
  }
  const controller = new AbortController();
  let timeout;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => {
      const error = capabilityError('INVOKE_CANCELLED', 'Tool execution was cancelled');
      controller.abort(error);
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      // The underlying Broker may ignore cancellation. Reconciliation is safer
      // than claiming a read completed or starting another attempt.
      const error = capabilityError('TOOL_RETRY_TIMEOUT', 'Bounded read retry did not settle');
      error.effectStatus = 'unknown';
      controller.abort(error);
      reject(error);
    }, Math.max(1, Math.floor(remainingMs)));
  });
  try { return await Promise.race([Promise.resolve().then(() => execute(controller.signal)), stopped]); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); }
}
