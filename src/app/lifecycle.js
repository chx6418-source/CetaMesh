export function createApplicationLifecycle({ processRef = process, log = () => {} } = {}) {
  const shutdownHandlers = [];
  let bound = false;
  let stopped = false;

  function stop() {
    if (stopped) return false;
    stopped = true;
    for (let i = shutdownHandlers.length - 1; i >= 0; i -= 1) {
      try {
        const result = shutdownHandlers[i]();
        if (result && typeof result.catch === 'function') {
          result.catch(error => log('Application shutdown failed: ' + (error?.message ?? error)));
        }
      } catch (error) {
        log('Application shutdown failed: ' + (error?.message ?? error));
      }
    }
    return true;
  }

  return {
    register(handler) {
      if (stopped) throw new Error('Application lifecycle is already stopped');
      if (typeof handler !== 'function') throw new TypeError('Application lifecycle handler must be a function');
      shutdownHandlers.push(handler);
      return handler;
    },
    bind() {
      if (!bound) {
        processRef.once('exit', stop);
        bound = true;
      }
      return stop;
    },
    stop
  };
}
