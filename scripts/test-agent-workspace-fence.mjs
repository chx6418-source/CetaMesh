import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskService } from '../src/task/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

// Real storage/service fault injection, not native Agent execution evidence.
const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, 'cetamesh-workspace-fence-'));
const fault = code => Object.assign(new Error(code), { code });
const cases = [], test = (name, run) => cases.push([name, run]);
async function fixture(name, { failFenceWrite = false, failAfterSend = false } = {}) {
  const base = path.join(root, name), stateDir = path.join(base, 'state'), project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'result.txt'), 'original content');
  const workspaces = createWorkspaceService({ stateDir });
  const workspace = (await workspaces.execute({ method: 'workspace.create', params: { root: project, name } })).workspace;
  let tasks = createTaskService({ stateDir });
  const a = tasks.runtime.create({ goal: 'First isolated writer', workspaceId: workspace.id });
  const b = tasks.runtime.create({ goal: 'Second isolated writer', workspaceId: workspace.id });
  const state = { created: [], sent: [], stopped: false };
  const provider = { verifyTaskQuiescence: async ({ taskId }) => ({ stopped: taskId !== a.id || state.stopped }) };
  const agents = { ids: () => ['codex'], require: () => provider,
    capabilities: () => ({ workspaceBoundary: 'native-staged' }),
    health: async () => ({ available: true, authenticated: true, sessionCapable: true }),
    createSession: async (_provider, { taskId }) => { state.created.push(taskId); return { sessionId: 'session-' + taskId }; },
    closeSession: async ({ sessionId }) => { if (sessionId === 'session-' + a.id && !state.stopped && !failAfterSend) throw fault('INVOKE_CANCEL_UNCONFIRMED'); return { closed: true }; },
    send: async ({ sessionId }) => {
      state.sent.push(sessionId);
      if (failAfterSend && sessionId === 'session-' + a.id) {
        tasks.runtime.beginExecutionObservation({ id: a.id, provider: 'codex', sessionId, runId: 'lost-result-run', phase: 'user' });
        tasks.runtime.recordToolOutcome({ id: a.id, provider: 'codex', sessionId, runId: 'lost-result-run', phase: 'user',
          eventId: 'uncertain-tool-effect', capability: 'filesystem.write', status: 'unknown' });
      }
      return { accepted: true, requestId: 'accepted-' + state.sent.length };
    },
    async *follow({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
  };
  const build = () => createCapabilityService({ stateDir, taskRuntime: tasks.runtime, workspaceService: workspaces, agentBroker: agents });
  let capabilities = build();
  for (const task of [a, b]) capabilities.grantTask(task.id, { capabilities: ['filesystem.read'], workspaceIds: [workspace.id] });
  const run = (task, requestId) => capabilities.broker.execute({ capability: 'agent.run', requestId,
    taskId: task.id, workspaceId: workspace.id, actor: OWNER_ACTOR, approved: true,
    input: { agentProvider: 'codex', content: 'Read the existing file only.', ...(failAfterSend && task.id === a.id ? { model: 'fixture-model' } : {}) } });
  const attach = tasks.runtime.attachAgent, block = tasks.runtime.block, setModel = tasks.runtime.setModelConfig;
  tasks.runtime.attachAgent = params => { if (params.id === a.id && !failAfterSend) throw fault('FIXTURE_TASK_WRITE_FAILED'); return attach(params); };
  tasks.runtime.block = params => { if (params.id === a.id && !failAfterSend) throw fault('FIXTURE_RECOVERY_WRITE_FAILED'); return block(params); };
  tasks.runtime.setModelConfig = params => { if (params.id === a.id && failAfterSend) throw fault('FIXTURE_RESULT_WRITE_FAILED'); return setModel(params); };
  const before = fs.readFileSync(path.join(stateDir, 'tasks', 'tasks.json'));
  const rename = fs.renameSync; let requestWrites = 0;
  if (failFenceWrite) fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.join(stateDir, 'capability', 'requests.json') && ++requestWrites === 2) {
      throw Object.assign(fault('EIO'), { syscall: 'rename' });
    }
    return rename(from, to);
  };
  let initialError;
  try { await assert.rejects(run(a, name + '-original'), error => { initialError = error; return true; }); }
  finally { fs.renameSync = rename; }
  if (!failAfterSend) assert.deepEqual(fs.readFileSync(path.join(stateDir, 'tasks', 'tasks.json')), before);
  tasks.runtime.attachAgent = attach; tasks.runtime.block = block; tasks.runtime.setModelConfig = setModel;
  return { a, b, workspace, state, stateDir, run, initialError, read: id => tasks.runtime.get({ id }).task,
    recovery: () => capabilities.recoveryForTask(a.id), completionBlocker: () => capabilities.completionBlocker(a.id),
    assertRecoveryAvailable: taskId => capabilities.assertWorkspaceRecoveryAvailable({ taskId, workspaceId: workspace.id }),
    async restart() { await capabilities.close(); tasks = createTaskService({ stateDir }); capabilities = build(); },
    ui() { return createDesktopUiService({ services: { taskService: tasks, workspaceService: workspaces,
      capabilityService: capabilities, agentBroker: agents } }); },
    async close() { await capabilities.close(); }
  };
}

test('unconfirmed creation holds Workspace when attachment and rollback Task writes both fail', async () => {
  const f = await fixture('same-core');
  try {
    await assert.rejects(f.run(f.b, 'second-writer'), error => error.code === 'TASK_WORKSPACE_BUSY' && error.blockingTaskId === f.a.id);
    await assert.rejects(f.run(f.a, 'same-task-repeat'), error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    assert.deepEqual(f.state.created, [f.a.id]); assert.deepEqual(f.state.sent, []);
    assert.equal(f.initialError.code, 'FIXTURE_TASK_WRITE_FAILED', 'rollback preserves the original failure');
    assert.equal(f.recovery()?.state, 'needs-reconciliation');
    assert.equal(f.completionBlocker(), 'TASK_EXECUTION_UNCONFIRMED');
    assert.throws(() => f.assertRecoveryAvailable(f.b.id), error => error.code === 'TASK_WORKSPACE_BUSY' && error.blockingTaskId === f.a.id,
      'pre-attachment durable fence also prevents another Task from rolling back imports');
  } finally { await f.close(); }
});

test('durable Workspace fence survives restart and releases only after formal Owner review', async () => {
  const f = await fixture('restart');
  try {
    await f.restart();
    assert.equal(f.read(f.a.id).status, 'blocked', 'restored queued orphan has a reachable recovery path');
    await assert.rejects(f.run(f.b, 'after-restart'), error => error.code === 'TASK_WORKSPACE_BUSY');
    const ui = f.ui(), call = (method, params) => ui.execute({ method, params });
    let preview = await call('ui.task.recovery.inspect', { id: f.a.id });
    assert.equal(preview.reviewToken, null); assert.equal(preview.session.stopped, false);
    f.state.stopped = true;
    preview = await call('ui.task.recovery.inspect', { id: f.a.id });
    assert.ok(preview.reviewToken); assert.ok(preview.reviewOperationIds.includes('request:restart-original'));
    await call('ui.task.reconcile', { id: f.a.id, expectedRev: preview.taskRev, action: 'release', reviewed: true,
      reviewToken: preview.reviewToken, reviewedOperationIds: preview.reviewOperationIds,
      reviewSummary: 'Verified the controlled process is stopped and checked all content and original request receipts.' });
    assert.equal(f.read(f.a.id).status, 'paused');
    await f.restart();
    const result = await f.run(f.b, 'after-owner-review');
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.state.created, [f.a.id, f.b.id]);
    assert.deepEqual(f.state.sent, ['session-' + f.b.id]);
  } finally { await f.close(); }
});

test('failure to persist the pre-launch fence starts no native process', async () => {
  const f = await fixture('fence-write', { failFenceWrite: true });
  try {
    assert.deepEqual(f.state.created, []); assert.deepEqual(f.state.sent, []);
    assert.equal((await f.run(f.b, 'safe-second-writer')).status, 'completed');
    assert.deepEqual(f.state.created, [f.b.id]);
  } finally { await f.close(); }
});

test('confirmed process close after send does not discard unknown tool evidence or release Workspace', async () => {
  const f = await fixture('after-send', { failAfterSend: true });
  try {
    assert.equal(f.initialError.code, 'FIXTURE_RESULT_WRITE_FAILED');
    const held = f.read(f.a.id);
    assert.equal(held.status, 'blocked'); assert.equal(held.currentAgent?.sessionId, 'session-' + f.a.id);
    assert.equal(held.executionObservation.runId, 'lost-result-run');
    assert.equal(held.executionEvidence.at(-1).status, 'unknown');
    await assert.rejects(f.run(f.b, 'must-still-review'), error => error.code === 'TASK_WORKSPACE_BUSY');
    await f.restart();
    assert.equal(f.read(f.a.id).executionEvidence.at(-1).status, 'unknown');
    await assert.rejects(f.run(f.b, 'must-still-review-after-restart'), error => error.code === 'TASK_WORKSPACE_BUSY');
  } finally { await f.close(); }
});

let failed = 0;
try { for (const [name, run] of cases) { try { await run(); console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.code ?? error.name, error.message); } } }
finally { const target = path.resolve(root); assert.equal(path.dirname(target), parent);
  assert.ok(path.basename(target).startsWith('cetamesh-workspace-fence-')); fs.rmSync(target, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
