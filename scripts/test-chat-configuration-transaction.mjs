import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createChatService } from '../src/desktop/chat-service.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createContinuityService } from '../src/continuity/service.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { createSettingsStore } from '../src/settings/store.js';
import { createModelProviderRegistry, createModelRuntimeService, createModelConfiguration, createOpenAiCompatibleModelProvider } from '../src/model/index.js';

// Real Chat storage and Agent Broker, with a controlled native protocol leaf.
// These fixtures do not contact an account or establish native UI acceptance.
const tempRoot = path.resolve(process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir());
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'cm-chat-configuration-'));
let sequence = 0, failures = 0;
const control = (model = 'model-a', reasoningEffort = 'medium') => ({ status: 'available', source: 'acp-session', runtimeVersion: 'fixture',
  application: 'runtime-confirmed', selection: { model, reasoningEffort },
  model: { configId: 'model', options: ['model-a', 'model-b'].map(value => ({ value, label: value })) },
  reasoning: { configId: 'reasoning', options: ['medium', 'xhigh'].map(value => ({ value, label: value })) } });
const coded = code => Object.assign(new Error(code), { code });
function failWrites(file, predicate) {
  const original = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.resolve(to) === path.resolve(file) && predicate(JSON.parse(fs.readFileSync(from, 'utf8')))) throw coded('EIO');
    return original.apply(this, arguments);
  };
  return () => { fs.renameSync = original; };
}
function fixture({ select, count = 1, modelRuntime = null, modelCatalogRevision = null, observed = {} } = {}) {
  const stateDir = path.join(root, String(++sequence));
  fs.mkdirSync(path.join(stateDir, 'desktop-chat'), { recursive: true });
  const calls = [], controls = new Map();
  let sessionSequence = 0;
  const registry = createAgentProviderRegistry();
  registry.register(defineAgentProvider({ id: 'native-fixture', label: 'Native fixture', capabilityExtras: { workspaceBoundary: 'unsupported' }, methods: {
    async createSession() { const sessionId = 'native-' + (++sessionSequence); controls.set(sessionId, control()); return { sessionId }; },
    async status({ sessionId }) { calls.push({ method: 'status', sessionId }); return { running: false, queued: 0, modelControl: controls.get(sessionId), ...observed }; },
    async send() { return { accepted: true }; }, async cancel() { return { cancelled: true }; }, async closeSession() { return { closed: true }; },
    async selectModel(params) {
      calls.push({ method: 'select', ...params });
      const result = select ? await select(params, { calls, controls }) : { modelControl: control(params.model || controls.get(params.sessionId).selection.model, params.reasoningEffort || controls.get(params.sessionId).selection.reasoningEffort) };
      if (result?.modelControl) controls.set(params.sessionId, result.modelControl);
      return result;
    }, async health() { return { available: true }; }, async *follow() {}, async contextUsage() { return { available: false }; }, async resume() { return {}; }
  } }));
  const broker = createAgentBroker({ registry });
  const agentExecute = request => request.method === 'agent.list' ? Promise.resolve({ providers: [] })
    : request.method === 'agent.createSession' ? broker.createSession(request.params.provider, request.params) : broker[request.method.slice(6)](request.params);
  const options = { stateDir, modelRuntime, modelCatalogRevision, agentExecute,
    agentFollow: async function* ({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    agentProviders: [{ id: 'native-fixture', eventProtocol: 'agent-turn-events-v1' }] };
  let service = createChatService(options);
  const execute = (method, params = {}) => service.execute({ method, params });
  return { calls, controls, options, stateDir, broker, get service() { return service; }, execute,
    saved: id => JSON.parse(fs.readFileSync(service._store.sessionsFile, 'utf8')).sessions.find(row => row.id === id),
    async restart() { await service.close(); service = createChatService(options); },
    async bind() {
      const ids = [];
      for (let i = 0; i < count; i++) {
        const row = await execute('chat.sessions.create'); ids.push(row.id);
        await execute('chat.config.set', { id: row.id, config: { agentProvider: 'native-fixture' } });
        await execute('chat.send', { id: row.id, text: 'Preserved fixture history' });
        for (let j = 0; j < 100 && !(await execute('chat.status', { id: row.id })).turn?.state?.includes('streaming'); j++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.equal((await execute('chat.status', { id: row.id })).turn?.state, 'streaming', 'fixture Agent must accept the real Chat turn');
        service._injectEvent(row.id, { type: 'turn/start', data: { turn: 'turn-' + i } });
        service._injectEvent(row.id, { type: 'turn/end', data: { turn: 'turn-' + i, reason: { kind: 'completed' }, usage: { inputTokens: 3, outputTokens: 2 } } });
      }
      return ids;
    }
  };
}
async function managedFixture({ streamHook = null, catalogHook = null, missingResponseModel = false } = {}) {
  const stateDir = path.join(root, 'managed-' + (++sequence)), requests = [], events = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null; requests.push({ path: req.url, body });
    if (req.url.endsWith('/models')) {
      if (catalogHook && await catalogHook(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: req.url.startsWith('/new/') ? 'gpt-new' : 'gpt-5-fixture' }] })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ ...(missingResponseModel ? {} : { model: 'gpt-response' }), choices: [{ delta: { content: 'Fixture reply' } }] }) + '\n\n');
    if (streamHook) await streamHook();
    res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const secrets = createProviderSecrets({ root: stateDir });
  secrets.set({ provider: 'openai', apiKey: 'fixture-private-key-123456', baseUrl: base });
  const registry = createModelProviderRegistry({ providers: [createOpenAiCompatibleModelProvider({
    id: 'openai', label: 'Owned fixture', baseUrl: base, defaultModel: 'gpt-5-fixture', secrets, reasoningParam: 'reasoning_effort'
  })] });
  const settings = createSettingsStore({ stateDir });
  const configuration = createModelConfiguration({ settingsStore: settings, secrets, registry });
  const modelRuntime = createModelRuntimeService({ registry, secrets, configuration });
  const options = { stateDir, modelRuntime, onEvent: event => events.push(event),
    defaultModelConfig: () => ({ provider: 'openai', defaultModel: 'gpt-5-fixture', reasoningEffort: 'max' }),
    modelCatalogRevision: () => JSON.stringify([configuration.get().revision, secrets.list().map(row => [row.provider, row.revision, row.updatedAt])]) };
  let service = createChatService(options);
  return { stateDir, requests, events, secrets, settings, configuration, modelRuntime, base, options,
    get service() { return service; }, execute: (method, params = {}) => service.execute({ method, params }),
    async restart() { await service.close(); service = createChatService(options); },
    async close() { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function handoffFixture({ statusHook = null, ownerContext = false, nextTurnTarget = false, gates = {}, boundarySupported = true, prepareHandoff = null, automaticRoute = false } = {}) {
  const stateDir = path.join(root, 'handoff-' + (++sequence));
  const taskRuntime = createTaskRuntime({ stateDir });
  const task = taskRuntime.create({ goal: 'Preserve exact Chat configuration handoff', workspaceId: 'fixture-workspace' });
  const controls = new Map(), ends = new Map(), calls = [];
  let serial = 0;
  const sourceProviderId = automaticRoute ? 'cetamesh' : 'native-fixture';
  const registry = createAgentProviderRegistry();
  const sourceProvider = defineAgentProvider({ id: sourceProviderId, label: 'Owned source fixture', capabilityExtras: { workspaceBoundary: 'capability-broker' }, methods: {
    async createSession(options) { const sessionId = 'handoff-' + (++serial); const modelControl = control(options.model || 'model-a', options.reasoningEffort || 'medium');
      calls.push({ method: 'create', sessionId }); controls.set(sessionId, modelControl); return { sessionId, modelControl }; },
    async send({ sessionId }) { const requestId = 'bootstrap-' + sessionId; ends.set(sessionId, { type: 'turn/end', data: { requestId, reason: { kind: 'completed' } } }); return { accepted: true, requestId }; },
    async status({ sessionId }) { calls.push({ method: 'status', sessionId }); if (statusHook) await statusHook(sessionId);
      if (gates.statusError) throw coded(gates.statusError);
      return { running: false, queued: 0, modelControl: controls.get(sessionId), ...(gates.statusUnknown ? { state: 'unknown' } : {}) }; },
    async cancel() { return { cancelled: true }; }, async closeSession() { return { closed: true }; }, async contextUsage() { return { available: false }; },
    async resume() { return {}; }, async selectModel() { throw Error('Task configuration must use Continuity'); },
    async *follow({ sessionId }) { if (ends.has(sessionId)) yield ends.get(sessionId); }, async health() { return { available: true }; }
  } });
  registry.register(sourceProvider);
  if (nextTurnTarget) {
    const targetProvider = defineAgentProvider({ id: 'next-turn-fixture', label: 'Next-turn fixture', capabilityExtras: { workspaceBoundary: 'capability-broker' }, methods: {
    async createSession(options) {
      const created = await sourceProvider.createSession(options);
      if (gates.creationError) throw gates.creationError;
      const modelControl = { status: 'unknown', source: 'fixture-exec', application: 'next-turn', selection: null, model: null, reasoning: null,
        requested: { model: 'native-default', reasoningEffort: 'medium' } };
      controls.set(created.sessionId, modelControl); return { ...created, modelControl };
    }, send: sourceProvider.send, status: sourceProvider.status, cancel: sourceProvider.cancel, closeSession: sourceProvider.closeSession,
    contextUsage: sourceProvider.contextUsage, resume: sourceProvider.resume, selectModel: sourceProvider.selectModel, follow: sourceProvider.follow, health: sourceProvider.health
    } });
    registry.register({ ...targetProvider, capabilities: () => ({ ...targetProvider.capabilities(),
      workspaceBoundary: gates.targetBlocked ? 'unsupported' : 'capability-broker' }) });
  }
  const broker = createAgentBroker({ registry });
  const source = await broker.createSession(sourceProviderId, { taskId: task.id, workspaceId: task.workspaceId });
  taskRuntime.start({ id: task.id, expectedRev: taskRuntime.get({ id: task.id }).task.rev, provider: sourceProviderId, sessionId: source.sessionId });
  const continuity = createContinuityService({ stateDir, taskRuntime, agentBroker: broker, canRollover: () => gates.canRollover !== false, prepareHandoff,
    readOperations: () => gates.unknownOperation ? [{ operationId: 'fixture-unknown', status: 'outcome-unknown' }] : [] });
  fs.mkdirSync(path.join(stateDir, 'desktop-chat'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'desktop-chat', 'sessions.json'), JSON.stringify({ schemaVersion: 1, sessions: [{
    id: 'linked-chat', title: 'Task fixture', createdAt: 1, updatedAt: 1, taskId: automaticRoute ? null : task.id,
    config: { provider: 'dsh', agentProvider: automaticRoute ? null : sourceProviderId, model: 'model-a', modelProvider: null, reasoning: 'medium', workspaceId: task.workspaceId, mode: automaticRoute ? 'smart' : 'chat' }
  }] }));
  const handoffAttempts = [];
  const options = { stateDir, resolveTask: async id => taskRuntime.get({ id }).task,
    handoffTaskSupportsBeforeEffects: boundarySupported,
    ...(automaticRoute ? { router: { classify: () => ({ decision: { class: 'project', route: 'agent', agentIntent: true, capabilityIntent: false } }) },
      platformRoute: async request => {
        assert.equal(request.record.id, 'linked-chat', 'the owned routing result belongs only to its initiating Chat');
        const accepted = await broker.send({ provider: sourceProviderId, sessionId: source.sessionId, content: request.text });
        return { kind: 'agent', provider: sourceProviderId, sessionId: source.sessionId, taskId: task.id, accepted: true, requestId: accepted.requestId };
      } } : {}),
    ...(ownerContext ? { recordOwnerContext: request => taskRuntime.recordOwnerContext(request) } : {}),
    handoffTask: async request => {
      if (ownerContext) {
        const current = taskRuntime.get({ id: task.id }).task;
        const intent = JSON.parse(fs.readFileSync(path.join(stateDir, 'desktop-chat', 'sessions.json'), 'utf8')).sessions[0].pendingConfiguration;
        assert.equal(intent.sourceBinding.taskRevision, current.rev, 'persisted intent must bind the post-context Task revision');
        assert.equal(request.expectedConfigurationSource?.taskRevision, current.rev, 'composition receives the exact persisted source guard');
      }
      const { expectedConfigurationSource, ...invocation } = request;
      const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'desktop-chat', 'sessions.json'), 'utf8')).sessions[0];
      const attempt = { request, invocation, sourceBinding: persisted.pendingConfiguration?.sourceBinding, projectedSessionId: persisted.dshSessionId }; handoffAttempts.push(attempt);
      try { return await continuity.runtime.rollover(invocation); }
      catch (error) {
        attempt.error = error;
        throw error;
      }
    },
    readTaskHandoff: ({ taskId, from }) => continuity.runtime.history({ taskId }).rollovers.findLast(row => row.from.provider === from.provider && row.from.sessionId === from.sessionId),
    agentProviders: [{ id: sourceProviderId, eventProtocol: 'agent-turn-events-v1', requiresTask: true },
      ...(nextTurnTarget ? [{ id: 'next-turn-fixture', eventProtocol: 'agent-turn-events-v1', requiresTask: true }] : [])],
    agentExecute: request => broker[request.method.slice(6)](request.params),
    agentFollow: async function* ({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } };
  let service = createChatService(options);
  if (automaticRoute) {
    await service.execute({ method: 'chat.send', params: { id: 'linked-chat', text: 'Analyze this owned project through Auto routing' } });
    for (let i = 0; i < 100 && !(await service.execute({ method: 'chat.status', params: { id: 'linked-chat' } })).turn?.state?.includes('streaming'); i++) await new Promise(resolve => setTimeout(resolve, 1));
    const requestId = 'bootstrap-' + source.sessionId;
    service._injectEvent('linked-chat', { type: 'turn/end', data: { requestId, reason: { kind: 'completed' } } });
    for (let i = 0; i < 100 && (await service.execute({ method: 'chat.status', params: { id: 'linked-chat' } })).turn; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const saved = JSON.parse(fs.readFileSync(service._store.sessionsFile, 'utf8')).sessions[0];
    assert.equal(saved.taskId, task.id); assert.equal(saved.config.agentProvider, null); assert.equal(saved.runtimeProvider, sourceProviderId);
  } else await service.synchronizeTaskAssignment({ taskId: task.id, provider: sourceProviderId, sessionId: source.sessionId });
  return { calls, handoffAttempts, options, stateDir, task, taskRuntime, continuity, source, broker, get service() { return service; },
    execute: (method, params = {}) => service.execute({ method, params: { id: 'linked-chat', ...params } }),
    saved: () => JSON.parse(fs.readFileSync(service._store.sessionsFile, 'utf8')).sessions[0],
    async restart() { await service.close(); service = createChatService(options); } };
}
async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); } }
try {
  await check('durable configuration intent failure makes zero native selection calls', async () => {
    const f = fixture(); let restore = () => {};
    try {
      const [id] = await f.bind(); const before = f.saved(id);
      restore = failWrites(f.service._store.sessionsFile, () => true);
      await assert.rejects(f.execute('chat.config.set', { id, config: { model: 'model-b' } }));
      assert.equal(f.calls.filter(row => row.method === 'select').length, 0, 'native effect must follow durable intent');
      assert.deepEqual((await f.execute('chat.sessions.list')).sessions[0].config, before.config);
    } finally { restore(); await f.service.close(); }
  });
  await check('prepared intent exists before native dispatch and clears only after confirmed persistence', async () => {
    let f;
    f = fixture({ select: async params => {
      const intent = f.saved(id).pendingConfiguration;
      assert.ok(intent?.changeId, 'persisted intent must precede native dispatch');
      assert.equal(intent.requested.model, 'model-b'); assert.equal(intent.sourceBinding.sessionId, params.sessionId);
      return { modelControl: control('model-b') };
    } });
    const [id] = await f.bind();
    try {
      const updated = await f.execute('chat.config.set', { id, config: { model: 'model-b' } });
      assert.equal(updated.config.model, 'model-b'); assert.equal(updated.configuration.application, 'runtime-confirmed');
      assert.equal(updated.configuration.durable, true); assert.equal(f.saved(id).pendingConfiguration, null);
    } finally { await f.service.close(); }
  });
  await check('partial native ACK is unknown and recovery reads current runtime without replay', async () => {
    const f = fixture({ select: async () => ({ modelControl: control('model-a', 'xhigh') }) });
    try {
      const [id] = await f.bind();
      await assert.rejects(f.execute('chat.config.set', { id, config: { model: 'model-b', reasoning: 'xhigh' } }), { code: 'MODEL_ACK_MISMATCH' });
      assert.equal(f.saved(id).pendingConfiguration.phase, 'needs-reconciliation');
      await assert.rejects(f.execute('chat.send', { id, text: 'Do not run unknown config' }), { code: 'CONFIG_RECONCILIATION_REQUIRED' });
      const reconciled = await f.execute('chat.config.reconcile', { id });
      assert.equal(reconciled.config.model, 'model-a'); assert.equal(reconciled.config.reasoning, 'xhigh');
      assert.equal(f.calls.filter(row => row.method === 'select').length, 1);
      assert.equal((await f.execute('chat.history', { id })).messages[0].text, 'Preserved fixture history');
    } finally { await f.service.close(); }
  });
  await check('final native ACK must retain the complete selected tuple when only model changes', async () => {
    const f = fixture({ select: async params => ({ modelControl: params.reasoningEffort ? control('model-a', params.reasoningEffort) : control('model-b', 'medium') }) });
    try {
      const [id] = await f.bind(); await f.execute('chat.config.set', { id, config: { reasoning: 'xhigh' } });
      await assert.rejects(f.execute('chat.config.set', { id, config: { model: 'model-b' } }), { code: 'MODEL_ACK_MISMATCH' });
      assert.equal(f.saved(id).config.reasoning, 'xhigh'); assert.equal(f.saved(id).pendingConfiguration.phase, 'needs-reconciliation');
      const observed = await f.execute('chat.config.reconcile', { id }); assert.equal(observed.config.reasoning, 'medium'); assert.equal(observed.config.model, 'model-b');
      assert.equal(f.calls.filter(row => row.method === 'select').length, 2);
    } finally { await f.service.close(); }
  });
  await check('ACK success and final Chat save failure retain durable evidence and correct memory', async () => {
    const f = fixture(); let restore = () => {};
    try {
      const [id] = await f.bind(); const before = f.saved(id);
      restore = failWrites(f.service._store.sessionsFile, store => store.sessions.some(row => row.id === id && row.config.model === 'model-b'));
      await assert.rejects(f.execute('chat.config.set', { id, config: { model: 'model-b' } }));
      assert.equal(f.saved(id).config.model, before.config.model);
      assert.equal(f.saved(id).pendingConfiguration.phase, 'runtime-confirmed');
      const status = await f.execute('chat.status', { id }); assert.equal(status.configuration.durable, false); assert.equal(status.configuration.runtime, 'confirmed');
      assert.equal((await f.execute('chat.sessions.list')).sessions[0].config.model, before.config.model);
      restore(); restore = () => {};
      const recovered = await f.execute('chat.config.reconcile', { id }); assert.equal(recovered.config.model, 'model-b');
      assert.equal(f.calls.filter(row => row.method === 'select').length, 1);
    } finally { restore(); await f.service.close(); }
  });
  await check('same Chat is locked while an independent Chat configuration completes', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    let target;
    const f = fixture({ count: 2, select: async params => { if (params.sessionId === target) { entered(); await gate; } return { modelControl: control(params.model) }; } });
    try {
      const [a, b] = await f.bind(); target = f.saved(a).dshSessionId;
      const pending = f.execute('chat.config.set', { id: a, config: { model: 'model-b' } }); await started;
      await assert.rejects(f.execute('chat.config.set', { id: a, config: { reasoning: 'xhigh' } }), { code: 'CONFIG_BUSY' });
      assert.equal((await f.execute('chat.config.set', { id: b, config: { model: 'model-b' } })).config.model, 'model-b');
      release(); assert.equal((await pending).config.model, 'model-b');
      assert.equal(f.saved(b).config.model, 'model-b');
    } finally { release?.(); await f.service.close(); }
  });
  await check('explicit no-effect native rejection is observed and a fresh explicit change can recover', async () => {
    let reject = true;
    const f = fixture({ select: async params => { if (reject) { reject = false; throw coded('MODEL_NOT_FOUND'); } return { modelControl: control(params.model) }; } });
    try {
      const [id] = await f.bind(); const before = f.saved(id).config;
      await assert.rejects(f.execute('chat.config.set', { id, config: { model: 'model-b' } }));
      assert.deepEqual(f.saved(id).config, before); assert.equal(f.saved(id).pendingConfiguration, null);
      assert.equal((await f.execute('chat.config.set', { id, config: { model: 'model-b' } })).config.model, 'model-b');
      assert.equal(f.calls.filter(row => row.method === 'select').length, 2);
    } finally { await f.service.close(); }
  });
  for (const status of [{ running: true }, { running: false, state: 'unknown' }]) await check('busy/unknown native status refuses before intent and later real ready status recovers', async () => {
    const observed = { ...status }, f = fixture({ observed });
    try {
      const [id] = await f.bind();
      await assert.rejects(f.execute('chat.config.set', { id, config: { model: 'model-b' } }));
      assert.equal(f.calls.filter(row => row.method === 'select').length, 0); assert.equal(f.saved(id).pendingConfiguration ?? null, null);
      Object.assign(observed, { running: false, state: 'ready' });
      assert.equal((await f.execute('chat.config.set', { id, config: { model: 'model-b' } })).config.model, 'model-b');
    } finally { await f.service.close(); }
  });
  await check('late ACK after Chat close/reconstruction cannot overwrite restarted intent or history', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ select: async () => { entered(); await gate; return { modelControl: control('model-b') }; } });
    try {
      const [id] = await f.bind();
      const pending = f.execute('chat.config.set', { id, config: { model: 'model-b' } }); const settled = pending.then(() => null, error => error);
      await started; await f.restart(); const restarted = f.saved(id);
      release(); assert.equal((await settled).code, 'SERVICE_CLOSED');
      assert.deepEqual(f.saved(id), restarted, 'closed service must not persist a late ACK');
      const recovered = await f.execute('chat.config.reconcile', { id }); assert.equal(recovered.config.model, 'model-b');
      assert.equal(f.calls.filter(row => row.method === 'select').length, 1);
      assert.equal((await f.execute('chat.history', { id })).messages[0].text, 'Preserved fixture history');
    } finally { release?.(); await f.service.close(); }
  });
  await check('deleting Chat cannot erase outstanding configuration evidence and recovers after confirmed save', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ select: async () => { entered(); await gate; return { modelControl: control('model-b') }; } });
    try {
      const [id] = await f.bind();
      const pending = f.execute('chat.config.set', { id, config: { model: 'model-b' } }); const settled = pending.then(value => ({ value }), error => ({ error }));
      await started; await assert.rejects(f.execute('chat.sessions.delete', { id }), { code: 'CONFIG_BUSY' });
      assert.ok(f.saved(id).pendingConfiguration); assert.equal((await f.execute('chat.history', { id })).messages[0].text, 'Preserved fixture history');
      release(); assert.equal((await settled).value.config.model, 'model-b');
      await f.execute('chat.sessions.delete', { id }); assert.equal((await f.execute('chat.sessions.list')).sessions.length, 0);
    } finally { release?.(); await f.service.close(); }
  });
  for (const failurePoint of ['final-save', 'receipt-save']) await check('real Continuity handoff plus Chat ' + failurePoint + ' recovers same Task without another handoff', async () => {
    const f = await handoffFixture(); let restore = () => {};
    try {
      const taskBefore = f.taskRuntime.get({ id: f.task.id }).task;
      restore = failWrites(f.service._store.sessionsFile, store => store.sessions.some(row => row.id === 'linked-chat' &&
        (failurePoint === 'final-save' ? row.config.model === 'model-b' : !!row.pendingConfiguration?.handoff)));
      await assert.rejects(f.execute('chat.config.set', { config: { model: 'model-b', reasoning: 'xhigh' } }));
      const after = f.taskRuntime.get({ id: f.task.id }).task;
      assert.equal(after.id, taskBefore.id); assert.equal(after.goal, taskBefore.goal); assert.equal(after.workspaceId, taskBefore.workspaceId);
      assert.notEqual(after.currentAgent.sessionId, f.source.sessionId, 'Continuity actually committed a new Session');
      assert.equal(f.saved().config.model, 'model-a'); assert.equal(f.saved().taskId, f.task.id);
      assert.equal(f.continuity.runtime.history({ taskId: f.task.id }).total, 1);
      restore(); restore = () => {}; await f.restart();
      const recovered = await f.execute('chat.config.reconcile');
      assert.equal(recovered.config.model, 'model-b'); assert.equal(recovered.dshSessionId, after.currentAgent.sessionId);
      assert.equal(f.saved().pendingConfiguration, null); assert.equal(f.continuity.runtime.history({ taskId: f.task.id }).total, 1);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 2, 'source plus one target, no blind replay');
    } finally { restore(); await f.service.close(); }
  });
  await check('Chat intent binds actual Task revision after preserving Owner context, before real Continuity handoff', async () => {
    const f = await handoffFixture({ ownerContext: true });
    try {
      const before = f.taskRuntime.get({ id: f.task.id }).task;
      const changed = await f.execute('chat.config.set', { config: { model: 'model-b' } });
      assert.equal(changed.config.model, 'model-b');
      const current = f.taskRuntime.get({ id: f.task.id }).task;
      assert.ok(current.rev > before.rev); assert.equal(current.ownerContext.sessionId, 'linked-chat');
      assert.equal(f.continuity.runtime.history({ taskId: f.task.id }).total, 1);
    } finally { await f.service.close(); }
  });
  await check('missing handoff receipt cannot turn the old source model ACK into target Provider success', async () => {
    const gates = { canRollover: false }, f = await handoffFixture({ nextTurnTarget: true, gates, boundarySupported: false });
    try {
      const before = f.saved(), task = f.taskRuntime.get({ id: f.task.id }).task;
      await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }), { code: 'ROLLOVER_NOT_SAFE' });
      assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 0);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 1);
      await assert.rejects(f.execute('chat.config.reconcile'), { code: 'CONFIG_RECONCILIATION_REQUIRED' });
      assert.deepEqual(f.saved().config, before.config); assert.equal(f.saved().runtimeProvider, before.runtimeProvider);
      assert.equal(f.saved().dshSessionId, before.dshSessionId); assert.ok(f.saved().pendingConfiguration);
    } finally { await f.service.close(); }
  });
  for (const refusal of ['can-rollover', 'target-preflight']) await check('trusted ' + refusal + ' refusal keeps old config and permits explicit same-Task retry', async () => {
    const gates = { canRollover: refusal !== 'can-rollover', targetBlocked: refusal === 'target-preflight' };
    const f = await handoffFixture({ nextTurnTarget: true, gates });
    try {
      const before = f.saved(), task = f.taskRuntime.get({ id: f.task.id }).task;
      await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }), { code: 'ROLLOVER_NOT_SAFE' });
      assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 0);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 1);
      assert.equal(f.saved().pendingConfiguration, null, 'authoritative no-effect refusal must not strand the Chat');
      const recovered = await f.execute('chat.config.reconcile'); assert.deepEqual(recovered.config, before.config); assert.equal(recovered.dshSessionId, before.dshSessionId);
      gates.canRollover = true; gates.targetBlocked = false;
      const changed = await f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } });
      assert.equal(changed.config.agentProvider, 'next-turn-fixture'); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 1);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 2);
    } finally { await f.service.close(); }
  });
  await check('same refusal code after target creation stays unknown and cannot use missing history/source ACK as proof', async () => {
    const gates = { creationError: coded('ROLLOVER_NOT_SAFE') }, f = await handoffFixture({ nextTurnTarget: true, gates });
    try {
      await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }));
      assert.equal(f.continuity.runtime.history({ taskId: f.task.id }).total, 0); assert.equal(f.calls.filter(row => row.method === 'create').length, 2);
      const before = f.saved(); assert.ok(before.pendingConfiguration); assert.equal(f.continuity.runtime.isInFlight(f.task.id), true);
      assert.ok(Number.isFinite(before.pendingConfiguration.attemptedAt));
      await assert.rejects(f.execute('chat.config.reconcile'), { code: 'CONFIG_RECONCILIATION_REQUIRED' });
      assert.deepEqual(f.saved().config, before.config); assert.equal(f.calls.filter(row => row.method === 'create').length, 2);
      await f.restart(); await assert.rejects(f.execute('chat.config.reconcile'), { code: 'CONFIG_RECONCILIATION_REQUIRED' });
      assert.equal(f.saved().config.agentProvider, 'native-fixture');
    } finally { await f.service.close(); }
  });
  await check('handoff boundary write failure prevents Domain writes/creation and prepared intent recovers after restart', async () => {
    let prepared = 0, broken = false;
    const f = await handoffFixture({ nextTurnTarget: true, prepareHandoff: () => { prepared++; } }); let restore = () => {};
    try {
      const task = f.taskRuntime.get({ id: f.task.id }).task;
      restore = failWrites(f.service._store.sessionsFile, store => {
        if (store.sessions.some(row => Number.isFinite(row.pendingConfiguration?.attemptedAt))) broken = true;
        return broken;
      });
      await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }), { code: 'CONFIG_SAVE_FAILED' });
      assert.equal(f.handoffAttempts.length, 1, 'real Continuity must reach its before-effects boundary before marking attempted');
      assert.equal(prepared, 0); assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 1); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 0);
      assert.equal(fs.existsSync(path.join(f.continuity.runtime._dir, 'handoff')), false); assert.equal(fs.existsSync(path.join(f.continuity.runtime._dir, 'transactions')), false);
      assert.equal(f.saved().pendingConfiguration.phase, 'prepared'); assert.equal(f.saved().pendingConfiguration.attemptedAt, undefined);
      restore(); restore = () => {}; await f.restart();
      const recovered = await f.execute('chat.config.reconcile'); assert.equal(recovered.config.agentProvider, 'native-fixture'); assert.equal(f.saved().pendingConfiguration, null);
    } finally { restore(); await f.service.close(); }
  });
  await check('closed Chat refuses a late Continuity boundary before any handoff effects', async () => {
    let entered, release, prepared = 0;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = await handoffFixture({ nextTurnTarget: true, statusHook: async () => { entered(); await gate; }, prepareHandoff: () => { prepared++; } });
    try {
      const task = f.taskRuntime.get({ id: f.task.id }).task;
      const pending = f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }).then(value => ({ value }), error => ({ error }));
      await started; await f.restart(); const before = f.saved(); release(); assert.equal((await pending).error?.code, 'SERVICE_CLOSED');
      assert.equal(prepared, 0); assert.deepEqual(f.saved(), before); assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 1); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 0);
      assert.equal((await f.execute('chat.config.reconcile')).config.agentProvider, 'native-fixture');
    } finally { release?.(); await f.service.close(); }
  });
  await check('trusted handoff boundary rechecks real Task source revision after asynchronous preflight', async () => {
    let entered, release, prepared = 0;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = await handoffFixture({ nextTurnTarget: true, statusHook: async () => { entered(); await gate; }, prepareHandoff: () => { prepared++; } });
    try {
      const task = f.taskRuntime.get({ id: f.task.id }).task;
      const pending = f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }).then(value => ({ value }), error => ({ error }));
      await started; f.taskRuntime.setProgress({ id: task.id, expectedRev: task.rev, note: 'Owner changed Task during preflight' }); release();
      assert.equal((await pending).error?.code, 'TASK_CONFLICT'); assert.equal(prepared, 0);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 1); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 0);
      assert.equal(f.saved().pendingConfiguration, null); assert.equal(f.saved().config.agentProvider, 'native-fixture');
      assert.equal((await f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } })).config.agentProvider, 'next-turn-fixture');
      assert.equal(prepared, 1); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 1);
    } finally { release?.(); await f.service.close(); }
  });
  await check('reloaded Task-bound Chat switches Provider through verified current Task source without reviving a live Chat Session', async () => {
    const f = await handoffFixture({ nextTurnTarget: true, ownerContext: true });
    try {
      const historyFile = path.join(f.stateDir, 'desktop-chat', 'history', 'linked-chat.json'); fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      const messages = [{ id: 'prior-owner', role: 'user', text: 'Keep prior Task constraints', at: 1 },
        { id: 'prior-report', role: 'assistant', text: 'Earlier report', at: 2, usage: { inputTokens: 4, outputTokens: 2 } }];
      fs.writeFileSync(historyFile, JSON.stringify({ schemaVersion: 1, messages }));
      await f.restart(); const cold = f.saved();
      assert.equal(cold.dshSessionId, null); assert.equal(cold.runtimeProvider, null); assert.equal(cold.taskId, f.task.id);
      const changed = await f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } });
      assert.equal(changed.taskId, f.task.id); assert.equal(changed.config.agentProvider, 'next-turn-fixture');
      const attempt = f.handoffAttempts[0]; assert.equal(attempt.projectedSessionId, null);
      assert.equal(attempt.sourceBinding.provider, 'native-fixture'); assert.equal(attempt.sourceBinding.sessionId, f.source.sessionId);
      assert.equal(attempt.sourceBinding.taskId, f.task.id); assert.equal(attempt.sourceBinding.taskRevision, attempt.request.expectedConfigurationSource.taskRevision);
      assert.ok(f.calls.some(row => row.method === 'status' && row.sessionId === f.source.sessionId));
      const task = f.taskRuntime.get({ id: f.task.id }).task; assert.equal(task.currentAgent.sessionId, changed.dshSessionId);
      assert.equal(task.ownerContext.sessionId, 'linked-chat'); assert.equal(task.ownerContext.entries[0].text, messages[0].text);
      assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 1);
      const history = await f.execute('chat.history'); assert.deepEqual(history.messages.map(row => row.text), messages.map(row => row.text));
      assert.deepEqual(history.messages[1].usage, messages[1].usage);
    } finally { await f.service.close(); }
  });
  await check('reloaded Task-bound Chat still refuses direct same-Provider native model changes', async () => {
    const f = await handoffFixture({ nextTurnTarget: true });
    try {
      await f.restart(); await assert.rejects(f.execute('chat.config.set', { config: { model: 'model-b' } }), { code: 'TASK_HANDOFF_REQUIRED' });
      assert.equal(f.handoffAttempts.length, 0); assert.equal(f.calls.filter(row => row.method === 'create').length, 1);
    } finally { await f.service.close(); }
  });
  for (const risk of ['status', 'transport', 'operation']) await check('reloaded Chat provider handoff retains real ' + risk + ' refusal and succeeds only after owner evidence recovers', async () => {
    const gates = {}, f = await handoffFixture({ nextTurnTarget: true, gates });
    try {
      await f.restart(); const before = f.saved(), task = f.taskRuntime.get({ id: f.task.id }).task;
      if (risk === 'status') gates.statusUnknown = true;
      if (risk === 'transport') gates.statusError = 'SESSION_TRANSPORT_UNKNOWN';
      if (risk === 'operation') gates.unknownOperation = true;
      await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }),
        { code: risk === 'transport' ? 'SESSION_TRANSPORT_UNKNOWN' : 'ROLLOVER_NOT_SAFE' });
      assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task); assert.deepEqual(f.saved().config, before.config);
      assert.equal(f.calls.filter(row => row.method === 'create').length, 1); assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 0);
      gates.statusUnknown = false; gates.statusError = null; gates.unknownOperation = false;
      assert.equal((await f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } })).config.agentProvider, 'next-turn-fixture');
      assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 1);
    } finally { await f.service.close(); }
  });
  for (const changed of ['provider', 'workspace']) await check('reloaded Chat cannot transfer a Task whose stored source ' + changed + ' no longer matches', async () => {
    const f = await handoffFixture({ nextTurnTarget: true });
    try {
      await f.restart(); const task = f.taskRuntime.get({ id: f.task.id }).task;
      if (changed === 'provider') {
        const replacement = await f.broker.createSession('next-turn-fixture', { taskId: task.id, workspaceId: task.workspaceId });
        f.taskRuntime.attachAgent({ id: task.id, expectedRev: task.rev, provider: 'next-turn-fixture', sessionId: replacement.sessionId });
      } else f.taskRuntime.update({ id: task.id, expectedRev: task.rev, workspaceId: 'different-workspace' });
      const before = f.taskRuntime.get({ id: task.id }).task;
      await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }),
        { code: changed === 'provider' ? 'TASK_SESSION_MISMATCH' : 'WORKSPACE_RECONCILIATION_REQUIRED' });
      assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, before); assert.equal(f.handoffAttempts.length, 0);
      assert.equal(f.saved().config.agentProvider, 'native-fixture');
    } finally { await f.service.close(); }
  });
  await check('ordinary new Chat cannot acquire another stored Task by choosing its Provider', async () => {
    const f = await handoffFixture({ nextTurnTarget: true });
    try {
      await f.restart(); const task = f.taskRuntime.get({ id: f.task.id }).task;
      const row = await f.service.execute({ method: 'chat.sessions.create' });
      const changed = await f.service.execute({ method: 'chat.config.set', params: { id: row.id, config: { agentProvider: 'next-turn-fixture' } } });
      assert.equal(changed.taskId, null); assert.equal(changed.dshSessionId, null);
      assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task); assert.equal(f.handoffAttempts.length, 0);
      assert.equal(f.calls.filter(item => item.method === 'create').length, 1);
    } finally { await f.service.close(); }
  });
  await check('Auto routing persists its own Task binding and reload can formally hand off its current Managed source', async () => {
    const f = await handoffFixture({ automaticRoute: true, nextTurnTarget: true, ownerContext: true });
    try {
      const warm = f.saved(); assert.equal(warm.config.agentProvider, null); assert.equal(warm.runtimeProvider, 'cetamesh');
      await f.restart(); const cold = f.saved(); assert.equal(cold.taskId, f.task.id); assert.equal(cold.config.agentProvider, null);
      assert.equal(cold.runtimeProvider, null); assert.equal(cold.dshSessionId, null);
      const changed = await f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } });
      assert.equal(changed.taskId, f.task.id); assert.equal(changed.config.agentProvider, 'next-turn-fixture');
      const attempt = f.handoffAttempts[0]; assert.equal(attempt.sourceBinding.provider, 'cetamesh'); assert.equal(attempt.sourceBinding.sessionId, f.source.sessionId);
      assert.equal(attempt.projectedSessionId, null); assert.equal(f.continuity.runtime.history({ taskId: f.task.id }).total, 1);
      assert.equal((await f.execute('chat.history')).messages[0].text, 'Analyze this owned project through Auto routing');
      const task = f.taskRuntime.get({ id: f.task.id }).task;
      const fresh = await f.service.execute({ method: 'chat.sessions.create' });
      await f.service.execute({ method: 'chat.config.set', params: { id: fresh.id, config: { agentProvider: 'next-turn-fixture' } } });
      assert.equal((await f.service.execute({ method: 'chat.sessions.list' })).sessions.find(row => row.id === fresh.id).taskId, null);
      assert.deepEqual(f.taskRuntime.get({ id: task.id }).task, task); assert.equal(f.handoffAttempts.length, 1);
    } finally { await f.service.close(); }
  });
  for (const failFinalSave of [false, true]) await check('native new-session-only Provider switch preserves actual assignment without inventing a model ACK; save failure=' + failFinalSave, async () => {
    const f = await handoffFixture({ nextTurnTarget: true }); let restore = () => {};
    try {
      if (failFinalSave) restore = failWrites(f.service._store.sessionsFile, store => store.sessions.some(row => row.config.agentProvider === 'next-turn-fixture'));
      let changed;
      if (failFinalSave) {
        await assert.rejects(f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } }), { code: 'CONFIG_SAVE_FAILED' });
        assert.equal(f.saved().config.agentProvider, 'native-fixture');
        restore(); restore = () => {}; await f.restart(); changed = await f.execute('chat.config.reconcile');
      } else changed = await f.execute('chat.config.set', { config: { agentProvider: 'next-turn-fixture' } });
      assert.equal(changed.config.agentProvider, 'next-turn-fixture'); assert.equal(changed.config.model, '');
      assert.equal(changed.configuration.application, 'requires-new-session'); assert.equal(changed.configuration.runtime, 'unknown'); assert.equal(changed.configuration.durable, true);
      assert.equal(f.taskRuntime.get({ id: f.task.id }).task.currentAgent.sessionId, changed.dshSessionId);
      assert.equal((await f.execute('chat.catalog')).modelControl.application, 'next-turn');
      assert.equal(f.continuity.runtime.history({ taskId: f.task.id }).total, 1); assert.equal(f.calls.filter(row => row.method === 'create').length, 2);
    } finally { restore(); await f.service.close(); }
  });
  await check('Task revision change during status-only reconciliation refuses then recovers with fresh unchanged owner', async () => {
    let hold = false, release, entered;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const f = await handoffFixture({ statusHook: async () => { if (hold) { entered(); await gate; } } }); let restore = () => {};
    try {
      restore = failWrites(f.service._store.sessionsFile, store => store.sessions.some(row => row.config.model === 'model-b'));
      await assert.rejects(f.execute('chat.config.set', { config: { model: 'model-b' } })); restore(); restore = () => {};
      hold = true; const recovery = f.execute('chat.config.reconcile').then(value => ({ value }), error => ({ error })); await started;
      const task = f.taskRuntime.get({ id: f.task.id }).task;
      f.taskRuntime.setProgress({ id: task.id, expectedRev: task.rev, note: 'Concurrent Owner progress' });
      hold = false; release(); assert.equal((await recovery).error?.code, 'TASK_SESSION_MISMATCH');
      assert.equal(f.saved().config.model, 'model-a');
      assert.equal((await f.execute('chat.config.reconcile')).config.model, 'model-b');
      assert.equal(f.continuity.runtime.history({ taskId: task.id }).total, 1);
    } finally { release?.(); restore(); await f.service.close(); }
  });
  await check('Managed save failure preserves in-memory durable config and next-turn intent can clear without a request', async () => {
    const f = await managedFixture(); let restore = () => {};
    try {
      const row = await f.execute('chat.sessions.create');
      restore = failWrites(f.service._store.sessionsFile, store => store.sessions.some(entry => entry.config.model === 'gpt-new'));
      await assert.rejects(f.execute('chat.config.set', { id: row.id, config: { model: 'gpt-new' } }));
      assert.equal((await f.execute('chat.sessions.list')).sessions[0].config.model, 'gpt-5-fixture');
      restore(); restore = () => {};
      assert.equal((await f.execute('chat.config.reconcile', { id: row.id })).config.model, 'gpt-5-fixture');
      assert.equal(f.requests.length, 0);
      const changed = await f.execute('chat.config.set', { id: row.id, config: { model: 'gpt-new' } });
      assert.equal(changed.configuration.application, 'next-turn'); assert.equal(changed.configuration.runtime, 'not-required');
    } finally { restore(); await f.close(); }
  });
  await check('catalog whole-cache and pending responses are fenced by live connection/key revision', async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const f = await managedFixture({ catalogHook: async (req, res) => {
      if (req.url !== '/models') return false;
      entered(); await gate; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gpt-obsolete' }] })); return true;
    } });
    try {
      const pending = f.execute('chat.catalog').then(value => ({ value }), error => ({ error })); await started;
      f.secrets.set({ provider: 'openai', apiKey: 'fixture-rotated-key-987654', baseUrl: f.base + '/new' });
      let timer;
      const current = await Promise.race([f.execute('chat.catalog'), new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]).finally(() => clearTimeout(timer));
      if (!current) { release(); await pending; assert.fail('a new connection/key revision must not await the obsolete catalog request'); }
      assert.equal(current.modelProviders[0].models[0].id, 'gpt-new');
      release(); const old = await pending;
      if (old.error) assert.equal(old.error.code, 'MODEL_CONFIGURATION_CHANGED'); else assert.equal(old.value.modelProviders[0].models[0].id, 'gpt-new');
      assert.equal((await f.execute('chat.catalog')).modelProviders[0].models[0].id, 'gpt-new');
    } finally { release?.(); await f.close(); }
  });
  await check('all disabled models keep config/catalog recovery and make zero implicit DSH calls', async () => {
    const f = await managedFixture(); let dshCalls = 0;
    try {
      const snapshot = f.configuration.get();
      f.configuration.update({ expectedRevision: snapshot.revision, connections: snapshot.connections.map(row => ({ ...row, enabled: false })) });
      await f.service.close(); const service = createChatService({ ...f.options, api: { callEndpoint: async () => { dshCalls++; return { sessionId: 'forbidden-fallback' }; } } });
      try {
        const row = await service.execute({ method: 'chat.sessions.create' });
        await assert.rejects(service.execute({ method: 'chat.send', params: { id: row.id, text: 'A configured disabled model must stay disabled' } }),
          error => ['MODEL_NO_ENABLED_MODELS', 'MODEL_CONNECTION_DISABLED'].includes(error.code));
        assert.equal(dshCalls, 0); assert.equal((await service.execute({ method: 'chat.catalog' })).defaultModelProvider, null);
        assert.equal((await service.execute({ method: 'chat.config.set', params: { id: row.id, config: { mode: 'smart' } } })).config.mode, 'smart');
      } finally { await service.close(); }
    } finally { await f.close(); }
  });
  await check('removed model connection keeps its saved Chat identity on restart and cannot silently use Auto', async () => {
    const f = await managedFixture();
    try {
      const row = await f.execute('chat.sessions.create'); assert.equal(row.config.modelProvider, 'openai');
      const snapshot = f.configuration.get(); f.configuration.update({ expectedRevision: snapshot.revision, connections: [] });
      await f.restart();
      assert.equal((await f.execute('chat.sessions.list')).sessions[0].config.modelProvider, 'openai');
      await assert.rejects(f.execute('chat.send', { id: row.id, text: 'Retain exact removed source' })); assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  await check('disabling the last model leaves prior Auto Chat status and history readable', async () => {
    const f = await managedFixture();
    try {
      const row = await f.execute('chat.sessions.create'); await f.execute('chat.send', { id: row.id, text: 'Preserve readable prior request' });
      for (let i = 0; i < 100 && (await f.execute('chat.status', { id: row.id })).turn; i++) await new Promise(resolve => setTimeout(resolve, 2));
      await f.execute('chat.config.set', { id: row.id, config: { modelProvider: null } });
      const snapshot = f.configuration.get(); f.configuration.update({ expectedRevision: snapshot.revision, connections: snapshot.connections.map(entry => ({ ...entry, enabled: false })) });
      assert.equal((await f.execute('chat.status', { id: row.id })).turn, null);
      assert.equal((await f.execute('chat.history', { id: row.id })).messages[0].text, 'Preserve readable prior request');
    } finally { await f.close(); }
  });
  for (const missing of [false, true]) await check('actual Runtime wire/response configuration observations survive status/history/restart; response missing=' + missing, async () => {
    let release, entered; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const f = await managedFixture({ missingResponseModel: missing, streamHook: async () => { entered(); await gate; } });
    try {
      const row = await f.execute('chat.sessions.create'); await f.execute('chat.send', { id: row.id, text: 'private fixture prompt' }); await started;
      const status = await f.execute('chat.status', { id: row.id });
      assert.equal(status.turn.configurationObservation.requested.reasoning, 'max');
      assert.equal(status.turn.configurationObservation.effective.reasoning, 'high');
      assert.equal(status.turn.configurationObservation.source.effective, 'wire-projection');
      release();
      for (let i = 0; i < 100 && (await f.execute('chat.status', { id: row.id })).turn; i++) await new Promise(resolve => setTimeout(resolve, 2));
      const history = await f.execute('chat.history', { id: row.id }); const observed = history.messages.at(-1).configurationObservation;
      assert.equal(observed.requested.model, 'gpt-5-fixture'); assert.equal(observed.effective.model, 'gpt-5-fixture');
      assert.equal(observed.response.model, missing ? null : 'gpt-response'); assert.equal(observed.stage, 'response');
      assert.equal(observed.chatRequestId, history.messages.at(-1).requestId); assert.equal(observed.turnId, history.messages.at(-1).turnId);
      const encoded = JSON.stringify(f.events.filter(event => event.data?.configurationObservation));
      assert.ok(encoded.length > 2); assert.ok(!encoded.includes('fixture-private-key') && !encoded.includes(f.base) && !encoded.includes('private fixture prompt'));
      await f.restart(); assert.deepEqual((await f.execute('chat.status', { id: row.id })).configurationObservation, observed);
      const savedRevision = observed.configurationRevision;
      await f.execute('chat.config.set', { id: row.id, config: { reasoning: 'low' } });
      assert.equal((await f.execute('chat.history', { id: row.id })).messages.at(-1).configurationObservation.configurationRevision, savedRevision);
    } finally { release?.(); await f.close(); }
  });
  await check('production Composer distinguishes unsaved ACK/unknown/next-turn and keeps settings/recovery reachable', async () => {
    const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui'), require = createRequire(path.join(uiRoot, 'package.json'));
    const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
    const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
    try {
      const ui = await vite.ssrLoadModule('/src/app/ChatComposerPanels.tsx');
      const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
      const props = { models: [], selectedModelKey: '["",""]', selectedAgent: 'none', agentLabel: '普通聊天', query: '', onQueryChange() {}, onModelChange() {}, onReasoningChange() {}, onConfigure() {}, onClose() {}, onReconcile() {} };
      const render = extra => renderToStaticMarkup(React.createElement(ui.ChatModelPickerContent, { ...props, ...extra }));
      const configuration = { revision: 1, changeId: 'fixture-change', state: 'runtime-confirmed', application: 'runtime-confirmed', durable: false, runtime: 'confirmed', at: 1, errorCode: 'CONFIG_SAVE_FAILED' };
      assert.match(render({ configuration }), /运行时已确认.*保存尚未完成/);
      assert.match(render({ configuration }), /核对当前配置/); assert.match(render({ configuration }), /模型与服务设置/);
      assert.match(render({ configuration: { ...configuration, state: 'needs-reconciliation', runtime: 'unknown' } }), /配置结果尚未确认/);
      assert.match(render({ configuration: { ...configuration, state: 'saved', durable: true, application: 'next-turn', runtime: 'not-required' } }), /已保存.*下一回合/);
      assert.match(render({ saving: true }), /正在保存配置/);
      const native = render({ selectedAgent: 'native-fixture', modelControl: control(), configuration });
      assert.doesNotMatch(native, /当前 Agent 模型|role="option"/); assert.match(native, /最近确认/);
      const observation = { schemaVersion: 1, requestId: 'request', providerId: 'openai', connectionRevision: 1, requested: { model: 'gpt-5-fixture', reasoning: 'max' },
        effective: { model: 'gpt-5-fixture', reasoning: 'high' }, response: { model: null }, source: { model: 'request', reasoning: 'request', effective: 'wire-projection' },
        application: 'current-request', stage: 'response', overrideReason: 'adapter-reasoning-map', at: 1, chatRequestId: 'chat-request', turnId: 'turn', configurationRevision: 1 };
      const observed = render({ configurationObservation: observation });
      assert.match(observed, /请求参数观测/); assert.match(observed, /请求值/); assert.match(observed, /报文实际值/); assert.match(observed, /服务响应模型/); assert.match(observed, /未知/);
    } finally { await vite.close(); }
  });
} finally {
  if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith('cm-chat-configuration-')) throw Error('fixture cleanup boundary');
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
