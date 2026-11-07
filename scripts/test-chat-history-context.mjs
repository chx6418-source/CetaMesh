import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createCapabilityService } from '../src/capability/service.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { observeReads } from './test-model-read-concurrency.mjs';

const parent = fs.realpathSync.native(os.tmpdir());
const base = fs.mkdtempSync(path.join(parent, 'cetamesh-chat-history-'));
const stateDir = path.join(base, 'state'), project = path.join(base, 'project');
fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'proof.txt'), 'ACTUAL-CHAT-FILE-RECEIPT');
const services = createCetaMeshServices({ stateDir, dataRoot: path.join(base, 'data'), resourceRoot: base, sourceRoot: base, deferOptionalStart: true });
let chat, coordinator, sourceReads = 0, cycle = 0, flow = 'loop', catalogRevision = 1, ownerRequest = null, releaseModel = null;
let currentModelSignal = null, metadataGate = null, metadataEntered = false;
const requests = [], checkpoints = [], events = [];
async function settled(id) {
  for (let i = 0; i < 1000; i++) { const status = await chat.execute({ method: 'chat.status', params: { id } }); if (!status.turn) return status; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Actual Chat turn did not settle');
}
async function until(read, predicate, label) {
  for (let i = 0; i < 1000; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(label);
}
try {
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Chat history fixture' } })).workspace;
  // Fresh real service for this explicit composition; the default Core service
  // may already have its own one-time reader binding and is never rebound.
  const capabilities = createCapabilityService({ stateDir: path.join(base, 'chat-capability'), workspaceService: services.workspaceService, taskRuntime: services.taskService.runtime });
  const broker = capabilities.broker;
  services.modelRegistry.register({ id: 'chat-history-local', label: 'Owned deterministic model leaf', defaultModel: 'fixture', supportsTools: true,
    contextCapabilities: () => ({ status: 'declared', contextWindowTokens: 100000, maxOutputTokens: 2000, defaultOutputTokens: 1000, source: 'owned-fixture', version: '1' }),
    listModels: async () => [{ id: 'fixture' }], health: async () => ({ available: true }), chat: async () => { throw Error('Unexpected non-streaming request'); },
    stream: async function* (request) {
      requests.push(structuredClone(request.messages));
      cycle++;
      if (flow === 'hold' && cycle === 1) await new Promise(resolve => {
        currentModelSignal = request.signal;
        releaseModel = () => { request.signal?.removeEventListener('abort', releaseModel); resolve(); };
        request.signal?.addEventListener('abort', releaseModel, { once: true });
      });
      if (flow === 'error' && cycle === 3) throw Object.assign(new Error('Owned synthetic model transport failed after real receipts.'), { code: 'OWNED_MODEL_TRANSPORT_FAILED' });
      if (flow === 'approval' && cycle === 1) {
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'chat-approved-write', capabilityId: 'filesystem.write', arguments: '{"path":"approved.txt","content":"OWNER-APPROVED-FILE"}' }] } };
      } else if (flow === 'approval') {
        assert.ok(request.messages.some(row => row.tool_call_id === 'chat-approved-write' && row.content.includes('completed')));
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The approved owned file write returned its receipt.' }] } } };
      } else if (cycle === 1) {
        const synopsis = request.messages.map(row => { try { return JSON.parse(row.content); } catch { return null; } }).find(row => row?.representation === 'extractive-history-reference');
        assert.ok(synopsis?.sources.length, 'the actual Chat model request contains a retained-source projection');
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'chat-source-read', capabilityId: 'context.history.read', arguments: JSON.stringify({ sourceId: synopsis.sources[0].sourceId, maxChars: 3000 }) }] } };
      } else if (cycle === 2) {
        assert.ok(request.messages.some(row => row.tool_call_id === 'chat-source-read' && row.content.includes('ORIGINAL-CHAT-OWNER-0')), 'the same Run receives actual old Chat public text');
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'chat-file-read', capabilityId: 'filesystem.read', arguments: '{"path":"proof.txt"}' }] } };
      } else {
        assert.ok(request.messages.some(row => row.tool_call_id === 'chat-file-read' && row.content.includes('ACTUAL-CHAT-FILE-RECEIPT')));
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Read retained Chat history and the actual file.' }] } } };
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' }, ...(flow === 'native' ? { modelContinuation: { reasoningContent: 'PRIVATE-NATIVE-CONTINUATION', signature: 'opaque-fixture-signature' } } : {}) } };
    } });
  services.providerSecrets.set({ provider: 'chat-history-local', apiKey: 'synthetic-local-only' });
  coordinator = createToolExecutionCoordinator({ stateDir, modelRuntime: services.modelRuntime, capabilityBroker: broker,
    resolveHistoryContext: request => { ownerRequest = request; return chat.resolveModelHistoryContext(request); },
    onMessagesCheckpoint: payload => { checkpoints.push(structuredClone(payload)); return chat.checkpointModelHistory(payload); } });
  capabilities.setHistorySourceReader(request => { sourceReads++; return coordinator.readHistory(request); });
  const options = { stateDir: path.join(base, 'chat-owner'), defaults: {}, modelRuntime: services.modelRuntime, toolExecutionCoordinator: coordinator,
    modelCatalogRevision: async () => { if (metadataGate) { metadataEntered = true; await metadataGate; } return catalogRevision; },
    resolveWorkspace: id => services.workspaceService.describeWorkspace(id), resolveTask: id => services.taskService.runtime.get({ id }).task,
    onEvent: event => events.push(event),
    buildProductTurnContext: async request => ({ ...(await services.productContextService.buildForChatTurn(request)),
      manifest: broker.list().filter(row => ['context.history.read', 'filesystem.read', 'filesystem.write'].includes(row.id)), scope: { taskId: request.record.taskId ?? null, workspaceId: request.record.config.workspaceId ?? null } }) };
  chat = createChatService(options);
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'none', modelProvider: 'chat-history-local', model: 'fixture', workspaceId: workspace.id } } });
  const file = path.join(chat._store.historyDir, session.id + '.json');
  const originals = [];
  for (let i = 0; i < 40; i++) originals.push({ id: `owner-history-${i}`, role: 'user', text: `ORIGINAL-CHAT-OWNER-${i} ${'retained conversation detail. '.repeat(280)}`, at: i * 2, sourceWorkspaceId: workspace.id },
    { id: `assistant-history-${i}`, role: 'assistant', text: `Attributed historical reply ${i} ${'unverified historical detail. '.repeat(260)}`, at: i * 2 + 1, sourceWorkspaceId: workspace.id });
  writeJsonAtomic(file, { schemaVersion: 1, messages: originals });
  assert.ok(Buffer.byteLength(JSON.stringify(originals)) > 512 * 1024);
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'CURRENT OWNER: read the original history source, then proof.txt.', clientMessageId: 'owner-current-history' } });
  const status = await settled(session.id);
  assert.equal(status.lastState, 'idle', `actual Chat loop must complete: ${status.lastErrorCode} ${status.lastError}`);
  assert.equal(requests.length, 3); assert.equal(sourceReads, 1);
  const saved = readJsonFile(file);
  assert.deepEqual(saved.messages.slice(0, originals.length), originals, 'the previous original Chat history remains byte-for-byte data identical');
  assert.equal(saved.activeTurn, undefined, 'normal completion does not retain a full history copy in activeTurn');
  assert.ok(saved.messages.at(-1).modelMessages.some(row => row.tool_call_id === 'chat-file-read'));
  const publicHistory = await chat.execute({ method: 'chat.history', params: { id: session.id } });
  assert.ok(!JSON.stringify(publicHistory).includes('tool_call_id'));
  assert.ok(!JSON.stringify(publicHistory).includes('extractive-history-reference'));
  assert.ok(!JSON.stringify(events).includes('sourceFingerprint'));
  console.log(JSON.stringify({ fixture: 'actual-chat-owned-history-loop', originalBytes: Buffer.byteLength(JSON.stringify(originals)), outgoingBytes: Buffer.byteLength(JSON.stringify(requests[0])), sourceReads, modelRequests: requests.length, actualChat: true, actualBroker: true, liveModel: false }));

  flow = 'hold'; cycle = 0; releaseModel = null; ownerRequest = null;
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Hold this actual model request for source validation.' } });
  await until(() => releaseModel, Boolean, 'Held source validation request did not start');
  const bound = ownerRequest, active = readJsonFile(file).activeTurn;
  assert.ok(Buffer.byteLength(JSON.stringify(active.modelHistory)) < 128 * 1024, 'active envelope contains only current private tail and headers, not the 658KB prior history');
  assert.equal(active.modelHistory.protocol.length, 0);
  const context = await chat.resolveModelHistoryContext(bound);
  assert.equal(context.authorized, true);
  assert.ok((await context.resolveMessages()).some(row => row.content?.includes?.('ORIGINAL-CHAT-OWNER-0')));
  for (const changed of [{ actorKind: 'agent' }, { actorId: 'other-owner' }, { sessionId: 'other-chat' }, { turnId: 'other-turn' }, { targetKind: 'agent' }, { runId: 'invented-native-run' },
    { scope: { ...bound.scope, taskId: 'other-task' } }, { scope: { ...bound.scope, workspaceId: 'other-workspace' } }]) {
    await assert.rejects(chat.resolveModelHistoryContext({ ...bound, ...changed }), { code: 'CONTEXT_HISTORY_DENIED' });
  }
  const beforeEdit = readJsonFile(file), edited = structuredClone(beforeEdit);
  const missingPrivate = structuredClone(beforeEdit);
  delete missingPrivate.activeTurn.modelHistory.ownerContent;
  writeJsonAtomic(file, missingPrivate);
  await assert.rejects(async () => context.resolveMessages(), { code: 'CONTEXT_HISTORY_UNAVAILABLE' }, 'missing optional private original data is an explicit unavailable source');
  writeJsonAtomic(file, beforeEdit);
  edited.messages[1].text = edited.messages[1].text.replace('Attributed', 'Attributex');
  assert.equal(JSON.stringify(edited).length, JSON.stringify(beforeEdit).length);
  writeJsonAtomic(file, edited);
  await assert.rejects(chat.resolveModelHistoryContext(bound), { code: 'CONTEXT_SYNOPSIS_STALE' });
  await assert.rejects(async () => context.resolveMessages(), { code: 'CONTEXT_SYNOPSIS_STALE' });
  writeJsonAtomic(file, beforeEdit);
  const revision = (await chat.resolveModelHistoryContext(bound)).revision;
  catalogRevision++;
  assert.notEqual((await chat.resolveModelHistoryContext(bound)).revision, revision, 'real current model catalog/config revision invalidates old source authorization');
  const oldProjection = checkpoints.findLast(row => row.phase === 'request-projection');
  await assert.rejects(chat.checkpointModelHistory(oldProjection), { code: 'CONTEXT_SYNOPSIS_STALE' });
  catalogRevision--;
  releaseModel(); await settled(session.id);
  await assert.rejects(chat.resolveModelHistoryContext(bound), { code: 'CONTEXT_HISTORY_DENIED' }, 'a settled turn does not keep an active source grant');
  console.log('Chat source: exact Owner/Session/turn/Task/Workspace/config identity and same-length edit refusal with recovery after restoring real originals');

  flow = 'approval'; cycle = 0;
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Request the exact owned file write and wait for Owner approval.' } });
  const pendingStatus = await until(() => chat.execute({ method: 'chat.status', params: { id: session.id } }), row => row.turn?.state === 'waiting-approval', 'Actual write approval did not become pending');
  const approval = broker.approvals.get(pendingStatus.turn.approvalId), pendingPrivate = readJsonFile(file).activeTurn.modelHistory;
  assert.equal(pendingPrivate.protocol.at(-1).tool_calls[0].id, 'chat-approved-write');
  assert.equal(fs.existsSync(path.join(project, 'approved.txt')), false);
  const decision = await broker.decide({ id: approval.id, approve: true, actor: OWNER_ACTOR });
  await chat.resumeApproval({ approvalId: approval.id, requestFingerprint: approval.fingerprint, decisionResult: decision });
  assert.equal((await settled(session.id)).lastState, 'idle');
  assert.equal(fs.readFileSync(path.join(project, 'approved.txt'), 'utf8'), 'OWNER-APPROVED-FILE');
  assert.equal(readJsonFile(file).messages.at(-1).modelMessages.filter(row => row.tool_call_id === 'chat-approved-write').length, 1);
  console.log('Chat source: actual approval suspension/resume retains one exact tool pair and the approved real file receipt');

  flow = 'error'; cycle = 0;
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Retain real receipts if the final model transport fails.' } });
  assert.equal((await settled(session.id)).lastState, 'error');
  const failed = readJsonFile(file).messages.at(-1);
  assert.ok(failed.modelMessages.some(row => row.tool_call_id === 'chat-file-read' && row.content.includes('ACTUAL-CHAT-FILE-RECEIPT')));
  assert.equal(failed.modelHistory.available, false);
  flow = 'loop'; cycle = 0;
  await chat.execute({ method: 'chat.retry', params: { id: session.id } });
  assert.equal((await settled(session.id)).lastState, 'idle', 'explicit fresh retry uses retained original Owner history');
  assert.ok(readJsonFile(file).messages.some(row => row.id === failed.id && row.error));
  console.log('Chat source: final transport failure retains completed protocol; explicit retry keeps the failed evidence/history');

  const originalRename = fs.renameSync;
  let failOnce = true;
  fs.renameSync = function (from, to) {
    if (failOnce && path.resolve(to) === path.resolve(file)) {
      const next = readJsonFile(from);
      if (next.activeTurn?.modelHistory?.protocol.some(row => row.tool_call_id === 'chat-source-read')) { failOnce = false; throw Object.assign(new Error('Owned checkpoint writer unavailable'), { code: 'EIO' }); }
    }
    return originalRename.apply(this, arguments);
  };
  flow = 'loop'; cycle = 0;
  try {
    await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Exercise an actual atomic checkpoint write failure.' } });
    const failedStatus = await settled(session.id);
    assert.equal(failedStatus.lastErrorCode, 'CONTEXT_HISTORY_CHECKPOINT_PERSIST_FAILED');
  } finally { fs.renameSync = originalRename; }
  const ioFailed = readJsonFile(file).messages.at(-1);
  assert.ok(ioFailed.modelMessages.some(row => row.tool_call_id === 'chat-source-read'));
  assert.equal(ioFailed.modelHistory.available, false);
  const ioReceipt = Object.values(readJsonFile(path.join(stateDir, 'model', 'tool-executions.json'))).filter(row => row.turnId === ioFailed.turnId);
  assert.deepEqual(ioReceipt.map(row => row.status), ['completed']);
  await assert.rejects(coordinator.run({ actor: OWNER_ACTOR, sessionId: session.id, turnId: ioFailed.turnId, messages: [] }), { code: 'REQUEST_RECOVERY_REQUIRED' });
  console.log('Chat source: real atomic writer failure retains accepted journal/model receipt and refuses same-turn replay');

  flow = 'native'; cycle = 0;
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Retain protocol-private continuation metadata only in private history.' } });
  assert.equal((await settled(session.id)).lastState, 'idle');
  const privateNative = readJsonFile(file).messages.at(-1);
  assert.ok(JSON.stringify(privateNative.modelMessages).includes('PRIVATE-NATIVE-CONTINUATION'));
  assert.ok(!JSON.stringify(await chat.execute({ method: 'chat.history', params: { id: session.id } })).includes('PRIVATE-NATIVE-CONTINUATION'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE-NATIVE-CONTINUATION'));
  console.log('Chat source: opaque provider continuation remains private and exact without becoming an ordinary history page or public reasoning');

  flow = 'hold'; cycle = 0; releaseModel = null;
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Stop while the current source metadata check awaits.' } });
  await until(() => releaseModel, Boolean, 'Cancellation source request did not reach the actual model');
  const beforeStop = await chat.resolveModelHistoryContext(ownerRequest);
  currentModelSignal.removeEventListener('abort', releaseModel); // controlled leaf temporarily ignores abort; it is explicitly drained below.
  let releaseMetadata; metadataEntered = false;
  metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  const pendingContext = chat.resolveModelHistoryContext(ownerRequest);
  await until(() => metadataEntered, Boolean, 'Source metadata check did not await');
  await chat.execute({ method: 'chat.stop', params: { id: session.id } });
  releaseMetadata(); metadataGate = null;
  try {
    await assert.rejects(pendingContext, { code: 'CONTEXT_HISTORY_DENIED' }, 'stop during an actual metadata await revokes source access before return');
    await assert.rejects(async () => beforeStop.resolveMessages(), { code: 'CONTEXT_HISTORY_DENIED' }, 'an earlier source getter cannot outlive cancellation');
  } finally { releaseModel(); await settled(session.id); }
  console.log('Chat source: cancellation during awaited current metadata revokes both in-flight resolution and an older getter');

  let releaseRead, readEntered = false;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let cold;
  await observeReads(project, async () => {
    flow = 'restart'; cycle = 0;
    await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'Retain the actual call before this real file read settles.' } });
    await until(() => readEntered, Boolean, 'The actual FileHandle read was not admitted');
    const current = readJsonFile(file), activeProtocol = current.activeTurn.modelHistory.protocol;
    assert.equal(activeProtocol.at(-1).tool_calls[0].id, 'chat-file-read');
    assert.ok(!activeProtocol.some(row => row.tool_call_id === 'chat-file-read'), 'an unfinished actual source has no invented receipt');
    const copiedChat = path.join(base, 'restarted-chat'), copiedExecution = path.join(base, 'restarted-execution');
    fs.cpSync(options.stateDir, copiedChat, { recursive: true });
    fs.mkdirSync(path.join(copiedExecution, 'model'), { recursive: true });
    fs.copyFileSync(path.join(stateDir, 'model', 'tool-executions.json'), path.join(copiedExecution, 'model', 'tool-executions.json'));
    const coldCapabilities = createCapabilityService({ stateDir: path.join(base, 'restarted-capability'), workspaceService: services.workspaceService, taskRuntime: services.taskService.runtime });
    const coldCoordinator = createToolExecutionCoordinator({ stateDir: copiedExecution, modelRuntime: services.modelRuntime, capabilityBroker: coldCapabilities.broker });
    const reached = requests.length;
    cold = createChatService({ ...options, stateDir: copiedChat, toolExecutionCoordinator: coldCoordinator });
    const interruptedFile = path.join(cold._store.historyDir, session.id + '.json'), interruptedStore = readJsonFile(interruptedFile);
    assert.equal(interruptedStore.activeTurn, undefined);
    const interrupted = interruptedStore.messages.at(-1);
    assert.equal(interrupted.interrupted, true); assert.equal(interrupted.modelHistory.available, false);
    assert.deepEqual(interrupted.modelHistory.protocol, activeProtocol, 'reconstruction preserves exact current private originals, including the missing actual result');
    assert.equal(coldCoordinator.recoveryForSession(session.id).state, 'needs-reconciliation');
    await assert.rejects(cold.resolveModelHistoryContext(ownerRequest), { code: 'CONTEXT_HISTORY_DENIED' });
    await assert.rejects(coldCoordinator.run({ actor: OWNER_ACTOR, sessionId: session.id, turnId: 'no-unknown-replay', messages: [] }), { code: 'REQUEST_RECOVERY_REQUIRED' });
    const visible = await cold.execute({ method: 'chat.history', params: { id: session.id } });
    assert.ok(!JSON.stringify(visible).includes('modelHistory')); assert.ok(!JSON.stringify(visible).includes('tool_calls'));
    await cold.close(); cold = null;
    const again = createChatService({ ...options, stateDir: copiedChat, toolExecutionCoordinator: coldCoordinator });
    assert.equal(readJsonFile(interruptedFile).messages.length, interruptedStore.messages.length, 'repeated load does not duplicate the interrupted envelope');
    await again.close(); assert.equal(requests.length, reached, 'loading/status/history never replays a model/tool request');
    releaseRead(); await settled(session.id);
    assert.equal(coldCoordinator.recoveryForSession(session.id).state, 'needs-reconciliation', 'another running Core completion does not rewrite the frozen unknown recovery evidence');
  }, { holdMs: 0, beforeRead: async () => { readEntered = true; await readGate; } }).finally(async () => { releaseRead(); await cold?.close(); });
  console.log('Chat source: real in-flight read snapshot preserves exact private call, repeated restart is idempotent and unknown recovery never replays');

  for (const useCoordinator of [false, true]) {
    const providerId = useCoordinator ? 'history-text-only' : 'chat-history-local';
    if (useCoordinator) {
      services.modelRegistry.register({ id: providerId, label: 'Owned unsupported-tool leaf', defaultModel: 'fixture', supportsTools: false,
        listModels: async () => [{ id: 'fixture' }], health: async () => ({ available: true }), chat: async () => { throw Error('Byte guard must precede this leaf'); },
        stream: async function* () { throw Error('Byte guard must precede this leaf'); } });
      services.providerSecrets.set({ provider: providerId, apiKey: 'synthetic-local-only' });
    }
    const direct = createChatService({ ...options, stateDir: path.join(base, useCoordinator ? 'text-only-chat' : 'direct-chat'), toolExecutionCoordinator: useCoordinator ? coordinator : null });
    try {
      const entry = await direct.execute({ method: 'chat.sessions.create', params: {} });
      await direct.execute({ method: 'chat.config.set', params: { id: entry.id, config: { modelProvider: providerId, model: 'fixture', agentProvider: 'none', workspaceId: workspace.id } } });
      writeJsonAtomic(path.join(direct._store.historyDir, entry.id + '.json'), { schemaVersion: 1, messages: originals });
      const reached = requests.length;
      await direct.execute({ method: 'chat.send', params: { id: entry.id, text: 'Keep the direct legacy transport guard.' } }).catch(error => assert.equal(error.code, 'CONTEXT_BUDGET_EXCEEDED'));
      const terminal = await until(() => direct.execute({ method: 'chat.status', params: { id: entry.id } }), row => !row.turn, 'Direct guarded turn did not settle');
      assert.equal(terminal.lastErrorCode, 'CONTEXT_BUDGET_EXCEEDED'); assert.equal(requests.length, reached);
    } finally { await direct.close(); }
  }
  console.log('Chat source: direct and unsupported-tool callers retain the existing complete transport guard');

  // A legacy v1 linked-Chat fixture uses the real Task runtime as authority,
  // rather than declaring a Task in a callback or tool parameter.
  await chat.close();
  const task = services.taskService.runtime.create({ goal: 'Original Task source goal.', workspaceId: workspace.id });
  const taskOptions = { ...options, stateDir: path.join(base, 'task-chat-owner') };
  chat = createChatService(taskOptions);
  const taskSession = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: taskSession.id, config: { agentProvider: 'none', modelProvider: 'chat-history-local', model: 'fixture', workspaceId: workspace.id } } });
  const linked = readJsonFile(chat._store.sessionsFile);
  linked.sessions.find(row => row.id === taskSession.id).taskId = task.id;
  writeJsonAtomic(chat._store.sessionsFile, linked);
  writeJsonAtomic(path.join(chat._store.historyDir, taskSession.id + '.json'), { schemaVersion: 1, messages: originals });
  await chat.close(); chat = createChatService(taskOptions);
  flow = 'hold'; cycle = 0; releaseModel = null;
  await chat.execute({ method: 'chat.send', params: { id: taskSession.id, text: 'Validate actual current Task identity before source access.' } });
  await until(() => releaseModel, Boolean, 'Actual Task-linked source request did not reach the model');
  const taskRequest = ownerRequest, taskContext = await chat.resolveModelHistoryContext(taskRequest);
  assert.equal(taskContext.task.id, task.id);
  assert.equal(taskContext.task.goal, 'Original Task source goal.');
  let releaseTaskMetadata; metadataEntered = false;
  metadataGate = new Promise(resolve => { releaseTaskMetadata = resolve; });
  const validatingTask = chat.resolveModelHistoryContext(taskRequest);
  await until(() => metadataEntered, Boolean, 'Task authority check did not await real metadata');
  let changed = services.taskService.runtime.update({ id: task.id, expectedRev: task.rev, goal: 'Changed actual Task source goal.' });
  releaseTaskMetadata(); metadataGate = null;
  const validatedTask = await validatingTask;
  assert.equal(validatedTask.task.goal, changed.goal, 'the final metadata await must be followed by a fresh actual Task snapshot');
  assert.notEqual(validatedTask.revision, taskContext.revision);
  await assert.rejects(async () => taskContext.resolveMessages(), { code: 'CONTEXT_SYNOPSIS_STALE' }, 'a previous getter cannot retain old Task authority');
  const catalogContext = await chat.resolveModelHistoryContext(taskRequest); catalogRevision++;
  await assert.rejects(async () => catalogContext.resolveMessages(), { code: 'CONTEXT_SYNOPSIS_STALE' }, 'a previous getter cannot retain old catalog authority');
  catalogRevision--;
  assert.notEqual((await chat.resolveModelHistoryContext(taskRequest)).revision, taskContext.revision, 'actual Task authorization revision invalidates old source authority');
  const otherProject = path.join(base, 'other-project'); fs.mkdirSync(otherProject);
  const otherWorkspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: otherProject, name: 'Other actual Workspace' } })).workspace;
  changed = services.taskService.runtime.update({ id: task.id, expectedRev: changed.rev, workspaceId: otherWorkspace.id });
  await assert.rejects(async () => taskContext.resolveMessages(), { code: 'CONTEXT_HISTORY_DENIED' }, 'a previous getter cannot read after actual Task Workspace relocation');
  await assert.rejects(chat.resolveModelHistoryContext(taskRequest), { code: 'CONTEXT_HISTORY_DENIED' }, 'actual Task relocation cannot borrow the Chat Workspace source');
  services.taskService.runtime.update({ id: task.id, expectedRev: changed.rev, workspaceId: workspace.id });
  await chat.execute({ method: 'chat.stop', params: { id: taskSession.id } });
  releaseModel(); await settled(taskSession.id);
  await assert.rejects(chat.execute({ method: 'chat.config.set', params: { id: taskSession.id, config: { workspaceId: otherWorkspace.id } } }), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' },
    'the existing Task-bound Workspace transition guard stays authoritative');
  await chat.execute({ method: 'chat.config.set', params: { id: taskSession.id, config: { mode: 'smart' } } });
  await assert.rejects(chat.resolveModelHistoryContext(taskRequest), { code: 'CONTEXT_HISTORY_DENIED' }, 'a former turn cannot reuse authority after actual Chat configuration changes');
  console.log('Chat source: real Task goal/Workspace transitions and later Chat configuration changes cannot reuse old source identity');
} finally {
  await chat?.close(); await services.close?.();
  assert.equal(path.dirname(base), parent); assert.ok(path.basename(base).startsWith('cetamesh-chat-history-'));
  fs.rmSync(base, { recursive: true, force: true });
}
