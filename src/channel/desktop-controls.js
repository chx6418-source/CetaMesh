import { channelError } from './delivery-journal.js';

// Only the local desktop composition root supplies this adapter to Integrations.
// Action arguments never select a method, actor, configuration, account or path.
const OWNER = Object.freeze({ kind: 'owner', id: 'desktop' });
const knownBoolean = value => typeof value === 'boolean' ? value : null;
const errorView = error => error ? { code: String(error.code ?? 'CHANNEL_UNAVAILABLE'), message: String(error.message ?? error).slice(0, 300) } : null;

export function createChannelDesktopControls({ channelService, bionicService } = {}) {
  const unchecked = () => ({ status: 'not-checked', installed: null, configured: null,
    running: false, ready: false, authenticated: false, canSend: false, accountId: null, lastError: null });
  const cache = { qq: unchecked(), bionic: unchecked() };
  const lifecycle = { qq: Promise.resolve(), bionic: Promise.resolve() };

  function project(kind, raw = {}) {
    const accountId = /^\d{1,20}$/.test(String(raw.accountId ?? '')) ? String(raw.accountId) : null;
    const authenticated = raw.ready === true && accountId !== null && raw.authenticated !== false;
    const running = raw.running === true || raw.ready === true || raw.state === 'running' || Number(raw.processId) > 0;
    const ready = raw.ready === true && authenticated;
    return { status: ready ? 'ready' : running ? 'running' : raw.state ?? 'stopped',
      installed: knownBoolean(raw.installed), configured: knownBoolean(raw.configured),
      running, ready, authenticated, canSend: kind === 'qq' && ready && raw.canSend !== false,
      readiness:raw.readiness??null,activity:raw.activity??null,accountId, lastError: errorView(raw.error ?? raw.lastError),
      ...(Number(raw.processId) > 0 ? { processId: raw.processId } : {}) };
  }

  async function dispatch(kind, action) {
    if (typeof channelService?.execute !== 'function' || (kind === 'bionic' && !bionicService)) {
      throw channelError('CHANNEL_UNAVAILABLE', 'Desktop Channel lifecycle service is unavailable');
    }
    return channelService.execute({ method: `channel.${kind}.${action}`, actor: OWNER });
  }

  async function health(kind) {
    try {
      cache[kind] = project(kind, await dispatch(kind, 'health'));
      return structuredClone(cache[kind]);
    } catch (error) {
      cache[kind] = { ...cache[kind], status: 'unavailable', ready: false, authenticated: false, canSend: false, lastError: errorView(error) };
      throw error;
    }
  }

  function action(kind, operation) {
    return () => {
      const run = async () => {
        try {
          const result = await dispatch(kind, operation);
          await health(kind);
          if (kind === 'qq' && ['stop', 'reconnect'].includes(operation)) await health('bionic').catch(() => { /* Independent runtime diagnostics are retained in its cache. */ });
          if (result?.ok === false || result?.error) {
            cache[kind] = { ...cache[kind], ready: false, authenticated: false, canSend: false,
              lastError: errorView({ code: result.code, message: result.error ?? 'Channel operation did not complete' }) };
          }
          return structuredClone(cache[kind]);
        } catch (error) {
          // Refresh actual state after a partial startup/shutdown before reporting failure.
          await health(kind).catch(() => { /* Preserve the original action failure below. */ });
          cache[kind] = { ...cache[kind], lastError: errorView(error) };
          throw error;
        }
      };
      const result = lifecycle[kind].then(run, run);
      lifecycle[kind] = result.catch(() => { /* A failed action must not poison later stop/reconnect operations. */ });
      return result;
    };
  }

  const qq = Object.freeze({ health: () => health('qq'), start: action('qq', 'start'), stop: action('qq', 'stop'),
    reconnect: action('qq', 'reconnect'), detect: () => health('qq') });
  const bionic = Object.freeze({ health: () => health('bionic'), start: action('bionic', 'start'), stop: action('bionic', 'stop'),reconnect:action('bionic','reconnect') });
  const localServices = () => ({ snowluma: structuredClone(cache.qq), qq: structuredClone(cache.qq), bionic: structuredClone(cache.bionic) });
  localServices.actions = Object.freeze({ snowluma: qq, qq, bionic });
  localServices.refresh = async () => { await Promise.allSettled([health('qq'), health('bionic')]); return localServices(); };
  return localServices;
}
