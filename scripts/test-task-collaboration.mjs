import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskService } from '../src/task/service.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-collaboration-'));
try {
  const service = createTaskService({ stateDir });
  const call = (method, params) => service.execute({ method, params });
  const parent = await call('task.create', { goal: 'Inspect release', workspaceId: 'ws-test' });
  const contract = { mode: 'read-only', outputKind: 'analysis', readScope: ['src/task'], expectedEvidence: ['source'] };
  const child = await call('task.child.create', { parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'read-1', goal: 'Inspect Task source', workspaceId: 'ws-test', contract });
  assert.equal(child.parentTaskId, parent.id);
  assert.deepEqual(child.childContract, contract);
  assert.equal(child.id, (await call('task.child.create', { parentTaskId: parent.id,
    expectedParentRev: parent.rev, requestId: 'read-1', goal: 'Inspect Task source',
    workspaceId: 'ws-test', contract })).id);
  assert.equal((await call('task.child.list', { parentTaskId: parent.id })).children.length, 1);
  const sameGoalRoot = await call('task.create', { goal: 'Inspect Task source', workspaceId: 'ws-test' });
  assert.notEqual(sameGoalRoot.id, child.id, 'a child cannot substitute for an independent root Task');
  await assert.rejects(call('task.child.create', { parentTaskId: child.id, expectedParentRev: child.rev,
    requestId: 'nested', goal: 'Nested', workspaceId: 'ws-test', contract }), { code: 'TASK_CHILD_DEPTH_EXCEEDED' });
  await assert.rejects(call('task.child.create', { parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'cross', goal: 'Cross', workspaceId: 'ws-other', contract }), { code: 'TASK_WORKSPACE_CONFLICT' });
  await assert.rejects(call('task.child.create', { parentTaskId: parent.id, expectedParentRev: parent.rev - 1,
    requestId: 'stale', goal: 'Stale', workspaceId: 'ws-test', contract }), { code: 'TASK_CONFLICT' });
  await assert.rejects(call('task.child.create', { parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'escape', goal: 'Escape', workspaceId: 'ws-test',
    contract: { ...contract, readScope: ['src/../private'] } }), { code: 'TASK_CHILD_SCOPE_DENIED' });
  await assert.rejects(call('task.child.create', { parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'writer', goal: 'Write', workspaceId: 'ws-test',
    contract: { ...contract, outputKind: 'code' } }), { code: 'INVALID_PARAMS' });
  await assert.rejects(call('task.child.create', { parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'fake-tool', goal: 'Fake completion', workspaceId: 'ws-test',
    contract: { ...contract, outputKind: 'tool', expectedEvidence: ['agent.run'] } }),
  { code: 'INVALID_PARAMS' });
  const a1 = service.runtime.recordAttempt({ id: child.id, expectedRev: child.rev,
    provider: 'cetamesh', sessionId: 'native-1', state: 'started', requestId: 'attempt-1' });
  const a2 = service.runtime.recordAttempt({ id: child.id, expectedRev: a1.rev,
    provider: 'cetamesh', sessionId: 'native-1', state: 'failed', requestId: 'attempt-2', reason: 'no effect' });
  assert.equal(a2.attempts.length, 2);
  assert.equal(a2.id, child.id);
  fs.mkdirSync(path.join(stateDir, 'src', 'task'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'src', 'task', 'runtime.js'), 'fixture');
  // Match Workspace registry semantics: CI Temp may be an alias/junction, while
  // registered roots are canonicalized before capability checks.
  const workspaceRoot = fs.realpathSync.native(stateDir);
  const policy = createCapabilityPolicy({ resolveWorkspace: id => ({ id, root: workspaceRoot }),
    resolveTask: id => service.runtime.get({ id }).task });
  const owner = { kind: 'owner', id: 'desktop' };
  await assert.rejects(Promise.resolve().then(() => policy.authorize({ actor: owner, taskId: child.id,
    workspaceId: 'ws-test', input: { path: 'src/task/runtime.js' } },
  { id: 'filesystem.write', permission: 'filesystem.write', workspace: true })),
  { code: 'TASK_CHILD_READ_ONLY' });
  assert.equal(policy.authorize({ actor: owner, taskId: child.id, workspaceId: 'ws-test',
    input: { path: 'src/task/runtime.js' } },
  { id: 'filesystem.read', permission: 'filesystem.read', workspace: true }).allowed, true);
  await assert.rejects(Promise.resolve().then(() => policy.authorize({ actor: owner, taskId: child.id,
    workspaceId: 'ws-test', input: { path: 'private.txt' } },
  { id: 'filesystem.read', permission: 'filesystem.read', workspace: true })),
  { code: 'TASK_CHILD_SCOPE_DENIED' });
  await assert.rejects(call('task.complete', { id: parent.id, expectedRev: parent.rev,
    summary: 'Agent says done' }), { code: 'TASK_CHILD_UNVERIFIED' });
  await assert.rejects(call('task.delete', { id: child.id, expectedRev: a2.rev }),
    { code: 'TASK_CHILD_LINKED' });
  await assert.rejects(call('task.delete', { id: parent.id, expectedRev: parent.rev }),
    { code: 'TASK_CHILD_LINKED' });
  await assert.rejects(call('task.cancel', { id: parent.id, expectedRev: parent.rev }),
    { code: 'TASK_CHILD_ACTIVE' });
  await assert.rejects(call('task.pause', { id: parent.id, expectedRev: parent.rev }),
    { code: 'TASK_CHILD_ACTIVE' });
  await assert.rejects(call('task.fail', { id: parent.id, expectedRev: parent.rev, reason: 'parent failed' }),
    { code: 'TASK_CHILD_ACTIVE' });
  await assert.rejects(call('task.update', { id: parent.id, expectedRev: parent.rev,
    workspaceId: 'ws-other' }), { code: 'TASK_CHILD_LINKED' });
  const parent2 = await call('task.create', { goal: 'Check file read', workspaceId: 'ws-test' });
  const toolChild = await call('task.child.create', { parentTaskId: parent2.id,
    expectedParentRev: parent2.rev, requestId: 'tool-child', goal: 'Read scoped file',
    workspaceId: 'ws-test', contract: { mode: 'read-only', outputKind: 'tool',
      readScope: ['src/task'], expectedEvidence: ['filesystem.read'] } });
  let running = service.runtime.start({ id: toolChild.id, expectedRev: toolChild.rev,
    provider: 'cetamesh', sessionId: 'read-session' }).task;
  running = service.runtime.recordAttempt({ id: toolChild.id, expectedRev: running.rev,
    provider: 'cetamesh', sessionId: 'read-session', requestId: 'read-turn', state: 'started' });
  service.runtime.recordToolOutcome({ id: toolChild.id, provider: 'cetamesh',
    sessionId: 'read-session', runId: 'read-turn', eventId: 'read-proof', capability: 'filesystem.read', status: 'completed' });
  service.runtime.settleAttempt({ id: toolChild.id, expectedRev: service.runtime.get({ id: toolChild.id }).task.rev,
    requestId: 'read-turn', state: 'completed' });
  const finished = await call('task.complete', { id: toolChild.id,
    expectedRev: service.runtime.get({ id: toolChild.id }).task.rev, summary: 'Read observed' });
  const verification = await call('task.child.verify', { id: toolChild.id, expectedRev: finished.task.rev });
  assert.equal(verification.status, 'VERIFIED');
  assert.equal(service.runtime.get({ id: toolChild.id }).task.acceptance[0].met, true,
    'observed tool result, not model self-report, satisfies child acceptance');
  const changedGoal = await call('task.update', { id: parent2.id, expectedRev: parent2.rev,
    goal: 'Different objective' });
  const changedRunning = (await call('task.start', { id: parent2.id, expectedRev: changedGoal.rev })).task;
  await assert.rejects(call('task.complete', { id: parent2.id, expectedRev: changedRunning.rev,
    summary: 'Stale child result' }), { code: 'TASK_CHILD_PARENT_CHANGED' });
  const restoredGoal = await call('task.update', { id: parent2.id, expectedRev: changedRunning.rev,
    goal: 'Check file read' });
  const parent2Running = restoredGoal;
  const parentDone = (await call('task.complete', { id: parent2.id, expectedRev: parent2Running.rev,
    summary: 'Both facts observed' })).task;
  assert.equal(parentDone.status, 'completed');
  assert.deepEqual(parentDone.result.childResultRefs[0].evidenceEventIds, ['read-proof']);
  const parent3 = await call('task.create', { goal: 'Two read outcomes', workspaceId: 'ws-test' });
  const child3 = await call('task.child.create', { parentTaskId: parent3.id,
    expectedParentRev: parent3.rev, requestId: 'two-tools', goal: 'Read and search', workspaceId: 'ws-test',
    contract: { mode: 'read-only', outputKind: 'tool', readScope: ['src/task'],
      expectedEvidence: ['filesystem.read', 'filesystem.search'] } });
  let both = service.runtime.start({ id: child3.id, expectedRev: child3.rev,
    provider: 'cetamesh', sessionId: 'two-tool-session' }).task;
  both = service.runtime.recordAttempt({ id: both.id, expectedRev: both.rev,
    provider: 'cetamesh', sessionId: 'two-tool-session', requestId: 'two-tool-run', state: 'started' });
  for (const item of both.acceptance) {
    both = service.runtime.setAcceptance({ id: both.id, expectedRev: both.rev,
      acceptanceId: item.id, met: true });
  }
  service.runtime.recordToolOutcome({ id: both.id, provider: 'cetamesh', sessionId: 'two-tool-session',
    eventId: 'read-only-proof', capability: 'filesystem.read', status: 'completed' });
  service.runtime.settleAttempt({ id: both.id, expectedRev: service.runtime.get({ id: both.id }).task.rev,
    requestId: 'two-tool-run', state: 'completed' });
  const partial = (await call('task.complete', { id: both.id,
    expectedRev: service.runtime.get({ id: both.id }).task.rev, summary: 'One of two' })).task;
  assert.equal((await call('task.child.verify', { id: both.id, expectedRev: partial.rev })).status,
    'NEEDS_REVIEW', 'one of two declared tool results cannot verify the child');
  const partialReplacement = await call('task.child.create', { parentTaskId: parent3.id,
    expectedParentRev: parent3.rev, requestId: 'partial-replacement', goal: 'Retry missing search',
    workspaceId: 'ws-test', supersedesChildId: child3.id,
    contract: { mode: 'read-only', outputKind: 'tool', readScope: ['src/task'],
      expectedEvidence: ['filesystem.search'] } });
  assert.equal(partialReplacement.supersedesChildId, child3.id);
  const staleToolParent = await call('task.create', { goal: 'Latest tool attempt proof', workspaceId: 'ws-test' });
  const staleTool = await call('task.child.create', { parentTaskId: staleToolParent.id,
    expectedParentRev: staleToolParent.rev, requestId: 'stale-tool-child', goal: 'Read in latest turn',
    workspaceId: 'ws-test', contract: { mode: 'read-only', outputKind: 'tool',
      readScope: ['src/task'], expectedEvidence: ['filesystem.read'] } });
  let staleToolRun = service.runtime.start({ id: staleTool.id, expectedRev: staleTool.rev,
    provider: 'cetamesh', sessionId: 'stale-tool-session' }).task;
  staleToolRun = service.runtime.recordAttempt({ id: staleTool.id, expectedRev: staleToolRun.rev,
    provider: 'cetamesh', sessionId: 'stale-tool-session', requestId: 'tool-turn-one', state: 'started' });
  service.runtime.recordToolOutcome({ id: staleTool.id, provider: 'cetamesh',
    sessionId: 'stale-tool-session', runId: 'tool-turn-one', eventId: 'prior-read',
    capability: 'filesystem.read', status: 'completed' });
  const afterFirstRead = service.runtime.get({ id: staleTool.id }).task;
  staleToolRun = service.runtime.settleAttempt({ id: staleTool.id, expectedRev: afterFirstRead.rev,
    requestId: 'tool-turn-one', state: 'completed' });
  staleToolRun = service.runtime.recordAttempt({ id: staleTool.id, expectedRev: staleToolRun.rev,
    provider: 'cetamesh', sessionId: 'stale-tool-session', requestId: 'tool-turn-two', state: 'started' });
  staleToolRun = service.runtime.settleAttempt({ id: staleTool.id, expectedRev: staleToolRun.rev,
    requestId: 'tool-turn-two', state: 'completed' });
  const staleToolDone = service.runtime.complete({ id: staleTool.id,
    expectedRev: staleToolRun.rev, summary: 'Model claims second read' }).task;
  assert.equal((await service.runtime.verifyChild({ id: staleTool.id,
    expectedRev: staleToolDone.rev })).status, 'NEEDS_REVIEW',
    'a prior Attempt read cannot verify the latest Attempt');
  const reviewParent = await call('task.create', { goal: 'Owner reviewed analysis', workspaceId: 'ws-test' });
  const analysis = await call('task.child.create', { parentTaskId: reviewParent.id,
    expectedParentRev: reviewParent.rev, requestId: 'analysis-review', goal: 'Inspect evidence',
    workspaceId: 'ws-test', contract });
  let analysisRun = service.runtime.start({ id: analysis.id, expectedRev: analysis.rev,
    provider: 'cetamesh', sessionId: 'analysis-native' }).task;
  analysisRun = service.runtime.recordAttempt({ id: analysis.id, expectedRev: analysisRun.rev,
    provider: 'cetamesh', sessionId: 'analysis-native', requestId: 'analysis-turn', state: 'started' });
  service.runtime.recordAgentReport({ id: analysis.id, expectedRev: analysisRun.rev,
    provider: 'cetamesh', sessionId: 'analysis-native', runId: 'analysis-turn',
    eventId: 'report-1', text: 'Evidence based finding' });
  service.runtime.recordToolOutcome({ id: analysis.id, provider: 'cetamesh', sessionId: 'analysis-native',
    runId: 'analysis-turn', eventId: 'source-1', capability: 'filesystem.read', status: 'completed' });
  service.runtime.settleAttempt({ id: analysis.id, expectedRev: service.runtime.get({ id: analysis.id }).task.rev,
    requestId: 'analysis-turn', state: 'completed' });
  const analysisDone = (await call('task.complete', { id: analysis.id,
    expectedRev: service.runtime.get({ id: analysis.id }).task.rev, summary: 'Review finding' })).task;
  assert.throws(() => service.runtime.reviewChild({ id: analysis.id, expectedRev: analysisDone.rev,
    approve: true, reviewSummary: 'Checked source', evidenceEventIds: [] }),
  { code: 'TASK_CHILD_EVIDENCE_REQUIRED' });
  const reviewed = service.runtime.reviewChild({ id: analysis.id, expectedRev: analysisDone.rev,
    approve: true, reviewSummary: 'Checked source and analysis', evidenceEventIds: ['source-1'] });
  assert.equal(reviewed.result.verification, 'VERIFIED');
  const staleParent = await call('task.create', { goal: 'Reject stale analysis evidence', workspaceId: 'ws-test' });
  const staleChild = await call('task.child.create', { parentTaskId: staleParent.id,
    expectedParentRev: staleParent.rev, requestId: 'stale-analysis', goal: 'Inspect recent source',
    workspaceId: 'ws-test', contract });
  let staleRun = service.runtime.start({ id: staleChild.id, expectedRev: staleChild.rev,
    provider: 'cetamesh', sessionId: 'stale-session' }).task;
  staleRun = service.runtime.recordAttempt({ id: staleChild.id, expectedRev: staleRun.rev,
    provider: 'cetamesh', sessionId: 'stale-session', state: 'started', requestId: 'stale-run' });
  service.runtime.recordToolOutcome({ id: staleChild.id, provider: 'cetamesh', sessionId: 'stale-session',
    runId: 'stale-run', eventId: 'old-read', capability: 'filesystem.read', status: 'completed' });
  service.runtime.recordAgentReport({ id: staleChild.id,
    expectedRev: service.runtime.get({ id: staleChild.id }).task.rev,
    provider: 'cetamesh', sessionId: 'stale-session', runId: 'stale-run',
    eventId: 'old-report', text: 'Old analysis' });
  service.runtime.recordToolOutcome({ id: staleChild.id, provider: 'cetamesh', sessionId: 'stale-session',
    runId: 'stale-run', eventId: 'failed-new-read', capability: 'filesystem.read', status: 'failed' });
  const staleBeforeEnd = service.runtime.get({ id: staleChild.id }).task;
  service.runtime.settleAttempt({ id: staleChild.id, expectedRev: staleBeforeEnd.rev,
    requestId: 'stale-run', state: 'completed' });
  const staleDone = service.runtime.complete({ id: staleChild.id,
    expectedRev: service.runtime.get({ id: staleChild.id }).task.rev, summary: 'Old result' }).task;
  assert.throws(() => service.runtime.reviewChild({ id: staleChild.id, expectedRev: staleDone.rev,
    approve: true, reviewSummary: 'Approve old data', evidenceEventIds: ['old-read'] }),
  { code: 'TASK_CHILD_EVIDENCE_REQUIRED' }, 'later failed read invalidates older analysis evidence');
  const rejected = service.runtime.reviewChild({ id: staleChild.id, expectedRev: staleDone.rev,
    approve: false, reviewSummary: 'Latest read failed', evidenceEventIds: [] });
  const retryAnalysis = await call('task.child.create', { parentTaskId: staleParent.id,
    expectedParentRev: staleParent.rev, requestId: 'retry-analysis', goal: 'Retry analysis',
    workspaceId: 'ws-test', supersedesChildId: staleChild.id, contract });
  assert.equal(retryAnalysis.supersedesChildId, staleChild.id);
  const reviewParentRun = service.runtime.start({ id: reviewParent.id, expectedRev: reviewParent.rev }).task;
  assert.equal(service.runtime.complete({ id: reviewParent.id, expectedRev: reviewParentRun.rev,
    summary: 'Owner reviewed sources' }).task.status, 'completed');
  const retryParent = await call('task.create', { goal: 'Recover a failed independent read', workspaceId: 'ws-test' });
  const failedRead = await call('task.child.create', { parentTaskId: retryParent.id,
    expectedParentRev: retryParent.rev, requestId: 'failed-read', goal: 'Read first attempt',
    workspaceId: 'ws-test', contract: { mode: 'read-only', outputKind: 'tool',
      readScope: ['src/task'], expectedEvidence: ['filesystem.read'] } });
  const failedRunning = service.runtime.start({ id: failedRead.id, expectedRev: failedRead.rev }).task;
  service.runtime.fail({ id: failedRead.id, expectedRev: failedRunning.rev, reason: 'Confirmed no result' });
  const replacement = await call('task.child.create', { parentTaskId: retryParent.id,
    expectedParentRev: retryParent.rev, requestId: 'replacement-read', goal: 'Read after failure',
    workspaceId: 'ws-test', supersedesChildId: failedRead.id,
    contract: { mode: 'read-only', outputKind: 'tool', readScope: ['src/task'], expectedEvidence: ['filesystem.read'] } });
  assert.equal(replacement.supersedesChildId, failedRead.id);
  let replacementRun = service.runtime.start({ id: replacement.id, expectedRev: replacement.rev,
    provider: 'cetamesh', sessionId: 'replacement-session' }).task;
  replacementRun = service.runtime.recordAttempt({ id: replacement.id, expectedRev: replacementRun.rev,
    provider: 'cetamesh', sessionId: 'replacement-session', requestId: 'replacement-turn', state: 'started' });
  service.runtime.recordToolOutcome({ id: replacement.id, provider: 'cetamesh', sessionId: 'replacement-session',
    runId: 'replacement-turn', eventId: 'replacement-proof', capability: 'filesystem.read', status: 'completed' });
  service.runtime.settleAttempt({ id: replacement.id,
    expectedRev: service.runtime.get({ id: replacement.id }).task.rev,
    requestId: 'replacement-turn', state: 'completed' });
  const replacementDone = service.runtime.complete({ id: replacement.id,
    expectedRev: service.runtime.get({ id: replacement.id }).task.rev, summary: 'Read verified' }).task;
  assert.equal((await service.runtime.verifyChild({ id: replacement.id,
    expectedRev: replacementDone.rev })).status, 'VERIFIED');
  const retryParentRun = service.runtime.start({ id: retryParent.id, expectedRev: retryParent.rev }).task;
  const retryDone = service.runtime.complete({ id: retryParent.id, expectedRev: retryParentRun.rev,
    summary: 'Recovered result' }).task;
  assert.deepEqual(retryDone.result.priorFailedChildIds, [failedRead.id]);
  const interrupted = service.runtime.createChild({ parentTaskId: parent.id,
    expectedParentRev: parent.rev, requestId: 'interrupt-child', goal: 'Read before restart',
    workspaceId: 'ws-test', contract });
  const inFlight = service.runtime.start({ id: interrupted.id, expectedRev: interrupted.rev,
    provider: 'cetamesh', sessionId: 'old-native-session' }).task;
  const observed = service.runtime.recordAttempt({ id: inFlight.id, expectedRev: inFlight.rev,
    provider: 'cetamesh', sessionId: 'old-native-session', requestId: 'old-turn', state: 'started' });
  service.runtime.settleAttempt({ id: observed.id, expectedRev: observed.rev,
    requestId: 'old-turn', state: 'accepted', nativeRequestId: 'native-request' });
  const restarted = createTaskService({ stateDir });
  const recovery = restarted.runtime.get({ id: interrupted.id }).task;
  assert.equal(recovery.status, 'blocked');
  assert.equal(recovery.attempts[0].state, 'unknown');
  assert.match(recovery.progress.note, /needs-reconciliation/);
  assert.equal(policy.authorize({ actor: owner, taskId: interrupted.id, workspaceId: 'ws-test', input: {} },
    { id: 'git.status', permission: 'git.status', workspace: true }).allowed, true);
  const acknowledged = restarted.runtime.acknowledgeUnknownAttempts({ id: interrupted.id,
    expectedRev: recovery.rev, reviewSummary: 'Owner verified Workspace after restart' });
  assert.equal(acknowledged.attempts[0].state, 'reviewed');
  const taskFile = path.join(stateDir, 'tasks', 'tasks.json');
  const stored = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  stored.tasks.find(row => row.id === interrupted.id).childContract.mode = 'write';
  fs.writeFileSync(taskFile, JSON.stringify(stored));
  assert.throws(() => createTaskService({ stateDir }).runtime.countAll(),
    { code: 'STORE_CORRUPT' }, 'invalid persisted child authority must fail closed');
  stored.tasks.find(row => row.id === interrupted.id).childContract.mode = 'read-only';
  const interruptedStored = stored.tasks.find(row => row.id === interrupted.id);
  interruptedStored.attempts.push({ ...interruptedStored.attempts[0] });
  fs.writeFileSync(taskFile, JSON.stringify(stored));
  assert.throws(() => createTaskService({ stateDir }).runtime.countAll(),
    { code: 'STORE_CORRUPT' }, 'duplicate persisted Attempt identity must fail closed');
  console.log('PASS task collaboration parent, contract, depth, idempotency, rev, attempts and completion fence');
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
