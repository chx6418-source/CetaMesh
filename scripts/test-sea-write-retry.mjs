import assert from 'node:assert/strict';
import { createBusyOpenWriter } from './sea-write-retry.mjs';
const busy = () => Object.assign(new Error('generated executable temporarily busy'), { code: 'EBUSY', syscall: 'open' });
const bytes = Buffer.from('exact injection bytes');
let attempts = 0, clock = 0;
const write = createBusyOpenWriter(async (file, data) => {
  assert.equal(file, 'generated.exe');assert.strictEqual(data, bytes);
  if (++attempts < 3) throw busy();
}, { now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 500, intervalMs: 100 });
await write('generated.exe', bytes);
assert.equal(attempts, 3);assert.equal(clock, 200);
let failures = 0;clock = 0;
const original = busy();
const bounded = createBusyOpenWriter(async () => { failures++;throw original; },
  { now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 250, intervalMs: 100 });
await assert.rejects(bounded('generated.exe', bytes), error => error === original);
assert.ok(clock <= 250);assert.ok(failures <= 4, 'busy output cannot retry indefinitely');
for (const [code, syscall] of [['EACCES', 'open'], ['EPERM', 'open'], ['ENOSPC', 'write'], ['EBUSY', 'write']]) {
  let calls = 0;const failure = Object.assign(new Error('must not retry'), { code, syscall });
  await assert.rejects(createBusyOpenWriter(async () => { calls++;throw failure; })('generated.exe', bytes), error => error === failure);
  assert.equal(calls, 1, 'only an open rejected before writing is safe to retry');
}
console.log('PASS bounded EBUSY/open retry keeps exact bytes; denial, disk errors and partial writes fail immediately');
