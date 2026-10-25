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
async function fixture(name) {
  const stateDir = path.join(root, name);
  const state = { clock: 1000, handoff: false, workspace: { id: 'workspace', root: root, name: 'Fixture' },
    task: { id: 'task', workspaceId: 'workspace', status: 'queued', rev: 1, authorizationRevision: 1, currentAgent: null },
    security: { mode: 'native-permissions', nativeSandboxSupported: false, strictIsolationVerified: false,
      nativeApprovalSupported: true, nativePermissionPolicyVerified: true, allToolsRequireApproval: true,
      nativeSandboxMode: 'none', nativeApprovalPolicy: 'all-tools-prompt', runtimeIdentity: 'fixture-v1' },
    sessionState: 'waiting', nativeRuns: 0 };
  const base = defineAgentProvider({ id: 'private-native-fixture', label: 'Private native fixture',
    capabilityExtras: { workspaceBoundary: 'native-staged' }, methods: {
      async createSession() { return { sessionId: 'session' }; },
      async status({ sessionId }) { return { provider: base.id, sessionId, taskId: 'task', workspaceId: 'workspace',
        state: state.sessionState, running: state.sessionState === 'waiting' || state.sessionState === 'running' }; }
    } });
  const provider = { ...base, capabilities: () => ({ ...base.capabilities(), security: state.security }) };
  const agentBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [provider] }),
    resolveWorkspaceIdentity: () => state.workspace?.root, resolveExecutionTask: id => state.task?.id === id ? state.task : null,
    isTaskHandoffInFlight: () => state.handoff });
  const scope = agentBroker.describeExecutionSecurity(provider.id, 'workspace');
  agentBroker.authorizeExecution(provider.id, 'workspace', scope.fingerprint);
  await agentBroker.createSession(provider.id, { taskId: 'task', workspaceId: 'workspace' });
  state.task = { ...state.task, status: 'running', currentAgent: { provider: provider.id, sessionId: 'session' } };
  const service = createCapabilityService({ stateDir, agentBroker, now: () => state.clock,
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
        workspaceId: input.workspaceId, taskId: input.taskId, toolCall: input.target, options: input.options });
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
