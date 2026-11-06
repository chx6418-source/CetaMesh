// Core-only cancellation. Preserve a fixed code without exposing a caller's reason.
export function assertObservationActive(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Core observation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}
