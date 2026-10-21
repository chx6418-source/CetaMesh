export function createApplicationLifecycle({ processRef = process, log = () => {},
  handlerTimeoutMs = 5000, shutdownTimeoutMs = 30000 } = {}) {
  const shutdownHandlers = [];
  let bound = false;
  let stopPromise = null;
  const handlerBudget = Number.isFinite(handlerTimeoutMs) && handlerTimeoutMs > 0 ? handlerTimeoutMs : 5000;
  const totalBudget = Number.isFinite(shutdownTimeoutMs) && shutdownTimeoutMs > 0 ? shutdownTimeoutMs : 30000;

  function reportFailure(message) {
    try { log(message); }
    catch (error) { void error; /* Logging must not interrupt remaining resource cleanup or release ownership. */ }
  }

  async function drain() {
    const outcomes = [];
    const deadline = Date.now() + totalBudget;
    let ok = true;
    for (let i = shutdownHandlers.length - 1; i >= 0; i -= 1) {
      const { handler, name, requireCleanShutdown } = shutdownHandlers[i];
      if (requireCleanShutdown && !ok) {
        outcomes.push({ name, status: 'skipped', code: 'CLEANUP_UNCONFIRMED' });
        reportFailure('Application retains ' + name + ': resource cleanup is unconfirmed');
        continue;
      }
      const budget = Math.min(handlerBudget, deadline - Date.now());
      if (budget <= 0) {
        outcomes.push({ name, status: 'timed_out', code: 'SHUTDOWN_TIMEOUT' });
        ok = false;
        reportFailure('Application shutdown timed out before ' + name);
        continue;
      }
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(handler),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Cleanup deadline exceeded'), { code: 'SHUTDOWN_TIMEOUT' })), budget);
          })
        ]);
        if (result && typeof result === 'object' && result.ok === false) {
          throw Object.assign(new Error('Resource cleanup was not confirmed'), { code: result.code ?? 'CLEANUP_UNCONFIRMED' });
        }
        outcomes.push({ name, status: 'completed' });
      } catch (error) {
        ok = false;
        outcomes.push({ name, status: error?.code === 'SHUTDOWN_TIMEOUT' ? 'timed_out' : 'failed',
          code: error?.code ?? 'SHUTDOWN_FAILED', message: String(error?.message ?? error) });
        reportFailure('Application shutdown failed (' + name + '): ' + String(error?.message ?? error));
      } finally { clearTimeout(timer); }
    }
    return { ok, status: ok ? 'completed' : 'incomplete', outcomes };
  }

  function stop() {
    // Set the shared Promise before invoking any cleanup, including reentrant
    // handlers. A synchronous caller immediately closes the request gate.
    if (!stopPromise) stopPromise = Promise.resolve().then(drain);
    return stopPromise;
  }

  return {
    register(handler, { name = 'handler-' + shutdownHandlers.length, requireCleanShutdown = false } = {}) {
      if (stopPromise) throw new Error('Application lifecycle is already stopping');
      if (typeof handler !== 'function') throw new TypeError('Application lifecycle handler must be a function');
      shutdownHandlers.push({ handler, name, requireCleanShutdown });
      return handler;
    },
    bind() {
      if (!bound) {
        // Natural process drain can await cleanup. The exit fallback may only
        // initiate shutdown; it cannot release ownership ahead of promises.
        processRef.once('beforeExit', stop);
        processRef.once('exit', stop);
        bound = true;
      }
      return stop;
    },
    isStopping: () => stopPromise !== null,
    stop
  };
}
import { MessageChannel } from 'node:worker_threads';

// An uncertain resource still needs a live owner PID. A referenced local port
// keeps that owner alive without polling or creating a network listener.
export function createApplicationOwnershipHold() {
  const { port1, port2 } = new MessageChannel();
  port1.on('message', () => {});
  port1.ref();
  port2.unref();
  return { close() { port1.close(); port2.close(); } };
}
