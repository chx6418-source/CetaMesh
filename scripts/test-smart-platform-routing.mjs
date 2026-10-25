import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopPlatformRuntime } from '../src/desktop/platform-runtime.js';
import { createRouterService } from '../src/router/index.js';
import { createWorkspaceService } from '../src/workspace/index.js';
import { createTaskRuntime } from '../src/task/index.js';
import { createCapabilityService } from '../src/capability/index.js';
import { createMemoryService } from '../src/memory/index.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-smart-route-'));
const modelRequests = [], agentCalls = [], audit = [];
let agentSeq = 0;
let chat;
async function waitFor(read, predicate, label, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  const stateDir = path.join(dir, 'state');
  const workspaceService = createWorkspaceService({ stateDir });
  const taskRuntime = createTaskRuntime({ stateDir });
  const memoryService = createMemoryService({ stateDir });
  const agentBroker = {
    ids: () => ['cetamesh'],
    capabilities: () => ({ workspaceBoundary: 'capability-broker', assignment: { taskKinds: ['code'],
      tools: ['filesystem.read', 'git.status', 'test.run'], maxDifficulty: 3,
      estimatedCost: { amount: 0, currency: 'USD', source: 'fixture',
        agentProvider: 'cetamesh', modelProvider: 'fixture-model', model: 'fixture-model-id' }, estimatedLatencyMs: 20 } }),
    async health() { return { available: true, installed: true, authenticated: true,
      sessionCapable: true, compatible: true }; },
    async createSession(provider, options) {
      const sessionId = 'managed-' + (++agentSeq);
      agentCalls.push({ kind: 'create', provider, sessionId, options });
      return { sessionId };
    },
    async send(request) { agentCalls.push({ kind: 'send', ...request }); return { accepted: true }; },
    async status() { return { active: true }; }
  };
  const capabilityService = createCapabilityService({ stateDir, workspaceService, taskRuntime, memoryService, agentBroker,
    audit: event => audit.push(event) });
  const approval = await capabilityService.broker.execute({ actor: OWNER_ACTOR, capability: 'workspace.create',
    input: { name: 'Smart routing fixture', root: path.join(dir, 'workspace'), createIfMissing: true }, reason: 'Test fixture' });
  assert.equal(approval.status, 'pending');
  const created = await capabilityService.execute({ method: 'capability.approval.decide', params: { id: approval.approvalId, approve: true } });
  const workspaceId = created.result.workspace.id;
  let platformRuntime;
  const modelRuntime = {
    supportsToolCalling: () => true,
    health: async () => ({ configured: true, available: true }),
    defaultProviderId: () => 'fixture-model',
    isRegistered: id => id === 'fixture-model',
    resolveProvider: () => ({ id: 'fixture-model' }),
    async *stream(request) {
      modelRequests.push(structuredClone(request));
      yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Model reply' } } };
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    }
  };
  platformRuntime = createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker, modelRuntime });
  const router = createRouterService({ stateDir, log: () => {} });
  chat = createChatService({
    modelRuntime,
    router,
    platformRoute: request => platformRuntime.route(request),
    resolveWorkspace: workspaceId => workspaceService.describeWorkspace(workspaceId),
    agentFollow: async function* ({ signal }) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    defaults: { provider: 'deepseek-official', model: 'legacy', reasoningEffort: 'max' },
    stateDir
  });

  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: session.id, config: { mode: 'smart', workspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } } });

  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'what time is it?' } });
  await waitFor(() => chat.execute({ method: 'chat.status', params: { id: session.id } }), status => status.turn === null, 'capability-backed Chat turn');
  let history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).routing.resolvedRoute, 'capability');
  assert.ok(modelRequests.at(-1).messages.at(-1).content.includes('Capability reference data'));
  assert.equal(audit.filter(event => event.capability === 'clock.now' && event.status === 'completed').length, 1,
    JSON.stringify({ audit, routing: history.messages.at(-1).routing }));

  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'hello' } });
  history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
  assert.equal(history.messages.at(-1).routing.resolvedRoute, 'model');
  assert.equal(modelRequests.length, 2);

  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'fix a bug in this project' } });
  await waitFor(() => taskRuntime.list().tasks, tasks => tasks.some(task => task.currentAgent?.sessionId === 'managed-1'), 'managed Agent acceptance');
  const tasks = taskRuntime.list().tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].workspaceId, workspaceId);
  assert.equal(tasks[0].currentAgent.provider, 'cetamesh');
  assert.equal(tasks[0].currentAgent.sessionId, 'managed-1');
  assert.deepEqual(agentCalls.filter(call => call.kind === 'send').map(call => call.content), ['fix a bug in this project']);
  assert.equal(modelRequests.length, 2, 'Project intent runs through Task and Agent, not the Model turn');

  const linkedRecord = { taskId: null, config: { workspaceId, agentProvider: 'cetamesh' } };
  const linked = await platformRuntime.route({ decision: { agentIntent: true }, record: linkedRecord,
    text: 'fix a bug in this project' });
  assert.equal(linked.taskId, tasks[0].id, 'Work and Chat must refer to the same existing Task for an exact goal');
  assert.equal(linkedRecord.taskId, tasks[0].id);
  assert.equal(taskRuntime.list().total, 1, 'the same Workspace goal must not create a duplicate Task');

  const taskLookupFailureRuntime = new Proxy(taskRuntime, {
    get(target, property) {
      if (property === 'get') return () => { throw Object.assign(new Error('task store read failed'), { code: 'TASK_STORE_IO' }); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const guardedPlatformRuntime = createDesktopPlatformRuntime({ capabilityService, workspaceService,
    taskRuntime: taskLookupFailureRuntime, agentBroker });
  await assert.rejects(() => guardedPlatformRuntime.route({ decision: { agentIntent: true },
    record: { taskId: 'task-store-unavailable', config: { workspaceId, agentProvider: 'cetamesh' } },
    text: 'do not hide Task storage failures' }), error => error.code === 'TASK_STORE_IO',
  'only a missing stale Task reference may be treated as absent; storage errors must surface');

  let cancelTaskReads = 0;
  const failingCancelTaskRuntime = new Proxy(taskRuntime, {
    get(target, property) {
      if (property === 'cancel') return () => { throw Object.assign(new Error('Task cancellation conflict'), { code: 'TASK_CONFLICT' }); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const taskCancelRuntime = createDesktopPlatformRuntime({ capabilityService, workspaceService,
    taskRuntime: failingCancelTaskRuntime, agentBroker });
  await assert.rejects(() => taskCancelRuntime.route({ decision: { agentIntent: true },
    record: { taskId: null, config: { workspaceId, agentProvider: 'cetamesh' } },
    text: 'surface failed Task cleanup', signal: { get aborted() { cancelTaskReads += 1; return cancelTaskReads >= 3; } } }),
  error => error.code === 'TASK_CONFLICT', 'a failed newly-created Task cancellation must remain observable');

  const rolloverTask = taskRuntime.create({ goal: 'Rollover cancellation fixture', workspaceId });
  taskRuntime.attachAgent({ id: rolloverTask.id, expectedRev: rolloverTask.rev, provider: 'dsh', sessionId: 'dsh-old' });
  let rolloverSignalReads = 0;
  const failingRolloverCancelBroker = { ...agentBroker,
    async health(id) { return { available: true, authenticated: true, sessionCapable: true,
      sandboxCapable: id === 'codex', toolsAvailable: true }; },
    async cancel() { throw Object.assign(new Error('Agent cancellation failed'), { code: 'AGENT_CANCEL_FAILED' }); }
  };
  const rolloverRuntime = createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime,
    agentBroker: failingRolloverCancelBroker, continuityRuntime: { async rollover() {
      return { to: { provider: 'codex', sessionId: 'codex-next' } };
    } } });
  await assert.rejects(() => rolloverRuntime.route({ decision: { agentIntent: true },
    record: { taskId: rolloverTask.id, config: { workspaceId, agentProvider: 'codex' } },
    text: 'surface failed rollover cancellation', signal: { get aborted() { rolloverSignalReads += 1; return rolloverSignalReads >= 4; } } }),
  error => error.code === 'AGENT_CANCEL_FAILED', 'a failed remote cancellation after rollover must remain observable');

  // Phase 3: automatic project routing must use observed capabilities and health.
  const selectedProviders = [];
  let managedTools = true;
  let codexReady = false;
  let codexSandboxCapable = false;
  const routingBroker = { ...agentBroker,
    ids: () => ['cetamesh', 'codex'],
    capabilities: id => ({ workspaceBoundary: id === 'codex' ? 'staged-capability-broker' : 'capability-broker',
      assignment: { taskKinds: ['code'], tools: ['filesystem.read'], maxDifficulty: 3,
        estimatedCost: { amount: 0, currency: 'USD', source: 'fixture',
          agentProvider: id, modelProvider: 'fixture-model', model: 'fixture-model-id' },
        estimatedLatencyMs: id === 'codex' ? 20 : 100 } }),
    health: async id => id === 'codex'
      ? { available: codexReady, installed: codexReady, authenticated: codexReady, sessionCapable: codexReady,
          sandboxCapable: codexSandboxCapable }
      : { available: true, sessionCapable: true }
  };
  const routingRuntime = createDesktopPlatformRuntime({
    capabilityService: { broker: { execute: async request => {
      selectedProviders.push(request.input.agentProvider ?? request.input.provider);
      return { status: 'completed', result: { accepted: true, provider: request.input.agentProvider ?? request.input.provider } };
    } } }, workspaceService, taskRuntime, agentBroker: routingBroker,
    modelRuntime: { supportsToolCalling: () => managedTools,
      health: async () => ({ configured: true, available: true }) }
  });
  await routingRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: 'fix one TypeScript module' });
  assert.equal(selectedProviders.at(-1), 'cetamesh');
  managedTools = false;
  codexReady = true;
  codexSandboxCapable = true;
  const retryWorkspaceApproval = await capabilityService.broker.execute({ actor: OWNER_ACTOR,
    capability: 'workspace.create', input: { name: 'Safe reassignment fixture',
      root: path.join(dir, 'retry-workspace'), createIfMissing: true }, reason: 'Test fixture' });
  const retryWorkspace = await capabilityService.execute({ method: 'capability.approval.decide',
    params: { id: retryWorkspaceApproval.approvalId, approve: true } });
  const retryWorkspaceId = retryWorkspace.result.workspace.id;
  await routingRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: 'fix another TypeScript module' });
  assert.equal(selectedProviders.at(-1), 'codex', 'a verified code Agent must win when Managed lacks tools');
  codexSandboxCapable = false;
  const beforeSandboxRefusal = taskRuntime.countAll();
  await assert.rejects(routingRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId, agentProvider: 'codex' } }, text: 'retry a Codex sandbox refusal' }),
  error => error.code === 'CODEX_SANDBOX_UNAVAILABLE');
  assert.equal(taskRuntime.countAll(), beforeSandboxRefusal, 'a known sandbox refusal cannot create a fake Task');
  codexReady = false;
  const beforeUnavailable = taskRuntime.countAll();
  await assert.rejects(routingRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: 'fix a third TypeScript module' }),
  error => error.code === 'AGENT_PROVIDER_SELECTION_REQUIRED');
  assert.equal(taskRuntime.countAll(), beforeUnavailable, 'unavailable providers cannot leave a queued fake Task');
  const queuedWork = taskRuntime.create({ goal: 'fix queued Work task', workspaceId,
    requestId: 'queued-work-choice', requestedAgentProvider: 'codex' });
  await assert.rejects(routingRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: queuedWork.goal }),
  error => error.code === 'TASK_DISPATCH_INCOMPLETE', 'Chat must not override an unconfirmed Work Agent selection');
  assert.equal(taskRuntime.get({ id: queuedWork.id }).task.currentAgent, null);
  const unknownCostRuntime = createDesktopPlatformRuntime({ workspaceService, taskRuntime,
    agentBroker: { ...routingBroker, capabilities: () => ({ workspaceBoundary: 'capability-broker' }) },
    modelRuntime: { supportsToolCalling: () => true, health: async () => ({ configured: true, available: true }) },
    capabilityService: { broker: { execute: async () => { throw new Error('unknown-cost dispatch must not run'); } } } });
  const beforeUnknownCost = taskRuntime.countAll();
  await assert.rejects(unknownCostRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: 'fix unknown cost candidate' }),
  error => error.code === 'AGENT_PROVIDER_SELECTION_REQUIRED');
  assert.equal(taskRuntime.countAll(), beforeUnknownCost, 'no trusted model-bound cost means no automatic paid Task');
  const beforeDisabled = taskRuntime.countAll();
  await assert.rejects(routingRuntime.route({ decision: { agentIntent: true, class: 'project', agentEnabled: false },
    record: { config: { workspaceId, agentProvider: 'none' } }, text: 'fix disabled project' }),
  error => error.code === 'AGENT_DISABLED');
  assert.equal(taskRuntime.countAll(), beforeDisabled, 'disabled Agent must not create a Task or dispatch');

  codexReady = true;
  codexSandboxCapable = true;
  let codexHealthCalls = 0;
  const retryAgentCalls = [];
  const retryAudit = [];
  const retryBroker = { ...routingBroker,
    health: async id => id === 'codex'
      ? { available: ++codexHealthCalls !== 3, installed: true, authenticated: true,
          sessionCapable: true, sandboxCapable: true }
      : { available: true, sessionCapable: true },
    async createSession(provider, options) {
      retryAgentCalls.push({ kind: 'create', provider, options });
      return { sessionId: 'retry-managed-session' };
    },
    async send(request) { retryAgentCalls.push({ kind: 'send', ...request }); return { accepted: true }; }
  };
  const retryCapability = createCapabilityService({ stateDir: path.join(dir, 'retry-state'),
    workspaceService, taskRuntime, memoryService, agentBroker: retryBroker,
    audit: event => retryAudit.push(event) });
  const safeRetryRuntime = createDesktopPlatformRuntime({ workspaceService, taskRuntime, agentBroker: retryBroker,
    modelRuntime: { supportsToolCalling: () => true, health: async () => ({ configured: true, available: true }) },
    capabilityService: retryCapability });
  const recovered = await safeRetryRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId: retryWorkspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: 'fix safe retry fixture', requestId: 'safe-retry-fixture' });
  assert.equal(recovered.provider, 'cetamesh', 'one preflight failure may select the next verified Provider');
  assert.deepEqual(retryAgentCalls.map(row => row.provider), ['cetamesh', 'cetamesh'],
    'Codex preflight rejection creates no native Session or Agent send');
  const assignmentAudit = retryAudit.filter(row => row.capability === 'agent.run'
    && ['denied', 'completed'].includes(row.status));
  assert.deepEqual(assignmentAudit.map(row => row.status), ['denied', 'completed']);
  assert.notEqual(assignmentAudit[0].requestId, assignmentAudit[1].requestId,
    'retry uses a distinct original Journal request ID');
  assert.equal(recovered.taskId, taskRuntime.findByGoalWorkspace({ goal: 'fix safe retry fixture', workspaceId: retryWorkspaceId }).id);

  let unsafeCalls = 0;
  const unsafeRetryRuntime = createDesktopPlatformRuntime({ workspaceService, taskRuntime, agentBroker: routingBroker,
    modelRuntime: { supportsToolCalling: () => true, health: async () => ({ configured: true, available: true }) },
    capabilityService: { broker: { execute: async () => {
      unsafeCalls += 1;
      throw Object.assign(new Error('unknown send effect'), { code: 'PROVIDER_UNAVAILABLE', effectStatus: 'unknown' });
    } } } });
  await assert.rejects(unsafeRetryRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId: retryWorkspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } }, text: 'fix unknown effect fixture' }),
  error => error.effectStatus === 'unknown');
  assert.equal(unsafeCalls, 1, 'unknown effect cannot be replayed');
  let forgedCalls = 0;
  const forgedRuntime = createDesktopPlatformRuntime({ workspaceService, taskRuntime, agentBroker: routingBroker,
    modelRuntime: { supportsToolCalling: () => true, health: async () => ({ configured: true, available: true }) },
    capabilityService: { broker: { execute: async () => {
      forgedCalls += 1;
      throw Object.assign(new Error('untrusted Provider failure'),
        { code: 'PROVIDER_UNAVAILABLE', noAgentSideEffect: true });
    } } } });
  await assert.rejects(forgedRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId: retryWorkspaceId, modelProvider: 'fixture-model', model: 'fixture-model-id' } },
    text: 'fix forged safe marker fixture' }), error => error.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(forgedCalls, 1, 'Provider supplied safety marker cannot authorize replay');
  await assert.rejects(forgedRuntime.route({ decision: { agentIntent: true, class: 'project' },
    record: { config: { workspaceId: retryWorkspaceId, agentProvider: 'codex' } },
    text: 'fix explicit no fallback fixture' }), error => error.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(forgedCalls, 2, 'explicit Agent failure cannot silently fall back');
  console.log('Smart platform routing: Chat -> Model, Smart tool -> Capability -> Model context, Smart project -> Task -> Agent; no DSH client supplied');
} finally {
  chat?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
