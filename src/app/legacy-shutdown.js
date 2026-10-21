import { createApplicationLifecycle, createApplicationOwnershipHold } from './lifecycle.js';

// Legacy owns the same StateDir lease as Core. Keep process exit and both lease
// releases behind one awaited resource drain, including failures during startup.
export function createLegacyShutdown({ owner, releaseLegacyLock, processRef = process,
  log = () => {}, handlerTimeoutMs, shutdownTimeoutMs,
  retainOwnership = createApplicationOwnershipHold } = {}) {
  const lifecycle = createApplicationLifecycle({ processRef, log, handlerTimeoutMs, shutdownTimeoutMs });
  lifecycle.register(() => owner.release(), { name: 'StateDir owner', requireCleanShutdown: true });
  lifecycle.register(() => releaseLegacyLock(), { name: 'Legacy bridge lock', requireCleanShutdown: true });
  let shutdownPromise = null;
  let exitCode = 0;
  let ownershipHold = null;
  function shutdown(code = 0) {
    exitCode = Math.max(exitCode, code);
    if (!shutdownPromise) shutdownPromise = lifecycle.stop().then(report => {
      if (report.ok) processRef.exit(exitCode);
      else {
        processRef.exitCode = 1;
        log('Legacy shutdown is incomplete; retaining the live StateDir owner until resource cleanup is confirmed.');
        ownershipHold ??= retainOwnership();
      }
      return report;
    });
    return shutdownPromise;
  }
  function register(handler, options) {
    return lifecycle.register(async () => {
      const result = await handler();
      if (result && typeof result === 'object' && result.ok === false) {
        throw Object.assign(new Error('Legacy resource cleanup was not confirmed'), { code: result.code ?? 'CLEANUP_UNCONFIRMED' });
      }
      return result;
    }, options);
  }
  function registerServer(server, { name } = {}) {
    const sockets = new Set();
    server.on('connection', socket => {
      if (lifecycle.isStopping()) { socket.destroy(); return; }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    register(() => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    }), { name });
  }
  return {
    lifecycle, register, registerServer, shutdown, isStopping: lifecycle.isStopping,
    bind() {
      lifecycle.bind();
      processRef.once('beforeExit', () => { void shutdown(); });
    }
  };
}
