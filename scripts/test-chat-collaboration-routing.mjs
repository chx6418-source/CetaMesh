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
import { createCetaMeshServices } from '../src/app/service-container.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { explicitCollaborationIntent } from '../src/desktop/explicit-delegation.js';
import { classifyTask } from '../src/router/smart-router.js';

const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, 'cetamesh-chat-collaboration-'));
const request = '先核实一下文件目录，然后交给其它agent完成项目分析';
const codingRequest = '先读取本项目sum.js和verify.cjs，安排其它agent协作修复sum.js的加法错误，再独立核对差异和测试。';
for (const text of [codingRequest, '请安排其它agent开发一个模块', '让其他agent实现搜索功能',
  '委派给另外一个agent修改代码', '请用多个agent编写测试']) {
  assert.equal(explicitCollaborationIntent(text), true, text);
  assert.equal(classifyTask({ text, hasWorkspaceContext: true }).agentIntent, true, text);
}
for (const text of ['不要安排其它agent协作修复sum.js', '安排其它agent别修复错误',
  '请解释“安排其它agent协作修复sum.js”这句话', '下面是需求示例：安排其它agent实现模块',
  '安排其它agent协作修复是什么意思？', '请讨论安排其它agent修复sum.js的方案，不实际执行。',
  '只想了解如何安排其它agent编写测试，没有要求执行。']) {
  assert.equal(explicitCollaborationIntent(text), false, text);
  assert.equal(classifyTask({ text, hasWorkspaceContext: true }).agentIntent, false, text);
}

async function waitFor(read, check) {
  const deadline = Date.now() + 15000;
  let latest;
  while (Date.now() < deadline) {
    const value = latest = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Chat did not reach a routing outcome: ' + JSON.stringify(latest));
}

async function fixture(name, { managedReady = true, disabled = false, now = Date.now } = {}) {
  const stateDir = path.join(root, name, 'state'), workspaceRoot = path.join(root, name, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'A bounded project-analysis fixture.\n');
  const workspaces = createWorkspaceService({ stateDir });
  const workspace = (await workspaces.execute({ method: 'workspace.create', params: { name, root: workspaceRoot } })).workspace;
  const tasks = createTaskRuntime({ stateDir, now });
  const calls = [], modelRequests = [], routes = [];
  const agentBroker = {
    ids: () => ['cetamesh', 'paid-native'],
    capabilities: provider => ({ workspaceBoundary: 'capability-broker', assignment: {
      taskKinds: ['code', 'analysis'], tools: ['filesystem.read', 'filesystem.search'], maxDifficulty: 3,
      ...(provider === 'cetamesh' ? { estimatedCost: { amount: 0, currency: 'USD', source: 'controlled-fixture',
        agentProvider: provider, modelProvider: 'fixture-model', model: 'fixture-model-id' } } : {}) } }),
    async health(provider) { return { available: provider !== 'cetamesh' || managedReady,
      installed: true, authenticated: true, sessionCapable: true, compatible: true }; },
    async createSession(provider, options) {
      assert.equal(provider, 'cetamesh', 'an unspecified paid native executor must never be a fallback');
      const sessionId = 'managed-fixture'; calls.push({ kind: 'create', provider, sessionId, options }); return { sessionId };
    },
    async send(value) { calls.push({ kind: 'send', ...value }); return { accepted: true }; },
    async status() { return { active: true }; }
  };
  const capabilities = createCapabilityService({ stateDir, workspaceService: workspaces, taskRuntime: tasks,
    memoryService: createMemoryService({ stateDir }), agentBroker });
  const modelRuntime = {
    supportsToolCalling: () => managedReady,
    health: async () => ({ configured: true, available: managedReady }),
    defaultProviderId: () => 'fixture-model', isRegistered: id => id === 'fixture-model',
    resolveProvider: () => ({ id: 'fixture-model' }),
    async *stream(value) {
      modelRequests.push(value);
      yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Controlled ordinary model reply' } } };
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    }
  };
  const platform = createDesktopPlatformRuntime({ capabilityService: capabilities, workspaceService: workspaces,
    taskRuntime: tasks, agentBroker, modelRuntime });
  const chat = createChatService({ stateDir, modelRuntime, router: createRouterService({ stateDir }),
    platformRoute: value => { routes.push(value); return platform.route(value); },
    resolveWorkspace: id => workspaces.describeWorkspace(id), resolveTask: id => tasks.get({ id }).task,
    agentFollow: async function* ({ signal }) {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
  });
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: session.id,
    config: { mode: 'chat', workspaceId: workspace.id, modelProvider: 'fixture-model', model: 'fixture-model-id',
      ...(disabled ? { agentProvider: 'none' } : {}) } } });
  return { tasks, workspace, capabilities, calls, routes, modelRequests, platform,
    record: { id: session.id, taskId: null, config: { mode: 'chat', workspaceId: workspace.id,
      modelProvider: 'fixture-model', model: 'fixture-model-id' } },
    send: text => chat.execute({ method: 'chat.send', params: { id: session.id, text } }),
    status: () => chat.execute({ method: 'chat.status', params: { id: session.id } }),
    async close() { chat.close(); await capabilities.close(); }
  };
}

async function actualCoreCollaboration(name, knownCost, requestText = request, taskKind = 'analysis') {
  const base = path.join(root, name), project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  const fileContent = 'Actual Core collaboration read evidence.';
  fs.writeFileSync(path.join(project, 'proof.txt'), fileContent);
  const services = createCetaMeshServices({ stateDir: path.join(base, 'state'), dataRoot: path.join(base, 'data'),
    sourceRoot: base, resourceRoot: base });
  // Preserve the real Managed descriptor and Broker; candidate discovery is
  // deliberately limited to controlled Providers, never installed native CLIs.
  services.agentBroker.ids = () => ['cetamesh', 'analysis-fixture'];
  let modelCalls = 0, nativeCreates = 0, candidateResult = null, proposalResult = null, modelError = null;
  const needs = { taskKind, difficulty: 1, requiredTools: [] };
  services.modelRegistry.register({ id: 'collaboration-fixture', label: 'Synthetic collaboration model', supportsTools: true,
    defaultModel: 'fixture', health: async () => ({ available: true, configured: true }), listModels: async () => [{ id: 'fixture' }],
    chat: async () => { throw Error('Unexpected non-streaming model call'); },
    stream: async function* (input) {
      try {
      const results = input.messages.filter(row => row.role === 'tool');
      const call = (id, capabilityId, args) => ({ type: 'assistant/tool-calls', data: {
        toolCalls: [{ id, capabilityId, arguments: JSON.stringify(args) }] } });
      if (modelCalls++ === 0) {
        assert.ok(JSON.stringify(input.messages).includes(requestText), 'the actual Managed model receives the whole request');
        yield call('read-proof', 'filesystem.read', { path: 'proof.txt' });
      } else if (modelCalls === 2) {
        assert.ok(JSON.stringify(results).includes(fileContent), 'the model observes actual file bytes');
        yield call('discover-executor', 'agent.delegate.candidates', needs);
      } else if (modelCalls === 3) {
        candidateResult = JSON.parse(results.find(row => row.tool_call_id === 'discover-executor').content);
        assert.equal(candidateResult.status, 'completed', 'discovery must remain complete in the actual model tool reply');
        assert.equal(candidateResult.result.canPropose, knownCost);
        assert.equal(candidateResult.result.nextAction, knownCost ? 'propose-matching-needs' : 'no-authorized-executor');
        if (knownCost) {
          assert.equal(candidateResult.result.candidates[0].preparationRequired, true);
          assert.equal(candidateResult.result.candidates[0].consentRequired, true);
          assert.equal(candidateResult.result.candidates[0].cost.amount, 0);
          assert.equal(candidateResult.result.candidates[0].cost.source, 'controlled-fixture');
        }
        if (knownCost) yield call('propose-analysis', 'agent.delegate.propose', { ...needs,
          instruction: taskKind === 'code' ? 'Fix the bounded project module after the verified read; native execution and file import still require Owner approval.'
            : 'Analyze the project without modifying files, after the verified directory read.' });
        else yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'No authorized-cost executor is available.' }] } } };
      } else if (knownCost && modelCalls === 4) {
        proposalResult = JSON.stringify(results);
        assert.ok(proposalResult.includes('not-started'), proposalResult);
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Analysis proposed; native execution has not started.' }] } } };
      } else {
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Continuing within the existing Task scope.' }] } } };
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } catch (error) { modelError = error.message; throw error; }
    } });
  services.providerSecrets.set({ provider: 'collaboration-fixture', apiKey: 'synthetic-local-only' });
  services.agentBroker.register(defineAgentProvider({ id: 'analysis-fixture', label: 'Controlled native preparation boundary',
    capabilityExtras: { workspaceBoundary: 'native-staged', supportsReadinessCheck: true,
      security: { mode: 'native', verified: true, nativeSandboxSupported: true, nativeSandboxMode: 'read-only',
        nativeApprovalSupported: true, nativeApprovalPolicy: 'on-request' },
      assignment: { taskKinds: ['analysis', 'code'], tools: [], maxDifficulty: 3,
        ...(knownCost ? { estimatedCost: { amount: 0, currency: 'USD', source: 'controlled-fixture',
          agentProvider: 'analysis-fixture', modelProvider: 'collaboration-fixture', model: 'fixture' } } : {}) } },
    methods: { async health() { return { available: true, installed: true, compatible: true, authenticated: true, sessionCapable: true }; },
      async createSession() { nativeCreates++; throw Error('Native execution requires separate Owner approval'); },
      async send() { throw Error('Native dispatch must not occur'); }, async status() { return { running: false }; },
      async cancel() {}, async closeSession() {}, async *follow() {} } }));
  try {
    const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name } })).workspace;
    const chat = await services.chatService.execute({ method: 'chat.sessions.create', params: {} });
    await services.chatService.execute({ method: 'chat.config.set', params: { id: chat.id,
      config: { mode: 'chat', workspaceId: workspace.id, modelProvider: 'collaboration-fixture', model: 'fixture', reasoning: 'max' } } });
    await services.chatService.execute({ method: 'chat.send', params: { id: chat.id, text: requestText } });
    const status = await waitFor(() => services.chatService.execute({ method: 'chat.status', params: { id: chat.id } }), value => value.turn === null);
    assert.equal(status.lastErrorCode, null, 'ordinary Core must enter its configured Managed model without an invented price descriptor: ' + JSON.stringify({ modelCalls, modelError, candidateResult, proposalResult }));
    const task = services.taskService.runtime.list().tasks[0];
    assert.ok(task?.delegationPolicy, 'explicit collaboration prepares a bounded Task policy');
    assert.equal(task.delegationPolicy.allowUnknownCost, false);
    assert.equal(task.delegationPolicy.allowSubscriptionOnly, true, 'new explicit Chat collaboration permits only the verified Codex subscription route without guessing price');
    assert.equal(task.delegationPolicy.prepareNative, true);
    assert.equal(task.delegationPolicy.maxDelegations, 1);
    assert.equal(task.modelConfig.reasoningEffort, 'max', 'policy binds the actual Chat model configuration');
    const grants = services.capabilityService.principalForTask(task.id).grants.capabilities;
    for (const id of ['filesystem.read', 'filesystem.search', 'agent.delegate.candidates', 'agent.delegate.propose']) assert.ok(grants.includes(id), id);
    for (const id of ['filesystem.write', 'workspace.apply', 'test.run', 'task.create', 'agent.run']) assert.equal(grants.includes(id), false, id);
    assert.ok(task.executionEvidence.some(row => row.capability === 'filesystem.read' && row.status === 'completed'));
    assert.ok(candidateResult);
    if (knownCost) {
      await waitFor(() => services.capabilityService.broker.approvals.list(), rows => rows.some(row => row.request?.capability === 'agent.execution.authorize'));
      assert.ok(proposalResult); assert.equal(services.taskService.runtime.get({ id: task.id }).task.delegationProposal.state, 'proposed');
    } else {
      assert.equal(task.delegationProposal ?? null, null); assert.equal(services.capabilityService.broker.approvals.list().length, 0);
      const existingPolicy = structuredClone(task.delegationPolicy);
      await services.chatService.execute({ method: 'chat.send', params: { id: chat.id, text: '继续总结已经核实的目录' } });
      const continued = await waitFor(() => services.chatService.execute({ method: 'chat.status', params: { id: chat.id } }), value => value.turn === null);
      assert.equal(continued.lastErrorCode, null);
      assert.equal(continued.taskId, task.id);
      assert.deepEqual(services.capabilityService.principalForTask(task.id).grants.capabilities, grants,
        'an ordinary follow-up never replaces existing read-only grants with broad agent.run defaults');
      assert.deepEqual(services.taskService.runtime.get({ id: task.id }).task.delegationPolicy, existingPolicy);
    }
    assert.equal(nativeCreates, 0);
    assert.equal(fs.readFileSync(path.join(project, 'proof.txt'), 'utf8'), fileContent);
    console.log('PASS actual Core Chat -> Managed file read -> candidate discovery -> ' + (knownCost ? 'bounded proposal and pending native approval, zero native execution' : 'unknown-cost refusal, zero native execution'));
  } finally {
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
}

async function retainExistingPolicy(kind) {
  let clock = Date.now();
  const f = await fixture('retained-' + kind, { now: () => clock });
  try {
    await f.platform.route({ decision: { agentIntent: true }, record: f.record, text: request, requestId: 'create-' + kind });
    let task = f.tasks.get({ id: f.record.taskId }).task;
    if (kind === 'revoked') {
      await f.capabilities.execute({ method: 'capability.delegation.revoke', params: { taskId: task.id, expectedRev: task.rev } });
    } else if (kind === 'expired') {
      clock = task.delegationPolicy.expiresAt + 1;
    } else if (kind === 'exhausted') {
      const identity = { id: task.id, provider: task.currentAgent.provider, sessionId: task.currentAgent.sessionId, runId: 'controlled-run', phase: 'user' };
      f.tasks.beginExecutionObservation(identity);
      f.tasks.recordDelegationProposal({ ...identity, actor: f.capabilities.principalForTask(task.id), requestId: 'controlled-proposal',
        intent: { taskKind: 'analysis', difficulty: 1, requiredTools: [], instruction: 'Bounded controlled proposal' } });
      f.tasks.observeExecution({ ...identity, state: 'awaiting-review' });
      f.tasks.claimDelegationProposal({ id: task.id, requestId: 'controlled-proposal', selectedProvider: 'controlled-external' });
      f.tasks.settleDelegationProposal({ id: task.id, requestId: 'controlled-proposal', state: 'blocked', code: 'PROVIDER_UNAVAILABLE' });
    }
    const originalPolicy = f.tasks.get({ id: task.id }).task.delegationPolicy;
    const originalGrants = f.capabilities.principalForTask(task.id).grants;
    await f.platform.route({ decision: { agentIntent: true }, record: f.record, text: request, requestId: 'continue-' + kind });
    assert.equal(f.tasks.countAll(), 1);
    assert.deepEqual(f.tasks.get({ id: task.id }).task.delegationPolicy, originalPolicy, kind + ' policy is never replaced');
    assert.deepEqual(f.capabilities.principalForTask(task.id).grants, originalGrants, kind + ' grants are never renewed');
    assert.equal(f.calls.filter(row => row.kind === 'create').length, 1);
    console.log('PASS existing ' + kind + ' collaboration policy retained without new authority');
  } finally { await f.close(); }
}

try {
  await actualCoreCollaboration('actual-core-preparation', true);
  await actualCoreCollaboration('actual-core-coding-preparation', true,
    '先读取项目proof.txt，安排其它agent协作修复项目模块，再独立核对结果。', 'code');
  await actualCoreCollaboration('actual-core-unknown-cost', false);
  for (const kind of ['valid', 'revoked', 'expired', 'exhausted']) await retainExistingPolicy(kind);
  const f = await fixture('ordinary-chat');
  try {
    await f.send(request);
    const outcome = await waitFor(f.status, status => f.calls.some(row => row.kind === 'send') || status.turn === null);
    assert.equal(f.routes.length, 1, JSON.stringify({ stage: 'ordinary-chat-entry', mode: 'chat',
      routes: f.routes.length, tasks: f.tasks.countAll(), modelCalls: f.modelRequests.length, lastError: outcome.lastErrorCode }));
    const task = f.tasks.list().tasks[0];
    await waitFor(f.status, status => status.taskId === task.id);
    assert.equal(task.goal, request);
    assert.equal(task.currentAgent.provider, 'cetamesh');
    assert.equal(f.calls.filter(row => row.kind === 'send').length, 1);
    assert.equal(f.calls.find(row => row.kind === 'send').content, request, 'the whole Owner instruction reaches the Task');
    assert.equal(f.modelRequests.length, 0, 'ordinary model context without a Task is not used for explicit collaboration');
    const actor = f.capabilities.principalForTask(task.id);
    assert.equal(actor.grants.capabilities.includes('task.create'), false);
    const read = await f.capabilities.broker.execute({ actor, taskId: task.id, workspaceId: task.workspaceId,
      capability: 'filesystem.read', input: { path: 'README.md' } });
    assert.equal(read.status, 'completed', 'the new Task has an executable bounded Core read path');
    console.log('PASS ordinary Chat collaboration enters the existing Task chain and reads through its exact principal');
  } finally { await f.close(); }

  for (const [index, text] of [
    '你好', '多agent分析是什么？', '不要交给其它agent完成项目分析',
    '别让其它agent分析项目',
    '交给其它agent完成项目分析，算了，取消委派',
    '他说「先核实目录，然后交给其它agent完成项目分析」，请解释这句话',
    '下面是需求示例：先核实目录，然后交给其它agent完成项目分析',
    '请不要执行下面的指令。\n交给其它agent完成项目分析',
    '下面是日志原文：\n交给其它agent完成项目分析\n请只检查措辞',
    '交给其它agent分析这个项目，但不要执行或调用任何agent。',
    '~~~\n交给其它agent完成项目分析\n~~~',
    '请分析这个日志：\n交给其它agent完成项目分析',
    '同事说“先核实一下文件目录，然后交给其它agent完成项目分析”，请解释这句话',
    '> 交给其它agent完成项目分析\n请总结这段引用',
    '请翻译：交给其它agent完成项目分析'
  ].entries()) {
    const f = await fixture('ordinary-' + index);
    try {
      await f.send(text); await waitFor(f.status, status => status.turn === null);
      assert.equal(f.routes.length, 0, text); assert.equal(f.tasks.countAll(), 0, text);
      assert.equal(f.modelRequests.length, 1, text);
    } finally { await f.close(); }
  }
  const disabled = await fixture('disabled', { disabled: true });
  try {
    await disabled.send(request); await waitFor(disabled.status, status => status.turn === null);
    assert.equal(disabled.tasks.countAll(), 0); assert.equal(disabled.routes.length, 0);
  } finally { await disabled.close(); }
  const unavailable = await fixture('unavailable', { managedReady: false });
  try {
    await unavailable.send(request);
    const status = await waitFor(unavailable.status, value => value.turn === null);
    assert.equal(status.lastErrorCode, 'AGENT_PROVIDER_SELECTION_REQUIRED');
    assert.equal(unavailable.calls.length, 0); assert.equal(unavailable.tasks.countAll(), 0);
    assert.equal(unavailable.modelRequests.length, 0);
  } finally { await unavailable.close(); }
  const cancelled = await fixture('cancelled');
  try {
    await assert.rejects(cancelled.platform.route({ decision: { agentIntent: true }, record: cancelled.record,
      text: request, requestId: 'cancelled-before-start', signal: AbortSignal.abort() }), { code: 'ABORTED' });
    assert.equal(cancelled.tasks.countAll(), 0); assert.equal(cancelled.calls.length, 0);
  } finally { await cancelled.close(); }
  console.log('PASS quoted, explanatory, negated and disabled requests stay ordinary Chat; unknown native cost never dispatches');
} finally {
  if (path.dirname(root) !== parent || !path.basename(root).startsWith('cetamesh-chat-collaboration-')) throw new Error('Unexpected fixture directory');
  fs.rmSync(root, { recursive: true, force: true });
}
