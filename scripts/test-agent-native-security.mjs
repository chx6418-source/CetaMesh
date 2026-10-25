import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodexExecArgs, createCodexAgentProvider, parseWindowsNativeSandboxPolicy } from '../src/agent/codex-agent-provider.js';
import { createDefaultAgentService } from '../src/agent/service.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import * as executionSecurity from '../src/agent/execution-security.js';

assert.equal(parseWindowsNativeSandboxPolicy('opaqueWindows = true\n[windows]\nsandbox = "unelevated"'), 'unelevated',
  'unrelated keys containing Windows must not be mistaken for a security policy');
assert.equal(parseWindowsNativeSandboxPolicy('[model_providers.WindowsProxy]\nname = "fixture"\n[windows]\nsandbox = "elevated"'), 'elevated',
  'unrelated table names must not shadow the selected native sandbox');
assert.equal(parseWindowsNativeSandboxPolicy('[windows]\nopaqueSandbox = true\nsandbox = "unelevated"'), 'unelevated');

const args = buildCodexExecArgs({ stageRoot: os.tmpdir() });
assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write', 'Native must use an inspected official sandbox');
assert.ok(!args.some(arg => arg.includes('":root"="deny"')), 'Native must not impose incompatible read-isolation rules');
assert.ok(!args.some(arg => /danger-full-access|bypass-approvals/.test(arg)));
assert.ok(args.includes('--ignore-user-config'), 'untrusted hooks/MCP/security config must not be silently inherited');
assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never', 'noninteractive native escalation requests are denied');
assert.throws(() => buildCodexExecArgs({ stageRoot: os.tmpdir(), securityMode: 'unsafe' }), e => e.code === 'INVALID_PARAMS');

let revision = 'fixture-policy-v1'; let runs = 0;
const descriptor = () => ({ mode: 'native', nativeSandboxSupported: true, nativeSandboxMode: 'fixture-limited',
  nativeApprovalSupported: false, nativeApprovalPolicy: 'deny-escalation', executionBoundary: 'agent-native',
  workspaceAccess: 'native-policy', directFilesystemAccess: true, platformToolPermissions: 'capability-broker',
  strictIsolationVerified: false, requiresConfirmation: true, identity: revision,
  securityLimitations: ['Native commands may read files outside this Workspace; Core cannot intercept OS operations.'] });
const base = defineAgentProvider({ id: 'test-vendor-native', label: 'Different native policy test adapter',
  capabilityExtras: { workspaceBoundary: 'native-staged', security: descriptor() },
  methods: { async health() { return { available: true, installed: true, authenticated: true, sessionCapable: true }; },
    async createSession() { runs++; return { sessionId: 'vendor-session' }; }, async send() { return { accepted: true }; } } });
const adapter = { ...base, capabilities: () => ({ ...base.capabilities(), security: descriptor() }) };
const broker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [adapter] }) });
await assert.rejects(() => broker.createSession(adapter.id, { taskId: 't', workspaceId: 'w' }),
  e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
assert.equal(runs, 0, 'no native Session before Owner confirmation');
const description = broker.describeExecutionSecurity(adapter.id, 'w');
assert.match(description.disclosure, /Core cannot intercept/);
assert.equal(description.authorized, false);
broker.authorizeExecution(adapter.id, 'w', description.fingerprint);
const session = await broker.createSession(adapter.id, { taskId: 't', workspaceId: 'w' });
await broker.send({ provider: adapter.id, sessionId: session.sessionId, content: 'fixture' });
await assert.rejects(() => broker.createSession(adapter.id, { taskId: 'other', workspaceId: 'other-workspace' }),
  e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
revision = 'fixture-policy-v2';
await assert.rejects(() => broker.send({ provider: adapter.id, sessionId: session.sessionId, content: 'stale policy' }),
  e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
assert.throws(() => broker.authorizeExecution(adapter.id, 'w', description.fingerprint), e => e.code === 'AGENT_SECURITY_POLICY_CHANGED');

let handoffInFlight = false;
let liveTask = { id: 'guard-task', workspaceId: 'guard-workspace', status: 'queued', currentAgent: null };
const guarded = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [adapter] }), resolveExecutionTask: () => liveTask, isTaskHandoffInFlight: () => handoffInFlight });
const guardedScope = guarded.describeExecutionSecurity(adapter.id, liveTask.workspaceId);
guarded.authorizeExecution(adapter.id, liveTask.workspaceId, guardedScope.fingerprint);
const guardedSession = await guarded.createSession(adapter.id, { taskId: liveTask.id, workspaceId: liveTask.workspaceId });
liveTask = { ...liveTask, status: 'running', currentAgent: { provider: adapter.id, sessionId: guardedSession.sessionId } };
await guarded.send({ provider: adapter.id, sessionId: guardedSession.sessionId, content: 'authorized' });
handoffInFlight = true;
await assert.rejects(() => guarded.send({ provider: adapter.id, sessionId: guardedSession.sessionId, content: 'handoff race' }), e => e.code === 'TASK_HANDOFF_IN_PROGRESS');
handoffInFlight = false;
for (const state of ['paused', 'blocked', 'cancelled']) {
  liveTask.status = state;
  await assert.rejects(() => guarded.send({ provider: adapter.id, sessionId: guardedSession.sessionId, content: 'forbidden' }), e => e.code === 'TASK_NOT_AUTHORIZED');
}

// The permission mode must be independently selected and must never claim OS isolation.
const nativePermissionDescriptor = () => ({ mode: 'native-permissions', nativeSandboxSupported: false,
  strictIsolationVerified: false, nativeApprovalSupported: true, nativePermissionPolicyVerified: true,
  allToolsRequireApproval: true, nativeSandboxMode: 'none', nativeApprovalPolicy: 'all-tools-prompt',
  runtimeIdentity: { executable: 'fixture-code-runtime', version: '1', sha256: 'fixture-v1' },
  hooksPolicy: 'deny-unapproved', mcpPolicy: 'deny-unapproved' });
let permissionSecurity = nativePermissionDescriptor(); let permissionStarts = 0; let permissionSends = 0;
const permissionBase = defineAgentProvider({ id: 'test-native-permissions', label: 'Native permission test adapter',
  capabilityExtras: { workspaceBoundary: 'native-staged', security: permissionSecurity }, methods: {
    async createSession() { return { sessionId: 'permission-session-' + ++permissionStarts }; },
    async send() { permissionSends++; return { accepted: true }; }
  } });
const permissionAdapter = { ...permissionBase, capabilities: () => ({ ...permissionBase.capabilities(), security: permissionSecurity }) };
let permissionTask = { id: 'permission-task', workspaceId: 'permission-workspace', status: 'queued', currentAgent: null };
let permissionHandoff = false; let permissionWorkspaceIdentity = 'fixture-workspace-root-v1';
const permissionBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [permissionAdapter] }),
  resolveExecutionTask: taskId => permissionTask?.id === taskId ? permissionTask : null, isTaskHandoffInFlight: () => permissionHandoff,
  resolveWorkspaceIdentity: () => permissionWorkspaceIdentity });
let permissionScope;
assert.doesNotThrow(() => { permissionScope = permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId); },
  'an explicitly selected native-permissions policy must be reviewable before Owner approval');
assert.equal(permissionScope.required, true); assert.equal(permissionScope.authorized, false);
assert.equal(permissionScope.security.nativeSandboxSupported, false);
assert.match(permissionScope.disclosure, /原生逐次审批/);
assert.match(permissionScope.disclosure, /不提供 OS 级沙箱/);
assert.match(permissionScope.disclosure, /原生工具.*逐次审批/);
assert.match(permissionScope.disclosure, /成果导入.*平台审批/);
assert.match(permissionScope.disclosure, /编码运行时.*认证/);
assert.equal(typeof executionSecurity.isNativePermissionSecurity, 'function');
assert.equal(executionSecurity.isNativePermissionSecurity(permissionSecurity), true);
assert.equal(executionSecurity.isNativePermissionSecurity(null), false);
assert.equal(executionSecurity.isNativePermissionSecurity({ ...permissionSecurity, mode: 'native' }), false);
await assert.rejects(() => permissionBroker.createSession(permissionAdapter.id, { taskId: permissionTask.id, workspaceId: permissionTask.workspaceId }),
  e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
assert.throws(() => permissionBroker.assertExecutionConsent(permissionAdapter.id, { workspaceId: permissionTask.workspaceId }),
  e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
assert.equal(permissionStarts, 0, 'verified native permission policy still cannot run before Owner confirmation');
assert.throws(() => permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, 'stale'),
  e => e.code === 'AGENT_SECURITY_POLICY_CHANGED');
permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, permissionScope.fingerprint);
await assert.rejects(() => permissionBroker.createSession(permissionAdapter.id, { workspaceId: permissionTask.workspaceId }), e => e.code === 'TASK_REQUIRED');
await assert.rejects(() => permissionBroker.createSession(permissionAdapter.id, { taskId: permissionTask.id, workspaceId: 'another-workspace' }),
  e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
const permissionSession = await permissionBroker.createSession(permissionAdapter.id, { taskId: permissionTask.id, workspaceId: permissionTask.workspaceId });
permissionTask = { ...permissionTask, status: 'running', currentAgent: { provider: permissionAdapter.id, sessionId: permissionSession.sessionId } };
const permissionSend = () => permissionBroker.send({ provider: permissionAdapter.id, sessionId: permissionSession.sessionId, content: 'fixture' });
await permissionSend();
assert.equal(permissionSends, 1);
await assert.rejects(() => permissionBroker.send({ provider: permissionAdapter.id, sessionId: 'unbound-session', content: 'fixture' }),
  e => e.code === 'AGENT_SECURITY_SESSION_UNBOUND');
const executablePermissionTask = structuredClone(permissionTask);
for (const changedTask of [null, { ...executablePermissionTask, id: 'another-task' },
  { ...executablePermissionTask, workspaceId: 'another-workspace' },
  { ...executablePermissionTask, currentAgent: { provider: 'other-provider', sessionId: permissionSession.sessionId } },
  { ...executablePermissionTask, currentAgent: { provider: permissionAdapter.id, sessionId: 'other-session' } },
  ...['paused', 'blocked', 'completed', 'failed', 'cancelled'].map(status => ({ ...executablePermissionTask, status }))]) {
  permissionTask = changedTask;
  await assert.rejects(permissionSend, e => e.code === 'TASK_NOT_AUTHORIZED');
}
permissionTask = executablePermissionTask;
permissionHandoff = true;
await assert.rejects(permissionSend, e => e.code === 'TASK_HANDOFF_IN_PROGRESS');
permissionHandoff = false;
assert.equal(permissionSends, 1, 'Task/Session/Workspace fences block execution before the adapter is called');
for (const change of [{ runtimeIdentity: { ...permissionSecurity.runtimeIdentity, executable: 'other-runtime' } },
  { runtimeIdentity: { ...permissionSecurity.runtimeIdentity, version: '2' } },
  { runtimeIdentity: { ...permissionSecurity.runtimeIdentity, sha256: 'fixture-v2' } },
  { nativeApprovalPolicy: 'another-approval-policy' }, { hooksPolicy: 'changed-hooks-policy' }, { mcpPolicy: 'changed-mcp-policy' }]) {
  permissionSecurity = { ...nativePermissionDescriptor(), ...change };
  assert.notEqual(permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId).fingerprint, permissionScope.fingerprint);
  await assert.rejects(permissionSend, e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
  assert.throws(() => permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, permissionScope.fingerprint),
    e => e.code === 'AGENT_SECURITY_POLICY_CHANGED');
}
permissionSecurity = nativePermissionDescriptor();
permissionWorkspaceIdentity = 'fixture-workspace-root-v2';
await assert.rejects(permissionSend, e => e.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
permissionWorkspaceIdentity = 'fixture-workspace-root-v1';
for (const removed of [undefined, null]) {
  permissionSecurity = removed;
  await assert.rejects(permissionSend, e => e.code === 'AGENT_SECURITY_POLICY_CHANGED',
    'a Session created under a security policy cannot continue after its descriptor is removed');
}
permissionSecurity = { ...nativePermissionDescriptor(), nativeApprovalPolicy: 'replacement-approval-policy' };
const replacementScope = permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId);
permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, replacementScope.fingerprint);
await assert.rejects(permissionSend, e => e.code === 'AGENT_SECURITY_POLICY_CHANGED',
  'fresh Owner consent for a changed policy must not transfer the old Session to that policy');
const replacementSession = await permissionBroker.createSession(permissionAdapter.id, { taskId: permissionTask.id, workspaceId: permissionTask.workspaceId });
permissionTask = { ...executablePermissionTask, currentAgent: { provider: permissionAdapter.id, sessionId: replacementSession.sessionId } };
await permissionBroker.send({ provider: permissionAdapter.id, sessionId: replacementSession.sessionId, content: 'replacement policy' });
assert.equal(permissionSends, 2, 'a fresh Session under the approved replacement policy can execute');
permissionSecurity = nativePermissionDescriptor();
permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, permissionScope.fingerprint);
permissionTask = executablePermissionTask;
for (const [key, invalid] of [['nativeSandboxSupported', true], ['strictIsolationVerified', true],
  ['nativeApprovalSupported', false], ['nativePermissionPolicyVerified', false], ['allToolsRequireApproval', false], ['nativeSandboxMode', 'workspace-write']]) {
  for (const value of [invalid, undefined, 'true', null]) {
    permissionSecurity = { ...nativePermissionDescriptor(), [key]: value };
    assert.equal(executionSecurity.isNativePermissionSecurity(permissionSecurity), false, key + ' must be exact and present');
    const rejectedScope = permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId);
    assert.throws(() => permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, rejectedScope.fingerprint),
      e => e.code === 'AGENT_NATIVE_PERMISSION_POLICY_UNVERIFIED', key);
    await assert.rejects(permissionSend, e => e.code === 'AGENT_NATIVE_PERMISSION_POLICY_UNVERIFIED', key);
  }
}
permissionSecurity = { ...nativePermissionDescriptor(), mode: 'native' };
const legacyUnsandboxed = permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId);
assert.throws(() => permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, legacyUnsandboxed.fingerprint),
  e => e.code === 'AGENT_NATIVE_SANDBOX_UNSUPPORTED');
await assert.rejects(permissionSend, e => e.code === 'AGENT_NATIVE_SANDBOX_UNSUPPORTED');
permissionSecurity = { ...nativePermissionDescriptor(), mode: 'isolated', nativeSandboxSupported: true };
const unverifiedIsolated = permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId);
assert.throws(() => permissionBroker.authorizeExecution(permissionAdapter.id, permissionTask.workspaceId, unverifiedIsolated.fingerprint),
  e => e.code === 'ISOLATED_ENVIRONMENT_UNVERIFIED');
for (const mode of ['unknown', '', null, undefined, true, 0, {}, []]) {
  permissionSecurity = { ...nativePermissionDescriptor(), mode };
  assert.throws(() => permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId),
    e => e.code === 'AGENT_SECURITY_DESCRIPTOR_INVALID');
  await assert.rejects(permissionSend, e => e.code === 'AGENT_SECURITY_DESCRIPTOR_INVALID');
}
for (const malformed of [false, 0, '', true, []]) {
  permissionSecurity = malformed;
  assert.throws(() => permissionBroker.describeExecutionSecurity(permissionAdapter.id, permissionTask.workspaceId),
    e => e.code === 'AGENT_SECURITY_DESCRIPTOR_INVALID');
  await assert.rejects(permissionSend, e => e.code === 'AGENT_SECURITY_DESCRIPTOR_INVALID');
}
permissionSecurity = nativePermissionDescriptor();
console.log('PASS explicit native permission mode, exact gates, Owner consent, runtime/policy fingerprints, and existing Task/Session/Workspace fences');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-native-security-'));
let services;
try {
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data') });
  services.agentBroker.register(adapter);
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { name: 'Synthetic', root: project } })).workspace;
  const scope = services.agentBroker.describeExecutionSecurity(adapter.id, workspace.id);
  const request = { capability: 'agent.execution.authorize', workspaceId: workspace.id,
    input: { provider: adapter.id, fingerprint: scope.fingerprint }, reason: scope.disclosure };
  await assert.rejects(() => services.capabilityService.broker.execute({ ...request, actor: { kind: 'agent', id: 'untrusted' } }),
    e => e.code === 'PERMISSION_DENIED');
  const pending = await services.capabilityService.execute({ method: 'capability.execute', params: request });
  assert.equal(pending.status, 'pending');
  assert.equal(services.agentBroker.describeExecutionSecurity(adapter.id, workspace.id).authorized, false);
  const approval = services.capabilityService.broker.approvals.get(pending.approvalId);
  assert.match(approval.request.reason, /Native/);
  await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  assert.equal(services.agentBroker.describeExecutionSecurity(adapter.id, workspace.id).authorized, true);
  services.agentBroker.register(permissionAdapter);
  const permissionOwnerScope = services.agentBroker.describeExecutionSecurity(permissionAdapter.id, workspace.id);
  const permissionRequest = { ...request, input: { provider: permissionAdapter.id, fingerprint: permissionOwnerScope.fingerprint }, reason: permissionOwnerScope.disclosure };
  await assert.rejects(() => services.capabilityService.broker.execute({ ...permissionRequest, actor: { kind: 'agent', id: 'untrusted' } }),
    e => e.code === 'PERMISSION_DENIED');
  const permissionPending = await services.capabilityService.execute({ method: 'capability.execute', params: permissionRequest });
  assert.equal(permissionPending.status, 'pending');
  assert.equal(services.agentBroker.describeExecutionSecurity(permissionAdapter.id, workspace.id).authorized, false);
  await services.capabilityService.execute({ method: 'capability.approval.decide', params: { id: permissionPending.approvalId, approve: true } });
  assert.equal(services.agentBroker.describeExecutionSecurity(permissionAdapter.id, workspace.id).authorized, true);
  // Configured credentials are not authenticated accounts. The explicit native mode
  // may dispatch one Task to verify them, but only with its complete verified policy.
  let dispatchHealth={available:true,installed:true,compatible:true,taskEligible:true,
    sessionCapable:true,authenticated:null,authConfigured:true,authVerified:false,authentication:'configured-unverified'};
  let dispatchSecurity={...nativePermissionDescriptor(),verified:true};
  let dispatchStarts=0,dispatchSends=0;
  const dispatchBase=defineAgentProvider({id:'configured-native-dispatch',label:'Configured native dispatch fixture',
    capabilityExtras:{workspaceBoundary:'native-staged'},methods:{
      async health(){return {...dispatchHealth};},
      async createSession(){dispatchStarts++;return {sessionId:'configured-dispatch-session'};},
      async send(){dispatchSends++;return {accepted:true};},
      async *follow({signal}){await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});}
    }});
  services.agentBroker.register({...dispatchBase,capabilities:()=>({...dispatchBase.capabilities(),security:dispatchSecurity})});
  const dispatchTask=services.taskService.runtime.create({goal:'Synthetic configured runtime preflight',workspaceId:workspace.id});
  const dispatchScope=services.agentBroker.describeExecutionSecurity(dispatchBase.id,workspace.id);
  services.agentBroker.authorizeExecution(dispatchBase.id,workspace.id,dispatchScope.fingerprint);
  const healthyDispatch={...dispatchHealth};
  const baseDispatchSecurity={...dispatchSecurity};
  let dispatchRequest=0;
  const runDispatch=()=>services.capabilityService.execute({method:'capability.execute',params:{capability:'agent.run',
    requestId:'configured-native-'+ ++dispatchRequest,taskId:dispatchTask.id,workspaceId:workspace.id,
    input:{agentProvider:dispatchBase.id,content:'Synthetic fixture; no external effects'}}});
  for(const [label,changes] of [
    ['explicit authentication failure',{authenticated:false}],['missing credential',{authConfigured:false}],
    ['missing credential evidence',{authConfigured:undefined}],['unknown credential state',{authentication:'unknown'}],
    ['unproven session',{sessionCapable:false}],['missing session evidence',{sessionCapable:undefined}],
    ['unavailable runtime',{available:false}],['ineligible Task runtime',{taskEligible:false}],
    ['ambiguous API verification',{authVerified:undefined}],['claimed API verification without authentication',{authVerified:true}]
  ]){dispatchHealth={...healthyDispatch,...changes};await assert.rejects(runDispatch,error=>error.code==='PROVIDER_UNAVAILABLE',label);}
  dispatchHealth={...healthyDispatch};
  for(const changes of [{mode:'native',nativeSandboxSupported:true},{mode:'isolated',nativeSandboxSupported:true,strictIsolationVerified:true},
    {nativePermissionPolicyVerified:false},{allToolsRequireApproval:false},{verified:false}]){
    dispatchSecurity={...baseDispatchSecurity,...changes};await assert.rejects(runDispatch,error=>error.code==='PROVIDER_UNAVAILABLE');
  }
  dispatchSecurity={...baseDispatchSecurity};
  assert.equal(dispatchStarts,0,'unverified preflight must not create a Session');
  assert.equal(dispatchSends,0,'unverified preflight must not send a prompt');
  const dispatched=await runDispatch();
  assert.equal(dispatched.status,'completed');assert.equal(dispatched.result.accepted,true);
  assert.equal(dispatchStarts,1);assert.equal(dispatchSends,1);
  assert.equal(dispatchHealth.authenticated,null,'dispatch must not turn configured credentials into an authenticated account');
  assert.equal(services.taskService.runtime.get({id:dispatchTask.id}).task.currentAgent.provider,dispatchBase.id);
  console.log('PASS real Task assignment accepts only exact configured-unverified native policy and rejects explicit auth failure or incomplete evidence');
  const stale = services.agentBroker.describeExecutionSecurity(adapter.id, workspace.id);
  revision = 'fixture-policy-v3';
  await assert.rejects(() => services.capabilityService.execute({ method: 'capability.execute', params: {
    ...request, input: { provider: adapter.id, fingerprint: stale.fingerprint } } }), e => e.code === 'AGENT_SECURITY_POLICY_CHANGED');
  console.log('PASS Native official policy, alternate Adapter, scope confirmation, policy change, platform Owner approval and cross-workspace denial');
} finally {
  if (services) await services.capabilityService.close();
  fs.rmSync(root, { recursive: true, force: true });
}

assert.equal(parseWindowsNativeSandboxPolicy('[windows]\nsandbox = "unelevated"'), 'unelevated');
assert.equal(parseWindowsNativeSandboxPolicy('[windows]\nsandbox = "elevated"'), 'elevated');
for (const config of ['windows.sandbox = "elevated"', 'windows = { sandbox = "mxc" }', '["windows"]\nsandbox = "mxc"']) {
  assert.throws(() => parseWindowsNativeSandboxPolicy(config), e => e.code === 'CODEX_NATIVE_POLICY_UNVERIFIED');
}

if (process.platform === 'win32') {
  const policyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-policy-projection-'));
  let starts = 0;
  const fixtureCli = { executable: () => path.join(policyRoot, 'fixture.exe'),
    probe: args => ({ available: true, stdout: args[0] === '--version' ? 'codex-cli fixture'
      : args[0] === 'login' ? 'Logged in'
      : '--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check [SESSION_ID]', stderr: '' }),
    startSession() { starts++; throw new Error('unverified policy must never start a process'); },
    async shutdown() {} };
  try {
    for (const config of ['windows.sandbox = "elevated"', '[windows]\nsandbox = "unknown"', '[windows]\nsandbox = "unelevated"\nsandbox = "elevated"']) {
      fs.writeFileSync(path.join(policyRoot, 'config.toml'), config);
      const provider = createCodexAgentProvider({ codexHome: policyRoot, cliProcess: fixtureCli, resolveTaskWorkspace: () => null });
      const capabilities = provider.capabilities();
      assert.equal(capabilities.available, false);
      assert.equal(capabilities.security.nativeSandboxSupported, false);
      assert.match(capabilities.reason, /^CODEX_NATIVE_POLICY_/);
      const health = await provider.health();
      for (const key of ['available', 'sessionCapable', 'taskEligible', 'readyForTask']) assert.equal(health[key], false, key);
      assert.equal(health.installed, true); assert.equal(health.compatible, true);
      assert.equal(health.probeCode, capabilities.reason);
      const guardedPolicy = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [provider] }) });
      const scope = guardedPolicy.describeExecutionSecurity('codex', 'fixture-workspace');
      assert.throws(() => guardedPolicy.authorizeExecution('codex', 'fixture-workspace', scope.fingerprint), e => e.code === 'AGENT_NATIVE_SANDBOX_UNSUPPORTED');
      await assert.rejects(() => provider.createSession({ taskId: 'fixture-task', workspaceId: 'fixture-workspace' }), e => /^CODEX_NATIVE_POLICY_/.test(e.code));
      const service = createDefaultAgentService({ codexOptions: { codexHome: policyRoot, cliProcess: fixtureCli } });
      try { assert.equal(service.listProviders().find(item => item.id === 'codex').available, false); }
      finally { await service.close(); }
    }
    assert.equal(starts, 0, 'invalid policy cannot run even when metadata remains readable');
    console.log('PASS invalid native policy is unavailable without breaking Core provider enumeration or weakening execution checks');
  } finally { fs.rmSync(policyRoot, { recursive: true, force: true }); }
}
