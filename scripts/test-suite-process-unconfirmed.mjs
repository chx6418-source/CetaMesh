import assert from 'node:assert/strict';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

// No actual processes are signalled: reproduce missing detached-group semantics
// deterministically on every OS using the helper's explicit platform test seam.
const missing = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });
for (const childProbe of ['alive', 'denied', 'gone']) {
  const calls = [];
  const signalProcess = (pid, signal) => {
    calls.push([pid, signal]);
    if (pid === -1234) throw missing();
    assert.equal(pid, 1234);
    assert.equal(signal, 0, 'only probe the root; never pretend root-only killing proves tree termination');
    if (childProbe === 'gone') throw missing();
    if (childProbe === 'denied') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return true;
  };
  const run = terminateSuiteProcessTree({ pid: 1234 }, { platform: 'linux', signalProcess });
  if (childProbe === 'gone') await run;
  else await assert.rejects(run, error => error.code === 'TREE_TERMINATION_UNCONFIRMED');
  assert.deepEqual(calls, [[-1234, 'SIGTERM'], [1234, 0]]);
}
console.log('PASS missing suite group cannot confirm termination while root is alive or inaccessible');

{
  const calls = [];
  await terminateSuiteProcessTree({ pid: 1234 }, { platform: 'linux', signalProcess(pid, signal) {
    calls.push([pid, signal]);
    if (signal === 'SIGTERM') return true;
    throw missing();
  } });
  assert.deepEqual(calls, [[-1234, 'SIGTERM'], [-1234, 0], [-1234, 0], [1234, 0]],
    'normal group termination and reaped root still succeeds');
}
{
  const calls = [];
  await assert.rejects(terminateSuiteProcessTree({ pid: 1234 }, { platform: 'linux', signalProcess(pid, signal) {
    calls.push([pid, signal]);
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  } }), error => error.code === 'EPERM');
  assert.deepEqual(calls, [[-1234, 'SIGTERM']], 'permission failure is never retried through another signal target');
}
console.log('PASS normal group exit is accepted; group permission failure propagates without fallback');
