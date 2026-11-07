import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityService } from '../src/capability/service.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createAgentPermissionBridge, permissionFingerprint } from '../src/agent/protocol/agent-permission-bridge.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-native-approval-'));
const owner = { kind: 'owner', id: 'desktop' };
const tick = () => new Promise(resolve => setTimeout(resolve, 35));
const fixtures = [];
let requestNumber = 0;
async function fixture(name, { providerId = 'private-native-fixture', durable = true } = {}) {
  const stateDir = path.join(root, name);
  const state = { clock: 1000, handoff: false, workspace: { id: 'workspace', root: root, name: 'Fixture' },
    task: { id: 'task', workspaceId: 'workspace', status: 'queued', rev: 1, authorizationRevision: 1, currentAgent: null },
    security: { mode: 'native-permissions', nativeSandboxSupported: false, strictIsolationVerified: false,
      nativeApprovalSupported: true, nativePermissionPolicyVerified: true, allToolsRequireApproval: true,
      nativeSandboxMode: 'none', nativeApprovalPolicy: 'all-tools-prompt', runtimeIdentity: 'fixture-v1' },
    sessionState: 'waiting', nativeRuns: 0 };
  const base = defineAgentProvider({ id: providerId, label: 'Private native fixture',
    capabilityExtras: { workspaceBoundary: 'native-staged' }, methods: {
      async createSession() { return { sessionId: 'session' }; },
      async status({ sessionId }) {
        const status = { provider: base.id, sessionId, taskId: 'task', workspaceId: 'workspace',
          state: state.sessionState, running: state.sessionState === 'waiting' || state.sessionState === 'running' };
        await state.onStatus?.();
        return status;
      }
    } });
  const provider = { ...base, capabilities: () => ({ ...base.capabilities(), security: state.security }) };
  const agentBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [provider] }),
    resolveWorkspaceIdentity: () => state.workspace?.root, resolveExecutionTask: id => state.task?.id === id ? state.task : null,
    isTaskHandoffInFlight: () => state.handoff });
  const scope = agentBroker.describeExecutionSecurity(provider.id, 'workspace');
  agentBroker.authorizeExecution(provider.id, 'workspace', scope.fingerprint);
  await agentBroker.createSession(provider.id, { taskId: 'task', workspaceId: 'workspace' });
  state.task = { ...state.task, status: 'running', currentAgent: { provider: provider.id, sessionId: 'session' } };
  const service = createCapabilityService({ stateDir: durable ? stateDir : undefined, agentBroker, now: () => state.clock,
    taskRuntime: { get: ({ id }) => ({ task: state.task?.id === id ? state.task : null }) },
    workspaceService: { describeWorkspace: id => state.workspace?.id === id ? state.workspace : null } });
  service.setTaskHandoffGuard(() => state.handoff);
  const f = { state, service, provider, stateDir,
    input(extra = {}) {
      const input = { provider: provider.id, sessionId: 'session', taskId: 'task', workspaceId: 'workspace',
        requestId: 'native-request-' + ++requestNumber, action: 'execute',
        target: { toolCallId: 'tool-' + requestNumber, title: 'Read package.json', kind: 'execute',
          locations: [{ path: 'package.json' }], rawInput: { command: 'type package.json' } },
        options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }], ...extra };
      input.fingerprint = permissionFingerprint({ provider: input.provider, sessionId: input.sessionId,
        workspaceId: input.workspaceId, taskId: input.taskId, toolCall: input.target, options: input.options,
        ...(Object.hasOwn(input, 'runId') ? { runId: input.runId, phase: input.phase } : {}),
        ...(Object.hasOwn(input, 'trackEffect') ? { trackEffect: input.trackEffect } : {}),
        ...(Object.hasOwn(input, 'effectPolicy') ? { effectPolicy: input.effectPolicy } : {}) });
      return input;
    },
    request(input = this.input(), options) {
      return service.requestAgentNativeApproval(input, options).then(result => {
        if (result.outcome === 'approved') state.nativeRuns++;
        return result;
      });
    },
    pending() { return service.broker.approvals.list(); },
    decide(id, approve = true) { return service.execute({ method: 'capability.approval.decide', params: { id, approve } }); }
  };
  fixtures.push(f);
  return f;
}
try {
  const f = await fixture('owner-approval');
  assert.equal(typeof f.service.requestAgentNativeApproval, 'function', 'trusted composition needs a native approval entry point');
  const native = await import('../src/agent/native-approval-bridge.js');
  assert.equal(typeof native.createNativeApprovalAdapter, 'function');
  const awaiting = f.request();
  await tick();
  assert.equal(f.state.nativeRuns, 0, 'native permission has no effect before Owner decides');
  assert.equal(f.pending().length, 1);
  const row = f.pending()[0];
  assert.equal(row.request.capability, 'agent.native.approve');
  assert.equal(row.request.actor.kind, 'owner');
  assert.equal(row.request.approved, undefined);
  const catalog = f.service.broker.list().find(entry => entry.id === 'agent.native.approve');
  assert.equal(catalog.risk, 'high');
  assert.equal(catalog.modelCallable, false);
  assert.equal(catalog.requiresTask, true);
  assert.equal(catalog.workspace, true);
  await assert.rejects(() => f.service.broker.execute({ ...row.request, approved: true }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(() => f.service.broker.execute({ ...row.request, actor: { kind: 'agent', id: 'fixture',
    grants: { capabilities: ['agent.native.approve'], taskIds: ['task'], workspaceIds: ['workspace'] } }, approved: true }));
  assert.equal(f.state.nativeRuns, 0, 'forged approved fields cannot grant native permission');
  assert.equal((await f.decide(row.id)).status, 'completed');
  assert.deepEqual(await awaiting, { outcome: 'approved', optionId: 'allow' });
  assert.equal(f.state.nativeRuns, 1);
  assert.equal(f.service.broker.approvals.get(row.id).status, 'consumed');
  await assert.rejects(() => f.decide(row.id), { code: 'APPROVAL_ALREADY_DECIDED' });
  await assert.rejects(() => f.service.broker.execute({ ...row.request, approved: true }));

  const longCommand = await fixture('full-command-review');
  const suffix='; Remove-Item C:/example -Recurse';
  const longInput=longCommand.input({target:{toolCallId:'long-command',kind:'execute',title:'Long command',rawInput:{command:'echo '+ 'x'.repeat(900)+suffix,content:'file body must be reviewable'}}});
  const longPromise=longCommand.request(longInput);await tick();
  const longRow=longCommand.pending()[0];
  assert.ok(longRow.request.input.nativeDetails.includes(suffix),'executable command suffix cannot be silently truncated');
  assert.ok(longRow.request.input.nativeDetails.includes('file body must be reviewable'),'write content is part of the native operation review');
  await longCommand.decide(longRow.id,false);await longPromise;
  const tooLarge=await fixture('unreviewable-size');
  const tooLargeInput=tooLarge.input({target:{toolCallId:'too-large',kind:'execute',title:'Large operation',rawInput:{command:'x'.repeat(9000)}}});
  assert.deepEqual(await tooLarge.request(tooLargeInput),{outcome:'cancelled'},'unreviewable arguments must fail closed without pending approval');
  assert.equal(tooLarge.pending().length,0);
  const tooDeep=await fixture('unreviewable-depth');let deep={command:'hidden suffix'};for(let i=0;i<20;i++)deep={next:deep};
  assert.deepEqual(await tooDeep.request(tooDeep.input({target:{toolCallId:'too-deep',kind:'execute',title:'Deep operation',rawInput:deep}})),{outcome:'cancelled'});
  assert.equal(tooDeep.pending().length,0);
  const incomplete=await fixture('missing-native-input');
  for(const raw of [undefined,null,'summary only',[]]) {
    const target={toolCallId:'incomplete-'+requestNumber,kind:'execute',title:'Incomplete operation'};
    if(raw!==undefined)target.rawInput=raw;
    assert.deepEqual(await Promise.race([incomplete.request(incomplete.input({target})),tick().then(()=>null)]),{outcome:'cancelled'},'missing or non-object exact native input is never reviewable');
  }
  assert.equal(incomplete.pending().length,0);
  const reject = await fixture('reject');
  const rejected = reject.request(); await tick();
  await reject.decide(reject.pending()[0].id, false);
  assert.deepEqual(await rejected, { outcome: 'rejected' });
  assert.equal(reject.state.nativeRuns, 0);

  for (const [name, mutate] of [
    ['task-paused', f => { f.state.task.status = 'paused'; }],
    ['task-removed', f => { f.state.task = null; }],
    ['task-authorization', f => { f.state.task.authorizationRevision++; }],
    ['workspace-id', f => { f.state.task.workspaceId = 'other'; }],
    ['workspace-root', f => { f.state.workspace.root = path.join(root, 'other-root'); }],
    ['provider', f => { f.state.task.currentAgent.provider = 'other'; }],
    ['session', f => { f.state.task.currentAgent.sessionId = 'other'; }],
    ['security', f => { f.state.security = { ...f.state.security, runtimeIdentity: 'fixture-v2' }; }],
    ['handoff', f => { f.state.handoff = true; }],
    ['disconnected', f => { f.state.sessionState = 'unknown'; }]
  ]) {
    const changed = await fixture(name), promise = changed.request(); await tick();
    const pending = changed.pending()[0]; mutate(changed);
    await assert.rejects(() => changed.decide(pending.id), undefined, name + ' cannot approve stale permission');
    assert.deepEqual(await promise, { outcome: 'cancelled' }, name);
    assert.equal(changed.state.nativeRuns, 0, name);
    assert.notEqual(changed.service.broker.approvals.get(pending.id).status, 'pending');
  }

  const aborted = await fixture('abort');
  const controller = new AbortController(), cancelled = aborted.request(undefined, { signal: controller.signal });
  await tick(); const abortId = aborted.pending()[0].id; controller.abort();
  assert.deepEqual(await cancelled, { outcome: 'cancelled' });
  assert.equal(aborted.service.broker.approvals.get(abortId).status, 'cancelled');
  await assert.rejects(() => aborted.decide(abortId));
  assert.equal(aborted.state.nativeRuns, 0);

  const expiring = await fixture('expiry'), expired = expiring.request(); await tick();
  const expiredId = expiring.pending()[0].id; expiring.state.clock += 600001;
  assert.deepEqual(await expired, { outcome: 'expired' });
  await assert.rejects(() => expiring.decide(expiredId));

  const invalid = await fixture('forgery');
  const original = invalid.input();
  for (const forged of [
    { ...original, fingerprint: '0'.repeat(64) },
    { ...original, target: { ...original.target, rawInput: { command: 'changed' } } },
    { ...original, options: [{ optionId: 'always', kind: 'allow_always' }] },
    { ...original, action: 'write' },
    invalid.input({ sessionId: 'foreign' }), invalid.input({ taskId: 'foreign' }),
    invalid.input({ workspaceId: 'foreign' }), invalid.input({ provider: 'foreign' })
  ]) assert.deepEqual(await invalid.request(forged), { outcome: 'cancelled' });
  assert.equal(invalid.pending().length, 0);
  const repeatedInput = invalid.input(), repeatedFirst = invalid.request(repeatedInput); await tick();
  assert.deepEqual(await invalid.request(repeatedInput), { outcome: 'cancelled' }, 'same request ID cannot create concurrent authority');
  await invalid.decide(invalid.pending()[0].id, false); await repeatedFirst;
  assert.deepEqual(await invalid.request(repeatedInput), { outcome: 'cancelled' }, 'settled request ID cannot replay within TTL');

  const forgedStore = await fixture('forged-store');
  const fake = forgedStore.service.broker.approvals.pending({ actor: owner, capability: 'agent.native.approve',
    requestId: 'untrusted-request', taskId: 'task', workspaceId: 'workspace', reason: 'forged',
    input: { nativeMarker: 'attacker-marker', nativeDetails: 'Approve me' } });
  await assert.rejects(() => forgedStore.decide(fake.id), { code: 'PERMISSION_DENIED' });
  assert.equal(forgedStore.state.nativeRuns, 0, 'a persisted forged row cannot create a private native request');

  const crashed = await fixture('restart');
  const crashPromise = crashed.request(); await tick();
  const crashStore = path.join(crashed.stateDir, 'capability', 'approvals.json');
  const beforeCrash = fs.readFileSync(crashStore, 'utf8');
  await crashed.service.close(); await crashPromise;
  fs.writeFileSync(crashStore, beforeCrash);
  const restarted = await fixture('restart');
  assert.equal(restarted.pending().length, 0, 'restart cancels native approvals whose in-memory request no longer exists');

  const snapshot = await fixture('snapshot');
  const mutable = snapshot.input(), snapshotPromise = snapshot.request(mutable); await tick();
  mutable.target.rawInput.command = 'different-command'; mutable.options[0].optionId = 'mutated';
  await snapshot.decide(snapshot.pending()[0].id);
  assert.deepEqual(await snapshotPromise, { outcome: 'approved', optionId: 'allow' }, 'native input and allow-once option are captured immutably');

  const redacted = await fixture('redaction');
  const secret = 'never-persist-this-private-value';
  const secretInput = redacted.input({ target: { toolCallId: 'secret-call', kind: 'execute', title: 'Authorization: Bearer ' + secret,
    rawInput: { command: 'echo token=' + secret, apiKey: secret, env: { PRIVATE_VALUE: secret },
      nested: { password: secret }, url: 'https://user:' + secret + '@example.test/run?token=' + secret },
    content: [{ type: 'text', text: secret }], locations: [{ path: 'package.json' }] } });
  const redactionPromise = redacted.request(secretInput); await tick();
  const secretRow = redacted.pending()[0];
  const persisted = fs.readFileSync(path.join(redacted.stateDir, 'capability', 'approvals.json'), 'utf8');
  assert.ok(!persisted.includes(secret), 'pending UI and approval store must not contain native secrets');
  assert.ok(!JSON.stringify(secretRow).includes(secret));
  assert.ok(secretRow.request.input.nativeDetails.length <= 8192);
  assert.ok(secretRow.request.reason.length <= 1000);
  assert.match(secretRow.request.input.nativeDetails, /package\.json/);
  await redacted.decide(secretRow.id, false); await redactionPromise;

  const runBound = await fixture('run-bound');
  runBound.state.task.executionObservation = { provider: runBound.provider.id, sessionId: 'session', runId: 'current-run', phase: 'user', state: 'running' };
  const runPromise = runBound.request(runBound.input({ runId: 'current-run', phase: 'user' }));
  await tick();
  assert.equal(runBound.pending().length, 1, 'a matching Core run reaches the existing Owner approval');
  await runBound.decide(runBound.pending()[0].id);
  assert.equal((await runPromise).outcome, 'approved');

  for (const duringStatus of [false, true]) {
    const changedRun = await fixture('run-changed-' + duringStatus);
    changedRun.state.task.executionObservation = { provider: changedRun.provider.id, sessionId: 'session', runId: 'original-run', phase: 'user', state: 'running' };
    const promise = changedRun.request(changedRun.input({ runId: 'original-run', phase: 'user' }));
    await tick();
    assert.equal(changedRun.pending().length, 1);
    if (duringStatus) changedRun.state.onStatus = () => { changedRun.state.task.executionObservation.runId = 'later-run'; };
    else changedRun.state.task.executionObservation.runId = 'later-run';
    await assert.rejects(() => changedRun.decide(changedRun.pending()[0].id));
    assert.equal((await promise).outcome, 'cancelled', 'a replaced run cannot consume its predecessor native approval');
    assert.equal(changedRun.state.nativeRuns, 0);
  }

  const trustedRun = await fixture('bridge-trusted-run');
  trustedRun.state.task.executionObservation = { provider: trustedRun.provider.id, sessionId: 'session', runId: 'bridge-run', phase: 'user', state: 'running' };
  const runBridge = createAgentPermissionBridge({ provider: trustedRun.provider.id, sessionId: 'session', nativeSessionId: 'native',
    taskId: 'task', workspaceId: 'workspace', runId: 'bridge-run', phase: 'user', requestNativeApproval: trustedRun.service.requestAgentNativeApproval });
  const runParams = { sessionId: 'native', toolCall: { toolCallId: 'bridge-call', kind: 'read', title: 'Read', rawInput: { path: 'package.json' } },
    options: [{ optionId: 'allow', kind: 'allow_once' }] };
  assert.deepEqual(await runBridge.request({ ...runParams, runId: 'peer-injected-run' }), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(await runBridge.request({...runParams, effectPolicy: 'dsh-staging-read-v1'}), {outcome: {outcome: 'cancelled'}},
    'protocol peers cannot attach the trusted effect classification');
  const bridgePromise = runBridge.request(runParams);
  await tick();
  assert.equal(trustedRun.pending().length, 1, 'trusted bridge configuration owns the Core run binding');
  await trustedRun.decide(trustedRun.pending()[0].id);
  assert.deepEqual(await bridgePromise, { outcome: { outcome: 'selected', optionId: 'allow' } });
  runBridge.close();

  for (const state of ['awaiting-review', 'unknown', 'cancelled']) {
    const inactiveRun = await fixture('inactive-run-' + state);
    inactiveRun.state.task.executionObservation = { provider: inactiveRun.provider.id, sessionId: 'session', runId: 'ended-run', state };
    assert.deepEqual(await Promise.race([inactiveRun.request(inactiveRun.input({ runId: 'ended-run', phase: 'user' })), tick().then(() => null)]),
      { outcome: 'cancelled' }, 'a settled, unknown or cancelled Core run cannot request more native execution');
  }

  async function trackedFixture(name, { target, effectPolicy } = {}) {
    const tracked = await fixture(name, { providerId: 'dsh' });
    tracked.state.task.executionObservation = { provider: 'dsh', sessionId: 'session', runId: 'dsh-run', state: 'running' };
    const input = tracked.input({ runId: 'dsh-run', phase: 'user', trackEffect: true, ...(effectPolicy ? {effectPolicy} : {}), action: target?.kind ?? 'execute',
      target: target ?? { toolCallId: 'native-call', title: 'Native command', kind: 'execute',
        rawInput: { command: 'echo reviewable-command', secret: 'never-persist-effect-secret' } } });
    return { tracked, input };
  }
  async function approveTracked(name, options) {
    const { tracked, input } = await trackedFixture(name, options);
    const promise = tracked.request(input); await tick();
    assert.equal(tracked.pending().length, 1, 'a tracked DSH call reaches the same once-only Owner approval');
    assert.equal(tracked.state.nativeRuns, 0);
    assert.equal(tracked.service.broker.uncertainDispatchesForTask({ taskId: 'task', workspaceId: 'workspace' }).length, 0);
    await tracked.decide(tracked.pending()[0].id);
    const grant = await promise;
    assert.equal(grant.outcome, 'approved');
    assert.match(grant.nativeEffectId, /^[a-f0-9-]{36}$/);
    assert.equal(grant.inputFingerprint, permissionFingerprint(input.target.rawInput));
    const binding = { nativeEffectId: grant.nativeEffectId, provider: 'dsh', sessionId: 'session', taskId: 'task',
      workspaceId: 'workspace', runId: 'dsh-run', toolCallId: 'native-call', inputFingerprint: grant.inputFingerprint };
    return { tracked, input, grant, binding };
  }
  const invalidPolicy = await trackedFixture('tracked-unsupported-policy', {effectPolicy: 'peer-says-read-only'});
  assert.deepEqual(await invalidPolicy.tracked.request(invalidPolicy.input), {outcome: 'cancelled'});
  assert.equal(invalidPolicy.tracked.pending().length, 0, 'an unknown effect policy cannot reach Owner approval');
  const untrackedPolicy = await trackedFixture('tracked-policy-without-tracking', {effectPolicy: 'dsh-staging-read-v1'});
  assert.deepEqual(await untrackedPolicy.tracked.request(untrackedPolicy.tracked.input({...untrackedPolicy.input, trackEffect: false})), {outcome: 'cancelled'});
  assert.equal(untrackedPolicy.tracked.pending().length, 0);
  const tracked = await approveTracked('tracked-effect');
  assert.equal(tracked.tracked.service.completionBlocker('task'), 'TASK_EFFECT_UNCONFIRMED', 'permit release cannot certify native tool completion');
  const effectFile = path.join(tracked.tracked.stateDir, 'capability', 'dispatches.json');
  const persistedEffects = fs.readFileSync(effectFile, 'utf8');
  assert.ok(!persistedEffects.includes('echo reviewable-command') && !persistedEffects.includes('never-persist-effect-secret'), 'effect journal keeps digests, not executable input or secrets');
  const started = tracked.tracked.service.broker.uncertainDispatchesForTask({ taskId: 'task', workspaceId: 'workspace' });
  assert.equal(started.length, 1); assert.equal(started[0].status, 'started');
  assert.deepEqual(await tracked.tracked.request(tracked.tracked.input({ ...tracked.input, requestId: 'different-request-id' })), { outcome: 'cancelled' }, 'a native call cannot obtain another permit by changing requestId');
  assert.equal(tracked.tracked.pending().length, 0);
  for (const key of ['provider', 'sessionId', 'taskId', 'workspaceId', 'runId', 'toolCallId', 'inputFingerprint']) {
    assert.throws(() => tracked.tracked.service.settleAgentNativeEffect({ ...tracked.binding, [key]: 'foreign', outcome: 'completed',
      evidence: { source: 'native-result', resultSha256: 'a'.repeat(64), eventId: 'result-1' } }), { code: 'AGENT_NATIVE_EFFECT_MISMATCH' }, key);
  }
  for (const evidence of [undefined, { source: 'activity-completed', resultSha256: 'a'.repeat(64), eventId: 'result-1' },
    { source: 'native-result', resultSha256: 'invalid', eventId: 'result-1' }]) {
    assert.throws(() => tracked.tracked.service.settleAgentNativeEffect({ ...tracked.binding, outcome: 'completed', evidence }),
      { code: 'AGENT_NATIVE_EFFECT_EVIDENCE_REQUIRED' }, 'activity, permission or missing output never proves completion');
  }
  const actualResult = { ...tracked.binding, outcome: 'completed', evidence: { source: 'native-result', resultSha256: 'a'.repeat(64), eventId: 'result-1' } };
  assert.equal(tracked.tracked.service.settleAgentNativeEffect(actualResult).status, 'completed');
  assert.equal(tracked.tracked.service.completionBlocker('task'), null);
  assert.equal(tracked.tracked.service.settleAgentNativeEffect(actualResult).status, 'completed', 'same actual result replay is an observation only');
  assert.throws(() => tracked.tracked.service.settleAgentNativeEffect({ ...actualResult, evidence: { ...actualResult.evidence, resultSha256: 'b'.repeat(64) } }),
    { code: 'AGENT_NATIVE_EFFECT_ALREADY_SETTLED' });
  assert.deepEqual(await tracked.tracked.request(tracked.tracked.input({ ...tracked.input, requestId: 'after-completed-request' })), { outcome: 'cancelled' });

  for (const outcome of ['unknown', 'cancelled', 'disconnected']) {
    const lost = await approveTracked('tracked-' + outcome);
    assert.equal(lost.tracked.service.settleAgentNativeEffect({ ...lost.binding, outcome }).status, 'outcome-unknown');
    assert.equal(lost.tracked.service.completionBlocker('task'), 'TASK_EFFECT_UNCONFIRMED');
    assert.deepEqual(await lost.tracked.request(lost.tracked.input({ ...lost.input, requestId: 'retry-' + outcome })), { outcome: 'cancelled' });
  }
  const failedEffect = await approveTracked('tracked-failed', { target: { toolCallId: 'native-call', title: 'Edit a file', kind: 'edit', rawInput: { path: 'partial.txt', content: 'partial write' } } });
  assert.equal(failedEffect.tracked.service.settleAgentNativeEffect({ ...failedEffect.binding, outcome: 'failed',
    evidence: { source: 'native-result', resultSha256: 'f'.repeat(64), eventId: 'failed-result' } }).status, 'outcome-unknown');
  assert.equal(failedEffect.tracked.service.completionBlocker('task'), 'TASK_EFFECT_UNCONFIRMED', 'failed native writes can leave partial effects and require reconciliation');
  const failedJournal = JSON.parse(fs.readFileSync(path.join(failedEffect.tracked.stateDir, 'capability', 'dispatches.json'), 'utf8'));
  assert.equal(Object.values(failedJournal).find(row => row.nativeEffectId === failedEffect.grant.nativeEffectId).nativeEvidence.outcome, 'failed');
  assert.throws(() => failedEffect.tracked.service.settleAgentNativeEffect({ ...failedEffect.binding, outcome: 'completed',
    evidence: { source: 'native-result', resultSha256: 'e'.repeat(64), eventId: 'contradictory-success' } }), { code: 'AGENT_NATIVE_EFFECT_ALREADY_SETTLED' });

  const readTarget = {toolCallId: 'native-call', title: 'read', kind: 'read', rawInput: {file_path: 'missing.txt'}};
  const failedRead = await approveTracked('tracked-read-failed', {target: readTarget, effectPolicy: 'dsh-staging-read-v1'});
  const failedReadResult = {...failedRead.binding, outcome: 'failed',
    evidence: {source: 'native-result', resultSha256: '1'.repeat(64), eventId: 'read-failed-result'}};
  assert.equal(failedRead.tracked.service.settleAgentNativeEffect(failedReadResult).status, 'failed', 'a verified read terminal error has no unconfirmed file write');
  assert.equal(failedRead.tracked.service.completionBlocker('task'), null);
  assert.equal(failedRead.tracked.service.settleAgentNativeEffect(failedReadResult).status, 'failed');
  assert.deepEqual(await failedRead.tracked.request(failedRead.tracked.input({...failedRead.input, requestId: 'repeat-failed-read'})),
    {outcome: 'cancelled'}, 'known failure does not grant replay of the original call');
  assert.throws(() => failedRead.tracked.service.settleAgentNativeEffect({...failedReadResult, outcome: 'completed'}),
    {code: 'AGENT_NATIVE_EFFECT_ALREADY_SETTLED'});
  const lostRead = await approveTracked('tracked-read-lost', {target: readTarget, effectPolicy: 'dsh-staging-read-v1'});
  assert.equal(lostRead.tracked.service.settleAgentNativeEffect({...lostRead.binding, outcome: 'disconnected'}).status, 'outcome-unknown',
    'a missing read result remains unknown even for the verified policy');
  const unclassifiedRead = await approveTracked('tracked-read-unclassified', {target: readTarget});
  assert.equal(unclassifiedRead.tracked.service.settleAgentNativeEffect({...unclassifiedRead.binding, effectPolicy: 'dsh-staging-read-v1', outcome: 'failed',
    evidence: {source: 'native-result', resultSha256: '2'.repeat(64), eventId: 'legacy-read-failed'}}).status, 'outcome-unknown',
    'a settlement label or read-looking title cannot replace the original approved effect policy');

  const effectCrash = await approveTracked('tracked-restart');
  const crashEffectFile = path.join(effectCrash.tracked.stateDir, 'capability', 'dispatches.json');
  const startedJournal = fs.readFileSync(crashEffectFile, 'utf8');
  await effectCrash.tracked.service.close();
  fs.writeFileSync(crashEffectFile, startedJournal);
  const afterEffectRestart = await trackedFixture('tracked-restart');
  const recoveredEffects = afterEffectRestart.tracked.service.broker.uncertainDispatchesForTask({ taskId: 'task', workspaceId: 'workspace' });
  assert.equal(recoveredEffects.length, 1); assert.equal(recoveredEffects[0].status, 'outcome-unknown');
  assert.deepEqual(await afterEffectRestart.tracked.request(afterEffectRestart.input), { outcome: 'cancelled' }, 'restart cannot reauthorize an already released native call');
  assert.equal(afterEffectRestart.tracked.service.completionBlocker('task'), 'TASK_EFFECT_UNCONFIRMED');
  assert.equal(afterEffectRestart.tracked.service.settleAgentNativeEffect({ ...effectCrash.binding, outcome: 'completed',
    evidence: { source: 'native-result', resultSha256: 'e'.repeat(64), eventId: 'late-exact-result' } }).status, 'completed',
  'an exact actual terminal result can settle the retained original effect after Core restart without replay');
  assert.equal(afterEffectRestart.tracked.service.completionBlocker('task'), null);

  const trackDenied = await fixture('tracked-other-provider');
  trackDenied.state.task.executionObservation = { provider: trackDenied.provider.id, sessionId: 'session', runId: 'run', state: 'running' };
  assert.deepEqual(await trackDenied.request(trackDenied.input({ runId: 'run', phase: 'user', trackEffect: true })), { outcome: 'cancelled' }, 'effect tracking is initially confined to the verified DSH adapter');

  const volatile = await fixture('tracked-without-durable-journal', { providerId: 'dsh', durable: false });
  volatile.state.task.executionObservation = { provider: 'dsh', sessionId: 'session', runId: 'volatile-run', state: 'running' };
  const volatilePromise = volatile.request(volatile.input({ runId: 'volatile-run', phase: 'user', trackEffect: true }));
  await tick();
  await assert.rejects(() => volatile.decide(volatile.pending()[0].id), { code: 'AGENT_NATIVE_EFFECT_PERSISTENCE_REQUIRED' });
  assert.equal((await volatilePromise).outcome, 'cancelled');
  assert.equal(volatile.state.nativeRuns, 0, 'no durable effect journal means no native permit');

  const closingEffect = await approveTracked('tracked-close');
  await closingEffect.tracked.service.close();
  assert.equal(closingEffect.tracked.service.broker.uncertainDispatchesForTask({ taskId: 'task', workspaceId: 'workspace' })[0].status, 'outcome-unknown');
  assert.equal(closingEffect.tracked.service.broker.hasActiveDispatchForTask({ taskId: 'task', workspaceId: 'workspace' }), false);

  const unconsumed = await trackedFixture('tracked-unconsumed-approval');
  const unconsumedPromise = unconsumed.tracked.request(unconsumed.input); await tick();
  const unconsumedRow = unconsumed.tracked.pending()[0];
  assert.throws(() => unconsumed.tracked.service.broker.beginAgentNativeEffect({ ...unconsumedRow.request, approvalId: unconsumedRow.id },
    unconsumedRow.request.input.nativeBinding), { code: 'PERMISSION_DENIED' }, 'pending approval rows cannot manufacture an external effect permit');
  await unconsumed.tracked.decide(unconsumedRow.id, false); await unconsumedPromise;
  assert.equal(unconsumed.tracked.service.broker.uncertainDispatchesForTask({ taskId: 'task', workspaceId: 'workspace' }).length, 0);

  const writeFailure = await trackedFixture('tracked-intent-write-failure');
  const writeFailurePromise = writeFailure.tracked.request(writeFailure.input); await tick();
  const blockedIntent = path.join(writeFailure.tracked.stateDir, 'capability', 'dispatches.json');
  fs.mkdirSync(blockedIntent);
  await assert.rejects(() => writeFailure.tracked.decide(writeFailure.tracked.pending()[0].id));
  assert.equal((await writeFailurePromise).outcome, 'cancelled');
  assert.equal(writeFailure.tracked.state.nativeRuns, 0, 'failure to persist native effect ownership cannot release permission');
  fs.rmdirSync(blockedIntent);

  const resultWriteFailure = await approveTracked('tracked-result-write-failure');
  const blockedResult = path.join(resultWriteFailure.tracked.stateDir, 'capability', 'dispatches.json');
  fs.renameSync(blockedResult, blockedResult + '.retained'); fs.mkdirSync(blockedResult);
  const writtenResult = { ...resultWriteFailure.binding, outcome: 'completed', evidence: { source: 'native-result', resultSha256: 'c'.repeat(64), eventId: 'actual-result' } };
  assert.throws(() => resultWriteFailure.tracked.service.settleAgentNativeEffect(writtenResult), { code: 'DISPATCH_RESULT_PERSIST_FAILED', effectStatus: 'unknown' });
  assert.equal(resultWriteFailure.tracked.service.completionBlocker('task'), 'TASK_EFFECT_UNCONFIRMED');
  fs.rmdirSync(blockedResult); fs.renameSync(blockedResult + '.retained', blockedResult);
  assert.equal(resultWriteFailure.tracked.service.settleAgentNativeEffect(writtenResult).status, 'completed', 'the same actual result can settle after storage is repaired without re-executing the tool');

  const selectedReceipt = await trackedFixture('tracked-bridge-receipt');
  const effectBridge = createAgentPermissionBridge({ provider: 'dsh', sessionId: 'session', nativeSessionId: 'native', taskId: 'task', workspaceId: 'workspace',
    runId: 'dsh-run', phase: 'user', trackEffect: true, requestNativeApproval: selectedReceipt.tracked.service.requestAgentNativeApproval });
  const selectedPromise = effectBridge.request({ sessionId: 'native', toolCall: selectedReceipt.input.target, options: selectedReceipt.input.options });
  await tick(); await selectedReceipt.tracked.decide(selectedReceipt.tracked.pending()[0].id);
  const selected = await selectedPromise;
  assert.deepEqual(selected.outcome, { outcome: 'selected', optionId: 'allow' });
  assert.match(selected.nativeEffectId, /^[a-f0-9-]{36}$/);
  assert.equal(selected.inputFingerprint, permissionFingerprint(selectedReceipt.input.target.rawInput));
  assert.equal(selectedReceipt.tracked.service.settleAgentNativeEffect({ nativeEffectId: selected.nativeEffectId, provider: 'dsh', sessionId: 'session', taskId: 'task',
    workspaceId: 'workspace', runId: 'dsh-run', toolCallId: 'native-call', inputFingerprint: selected.inputFingerprint, outcome: 'completed',
    evidence: { source: 'native-result', resultSha256: 'd'.repeat(64), eventId: 'bridge-result' } }).status, 'completed');
  effectBridge.close();

  const capacity = await fixture('capacity');
  const capacityRequests = Array.from({ length: 128 }, () => capacity.request()); await tick();
  assert.equal(capacity.pending().length, 128);
  assert.deepEqual(await capacity.request(), { outcome: 'cancelled' });
  await capacity.service.close();
  assert.ok((await Promise.all(capacityRequests)).every(result => result.outcome === 'cancelled'));
  assert.equal(capacity.pending().length, 0, 'shutdown revokes only its owned pending native approvals');

  for (const method of ['invalidate', 'cancel', 'close']) {
    const delegated = await fixture('bridge-' + method);
    let callbackSignal;
    const bridge = createAgentPermissionBridge({ provider: delegated.provider.id, sessionId: 'session', nativeSessionId: 'native',
      taskId: 'task', workspaceId: 'workspace', requestNativeApproval: (input, options) => {
        callbackSignal = options?.signal; return delegated.service.requestAgentNativeApproval(input, options);
      } });
    const bridged = bridge.request({ sessionId: 'native', toolCall: { toolCallId: 'call', kind: 'read', title: 'Read package.json', rawInput:{file_path:'package.json'} },
      options: [{ optionId: 'allow', kind: 'allow_once' }] });
    await tick(); assert.ok(callbackSignal instanceof AbortSignal);
    const bridgeId = delegated.pending()[0].id;
    bridge[method](method === 'invalidate' ? 'call' : undefined);
    assert.deepEqual(await bridged, { outcome: { outcome: 'cancelled' } });
    assert.equal(callbackSignal.aborted, true);
    await tick(); assert.equal(delegated.service.broker.approvals.get(bridgeId).status, 'cancelled');
    await assert.rejects(() => delegated.decide(bridgeId));
    bridge.close();
  }
  console.log('PASS native approval: Owner once, reject, cancellation, expiry, immutable bindings, handoff, capacity and redaction');
} finally {
  await Promise.allSettled(fixtures.map(f => f.service.close()));
  fs.rmSync(root, { recursive: true, force: true });
}
