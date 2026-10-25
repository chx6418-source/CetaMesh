import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-agent-collab-'));
const services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') });
try {
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'readme.txt'), 'fixture');
  fs.mkdirSync(path.join(workspaceRoot, 'scoped'));
  fs.writeFileSync(path.join(workspaceRoot, 'secret.txt'), 'private fixture');
  const { workspace } = await services.workspaceService.execute({ method: 'workspace.create',
    params: { name: 'Collaboration fixture', root: workspaceRoot } });
  const rt = services.taskService.runtime;
  const parent = rt.create({ goal: 'Summarize files', workspaceId: workspace.id });
  const contract = { mode: 'read-only', outputKind: 'analysis', readScope: ['readme.txt', 'scoped'], expectedEvidence: ['source'] };
  const aCreated = await services.desktopUiService.execute({ method: 'ui.task.child.create', params: {
    parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'read-a', goal: 'Read A', workspaceId: workspace.id, contract
  } });
  const a = rt.get({ id: aCreated.task.id }).task;
  const b = rt.createChild({ parentTaskId: parent.id, expectedParentRev: parent.rev,
    requestId: 'read-b', goal: 'Read B', workspaceId: workspace.id, contract });
  const sent = [];
  services.agentBroker.send = async row => { sent.push(row); return { accepted: true, requestId: `run-${sent.length}` }; };
  const run = (task, provider, requestId) => services.capabilityService.broker.execute({
    requestId, actor: OWNER_ACTOR, taskId: task.id, workspaceId: workspace.id,
    capability: 'agent.run', input: { agentProvider: provider, content: task.goal }
  });
  await assert.rejects(run(a, 'dsh', 'collab-native-read'),
    { code: 'AGENT_READ_ONLY_BOUNDARY_UNVERIFIED' });
  assert.equal(sent.length, 0, 'native Agent cannot receive a read-only child without a verified boundary');
  const actualHealth = services.agentBroker.health.bind(services.agentBroker);
  services.agentBroker.health = async () => ({ available: false, authenticated: false, sessionCapable: false });
  await assert.rejects(run(a, 'cetamesh', 'collab-unhealthy'), { code: 'PROVIDER_UNAVAILABLE' });
  services.agentBroker.health = async () => ({ available: true, disabled: true, installed: true });
  await assert.rejects(run(a, 'cetamesh', 'collab-disabled'), { code: 'PROVIDER_UNAVAILABLE' });
  services.agentBroker.health = actualHealth;
  assert.equal(sent.length, 0, 'unhealthy provider cannot receive Task work');
  const changedParent = rt.create({ goal: 'Original objective', workspaceId: workspace.id });
  const staleChild = rt.createChild({ parentTaskId: changedParent.id, expectedParentRev: changedParent.rev,
    requestId: 'changed-parent-read', goal: 'Old child objective', workspaceId: workspace.id, contract });
  rt.update({ id: changedParent.id, expectedRev: changedParent.rev, goal: 'Changed objective' });
  await assert.rejects(run(staleChild, 'cetamesh', 'changed-parent-dispatch'),
    { code: 'TASK_CHILD_PARENT_CHANGED' });
  assert.equal(sent.length, 0, 'stale child objective must not consume an Agent turn');
  const first = await run(a, 'cetamesh', 'collab-run-a');
  const second = await run(b, 'cetamesh', 'collab-run-b');
  assert.equal(first.result.accepted, true);
  assert.equal(second.result.accepted, true, 'two independent read-only children may execute');
  assert.equal(sent.length, 2);
  const pauseParent = rt.create({ goal: 'Pause with active child', workspaceId: workspace.id });
  const pauseChild = rt.createChild({ parentTaskId: pauseParent.id, expectedParentRev: pauseParent.rev,
    requestId: 'pause-child', goal: 'Active child', workspaceId: workspace.id, contract });
  const pauseChildRunning = rt.start({ id: pauseChild.id, expectedRev: pauseChild.rev,
    provider: 'cetamesh', sessionId: 'pause-child-session' }).task;
  assert.throws(() => rt.start({ id: pauseParent.id, expectedRev: pauseParent.rev }),
    { code: 'TASK_CHILD_ACTIVE' });
  let pauseCancelCalls = 0;
  const originalPauseCancel = services.agentBroker.cancel;
  services.agentBroker.cancel = async () => { pauseCancelCalls++; return { cancelled: true }; };
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.pause', params: {
    id: pauseParent.id, expectedRev: pauseParent.rev
  } }), { code: 'TASK_CHILD_ACTIVE' });
  assert.equal(pauseCancelCalls, 0, 'invalid parent pause must not stop the Agent first');
  assert.equal(rt.get({ id: pauseParent.id }).task.status, 'queued');
  services.agentBroker.cancel = originalPauseCancel;
  rt.cancel({ id: pauseChild.id, expectedRev: pauseChildRunning.rev });
  rt.cancel({ id: pauseParent.id, expectedRev: pauseParent.rev });
  const racedPauseParent = rt.create({ goal: 'Pause race parent', workspaceId: workspace.id });
  const racedPauseRunning = rt.start({ id: racedPauseParent.id, expectedRev: racedPauseParent.rev,
    provider: 'cetamesh', sessionId: 'raced-pause-session' }).task;
  const originalRaceCancel = services.agentBroker.cancel;
  services.agentBroker.cancel = async () => ({ cancelled: true });
  const originalCancelOperations = services.capabilityService.cancelTaskOperations;
  let releasePauseOperations;
  let pauseOperationsEntered;
  const entered = new Promise(resolve => { pauseOperationsEntered = resolve; });
  services.capabilityService.cancelTaskOperations = async () => {
    pauseOperationsEntered();
    await new Promise(resolve => { releasePauseOperations = resolve; });
    return [];
  };
  const racedPause = services.desktopUiService.execute({ method: 'ui.task.pause', params: {
    id: racedPauseParent.id, expectedRev: racedPauseRunning.rev
  } });
  await entered;
  assert.throws(() => rt.createChild({ parentTaskId: racedPauseParent.id,
    expectedParentRev: rt.get({ id: racedPauseParent.id }).task.rev,
    requestId: 'race-child', goal: 'Late child', workspaceId: workspace.id, contract }),
  { code: 'TASK_PARENT_TERMINAL' }, 'Pause fence must reject a child before the parent Agent stop');
  releasePauseOperations();
  const racedPaused = await racedPause;
  services.capabilityService.cancelTaskOperations = originalCancelOperations;
  services.agentBroker.cancel = originalRaceCancel;
  assert.equal(racedPaused.task.status, 'paused');
  const secondParent = rt.create({ goal: 'Another parent', workspaceId: workspace.id });
  const thirdRead = rt.createChild({ parentTaskId: secondParent.id, expectedParentRev: secondParent.rev,
    requestId: 'third-read', goal: 'Third Workspace read', workspaceId: workspace.id, contract });
  await assert.rejects(run(thirdRead, 'cetamesh', 'collab-third-read'),
    { code: 'TASK_WORKSPACE_BUSY' }, 'two-reader limit spans parent Tasks');
  assert.equal(rt.get({ id: a.id }).task.attempts.length, 1, 'accepted Agent turn records an Attempt');
  assert.equal(rt.get({ id: b.id }).task.attempts[0].sessionId, second.result.sessionId);
  await assert.rejects(services.continuityService.runtime.rollover({ taskId: a.id, targetProvider: 'dsh' }),
    error => error.code === 'AGENT_READ_ONLY_BOUNDARY_UNVERIFIED',
    'Continuity cannot bypass the native read-only child fence');
  const projected = (await services.desktopUiService.execute({ method: 'ui.task.get', params: { id: parent.id } })).task;
  assert.equal(projected.children.length, 2);
  assert.equal(projected.children[0].verification, 'NEEDS_REVIEW');
  assert.equal(projected.children[0].attemptCount, 1);
  services.usageLedger.record({ sessionId: first.result.sessionId, taskId: a.id,
    turnId: 'fixture-turn-a', usage: { requests: [{ requestId: 'fixture-model-a',
      inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 }] } });
  services.usageLedger.record({ sessionId: second.result.sessionId, taskId: b.id,
    turnId: 'fixture-turn-b', usage: { requests: [{ requestId: 'fixture-model-b',
      inputTokens: 11, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 }] } });
  const withUsage = (await services.desktopUiService.execute({ method: 'ui.task.get', params: { id: parent.id } })).task;
  assert.equal(withUsage.usage.inputTokens, 18);
  assert.equal(withUsage.usage.cost.amount, null, 'unknown tariff must remain unknown');
  const assigned = rt.get({ id: a.id }).task;
  const tool = (capability, input, requestId) => services.capabilityService.broker.execute({
    requestId, actor: services.capabilityService.principalForTask(a.id), taskId: a.id,
    workspaceId: workspace.id, assignment: assigned.currentAgent, capability, input
  });
  await assert.rejects(tool('filesystem.write', { path: 'readme.txt', content: 'mutated' }, 'collab-write'),
    { code: 'PERMISSION_DENIED' }, 'child grant does not even advertise a write capability');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'readme.txt'), 'utf8'), 'fixture');
  await assert.rejects(tool('filesystem.read', { path: 'other.txt' }, 'collab-outside'),
    { code: 'TASK_CHILD_SCOPE_DENIED' });
  const read = await tool('filesystem.read', { path: 'readme.txt' }, 'collab-inside');
  assert.equal(read.status, 'completed');
  try {
    fs.symlinkSync(path.join(workspaceRoot, 'secret.txt'), path.join(workspaceRoot, 'scoped', 'leak.txt'), 'file');
    await assert.rejects(tool('filesystem.read', { path: 'scoped/leak.txt' }, 'collab-symlink'),
      { code: 'TASK_CHILD_SCOPE_DENIED' });
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    console.log('NOT_RUN_ENVIRONMENT child symlink regression: Windows symlink creation denied');
  }
  const writer = rt.create({ goal: 'Write in same Workspace', workspaceId: workspace.id });
  await assert.rejects(run(writer, 'cetamesh', 'collab-writer'), { code: 'TASK_WORKSPACE_BUSY' });
  assert.equal(sent.length, 2, 'writer must not start during child reads');
  const staleRoot = rt.start({ id: writer.id, expectedRev: writer.rev,
    provider: 'cetamesh', sessionId: 'stale-root-session' }).task;
  await assert.rejects(services.continuityService.runtime.rollover({ taskId: staleRoot.id }),
    { code: 'ROLLOVER_NOT_SAFE' }, 'Continuity cannot start a root writer while child readers own Workspace');
  rt.cancel({ id: staleRoot.id, expectedRev: staleRoot.rev });
  await services.desktopUiService.execute({ method: 'ui.task.cancel',
    params: { id: parent.id, expectedRev: parent.rev } });
  assert.equal(rt.get({ id: a.id }).task.status, 'cancelled');
  assert.equal(rt.get({ id: b.id }).task.status, 'cancelled');
  assert.equal(rt.get({ id: a.id }).task.attempts[0].state, 'unknown');
  await assert.rejects(run(a, 'cetamesh', 'collab-after-parent-cancel'),
    { code: 'TASK_NOT_AUTHORIZED' });
  const uncertainParent = rt.create({ goal: 'Cancel uncertain child', workspaceId: workspace.id });
  const uncertainChild = rt.createChild({ parentTaskId: uncertainParent.id, expectedParentRev: uncertainParent.rev,
    requestId: 'uncertain-child', goal: 'Read before cancel', workspaceId: workspace.id, contract });
  await run(uncertainChild, 'cetamesh', 'uncertain-run');
  const realStatus = services.agentBroker.status.bind(services.agentBroker);
  services.agentBroker.status = async () => ({ running: true });
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.cancel',
    params: { id: uncertainParent.id, expectedRev: uncertainParent.rev } }),
  { code: 'INVOKE_CANCEL_UNCONFIRMED' });
  assert.equal(rt.get({ id: uncertainParent.id }).task.status, 'blocked');
  assert.equal(rt.get({ id: uncertainChild.id }).task.status, 'running');
  services.agentBroker.status = realStatus;
  await services.desktopUiService.execute({ method: 'ui.task.cancel',
    params: { id: uncertainParent.id, expectedRev: rt.get({ id: uncertainParent.id }).task.rev } });
  const observedParent = rt.create({ goal: 'Observe native turn', workspaceId: workspace.id });
  const observedChild = rt.createChild({ parentTaskId: observedParent.id,
    expectedParentRev: observedParent.rev, requestId: 'observed-child',
    goal: 'Read with native event', workspaceId: workspace.id, contract });
  let emitTurn;
  const turn = new Promise(resolve => { emitTurn = resolve; });
  services.agentBroker.follow = async function* () { yield await turn; };
  services.agentBroker.send = async row => {
    queueMicrotask(() => emitTurn({ type: 'turn/end', seq: 1, data: {
      requestId: 'native-observed', runId: row.runId, phase: 'user', reason: { kind: 'completed' }
    } }));
    return { accepted: true, requestId: 'native-observed' };
  };
  await run(observedChild, 'cetamesh', 'observed-run');
  let settled;
  for (let i = 0; i < 40; i++) {
    settled = rt.get({ id: observedChild.id }).task.attempts[0];
    if (settled?.state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(settled?.state, 'completed', 'native turn/end must close the matching Task Attempt');
  const uiParent = rt.create({ goal: 'Review analysis through Owner UI', workspaceId: workspace.id });
  const uiChild = rt.createChild({ parentTaskId: uiParent.id, expectedParentRev: uiParent.rev,
    requestId: 'ui-analysis', goal: 'Analyze source', workspaceId: workspace.id, contract });
  const uiRunning = rt.start({ id: uiChild.id, expectedRev: uiChild.rev,
    provider: 'cetamesh', sessionId: 'ui-review-session' }).task;
  let uiAttempt = rt.recordAttempt({ id: uiChild.id, expectedRev: uiRunning.rev,
    requestId: 'ui-review-run', provider: 'cetamesh', sessionId: 'ui-review-session', state: 'started' });
  rt.recordAgentReport({ id: uiChild.id, expectedRev: uiAttempt.rev, provider: 'cetamesh',
    sessionId: 'ui-review-session', runId: 'ui-review-run', eventId: 'ui-report', text: 'Observed source summary' });
  rt.recordToolOutcome({ id: uiChild.id, provider: 'cetamesh', sessionId: 'ui-review-session',
    runId: 'ui-review-run', eventId: 'ui-read', capability: 'filesystem.read', status: 'completed' });
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.child.complete', params: {
    id: uiChild.id, expectedRev: rt.get({ id: uiChild.id }).task.rev, summary: 'Source summary'
  } }), { code: 'TASK_ATTEMPT_NOT_CONFIRMED' });
  uiAttempt = rt.settleAttempt({ id: uiChild.id, expectedRev: rt.get({ id: uiChild.id }).task.rev, requestId: 'ui-review-run', state: 'completed',
    reason: 'native turn/end' });
  const originalRecovery = services.capabilityService.recoveryForTask;
  services.capabilityService.recoveryForTask = () => ({ state: 'needs-reconciliation', capability: 'agent.run' });
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.child.complete', params: {
    id: uiChild.id, expectedRev: rt.get({ id: uiChild.id }).task.rev, summary: 'Source summary'
  } }), { code: 'TASK_EFFECT_UNCONFIRMED' });
  services.capabilityService.recoveryForTask = originalRecovery;
  const uiCompletedResult = await services.desktopUiService.execute({ method: 'ui.task.child.complete', params: {
    id: uiChild.id, expectedRev: rt.get({ id: uiChild.id }).task.rev, summary: 'Source summary'
  } });
  const uiCompleted = rt.get({ id: uiChild.id }).task;
  assert.equal(uiCompletedResult.task.status, 'completed');
  assert.equal(uiCompletedResult.task.verification, 'NEEDS_REVIEW');
  await assert.rejects(services.taskService.execute({ method: 'task.child.review',
    params: { id: uiChild.id, approve: true } }), { code: 'METHOD_NOT_FOUND' });
  const uiReviewed = await services.desktopUiService.execute({ method: 'ui.task.child.review',
    params: { id: uiChild.id, expectedRev: uiCompleted.rev, approve: true,
      reviewSummary: 'Owner checked source and analysis', evidenceEventIds: ['ui-read'] } });
  assert.equal(uiReviewed.task.verification, 'VERIFIED');
  const emptyRoot = rt.create({ goal: 'Model says done without evidence', workspaceId: workspace.id });
  const activeEmptyRoot = rt.start({ id: emptyRoot.id, expectedRev: emptyRoot.rev,
    provider: 'cetamesh', sessionId: 'empty-root-session' }).task;
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.complete', params: {
    id: emptyRoot.id, expectedRev: activeEmptyRoot.rev, summary: 'Claimed done', reviewed: true
  } }), { code: 'TASK_EVIDENCE_REQUIRED' });
  const activeUiParent = rt.start({ id: uiParent.id, expectedRev: uiParent.rev,
    provider: 'cetamesh', sessionId: 'ui-parent-session' }).task;
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.complete', params: {
    id: uiParent.id, expectedRev: activeUiParent.rev, summary: 'Accepted source summary', reviewed: false
  } }), { code: 'OWNER_REVIEW_REQUIRED' });
  const completedParent = await services.desktopUiService.execute({ method: 'ui.task.complete', params: {
    id: uiParent.id, expectedRev: activeUiParent.rev, summary: 'Accepted source summary', reviewed: true
  } });
  assert.equal(completedParent.task.status, 'completed');
  assert.equal(rt.get({ id: uiParent.id }).task.result.childResultRefs[0].childId, uiChild.id);
  const repeatedParent = rt.create({ goal: 'Latest analysis review', workspaceId: workspace.id });
  const repeatedChild = rt.createChild({ parentTaskId: repeatedParent.id,
    expectedParentRev: repeatedParent.rev, requestId: 'repeated-analysis',
    goal: 'Read on latest turn', workspaceId: workspace.id, contract });
  let repeated = rt.start({ id: repeatedChild.id, expectedRev: repeatedChild.rev,
    provider: 'cetamesh', sessionId: 'repeated-session' }).task;
  for (const index of [1, 2]) {
    repeated = rt.recordAttempt({ id: repeatedChild.id, expectedRev: repeated.rev,
      provider: 'cetamesh', sessionId: 'repeated-session', requestId: `repeated-${index}`, state: 'started' });
    repeated = rt.recordAgentReport({ id: repeatedChild.id, expectedRev: repeated.rev,
      provider: 'cetamesh', sessionId: 'repeated-session', runId: `repeated-${index}`,
      eventId: `report-${index}`, text: `Report ${index}` });
    rt.recordToolOutcome({ id: repeatedChild.id, provider: 'cetamesh', sessionId: 'repeated-session',
      runId: `repeated-${index}`, eventId: `read-${index}`, capability: 'filesystem.read', status: 'completed' });
    repeated = rt.settleAttempt({ id: repeatedChild.id,
      expectedRev: rt.get({ id: repeatedChild.id }).task.rev,
      requestId: `repeated-${index}`, state: 'completed' });
  }
  const repeatedDone = rt.complete({ id: repeatedChild.id, expectedRev: repeated.rev,
    summary: 'Latest report' }).task;
  const latestReviewed = await services.desktopUiService.execute({ method: 'ui.task.child.review',
    params: { id: repeatedChild.id, expectedRev: repeatedDone.rev, approve: true,
      reviewSummary: 'Owner checked latest turn', evidenceEventIds: ['read-2'] } });
  assert.equal(latestReviewed.task.verification, 'VERIFIED');
  const briefingRoot = path.join(root, 'briefing-workspace');
  fs.mkdirSync(briefingRoot);
  fs.writeFileSync(path.join(briefingRoot, 'scope.txt'), 'allowed fixture');
  const { workspace: briefingWorkspace } = await services.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Briefing fixture', root: briefingRoot } });
  const briefingParent = rt.create({ goal: 'Owner parent briefing', workspaceId: briefingWorkspace.id });
  const briefingChild = rt.createChild({ parentTaskId: briefingParent.id, expectedParentRev: briefingParent.rev,
    requestId: 'briefing-child', goal: 'Inspect the allowed file', workspaceId: briefingWorkspace.id,
    contract: { mode: 'read-only', outputKind: 'tool', readScope: ['scope.txt'],
      expectedEvidence: ['filesystem.read'] } });
  services.agentBroker.send = async row => { sent.push(row); return { accepted: true, requestId: 'briefing-native' }; };
  const beforeBriefing = sent.length;
  await services.desktopUiService.execute({ method: 'ui.task.start', params: {
    id: briefingChild.id, expectedRev: briefingChild.rev, agentProvider: 'cetamesh'
  } });
  assert.equal(sent.length, beforeBriefing + 1);
  assert.match(sent.at(-1).content, /scope\.txt/, 'actual child instruction carries the read scope');
  assert.match(sent.at(-1).content, /filesystem\.read/, 'actual child instruction carries expected evidence');
  const briefingPrincipal = services.capabilityService.principalForTask(briefingChild.id);
  assert.deepEqual([...briefingPrincipal.grants.capabilities].sort(), ['filesystem.read', 'filesystem.search']);
  assert.deepEqual(briefingPrincipal.grants.scopes, [`task:${briefingChild.id}`],
    'read-only child does not receive unrelated Workspace Memory scope');
  await services.settingsService.execute({ method: 'settings.update', params: {
    section: 'memory', values: { enabled: true } } });
  await services.memoryService.execute({ method: 'memory.create', params: {
    type: 'workspace', scope: `workspace:${briefingWorkspace.id}`,
    content: 'Private unrelated Workspace Memory marker' } });
  const briefingAssigned = rt.get({ id: briefingChild.id }).task;
  const childContext = await services.productContextService.buildForAgentTurn({
    sessionId: briefingAssigned.currentAgent.sessionId, provider: 'cetamesh',
    principal: { taskId: briefingChild.id, expectedWorkspaceId: briefingWorkspace.id,
      workspaceId: briefingWorkspace.id, actor: briefingPrincipal },
    modelProvider: 'fixture', model: 'fixture' });
  assert.doesNotMatch(childContext.serialized, /Private unrelated Workspace Memory marker/);
  assert.doesNotMatch(childContext.serialized, /filesystem\.write.*granted/i);
  rt.recordToolOutcome({ id: briefingChild.id, provider: 'cetamesh',
    sessionId: briefingAssigned.currentAgent.sessionId, runId: briefingAssigned.attempts[0].requestId,
    eventId: 'briefing-read-proof', capability: 'filesystem.read', status: 'completed' });
  rt.settleAttempt({ id: briefingChild.id, expectedRev: rt.get({ id: briefingChild.id }).task.rev,
    requestId: briefingAssigned.attempts[0].requestId, state: 'completed' });
  const originalVerifyChild = rt.verifyChild;
  rt.verifyChild = async () => { throw Object.assign(new Error('fixture verification interruption'), { code: 'FIXTURE_VERIFY_IO' }); };
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.child.complete', params: {
    id: briefingChild.id, expectedRev: rt.get({ id: briefingChild.id }).task.rev, summary: 'Read scope file'
  } }), { code: 'FIXTURE_VERIFY_IO' });
  rt.verifyChild = originalVerifyChild;
  const pendingVerification = rt.get({ id: briefingChild.id }).task;
  assert.equal(pendingVerification.status, 'completed');
  assert.equal(pendingVerification.result.verification, undefined);
  const recoveredVerification = await services.desktopUiService.execute({ method: 'ui.task.child.verify',
    params: { id: briefingChild.id, expectedRev: pendingVerification.rev } });
  assert.equal(recoveredVerification.task.verification, 'VERIFIED',
    'Owner can retry read-only verification without replaying the Agent turn');
  const uiWorkflowParent = rt.create({ goal: 'Owner parent planning', workspaceId: briefingWorkspace.id });
  const uiWorkflowStarted = await services.desktopUiService.execute({ method: 'ui.task.start', params: {
    id: uiWorkflowParent.id, expectedRev: uiWorkflowParent.rev, agentProvider: 'cetamesh'
  } });
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.child.create', params: {
    parentTaskId: uiWorkflowParent.id, expectedParentRev: uiWorkflowStarted.task.rev,
    requestId: 'premature-child', goal: 'Read before pause', workspaceId: briefingWorkspace.id,
    contract: { mode: 'read-only', outputKind: 'tool', readScope: ['scope.txt'],
      expectedEvidence: ['filesystem.read'] }
  } }), { code: 'TASK_PARENT_PAUSE_REQUIRED' },
  'UI must reject child creation while parent writer is running');
  const workflowCancel = services.agentBroker.cancel;
  services.agentBroker.cancel = async () => ({ cancelled: true });
  const workflowPaused = await services.desktopUiService.execute({ method: 'ui.task.pause', params: {
    id: uiWorkflowParent.id, expectedRev: uiWorkflowStarted.task.rev
  } });
  services.agentBroker.cancel = workflowCancel;
  assert.equal(workflowPaused.task.status, 'paused');
  const workflowChild = await services.desktopUiService.execute({ method: 'ui.task.child.create', params: {
    parentTaskId: uiWorkflowParent.id, expectedParentRev: workflowPaused.task.rev,
    requestId: 'workflow-child', goal: 'Read while parent paused', workspaceId: briefingWorkspace.id,
    contract: { mode: 'read-only', outputKind: 'tool', readScope: ['scope.txt'],
      expectedEvidence: ['filesystem.read'] }
  } });
  const workflowChildStarted = await services.desktopUiService.execute({ method: 'ui.task.start', params: {
    id: workflowChild.task.id, expectedRev: workflowChild.task.rev, agentProvider: 'cetamesh'
  } });
  assert.equal(workflowChildStarted.task.status, 'running');
  assert.throws(() => rt.resume({ id: uiWorkflowParent.id,
    expectedRev: workflowPaused.task.rev }), { code: 'TASK_CHILD_ACTIVE' },
  'Task state transition itself must not race active child reads');
  const beforeUnsafeResume = sent.length;
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.resume', params: {
    id: uiWorkflowParent.id, expectedRev: workflowPaused.task.rev
  } }), { code: 'TASK_CHILD_ACTIVE' });
  assert.equal(sent.length, beforeUnsafeResume, 'parent writer cannot resume while child read owns Workspace');
  const queuedRoot = path.join(root, 'queued-workspace');
  fs.mkdirSync(queuedRoot);
  fs.writeFileSync(path.join(queuedRoot, 'queued.txt'), 'queued child fixture');
  const { workspace: queuedWorkspace } = await services.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Queued child fixture', root: queuedRoot } });
  const queuedParent = rt.create({ goal: 'Plan child before starting writer', workspaceId: queuedWorkspace.id });
  const queuedChild = rt.createChild({ parentTaskId: queuedParent.id,
    expectedParentRev: queuedParent.rev, requestId: 'queued-child', goal: 'Read queued file',
    workspaceId: queuedWorkspace.id, contract: { mode: 'read-only', outputKind: 'tool',
      readScope: ['queued.txt'], expectedEvidence: ['filesystem.read'] } });
  assert.throws(() => rt.start({ id: queuedParent.id, expectedRev: queuedParent.rev }),
    { code: 'TASK_CHILD_ACTIVE' }, 'Task transition cannot start parent writer over a queued child');
  const beforeQueuedStart = sent.length;
  await assert.rejects(services.desktopUiService.execute({ method: 'ui.task.start', params: {
    id: queuedParent.id, expectedRev: queuedParent.rev, agentProvider: 'cetamesh'
  } }), { code: 'TASK_CHILD_ACTIVE' });
  assert.equal(sent.length, beforeQueuedStart);
  const queuedChildStarted = await services.desktopUiService.execute({ method: 'ui.task.start', params: {
    id: queuedChild.id, expectedRev: queuedChild.rev, agentProvider: 'cetamesh'
  } });
  assert.equal(queuedChildStarted.task.status, 'running');
  console.log('PASS Agent Broker child read concurrency and Workspace writer fence');
} finally {
  await services.capabilityService.close();
  fs.rmSync(root, { recursive: true, force: true });
}
