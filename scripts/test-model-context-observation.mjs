import assert from 'node:assert/strict';
import { createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider,
  defineModelProvider, createToolExecutionCoordinator } from '../src/model/index.js';
import { createCapabilityBroker, OWNER_ACTOR } from '../src/capability/index.js';

const capacity = { status: 'declared', contextWindowTokens: 100000, maxOutputTokens: 8000,
  defaultOutputTokens: 1000, source: 'fixture-provider-capacity', version: 'fixture-v1' };
const privateText = 'PRIVATE_PROMPT_TOOL_AND_CONTINUATION_DO_NOT_PROJECT';
function fixtureRuntime({ profile = capacity, countInputTokens = null, responses = [{ text: 'done' }] } = {}) {
  const calls = [];
  const provider = defineModelProvider({ id: 'fixture', label: 'Fixture', defaultModel: 'fixture-model', supportsTools: true,
    contextCapabilities: () => profile, countInputTokens,
    methods: { listModels: async () => [{ id: 'fixture-model' }],
      chat: async request => { calls.push(request); return responses.shift() ?? { text: 'done' }; },
      stream: async function* (request) { calls.push(request); yield { type: 'turn/end', data: { reason: { kind: request.signal?.aborted ? 'aborted' : 'completed' } } }; }
    } });
  return { calls, runtime: createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [provider] }),
    secrets: { list: () => [{ provider: 'fixture' }] } }) };
}
const request = { messages: [
  { role: 'system', content: privateText }, { role: 'user', content: privateText },
  { role: 'assistant', content: '', modelContinuation: { reasoningContent: privateText } },
  { role: 'tool', tool_call_id: 'fixture-call', content: privateText }
], tools: [{ id: 'fixture.read', description: privateText, inputSchema: { type: 'object' } }] };
{
  const { runtime, calls } = fixtureRuntime();
  const observed = [];
  const response = await runtime.chat({ ...request, onContext: snapshot => {
    assert.equal(calls.length, 0, 'snapshot is emitted after budgeting and before provider dispatch');
    observed.push(snapshot);
  } });
  assert.equal(observed.length, 1, 'chat exposes the effective request budget');
  const snapshot = observed[0];
  assert.deepEqual(Object.keys(snapshot).sort(), ['schemaVersion', 'providerId', 'model', 'at', 'status', 'inputTokens',
    'windowTokens', 'reservedOutputTokens', 'capacityStatus', 'source', 'version', 'estimator', 'composition'].sort());
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.providerId, 'fixture');
  assert.equal(snapshot.model, 'fixture-model');
  assert.equal(snapshot.status, 'estimated');
  assert.equal(snapshot.inputTokens, response.contextBudget.inputTokens);
  assert.equal(snapshot.windowTokens, 100000);
  assert.equal(snapshot.reservedOutputTokens, calls[0].maxOutputTokens);
  assert.equal(snapshot.capacityStatus, 'declared');
  assert.equal(snapshot.source, 'fixture-provider-capacity');
  assert.equal(snapshot.version, 'fixture-v1');
  assert.ok(Number.isSafeInteger(snapshot.at));
  assert.equal(JSON.stringify(snapshot).includes(privateText), false, 'observations contain no prompt, tool body or native continuation');
  assert.equal(Object.values(snapshot.composition).reduce((sum, part) => sum + part.tokens, 0), snapshot.inputTokens);
  for (const part of Object.values(snapshot.composition)) {
    assert.equal(part.status, 'estimated'); assert.ok(Number.isSafeInteger(part.tokens) && part.tokens >= 0);
  }
  const streamSnapshots = [];
  const stream = runtime.stream({ ...request, onContext: value => streamSnapshots.push(value) });
  assert.equal(streamSnapshots.length, 1, 'stream keeps the synchronous pre-dispatch observation path');
  for await (const event of stream) assert.equal(event.type, 'turn/end');
  assert.equal(streamSnapshots[0].inputTokens, snapshot.inputTokens);
}
{
  const { runtime } = fixtureRuntime({ countInputTokens: () => ({ tokens: 37, exact: true, tokenizer: 'fixture-tokenizer' }) });
  let snapshot;
  await runtime.chat({ ...request, onContext: value => { snapshot = value; } });
  assert.equal(snapshot.status, 'actual'); assert.equal(snapshot.inputTokens, 37);
  assert.equal(snapshot.estimator, 'fixture-tokenizer');
  assert.ok(Object.values(snapshot.composition).every(part => part.tokens === null && part.status === 'unknown'),
    'an exact total does not fabricate per-component tokenizer counts');
  const unknown = fixtureRuntime({ profile: { status: 'unknown' } });
  await unknown.runtime.chat({ ...request, onContext: value => { snapshot = value; } });
  assert.equal(snapshot.status, 'unknown');
  for (const key of ['inputTokens', 'windowTokens', 'reservedOutputTokens', 'source', 'version', 'estimator']) assert.equal(snapshot[key], null);
  const blocked = fixtureRuntime({ profile: { ...capacity, contextWindowTokens: 1200 } });
  let notifications = 0;
  await assert.rejects(blocked.runtime.chat({ messages: [{ role: 'user', content: 'x'.repeat(2000) }],
    onContext: () => { notifications++; } }), { code: 'MODEL_CONTEXT_BUDGET_EXCEEDED' });
  assert.equal(notifications, 0); assert.equal(blocked.calls.length, 0);
}
{
  const bodies = [];
  const provider = createOpenAiCompatibleModelProvider({ id: 'deepseek-fixture', label: 'Native fixture',
    baseUrl: 'https://fixture.invalid/v1', defaultModel: 'fixture-model', protocolProfile: 'deepseek-chat-v1', supportsTools: true,
    secrets: { raw: () => ({ apiKey: 'fixture-secret' }) },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
      bodies.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: 'done' } }] });
    } });
  const runtime = createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [provider] }),
    secrets: { list: () => [{ provider: 'deepseek-fixture' }] } });
  assert.equal(typeof runtime.modelCapabilities, 'function', 'runtime exposes provider-owned model capabilities');
  const capabilities = runtime.modelCapabilities('deepseek-fixture', 'fixture-model');
  assert.deepEqual(capabilities.reasoning.levels, ['off', 'low', 'high', 'max']);
  assert.equal(capabilities.tools.supported, true); assert.equal(capabilities.tools.status, 'declared');
  assert.equal(capabilities.vision.supported, null); assert.equal(capabilities.context.status, 'unknown');
  assert.deepEqual((await runtime.listModels('deepseek-fixture')).models[0].capabilities, capabilities);
  for (const reasoning of capabilities.reasoning.levels) {
    await runtime.chat({ messages: [{ role: 'user', content: 'fixture' }], reasoning });
    assert.equal(bodies.at(-1).thinking.type, reasoning === 'off' ? 'disabled' : 'enabled');
    assert.equal(bodies.at(-1).reasoning_effort, reasoning === 'off' ? undefined : reasoning);
  }
  const openai = createOpenAiCompatibleModelProvider({ id: 'openai', label: 'OpenAI fixture', defaultModel: 'o3',
    baseUrl: 'https://fixture.invalid/v1', reasoningParam: 'reasoning_effort', secrets: { raw: () => ({ apiKey: 'fixture-secret' }) },
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: 'done' } }] }); } });
  const openaiRuntime = createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [openai] }), secrets: { list: () => [{ provider: 'openai' }] } });
  assert.deepEqual(openaiRuntime.modelCapabilities('openai', 'o3').reasoning.levels, ['off', 'low', 'high']);
  assert.deepEqual(openaiRuntime.modelCapabilities('openai', 'unknown-model').reasoning.levels, []);
  for (const reasoning of ['off', 'low', 'high']) {
    await openaiRuntime.chat({ messages: [{ role: 'user', content: 'fixture' }], reasoning });
    assert.equal(bodies.at(-1).reasoning_effort, reasoning === 'off' ? undefined : reasoning);
  }
}
{
  const { runtime } = fixtureRuntime({ responses: [
    { text: '', toolCalls: [{ id: 'read-1', capabilityId: 'fixture.read', arguments: '{}' }] }, { text: 'done' }
  ] });
  // Use the non-stream path to isolate observation forwarding from the provider's stream parser.
  const coordinatorRuntime = { chat: runtime.chat, supportsToolCalling: runtime.supportsToolCalling };
  const broker = createCapabilityBroker({});
  broker.register({ id: 'fixture.read', permission: 'storage', risk: 'low', execute: () => ({ value: privateText }) });
  const coordinator = createToolExecutionCoordinator({ modelRuntime: coordinatorRuntime, capabilityBroker: broker });
  const snapshots = [];
  const result = await coordinator.run({ providerId: 'fixture', model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }],
    manifest: [{ id: 'fixture.read', description: 'read fixture', inputSchema: { type: 'object' } }],
    actor: OWNER_ACTOR, sessionId: 'observe-session', turnId: 'observe-turn', onContext: value => snapshots.push(value) });
  assert.equal(result.status, 'completed'); assert.deepEqual(snapshots.map(value => value.cycle), [0, 1]);
  assert.deepEqual(snapshots.map(value => value.requestId), ['observe-turn:0', 'observe-turn:1']);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.projection.status, 'observed'); assert.equal(snapshot.projection.truncated, null);
    assert.equal(snapshot.projection.compacted, false); assert.equal(snapshot.projection.compactionCount, 0);
    assert.ok(Number.isSafeInteger(snapshot.projection.bytes));
    assert.equal(JSON.stringify(snapshot).includes(privateText), false);
  }
}
for (const overrideOnResume of [false, true]) {
  const { runtime } = fixtureRuntime({ responses: [
    { text: '', toolCalls: [{ id: 'write-1', capabilityId: 'fixture.write', arguments: '{}' }] }, { text: 'approved result' }
  ] });
  const broker = createCapabilityBroker({});
  broker.register({ id: 'fixture.write', permission: 'extension.invoke', risk: 'high', execute: () => ({ receipt: 'fixture-receipt' }) });
  const coordinator = createToolExecutionCoordinator({ modelRuntime: { chat: runtime.chat, supportsToolCalling: runtime.supportsToolCalling }, capabilityBroker: broker });
  const snapshots = [];
  const observer = value => snapshots.push(value);
  const pending = await coordinator.run({ providerId: 'fixture', model: 'fixture-model', messages: [{ role: 'user', content: 'approve fixture' }],
    manifest: [{ id: 'fixture.write', description: 'fixture write requiring approval', inputSchema: { type: 'object' } }],
    actor: OWNER_ACTOR, sessionId: 'observe-approval-' + overrideOnResume, turnId: 'observe-approval-turn',
    ...(overrideOnResume ? {} : { onContext: observer }) });
  assert.equal(pending.status, 'pending');
  const approval = broker.approvals.get(pending.approvalId);
  const decision = await broker.decide({ id: pending.approvalId, approve: true, actor: OWNER_ACTOR });
  const resumed = await coordinator.resumeApproval({ approvalId: pending.approvalId, requestFingerprint: approval.fingerprint,
    decisionResult: decision, ...(overrideOnResume ? { onContext: observer } : {}) });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(snapshots.map(value => value.cycle), overrideOnResume ? [1] : [0, 1],
    'approval continuation retains the process-local observer or accepts its explicit replacement');
  assert.equal(snapshots.at(-1).requestId, 'observe-approval-turn:1');
}
{
  const { runtime } = fixtureRuntime();
  const body = JSON.stringify({ status: 'completed', result: { text: privateText.repeat(50) } });
  const messages = [{ role: 'user', content: 'compare duplicate observations' },
    { role: 'tool', tool_call_id: 'first', content: body }, { role: 'tool', tool_call_id: 'second', content: body }];
  const coordinator = createToolExecutionCoordinator({ modelRuntime: { chat: runtime.chat }, capabilityBroker: createCapabilityBroker({}) });
  let snapshot;
  await coordinator.run({ providerId: 'fixture', messages, manifest: [], actor: OWNER_ACTOR,
    sessionId: 'observe-compaction', turnId: 'observe-compaction-turn', onContext: value => { snapshot = value; } });
  assert.equal(snapshot.projection.compacted, true);
  assert.equal(snapshot.projection.compactionCount, 1, 'compaction is reported from actual duplicate-result projection');
  assert.equal(snapshot.projection.truncated, null, 'no truncation fact is fabricated from an absent field');
  assert.ok(snapshot.projection.bytes < Buffer.byteLength(JSON.stringify(messages)));
  assert.equal(JSON.stringify(snapshot).includes(privateText), false);
}
{
  const controller = new AbortController();
  let chatCalls = 0, streamCalls = 0, observed = 0, iterator;
  const provider = defineModelProvider({ id: 'cancel-fixture', label: 'Cancel fixture', defaultModel: 'fixture-model', supportsTools: true,
    contextCapabilities: () => capacity,
    methods: { listModels: async () => [], chat: async () => { chatCalls++; return { text: 'must not run' }; },
      stream: request => {
        streamCalls++;
        iterator = (async function* () {
          yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'partial' } } };
          yield { type: 'turn/end', data: { reason: { kind: request.signal?.aborted ? 'aborted' : 'completed' } } };
        })();
        return iterator;
      } }
  });
  const runtime = createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [provider] }), secrets: { list: () => [{ provider: 'cancel-fixture' }] } });
  const direct = runtime.stream({ messages: [{ role: 'user', content: 'fixture' }] });
  assert.equal(direct, iterator, 'observation must not wrap the provider cancellation/finalization iterator');
  await direct.return();
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: createCapabilityBroker({}) });
  await assert.rejects(coordinator.run({ providerId: 'cancel-fixture', messages: [{ role: 'user', content: 'cancel fixture' }],
    manifest: [], actor: OWNER_ACTOR, sessionId: 'observe-cancel', turnId: 'observe-cancel-turn', signal: controller.signal,
    onContext: () => { observed++; }, onTextDelta: () => controller.abort('fixture-owner-stop') }), { code: 'INVOKE_CANCELLED' });
  assert.equal(observed, 1); assert.equal(streamCalls, 2); assert.equal(chatCalls, 0, 'cancelled stream never falls back to non-stream chat');
}
console.log('PASS effective numeric context observations, provider-owned wire capabilities and per-cycle forwarding');
