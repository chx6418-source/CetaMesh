import { agentProviderError } from './agent-provider.js';

const MAX_EVENTS = 512;
const FOLLOW_REQUEST = sessionId => ({ request: { address: { kind: 'session', sessionId } } });

// One DSH native reader per Session. The native 0.1.5-rc.1 follow request has no
// sinceSequence; replay is a Core cache plus the native opening snapshot.
export function createDshFollowHub({ api }) {
  const sessions = new Map();
  let stopped = false;
  function wake(state) { for (const done of state.waiters.splice(0)) done(); }
  function stateOf(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { events: [], lastSeq: 0, snapshotSeen: false, waiters: [], reader: null, controller: null,
        error: null, ended: false, lastTurnTerminal: false, closed: false };
      sessions.set(sessionId, state);
    }
    return state;
  }
  function ingest(state, item) {
    if (item?.type === 'snapshot') {
      const records = Array.isArray(item.records) ? item.records : [];
      if (state.lastSeq === 0 && Number.isSafeInteger(item.cursor) && item.cursor > 0 && records.length === 0) {
        throw agentProviderError('AGENT_EVENT_GAP', 'DSH opening snapshot has no records for an advanced cursor');
      }
      const first = records.find(row => Number.isSafeInteger(row?.event?.seq));
      const lastRecordSeq = records.reduce((highest, row) => Math.max(highest, Number.isSafeInteger(row?.event?.seq) ? row.event.seq : 0), 0);
      if (state.lastSeq > 0 && Number.isSafeInteger(item.cursor) && item.cursor > state.lastSeq
        && (!first || first.event.seq > state.lastSeq + 1 || lastRecordSeq < item.cursor)) {
        throw agentProviderError('AGENT_EVENT_GAP', 'DSH opening snapshot cannot cover the disconnected event gap');
      }
      for (const row of records) ingest(state, row);
      state.snapshotSeen = true;
      wake(state);
      return;
    }
    if (item?.type === 'assistant-stream') return; // non-durable presentation frames are not replayable
    const event = item?.type === 'event' ? item.event : item;
    if (!Number.isSafeInteger(event?.seq) || event.seq < 1) {
      throw agentProviderError('PROVIDER_ERROR', 'DSH Follow event is missing a durable sequence');
    }
    if (event.seq <= state.lastSeq) return;
    if (state.lastSeq > 0 && event.seq !== state.lastSeq + 1) {
      throw agentProviderError('AGENT_EVENT_GAP', `DSH Follow skipped event ${state.lastSeq + 1}`);
    }
    state.lastSeq = event.seq;
    if (event.type === 'turn/start') state.lastTurnTerminal = false;
    if (event.type === 'turn/end') state.lastTurnTerminal = true;
    state.events.push({ type: 'event', event });
    if (state.events.length > MAX_EVENTS) state.events.shift();
    wake(state);
  }
  function start(sessionId, state) {
    if (state.reader || state.closed || stopped) return;
    state.error = null;
    state.ended = false;
    state.snapshotSeen = false;
    state.lastTurnTerminal = false;
    const controller = new AbortController();
    state.controller = controller;
    state.reader = (async () => {
      try {
        for await (const item of api.openRemoteStream('session/follow', FOLLOW_REQUEST(sessionId), { signal: controller.signal })) {
          ingest(state, item);
        }
        if (!controller.signal.aborted) {
          if (state.lastTurnTerminal) state.ended = true;
          else throw agentProviderError('PROVIDER_UNAVAILABLE', 'DSH Follow ended before a terminal turn event');
        }
      } catch (error) {
        if (!controller.signal.aborted) state.error = error?.code ? error : agentProviderError('PROVIDER_UNAVAILABLE', String(error?.message ?? error));
      } finally {
        state.reader = null;
        state.controller = null;
        wake(state);
      }
    })();
  }
  async function* follow({ sessionId, signal, sinceSequence = 0 }) {
    if (!Number.isSafeInteger(sinceSequence) || sinceSequence < 0) {
      throw agentProviderError('INVALID_PARAMS', 'DSH Follow cursor must be a non-negative safe integer');
    }
    const state = stateOf(sessionId);
    if (state.closed || stopped) throw agentProviderError('SESSION_NOT_FOUND', 'DSH Follow Session is closed');
    if (sinceSequence > state.lastSeq && state.lastSeq > 0) {
      throw agentProviderError('AGENT_EVENT_GAP', 'DSH Follow cursor is ahead of the Core cache');
    }
    start(sessionId, state);
    let cursor = sinceSequence;
    while (!signal?.aborted && !state.closed && !stopped) {
      if (state.events.length && cursor < state.events[0].event.seq - 1) {
        throw agentProviderError('AGENT_EVENT_GAP', 'DSH Follow cursor is older than the retained Core cache');
      }
      if (state.snapshotSeen && cursor > state.lastSeq) {
        throw agentProviderError('AGENT_EVENT_GAP', 'DSH Follow cursor is ahead of the native snapshot');
      }
      const next = state.events.find(row => row.event.seq > cursor);
      if (next) { cursor = next.event.seq; yield next; continue; }
      if (state.error) throw state.error;
      if (state.ended) return;
      await new Promise(resolve => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          state.waiters = state.waiters.filter(item => item !== done);
          resolve();
        };
        state.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
  }
  function closeSession(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return;
    state.closed = true;
    state.controller?.abort();
    wake(state);
    sessions.delete(sessionId);
  }
  function shutdown() {
    stopped = true;
    for (const sessionId of sessions.keys()) closeSession(sessionId);
  }
  return { follow, closeSession, shutdown };
}
