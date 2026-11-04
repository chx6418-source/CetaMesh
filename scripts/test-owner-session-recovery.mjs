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
import { unreviewedTaskEffects } from '../src/task/recovery-evidence.js';
import { createContinuityService } from '../src/continuity/service.js';
import { createCodexSessionLifecycle } from '../src/agent/codex-session-lifecycle.js';
import { createCodexAgentProvider } from '../src/agent/codex-agent-provider.js';

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
  const provider = { id: 'codex', capabilities: () => ({ workspaceBoundary: 'native-staged' }),
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
    async *follow({ signal }) {
      if (signal.aborted) return;
      const event = await new Promise(resolve => {
        state.finishTurn = resolve;
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      if (event) yield event;
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
  };
  const capabilities = createCapabilityService({ stateDir, workspaceService: workspaces, taskRuntime: tasks.runtime, agentBroker: broker });
  capabilities.grantTask(old.id, { capabilities: ['filesystem.read'], workspaceIds: [workspace.id] });
  const services = { taskService: tasks, workspaceService: workspaces,
    capabilityService: capabilities, agentBroker: broker,
    settingsService: { store: { get: () => ({ settings: { agents: { defaultAgentProvider: 'codex' } } }) } } };
  const ui = createDesktopUiService({ services });
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
  return { state, tasks, capabilities, broker, services, workspaces, workspace, workspaceRoot, stateDir, read, call, inspect, recover, trace,
    async close() {
      trace('scenario-final');
      await capabilities.close();
      const reloaded = createMemoryService({ stateDir });
      assert.deepEqual((await reloaded.execute({ method: 'memory.get', params: { id: memory.id } })).memory, memory,
        'actual persisted Memory content and revision survive successful and rejected recovery unchanged');
    } };
}

function retainUnknownTool(f) {
  const task = f.read(), scope = { id: task.id, provider: 'codex', sessionId: 'lost-session', runId: 'old-run', phase: 'user' };
  f.tasks.runtime.recordToolOutcome({ ...scope, eventId: 'fixture-old-unknown', capability: 'filesystem.write', status: 'outcome-unknown' });
  f.tasks.runtime.observeExecution({ ...scope, state: 'unknown', toolActivity: true });
  f.tasks.runtime.block({ id: task.id, expectedRev: f.read().rev, note: 'Interrupted tool outcome needs Owner review' });
}

async function finishFreshRead(f) {
  const task = f.read(), scope = { id: task.id, ...task.currentAgent, runId: 'new-run', phase: 'user' };
  f.tasks.runtime.beginExecutionObservation(scope);
  f.tasks.runtime.recordToolOutcome({ ...scope, eventId: 'fixture-fresh-read', capability: 'filesystem.read', status: 'completed' });
  f.state.finishTurn({ type: 'turn/end', seq: 1, data: { phase: 'user', runId: scope.runId,
    requestId: 'fixture-fresh-turn', reason: { kind: 'completed' } } });
  for (let n = 0; n < 100 && f.capabilities.completionBlocker(task.id); n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.capabilities.completionBlocker(task.id), null, 'the actual follow consumer observed the fresh turn end');
  return f.read();
}

test('Owner recovery lists retained unknown native tool evidence for exact review', async () => {
  const f = await fixture('unknown-evidence-list', { restart: false });
  try {
    retainUnknownTool(f);
    const preview = await f.inspect();
    assert.equal(preview.canResume, true);
    assert.equal(preview.reviewOperationIds.filter(id => id.startsWith('task-evidence:')).length, 1,
      'unknown native evidence must be visible in the formal review, even without a Capability journal row');
    const before = f.read();
    await assert.rejects(f.recover(preview, 'resume', { reviewedOperationIds: [] }), error => error.code === 'TASK_RECOVERY_OPERATIONS_REQUIRED');
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.sends + f.state.creates, 0);
  } finally { await f.close(); }
});

test('formally reviewed historical unknown effects do not permanently block acceptance of a fresh run', async () => {
  const f = await fixture('unknown-evidence-complete', { restart: false });
  try {
    retainUnknownTool(f);
    const before = f.read();
    await f.recover(await f.inspect());
    const finished = await finishFreshRead(f);
    const accepted = await f.call('ui.task.complete', { id: finished.id, expectedRev: finished.rev, reviewed: true,
      summary: 'Reviewed the fresh read result and the exact retained earlier uncertainty; do not replay earlier effects.' });
    assert.equal(accepted.task.id, before.id);
    assert.equal(accepted.task.status, 'completed');
    assert.deepEqual(f.read().executionEvidence.slice(0, before.executionEvidence.length), before.executionEvidence,
      'retired uncertainty is retained verbatim, never converted into successful execution evidence');
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.sends, 1);
    const reloaded = createTaskService({ stateDir: f.stateDir }).runtime.get({ id: before.id }).task;
    assert.equal(reloaded.status, 'completed');
    assert.deepEqual(reloaded.executionEvidence, f.read().executionEvidence);
    assert.deepEqual(reloaded.recoveryReviews, f.read().recoveryReviews);
  } finally { await f.close(); }
});

test('a reviewed historical effect cannot certify a different Task, payload, Session or later unknown tool', async () => {
  const f = await fixture('unknown-review-boundaries', { restart: false });
  try {
    retainUnknownTool(f);
    await f.recover(await f.inspect());
    await finishFreshRead(f);
    const reviewed = f.read();
    assert.equal(unreviewedTaskEffects(reviewed).length, 0);
    const mutations = [
      task => { task.id += '-other'; },
      task => { task.workspaceId += '-other'; },
      task => { task.executionEvidence.find(row => row.status === 'outcome-unknown').runId = 'unreviewed-run'; },
      task => { task.executionEvidence.find(row => row.status === 'outcome-unknown').tool = 'different-tool'; },
      task => { task.recoveryReviews[0].operationIds = []; },
      task => { task.recoveryReviews[0].intent.operationIds = []; },
      task => { task.recoveryReviews[0].sessionProof.stopped = false; },
      task => { task.recoveryReviews[0].sessionProof.sessionId = 'different-session'; },
      task => { task.currentAgent = { provider: 'codex', sessionId: 'lost-session' }; }
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(reviewed); mutate(changed);
      assert.equal(unreviewedTaskEffects(changed).length, 1, 'authority only applies to the exact reviewed older observation');
    }
    f.tasks.runtime.recordToolOutcome({ id: reviewed.id, ...reviewed.currentAgent, phase: 'user', runId: 'new-run',
      eventId: 'fixture-fresh-unknown', capability: 'filesystem.write', status: 'cancel-unconfirmed' });
    const before = f.read();
    await assert.rejects(f.call('ui.task.complete', { id: before.id, expectedRev: before.rev, reviewed: true, summary: 'Cannot accept unknown new effects' }),
      error => error.code === 'TASK_EFFECT_UNCONFIRMED');
    assert.deepEqual(f.read(), before);
  } finally { await f.close(); }
});

test('current Session stopped proof cannot retire another historical native executor', async () => {
  const f = await fixture('unknown-foreign-session', { restart: false });
  try {
    retainUnknownTool(f);
    f.tasks.runtime.attachAgent({ id: f.read().id, expectedRev: f.read().rev, provider: 'codex', sessionId: 'different-retained-session' });
    const before = f.read(), preview = await f.inspect();
    assert.equal(preview.canResume, false);
    assert.ok(preview.blockers.some(row => row.code === 'TASK_EFFECT_SCOPE_UNCONFIRMED'));
    assert.deepEqual(f.read(), before);
    assert.equal(f.state.creates + f.state.sends, 0);
  } finally { await f.close(); }
});

async function interruptedHandoff(name) {
  const f = await fixture(name, { restart: false });
  const sourceStatus = f.broker.status, close = f.broker.closeSession;
  f.broker.status = async args => args.sessionId === 'lost-session' ? { running: false, queued: 0 } : sourceStatus(args);
  f.broker.closeSession = async () => ({ closed: false });
  // Use the production transaction writer and failure path; only the external
  // Provider is controlled. The Workspace proof for Owner recovery is real.
  f.services.continuityService = createContinuityService({ stateDir: f.stateDir,
    taskRuntime: f.tasks.runtime, agentBroker: f.broker });
  const continuity = f.services.continuityService.runtime;
  await assert.rejects(continuity.rollover({ taskId: f.read().id, targetProvider: 'codex' }),
    error => error.code === 'SESSION_TRANSPORT_UNKNOWN');
  f.broker.closeSession = close;
  const provider = f.broker.require('codex'), verify = provider.verifyStoppedTask;
  f.state.targetStopped = false;
  provider.verifyStoppedTask = async scope => scope.sessionId === 'fresh-1'
    ? { ...scope, provider: 'codex', stopped: f.state.targetStopped, state: f.state.targetStopped ? 'stop-confirmed' : 'unknown',
      receiptId: 'target-stop-receipt', generation: 0, runId: null, evidence: 'never-started' }
    : verify(scope);
  return { ...f, continuity };
}

test('prepared Handoff has a formal Owner exit after both exact participants are stopped', async () => {
  const f = await interruptedHandoff('prepared-owner-exit');
  try {
    const before = f.read();
    assert.equal(before.status, 'blocked');
    const blocked = await f.inspect();
    assert.equal(blocked.canResume, false);
    assert.ok(blocked.blockers.some(row => row.code === 'HANDOFF_EXECUTION_UNCONFIRMED'));
    assert.equal(f.continuity.isInFlight(before.id), true);
    f.state.targetStopped = true;
    const ready = await f.inspect();
    assert.equal(ready.canResume, true, 'a stopped interrupted Handoff must not be a permanent nonterminal state');
    assert.ok(ready.reviewOperationIds.some(id => id.startsWith('handoff:')));
    await assert.rejects(f.recover(ready, 'resume', { reviewedOperationIds: [] }), error => error.code === 'TASK_RECOVERY_OPERATIONS_REQUIRED');
    const recovered = await f.recover(ready);
    assert.equal(recovered.task.id, before.id);
    assert.equal(f.read().currentAgent.sessionId, 'fresh-2');
    assert.equal(f.state.sends, 1, 'the failed bootstrap is never replayed');
    assert.equal(f.continuity.transactionReviewState(before.id), null);
    assert.deepEqual(f.read().executionEvidence, before.executionEvidence);
    assert.deepEqual(f.read().checkpoint, before.checkpoint);
  } finally { await f.close(); }
});

test('Handoff participant stop evidence is revalidated before Owner journal acknowledgement', async () => {
  const f = await interruptedHandoff('prepared-proof-race');
  try {
    f.state.targetStopped = true;
    const preview = await f.inspect(), before = f.read(), transaction = f.continuity.transactionReviewState(before.id);
    assert.equal(preview.canResume, true);
    f.broker.health = async () => {
      f.state.targetStopped = false;
      return { available: true, authenticated: true, sessionCapable: true };
    };
    await assert.rejects(f.recover(preview), error => error.code === 'TASK_RECOVERY_REVIEW_STALE');
    assert.deepEqual(f.read(), before);
    assert.deepEqual(f.continuity.transactionReviewState(before.id), transaction);
    assert.equal(f.state.sends, 0);
  } finally { await f.close(); }
});

test('formal Handoff recovery consumes actual Codex lifecycle proofs for source and bootstrap target', async () => {
  const f = await interruptedHandoff('prepared-native-proof');
  try {
    const task = f.read(), transaction = f.continuity.transactionReviewState(task.id);
    const lifecycle = createCodexSessionLifecycle({ stateDir: f.stateDir });
    const binding = sessionId => ({ taskId: task.id, workspaceId: task.workspaceId, sessionId,
      transport: 'exec', snapshotId: 'fixture-snapshot-' + sessionId, attemptId: null });
    const source = binding('lost-session'), target = binding('fresh-1');
    lifecycle.create(source);
    lifecycle.begin({ ...source, runId: 'old-run', turnId: 'original-turn' });
    lifecycle.settle({ ...source, runId: 'old-run', proof: 'process-tree-exit' });
    lifecycle.create(target);
    const bootstrap = 'handoff:' + task.id + ':' + transaction.sequence;
    lifecycle.begin({ ...target, runId: bootstrap, turnId: 'bootstrap-turn' });
    lifecycle.settle({ ...target, runId: bootstrap, proof: 'process-tree-exit' });
    // No native process is launched. The receipt store and its production
    // consumer are real, exercising their stricter current/bootstrap semantics.
    const native = createCodexAgentProvider({ stateDir: f.stateDir, sessionLifecycle: lifecycle,
      codexHome: path.join(f.stateDir, 'fixture-codex-home'), environment: {},
      cliProcess: { executable: () => null, probe: () => ({ available: false, stdout: '', stderr: '' }), async shutdown() {} },
      resolveTaskWorkspace: () => ({ task: f.read(), workspace: { id: task.workspaceId, root: f.workspaceRoot } }) });
    const adapter = f.broker.require('codex');
    adapter.verifyStoppedTask = scope => native.verifyStoppedTask(scope);
    adapter.verifyTaskQuiescence = scope => native.verifyTaskQuiescence(scope);
    adapter.inspectStoppedHandoffSession = scope => native.inspectStoppedHandoffSession(scope);
    f.tasks.runtime.attachAgent({ id: task.id, expectedRev: f.read().rev, provider: 'codex', sessionId: target.sessionId });
    assert.equal((await native.verifyStoppedTask(target)).stopped, false,
      'ordinary recovery cannot pretend a bootstrap receipt is the current user-run receipt');
    const preview = await f.inspect();
    assert.equal(preview.canResume, true);
    assert.equal(preview.session.sessionId, target.sessionId);
    await f.recover(preview, 'release');
    const reviewed = f.read().recoveryReviews.at(-1);
    assert.equal(reviewed.sessionProof.runId, bootstrap);
    assert.equal(reviewed.sessionProof.handoffProofs.length, 2);
    assert.deepEqual(reviewed.sessionProof.handoffProofs.map(row => row.runId), ['old-run', bootstrap]);
    const reloaded = createTaskService({ stateDir: f.stateDir }).runtime.get({ id: task.id }).task;
    assert.equal(reloaded.status, 'paused');
    assert.equal(reloaded.currentAgent, null);
    assert.deepEqual(reloaded.recoveryReviews, f.read().recoveryReviews);
    assert.equal(f.state.sends, 0);
  } finally { await f.close(); }
});

test('partial Handoff acknowledgement retains both live stop checks after the Task write fails', async () => {
  const f = await interruptedHandoff('prepared-partial-write');
  const apply = f.tasks.runtime.applyOwnerRecovery;
  try {
    f.state.targetStopped = true;
    const preview = await f.inspect();
    f.tasks.runtime.applyOwnerRecovery = () => { throw fault('FIXTURE_TASK_WRITE_FAILED'); };
    await assert.rejects(f.recover(preview), error => error.code === 'FIXTURE_TASK_WRITE_FAILED');
    const pending = f.read();
    assert.ok(pending.recoveryIntent);
    assert.equal(f.continuity.transactionReviewState(pending.id), null, 'the earlier domain acknowledgement was already durable');
    f.state.targetStopped = false;
    const restartedUi = createDesktopUiService({ services: f.services });
    const blocked = await restartedUi.execute({ method: 'ui.task.recovery.inspect', params: { id: pending.id } });
    assert.equal(blocked.canResume, false, 'saved stop proofs never replace live revalidation after a partial commit');
    assert.ok(blocked.blockers.some(row => row.code === 'HANDOFF_EXECUTION_UNCONFIRMED'));
    assert.deepEqual(f.read(), pending);
    assert.equal(f.state.sends, 0);
    f.state.targetStopped = true;
    f.tasks.runtime.applyOwnerRecovery = apply;
    const ready = await f.inspect();
    assert.equal(ready.canResume, true);
    await f.recover(ready, 'resume', { requestId: 'explicit-retry-after-partial-commit' });
    assert.equal(f.state.sends, 1);
    assert.equal(f.read().recoveryIntent, null);
    assert.equal(f.read().id, pending.id);
  } finally { f.tasks.runtime.applyOwnerRecovery = apply; await f.close(); }
});

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
