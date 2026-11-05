import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';

const repo = path.resolve(import.meta.dirname, '..');
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
const { createChatService } = await import(pathToFileURL(path.join(repo, 'src/desktop/chat-service.js')));
const runtime = { defaultProviderId: () => 'fixture', resolveProvider: id => ({ id }), supportsToolCalling: () => true, isRegistered: () => true };
const invoke = (service, method, params = {}) => service.execute({ method: 'chat.' + method, params });
const tool = (id, status = 'completed') => ({ id, capability: 'filesystem.read', status, durationMs: 3, summary: 'Safe deterministic receipt' });
async function until(fn, name) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(5); } throw Error('Timeout: ' + name); }
function createFixture(stateDir) {
  const runs = [], events = [];
  const service = createChatService({ stateDir, defaults: { model: 'fixture' }, api: {}, modelRuntime: runtime,
    onEvent: value => events.push(structuredClone(value)),
    toolExecutionCoordinator: { run: request => new Promise(resolve => { runs.push({ request, resolve }); request.onTextDelta('Visible progress'); }), cancelSession: () => ({ cancelled: 0 }) }
  });
  return { service, runs, events };
}

if (process.argv[2] === '--interrupted-child') {
  const stateDir = process.argv[3];
  const { service, runs } = createFixture(stateDir);
  const session = await invoke(service, 'sessions.create', {});
  await invoke(service, 'send', { id: session.id, text: 'Controlled active turn' });
  runs[0].request.onActivity(tool('interrupted-receipt', 'running'));
  runs[0].request.onActivity(tool('settled-receipt', 'completed'));
  const before = await invoke(service, 'status', { id: session.id });
  fs.writeFileSync(path.join(stateDir, 'child-observation.json'), JSON.stringify({ sessionId: session.id, requestId: before.turn.requestId, toolIds: before.turn.toolActivity.map(row => row.id) }));
  // Model the lost process without calling graceful close/finalization.
  process.exit(0);
}

const sandbox = createSuiteSandbox({ suiteId: 'chat-activity-persistence' });
const root = sandbox.root;
const results = [];
async function check(name, action) {
  try { const facts = await action(); results.push({ name, status: 'PASS', facts }); }
  catch (error) { results.push({ name, status: 'FAIL', message: error.message, actual: error.actual, expected: error.expected, facts: error.facts }); }
}
function assertWithFacts(condition, message, facts) { try { assert.ok(condition, message); } catch (error) { error.facts = facts; throw error; } }

await check('terminal activity survives finalization and service reconstruction', async () => {
  const stateDir = path.join(root, 'terminal'); const { service, runs } = createFixture(stateDir);
  const session = await invoke(service, 'sessions.create', {});
  await invoke(service, 'send', { id: session.id, text: 'Terminal control' });
  runs[0].request.onActivity(tool('terminal-receipt'));
  runs[0].resolve({ status: 'completed', toolCalling: 'supported', text: 'Final answer' });
  await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'finalize');
  const before = await invoke(service, 'history', { id: session.id }); await service.close();
  const reconstructed = createFixture(stateDir).service;
  const after = await invoke(reconstructed, 'history', { id: session.id }); await reconstructed.close();
  assert.equal(before.messages.at(-1).toolActivity[0].id, 'terminal-receipt');
  assert.equal(after.messages.at(-1).toolActivity[0].id, 'terminal-receipt');
  return { messageCount: after.messages.length, terminalToolCount: after.messages.at(-1).toolActivity.length };
});

await check('active activity survives interrupted process restart without invented completion', async () => {
  const stateDir = path.join(root, 'interrupted'); fs.mkdirSync(stateDir, { recursive: true });
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupted-child', stateDir], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const before = JSON.parse(fs.readFileSync(path.join(stateDir, 'child-observation.json'), 'utf8'));
  assert.deepEqual(before.toolIds, ['interrupted-receipt', 'settled-receipt']);
  const service = createFixture(stateDir).service;
  const after = await invoke(service, 'status', { id: before.sessionId });
  const history = await invoke(service, 'history', { id: before.sessionId }); await service.close();
  const retained = [...(after.turn?.toolActivity ?? []), ...history.messages.flatMap(message => message.toolActivity ?? [])];
  assertWithFacts(retained.some(row => row.id === 'interrupted-receipt'), 'A previously visible activity receipt must remain readable after reconstruction', {
    beforeToolCount: 2, afterToolCount: retained.length, lastState: after.lastState, historyRoles: history.messages.map(row => row.role)
  });
  assert.equal(retained.find(row => row.id === 'interrupted-receipt').status, 'outcome-unknown');
  assert.equal(retained.find(row => row.id === 'settled-receipt').status, 'completed');
  assert.equal(after.lastState, 'interrupted');
  assert.equal(history.messages.at(-1).activityTimeline.entries.at(-1).source, 'recovery');
});

await check('late previous-run callback cannot mutate current-run activity', async () => {
  const { service, runs } = createFixture(path.join(root, 'late'));
  const session = await invoke(service, 'sessions.create', {});
  await invoke(service, 'send', { id: session.id, text: 'First turn' });
  runs[0].request.onActivity(tool('first-turn-receipt'));
  runs[0].resolve({ status: 'completed', toolCalling: 'supported', text: 'First answer' });
  await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'first finalize');
  await invoke(service, 'send', { id: session.id, text: 'Second turn' });
  runs[1].request.onActivity(tool('second-turn-receipt', 'running'));
  const before = await invoke(service, 'status', { id: session.id });
  runs[0].request.onActivity(tool('late-first-turn-receipt', 'failed'));
  runs[0].request.onStreamReset();
  runs[0].request.onTextDelta('STALE_TEXT_SENTINEL');
  runs[0].request.onCapabilityResult({ capability: 'task.create', result: { status: 'completed', result: { task: { id: 'stale-created-task' } } } });
  const after = await invoke(service, 'status', { id: session.id });
  runs[1].resolve({ status: 'completed', toolCalling: 'supported', text: 'Second answer' });
  await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'second finalize'); await service.close();
  assertWithFacts(!after.turn.toolActivity.some(row => row.id === 'late-first-turn-receipt'), 'An old run callback must be ignored by the current turn', {
    sameCurrentRequest: before.turn.requestId === after.turn.requestId, beforeIds: before.turn.toolActivity.map(row => row.id), afterIds: after.turn.toolActivity.map(row => row.id)
  });
  assert.equal(after.turn.displayText, before.turn.displayText);
  assert.equal(after.taskId, before.taskId, 'a late completed task creation cannot rebind the new Chat run');
});

await check('bounded terminal activity declares omitted receipts', async () => {
  const { service, runs } = createFixture(path.join(root, 'bounded'));
  const session = await invoke(service, 'sessions.create', {});
  await invoke(service, 'send', { id: session.id, text: 'Many controlled receipts' });
  for (let i = 0; i < 34; i++) runs[0].request.onActivity(tool('receipt-' + i));
  runs[0].resolve({ status: 'completed', toolCalling: 'supported', text: 'Final answer' });
  await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'bounded finalize');
  const history = await invoke(service, 'history', { id: session.id }); await service.close();
  const message = history.messages.at(-1);
  const retained = message.toolActivity.length;
  assertWithFacts(retained === 34 || message.activityOmitted >= 2, 'Every omitted published receipt must have an explicit omission count', {
    published: 34, retained, firstRetained: message.toolActivity[0]?.id, explicitOmissionKeys: Object.keys(message).filter(key => /omit|trunc|gap/i.test(key))
  });
});

await check('public timeline is bounded, sequenced and excludes private activity fields before persistence', async () => {
  const { service, runs } = createFixture(path.join(root, 'privacy'));
  const session = await invoke(service, 'sessions.create', {});
  await invoke(service, 'send', { id: session.id, text: 'Public observations only' });
  for (let i = 0; i < 140; i++) runs[0].request.onActivity({ ...tool('safe-' + i),
    summary: 'token=fixture-secret-value', reasoning: 'PRIVATE_REASONING_SENTINEL', input: 'RAW_INPUT_SENTINEL', output: 'RAW_OUTPUT_SENTINEL' });
  const checkpoint = JSON.parse(fs.readFileSync(path.join(service._store.historyDir, session.id + '.json'), 'utf8')).activeTurn;
  const serialized = JSON.stringify(checkpoint);
  assert.doesNotMatch(serialized, /PRIVATE_REASONING_SENTINEL|RAW_INPUT_SENTINEL|RAW_OUTPUT_SENTINEL|fixture-secret-value/);
  assert.equal(checkpoint.activityTimeline.entries.length, 128);
  assert.equal(checkpoint.activityTimeline.omittedCount, 12);
  assert.equal(checkpoint.activityOmitted, 108);
  assert.equal(checkpoint.activityTimeline.entries[0].sequence, 13);
  assert.ok(checkpoint.activityTimeline.entries.every(row => row.at > 0 && row.source === 'model-coordinator'));
  const priorCount = checkpoint.activityTimeline.nextSequence;
  runs[0].request.onActivity({ ...tool('safe-139'), summary: 'token=fixture-secret-value' });
  assert.equal((await invoke(service, 'status', { id: session.id })).turn.activityTimeline.nextSequence, priorCount, 'duplicate public activity does not append or regress');
  runs[0].resolve({ status: 'completed', toolCalling: 'supported', text: 'Final answer' });
  await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'privacy finalize');
  const history = await invoke(service, 'history', { id: session.id }); await service.close();
  assert.equal(history.messages.at(-1).id, checkpoint.id, 'durable turn retains its stable message identity');
  assert.equal(history.messages.at(-1).activityTimeline.omittedCount, 13);
});

await check('source sequence duplicates cannot regress tools and missing events remain explicit', async () => {
  const service = createChatService({ stateDir: path.join(root, 'sequences'), defaults: { model: 'fixture' }, api: {},
    modelRuntime: { ...runtime, supportsToolCalling: () => false, stream: async function* () {
      yield { seq: 10, timestamp: 1000, type: 'turn/start', data: { runId: 'run-current', attemptId: 'attempt-current' } };
      yield { seq: 11, timestamp: 1100, type: 'tool/activity', data: { activity: tool('sequenced', 'running') } };
      yield { seq: 11, timestamp: 1100, type: 'tool/activity', data: { activity: tool('sequenced', 'failed') } };
      yield { seq: 12, timestamp: 1200, type: 'assistant/reasoning', data: { text: 'PRIVATE_REASONING_SENTINEL' } };
      yield { seq: 99, timestamp: 9900, type: 'tool/activity', data: { runId: 'run-older', activity: tool('old-run-receipt', 'failed') } };
      yield { seq: 14, timestamp: 1400, type: 'tool/activity', data: { activity: tool('sequenced', 'completed') } };
      yield { seq: 15, timestamp: 1500, type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } } });
  try {
    const session = await invoke(service, 'sessions.create', {});
    await invoke(service, 'send', { id: session.id, text: 'Observe only public sequence facts' });
    await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'sequenced finalize');
    const history = await invoke(service, 'history', { id: session.id }), message = history.messages.at(-1), timeline = message.activityTimeline;
    assert.equal(message.toolActivity[0].status, 'completed');
    assert.equal(message.toolActivity.length, 1, 'a differently bound run cannot add activity or move the current source cursor');
    assert.equal(timeline.gapCount, 1);
    assert.deepEqual(timeline.entries.filter(row => row.kind === 'tool').map(row => row.status), ['running', 'completed']);
    assert.equal(timeline.entries[0].at, 1000);
    assert.equal(timeline.entries[0].sourceSequence, 10);
    assert.equal(timeline.entries[0].source, 'model-runtime');
    assert.doesNotMatch(JSON.stringify(history), /PRIVATE_REASONING_SENTINEL/);
  } finally { await service.close(); }
});

await check('ACP outer Follow envelope retains sequence, timestamp and duplicate isolation', async () => {
  const provider = 'fixture-acp', nativeTurnId = 'native-turn-1', nativeSessionId = 'native-session-1';
  const sourceTimes = ['2026-11-05T01:00:01.000Z', '2026-11-05T01:00:02.000Z', '2026-11-05T01:00:04.000Z'];
  const envelope = (seq, type, data, timestamp) => ({ type: 'event', seq, timestamp, source: provider,
    eventId: `${provider}:${nativeSessionId}:${seq}`, event: { type, data: { sessionId: nativeSessionId, turn: nativeTurnId, runId: 'acp-run-1', ...data } } });
  let releaseFollow;
  const accepted = new Promise(resolve => { releaseFollow = resolve; });
  const service = createChatService({ stateDir: path.join(root, 'acp-envelope'), defaults: {},
    agentProviders: [{ id: provider, label: 'ACP envelope fixture', eventProtocol: 'dsh-session-events', workspaceBoundary: 'unsupported' }],
    agentExecute: async ({ method }) => {
      if (method === 'agent.createSession') return { sessionId: nativeSessionId };
      if (method === 'agent.send') { releaseFollow(); return { accepted: true, turnId: nativeTurnId }; }
      return { closed: true };
    },
    agentFollow: async function* ({ sinceSequence }) {
      assert.equal(sinceSequence, 0);
      await accepted;
      yield envelope(1, 'turn/start', {}, sourceTimes[0]);
      yield envelope(2, 'tool/activity', { activity: tool('acp-tool', 'completed') }, sourceTimes[1]);
      yield envelope(2, 'tool/activity', { activity: tool('acp-tool', 'failed') }, sourceTimes[1]);
      yield envelope(4, 'turn/end', { reason: { kind: 'completed' } }, sourceTimes[2]);
    } });
  try {
    const session = await invoke(service, 'sessions.create', {});
    await invoke(service, 'config.set', { id: session.id, config: { agentProvider: provider } });
    await invoke(service, 'send', { id: session.id, text: 'Observe actual ACP Follow envelopes.' });
    await until(async () => !(await invoke(service, 'status', { id: session.id })).turn, 'ACP envelope finalize');
    const history = await invoke(service, 'history', { id: session.id }), message = history.messages.at(-1), timeline = message.activityTimeline;
    const facts = { toolStatus: message.toolActivity[0]?.status, gapCount: timeline.gapCount,
      sourceSequences: timeline.entries.map(row => row.sourceSequence), toolAt: timeline.entries.find(row => row.kind === 'tool')?.at };
    assertWithFacts(message.toolActivity[0]?.status === 'completed', 'duplicate outer seq must not overwrite a completed receipt', facts);
    assert.equal(timeline.gapCount, 1);
    assert.deepEqual(timeline.entries.filter(row => row.kind === 'tool').map(row => row.sourceSequence), [2]);
    assert.equal(timeline.entries.find(row => row.kind === 'tool').at, Date.parse(sourceTimes[1]));
    assert.equal(timeline.entries.find(row => row.kind === 'gap').at, Date.parse(sourceTimes[2]));
    assert.equal(timeline.entries.find(row => row.kind === 'gap').sourceSequence, 4);
    assert.equal(timeline.entries.find(row => row.kind === 'gap').source, 'agent-follow');
    assert.equal(timeline.providerId, provider);
    return facts;
  } finally { await service.close(); }
});

await check('production Core Managed Task Follow and actual Broker read retain one attributed activity history', async () => {
  const base = path.join(root, 'core'), project = path.join(base, 'project'); fs.mkdirSync(project, { recursive: true });
  const content = 'A real isolated file read, retained only as safe activity metadata.';
  fs.writeFileSync(path.join(project, 'proof.txt'), content);
  const services = createCetaMeshServices({ stateDir: path.join(base, 'state'), dataRoot: path.join(base, 'data'), resourceRoot: base, sourceRoot: base });
  let modelCalls = 0, observedRealResult = false;
  try {
    services.modelRegistry.register({ id: 'activity-fixture', label: 'Local deterministic model leaf', supportsTools: true,
      defaultModel: 'fixture', health: async () => ({ available: true, configured: true }), listModels: async () => [{ id: 'fixture' }],
      chat: async () => { throw Error('Unexpected non-streaming request'); }, stream: async function* (request) {
        modelCalls++;
        if (!request.messages.some(row => row.role === 'tool')) yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'actual-read', capabilityId: 'filesystem.read', arguments: JSON.stringify({ path: 'proof.txt' }) }] } };
        else {
          observedRealResult = JSON.stringify(request.messages.filter(row => row.role === 'tool')).includes(content);
          yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Observed the actual file.' }] } } };
        }
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: 'activity-fixture', apiKey: 'synthetic-local-only' });
    const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Activity fixture' } })).workspace;
    const ui = (method, params = {}) => services.desktopUiService.execute({ method, params });
    const session = await ui('ui.chat.sessions.create');
    await ui('ui.chat.config.set', { id: session.id, config: { agentProvider: 'cetamesh', modelProvider: 'activity-fixture', model: 'fixture', reasoning: 'off', workspaceId: workspace.id } });
    await ui('ui.chat.send', { id: session.id, text: 'Read proof.txt through the existing Task tool boundary.' });
    let history;
    await until(async () => { history = await ui('ui.chat.history', { id: session.id }); return history.messages.some(row => row.role === 'assistant'); }, 'Managed Chat finalization');
    const message = history.messages.at(-1), linked = (await ui('ui.chat.sessions.list')).sessions.find(row => row.id === session.id);
    const task = services.taskService.runtime.get({ id: linked.taskId }).task;
    assert.equal(observedRealResult, true); assert.equal(modelCalls, 2);
    assert.equal(message.activityTimeline.taskId, task.id);
    assert.equal(message.activityTimeline.runId, task.executionObservation.runId);
    assert.equal(message.activityTimeline.providerId, 'cetamesh');
    assert.ok(message.activityTimeline.entries.some(row => row.kind === 'tool' && row.source === 'agent-follow' && row.sourceSequence !== null));
    assert.equal(message.toolActivity[0].status, 'completed');
    assert.ok(task.executionEvidence.some(row => row.capability === 'filesystem.read' && row.status === 'completed'));
    assert.notEqual(task.status, 'completed', 'an observed turn cannot complete its Task');
    assert.equal(fs.readFileSync(path.join(project, 'proof.txt'), 'utf8'), content);
    return { modelCalls, retainedTools: message.toolActivity.length, taskStatus: task.status, timelineEntries: message.activityTimeline.entries.length };
  } finally {
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
});

fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ scope: 'Production Chat service, real isolated JSON persistence, deterministic coordinator; no external model or native UI', results }, null, 2));
for (const result of results) console.log(JSON.stringify(result));
console.log('Evidence: ' + path.join(root, 'results.json'));
const failed = results.some(result => result.status === 'FAIL');
finalizeSuiteSandbox({ sandbox, failed });
process.exitCode = failed ? 1 : 0;
