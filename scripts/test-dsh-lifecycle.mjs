import assert from 'node:assert/strict';
import { createDshLifecycle } from '../src/providers/dsh/lifecycle.js';
import { DEFAULT_DSH_POLL_INTERVAL_MS } from '../src/providers/dsh/lifecycle-policy.js';

assert.equal(DEFAULT_DSH_POLL_INTERVAL_MS, 5000);
const probes = [
  null,
  new Error('transient disconnect'),
  new Error('still disconnected'),
  null
];
let probeCount = 0;
let timerCallback = null;
let timerClears = 0;
let timerStarts = 0;
let timerUnrefs = 0;
const changes = [];
const subscribed = [];
const refreshes = [];
const lifecycle = createDshLifecycle({
  probe: async () => {
    probeCount += 1;
    const next = probes.shift();
    if (next) throw next;
  },
  onChange: (next, previous) => changes.push([next.state, previous.state]),
  onRefresh: result => refreshes.push(result.status.state),
  setIntervalFn(callback, interval) {
    assert.equal(interval, DEFAULT_DSH_POLL_INTERVAL_MS);
    timerStarts += 1;
    timerCallback = callback;
    return { unref() { timerUnrefs += 1; } };
  },
  clearIntervalFn() { timerClears += 1; }
});

assert.equal(lifecycle.status().state, 'unknown');
const unsubscribe = lifecycle.subscribe(next => subscribed.push(next.state));
const firstStart = lifecycle.start();
const secondStart = lifecycle.start();
assert.equal(timerStarts, 1, 'start twice creates one interval');
assert.equal(timerUnrefs, 1, 'interval is unrefed when supported');
await Promise.all([firstStart, secondStart]);
assert.equal(lifecycle.status().state, 'ready');
assert.equal(probeCount, 1);

timerCallback();
await lifecycle.refresh();
assert.equal(lifecycle.status().state, 'recovering');
timerCallback();
await lifecycle.refresh();
assert.equal(lifecycle.status().state, 'unavailable');
timerCallback();
await lifecycle.refresh();
assert.equal(lifecycle.status().state, 'ready');
assert.deepEqual(changes.map(([next]) => next), ['ready', 'recovering', 'unavailable', 'ready']);
assert.deepEqual(subscribed, ['ready', 'recovering', 'unavailable', 'ready'], 'subscribe observes state changes');
assert.equal(refreshes.length, 4, 'refresh hook observes every probe result');
assert.equal(lifecycle.stop(), true);
assert.equal(lifecycle.status().state, 'stopped');
assert.deepEqual(subscribed, ['ready', 'recovering', 'unavailable', 'ready', 'stopped']);
unsubscribe();
assert.equal(timerClears, 1);
assert.equal(lifecycle.stop(), false, 'stop is idempotent');
timerCallback();
await Promise.resolve();
assert.equal(probeCount, 4, 'stopped lifecycle cannot be probed by a stale timer callback');

console.log('PASS DSH provider lifecycle status and timer ownership');
