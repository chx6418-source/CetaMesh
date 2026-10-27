import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityApproval } from '../src/capability/approval.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-tool-unknown-'));
try {
  let modelCalls = 0;
  let brokerCalls = 0;
  const observed = [];
  const coordinator = createToolExecutionCoordinator({
    stateDir,
    modelRuntime: { chat: async () => {
      modelCalls++;
      return { toolCalls: [
        { id: 'write-1', capabilityId: 'filesystem.write', arguments: { path: 'result.md', content: 'x' } },
        { id: 'write-2', capabilityId: 'filesystem.write', arguments: { path: 'result.md', content: 'x' } }
      ] };
    } },
    capabilityBroker: { execute: async () => {
      brokerCalls++;
      const error = new Error('Cancellation did not confirm the side effect');
      error.code = 'INVOKE_CANCEL_UNCONFIRMED';
      error.effectStatus = 'unknown';
      throw error;
    } }
  });
  const result = await coordinator.run({ actor: { kind: 'agent', id: 'agent-one' },
    sessionId: 'session-one', turnId: 'turn-one', scope: { taskId: 'task-one', workspaceId: 'workspace-one' },
    messages: [{ role: 'user', content: 'Write the file once' }],
    manifest: [{ id: 'filesystem.write', description: 'Write file', inputSchema: { type: 'object', additionalProperties: true } }],
    onCapabilityResult: event => observed.push(event)
  });
  assert.equal(observed[0]?.result?.status, 'outcome-unknown', 'unknown effect must remain distinct from denial');
  assert.equal(brokerCalls, 1, 'an uncertain write must not be automatically repeated');
  assert.equal(modelCalls, 1, 'the model must not start a recovery turn after an uncertain side effect');
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(coordinator.recoveryForTask('task-one')?.state, 'needs-reconciliation',
    'a later turn must see the unresolved side effect');
  await assert.rejects(coordinator.run({ actor: { kind: 'agent', id: 'agent-one' },
    sessionId: 'session-one', turnId: 'turn-two', scope: { taskId: 'task-one', workspaceId: 'workspace-one' },
    messages: [{ role: 'user', content: 'Try again' }],
    manifest: [{ id: 'filesystem.write', description: 'Write file', inputSchema: { type: 'object', additionalProperties: true } }]
  }), error => error.code === 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(brokerCalls, 1, 'a subsequent turn cannot replay before reconciliation');
  assert.equal(coordinator.acknowledgeTaskRecovery('task-one').reconciled, 1,
    'Owner review may explicitly reconcile the original dispatch');
  assert.equal(coordinator.recoveryForTask('task-one'), null);
  const completed = createToolExecutionCoordinator({
    stateDir,
    modelRuntime: { chat: async () => ({ toolCalls: [
      { id: 'write-once', capabilityId: 'filesystem.write', arguments: { path: 'once.md', content: 'done' } }
    ] }) },
    capabilityBroker: { execute: async () => { brokerCalls++; return { status: 'completed', result: { written: true } }; } },
    maxCycles: 1
  });
  const writeTurn = { actor: { kind: 'agent', id: 'agent-one' }, sessionId: 'session-once',
    turnId: 'turn-once', scope: { taskId: 'task-one', workspaceId: 'workspace-one' },
    messages: [{ role: 'user', content: 'Write once' }],
    manifest: [{ id: 'filesystem.write', description: 'Write file', inputSchema: { type: 'object', additionalProperties: true } }] };
  await completed.run(writeTurn);
  assert.equal(brokerCalls, 2);
  await assert.rejects(completed.run(writeTurn), error => error.code === 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(brokerCalls, 2, 'a duplicate logical turn cannot dispatch the write again');
  const restarted = createToolExecutionCoordinator({ stateDir,
    modelRuntime: { chat: async () => { throw new Error('duplicate turn reached model'); } },
    capabilityBroker: { execute: async () => { brokerCalls++; throw new Error('duplicate turn reached Broker'); } } });
  await assert.rejects(restarted.run(writeTurn), error => error.code === 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(brokerCalls, 2, 'the persisted execution fences a duplicate after Core restart');
  await completed.run({ ...writeTurn, turnId: 'new-independent-intent' });
  assert.equal(brokerCalls, 3, 'a new user intent can perform the same parameters with a new turn identity');
  let releaseModel;
  let modelEntered;
  const modelStarted = new Promise(resolve => { modelEntered = resolve; });
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  const concurrent = createToolExecutionCoordinator({
    stateDir,
    modelRuntime: { chat: async () => {
      modelEntered();
      await modelGate;
      return { toolCalls: [{ id: 'concurrent-write', capabilityId: 'filesystem.write',
        arguments: { path: 'concurrent.md', content: 'once' } }] };
    } },
    capabilityBroker: { execute: async () => { brokerCalls++; return { status: 'completed', result: {} }; } },
    maxCycles: 1
  });
  const concurrentTurn = { ...writeTurn, sessionId: 'session-concurrent', turnId: 'turn-concurrent' };
  const firstRun = concurrent.run(concurrentTurn);
  await modelStarted;
  const duplicateRun = concurrent.run(concurrentTurn);
  releaseModel();
  await assert.rejects(duplicateRun, error => error.code === 'REQUEST_RECOVERY_REQUIRED');
  await firstRun;
  assert.equal(brokerCalls, 4, 'simultaneous duplicate turns cannot dispatch twice');
  const approvalStateDir = path.join(stateDir, 'approved-unknown');
  const approvalBroker = createCapabilityBroker({ stateDir: approvalStateDir,
    approval: createCapabilityApproval({ stateDir: approvalStateDir }) });
  let approvedCalls = 0;
  let approvedModelCalls = 0;
  approvalBroker.register({ id: 'fixture.effect', permission: 'extension.invoke', risk: 'high', effect: 'unknown',
    execute: () => { approvedCalls++; throw Object.assign(new Error('response lost'), { code: 'RPC_CLOSED' }); } });
  const approvalOptions = { stateDir: approvalStateDir, capabilityBroker: approvalBroker,
    modelRuntime: { chat: async () => { approvedModelCalls++; return { toolCalls: [
      { id: 'approved-effect', capabilityId: 'fixture.effect', arguments: {} } ] }; } } };
  const approvalCoordinator = createToolExecutionCoordinator(approvalOptions);
  const approvalTurn = { actor: { kind: 'owner', id: 'desktop' }, sessionId: 'approved-session', turnId: 'approved-turn',
    manifest: [{ id: 'fixture.effect', description: 'effect fixture', inputSchema: { type: 'object' } }] };
  const approvalPending = await approvalCoordinator.run(approvalTurn);
  const approvalRow = approvalBroker.approvals.get(approvalPending.approvalId);
  await assert.rejects(approvalBroker.decide({ id: approvalRow.id, approve: true, actor: approvalTurn.actor }),
    error => error.effectStatus === 'unknown');
  const unknownDecision = { approvalId: approvalRow.id, requestFingerprint: approvalRow.fingerprint,
    decisionResult: { status: 'outcome-unknown', error: { code: 'RPC_CLOSED' } } };
  const resumedUnknown = await approvalCoordinator.resumeApproval(unknownDecision);
  assert.equal(resumedUnknown.code, 'OUTCOME_UNKNOWN');
  assert.equal(approvedModelCalls, 1, 'unknown approved effects cannot resume inference');
  assert.equal(approvedCalls, 1);
  approvalCoordinator.cancelSession(approvalTurn.sessionId, 'owner-stop');
  assert.equal(approvalCoordinator.recoveryForSession(approvalTurn.sessionId)?.state, 'needs-reconciliation');
  const approvalRestart = createToolExecutionCoordinator(approvalOptions);
  assert.equal(approvalRestart.recoveryForSession(approvalTurn.sessionId)?.state, 'needs-reconciliation',
    'unknown approved effects survive continuation removal and Core restart');
  const persistenceTurn = { ...approvalTurn, sessionId: 'approval-persist-failure', turnId: 'approval-persist-turn' };
  const persistencePending = await approvalCoordinator.run(persistenceTurn);
  const persistenceRow = approvalBroker.approvals.get(persistencePending.approvalId);
  await assert.rejects(approvalBroker.decide({ id: persistenceRow.id, approve: true, actor: approvalTurn.actor }),
    error => error.effectStatus === 'unknown');
  const executionFile = path.join(approvalStateDir, 'model', 'tool-executions.json');
  const executionBackup = executionFile + '.before-fault';
  fs.renameSync(executionFile, executionBackup);
  fs.mkdirSync(executionFile); // Fault only the execution journal; continuations remain writable.
  try {
    await assert.rejects(async () => approvalCoordinator.recordApprovalOutcomeUnknown({
      approvalId: persistenceRow.id, requestFingerprint: persistenceRow.fingerprint,
      decisionResult: { status: 'outcome-unknown', error: { code: 'RPC_CLOSED' } }
    }), { code: 'TOOL_EXECUTION_PERSIST_FAILED' });
    approvalCoordinator.cancelSession(persistenceTurn.sessionId, 'owner-stop');
  } finally {
    fs.rmSync(executionFile, { recursive: true, force: true });
    fs.renameSync(executionBackup, executionFile);
  }
  const durableBroker = createCapabilityBroker({ stateDir: approvalStateDir,
    approval: createCapabilityApproval({ stateDir: approvalStateDir }) });
  const afterWriteFault = createToolExecutionCoordinator({ ...approvalOptions, capabilityBroker: durableBroker });
  assert.equal(afterWriteFault.recoveryForSession(persistenceTurn.sessionId)?.state, 'needs-reconciliation',
    'the durable Broker outcome restores recovery after a failed projection write and successful stop');
  const lateStateDir = path.join(stateDir, 'late-approved-completion');
  const lateBroker = createCapabilityBroker({ stateDir: lateStateDir, approval: createCapabilityApproval({ stateDir: lateStateDir }) });
  let finishEffect;
  let signalStarted;
  const effectStarted = new Promise(resolve => { signalStarted = resolve; });
  lateBroker.register({ id: 'fixture.late', permission: 'extension.invoke', risk: 'high', effect: 'unknown',
    execute: () => { signalStarted(); return new Promise(resolve => { finishEffect = resolve; }); } });
  const lateOptions = { stateDir: lateStateDir, capabilityBroker: lateBroker, modelRuntime: { chat: async () => ({
    toolCalls: [{ id: 'late-effect', capabilityId: 'fixture.late', arguments: {} }] }) } };
  const lateCoordinator = createToolExecutionCoordinator(lateOptions);
  const lateTurn = { ...approvalTurn, sessionId: 'late-session', turnId: 'late-turn',
    manifest: [{ id: 'fixture.late', description: 'late effect', inputSchema: { type: 'object' } }] };
  const latePending = await lateCoordinator.run(lateTurn);
  const lateRow = lateBroker.approvals.get(latePending.approvalId);
  const cancel = new AbortController();
  const lateDecision = lateBroker.decide({ id: lateRow.id, approve: true, actor: lateTurn.actor }, { signal: cancel.signal });
  await effectStarted;
  cancel.abort();
  await assert.rejects(lateDecision, { code: 'INVOKE_CANCEL_UNCONFIRMED' });
  lateCoordinator.cancelSession(lateTurn.sessionId, 'owner-stop');
  finishEffect({ performed: true });
  for (let tries = 0; tries < 20 && lateBroker.dispatchStatus(lateRow.request.requestId)?.status !== 'completed'; tries++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(lateBroker.dispatchStatus(lateRow.request.requestId)?.status, 'completed');
  const lateRestartBroker = createCapabilityBroker({ stateDir: lateStateDir, approval: createCapabilityApproval({ stateDir: lateStateDir }) });
  const lateRestart = createToolExecutionCoordinator({ ...lateOptions, capabilityBroker: lateRestartBroker });
  assert.equal(lateRestart.recoveryForSession(lateTurn.sessionId)?.state, 'needs-reconciliation',
    'a late completed effect with no consumed model result cannot disappear after stop/restart');
  const successStateDir = path.join(stateDir, 'consumed-approved-result');
  const successBroker = createCapabilityBroker({ stateDir: successStateDir,
    approval: createCapabilityApproval({ stateDir: successStateDir }) });
  successBroker.register({ id: 'fixture.success', permission: 'extension.invoke', risk: 'high', effect: 'unknown', execute: () => ({ done: true }) });
  let successModelCalls = 0;
  const successOptions = { stateDir: successStateDir, capabilityBroker: successBroker, modelRuntime: { chat: async () =>
    ++successModelCalls === 1 ? { toolCalls: [{ id: 'success', capabilityId: 'fixture.success', arguments: {} }] } : { text: 'Observed result' } } };
  const successCoordinator = createToolExecutionCoordinator(successOptions);
  const successTurn = { ...approvalTurn, sessionId: 'success-session', turnId: 'success-turn',
    manifest: [{ id: 'fixture.success', description: 'successful effect', inputSchema: { type: 'object' } }] };
  const successPending = await successCoordinator.run(successTurn);
  const successRow = successBroker.approvals.get(successPending.approvalId);
  const successResult = await successBroker.decide({ id: successRow.id, approve: true, actor: successTurn.actor });
  const resumedSuccess = await successCoordinator.resumeApproval({ approvalId: successRow.id,
    requestFingerprint: successRow.fingerprint, decisionResult: successResult });
  assert.equal(resumedSuccess.status, 'completed');
  const successRestart = createToolExecutionCoordinator(successOptions);
  assert.equal(successRestart.recoveryForSession(successTurn.sessionId), null,
    'a durably consumed successful approval result does not create false recovery work');
  console.log('tool outcome unknown: one dispatch, no automatic replay, review required');
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
