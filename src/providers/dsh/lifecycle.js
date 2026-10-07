import { DEFAULT_DSH_POLL_INTERVAL_MS, resolveDshPollInterval } from './lifecycle-policy.js';

function describeError(error) {
  return String(error?.message ?? error ?? 'Unknown DSH probe failure');
}

export function createDshLifecycle({
  probe,
  intervalMs = DEFAULT_DSH_POLL_INTERVAL_MS,
  onChange,
  onRefresh,
  log = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('DSH lifecycle requires a probe function');
  const listeners = new Set();
  let state = { state: 'unknown', ready: false, error: null, checkedAt: null };
  let timer = null;
  let started = false;
  let stopped = false;
  let inFlight = null;
  const pollIntervalMs = resolveDshPollInterval(intervalMs);

  function status() {
    return { ...state };
  }

  function notify(callback, ...args) {
    if (typeof callback !== 'function') return;
    try {
      const result = callback(...args);
      if (result && typeof result.catch === 'function') {
        result.catch(error => log('DSH lifecycle callback failed: ' + describeError(error)));
      }
    } catch (error) {
      log('DSH lifecycle callback failed: ' + describeError(error));
    }
  }

  function update(nextState, error = null) {
    const previousStatus = status();
    state = {
      state: nextState,
      ready: nextState === 'ready',
      error: error ? describeError(error) : null,
      checkedAt: Date.now()
    };
    const nextStatus = status();
    if (nextStatus.state !== previousStatus.state) {
      notify(onChange, nextStatus, previousStatus);
      for (const listener of listeners) notify(listener, nextStatus, previousStatus);
    }
    return { status: nextStatus, previousStatus };
  }

  function subscribe(listener, { immediate = false } = {}) {
    if (typeof listener !== 'function') throw new TypeError('DSH lifecycle listener must be a function');
    listeners.add(listener);
    if (immediate) notify(listener, status(), status());
    return () => listeners.delete(listener);
  }

  function refresh() {
    if (stopped) return Promise.resolve(status());
    if (inFlight) return inFlight;
    const beforeProbe = status();
    const work = (async () => {
      let result;
      let error = null;
      try {
        result = await probe();
        if (result === false || result?.ok === false) {
          throw result?.error ?? new Error('DSH probe reported unavailable');
        }
      } catch (probeError) {
        error = probeError;
      }
      if (stopped) return status();

      let transition;
      if (!error) {
        transition = update('ready');
      } else if (beforeProbe.state === 'ready') {
        transition = update('recovering', error);
      } else {
        transition = update('unavailable', error);
      }
      notify(onRefresh, { ...transition, error, intervalMs: pollIntervalMs });
      return status();
    })();
    inFlight = work.finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (stopped) return Promise.resolve(status());
    if (started) return inFlight ?? Promise.resolve(status());
    started = true;
    timer = setIntervalFn(() => { void refresh(); }, pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return refresh();
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    update('stopped');
    return true;
  }

  return {
    start,
    stop,
    refresh,
    status,
    subscribe,
    onChange: subscribe,
    get pollIntervalMs() { return pollIntervalMs; }
  };
}
