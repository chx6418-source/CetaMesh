import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodexExecArgs, parseWindowsNativeSandboxPolicy } from '../src/agent/codex-agent-provider.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createCetaMeshServices } from '../src/app/service-container.js';

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
