import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCapabilityBroker,
  createCapabilityPolicy,
  OWNER_ACTOR
} from '../src/capability/index.js';
import {
  createModelProviderRegistry,
  createModelRuntimeService,
  createOpenAiCompatibleModelProvider,
  createToolExecutionCoordinator
} from '../src/model/index.js';
import { createCapabilityApproval } from '../src/capability/approval.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { buildCapabilityContext } from '../src/context/capability-context.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createContinuityService } from '../src/continuity/service.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiEventBus, createDesktopUiService } from '../src/desktop/ui-service.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-tool-calling-'));
let step = 0;
const pass = (name) => console.log('PASS ' + (++step) + ' ' + name);

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function modelRuntimeWith(responses, supportsTools = true) {
  const calls = [];
  const runtime = {
    supportsToolCalling: () => supportsTools,
    async chat(options) {
      calls.push(options);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
  return { runtime, calls };
}

const emptyObjectSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false
};

{
  const context = buildCapabilityContext({
    registered: [
      {
        id: 'clock.now',
        description: 'Return the current local time.',
        inputSchema: emptyObjectSchema,
        available: true,
        availability: 'available',
        requiresApproval: false,
        provider: 'desktop',
        risk: 'low'
      },
      {
        id: 'agent.run',
        description: 'Start an authorized Agent for the current Task.',
        inputSchema: { type: 'object', properties: { provider: { type: 'string' } } },
        available: false,
        availability: 'unavailable',
        requiresApproval: true,
        provider: 'agent-broker',
        risk: 'high'
      }
    ],
    executionPath: 'chat',
    actorKind: 'owner',
    mode: 'smart',
    workspaceAvailable: true,
    toolCalling: 'supported'
  });

  assert.deepEqual(context.manifest.map((item) => item.id), ['clock.now']);
  assert.equal(context.manifest[0].description, 'Return the current local time.');
  assert.deepEqual(context.manifest[0].inputSchema, emptyObjectSchema);
  assert.equal(context.manifest[0].available, true);
  assert.equal(context.manifest[0].requiresApproval, false);
  assert.deepEqual(context.statusSummary, [{ id: 'agent.run', availability: 'unavailable' }]);
  pass('callable manifest keeps descriptions and schemas while unavailable capabilities stay status-only');
}

{
  const secrets = {
    raw: () => ({ apiKey: 'test-key', baseUrl: 'https://provider.example/v1' }),
    list: () => [{ provider: 'fixture' }]
  };
  let sentBody;
  const provider = createOpenAiCompatibleModelProvider({
    id: 'fixture',
    label: 'Fixture',
    baseUrl: 'https://provider.example/v1',
    defaultModel: 'fixture-default',
    supportsTools: true,
    secrets,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return response({
        model: 'fixture-resolved',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'cap_clock_now', arguments: '{}' }
            }]
          }
        }]
      });
    }
  });
  const registry = createModelProviderRegistry({ providers: [provider] });
  const runtime = createModelRuntimeService({ registry, secrets });
  const result = await runtime.chat({
    providerId: 'fixture',
    model: 'fixture-model',
    messages: [{ role: 'user', content: 'What time is it?' }],
    tools: [{
      id: 'clock.now',
      description: 'Return the current local time.',
      inputSchema: emptyObjectSchema
    }]
  });

  assert.equal(provider.supportsTools, true);
  assert.equal(sentBody.tools[0].type, 'function');
  assert.equal(sentBody.tools[0].function.name, 'cap_clock_now');
  assert.equal(sentBody.tools[0].function.description, 'Return the current local time.');
  assert.deepEqual(sentBody.tools[0].function.parameters, emptyObjectSchema);
  assert.equal(sentBody.tool_choice, 'auto');
  assert.equal(result.toolCalls[0].capabilityId, 'clock.now');
  assert.equal(result.model, 'fixture-resolved');
  pass('OpenAI-compatible provider maps descriptors to function tools and returns structured tool calls');
}

{
  let executed = 0;
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
  broker.register({
    id: 'clock.now',
    permission: 'log',
    description: 'Return the current local time.',
    inputSchema: emptyObjectSchema,
    provider: 'desktop',
    risk: 'low',
    execute: () => ({ iso: '2026-10-10T00:00:00.000Z' + (++executed) })
  });
  const { runtime, calls } = modelRuntimeWith([
    {
      text: '',
      toolCalls: [{ id: 'clock-call', capabilityId: 'clock.now', arguments: '{}' }],
      usage: { total_tokens: 5 },
      model: 'fixture-model'
    },
    { text: 'It is 00:00 UTC.', toolCalls: [], usage: { total_tokens: 3 }, model: 'fixture-model' }
  ]);
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker });
  const activities = [];
  const result = await coordinator.run({
    providerId: 'fixture',
    messages: [{ role: 'user', content: 'What time is it?' }],
    manifest: [{
      id: 'clock.now',
      description: 'Return the current local time.',
      inputSchema: emptyObjectSchema,
      available: true,
      requiresApproval: false
    }],
    actor: OWNER_ACTOR,
    sessionId: 'chat-1',
    turnId: 'turn-1',
    scope: { taskId: null, workspaceId: null },
    onActivity: activity => activities.push(activity)
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalling, 'supported');
  assert.equal(result.text, 'It is 00:00 UTC.');
  assert.equal(executed, 1);
  assert.deepEqual(activities.map(item => item.status), ['running', 'completed']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.equal(calls[1].messages.at(-1).tool_call_id, 'clock-call');
  assert.match(calls[1].messages.at(-1).content, /2026-10-10T00:00:00.000Z/);
  pass('tool results return through a structured tool message and continue the same model turn');
}

{
  let executed = 0;
  const broker = createCapabilityBroker({
    policy: createCapabilityPolicy(),
    approval: createCapabilityApproval({ stateDir: path.join(temp, 'approval'), ttlMs: 60_000 })
  });
  broker.register({
    id: 'publish.release',
    permission: 'publish',
    description: 'Publish a prepared release.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
    provider: 'release',
    risk: 'high',
    execute: ({ input }) => { executed += 1; return { published: input.target }; }
  });
  const { runtime, calls } = modelRuntimeWith([
    {
      text: '',
      toolCalls: [{ id: 'publish-call', capabilityId: 'publish.release', arguments: '{"target":"stable"}' }],
      model: 'fixture-model'
    },
    new Error('temporary Model continuation failure'),
    { text: 'The release was approved and published.', toolCalls: [], model: 'fixture-model' }
  ]);
  const coordinator = createToolExecutionCoordinator({
    modelRuntime: runtime,
    capabilityBroker: broker,
    stateDir: path.join(temp, 'pending')
  });
  const pending = await coordinator.run({
    providerId: 'fixture',
    messages: [{ role: 'user', content: 'Publish the stable release.' }],
    manifest: [{
      id: 'publish.release',
      description: 'Publish a prepared release.',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
      available: true,
      requiresApproval: true
    }],
    actor: OWNER_ACTOR,
    sessionId: 'chat-approval',
    turnId: 'turn-approval',
    scope: { taskId: null, workspaceId: null }
  });

  assert.equal(pending.status, 'pending');
  assert.equal(pending.approvalId, broker.approvals.list()[0].id);
  assert.equal(executed, 0, 'pending must pause before the executor');
  assert.equal(calls.length, 1, 'pending must release the Model request');
  const row = broker.approvals.get(pending.approvalId);
  assert.equal(row.request.capability, 'publish.release');
  assert.equal(row.request.actor.id, 'desktop');
  const decision = await broker.decide({ id: pending.approvalId, approve: true, actor: OWNER_ACTOR });
  assert.equal(broker.approvals.get(pending.approvalId).status, 'consumed');
  assert.equal(executed, 1);
  await assert.rejects(() => coordinator.resumeApproval({
    approvalId: pending.approvalId,
    requestFingerprint: row.fingerprint,
    decisionResult: decision
  }), /temporary Model continuation failure/);
  assert.deepEqual(coordinator.pendingTarget(pending.approvalId), { kind: 'chat', sessionId: 'chat-approval', turnId: 'turn-approval' },
    'a transient continuation failure keeps the approval available for retry');
  const resumed = await coordinator.resumeApproval({
    approvalId: pending.approvalId,
    requestFingerprint: row.fingerprint,
    decisionResult: decision
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.text, 'The release was approved and published.');
  assert.equal(calls.length, 3);
  pass('approval suspends, survives a transient Model continuation failure, and resumes after approval');
}

{
  async function approvalHarness(label, answer) {
    const stateDir = path.join(temp, `ui-approval-${label}`);
    let executed = 0;
    const capabilityService = createCapabilityService({ stateDir });
    capabilityService.broker.register({
      id: 'fixture.approval', permission: 'publish', description: 'Run a safe in-memory fixture.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      provider: 'fixture', risk: 'high', execute: ({ input }) => { executed += 1; return { accepted: input.value }; }
    });
    const { runtime, calls } = modelRuntimeWith([
      { text: '', toolCalls: [{ id: `approval-${label}`, capabilityId: 'fixture.approval', arguments: '{"value":"safe-fixture"}' }], model: 'fixture-model' },
      { text: answer, toolCalls: [], model: 'fixture-model' }
    ]);
    runtime.defaultProviderId = () => 'fixture';
    runtime.isRegistered = providerId => providerId === 'fixture';
    runtime.resolveProvider = providerId => ({ id: providerId || 'fixture' });
    const coordinator = createToolExecutionCoordinator({
      modelRuntime: runtime, capabilityBroker: capabilityService.broker, stateDir: path.join(stateDir, 'coordinator')
    });
    const eventBus = createDesktopUiEventBus();
    const chatService = createChatService({
      modelRuntime: runtime,
      toolExecutionCoordinator: coordinator,
      stateDir: path.join(stateDir, 'chat'),
      defaults: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'medium' },
      buildProductContext: async () => ({
        context: 'safe approval fixture',
        manifest: [{
          id: 'fixture.approval', description: 'Run a safe in-memory fixture.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
          available: true, requiresApproval: true
        }],
        scope: { taskId: null, workspaceId: null }
      }),
      onEvent: event => eventBus.publish(event.event, event.data)
    });
    capabilityService.setApprovalDecisionListener(async decision => {
      const target = coordinator.pendingTarget(decision.approvalId);
      return target?.kind === 'chat' ? chatService.resumeApproval(decision) : null;
    });
    const ui = createDesktopUiService({ services: { chatService, capabilityService }, eventBus });
    const session = await ui.execute({ method: 'ui.chat.sessions.create', params: { title: `Approval ${label}` } });
    await ui.execute({ method: 'ui.chat.config.set', params: { id: session.id, config: { modelProvider: 'fixture' } } });
    await ui.execute({ method: 'ui.chat.send', params: { id: session.id, text: 'Use the safe fixture once.' } });
    return { calls, capabilityService, chatService, coordinator, eventBus, executed: () => executed, session, ui };
  }

  const approved = await approvalHarness('approved', 'The approved fixture returned safe-fixture.');
  try {
    const pendingStatus = await approved.ui.execute({ method: 'ui.chat.status', params: { id: approved.session.id } });
    assert.equal(pendingStatus.state, 'waiting-approval');
    assert.ok(pendingStatus.approvalId);
    const pendingCoreStatus = await approved.chatService.execute({ method: 'chat.status', params: { id: approved.session.id } });
    const originalTurnId = pendingCoreStatus.turn.id;
    assert.equal(pendingCoreStatus.turn.toolActivity?.length, 1,
      'active chat status preserves the in-flight tool activity during a refresh');
    assert.equal(pendingCoreStatus.turn.toolActivity[0].capability, 'fixture.approval');
    const pendingRows = await approved.ui.execute({ method: 'ui.approvals.list', params: {} });
    assert.equal(pendingRows.approvals.length, 1);
    assert.equal(pendingRows.approvals[0].status, 'pending');
    assert.equal(pendingRows.approvals[0].capability, 'fixture.approval');
    assert.equal(approved.executed(), 0, 'a pending fixture is never executed before approval');
    const beforeDecision = await approved.eventBus.next({ after: 0, waitMs: 0 });
    assert.ok(beforeDecision.events.some(event => event.event === 'approval.pending'), 'Harbor receives a pending approval event');

    const decision = await approved.ui.execute({ method: 'ui.approvals.decide', params: { id: pendingStatus.approvalId, approve: true } });
    assert.equal(decision.status, 'completed');
    assert.equal(decision.turnResumed, true, 'the typed UI projection confirms that the same Chat turn resumed');
    assert.equal(approved.executed(), 1, 'Approve Once dispatches the safe fixture exactly once');
    assert.equal(approved.calls.length, 2, 'approval resumes through the same Model tool loop');
    assert.match(approved.calls[1].messages.at(-1).content, /safe-fixture/);
    const approvedHistory = await approved.ui.execute({ method: 'ui.chat.history', params: { id: approved.session.id } });
    assert.equal(approvedHistory.messages.at(-1).text, 'The approved fixture returned safe-fixture.');
    const approvedCoreHistory = await approved.chatService.execute({ method: 'chat.history', params: { id: approved.session.id } });
    assert.equal(approvedCoreHistory.messages.at(-1).turnId, originalTurnId, 'approval continuation keeps the original Chat turn id');
    const afterDecision = await approved.eventBus.next({ after: 0, waitMs: 0 });
    assert.ok(afterDecision.events.some(event => event.event === 'chat.updated' && event.data.sessionId === approved.session.id),
      'Harbor reloads the completed assistant reply after an approval is handled elsewhere');
  } finally { approved.chatService.close(); }

  const rejected = await approvalHarness('rejected', 'The fixture was rejected and I will not run it.');
  try {
    const pendingStatus = await rejected.ui.execute({ method: 'ui.chat.status', params: { id: rejected.session.id } });
    const decision = await rejected.ui.execute({ method: 'ui.approvals.decide', params: { id: pendingStatus.approvalId, approve: false } });
    assert.equal(decision.status, 'rejected');
    assert.equal(decision.turnResumed, true, 'rejection is returned to the active Model turn');
    assert.equal(rejected.executed(), 0, 'rejection never invokes the fixture executor');
    assert.match(rejected.calls[1].messages.at(-1).content, /APPROVAL_REJECTED/);
    const rejectedHistory = await rejected.ui.execute({ method: 'ui.chat.history', params: { id: rejected.session.id } });
    assert.equal(rejectedHistory.messages.at(-1).text, 'The fixture was rejected and I will not run it.');
  } finally { rejected.chatService.close(); }
  pass('typed approval projection keeps the Chat turn pending, then resumes through Approve Once or rejection');
}

{
  let executed = 0;
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
  broker.register({
    id: 'clock.now',
    permission: 'log',
    description: 'Return the current local time.',
    inputSchema: emptyObjectSchema,
    risk: 'low',
    execute: () => { executed += 1; return {}; }
  });
  const { runtime, calls } = modelRuntimeWith([
    { text: '', toolCalls: [{ id: 'unknown-call', capabilityId: 'unknown.capability', arguments: '{}' }] },
    { text: 'That capability is unavailable.', toolCalls: [] }
  ]);
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker });
  const result = await coordinator.run({
    providerId: 'fixture',
    messages: [{ role: 'user', content: 'Use the unavailable capability.' }],
    manifest: [],
    actor: OWNER_ACTOR,
    sessionId: 'chat-unknown',
    turnId: 'turn-unknown',
    scope: { taskId: null, workspaceId: null }
  });
  assert.equal(result.status, 'completed');
  assert.equal(executed, 0);
  assert.match(calls[1].messages.at(-1).content, /UNKNOWN_CAPABILITY/);
  pass('unknown provider tool calls are denied by the Capability Broker and returned as structured errors');
}

{
  const { runtime, calls } = modelRuntimeWith([], false);
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute() { throw new Error('must not execute'); } } });
  const result = await coordinator.run({
    providerId: 'legacy',
    messages: [{ role: 'user', content: 'Hello' }],
    manifest: [{ id: 'clock.now', description: 'Time', inputSchema: emptyObjectSchema }],
    actor: OWNER_ACTOR,
    sessionId: 'chat-legacy',
    turnId: 'turn-legacy',
    scope: { taskId: null, workspaceId: null }
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.toolCalling, 'unsupported');
  assert.equal(calls.length, 0);
  pass('providers without tool calling report unsupported and never receive fake tool schemas');
}

{
  const taskRuntime = createTaskRuntime({ stateDir: path.join(temp, 'workspace-resolution-tasks') });
  const task = taskRuntime.create({ goal: 'Reconcile execution workspace', workspaceId: 'workspace-a' });
  const workspaceService = {
    describeWorkspace(id) { return id === 'workspace-b' ? { id, name: 'Observed workspace', root: path.join(temp, 'workspace-b') } : null; }
  };
  const continuity = createContinuityService({ taskRuntime, stateDir: path.join(temp, 'workspace-resolution-continuity'),
    workspaceService, agentBroker: { ids: () => [], require() {}, send() {} } });
  const params = { taskId: task.id, expectedRev: task.rev, expectedWorkspaceId: 'workspace-a', observedWorkspaceId: 'workspace-b' };
  await assert.rejects(() => continuity.execute({ method: 'continuity.workspace.resolve', params }), error => error.code === 'PERMISSION_DENIED');
  const resolved = await continuity.execute({ method: 'continuity.workspace.resolve', params, actor: OWNER_ACTOR });
  assert.equal(resolved.task.workspaceId, 'workspace-b');
  assert.deepEqual(resolved.reconciliation, {
    expectedWorkspaceId: 'workspace-a', observedWorkspaceId: 'workspace-b', resolution: 'use-observed', resolvedAt: resolved.task.checkpoint.at
  });
  assert.equal(taskRuntime.get({ id: task.id }).task.checkpoint.workspaceReconciliation.observedWorkspaceId, 'workspace-b');

  const blocked = buildCapabilityContext({
    registered: [{ id: 'clock.now', description: 'Return time.', inputSchema: emptyObjectSchema, available: true }],
    executionPath: 'chat', mode: 'chat', taskAvailable: true, workspaceAvailable: true,
    workspaceReconciliationRequired: true, toolCalling: 'supported'
  });
  assert.deepEqual(blocked.manifest, [], 'Workspace conflict closes even non-workspace capability calls');
  assert.equal(blocked.statusSummary[0].reason, 'workspace-reconciliation-required');
  pass('Task/Workspace mismatch closes capability calls until an explicit Owner resolution updates the Task checkpoint');
}

{
  const modelRuntime = {
    defaultProviderId: () => 'fixture',
    resolveProvider: () => ({ id: 'fixture' }),
    supportsToolCalling: () => true,
    async *stream() { yield { type: 'turn/end', data: { reason: { kind: 'completed' } } }; }
  };
  const chat = createChatService({ modelRuntime, defaults: { model: 'fixture-default' },
    stateDir: path.join(temp, 'product-context-required'), requireProductContext: true });
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await assert.rejects(() => chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Hello' } }),
    error => error.code === 'PRODUCT_CONTEXT_UNAVAILABLE');
  chat.close();
  pass('production Chat fails closed when CetaMesh Product Context is unavailable');
}

fs.rmSync(temp, { recursive: true, force: true });
