import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-context-history-core-')));
const project = path.join(base, 'project'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'proof.txt'), 'REAL-CORE-FILE-RECEIPT');
const stateDir = path.join(base, 'state');
const services = createCetaMeshServices({ stateDir, dataRoot: path.join(base, 'data'), resourceRoot: base, sourceRoot: base });
const checkpoints = [], requests = [], requestControls = [];
let coordinator, historyRevision = 1, readCalls = 0, mode = 'positive', requestCycle = 0, readResolutions = 0, readSourceAccesses = 0;
let failCheckpoint = false;
const retainedFile = path.join(stateDir, 'chat', 'fixture-retained-transcript.json');
try {
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { name: 'History source fixture', root: project } })).workspace;
  const task = services.taskService.runtime.create({ goal: 'Retrieve retained history, then read the actual owned fixture.', workspaceId: workspace.id });
  const broker = services.capabilityService.broker;
  broker.register({ id: 'context.history.read', permission: 'context.evidence.read', provider: 'context', risk: 'low', readOnly: true, effect: 'read-only',
    description: 'Read only the current accepted Core history source in bounded pages.',
    inputSchema: { type: 'object', properties: { sourceId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 8000 } }, required: ['sourceId'], additionalProperties: false },
    execute: request => { readCalls++; return coordinator.readHistory(request); } });
  services.modelRegistry.register({ id: 'history-local', label: 'Deterministic local history model leaf', defaultModel: 'fixture', supportsTools: true,
    contextCapabilities: () => ({ status: 'declared', contextWindowTokens: 48000, maxOutputTokens: 2048, defaultOutputTokens: 1000, source: 'owned-fixture', version: '1' }),
    health: async () => ({ available: true }), listModels: async () => [{ id: 'fixture' }], chat: async () => { throw Error('Unexpected non-streaming request'); },
    stream: async function* (request) {
      requests.push(structuredClone(request.messages));
      requestControls.push({ tools: structuredClone(request.tools), toolChoice: request.toolChoice, maxOutputTokens: request.maxOutputTokens });
      requestCycle++;
      if (mode === 'ordinary') {
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Ordinary short turn remains available.' }] } } };
      } else if (mode === 'recovery') {
        assert.ok(request.messages.some(row => row.tool_call_id === 'retrieve-old-history'), 'recovery uses the actual retained accepted receipt');
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Resumed from retained receipts without replay.' }] } } };
      } else if (requestCycle === 1) {
        const synopsis = request.messages.map(row => { try { return JSON.parse(row.content); } catch { return null; } }).find(row => row?.representation === 'extractive-history-reference');
        assert.ok(synopsis?.sources?.length, 'the actual provider request contains a retained-source synopsis');
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'retrieve-old-history', capabilityId: 'context.history.read', arguments: JSON.stringify({ sourceId: synopsis.sources[0].sourceId, offset: 0, maxChars: 3000 }) }] } };
      } else if (requestCycle === 2 && mode !== 'positive') {
        const result = request.messages.findLast(row => row.tool_call_id === 'retrieve-old-history');
        const expected = { revoked: 'CONTEXT_HISTORY_DENIED', unavailable: 'CONTEXT_HISTORY_UNAVAILABLE', revision: 'CONTEXT_SYNOPSIS_STALE', 'changed-after-read': 'CONTEXT_SYNOPSIS_STALE', 'source-edit': 'CONTEXT_SYNOPSIS_STALE' }[mode];
        assert.ok(result?.content.includes(expected), `model receives truthful refused source state for ${mode}`);
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Source unavailable; no historical completion claim.' }] } } };
      } else if (requestCycle === 2) {
        const result = request.messages.find(row => row.tool_call_id === 'retrieve-old-history');
        assert.ok(result?.content.includes('HISTORICAL-PUBLIC-OWNER-0'), 'the model receives actual retained original public text');
        assert.ok(JSON.parse(result.content).result.content.includes(JSON.stringify('D:\\synthetic-owned-project\\owner-reference.txt').slice(1, -1)), 'authorized original public Owner text is not rewritten by generic tool result clipping');
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'real-file-read', capabilityId: 'filesystem.read', arguments: '{"path":"proof.txt"}' }] } };
      } else {
        assert.ok(request.messages.some(row => row.role === 'tool' && row.content.includes('REAL-CORE-FILE-RECEIPT')), 'the ordinary real Broker/Workspace loop remains usable');
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Retrieved old public history and the actual file receipt.' }] } } };
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  services.providerSecrets.set({ provider: 'history-local', apiKey: 'synthetic-local-only' });
  const coordinatorOptions = { stateDir, modelRuntime: services.modelRuntime, capabilityBroker: broker,
    resolveHistoryContext: ({ purpose }) => {
      if (purpose === 'read') readResolutions++;
      if (purpose === 'read' && (mode === 'revision' && readResolutions === 1 || mode === 'changed-after-read' && readResolutions === 2)) historyRevision++;
      return { authorized: mode !== 'ordinary' && (mode !== 'revoked' || purpose !== 'read'), revision: historyRevision, task: services.taskService.runtime.get({ id: task.id }).task,
        resolveMessages: () => {
          if (purpose === 'read') readSourceAccesses++;
          if (mode === 'unavailable' && purpose === 'read') return null;
          const retained = readJsonFile(retainedFile).modelMessages;
          if (mode === 'source-edit' && purpose === 'read') retained[2].content = retained[2].content.replace('Historical', 'Historicax');
          return retained;
        } };
    },
    onMessagesCheckpoint: payload => {
      checkpoints.push(structuredClone(payload));
      if (failCheckpoint && payload.phase === 'settled-transcript' && payload.settledCallIds.length) { failCheckpoint = false; throw Error('Owned fixture atomic writer unavailable'); }
      writeJsonAtomic(retainedFile, { schemaVersion: 1, modelMessages: payload.messages, contextSynopsis: payload.synopsis, revision: payload.revision });
    } };
  coordinator = createToolExecutionCoordinator(coordinatorOptions);
  const messages = [{ role: 'system', content: 'Current Core permissions remain authoritative.' }];
  for (let i = 0; i < 18; i++) messages.push({ role: 'user', content: `HISTORICAL-PUBLIC-OWNER-${i}: ${'retained conversation. '.repeat(140)}` },
    { role: 'assistant', content: `Historical attributed reply ${i}: ${'unverified conversation. '.repeat(135)}` });
  messages.push({ role: 'user', content: 'CURRENT OWNER: retrieve the old public source, then read proof.txt.' });
  messages[1].content = 'HISTORICAL-PUBLIC-OWNER-0 D:\\synthetic-owned-project\\owner-reference.txt ' + messages[1].content;
  const originals = JSON.stringify(messages);
  const options = { providerId: 'history-local', model: 'fixture', actor: OWNER_ACTOR, sessionId: 'history-core-session', turnId: 'history-core-turn',
    scope: { taskId: task.id, workspaceId: workspace.id }, messages,
    manifest: broker.list().filter(row => ['filesystem.read', 'context.history.read'].includes(row.id)) };
  assert.equal(services.modelRuntime.contextBudget('history-local', 'fixture', { messages, tools: options.manifest }).status, 'exceeded');
  const result = await coordinator.run(options);
  assert.equal(result.status, 'completed'); assert.equal(requests.length, 3); assert.equal(readCalls, 1);
  assert.equal(JSON.stringify(messages), originals, 'original caller history is retained');
  assert.ok(checkpoints.length >= 2, 'settled source/file receipts reach the existing owner checkpoint hook before later inference');
  assert.ok(checkpoints.some(row => row.messages.some(message => message.tool_call_id === 'real-file-read')));
  const executionJournal = JSON.parse(fs.readFileSync(path.join(stateDir, 'model', 'tool-executions.json'), 'utf8'));
  assert.deepEqual(Object.values(executionJournal).map(row => row.status), ['completed', 'completed']);
  console.log(JSON.stringify({ fixture: 'production-core-history-source-loop', originalBytes: Buffer.byteLength(originals), outgoingBytes: Buffer.byteLength(JSON.stringify(requests[0])),
    actualCore: true, actualBroker: true, actualWorkspaceRead: true, sourcePages: readCalls, modelRequests: requests.length, liveModel: false }));

  const reference = JSON.parse(checkpoints.find(row => row.synopsis).synopsis.content).sources[0];
  await assert.rejects(broker.execute({ requestId: 'forged-copy-of-call', actor: OWNER_ACTOR, capability: 'context.history.read', taskId: task.id, workspaceId: workspace.id,
    origin: { sessionId: options.sessionId, turnId: options.turnId, targetKind: 'chat' }, input: { sourceId: reference.sourceId } }), { code: 'CONTEXT_HISTORY_DENIED' }, 'copied origin cannot create an accepted coordinator frame');
  for (const scenario of ['revoked', 'unavailable', 'revision', 'changed-after-read', 'source-edit']) {
    mode = scenario; requestCycle = 0; readResolutions = 0; readSourceAccesses = 0;
    const denied = await coordinator.run({ ...options, turnId: `history-${scenario}` });
    assert.equal(denied.status, 'completed');
    if (scenario === 'revoked' || scenario === 'revision') assert.equal(readSourceAccesses, 0, 'changed authorization/revision refuses before raw source access');
    if (scenario === 'changed-after-read') assert.equal(readSourceAccesses, 1, 'post-read revision change prevents returning the page');
  }
  console.log('history Core: admitted frame, current authorization, revision and before/after source fingerprint checks refuse safely');

  mode = 'positive'; requestCycle = 0; readResolutions = 0; failCheckpoint = true;
  const interrupted = { ...options, turnId: 'history-checkpoint-failure' };
  await assert.rejects(coordinator.run(interrupted), { code: 'CONTEXT_HISTORY_CHECKPOINT_PERSIST_FAILED' });
  const durable = readJsonFile(path.join(stateDir, 'model', 'tool-executions.json'));
  const accepted = Object.values(durable).filter(row => row.turnId === interrupted.turnId);
  assert.equal(accepted.length, 1); assert.equal(accepted[0].status, 'completed', 'failed checkpoint cannot erase the original accepted receipt');
  await assert.rejects(coordinator.run(interrupted), { code: 'REQUEST_RECOVERY_REQUIRED' }, 'same logical turn cannot replay after checkpoint failure');
  const retained = readJsonFile(retainedFile).modelMessages;
  assert.equal(retained.at(-1).tool_calls[0].id, 'retrieve-old-history', 'the actual model call was atomically retained before dispatch');
  assert.equal(accepted[0].sessionId, interrupted.sessionId); assert.equal(accepted[0].cycle, 0); assert.equal(accepted[0].originalIndex, 0);
  assert.equal(accepted[0].taskId, task.id); assert.equal(accepted[0].workspaceId, workspace.id);
  assert.equal(accepted[0].actorKind, 'owner'); assert.equal(accepted[0].actorId, OWNER_ACTOR.id); assert.equal(accepted[0].capability, 'context.history.read');
  retained.push({ role: 'tool', tool_call_id: retained.at(-1).tool_calls[0].id, content: accepted[0].content });
  const callsBeforeRecovery = readCalls;
  mode = 'recovery'; requestCycle = 0;
  const recovered = await coordinator.run({ ...options, turnId: 'history-explicit-fresh-continuation', messages: retained });
  assert.equal(recovered.status, 'completed'); assert.equal(readCalls, callsBeforeRecovery, 'explicit fresh model-only continuation never replays the settled source read');
  assert.equal(readJsonFile(path.join(stateDir, 'model', 'tool-executions.json'))[Object.keys(durable).at(-1)].status, 'completed');
  console.log('history Core: atomic source callback failure retains journal/call pairing, same-turn replay refuses, explicit fresh model-only continuation succeeds');
  mode = 'ordinary'; requestCycle = 0;
  assert.equal((await coordinator.run({ ...options, turnId: 'history-unneeded-for-short-turn', messages: [{ role: 'user', content: 'An ordinary short question.' }] })).status, 'completed',
    'unavailable optional history projection does not block a short ordinary turn');

  // Break caught: exhausting the exact two-call budget used to disable the
  // authorized history projection just before its final no-tool inference.
  mode = 'positive'; requestCycle = 0; readResolutions = 0;
  const requestStart = requests.length, readStart = readCalls, checkpointStart = checkpoints.length;
  coordinator = createToolExecutionCoordinator({ ...coordinatorOptions, maxCalls: 2, finalSynthesisAtLimit: true });
  const limited = await coordinator.run({ ...options, sessionId: 'history-core-limited-session', turnId: 'history-two-call-limit' });
  assert.equal(limited.status, 'completed'); assert.equal(limited.totalCalls, 2);
  assert.equal(requests.length - requestStart, 3); assert.equal(readCalls - readStart, 1);
  const finalMessages = requests.at(-1), finalControl = requestControls.at(-1);
  const finalInstruction = finalMessages.at(-1);
  assert.equal(finalInstruction.role, 'system');
  assert.ok(finalInstruction.content.startsWith('The bounded tool budget is exhausted.'));
  assert.ok(finalInstruction.content.includes('Do not request or simulate more tools.'));
  assert.deepEqual(finalControl.tools, []); assert.equal(finalControl.toolChoice, 'none'); assert.equal(finalControl.maxOutputTokens, 1000);
  const finalCheckpoint = checkpoints.slice(checkpointStart).findLast(row => row.phase === 'request-projection');
  assert.ok(finalCheckpoint.synopsis, 'the final no-tool synthesis retains its current authorized synopsis');
  for (const source of JSON.parse(finalCheckpoint.synopsis.content).sources) assert.equal(source.sourceMessageCount, finalCheckpoint.messages.length, 'source references bind only the actual retained transcript');
  assert.ok(!finalCheckpoint.messages.some(row => row.content === finalInstruction.content), 'the independent request-only limit instruction is never inserted into original source/checkpoint history');
  assert.deepEqual(readJsonFile(retainedFile).modelMessages, finalCheckpoint.messages);
  assert.equal(services.modelRuntime.contextBudget('history-local', 'fixture', { messages: finalMessages, tools: finalControl.tools, maxOutputTokens: finalControl.maxOutputTokens }).status, 'within-budget',
    'complete final budget includes the preserved limit instruction, framing and output reservation');
  const limitReceipts = Object.values(readJsonFile(path.join(stateDir, 'model', 'tool-executions.json'))).filter(row => row.turnId === 'history-two-call-limit');
  assert.deepEqual(limitReceipts.map(row => [row.capability, row.status]), [['context.history.read', 'completed'], ['filesystem.read', 'completed']]);
  console.log(JSON.stringify({ fixture: 'history-final-synthesis-at-limit', maxCalls: 2, actualCalls: limited.totalCalls,
    modelRequests: requests.length - requestStart, finalTools: finalControl.tools.length, finalToolChoice: finalControl.toolChoice,
    finalSourceMessages: finalCheckpoint.messages.length, finalOutgoingMessages: finalMessages.length, finalOutgoingBytes: Buffer.byteLength(JSON.stringify(finalMessages)), liveModel: false }));
} finally {
  await services.close?.();
  assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
  assert.ok(path.basename(base).startsWith('cetamesh-context-history-core-'));
  fs.rmSync(base, { recursive: true, force: true });
}
