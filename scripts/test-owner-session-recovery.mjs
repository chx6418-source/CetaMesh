import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskService } from '../src/task/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { inspectTaskSession } from '../src/agent/session-recovery.js';
import { assertTaskSchema } from '../src/task/store.js';
import { createMemoryService } from '../src/memory/service.js';

// Deterministic service-level fault injection. This suite is NOT native/model evidence.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cetamesh-recovery-chain-'));
const scenarios = [];
const traceFile = process.env.CETAMESH_RECOVERY_TRACE_FILE;
const transitions = [];
const test = (name, fn) => scenarios.push([name, fn]);
const fault = code => Object.assign(new Error(code), { code });

async function fixture(name, { stopped = true, restart = true } = {}) {
  const base = path.join(root, name), stateDir = path.join(base, 'state'), workspaceRoot = path.join(base, 'project');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'proof.txt'), 'original result\n');
  const workspaces = createWorkspaceService({ stateDir });
  const { workspace } = await workspaces.execute({ method: 'workspace.create', params: { name, root: workspaceRoot } });
  let tasks = createTaskService({ stateDir });
  let old = tasks.runtime.create({ goal: 'Continue the same Task safely', workspaceId: workspace.id });
  old = tasks.runtime.start({ id: old.id, expectedRev: old.rev, provider: 'codex', sessionId: 'lost-session' }).task;
  old = tasks.runtime.beginExecutionObservation({ id: old.id, provider: 'codex', sessionId: 'lost-session', phase: 'user', runId: 'old-run' });
  old = tasks.runtime.recordToolOutcome({ id: old.id, provider: 'codex', sessionId: 'lost-session', phase: 'user',
    runId: 'old-run', eventId: 'fixture-old-read', capability: 'filesystem.read', status: 'completed', filePath: 'proof.txt' }).task;
  old = tasks.runtime.recordAgentReport({ id: old.id, expectedRev: old.rev, provider: 'codex', sessionId: 'lost-session',
    phase: 'user', runId: 'old-run', eventId: 'fixture-old-report', text: 'Synthetic earlier report, retained as unverified.' });
  const memories = createMemoryService({ stateDir });
  const memory = await memories.execute({ method: 'memory.create', params: { type: 'user', scope: 'user:desktop',
    content: 'Synthetic Owner memory must remain unchanged during recovery.' } });
  old = tasks.runtime.linkMemory({ id: old.id, expectedRev: old.rev, memoryId: memory.id, scope: 'user:desktop', type: 'user' });
  old = tasks.runtime.setCheckpoint({ id: old.id, expectedRev: old.rev, summary: 'Retain prior checkpoint', nextAction: 'Read existing result' });
  if (restart) tasks = createTaskService({ stateDir }); // Real Task JSON reload/restart transition.
  const state = { stopped, sends: 0, creates: 0, cancels: 0, closes: 0, generation: 1, inspections: 0 };
  const provider = { capabilities: () => ({ workspaceBoundary: 'native-staged' }),
    async verifyTaskQuiescence() { return { stopped: state.stopped }; },
    async verifyStoppedTask(scope) {
      state.inspections++;
      return { ...scope, provider: 'codex', stopped: state.stopped, state: state.stopped ? 'stop-confirmed' : 'unknown',
        receiptId: 'fixture-stop-receipt', generation: state.generation, runId: 'old-run',
        evidence: 'process-tree-exit', code: state.stopped ? null : 'SESSION_EXECUTION_UNCONFIRMED' };
    } };
  const broker = {
    ids: () => ['codex'], require: () => provider, capabilities: () => provider.capabilities(),
    health: async () => ({ available: true, authenticated: true, sessionCapable: true }),
    async status({ sessionId }) { if (sessionId === 'lost-session') throw fault('SESSION_TRANSPORT_UNKNOWN'); return { running: false, queued: 0 }; },
    async cancel({ sessionId }) { state.cancels++; if (sessionId === 'lost-session') throw fault('SESSION_TRANSPORT_UNKNOWN'); return { cancelled: true }; },
    async closeSession({ sessionId }) { state.closes++; if (sessionId === 'lost-session') throw fault('SESSION_TRANSPORT_UNKNOWN'); return { closed: true }; },
    async createSession() { return { sessionId: `fresh-${++state.creates}` }; },
    async send({ sessionId, content }) { assert.notEqual(sessionId, 'lost-session'); state.sends++; state.instruction = content; return { accepted: true, requestId: `new-${state.sends}` }; },
    async *follow({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
  };
  const capabilities = createCapabilityService({ stateDir, workspaceService: workspaces, taskRuntime: tasks.runtime, agentBroker: broker });
  capabilities.grantTask(old.id, { capabilities: ['filesystem.read'], workspaceIds: [workspace.id] });
  const ui = createDesktopUiService({ services: { taskService: tasks, workspaceService: workspaces,
    capabilityService: capabilities, agentBroker: broker,
    settingsService: { store: { get: () => ({ settings: { agents: { defaultAgentProvider: 'codex' } } }) } } } });
  const read = () => tasks.runtime.get({ id: old.id }).task;
  function trace(step, task = read(), code = null) {
    if (!traceFile) return;
    transitions.push({ scenario: name, step, code, at: new Date().toISOString(),
      level: 'real-services-controlled-provider-no-model', task: structuredClone(task),
      session: { currentAgent: task.currentAgent, controlledStopConfirmed: state.stopped, generation: state.generation,
        createdSessions: state.creates, sends: state.sends },
      operations: capabilities.taskReviewState({ taskId: task.id, workspaceId: task.workspaceId }),
      handoff: null, workspace: { id: task.workspaceId,
        ownerTaskId: tasks.runtime.activeWorkspaceOwner({ workspaceId: task.workspaceId })?.id ?? null } });
  }
  if (restart) {
    trace('before-Core-restart', old);
    trace('after-Core-restart');
  } else trace('before-session-visibility-loss');
  const call = async (method, params) => {
    trace('before:' + method);
    try { const result = await ui.execute({ method, params }); trace('after:' + method); return result; }
    catch (error) { trace('rejected:' + method, read(), error.code ?? error.name); throw error; }
  };
  const inspect = () => call('ui.task.recovery.inspect', { id: old.id });
  const recover = async (preview, action = 'resume', extra = {}) => call('ui.task.reconcile', {
    id: old.id, expectedRev: read().rev, reviewed: true, reviewToken: preview?.reviewToken,
    reviewedOperationIds: preview?.reviewOperationIds ?? [], action, provider: 'codex',
    reviewSummary: 'Checked original content and retained receipts; never repeat prior effects.',
    nextInstruction: 'Read proof.txt only; do not repeat the old operation.', requestId: `${name}-fresh`, ...extra
  });
  return { state, tasks, capabilities, broker, workspaces, workspace, workspaceRoot, stateDir, read, call, inspect, recover, trace,
    async close() {
      trace('scenario-final');
      await capabilities.close();
      const reloaded = createMemoryService({ stateDir });
      assert.deepEqual((await reloaded.execute({ method: 'memory.get', params: { id: memory.id } })).memory, memory,
        'actual persisted Memory content and revision survive successful and rejected recovery unchanged');
    } };
}

test('lost Codex transport: same Task fresh-session recovery without direct detach', async () => {
  const f = await fixture('same-task');
  try {
    const before = f.read();
    const preview = await f.inspect();
    assert.equal(preview.session?.stopped, true);
    assert.equal(preview.workspace?.kind, 'filtered-workspace-v1');
    assert.ok(preview.reviewToken);
    const result = await f.recover(preview);
    assert.equal(result.task.id, before.id);
    assert.equal(f.read().currentAgent.sessionId, 'fresh-1');
    assert.equal(f.state.sends, 1);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
    assert.deepEqual(f.read().executionEvidence, before.executionEvidence);
    assert.deepEqual(f.read().agentReports, before.agentReports);
    assert.deepEqual(f.read().memoryRefs, before.memoryRefs);
    assert.equal(f.read().agentHistory[0].sessionId, 'lost-session');
    assert.equal(f.read().recoveryReviews.at(-1).previousExecution.runId, 'old-run');
    assert.equal(fs.existsSync(path.join(f.workspaceRoot, '.git')), false);
  } finally { await f.close(); }
});

test('transport unknown and potentially live execution never yields recovery authority', async () => {
  const f = await fixture('live', { stopped: false });
  try {
    const before = f.read(), preview = await f.inspect();
    assert.equal(preview.session?.stopped, false);
    assert.equal(preview.reviewToken, null);
    assert.ok(preview.blockers.some(row => row.code === 'SESSION_EXECUTION_UNCONFIRMED'));
    await assert.rejects(f.recover(preview), error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.sends + f.state.creates + f.state.cancels, 0);
    assert.equal(f.tasks.runtime.activeWorkspaceOwner({ workspaceId: f.workspace.id }).id, before.id);
  } finally { await f.close(); }
});

test('missing native Session preserves its execution owner until stopped and formally reviewed', async () => {
  const f = await fixture('native-session-missing', { stopped: false, restart: false });
  try {
    const before = f.read();
    const status = f.broker.status;
    f.broker.status = async params => {
      if (params.sessionId !== 'lost-session') return status(params);
      await Promise.resolve();
      throw fault('SESSION_NOT_FOUND');
    };
    f.trace('before:missing-native-session-dispatch');
    let dispatchError;
    try {
      await f.capabilities.broker.execute({ capability: 'agent.run', requestId: 'missing-native-session-new-instruction',
        taskId: before.id, workspaceId: before.workspaceId, actor: OWNER_ACTOR, approved: true,
        input: { agentProvider: 'codex', content: 'Read proof.txt only; never repeat the earlier operation.' } });
    } catch (error) { dispatchError = error; }
    f.trace('after:missing-native-session-dispatch', f.read(), dispatchError?.code ?? null);
    assert.equal(dispatchError?.code, 'TASK_RECOVERY_REVIEW_REQUIRED');
    const blocked = f.read();
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.currentAgent, before.currentAgent);
    assert.deepEqual(blocked.agentHistory, before.agentHistory);
    assert.deepEqual(blocked.executionObservation, before.executionObservation);
    assert.deepEqual(blocked.checkpoint, before.checkpoint);
    assert.deepEqual(blocked.executionEvidence, before.executionEvidence);
    assert.deepEqual(blocked.agentReports, before.agentReports);
    assert.deepEqual(blocked.attempts, before.attempts);
    assert.equal(f.state.creates + f.state.sends + f.state.closes + f.state.cancels, 0);
    assert.equal(f.tasks.runtime.activeWorkspaceOwner({ workspaceId: before.workspaceId }).id, before.id);
    assert.equal((await f.inspect()).reviewToken, null, 'invisible native Session does not certify process exit');
    f.state.stopped = true;
    await f.recover(await f.inspect(), 'resume', { requestId: 'missing-native-session-reviewed-instruction' });
    assert.equal(f.read().id, before.id);
    assert.equal(f.read().currentAgent.sessionId, 'fresh-1');
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.sends, 1);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
    assert.deepEqual(f.read().executionEvidence, before.executionEvidence);
  } finally { await f.close(); }
});

test('missing native Session blocks only its exact current binding at the latest Task revision', async () => {
  const f = await fixture('native-session-missing-latest-rev', { stopped: false, restart: false });
  try {
    const before = f.read();
    f.broker.status = async () => {
      f.tasks.runtime.setProgress({ id: before.id, expectedRev: f.read().rev, note: 'Concurrent progress observation' });
      await Promise.resolve();
      throw fault('SESSION_NOT_FOUND');
    };
    await assert.rejects(f.capabilities.broker.execute({ capability: 'agent.run', requestId: 'missing-native-session-latest-rev',
      taskId: before.id, workspaceId: before.workspaceId, actor: OWNER_ACTOR, approved: true,
      input: { agentProvider: 'codex', content: 'Read proof.txt only.' } }), error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    assert.equal(f.read().status, 'blocked');
    assert.deepEqual(f.read().currentAgent, before.currentAgent);
    assert.deepEqual(f.read().executionObservation, before.executionObservation);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
    assert.equal(f.state.creates + f.state.sends, 0);
  } finally { await f.close(); }
});

test('late missing-session status does not block or detach a replacement assignment', async () => {
  const f = await fixture('native-session-missing-replaced', { stopped: false, restart: false });
  try {
    const before = f.read();
    let replacement;
    f.broker.status = async () => {
      const detached = f.tasks.runtime.detachAgent({ id: before.id, expectedRev: f.read().rev }).task;
      replacement = f.tasks.runtime.attachAgent({ id: before.id, expectedRev: detached.rev,
        provider: 'codex', sessionId: 'replacement-owned-by-concurrent-operation' }).task;
      await Promise.resolve();
      throw fault('SESSION_NOT_FOUND');
    };
    await assert.rejects(f.capabilities.broker.execute({ capability: 'agent.run', requestId: 'missing-native-session-replaced',
      taskId: before.id, workspaceId: before.workspaceId, actor: OWNER_ACTOR, approved: true,
      input: { agentProvider: 'codex', content: 'Read proof.txt only.' } }), error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    assert.deepEqual(f.read(), replacement, 'late failure belongs only to its original assignment');
    assert.equal(f.state.creates + f.state.sends, 0);
  } finally { await f.close(); }
});

test('Owner prose alone cannot replace a current content review token', async () => {
  const f = await fixture('missing-review');
  try {
    const before = f.read();
    await assert.rejects(f.recover(null), error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.sends, 0);
  } finally { await f.close(); }
});

test('same-length non-Git edit invalidates review without changing Task evidence', async () => {
  const f = await fixture('changed-bytes');
  try {
    const before = f.read(), preview = await f.inspect();
    fs.writeFileSync(path.join(f.workspaceRoot, 'proof.txt'), 'replaced result\n');
    await assert.rejects(f.recover(preview), error => error.code === 'TASK_RECOVERY_REVIEW_STALE');
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.creates + f.state.sends, 0);
  } finally { await f.close(); }
});

test('a new execution generation invalidates the inspected stop receipt', async () => {
  const f = await fixture('changed-generation');
  try {
    const before = f.read(), preview = await f.inspect();
    f.state.generation++;
    await assert.rejects(f.recover(preview), error => error.code === 'TASK_RECOVERY_REVIEW_STALE');
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.sends, 0);
  } finally { await f.close(); }
});

test('reviewed stale owner can release Workspace without dispatch and new Task inherits no evidence', async () => {
  const f = await fixture('release');
  try {
    const before = f.read();
    const conflict = await f.call('ui.task.recovery.inspect', { id: before.id });
    assert.equal(conflict.ownership?.taskId, before.id);
    assert.equal(conflict.ownership?.provider, 'codex');
    await f.recover(conflict, 'release');
    assert.equal(f.state.creates + f.state.sends, 0);
    assert.equal(f.tasks.runtime.activeWorkspaceOwner({ workspaceId: f.workspace.id }), null);
    assert.equal(f.read().status, 'paused');
    assert.equal(f.read().currentAgent, null);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
    const next = f.tasks.runtime.create({ goal: 'Independent new task', workspaceId: f.workspace.id });
    assert.equal(next.executionObservation ?? null, null);
    assert.deepEqual(next.executionEvidence ?? [], []);
    const restart = createTaskService({ stateDir: f.stateDir });
    assert.equal(restart.runtime.get({ id: before.id }).task.recoveryReviews.length, 1);
    assert.equal(restart.runtime.activeWorkspaceOwner({ workspaceId: f.workspace.id }), null);
  } finally { await f.close(); }
});

test('late old Session events cannot change the recovered Task or checkpoint', async () => {
  const f = await fixture('late-events');
  try {
    await f.recover(await f.inspect());
    const after = f.read();
    f.tasks.runtime.observeExecution({ id: after.id, provider: 'codex', sessionId: 'lost-session', runId: 'old-run', phase: 'user', state: 'failed' });
    assert.throws(() => f.tasks.runtime.recordToolOutcome({ id: after.id, provider: 'codex', sessionId: 'lost-session',
      runId: 'old-run', phase: 'user', eventId: 'late-old-tool', capability: 'filesystem.write', status: 'completed' }),
    error => error.code === 'AGENT_ASSIGNMENT_EXPIRED');
    assert.deepEqual(f.read(), after);
    await assert.rejects(f.recover(await f.inspect(), 'resume', { requestId: 'late-events-fresh' }),
      error => ['TASK_RECOVERY_NOT_REQUIRED', 'TASK_RECOVERY_REVIEW_REQUIRED'].includes(error.code));
    assert.equal(f.state.sends, 1);
  } finally { await f.close(); }
});

test('unconfirmed local effect requires exact review and can never replay its old request', async () => {
  const f = await fixture('unknown-effect');
  try {
    const effectFile = path.join(f.workspaceRoot, 'effect.txt');
    let effects = 0;
    f.capabilities.broker.register({ id: 'fixture.recovery-effect', permission: 'filesystem.write', effect: 'non-idempotent',
      risk: 'medium', async execute() { effects++; fs.appendFileSync(effectFile, 'x'); throw fault('FIXTURE_RESULT_LOST'); } });
    const request = { capability: 'fixture.recovery-effect', requestId: 'unknown-original', taskId: f.read().id,
      workspaceId: f.workspace.id, actor: OWNER_ACTOR, approved: true, input: {} };
    await assert.rejects(f.capabilities.broker.execute(request), error => error.code === 'FIXTURE_RESULT_LOST');
    const before = f.read(), preview = await f.inspect();
    assert.ok(preview.reviewOperationIds.length);
    await assert.rejects(f.recover(preview, 'resume', { reviewedOperationIds: [] }), error => error.code === 'TASK_RECOVERY_OPERATIONS_REQUIRED');
    assert.deepEqual(f.read(), before);
    assert.equal(f.capabilities.broker.dispatchStatus('unknown-original').status, 'outcome-unknown');
    await f.recover(preview);
    assert.equal(f.capabilities.broker.dispatchStatus('unknown-original').status, 'reconciled');
    await assert.rejects(f.capabilities.broker.execute(request));
    assert.equal(effects, 1);
    assert.equal(fs.readFileSync(effectFile, 'utf8'), 'x');
  } finally { await f.close(); }
});

test('a still-running tool blocks preview even if the old Codex process is stopped', async () => {
  const f = await fixture('active-tool');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let pending;
  try {
    f.capabilities.broker.register({ id: 'fixture.active-effect', permission: 'filesystem.write', effect: 'non-idempotent',
      risk: 'medium', async execute() { entered.resolve(); await release.promise; return { done: true }; } });
    pending = f.capabilities.broker.execute({ capability: 'fixture.active-effect', requestId: 'active-original',
      taskId: f.read().id, workspaceId: f.workspace.id, actor: OWNER_ACTOR, approved: true, input: {} });
    await entered.promise;
    const before = f.read(), preview = await f.inspect();
    assert.equal(preview.reviewToken, null);
    assert.ok(preview.blockers.some(row => row.code === 'OPERATION_STILL_RUNNING'));
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.sends, 0);
  } finally { release.resolve(); if (pending) await pending; await f.close(); }
});

test('partial recovery persistence retains Owner intent and original effect references across restart', async () => {
  const f = await fixture('recovery-persist');
  const apply = f.tasks.runtime.applyOwnerRecovery;
  try {
    f.capabilities.broker.register({ id: 'fixture.persist-effect', permission: 'filesystem.write', effect: 'non-idempotent', risk: 'medium',
      async execute() { fs.appendFileSync(path.join(f.workspaceRoot, 'effect.txt'), 'x'); throw fault('FIXTURE_RESULT_LOST'); } });
    await assert.rejects(f.capabilities.broker.execute({ capability: 'fixture.persist-effect', requestId: 'persist-original',
      taskId: f.read().id, workspaceId: f.workspace.id, actor: OWNER_ACTOR, approved: true, input: {} }));
    const before = f.read(), preview = await f.inspect();
    f.tasks.runtime.applyOwnerRecovery = () => { throw fault('FIXTURE_TASK_WRITE_FAILED'); };
    await assert.rejects(f.recover(preview), error => error.code === 'FIXTURE_TASK_WRITE_FAILED');
    assert.equal(f.read().currentAgent.sessionId, before.currentAgent.sessionId);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
    assert.deepEqual(f.read().executionEvidence, before.executionEvidence);
    const restored = createTaskService({ stateDir: f.stateDir }).runtime.get({ id: before.id }).task;
    assert.deepEqual(restored.recoveryIntent?.operationIds, preview.reviewOperationIds,
      'cleared journals must still have a durable Owner intent retaining their exact original references');
    // The old progress label is not a security boundary; typed intent is.
    let held = f.tasks.runtime.setProgress({ id: before.id, expectedRev: f.read().rev, note: 'STAGING_READ_FAILED' });
    await assert.rejects(f.call('ui.task.resume', { id: held.id, expectedRev: held.rev, provider: 'codex', content: 'read only' }),
      error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    await assert.rejects(f.capabilities.broker.execute({ capability: 'agent.run', requestId: 'bypass-pending-intent',
      taskId: before.id, workspaceId: f.workspace.id, actor: OWNER_ACTOR, approved: true,
      input: { agentProvider: 'codex', content: 'read only' } }), error => error.code === 'TASK_RECOVERY_REVIEW_REQUIRED');
    assert.equal(f.state.sends, 0, 'pending intent cannot be bypassed by normal resume or agent.run');
    const next = await f.inspect();
    assert.deepEqual(next.reviewOperationIds, preview.reviewOperationIds);
    f.tasks.runtime.applyOwnerRecovery = apply;
    await f.recover(next);
    assert.equal(f.state.sends, 1);
    assert.equal(f.read().recoveryIntent, null);
    assert.deepEqual(f.read().recoveryReviews.at(-1).intent.operationIds, preview.reviewOperationIds);
    assert.equal(fs.readFileSync(path.join(f.workspaceRoot, 'effect.txt'), 'utf8'), 'x');
  } finally { f.tasks.runtime.applyOwnerRecovery = apply; await f.close(); }
});

test('an old recovery review cannot certify a later detached native session', async () => {
  const f = await fixture('later-orphan');
  try {
    await f.recover(await f.inspect(), 'release');
    let current = f.read();
    current = f.tasks.runtime.attachAgent({ id: current.id, expectedRev: current.rev, provider: 'codex', sessionId: 'later-unconfirmed' }).task;
    current = f.tasks.runtime.detachAgent({ id: current.id, expectedRev: current.rev, note: 'Synthetic lost cleanup acknowledgement' }).task;
    f.state.stopped = false;
    const inspected = await inspectTaskSession(f.broker, current);
    assert.equal(inspected.stopped, false, 'retiring A is not proof of later B stopping');
  } finally { await f.close(); }
});

test('failed fresh-session cleanup retains the new execution owner for reconciliation', async () => {
  const f = await fixture('failed-cleanup');
  try {
    const before = f.read(), preview = await f.inspect();
    f.broker.send = async () => { f.state.stopped = false; throw fault('FIXTURE_SEND_FAILURE'); };
    f.broker.closeSession = async () => { throw fault('INVOKE_CANCEL_UNCONFIRMED'); };
    await assert.rejects(f.recover(preview), error => error.code === 'FIXTURE_SEND_FAILURE');
    assert.equal(f.read().currentAgent?.sessionId, 'fresh-1');
    assert.equal(f.read().status, 'blocked');
    assert.equal(f.tasks.runtime.activeWorkspaceOwner({ workspaceId: f.workspace.id }).id, before.id);
    assert.equal((await f.inspect()).reviewToken, null);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
  } finally { await f.close(); }
});

test('malformed or cross-task recovery authority fails closed on store load', async () => {
  const f = await fixture('corrupt-authority');
  try {
    await f.recover(await f.inspect(), 'release');
    const valid = { schemaVersion: 1, revision: 1, tasks: [f.read()] };
    assert.doesNotThrow(() => assertTaskSchema(valid, 'isolated-fixture'));
    const corruptions = [
      row => { row.recoveryReviews = [{ sessionProof: { stopped: true } }]; },
      row => { row.recoveryReviews[0].sessionProof.taskId = 'unrelated-task'; },
      row => { row.recoveryReviews[0].workspaceProof.sha256 = 'filename-only'; },
      row => { row.recoveryIntent = { operationIds: [] }; },
      row => { row.recoveryReservation = 'true'; },
      row => { row.attempts = [{ id: 'a', requestId: 'r', provider: 'codex', sessionId: 'later', state: 'unknown',
        review: { reviewId: row.recoveryReviews[0].id, at: row.recoveryReviews[0].at, disposition: 'do-not-replay' } }]; }
    ];
    for (const mutate of corruptions) {
      const invalid = structuredClone(valid); mutate(invalid.tasks[0]);
      assert.throws(() => assertTaskSchema(invalid, 'isolated-fixture'), error => error.code === 'STORE_CORRUPT');
    }
  } finally { await f.close(); }
});

test('release then failed fresh startup can be reviewed again without losing stopped-session proof', async () => {
  const f = await fixture('released-startup-failed');
  const createSession = f.broker.createSession;
  try {
    await f.recover(await f.inspect(), 'release');
    const afterRelease = f.read();
    f.broker.createSession = async () => { throw fault('FIXTURE_PRE_CREATE_FAILED'); };
    await assert.rejects(f.recover(await f.inspect(), 'resume', { requestId: 'failed-fresh-start' }),
      error => error.code === 'FIXTURE_PRE_CREATE_FAILED');
    assert.equal(f.read().currentAgent, null);
    assert.deepEqual(f.read().agentHistory, afterRelease.agentHistory);
    const retry = await f.inspect();
    assert.ok(retry.reviewToken, 'a chained review must retain its exact retired assignment proof');
    f.broker.createSession = createSession;
    await f.recover(retry, 'resume', { requestId: 'new-explicit-start' });
    assert.equal(f.state.sends, 1);
  } finally { f.broker.createSession = createSession; await f.close(); }
});

test('released Task compatibility resume never replays its checkpoint without a fresh instruction and request', async () => {
  const f = await fixture('released-legacy-resume');
  try {
    await f.recover(await f.inspect(), 'release');
    // Editable progress text must not remove the typed recovery boundary.
    f.tasks.runtime.setProgress({ id: f.read().id, expectedRev: f.read().rev, note: 'Owner paused this task' });
    const before = f.read();
    for (const extra of [{}, { content: 'Read proof.txt only.' }]) {
      await assert.rejects(f.call('ui.task.resume', { id: before.id, expectedRev: before.rev, provider: 'codex', ...extra }),
        error => error.code === 'TASK_RECOVERY_INSTRUCTION_REQUIRED');
      assert.deepEqual(f.read(), before);
      assert.equal(f.state.sends + f.state.creates, 0);
    }
    await f.recover(await f.inspect(), 'resume', { requestId: 'released-explicit-fresh-instruction' });
    assert.equal(f.state.sends, 1, 'formal reviewed fresh instruction remains usable');
  } finally { await f.close(); }
});

for (const phase of ['reviewed', 'pending']) for (const method of ['update', 'reconcileWorkspace']) {
  test(`${phase} recovery evidence cannot be rebound by ${method} or corrupt the next restart`, async () => {
    const f = await fixture(`workspace-bound-${phase}-${method}`);
    const apply = f.tasks.runtime.applyOwnerRecovery;
    try {
      if (phase === 'pending') {
        f.tasks.runtime.applyOwnerRecovery = () => { throw fault('FIXTURE_TASK_WRITE_FAILED'); };
        await assert.rejects(f.recover(await f.inspect(), 'release'), error => error.code === 'FIXTURE_TASK_WRITE_FAILED');
      } else await f.recover(await f.inspect(), 'release');
      const before = f.read();
      const beforeFiles = Object.fromEntries(fs.readdirSync(path.join(f.stateDir, 'tasks')).map(file =>
        [file, fs.readFileSync(path.join(f.stateDir, 'tasks', file))]));
      const otherRoot = path.join(f.workspaceRoot, '..', 'another-project');
      fs.mkdirSync(otherRoot);
      const { workspace: other } = await f.workspaces.execute({ method: 'workspace.create', params: { name: 'Other project', root: otherRoot } });
      const params = { id: before.id, expectedRev: before.rev,
        ...(method === 'update' ? { workspaceId: other.id } : {
          expectedWorkspaceId: before.workspaceId, observedWorkspaceId: other.id, resolution: 'use-observed' }) };
      assert.throws(() => f.tasks.runtime[method](params), error => error.code === 'TASK_RECOVERY_WORKSPACE_BOUND');
      assert.deepEqual(f.read(), before, 'rejected move preserves Task, checkpoint and all recovery evidence');
      for (const [file, bytes] of Object.entries(beforeFiles)) assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'tasks', file)), bytes);
      const restarted = createTaskService({ stateDir: f.stateDir }).runtime.get({ id: before.id }).task;
      assert.deepEqual(restarted.recoveryReviews, before.recoveryReviews);
      assert.deepEqual(restarted.recoveryIntent, before.recoveryIntent);
      assert.equal(restarted.workspaceId, before.workspaceId);
    } finally { f.tasks.runtime.applyOwnerRecovery = apply; await f.close(); }
  });
}

let failures = 0;
try {
  for (const [name, run] of scenarios) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.code ?? error.name}: ${error.message}`); }
  }
} finally {
  if (traceFile) fs.writeFileSync(traceFile, JSON.stringify({ schema: 'cetamesh-recovery-transitions-v1',
    evidenceLevel: 'service-level-fault-injection', provider: 'controlled-fixture', nativeDesktop: false, transitions }, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
