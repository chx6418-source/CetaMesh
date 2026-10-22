const fault = code => Object.assign(new Error('Agent event buffer unavailable'), {code});

/** Rolling history; an evicted cursor fails explicitly instead of replaying partial history. */
export function createAgentEventBuffer({limit = 512} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Positive event limit required');
  const events = [], waiters = new Set();
  let closed = false, failure = null, latest = 0, evictedThrough = 0;
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  return {
    push(event) {
      if (closed) throw failure ?? fault('AGENT_EVENT_CLOSED');
      const seq = event.seq ?? latest + 1;
      if (!Number.isSafeInteger(seq) || seq <= latest) throw new TypeError('Monotonically increasing event sequence required');
      const copy = structuredClone({...event,seq}); latest = seq;
      events.push(copy);
      if (events.length > limit) evictedThrough = events.shift().seq;
      wake();
    },
    async *follow({signal, sinceSequence = 0} = {}) {
      if (!Number.isSafeInteger(sinceSequence) || sinceSequence < 0) throw new TypeError('Nonnegative cursor required');
      let cursor = sinceSequence;
      while (!signal?.aborted) {
        if (failure) throw failure;
        if (cursor < evictedThrough) throw fault('AGENT_EVENT_CURSOR_EXPIRED');
        const event = events.find(value => value.seq > cursor);
        if (event) {
          cursor = event.seq;
          yield structuredClone(event);
          continue;
        }
        if (closed) return;
        await new Promise(resolve => {
          const done = () => { waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
          waiters.add(done); signal?.addEventListener('abort', done, {once:true});
          if (signal?.aborted) done();
        });
      }
    },
    close(error) { closed = true; failure = error ?? failure; wake(); }
  };
}
