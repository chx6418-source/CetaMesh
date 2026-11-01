export function createBusyOpenWriter(write, {
  timeoutMs = 15000, intervalMs = 100, now = () => performance.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {}
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 15000 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('Invalid busy-open retry bound');
  return async (...args) => {
    const deadline = now() + timeoutMs, maxRetries = Math.ceil(timeoutMs / intervalMs);
    let retries = 0;
    for (;;) {
      try { return await write(...args); }
      catch (error) {
        const remaining = deadline - now();
        // An open failure precedes truncation/writing. Never retry denied access,
        // a partially completed write, or an unknown injector failure.
        if (error?.code !== 'EBUSY' || error?.syscall !== 'open' || !Number.isFinite(remaining) || remaining <= 0 || retries >= maxRetries) throw error;
        onRetry(++retries);
        await wait(Math.min(intervalMs, remaining));
      }
    }
  };
}
