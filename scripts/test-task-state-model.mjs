import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTransition } from '../src/task/types.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createTaskService } from '../src/task/service.js';

// Independent business model: only an executing Task may be completed; terminal
// Tasks cannot be reopened. Waiting/blocked work is resumable, paused work needs
// an explicit resume, and an accepted user stop cannot silently requeue work.
// This suite tests trusted domain primitives, not permission to call them over IPC.
const model = {
  queued: ['queued', 'running', 'blocked', 'paused', 'failed', 'cancelled'],
  running: ['running', 'waiting', 'blocked', 'paused', 'completed', 'failed', 'cancelled'],
  waiting: ['waiting', 'running', 'blocked', 'paused', 'failed', 'cancelled'],
  blocked: ['blocked', 'running', 'waiting', 'paused', 'failed', 'cancelled'],
  paused: ['paused', 'running', 'failed', 'cancelled'],
  completed: ['completed'], failed: ['failed'], cancelled: ['cancelled']
};
const action = { running: 'resume', waiting: 'wait', blocked: 'block', paused: 'pause',
  completed: 'complete', failed: 'fail', cancelled: 'cancel' };
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cetamesh-task-model-'));
let count = 0;
const runtime = createTaskRuntime({ stateDir: root });
const invoke = (rt, task, target, expectedRev = task.rev) => rt[action[target]]({ id: task.id, expectedRev,
  reason: 'Explicit controlled test transition', summary: 'Controlled domain test; not Owner product acceptance' });
function seed(status) {
  let task = runtime.create({ goal: 'Model transition ' + (++count), workspaceId: 'model-workspace' });
  task = runtime.setCheckpoint({ id: task.id, expectedRev: task.rev, summary: 'Keep prior facts', nextAction: 'Read existing file' });
  task = runtime.linkMemory({ id: task.id, expectedRev: task.rev, memoryId: 'memory-model', scope: 'user:desktop', type: 'user' });
  if (['waiting', 'completed'].includes(status)) task = runtime.start({ id: task.id, expectedRev: task.rev }).task;
  if (status !== 'queued') task = invoke(runtime, task, status).task;
  return task;
}
try {
  let pairs = 0, actions = 0, stale = 0;
  for (const from of Object.keys(model)) for (const to of Object.keys(model)) {
    const allowed = model[from].includes(to);
    if (allowed) assert.doesNotThrow(() => assertTransition(from, to), `${from} -> ${to}`);
    else assert.throws(() => assertTransition(from, to), error => error.code === 'TASK_INVALID_TRANSITION', `${from} -> ${to}`);
    pairs++;
    if (to === 'queued') continue; // There is intentionally no public requeue primitive.
    const before = seed(from), read = () => runtime.get({ id: before.id }).task;
    if (!allowed) {
      assert.throws(() => invoke(runtime, before, to), error => error.code === 'TASK_INVALID_TRANSITION');
      assert.deepEqual(read(), before, 'invalid transition preserves every Task field');
    } else {
      if (from !== to) {
        assert.throws(() => invoke(runtime, before, to, before.rev - 1), error => error.code === 'TASK_CONFLICT');
        assert.deepEqual(read(), before, 'stale action cannot mutate state');
        stale++;
      }
      const result = invoke(runtime, before, to);
      assert.equal(result.task.status, to);
      assert.equal(result.changed, from !== to);
      assert.equal(result.task.rev, before.rev + (from !== to ? 1 : 0));
      assert.equal(result.task.id, before.id);
      assert.equal(result.task.workspaceId, before.workspaceId);
      assert.deepEqual(result.task.memoryRefs, before.memoryRefs);
      assert.deepEqual(result.task.checkpoint, before.checkpoint);
      assert.deepEqual(invoke(runtime, result.task, to).task, result.task, 'same-state retry is a no-op');
      const loaded = createTaskRuntime({ stateDir: root }).get({ id: before.id }).task;
      // Legacy normalization may add absent optional null/empty fields. Every
      // actual fact written by this transition must survive unchanged.
      for (const [key, value] of Object.entries(result.task)) assert.deepEqual(loaded[key], value,
        'atomic JSON round-trip preserves ' + key);
    }
    actions++;
  }
  console.log(`PASS independent Task model: ${pairs} status pairs, ${actions} runtime actions, ${stale} stale-revision refusals`);

  for (const status of Object.keys(model)) {
    const before = seed(status);
    const reopened = createTaskService({ stateDir: root }).runtime.get({ id: before.id }).task;
    const interrupted = ['running', 'waiting'].includes(status);
    assert.equal(reopened.status, interrupted ? 'blocked' : status);
    assert.equal(reopened.rev, before.rev + (interrupted ? 1 : 0));
    assert.deepEqual(reopened.checkpoint, before.checkpoint);
    assert.deepEqual(reopened.memoryRefs, before.memoryRefs);
    assert.equal(reopened.id, before.id);
  }
  console.log('PASS restart model: active work becomes blocked, all other states and retained facts remain unchanged');
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('cetamesh-task-model-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
