import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatService } from '../src/desktop/chat-service.js';
import { createOpenAiCompatibleModelProvider } from '../src/model/providers/openai-compatible.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';
const tools = [{ id: 'clock.now', description: 'Read clock', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
const principal = { taskId: 't', workspaceId: 'w', actor: { kind: 'agent', id: 'a', grants: { taskIds: ['t'], workspaceIds: ['w'], capabilities: ['clock.now'] } } };
const reasoning = 'private native continuation '.repeat(700);
const completion = (text = 'done', calls = false) => ({ model: 'deepseek-flash', choices: [{ message: { content: text, reasoning_content: reasoning, ...(calls ? { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'cap_clock_now', arguments: '{}' } }] } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] });
function setup({ stream = false, sequence = [completion()], id = 'deepseek-official', status = 200 } = {}) {
 const requests = [];
 const provider = createOpenAiCompatibleModelProvider({ id, label: 'fixture', defaultModel: 'deepseek-flash', baseUrl: 'https://fixture.invalid', supportsTools: true, protocolProfile: id === 'deepseek-official' ? 'deepseek-chat-v1' : 'openai-chat-v1', secrets: { raw: () => ({ apiKey: 'fixture-secret' }) }, fetchImpl: async (_url, init) => {
  const body = JSON.parse(init.body); requests.push(body);
  const payload = sequence.shift() ?? completion();
  if (status !== 200) return new Response(JSON.stringify(payload), { status, headers: { 'x-request-id': 'request-safe' } });
  if (!body.stream) return new Response(JSON.stringify(payload));
  const message = payload.choices[0].message;
  const chunks = [{ model: payload.model, choices: [{ delta: { reasoning_content: message.reasoning_content.slice(0, 100) } }] }, { choices: [{ delta: { reasoning_content: message.reasoning_content.slice(100), content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((x, index) => ({ ...x, index })) } : {}) }, finish_reason: 'stop' }] }];
  return new Response(chunks.map(p => 'data: ' + JSON.stringify(p) + '\n\n').join('') + 'data: [DONE]\n\n');
 } });
 const runtime = { chat: opts => provider.chat({ ...opts, model: opts.model ?? 'deepseek-flash' }), supportsToolCalling: () => true, ...(stream ? { stream: opts => provider.stream({ ...opts, model: opts.model ?? 'deepseek-flash' }) } : {}) };
 return { provider, runtime, requests };
}
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }
for (const stream of [false, true]) await test('native continuation survives ' + (stream ? 'stream' : 'chat') + ' tool round and final', async () => {
 const { runtime, requests } = setup({ stream, sequence: [completion('', true), completion()] });
 const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute: async () => ({ status: 'completed', result: { time: 1 } }) } });
 const result = await coordinator.run({ providerId: 'deepseek-official', model: 'deepseek-flash', reasoning: 'high', messages: [{ role: 'user', content: 'time' }], manifest: tools, actor: principal.actor, sessionId: 's', turnId: 'turn' });
 assert.equal(requests[1].messages.find(m => m.role === 'assistant').reasoning_content, reasoning);
 assert.equal(requests[1].messages.at(-1).tool_call_id, 'c1');
 assert.equal(result.modelContinuation.reasoningContent, reasoning);
});
await test('DeepSeek off low high max map effective wire settings', async () => {
 const { provider, requests } = setup();
 for (const effort of ['off', 'low', 'high', 'max']) await provider.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], reasoning: effort });
 assert.deepEqual(requests.map(r => r.thinking), [{ type: 'disabled' }, { type: 'enabled' }, { type: 'enabled' }, { type: 'enabled' }]);
 assert.deepEqual(requests.map(r => r.reasoning_effort), [undefined, 'low', 'high', 'max']);
});
await test('old missing continuation refuses before fetch without tool replay', async () => {
 const { provider, requests } = setup();
 await assert.rejects(() => provider.chat({ model: 'deepseek-flash', messages: [{ role: 'assistant', content: 'old' }, { role: 'user', content: 'next' }], tools, reasoning: 'high' }), { code: 'MODEL_CONTINUATION_REQUIRED' });
 assert.equal(requests.length, 0);
});
await test('generic provider strips native fields without DeepSeek mapping', async () => {
 const { provider, requests } = setup({ id: 'openai-compatible' });
 await provider.chat({ model: 'm', reasoning: 'off', messages: [{ role: 'assistant', content: 'old', modelContinuation: { profile: 'deepseek-chat-v1', reasoningContent: reasoning }, reasoning_content: reasoning }] });
 assert.equal(requests[0].thinking, undefined); assert.equal(requests[0].messages[0].modelContinuation, undefined); assert.equal(requests[0].messages[0].reasoning_content, undefined);
});
await test('budget finish keeps tool schemas and disables calls', async () => {
 const { runtime, requests } = setup({ sequence: [completion('', true), completion()] });
 const coordinator = createToolExecutionCoordinator({ maxCycles: 1, modelRuntime: runtime, capabilityBroker: { execute: async () => ({ status: 'completed', result: {} }) } });
 const result = await coordinator.run({ providerId: 'deepseek-official', reasoning: 'high', messages: [{ role: 'user', content: 'x' }], manifest: tools, actor: principal.actor });
 assert.equal(requests[1].tools.length, 1); assert.equal(requests[1].tool_choice, 'none'); assert.equal(result.status, 'partial');
});
for (const [status, category] of [[400, 'validation'], [401, 'authentication'], [402, 'quota'], [404, 'model-or-endpoint'], [429, 'rate-limit'], [503, 'server']]) await test('safe structured HTTP ' + status, async () => {
 const { provider } = setup({ status, sequence: [{ error: { message: 'fixture-secret Cookie: bad ' + reasoning } }] });
 await assert.rejects(() => provider.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }] }), error => { assert.equal(error.details.category, category); assert.equal(error.details.httpStatus, status); assert.equal(error.details.requestId, 'request-safe'); assert.ok(!JSON.stringify({message:error.message,details:error.details}).includes('private native')); assert.ok(!error.message.includes('fixture-secret')); return true; });
});
await test('Managed final history, phase identity, and safe failures survive follow', async () => {
 const { runtime, requests } = setup({ sequence: [completion(''), completion()] });
 const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute: async () => ({ status: 'completed' }) } });
 const managed = createManagedAgentProvider({ modelRuntime: runtime, toolExecutionCoordinator: coordinator, taskPrincipalResolver: () => principal, buildProductTurnContext: () => ({ context: '{}', manifest: tools }) });
 const { sessionId } = await managed.provider.createSession({ modelProvider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
 let cursor = 0;
 for (const [runId, phase] of [['run1', 'user'], ['run2', 'user'], ['run3', 'system'], ['run4', 'approval']]) {
  const ack = await managed.provider.send({ sessionId, content: 'hello', phase, runId });
  for await (const event of managed.provider.follow({ sessionId, sinceSequence: cursor })) { cursor = event.seq; assert.equal(event.data.phase, phase); assert.equal(event.data.runId, runId); assert.ok(!JSON.stringify(event).includes('private native')); if (event.type === 'turn/end' && event.data.requestId === ack.requestId) { assert.equal(event.data.reason.kind, 'completed'); break; } }
 }
 assert.equal(requests[1].messages.find(m => m.role === 'assistant').reasoning_content, reasoning);
 await managed.close();
});
await test('approval allow and reject preserve full native continuation without duplicate execution', async () => {
 for (const decision of ['completed', 'rejected']) {
  const { runtime, requests } = setup({ stream: true, sequence: [completion('', true), completion()] });
  let executions = 0;
  const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute: async () => { executions++; return { status: 'pending', approvalId: 'approval' }; }, approvals: { get: () => ({ fingerprint: 'fp' }) } } });
  const pending = await coordinator.run({ providerId: 'deepseek-official', model: 'deepseek-flash', reasoning: 'high', messages: [{ role: 'user', content: 'time' }], manifest: tools, actor: principal.actor, sessionId: 's', turnId: 't' });
  assert.equal(pending.status, 'pending');
  const resumed = await coordinator.resumeApproval({ approvalId: 'approval', requestFingerprint: 'fp', decisionResult: { status: decision, result: { time: 1 } } });
  assert.equal(executions, 1); assert.equal(resumed.status, 'completed');
  assert.equal(requests[1].messages.find(m => m.role === 'assistant').reasoning_content.length, reasoning.length);
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'c1');
 }
});
await test('Managed HTTP failure remains structured and safe', async () => {
 const { runtime } = setup({ status: 401, sequence: [{ error: { message: 'fixture-secret ' + reasoning } }] });
 const managed = createManagedAgentProvider({ modelRuntime: runtime, capabilityExecutor: async () => {}, taskPrincipalResolver: () => principal });
 const { sessionId } = await managed.provider.createSession({ modelProvider: 'deepseek-official', model: 'deepseek-flash' });
 const ack = await managed.provider.send({ sessionId, content: 'hello', phase: 'bootstrap', runId: 'bootstrap-run' });
 for await (const event of managed.provider.follow({ sessionId })) {
  assert.equal(event.data.phase, 'bootstrap'); assert.equal(event.data.runId, 'bootstrap-run');
  if (event.type === 'turn/end' && event.data.requestId === ack.requestId) {
   assert.equal(event.data.reason.error.details.httpStatus, 401); assert.equal(event.data.reason.error.details.category, 'authentication');
   assert.ok(!JSON.stringify(event).includes('fixture-secret')); assert.ok(!JSON.stringify(event).includes('private native')); break;
  }
 }
 await managed.close();
});
await test('Managed ignores arbitrary error details and safeMessage', async () => {
 const managed = createManagedAgentProvider({ modelRuntime: { chat: async () => { throw Object.assign(new Error('private native'), { code: 'fixture-secret', details: { safeMessage: 'fixture-secret', request: reasoning } }); } }, capabilityExecutor: async () => {}, taskPrincipalResolver: () => principal });
 const { sessionId } = await managed.provider.createSession({});
 await managed.provider.send({ sessionId, content: 'hello' });
 for await (const event of managed.provider.follow({ sessionId })) if (event.type === 'turn/end') { assert.equal(event.data.reason.error.details, undefined); assert.equal(event.data.reason.error.code, 'PROVIDER_ERROR'); assert.ok(!JSON.stringify(event).includes('fixture-secret')); break; }
 await managed.close();
});
await test('ordinary Chat preserves private native history and hides it from public history', async () => {
 const stateDir = fs.mkdtempSync(path.join(process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir(), 'continuation-chat-'));
 const { runtime, requests } = setup({ stream: true, sequence: [completion('', true), completion(''), completion()] });
 runtime.defaultProviderId = () => 'deepseek-official'; runtime.isRegistered = () => true; runtime.resolveProvider = () => ({ id: 'deepseek-official' });
 const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute: async () => ({ status: 'completed' }) } });
 const observed = [];
 const chat = createChatService({ modelRuntime: runtime, toolExecutionCoordinator: coordinator, stateDir, defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, buildProductContext: () => ({ context: '{}', manifest: tools }), onEvent: e => observed.push(e) });
 try {
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: session.id, config: { modelProvider: 'deepseek-official', reasoning: 'high' } } });
  for (let i = 0; i < 2; i++) {
   await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'hello ' + i } });
   const deadline = Date.now() + 2000;
   while (Date.now() < deadline) { const status = await chat.execute({ method: 'chat.status', params: { id: session.id } }); if (!status.turn || ['done','error','cancelled'].includes(status.turn.state)) break; await new Promise(r => setTimeout(r, 5)); }
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.filter(m => m.role === 'assistant').at(-1).reasoning_content, reasoning);
  const priorAssistant = requests[2].messages.filter(m => m.role === 'assistant');
  assert.equal(priorAssistant.length, 2); assert.equal(priorAssistant.at(-1).content, '');
  const history = await chat.execute({ method: 'chat.history', params: { id: session.id } });
  assert.ok(!JSON.stringify(history).includes('private native')); assert.ok(!JSON.stringify(observed).includes('private native'));
 } finally { chat.close(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});
await test('transport diagnostics never echo fetch payload or secrets', async () => {
 const provider = createOpenAiCompatibleModelProvider({ id: 'deepseek-official', label: 'fixture', baseUrl: 'https://fixture.invalid', secrets: { raw: () => ({ apiKey: 'fixture-secret' }) }, fetchImpl: async () => { throw new TypeError('fetch failed Cookie: bad ' + reasoning); } });
 await assert.rejects(() => provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }), error => { assert.ok(!error.message.includes('private native')); assert.ok(!error.message.includes('Cookie')); return true; });
});
await test('missing native response refuses before executing requested capabilities', async () => {
 const payload = completion('', true); delete payload.choices[0].message.reasoning_content;
 const { runtime } = setup({ sequence: [payload] }); let executions = 0;
 const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute: async () => { executions++; return { status: 'completed' }; } } });
 await assert.rejects(() => coordinator.run({ providerId: 'deepseek-official', model: 'deepseek-flash', reasoning: 'high', messages: [{ role: 'user', content: 'x' }], manifest: tools, actor: principal.actor }), { code: 'MODEL_CONTINUATION_REQUIRED' });
 assert.equal(executions, 0);
});
await test('cancelled queued bootstrap keeps its original phase and run identity', async () => {
 const managed = createManagedAgentProvider({ modelRuntime: { chat: async () => ({ text: '{"final":"done"}' }) }, capabilityExecutor: async () => {}, taskPrincipalResolver: () => principal });
 const { sessionId } = await managed.provider.createSession({});
 await managed.provider.send({ sessionId, content: 'bootstrap', phase: 'bootstrap', runId: 'cancelled-bootstrap' });
 await managed.provider.cancel({ sessionId });
 for await (const event of managed.provider.follow({ sessionId })) { assert.equal(event.data.phase, 'bootstrap'); assert.equal(event.data.runId, 'cancelled-bootstrap'); break; }
 await managed.close();
});
await test('Managed oversized native history refuses later inference without orphaning or tool replay', async () => {
 const first = completion('', true), last = completion('done');
 first.choices[0].message.reasoning_content = 'native tool reasoning '.repeat(15000);
 last.choices[0].message.reasoning_content = 'native final reasoning '.repeat(15000);
 const { runtime, requests } = setup({ sequence: [first, last, completion()] }); let executions = 0;
 const coordinator = createToolExecutionCoordinator({ modelRuntime: runtime, capabilityBroker: { execute: async () => { executions++; return { status: 'completed', result: { time: 1 } }; } } });
 const managed = createManagedAgentProvider({ modelRuntime: runtime, toolExecutionCoordinator: coordinator, taskPrincipalResolver: () => principal, buildProductTurnContext: () => ({ context: '{}', manifest: tools }) });
 const { sessionId } = await managed.provider.createSession({ modelProvider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }); let cursor = 0;
 for (let i = 0; i < 2; i++) {
  const ack = await managed.provider.send({ sessionId, content: 'time ' + i });
  for await (const event of managed.provider.follow({ sessionId, sinceSequence: cursor })) { cursor = event.seq; if (event.type === 'turn/end' && event.data.requestId === ack.requestId) { assert.equal(event.data.reason.error?.code, 'AGENT_CONTEXT_LIMIT'); break; } }
 }
 assert.equal(requests.length, 2); assert.equal(executions, 1);
 const assistant = requests[1].messages.find(m => m.tool_calls?.length);
 assert.equal(assistant.reasoning_content, first.choices[0].message.reasoning_content);
 assert.equal(requests[1].messages.at(-1).tool_call_id, assistant.tool_calls[0].id);
 await managed.close();
});
if (failed) process.exitCode = 1;
