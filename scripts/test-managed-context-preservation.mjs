import assert from 'node:assert/strict';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';
const principal = { taskId:'t', workspaceId:'w', actor:{kind:'agent',id:'a',grants:{taskIds:['t'],workspaceIds:['w'],capabilities:['filesystem.read']}}};
let calls=0;
const runtime = createManagedAgentProvider({taskPrincipalResolver:()=>principal,
 modelRuntime:{chat:async request => {
   if (++calls === 1) return {text:JSON.stringify({capability:'filesystem.read',input:{path:'x'}})};
   const reference = JSON.parse(request.messages.at(-1).content);
   assert.equal(reference.result.result.content.endsWith('FINAL_EVIDENCE'), true);
   return {text:JSON.stringify({final:'Evidence retained'})};
 }}, capabilityExecutor: async()=>({status:'completed',result:{content:'x'.repeat(70000)+'FINAL_EVIDENCE'}})});
const {sessionId}=await runtime.provider.createSession({});
const accepted=await runtime.provider.send({sessionId,content:'Keep evidence'});
for await (const event of runtime.provider.follow({sessionId})) {
 if(event.type==='turn/end' && event.data.requestId===accepted.requestId) {
  assert.equal(event.data.reason.kind,'completed',JSON.stringify(event.data.reason)); break;
 }
}
assert.equal(calls,2);
console.log('managed context preservation passed');

// Production composition, real owner storage/Broker, deterministic local model only.
const fs = (await import('node:fs')).default;
const os = (await import('node:os')).default;
const path = (await import('node:path')).default;
const crypto = await import('node:crypto');
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-managed-history-')));
const oldData = process.env.WHALEBRIDGE_DATA_DIR;
process.env.WHALEBRIDGE_DATA_DIR = path.join(base, 'data');
const { createCetaMeshServices } = await import('../src/app/service-container.js');
const stateDir = path.join(base, 'state'), project = path.join(base, 'project'); fs.mkdirSync(project);
const retainedFile = id => path.join(stateDir, 'agent', 'managed-history', crypto.createHash('sha256').update(id).digest('hex') + '.json');
let services, taskId, workspaceId, mode = 'ordinary', sourceReads = 0, modelCalls = 0;
const outgoing = [];
function compose() {
  const value = createCetaMeshServices({ stateDir, dataRoot: path.join(base, 'data'), config: { allow: { private: [], groups: [] } }, deferOptionalStart: true });
  value.modelRegistry.register({ id: 'managed-history-local', label: 'Local synthetic history fixture', defaultModel: 'fixture', supportsTools: true,
    contextCapabilities: () => ({ status: 'declared', contextWindowTokens: 300000, maxOutputTokens: 2048, defaultOutputTokens: 1000, source: 'owned-fixture', version: '1' }),
    health: async () => ({ available: true }), listModels: async () => [{ id: 'fixture' }], chat: async () => { throw Error('Unexpected chat fallback'); },
    stream: async function* (request) {
      modelCalls++; outgoing.push(structuredClone(request.messages));
      const synopsis = request.messages.map(row => { try { return JSON.parse(row.content); } catch { return null; } }).find(row => row?.representation === 'extractive-history-reference');
      if (mode === 'gate-pending') {
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'pending-gap-write', capabilityId: 'filesystem.write', arguments: JSON.stringify({ path: 'gate.txt', expectedHash: crypto.createHash('sha256').update('before').digest('hex'), content: 'after' }) }] } };
      } else if (['dispatch-failure', 'settled-failure'].includes(mode)) {
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'failure-file-read', capabilityId: 'filesystem.read', arguments: '{"path":"proof.txt"}' }] } };
      } else if (mode === 'retrieve' && !request.messages.some(row => row.tool_call_id === 'retained-source-read')) {
        assert.ok(synopsis?.sources?.length, 'actual Managed request must compact old complete turns through retained sources');
        sourceReads++;
        yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'retained-source-read', capabilityId: 'context.history.read', arguments: JSON.stringify({ sourceId: synopsis.sources[0].sourceId, maxChars: 3000 }) }] } };
      } else {
        if (mode === 'gap') {
          const gap = request.messages.map(row => { try { return JSON.parse(row.content); } catch { return null; } }).find(row => row?.representation === 'retained-history-gap');
          assert.ok(gap?.retainedOriginal && gap?.noReplay, 'fresh Task-only continuation explicitly reports retained source gap');
          assert.ok(!JSON.stringify(request.messages).includes('synthetic-private-protocol'));
          assert.ok(!request.messages.some(row => row.tool_calls || row.role === 'tool'), 'omitted old tool stack is not reconstructed');
          assert.ok(!JSON.stringify(request.messages).includes('MANAGED-ORIGINAL-0'), 'Task-only gap does not invent recovered original content');
        }
        if (mode === 'retrieve') assert.ok(request.messages.find(row => row.tool_call_id === 'retained-source-read')?.content.includes('MANAGED-ORIGINAL-0'), 'real Core Broker returns exact retained source text');
        if (mode === 'cold') assert.ok(request.messages.some(row => row.tool_call_id === 'retained-source-read'), 'fresh same-Task session receives actual settled receipt after cold restart');
        yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: mode === 'ordinary' ? 'Historical attributed answer. '.repeat(700) : 'Completed local history fixture.' }] } } };
      }
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  value.providerSecrets.set({ provider: 'managed-history-local', apiKey: 'synthetic-local-only' });
  return value;
}
async function closeCore(value) {
  if (!value) return;
  await value.managedAgent.close();
  await Promise.all([value.chatService.close(), value.agentService.close(), value.pluginCenterService.close(), value.extensionService.close(), value.capabilityService.close()]);
}
async function createAttached() {
  const created = await services.managedAgent.provider.createSession({ modelProvider: 'managed-history-local', model: 'fixture' });
  const task = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: created.sessionId });
  return created.sessionId;
}
async function sendTurn(id, content) {
  const accepted = await services.managedAgent.provider.send({ sessionId: id, content });
  for await (const event of services.managedAgent.provider.follow({ sessionId: id, signal: AbortSignal.timeout(15000) })) {
    if (event.type === 'turn/end' && event.data.requestId === accepted.requestId) return event.data.reason;
  }
  throw Error('Managed turn did not settle');
}
try {
  const { createManagedHistorySource: createOrderedStore } = await import('../src/agent/managed-history-source.js');
  const orderedStore = createOrderedStore({ stateDir });
  const orderedBinding = { sessionId: 'ordered-source', taskId: 'ordered-task', workspaceId: 'ordered-workspace', actorKind: 'agent', actorId: 'ordered-agent' };
  const orderedBody = [
    { role: 'user', content: 'Preserve Core feedback at its original position.' },
    { role: 'system', content: 'Core feedback before tool dispatch' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'ordered-read', type: 'function', function: { name: 'filesystem.read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'ordered-read', content: '{"status":"completed"}' },
    { role: 'system', content: 'Core feedback after tool settlement' },
    { role: 'assistant', content: 'Finished.' }
  ];
  const orderedPayload = { binding: orderedBinding, turnId: 'ordered-turn', revision: 'a'.repeat(64), phase: 'turn-complete', pendingCallIds: [],
    messages: [{ role: 'system', content: 'Old dynamic header' }, ...orderedBody] };
  orderedStore.write(orderedPayload);
  const orderedBytes = fs.readFileSync(retainedFile(orderedBinding.sessionId));
  for (const change of ['tamper', 'reorder', 'promote-to-header']) {
    const messages = structuredClone(orderedPayload.messages);
    if (change === 'tamper') messages[2].content += ' changed';
    if (change === 'reorder') [messages[2], messages[5]] = [messages[5], messages[2]];
    if (change === 'promote-to-header') messages.splice(0, 0, messages.splice(2, 1)[0]);
    assert.throws(() => orderedStore.write({ ...orderedPayload, messages }), { code: 'CONTEXT_SYNOPSIS_STALE' }, change);
    assert.deepEqual(fs.readFileSync(retainedFile(orderedBinding.sessionId)), orderedBytes);
  }
  const refreshed = orderedStore.write({ ...orderedPayload, messages: [{ role: 'system', content: 'Current authorized dynamic header' }, ...orderedBody] });
  assert.deepEqual(refreshed.messages.slice(1), orderedBody, 'only the leading dynamic header may refresh');
  services = compose();
  workspaceId = (await services.workspaceService.execute({ method: 'workspace.create', params: { name: 'Managed history isolated fixture', root: project } })).workspace.id;
  taskId = services.taskService.runtime.create({ goal: 'Preserve history with current Task authorization.', workspaceId }).id;
  services.capabilityService.grantTask(taskId, { capabilities: ['context.history.read', 'filesystem.read'] });
  const first = await createAttached();
  assert.equal((await sendTurn(first, 'MANAGED-ORIGINAL-0: ' + 'Original public reference. '.repeat(700))).kind, 'completed');
  assert.ok(fs.existsSync(retainedFile(first)), 'Managed owner must durably checkpoint its raw transcript');
  for (let index = 1; index < 14; index++) { const reason = await sendTurn(first, `MANAGED-ORIGINAL-${index}: ` + 'Original public reference. '.repeat(700)); assert.equal(reason.kind, 'completed', JSON.stringify({ index, reason })); }
  mode = 'retrieve';
  const reason = await sendTurn(first, 'Read the first original retained source.');
  assert.equal(reason.kind, 'completed', JSON.stringify(reason));
  // A completed raw source may contain Core system feedback between settled
  // protocol messages. Cold hydration and the next turn must keep its position.
  const completed = JSON.parse(fs.readFileSync(retainedFile(first)));
  const coldFeedback = { role: 'system', content: 'CetaMesh post-write verification feedback (JSON reference data):\n'
    + JSON.stringify({ kind: 'post-write-verification', state: 'not-run', code: 'POST_WRITE_NOT_CONFIGURED', sourceWriteIds: ['settled-write'], configDigest: null, operationRef: null }) };
  createOrderedStore({ stateDir }).write({ ...completed, messages: [...completed.messages, coldFeedback] });
  const sourceBytes = fs.readFileSync(retainedFile(first));
  const source = JSON.parse(sourceBytes);
  assert.equal(source.phase, 'turn-complete');
  assert.ok(source.messages.some(row => row.content?.startsWith?.('MANAGED-ORIGINAL-0:')));
  assert.ok(source.messages.some(row => row.tool_call_id === 'retained-source-read'));
  assert.equal(sourceReads, 1);
  await closeCore(services); services = null;
  services = compose(); mode = 'cold';
  const second = await createAttached();
  const cold = await sendTurn(second, 'Continue the same Task from retained observed history.');
  assert.equal(cold.kind, 'completed', JSON.stringify(cold));
  assert.deepEqual(fs.readFileSync(retainedFile(first)), sourceBytes, 'cold source remains byte-identical');
  assert.ok(fs.existsSync(retainedFile(second)), 'fresh session owns its newly authorized source envelope');
  const coldBodyStart = source.messages.findIndex(row => row.role !== 'system');
  const coldBody = source.messages.slice(coldBodyStart);
  const assertRetainedBody = () => {
    const messages = JSON.parse(fs.readFileSync(retainedFile(second))).messages;
    const start = messages.findIndex(row => row.role !== 'system');
    assert.deepEqual(messages.slice(start, start + coldBody.length), coldBody, 'completed and subsequent turns retain exact cold body, including system feedback');
    const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(digest(messages.slice(start, start + coldBody.length)), digest(coldBody), 'cold and subsequent body JSON hashes remain exact');
  };
  assertRetainedBody();
  assert.equal((await sendTurn(second, 'Continue once more without replaying historical tools.')).kind, 'completed');
  assertRetainedBody();
  assert.equal(sourceReads, 1, 'cold and subsequent turns never replay the retained history-read tool');
  const { fingerprintHistorySource } = await import('../src/context/history-synopsis.js');
  const { createManagedHistorySource, MANAGED_HISTORY_MAX_BYTES } = await import('../src/agent/managed-history-source.js');
  const ownerStore = createManagedHistorySource({ stateDir });
  function encodeSource(row) {
    row.sourceFingerprint = fingerprintHistorySource({ messages: row.messages, sourceBinding: row.binding });
    delete row.integrity;
    row.integrity = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
    return JSON.stringify(row);
  }
  // Prior versions could promote actual Core feedback into the header even in
  // a completed envelope. Its original position cannot be reconstructed safely.
  const legacyOrdered = structuredClone(source);
  legacyOrdered.messages.splice(1, 0, { role: 'system', content: 'CetaMesh post-write verification feedback (JSON reference data):\n'
    + JSON.stringify({ kind: 'post-write-verification', state: 'not-run', code: 'POST_WRITE_NOT_CONFIGURED', sourceWriteIds: ['legacy-write'], configDigest: null, operationRef: null }) });
  const legacyOrderedBytes = encodeSource(legacyOrdered);
  fs.writeFileSync(retainedFile(first), legacyOrderedBytes);
  let legacyTask = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: legacyTask.rev, provider: 'cetamesh', sessionId: first });
  const legacyOrderSession = await createAttached(); mode = 'gap';
  const legacyCalls = modelCalls, savedStatus = services.agentBroker.status;
  for (const status of [{ running: true }, { running: false, state: 'unknown' }]) {
    services.agentBroker.status = async assignment => assignment.sessionId === first ? status : savedStatus(assignment);
    try { assert.equal((await sendTurn(legacyOrderSession, 'Do not use malformed order as stop proof.')).error.code, 'REQUEST_RECOVERY_REQUIRED'); }
    finally { services.agentBroker.status = savedStatus; }
    assert.equal(modelCalls, legacyCalls);
  }
  fs.writeFileSync(path.join(project, 'legacy-order-gate.txt'), 'before');
  const { OWNER_ACTOR: legacyOwner } = await import('../src/capability/types.js');
  const legacyApproval = await services.capabilityService.broker.execute({ requestId: 'legacy-order-pending', actor: legacyOwner,
    taskId, workspaceId, capability: 'filesystem.write', input: { path: 'legacy-order-gate.txt', expectedHash: crypto.createHash('sha256').update('before').digest('hex'), content: 'after' } });
  assert.equal(legacyApproval.status, 'pending');
  assert.equal((await sendTurn(legacyOrderSession, 'Do not use malformed order to bypass approval.')).error.code, 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(modelCalls, legacyCalls);
  services.capabilityService.broker.approvals.cancel(legacyApproval.approvalId, 'owned-legacy-order-fixture');
  assert.equal((await sendTurn(legacyOrderSession, 'Gates clear; continue from current Task with an explicit order gap.')).kind, 'completed');
  const legacyGap = JSON.parse(fs.readFileSync(retainedFile(legacyOrderSession))).historyGap;
  assert.equal(legacyGap.reason, 'legacy-transcript-order');
  assert.equal(legacyGap.retainedOrigin.sourceFingerprint, legacyOrdered.sourceFingerprint);
  assert.equal(legacyGap.sourcePhase, 'turn-complete', 'gap classification never rewrites the old completion fact');
  assert.equal(legacyGap.noReplay, true);
  assert.equal(fs.readFileSync(retainedFile(first), 'utf8'), legacyOrderedBytes);
  assert.equal(fs.readFileSync(path.join(project, 'legacy-order-gate.txt'), 'utf8'), 'before');
  const inheritedLegacy = await createAttached();
  assert.equal((await sendTurn(inheritedLegacy, 'Retain the original order-gap provenance.')).kind, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(retainedFile(inheritedLegacy))).historyGap.retainedOrigin.sourceFingerprint, legacyOrdered.sourceFingerprint);
  assert.equal(fs.readFileSync(retainedFile(first), 'utf8'), legacyOrderedBytes);
  fs.writeFileSync(retainedFile(first), sourceBytes); mode = 'cold';
  console.log('PASS completed legacy promoted feedback remains byte-identical; active/unknown/pending gates refuse and cleared fresh continuation retains explicit order gap without replay');
  const settingsFile = services.settingsService.store.file;
  const settingsBefore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const rejected = [];
  // An incomplete source is reference loss, not independent execution authority.
  const incomplete = structuredClone(source); incomplete.phase = 'settled-transcript';
  incomplete.messages.push({ role: 'assistant', content: '', modelContinuation: { private: 'synthetic-private-protocol' } });
  const incompleteBytes = encodeSource(incomplete);
  fs.writeFileSync(retainedFile(first), incompleteBytes);
  let gapTask = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: gapTask.rev, provider: 'cetamesh', sessionId: first });
  assert.equal(services.toolExecutionCoordinator.recoveryForTask(taskId), null);
  assert.equal(services.capabilityService.recoveryForTask(taskId), null);
  const directGap = await createAttached(); mode = 'gap';
  assert.equal((await sendTurn(directGap, 'Inspect current Task evidence without reconstructing the interrupted protocol.')).kind, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(retainedFile(directGap))).historyGap.retainedOrigin.sourceFingerprint, incomplete.sourceFingerprint);
  gapTask = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: gapTask.rev, provider: 'cetamesh', sessionId: first });
  const missingReplacement = await createAttached();
  // Aborted replacement has no envelope; another missing replacement cannot hide
  // the older known source behind a false legacy/no-file interpretation.
  await createAttached();
  const gapSession = await createAttached(); mode = 'gap';
  const gapResult = await sendTurn(gapSession, 'Continue from current Task and inspect the actual workspace; do not replay old effects.');
  assert.equal(gapResult.kind, 'completed', JSON.stringify(gapResult));
  const gapEnvelope = JSON.parse(fs.readFileSync(retainedFile(gapSession)));
  assert.equal(gapEnvelope.derivedFrom.sessionId, first);
  assert.equal(gapEnvelope.historyGap.retainedOrigin.sourceFingerprint, incomplete.sourceFingerprint);
  assert.ok(gapEnvelope.historyGap.skippedSessionIds.includes(missingReplacement));
  assert.equal(fs.readFileSync(retainedFile(first), 'utf8'), incompleteBytes);
  const repeatedGap = await createAttached();
  assert.equal((await sendTurn(repeatedGap, 'Continue with the same explicit source gap.')).kind, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(retainedFile(repeatedGap))).historyGap.retainedOrigin.sourceFingerprint, incomplete.sourceFingerprint);
  fs.writeFileSync(path.join(project, 'gate.txt'), 'before');
  const originalTaskId = taskId;
  taskId = services.taskService.runtime.create({ goal: 'Exercise current pending and unknown effect gates.', workspaceId }).id;
  services.capabilityService.grantTask(taskId, { capabilities: ['context.history.read', 'filesystem.read', 'filesystem.write'] });
  mode = 'gate-pending';
  const pendingSession = await createAttached();
  const waiting = await sendTurn(pendingSession, 'Request one controlled write to gate.txt.');
  assert.equal(waiting.kind, 'waiting', JSON.stringify(waiting));
  const pendingSource = fs.readFileSync(retainedFile(pendingSession));
  const approval = services.capabilityService.broker.approvals.get(waiting.approvalId);
  const blockedByPending = await createAttached(); mode = 'gap';
  let beforeGateCalls = modelCalls;
  assert.equal((await sendTurn(blockedByPending, 'A fresh session cannot erase a pending approval.')).error.code, 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(modelCalls, beforeGateCalls);
  // Use the production unknown-outcome receipt API; no write is executed by
  // this adverse fixture. The real journal and recovery gates own the refusal.
  services.toolExecutionCoordinator.recordApprovalOutcomeUnknown({ approvalId: approval.id, requestFingerprint: approval.fingerprint,
    decisionResult: { status: 'outcome-unknown', error: { code: 'OWNED_FIXTURE_UNKNOWN' } } });
  await services.managedAgent.provider.cancel({ sessionId: pendingSession });
  assert.equal(services.toolExecutionCoordinator.recoveryForTask(taskId).state, 'needs-reconciliation');
  const blockedByUnknown = await createAttached();
  assert.equal((await sendTurn(blockedByUnknown, 'Unknown effects still require existing recovery.')).error.code, 'REQUEST_RECOVERY_REQUIRED');
  assert.equal(modelCalls, beforeGateCalls);
  assert.equal(fs.readFileSync(path.join(project, 'gate.txt'), 'utf8'), 'before');
  services.toolExecutionCoordinator.acknowledgeTaskRecovery(taskId);
  services.capabilityService.acknowledgeTaskRecovery(taskId);
  assert.equal(services.toolExecutionCoordinator.recoveryForTask(taskId), null);
  assert.equal((await sendTurn(blockedByUnknown, 'Existing recovery is clear; inspect current Task context with an explicit source gap.')).kind, 'completed');
  assert.deepEqual(fs.readFileSync(retainedFile(pendingSession)), pendingSource, 'risk reconciliation does not rewrite an incomplete raw envelope');
  taskId = originalTaskId;
  // Change a real approval gate while a historical Session stop lookup awaits.
  gapTask = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: gapTask.rev, provider: 'cetamesh', sessionId: first });
  const raceSession = await createAttached();
  const originalStatus = services.agentBroker.status;
  let raceApproval;
  services.agentBroker.status = async assignment => {
    if (assignment.sessionId === first && !raceApproval) {
      const { OWNER_ACTOR } = await import('../src/capability/types.js');
      raceApproval = await services.capabilityService.broker.execute({ requestId: 'gap-lookup-race', actor: OWNER_ACTOR,
        taskId, workspaceId, capability: 'filesystem.write', input: { path: 'gate.txt', expectedHash: crypto.createHash('sha256').update('before').digest('hex'), content: 'raced' } });
      assert.equal(raceApproval.status, 'pending');
    }
    return originalStatus(assignment);
  };
  beforeGateCalls = modelCalls;
  try { assert.equal((await sendTurn(raceSession, 'Race must not reuse an earlier clear gate.')).error.code, 'REQUEST_RECOVERY_REQUIRED'); }
  finally { services.agentBroker.status = originalStatus; }
  assert.equal(modelCalls, beforeGateCalls);
  services.capabilityService.broker.approvals.cancel(raceApproval.approvalId, 'owned-race-fixture-complete');
  assert.equal((await sendTurn(raceSession, 'Now current approval gates are clear.')).kind, 'completed');
  assert.equal(fs.readFileSync(retainedFile(first), 'utf8'), incompleteBytes);
  console.log(JSON.stringify({ fixture: 'managed-history-safe-gap', actualCore: true, immediateIncompleteContinues: true,
    skippedReplacementCount: gapEnvelope.historyGap.skippedSessionIds.length, persistedOrigin: gapEnvelope.historyGap.retainedOrigin.sourceFingerprint,
    pendingAndUnknownRefusedBeforeModel: true, gateChangeRaceRefused: true, reconciledIncompleteContinues: true, oldSourceUnchanged: true }));
  fs.writeFileSync(retainedFile(first), sourceBytes); mode = 'cold';
  for (const scenario of ['corrupt', 'future-version', 'content-hash', 'binding', 'pending-pair', 'unknown-effect']) {
    const altered = structuredClone(source);
    let bytes;
    if (scenario === 'corrupt') bytes = '{invalid';
    if (scenario === 'future-version') { altered.schemaVersion = 2; bytes = encodeSource(altered); }
    if (scenario === 'content-hash') { altered.messages[0].content += 'changed'; bytes = JSON.stringify(altered); }
    if (scenario === 'binding') { altered.binding.taskId = 'unrelated-task'; bytes = encodeSource(altered); }
    if (scenario === 'pending-pair') {
      altered.phase = 'tool-calls'; altered.pendingCallIds = ['pending-native'];
      altered.messages.push({ role: 'assistant', content: '', modelContinuation: { private: 'synthetic-private-protocol' }, tool_calls: [{ id: 'pending-native', type: 'function', function: { name: 'filesystem.read', arguments: '{}' } }] });
      bytes = encodeSource(altered);
    }
    if (scenario === 'unknown-effect') {
      altered.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'unknown-call', type: 'function', function: { name: 'filesystem.write', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'unknown-call', content: '{"status":"outcome-unknown"}' }, { role: 'assistant', content: 'Attributed report is not effect proof.' });
      bytes = encodeSource(altered);
    }
    fs.writeFileSync(retainedFile(first), bytes);
    const task = services.taskService.runtime.get({ id: taskId }).task;
    services.taskService.runtime.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: first });
    const refusedSession = await createAttached(), beforeCalls = modelCalls;
    mode = ['pending-pair', 'unknown-effect'].includes(scenario) ? 'gap' : 'cold';
    const result = await sendTurn(refusedSession, 'Continue this Task without inventing effects.');
    if (mode === 'gap') {
      assert.equal(result.kind, 'completed', 'historical unresolved-looking protocol alone is not live effect authority');
      assert.ok(JSON.parse(fs.readFileSync(retainedFile(refusedSession))).historyGap);
      assert.equal(fs.readFileSync(retainedFile(first), 'utf8'), bytes);
      fs.writeFileSync(retainedFile(first), sourceBytes); mode = 'cold';
      continue;
    }
    assert.equal(result.kind, 'failed', scenario);
    const expected = scenario === 'binding' ? 'CONTEXT_HISTORY_DENIED' : ['pending-pair', 'unknown-effect'].includes(scenario) ? 'REQUEST_RECOVERY_REQUIRED' : 'CONTEXT_HISTORY_UNAVAILABLE';
    assert.equal(result.error.code, expected, JSON.stringify({ scenario, result }));
    assert.equal(modelCalls, beforeCalls, 'refused cold source dispatches no model or tools');
    assert.equal(fs.readFileSync(retainedFile(first), 'utf8'), bytes, 'refusal preserves source bytes');
    assert.equal(fs.existsSync(retainedFile(refusedSession)), false, 'refusal does not create replacement history');
    rejected.push(scenario);
    fs.writeFileSync(retainedFile(first), sourceBytes);
  }
  assert.throws(() => ownerStore.read({ ...source.binding, actorId: 'unrelated-agent' }), { code: 'CONTEXT_HISTORY_DENIED' });
  assert.throws(() => ownerStore.read({ ...source.binding, sessionId: 'guessed-session' }), { code: 'CONTEXT_HISTORY_UNAVAILABLE' });
  const huge = { ...source, messages: [...source.messages, { role: 'assistant', content: 'x'.repeat(MANAGED_HISTORY_MAX_BYTES) }] };
  assert.throws(() => ownerStore.write(huge), { code: 'CONTEXT_HISTORY_LIMIT' });
  assert.deepEqual(fs.readFileSync(retainedFile(first)), sourceBytes, 'size refusal preserves source');
  // Restoring v1 after a rejected newer envelope is a reversible rollback; new
  // model configuration is admitted with current grants, not the old revision.
  let task = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: first });
  const changedModel = await createAttached();
  await services.managedAgent.provider.selectModel({ sessionId: changedModel, model: 'fixture-new-config', modelProvider: 'managed-history-local', reasoningEffort: 'high' });
  assert.equal((await sendTurn(changedModel, 'Continue with newly admitted current model configuration.')).kind, 'completed');
  assert.notEqual(JSON.parse(fs.readFileSync(retainedFile(changedModel))).revision, source.revision);
  // Compatible no-file predecessor: old versions did not persist Managed raw sources.
  task = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: 'legacy-without-envelope' });
  mode = 'ordinary';
  const legacy = await createAttached();
  assert.equal((await sendTurn(legacy, 'Legacy source is explicitly absent; start from current Task context.')).kind, 'completed');
  assert.ok(!JSON.parse(fs.readFileSync(retainedFile(legacy))).messages.some(row => row.tool_call_id === 'retained-source-read'));
  fs.writeFileSync(path.join(project, 'proof.txt'), 'ACTUAL MANAGED FILE RECEIPT');
  for (const scenario of ['dispatch-failure', 'settled-failure']) {
    mode = scenario;
    const id = await createAttached(), originalCheckpoint = services.managedAgent.checkpointModelHistory;
    let obstructed = false, backup;
    services.managedAgent.checkpointModelHistory = async payload => {
      if (!obstructed && payload.binding.sessionId === id && (scenario === 'dispatch-failure' ? payload.phase === 'tool-calls' : payload.phase === 'settled-transcript' && payload.settledCallIds?.includes('failure-file-read'))) {
        backup = fs.readFileSync(retainedFile(id));
        fs.renameSync(retainedFile(id), retainedFile(id) + '.fixture-retained');
        fs.mkdirSync(retainedFile(id)); // Real storage obstruction, not a mocked tool.
        obstructed = true;
      }
      return originalCheckpoint(payload);
    };
    try {
      const result = await sendTurn(id, 'Read proof.txt once through the real Broker.');
      assert.equal(result.kind, 'failed', JSON.stringify(result));
      assert.equal(result.error.code, 'CONTEXT_HISTORY_CHECKPOINT_PERSIST_FAILED');
      assert.equal(obstructed, true);
      const journal = JSON.parse(fs.readFileSync(path.join(stateDir, 'model', 'tool-executions.json')));
      const receipts = Object.values(journal).filter(row => row.sessionId === id);
      assert.equal(receipts.length, scenario === 'dispatch-failure' ? 0 : 1);
      if (receipts.length) assert.equal(receipts[0].status, 'completed', 'settled actual read receipt is retained despite source checkpoint failure');
      assert.deepEqual(fs.readFileSync(retainedFile(id) + '.fixture-retained'), backup);
      rejected.push(scenario);
    } finally {
      services.managedAgent.checkpointModelHistory = originalCheckpoint;
      if (obstructed) { fs.rmdirSync(retainedFile(id)); fs.renameSync(retainedFile(id) + '.fixture-retained', retainedFile(id)); }
    }
    // Next fixture starts from the last completed source, never the failed one.
    task = services.taskService.runtime.get({ id: taskId }).task;
    services.taskService.runtime.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: legacy });
  }
  if (settingsBefore) assert.deepEqual(fs.readFileSync(settingsFile), settingsBefore);
  else assert.equal(fs.existsSync(settingsFile), false);
  taskId = services.taskService.runtime.create({ goal: 'Legacy source absence remains explicit across continuation.', workspaceId }).id;
  services.capabilityService.grantTask(taskId, { capabilities: ['context.history.read'] });
  task = services.taskService.runtime.get({ id: taskId }).task;
  services.taskService.runtime.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: 'legacy-all-missing' });
  mode = 'ordinary';
  for (let iteration = 0; iteration < 2; iteration++) {
    const legacyGapSession = await createAttached();
    assert.equal((await sendTurn(legacyGapSession, 'Use current Task context without claiming absent legacy originals were recovered.')).kind, 'completed');
    const legacyGap = JSON.parse(fs.readFileSync(retainedFile(legacyGapSession))).historyGap;
    assert.equal(legacyGap.retainedOriginal, false);
    assert.equal(legacyGap.retainedOrigin, null, 'a later envelope must not turn absent original history into a recovered source');
  }
  console.log(JSON.stringify({ fixture: 'managed-history-refusals', rejected, settingsUnchanged: true, nativeOrPaidModel: false }));
  console.log(JSON.stringify({ fixture: 'managed-retained-history-core', actualCore: true, actualBroker: true, coldRestart: true, syntheticModel: true,
    sourceReads, modelCalls, retainedBytes: sourceBytes.length, sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex') }));
} finally {
  await closeCore(services);
  if (oldData === undefined) delete process.env.WHALEBRIDGE_DATA_DIR; else process.env.WHALEBRIDGE_DATA_DIR = oldData;
  assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
  assert.ok(path.basename(base).startsWith('cetamesh-managed-history-'));
  fs.rmSync(base, { recursive: true, force: true });
}
