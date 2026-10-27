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

async function finishApproval(ui, params) {
  const accepted = await ui.execute({method:'ui.approvals.decide',params});
  assert.equal(accepted.status,'accepted','UI acknowledges the durable operation before tool completion');
  assert.equal(typeof accepted.operationId,'string');
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const operation=await ui.execute({method:'ui.approvals.operation',params:{id:accepted.operationId}});
    if(['completed','failed','cancelled','unknown'].includes(operation.status)) {
      assert.equal(operation.status,'completed',JSON.stringify(operation));
      assert.equal(operation.decision,params.approve?'approved':'rejected');
      return operation;
    }
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('Approval operation did not reach a completed terminal state');
}

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
  const continuationState=path.join(temp,'operation-continuation');
  const tasks=createTaskRuntime({stateDir:continuationState});
  const workspace='continuation-workspace';
  const capabilities=createCapabilityService({stateDir:continuationState,taskRuntime:tasks,
    workspaceService:{describeWorkspace:id=>id===workspace?{id,root:temp}:null}});
  const marker=path.join(temp,'continued-effect.marker');let dispatchCount=0;
  capabilities.broker.register({id:'fixture.resume-write',description:'Append a local test marker',permission:'extension.invoke',risk:'high',effect:'non-idempotent',
    retainOperationResult:r=>r,inputSchema:{type:'object',properties:{proof:{type:'string'}},required:['proof'],additionalProperties:false},execute:r=>{
      assert.equal(r.input.proof,'marker');
      fs.appendFileSync(marker,'x');dispatchCount++;return {receipt:'trusted-local-receipt'};
    }});
  const task=tasks.create({goal:'Execute only remaining checkpoint work',workspaceId:workspace});
  capabilities.grantTask(task.id,{capabilities:['fixture.resume-write','operation.continue'],workspaceIds:[workspace]});
  tasks.attachAgent({id:task.id,expectedRev:tasks.get({id:task.id}).task.rev,provider:'alpha',sessionId:'alpha'});
  await capabilities.execute({method:'capability.operation.prepare',params:{taskId:task.id,workspaceId:workspace,
    operationId:'checkpoint-step',capability:'fixture.resume-write',input:{proof:'marker'}}});
  tasks.attachAgent({id:task.id,expectedRev:tasks.get({id:task.id}).task.rev,provider:'beta',sessionId:'beta'});
  const {runtime}=modelRuntimeWith([
    {toolCalls:[{id:'beta-generated-call',capabilityId:'operation.continue',arguments:{operationRef:'checkpoint-step',input:{proof:'marker'}}}]},
    {text:'I received the verified original tool result.',toolCalls:[]}
  ]);
  const coordinator=createToolExecutionCoordinator({stateDir:continuationState,modelRuntime:runtime,capabilityBroker:capabilities.broker});
  const options={providerId:'fixture',messages:[{role:'user',content:'Continue the checkpoint.'}],actor:capabilities.principalForTask(task.id),
    sessionId:'beta',turnId:'beta-turn',scope:{taskId:task.id,workspaceId:workspace},
    manifest:capabilities.broker.list().filter(row=>row.id==='operation.continue')};
  const pending=await coordinator.run(options);assert.equal(pending.status,'pending');assert.equal(dispatchCount,0);
  const approval=capabilities.broker.approvals.get(pending.approvalId);
  assert.equal(approval.request.capability,'fixture.resume-write','approval binds the actual source rather than a generic wrapper');
  const decision=await capabilities.broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR});
  assert.equal((await coordinator.resumeApproval({approvalId:pending.approvalId,requestFingerprint:approval.fingerprint,decisionResult:decision})).status,'completed');
  const next=modelRuntimeWith([{toolCalls:[{id:'different-external-call',capabilityId:'operation.continue',arguments:{input:{proof:'marker'},operationRef:'checkpoint-step'}}]},
    {text:'Skipped completed operation.',toolCalls:[]}]);
  const replay=await createToolExecutionCoordinator({modelRuntime:next.runtime,capabilityBroker:capabilities.broker}).run({...options,turnId:'new-turn'});
  assert.equal(replay.status,'completed');assert.equal(dispatchCount,1);assert.equal(fs.readFileSync(marker,'utf8'),'x');
  const unlinked=modelRuntimeWith([{toolCalls:[{id:'new-id-without-identity',capabilityId:'fixture.resume-write',arguments:{proof:'marker'}}]}]);
  const review=await createToolExecutionCoordinator({modelRuntime:unlinked.runtime,capabilityBroker:capabilities.broker}).run({...options,
    turnId:'unlinked-turn',manifest:capabilities.broker.list().filter(row=>row.id==='fixture.resume-write')});
  assert.equal(review.code,'OUTCOME_UNKNOWN',JSON.stringify(review));assert.equal(dispatchCount,1,'unreferenced resumed effects require review before dispatch');
  pass('replacement model resumes an explicit prepared operation, real approval and old result without duplicate effects');
}

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
  const toolCallBody = sentBody;
  await runtime.chat({
    providerId: 'fixture',
    model: 'fixture-model',
    messages: [{ role: 'user', content: 'Continue without tools.' }],
    tools: [],
    toolChoice: 'none'
  });
  assert.equal(toolCallBody.tool_choice, 'auto', 'tool-enabled requests keep auto selection when descriptors are present');
  assert.equal(Object.hasOwn(sentBody, 'tools'), false, 'empty tools are omitted for compatible providers');
  assert.equal(Object.hasOwn(sentBody, 'tool_choice'), false, 'tool_choice none is omitted when no tools are sent');
  pass('OpenAI-compatible provider preserves tool schemas and omits tool_choice for empty tools');
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
  assert.equal(result.usage.total_tokens, 8, 'usage includes both provider requests, not only final synthesis');
  assert.equal(result.usage.requestCount, 2);
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
  const executed = [];
  const broker = createCapabilityBroker({
    policy: createCapabilityPolicy(),
    approval: createCapabilityApproval({ stateDir: path.join(temp, 'approval-multi-call'), ttlMs: 60_000 })
  });
  for (const capability of ['fixture.first', 'fixture.second']) {
    broker.register({
      id: capability, permission: 'publish', description: `Run ${capability}.`,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      provider: 'fixture', risk: 'high', execute: () => { executed.push(capability); return { capability }; }
    });
  }
  const { runtime, calls } = modelRuntimeWith([
    { text: '', toolCalls: [
      { id: 'first', capabilityId: 'fixture.first', arguments: '{}' },
      { id: 'second', capabilityId: 'fixture.second', arguments: '{}' }
    ], usage: { total_tokens: 5 } },
    { text: 'Both approved actions completed.', toolCalls: [], usage: { total_tokens: 3 } }
  ]);
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker,
    stateDir: path.join(temp, 'continuation-multi-call') });
  const manifest = ['fixture.first', 'fixture.second'].map(id => ({ id, description: id,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: true, requiresApproval: true }));
  let pending = await coordinator.run({ providerId: 'fixture', messages: [{ role: 'user', content: 'Run both.' }], manifest,
    actor: OWNER_ACTOR, sessionId: 'chat-multi-approval', turnId: 'turn-multi-approval' });
  assert.equal(pending.status, 'pending');
  const firstId = pending.approvalId;
  const firstRow = broker.approvals.get(firstId);
  const firstDecision = await broker.decide({ id: firstId, approve: true, actor: OWNER_ACTOR });
  pending = await coordinator.resumeApproval({ approvalId: firstId, requestFingerprint: firstRow.fingerprint, decisionResult: firstDecision });
  assert.equal(pending.status, 'pending', 'the second tool call must pause for its own approval');
  assert.equal(executed.join(','), 'fixture.first');
  const secondId = pending.approvalId;
  const secondRow = broker.approvals.get(secondId);
  const secondDecision = await broker.decide({ id: secondId, approve: true, actor: OWNER_ACTOR });
  const completed = await coordinator.resumeApproval({ approvalId: secondId, requestFingerprint: secondRow.fingerprint, decisionResult: secondDecision });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.usage.totalTokens, 8);
  assert.equal(completed.usage.requestCount, 2, 'resumed tool batches do not count as provider requests');
  assert.deepEqual(executed, ['fixture.first', 'fixture.second']);
  assert.equal(calls.length, 2, 'the model is called again only after every call in the batch has a tool result');
  assert.deepEqual(calls[1].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['first', 'second']);
  pass('multiple tool calls pause and resume one approval at a time without losing the remaining calls');
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
    const deadline = Date.now() + 2_000;
    let sendStatus = null;
    while (Date.now() < deadline) {
      sendStatus = await ui.execute({ method: 'ui.chat.status', params: { id: session.id } });
      if (sendStatus.state === 'waiting-approval' || sendStatus.error) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
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

    const decision = await finishApproval(approved.ui, { id: pendingStatus.approvalId, approve: true });
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
    assert.ok(afterDecision.events.some(event => event.event === 'chat.streaming'
      && event.data.sessionId === approved.session.id && event.data.status === 'streaming' && event.data.reset === true),
    'approving a tool resumes the same Harbor turn in streaming state');
    assert.ok(afterDecision.events.some(event => event.event === 'chat.updated' && event.data.sessionId === approved.session.id),
      'Harbor reloads the completed assistant reply after an approval is handled elsewhere');
  } finally { approved.chatService.close(); }

  const rejected = await approvalHarness('rejected', 'The fixture was rejected and I will not run it.');
  try {
    const pendingStatus = await rejected.ui.execute({ method: 'ui.chat.status', params: { id: rejected.session.id } });
    const decision = await finishApproval(rejected.ui, { id: pendingStatus.approvalId, approve: false });
    assert.equal(decision.status, 'completed');
    assert.equal(decision.decision, 'rejected');
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
    { text: '', toolCalls: [{ id: 'unknown-call', capabilityId: 'clock.now', arguments: '{}' }] },
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
  assert.match(calls[1].messages.at(-1).content, /UNKNOWN_TOOL_IN_TURN/);
  pass('a registered but undisclosed provider tool cannot execute outside the current turn manifest');

  let agentDispatches = 0;
  const agentModel = modelRuntimeWith([
    { text: '', toolCalls: [{ id: 'agent-hidden', capabilityId: 'clock.now', arguments: '{}' }] },
    { text: 'The hidden tool was refused.', toolCalls: [] }
  ]);
  const agentCoordinator = createToolExecutionCoordinator({ modelRuntime: agentModel.runtime,
    capabilityBroker: { execute() { agentDispatches += 1; throw Error('hidden tool reached Broker'); } } });
  await agentCoordinator.run({ providerId: 'fixture', messages: [{ role: 'user', content: 'Try hidden tool.' }],
    manifest: [], actor: { kind: 'agent', id: 'task:fixture' }, sessionId: 'agent-hidden', turnId: 'agent-hidden',
    scope: { taskId: 'fixture', workspaceId: 'fixture-workspace' } });
  assert.equal(agentDispatches, 0, 'MODEL-02: Agent hidden tool never reaches Broker');
  assert.match(agentModel.calls[1].messages.at(-1).content, /UNKNOWN_TOOL_IN_TURN/);
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
  const ack = await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Hello' } });
  assert.ok(ack.requestId, 'tool-capable send returns a request identity before the provider task finishes');
  const deadline = Date.now() + 2_000;
  let terminal = null;
  while (Date.now() < deadline) {
    terminal = await chat.execute({ method: 'chat.status', params: { id: session.id } });
    if (terminal.turn?.state === 'error' || terminal.lastErrorCode) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(terminal.lastErrorCode, 'PRODUCT_CONTEXT_UNAVAILABLE', 'late startup failures remain explicit in Chat status');
  chat.close();
  pass('production Chat fails closed when CetaMesh Product Context is unavailable');
}

{
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
  broker.register({ id: 'clock.now', permission: 'log', description: 'Return the current local time.',
    inputSchema: emptyObjectSchema, risk: 'low', execute: () => ({ iso: 'fixture-time' }) });
  const requests = [], deltas = [], toolActivities = [];
  let cycle = 0;
  const runtime = {
    supportsToolCalling: () => true,
    async chat() { assert.fail('tool-capable Chat must use the streaming Model Runtime path'); },
    async *stream(request) {
      requests.push(request);
      cycle += 1;
      if (cycle === 1) {
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Checking. ' } } };
        yield { type: 'assistant/tool-calls', data: { toolCalls: [
          { id: 'stream-clock', capabilityId: 'clock.now', name: 'clock.now', arguments: '{}' }
        ] } };
        yield { type: 'assistant/message', data: { message: { content: 'Checking. ', usage: { prompt_tokens: 5, completion_tokens: 2 } } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed', usage: { prompt_tokens: 5, completion_tokens: 2 } }, resolvedModel: 'fixture-model' } };
      } else {
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'It is fixture-time.' } } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed', usage: { prompt_tokens: 8, completion_tokens: 4 } }, resolvedModel: 'fixture-model' } };
      }
    }
  };
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker,
    stateDir: path.join(temp, 'streaming-tool-loop') });
  const result = await coordinator.run({ providerId: 'fixture', model: 'fixture-model', messages: [{ role: 'user', content: 'What time?' }],
    manifest: [{ id: 'clock.now', description: 'Return the current local time.', inputSchema: emptyObjectSchema }],
    actor: OWNER_ACTOR, sessionId: 'streaming-chat', turnId: 'streaming-turn', targetKind: 'chat',
    onTextDelta: delta => deltas.push(delta), onStreamReset: () => deltas.push('[reset]'),
    onActivity: activity => toolActivities.push(activity) });
  assert.equal(result.text, 'It is fixture-time.');
  assert.equal(result.usage.inputTokens, 13);
  assert.equal(result.usage.outputTokens, 6);
  assert.equal(result.usage.totalTokens, 19);
  assert.equal(result.usage.requestCount, 2);
  assert.deepEqual(deltas, ['Checking. ', '[reset]', 'It is fixture-time.'], 'text deltas are available before and after tool execution');
  assert.equal(requests.length, 2, 'each tool loop turn streams');
  assert.equal(requests[0].tools.length, 1);
  assert.ok(toolActivities.some(activity => activity.capability === 'clock.now' && activity.status === 'completed'));
  assert.ok(requests[1].messages.some(message => message.role === 'assistant'
    && message.content === 'Checking. ' && message.tool_calls),
  'streaming preserves assistant text and the OpenAI tool-call continuation record');
  pass('tool-capable Chat streams text through each Model turn while preserving Capability execution');
}

{
  const counts = [1, 8, 9, 16];
  for (const count of counts) {
    let sideEffects = 0;
    const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
    broker.register({ id: 'fixture.counted', permission: 'log', description: 'Count bounded fixture calls.',
      inputSchema: emptyObjectSchema, risk: 'low', execute: () => { sideEffects += 1; return { ok: true }; } });
    const calls = Array.from({ length: count }, (_, index) => ({
      id: `count-${count}-${index}`, capabilityId: 'fixture.counted', arguments: '{}'
    }));
    const { runtime } = modelRuntimeWith([{ text: '', toolCalls: calls }, { text: 'done', toolCalls: [] }]);
    const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker,
      stateDir: path.join(temp, `tool-batch-${count}`) });
    const result = await coordinator.run({ providerId: 'fixture', messages: [{ role: 'user', content: 'bounded batch' }],
      manifest: [{ id: 'fixture.counted', description: 'Count bounded fixture calls.', inputSchema: emptyObjectSchema }],
      actor: OWNER_ACTOR, sessionId: `tool-batch-${count}`, turnId: `turn-${count}`, maxBatchCalls: 8 });
    const assistantCalls = result.messages.find(message => message.role === 'assistant' && Array.isArray(message.tool_calls))?.tool_calls ?? [];
    const toolResults = result.messages.filter(message => message.role === 'tool');
    assert.equal(assistantCalls.length, count, `${count} model calls remain represented in the assistant continuation`);
    assert.equal(toolResults.length, count, `${count} model calls each receive an explicit tool result`);
    assert.equal(sideEffects, Math.min(count, 8), `${count} calls execute only within the 8-call batch limit`);
    assert.equal(toolResults.filter(message => JSON.parse(message.content)?.error?.code === 'TOOL_CALL_LIMIT').length,
      Math.max(0, count - 8), `${count} over-limit calls receive explicit errors without side effects`);
  }
  pass('1, 8, 9, and 16 Tool Calls all receive results while side effects stay within the batch limit');
}

{
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy(),
    approval: createCapabilityApproval({ stateDir: path.join(temp, 'approval-delete-chat'), ttlMs: 60_000 }) });
  broker.register({ id: 'fixture.delete', permission: 'publish', description: 'A pending delete fixture.',
    inputSchema: emptyObjectSchema, risk: 'high', execute: () => ({}) });
  const { runtime } = modelRuntimeWith([{ text: '', toolCalls: [{ id: 'delete-pending', capabilityId: 'fixture.delete', arguments: '{}' }] }]);
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker,
    stateDir: path.join(temp, 'continuation-delete-chat') });
  const pending = await coordinator.run({ providerId: 'fixture', messages: [{ role: 'user', content: 'Wait.' }],
    manifest: [{ id: 'fixture.delete', description: 'A pending delete fixture.', inputSchema: emptyObjectSchema }],
    actor: OWNER_ACTOR, sessionId: 'deleted-chat', turnId: 'deleted-turn' });
  assert.equal(pending.status, 'pending');
  const cancelled = coordinator.cancelSession('deleted-chat');
  assert.deepEqual(cancelled, { cancelled: 1 });
  assert.equal(broker.approvals.get(pending.approvalId).status, 'cancelled');
  assert.equal(coordinator.pendingTarget(pending.approvalId), null);
  pass('deleting a Chat invalidates its pending approval continuation');
}

{
  let observedSignal = null;
  const modelRuntime = {
    defaultProviderId: () => 'fixture', resolveProvider: () => ({ id: 'fixture' }), supportsToolCalling: () => false,
    async *stream({ signal }) {
      observedSignal = signal;
      yield { type: 'turn/start', data: { providerId: 'fixture', requestedModel: 'fixture-model' } };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'turn/end', data: { reason: { kind: 'aborted' } } };
    }
  };
  const chat = createChatService({ modelRuntime, defaults: { model: 'fixture-model' },
    stateDir: path.join(temp, 'delete-chat-active-model') });
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Cancel when deleted.' } });
  const deleted = await chat.execute({ method: 'chat.sessions.delete', params: { id: session.id } });
  assert.equal(deleted.deleted, true);
  assert.equal(observedSignal.aborted, true, 'deleting a Chat aborts the active Model request');
  assert.equal((await chat.execute({ method: 'chat.sessions.list', params: {} })).sessions.length, 0);
  chat.close();
  pass('deleting a Chat aborts and joins its active Model turn before removing local history');
}

fs.rmSync(temp, { recursive: true, force: true });

{
 const {runtime,calls}=modelRuntimeWith([{text:'',toolCalls:[{id:'read-once',capabilityId:'fixture.read',arguments:'{}'}]},{text:'Analysis based on the inspected file.',toolCalls:[]}]);
 let executions=0;const c=createToolExecutionCoordinator({finalSynthesisAtLimit:true,modelRuntime:runtime,capabilityBroker:{execute:async()=>{executions++;return {status:'completed',result:'fixture content'};}},maxCycles:1});
 const result=await c.run({providerId:'fixture',messages:[{role:'user',content:'analyze'}],manifest:[{id:'fixture.read',description:'read',inputSchema:emptyObjectSchema}],actor:OWNER_ACTOR,sessionId:'budget-summary',turnId:'budget-summary'});
 assert.equal(result.status,'completed','a valid final answer is not a tool-limit failure');
 assert.equal(executions,1);assert.equal(calls.at(-1).tools.length,0,'final synthesis cannot invoke further tools');
 assert.match(calls.at(-1).messages.at(-1).content,/summari/i);
 pass('bounded tool budget ends with useful final synthesis without extra side effects');
}

{
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
  broker.register({ id: 'fixture.large', permission: 'log', description: 'Large result', inputSchema: emptyObjectSchema,
    risk: 'low', execute: () => ({ rows: Array.from({ length: 45 }, (_, i) => i), body: 'x'.repeat(15000) }) });
  const { runtime, calls } = modelRuntimeWith([
    { toolCalls: [{ id: 'large-call', capabilityId: 'fixture.large', arguments: '{}' }] },
    { text: 'The result is incomplete; obtain the omitted evidence before concluding.', toolCalls: [] }
  ]);
  await createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker }).run({
    providerId: 'fixture', messages: [{ role: 'user', content: 'Inspect all results.' }], actor: OWNER_ACTOR,
    sessionId: 'large', turnId: 'large', manifest: [{ id: 'fixture.large', description: 'Large', inputSchema: emptyObjectSchema }] });
  const evidence = JSON.parse(calls[1].messages.find(m => m.role === 'tool').content);
  assert.equal(evidence.status, 'incomplete');
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.error.code, 'TOOL_RESULT_TRUNCATED');
  assert.ok(evidence.omissions.some(x => x.reason === 'array-items' && x.omitted === 5));
  assert.ok(evidence.omissions.some(x => x.reason === 'string-characters' && x.omitted === 3000));
  pass('bounded results explicitly report omitted evidence instead of presenting clipped data as completed');
}

{
  for (const name of ['Error', 'AbortError']) {
    const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
    broker.register({ id: 'fixture.read', permission: 'log', description: 'Read', inputSchema: emptyObjectSchema,
      risk: 'low', execute: () => 'read evidence' });
    const failure = Object.assign(new Error('second inference interrupted'), { name });
    const { runtime } = modelRuntimeWith([
      { toolCalls: [{ id: 'read-call', capabilityId: 'fixture.read', arguments: '{}' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }, failure
    ]);
    await assert.rejects(() => createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker }).run({
      providerId: 'fixture', messages: [{ role: 'user', content: 'Read then explain.' }], actor: OWNER_ACTOR,
      sessionId: 'failure', turnId: 'failure', manifest: [{ id: 'fixture.read', description: 'Read', inputSchema: emptyObjectSchema }]
    }), error => {
      assert.equal(error.usage.accountingComplete, false);
      assert.equal(error.usage.requests[0].inputTokens, 10);
      assert.equal(error.usage.requests[0].outputTokens, 2);
      assert.equal(error.usage.inputTokens, null, 'failed request usage is unknown, not zero');
      assert.equal(error.usage.requestCount, 2);
      return true;
    });
  }
  pass('later inference failure/cancel retains earlier receipts and marks unknown failed-request usage');
}

{
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy() });
  const runtime = { supportsToolCalling: () => true, async chat() { assert.fail('stream required'); },
    async *stream() {
      yield { type: 'assistant/message', data: { message: { content: 'partial', usage: { prompt_tokens: 7, completion_tokens: 3 } } } };
      throw new Error('stream failed after usage snapshot');
    } };
  await assert.rejects(() => createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: broker }).run({
    providerId: 'fixture', messages: [{ role: 'user', content: 'Read.' }], actor: OWNER_ACTOR,
    sessionId: 'stream-failure', turnId: 'stream-failure', manifest: []
  }), error => {
    assert.equal(error.usage.accountingComplete, false);
    assert.equal(error.usage.requests[0].rawUsage.prompt_tokens, 7);
    assert.equal(error.usage.requests[0].rawUsage.completion_tokens, 3);
    assert.equal(error.usage.requestCount, 1);
    return true;
  });
  pass('usage snapshot received before stream failure survives as an incomplete receipt');
}
