import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatService } from '../src/desktop/chat-service.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';
import { createCapabilityBroker, createCapabilityPolicy, OWNER_ACTOR } from '../src/capability/index.js';
import { createCapabilityApproval } from '../src/capability/approval.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';

const sandbox = createSuiteSandbox({ suiteId: 'chat-stream-lifecycle' });
const results = [];
const invoke = (service, method, params = {}) => service.execute({ method: 'chat.' + method, params });
const runtime = { defaultProviderId: () => 'fixture', resolveProvider: id => ({ id }), supportsToolCalling: () => true };
const tool = id => ({ id, capability: 'filesystem.read', status: 'completed', durationMs: 1, summary: 'Safe receipt' });
async function until(read, label) {
  for (let i = 0; i < 200; i++) { if (await read()) return; await delay(5); }
  assert.fail('Timeout: ' + label);
}
async function check(name, action) {
  try { results.push({ name, status: 'PASS', facts: await action() }); }
  catch (error) { results.push({ name, status: 'FAIL', message: error.message, actual: error.actual, expected: error.expected }); }
  finally { mock.timers.reset(); }
}
async function fixture(name, coordinator = null) {
  let timestamp = 1000;
  const events = [], runs = [];
  const service = createChatService({ stateDir: path.join(sandbox.root, name), defaults: { model: 'fixture' }, api: {},
    modelRuntime: runtime, now: () => timestamp, onEvent: value => events.push({ at: timestamp, ...structuredClone(value) }),
    toolExecutionCoordinator: coordinator ?? { run: request => new Promise(resolve => {
      runs.push({ request, resolve }); request.onTextDelta('seed');
    }), cancelSession: () => ({ cancelled: 0 }) } });
  const session = await invoke(service, 'sessions.create');
  await invoke(service, 'send', { id: session.id, text: 'Controlled public streaming' });
  return { service, session, events, runs,
    advance(ms) { timestamp += ms; mock.timers.tick(ms); },
    inject(type, data = {}, seq) { service._injectEvent(session.id, { type, data, ...(seq === undefined ? {} : { seq }) }); },
    async close() { for (const run of runs) run.resolve({ status: 'completed', toolCalling: 'supported', text: 'seed' }); await service.close(); }
  };
}
const deltas = events => events.filter(row => row.event === 'chat.streaming' && row.data.delta).map(row => row.data.delta);

await check('quiet provider tail flushes within one throttle window without another chunk', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture('quiet');
  try {
    f.inject('assistant/reset'); f.events.length = 0;
    f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'A' } });
    f.advance(10);
    f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'B' } });
    assert.deepEqual(deltas(f.events), ['A']);
    f.advance(39); assert.deepEqual(deltas(f.events), ['A']);
    f.advance(1); assert.deepEqual(deltas(f.events), ['A', 'B']);
    f.advance(500); assert.deepEqual(deltas(f.events), ['A', 'B']);
    return { emittedBatches: deltas(f.events).length, tailDelayMs: f.events.find(row => row.data.delta === 'B').at - 1010,
      clock: 'deterministic timer ticks; no OS frame-rate claim' };
  } finally { await f.close(); }
});

for (const terminal of ['tool/activity', 'waiting', 'completed', 'failed']) {
  await check('pending public tail precedes ' + terminal, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture('ordering-' + terminal.replace('/', '-'));
    try {
      f.inject('assistant/reset'); f.events.length = 0;
      f.inject('turn/start', { runId: 'current', attemptId: 'attempt' }, 1);
      f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'A' } }, 2);
      f.advance(10);
      f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'B' } }, 3);
      f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'DUPLICATE' } }, 3);
      f.inject('assistant/chunk', { runId: 'old', chunk: { type: 'text-delta', text: 'STALE' } }, 90);
      f.advance(10);
      if (terminal === 'tool/activity') f.inject(terminal, { activity: tool('ordered') }, 4);
      else f.inject('turn/end', { reason: { kind: terminal, ...(terminal === 'waiting' ? { approvalId: 'one' } : {}) } }, 4);
      assert.deepEqual(deltas(f.events), ['A', 'B']);
      const index = f.events.findIndex(row => row.data.delta === 'B');
      assert.ok(index < f.events.length - 1, 'tail must precede critical event notification');
      f.advance(100); assert.deepEqual(deltas(f.events), ['A', 'B']);
      if (terminal !== 'tool/activity' && terminal !== 'waiting') {
        const history = await invoke(f.service, 'history', { id: f.session.id });
        assert.equal(history.messages.at(-1).text, 'AB');
      }
      return { emittedBatches: 2, tailDelayMs: 10, critical: terminal };
    } finally { await f.close(); }
  });
}

await check('cancel and new turn invalidate old queued timer ownership', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture('cancel');
  try {
    f.inject('assistant/reset'); f.events.length = 0;
    f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'old-A' } });
    f.advance(10); f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'old-B' } });
    f.inject('turn/end', { reason: { kind: 'cancelled' } });
    await invoke(f.service, 'send', { id: f.session.id, text: 'New turn' });
    const count = f.events.length, current = (await invoke(f.service, 'status', { id: f.session.id })).turn;
    f.runs[0].request.onStreamReset(); f.runs[0].request.onTextDelta('STALE_CALLBACK');
    f.advance(100);
    assert.equal(f.events.length, count, 'old timer/callback cannot publish into replacement request');
    assert.equal((await invoke(f.service, 'status', { id: f.session.id })).turn.requestId, current.requestId);
    assert.equal(deltas(f.events).join(''), 'old-Aold-Bseed');
  } finally { await f.close(); }
});

await check('close flushes the owned tail once and disposes its timer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture('close');
  f.inject('assistant/reset'); f.events.length = 0;
  f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'A' } });
  f.advance(10); f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'B' } });
  await f.close();
  assert.deepEqual(deltas(f.events), ['A', 'B']);
  const count = f.events.length; f.advance(100); assert.equal(f.events.length, count);
});

await check('external replacement resets remain real and cannot spoof a Managed status notice', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture('replacement');
  try {
    f.inject('assistant/reset'); f.events.length = 0;
    f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'old-A' } });
    f.advance(10); f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'old-B' } });
    f.inject('assistant/reset');
    assert.deepEqual(deltas(f.events), ['old-A', 'old-B']);
    assert.equal(f.events.at(-1).data.reset, true);
    assert.equal((await invoke(f.service, 'status', { id: f.session.id })).turn.displayText, '');
    f.inject('assistant/chunk', { chunk: { type: 'text-delta', text: 'Replacement' } });
    f.inject('assistant/message', { statusOnly: true, message: { content: [{ type: 'text', text: 'Replacement final' }] } });
    assert.equal(f.events.at(-1).data.replaceText, 'Replacement final');
    f.inject('turn/end', { reason: { kind: 'completed' } }); f.advance(100);
    assert.equal((await invoke(f.service, 'history', { id: f.session.id })).messages.at(-1).text, 'Replacement final');
  } finally { await f.close(); }
});

await check('model cycles and successive approvals preserve public text and stable history identity', async () => {
  let initial, resumed, resumeCount = 0;
  const pending = id => ({ status: 'pending', approvalId: id, toolCalling: 'supported' });
  const coordinator = {
    run: async request => { initial = request; request.onTextDelta('Before tool.'); request.onActivity(tool('read'));
      request.onStreamReset(); request.onTextDelta(' Before approval.'); return pending('a'); },
    pendingTarget: () => ({ kind: 'chat', sessionId: f.session.id, turnId: initial.turnId }),
    resumeApproval: async request => { resumed = request; resumeCount++; request.onStreamReset();
      if (resumeCount === 1) { request.onTextDelta(' Between approvals.'); return pending('b'); }
      request.onTextDelta(' Final.'); return { status: 'completed', text: ' Final.', toolCalling: 'supported' }; },
    cancelSession: () => ({ cancelled: 0 })
  };
  const f = await fixture('cycles', coordinator);
  try {
    await until(async () => (await invoke(f.service, 'status', { id: f.session.id })).turn?.state === 'waiting-approval', 'approval a');
    let status = await invoke(f.service, 'status', { id: f.session.id });
    assert.equal(status.turn.displayText, 'Before tool. Before approval.');
    assert.equal(status.turn.statusMessage, 'Waiting for Owner approval.');
    const requestId = status.turn.requestId;
    const checkpoint = JSON.parse(fs.readFileSync(path.join(f.service._store.historyDir, f.session.id + '.json'), 'utf8')).activeTurn;
    assert.equal(checkpoint.text, status.turn.displayText);
    const snapshotDir = path.join(sandbox.root, 'interrupted-snapshot');
    fs.cpSync(path.join(sandbox.root, 'cycles'), snapshotDir, { recursive: true });
    const recovered = createChatService({ stateDir: snapshotDir, defaults: {}, api: {} });
    try {
      const history = await invoke(recovered, 'history', { id: f.session.id });
      assert.equal(history.messages.at(-1).id, checkpoint.id);
      assert.equal(history.messages.at(-1).text, checkpoint.text);
      assert.equal(history.messages.at(-1).interrupted, true, 'reconstruction retains text without inventing successful execution');
    } finally { await recovered.close(); }
    await f.service.resumeApproval({ approvalId: 'a', decisionResult: { approved: true } });
    status = await invoke(f.service, 'status', { id: f.session.id });
    assert.equal(status.turn.displayText, 'Before tool. Before approval. Between approvals.');
    assert.equal(status.turn.requestId, requestId);
    await f.service.resumeApproval({ approvalId: 'b', decisionResult: { approved: true } });
    const history = await invoke(f.service, 'history', { id: f.session.id });
    const message = history.messages.at(-1);
    assert.equal(message.text, 'Before tool. Before approval. Between approvals. Final.');
    assert.equal(message.id, checkpoint.id);
    assert.equal(message.toolActivity[0].id, 'read');
    const resetEvents = f.events.filter(row => row.event === 'chat.streaming' && row.data.reset);
    assert.equal(resetEvents.length, 1, 'only the genuinely new request resets visible content');
    initial.onStreamReset(); resumed.onTextDelta('STALE');
    const rebuilt = createChatService({ stateDir: path.join(sandbox.root, 'cycles'), defaults: {}, api: {} });
    try { assert.equal((await invoke(rebuilt, 'history', { id: f.session.id })).messages.at(-1).text, message.text); }
    finally { await rebuilt.close(); }
    return { approvals: resumeCount, retainedText: message.text, stableId: message.id };
  } finally { await f.close(); }
});

await check('actual Core model, Broker tools and two approval operations retain every public cycle', async () => {
  const base = path.join(sandbox.root, 'core'), marker = path.join(base, 'effects.txt');
  fs.mkdirSync(base, { recursive: true });
  const services = createCetaMeshServices({ stateDir: path.join(base, 'state'), dataRoot: path.join(base, 'data'),
    resourceRoot: base, sourceRoot: base, deferOptionalStart: true });
  let calls = 0;
  const ui = (method, params = {}) => services.desktopUiService.execute({ method, params });
  const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  services.capabilityService.broker.register({ id: 'fixture.approval', permission: 'publish', risk: 'high',
    description: 'Append a controlled isolated evidence marker.', inputSchema: schema,
    execute: ({ input }) => { fs.appendFileSync(marker, input.value); return { observed: fs.readFileSync(marker, 'utf8') }; } });
  services.modelRegistry.register({ id: 'stream-fixture', label: 'Deterministic local model leaf', supportsTools: true,
    defaultModel: 'fixture', health: async () => ({ available: true, configured: true }), listModels: async () => [{ id: 'fixture' }],
    chat: async () => { throw Error('Unexpected non-streaming request'); }, stream: async function* (request) {
      calls++;
      const receipts = request.messages.filter(row => row.role === 'tool');
      if (calls > 1) assert.match(JSON.stringify(receipts), calls === 2 ? /observed.*A/ : /observed.*AB/,
        'the actual effect result must return to the next model cycle');
      yield { type: 'assistant/reasoning', data: { text: 'PRIVATE_REASONING_SENTINEL' } };
      const text = calls === 1 ? 'Before first approval.' : calls === 2 ? ' Between approvals.' : ' Final verified reply.';
      yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } };
      if (calls < 3) yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'effect-' + calls,
        capabilityId: 'fixture.approval', arguments: JSON.stringify({ value: calls === 1 ? 'A' : 'B' }) }] } };
      yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    } });
  services.providerSecrets.set({ provider: 'stream-fixture', apiKey: 'synthetic-local-only' });
  try {
    const session = await ui('ui.chat.sessions.create');
    await ui('ui.chat.config.set', { id: session.id, config: { agentProvider: 'none', modelProvider: 'stream-fixture', model: 'fixture', reasoning: 'off' } });
    await ui('ui.chat.send', { id: session.id, text: 'Run the two explicit isolated marker effects.' });
    let requestId, stableId;
    for (let i = 0; i < 2; i++) {
      let status;
      await until(async () => { status = await invoke(services.chatService, 'status', { id: session.id }); return status.turn?.state === 'waiting-approval'; }, 'Core approval ' + i);
      assert.equal(status.turn.displayText, i === 0 ? 'Before first approval.' : 'Before first approval. Between approvals.');
      if (i === 0) { requestId = status.turn.requestId; assert.equal(fs.existsSync(marker), false); }
      else { assert.equal(status.turn.requestId, requestId); assert.equal(fs.readFileSync(marker, 'utf8'), 'A'); }
      const checkpoint = JSON.parse(fs.readFileSync(path.join(services.chatService._store.historyDir, session.id + '.json'), 'utf8')).activeTurn;
      stableId ??= checkpoint.id; assert.equal(checkpoint.id, stableId); assert.equal(checkpoint.text, status.turn.displayText);
      const accepted = await ui('ui.approvals.decide', { id: status.turn.approvalId, approve: true });
      assert.equal(accepted.status, 'accepted');
      await until(async () => {
        const operation = await ui('ui.approvals.operation', { id: accepted.operationId });
        if (['failed', 'unknown', 'cancelled'].includes(operation.status)) assert.fail(JSON.stringify(operation));
        return operation.status === (i === 0 ? 'waiting' : 'completed');
      }, 'Core approval operation settlement');
    }
    await until(async () => !(await invoke(services.chatService, 'status', { id: session.id })).turn, 'Core final history');
    const history = await ui('ui.chat.history', { id: session.id }), message = history.messages.at(-1);
    assert.equal(calls, 3); assert.equal(fs.readFileSync(marker, 'utf8'), 'AB');
    assert.equal(message.id, stableId); assert.equal(message.requestId, requestId);
    assert.equal(message.text, 'Before first approval. Between approvals. Final verified reply.');
    assert.equal(message.toolActivity.length, 2); assert.ok(message.toolActivity.every(row => row.status === 'completed'));
    const publicEvents = (await services.uiEventBus.next({ after: 0, waitMs: 0 })).events;
    let visible = '';
    for (const event of publicEvents.filter(row => row.event === 'chat.streaming')) {
      if (event.data.reset) visible = '';
      if (typeof event.data.replaceText === 'string') visible = event.data.replaceText;
      if (event.data.delta) visible += event.data.delta;
    }
    assert.equal(visible, message.text, 'public transport and persisted final text agree without duplicated final prose');
    assert.doesNotMatch(JSON.stringify({ history, publicEvents }), /PRIVATE_REASONING_SENTINEL|synthetic-local-only/);
    return { modelCalls: calls, effects: fs.readFileSync(marker, 'utf8'), approvals: 2, publicText: message.text,
      evidence: 'real Core composition, local model leaf, actual isolated marker effects; no live model or native UI' };
  } finally {
    for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
  }
});

for (const resumed of [false, true]) {
  await check('Core uncertain effect retains public preamble ' + (resumed ? 'after approval resume' : 'in initial model cycle'), async () => {
    const base = path.join(sandbox.root, resumed ? 'unknown-resumed' : 'unknown-direct');
    fs.mkdirSync(base, { recursive: true });
    const marker = path.join(base, 'effects.txt');
    const services = createCetaMeshServices({ stateDir: path.join(base, 'state'), dataRoot: path.join(base, 'data'),
      resourceRoot: base, sourceRoot: base, deferOptionalStart: true });
    const ui = (method, params = {}) => services.desktopUiService.execute({ method, params });
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    let modelCalls = 0, unknownCalls = 0;
    services.capabilityService.broker.register({ id: 'fixture.uncertain', permission: 'extension.invoke', risk: 'low', effect: 'non-idempotent',
      description: 'Record an isolated effect whose response is lost.', inputSchema: schema,
      execute: () => { unknownCalls++; fs.appendFileSync(marker, '?'); throw Object.assign(Error('Synthetic response lost'), { code: 'RPC_CLOSED' }); } });
    services.capabilityService.broker.register({ id: 'fixture.before-unknown', permission: 'extension.invoke', risk: 'high', effect: 'non-idempotent',
      description: 'Return a controlled receipt after exact Owner approval.', inputSchema: schema,
      execute: () => { fs.appendFileSync(marker, 'A'); return { receipt: 'approved-receipt' }; } });
    services.modelRegistry.register({ id: 'unknown-fixture', label: 'Local uncertain-effect model fixture', supportsTools: true,
      defaultModel: 'fixture', health: async () => ({ available: true, configured: true }), listModels: async () => [{ id: 'fixture' }],
      chat: async () => { throw Error('Unexpected non-streaming request'); }, stream: async function* (request) {
        modelCalls++;
        const approvalCycle = resumed && modelCalls === 1;
        if (resumed && modelCalls === 2) assert.match(JSON.stringify(request.messages.filter(row => row.role === 'tool')), /approved-receipt/);
        yield { type: 'assistant/reasoning', data: { text: 'PRIVATE_UNKNOWN_REASONING_SENTINEL' } };
        yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: approvalCycle ? 'Before approval.'
          : resumed ? ' Visible after approved effect.' : 'Visible before uncertain effect.' } } };
        yield { type: 'assistant/tool-calls', data: { toolCalls: approvalCycle
          ? [{ id: 'approved-before-unknown', capabilityId: 'fixture.before-unknown', arguments: '{}' }]
          : [{ id: 'uncertain-first', capabilityId: 'fixture.uncertain', arguments: '{}' },
            { id: 'must-not-replay', capabilityId: 'fixture.uncertain', arguments: '{}' }] } };
        yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
      } });
    services.providerSecrets.set({ provider: 'unknown-fixture', apiKey: 'synthetic-unknown-secret' });
    try {
      const session = await ui('ui.chat.sessions.create');
      await ui('ui.chat.config.set', { id: session.id, config: { agentProvider: 'none', modelProvider: 'unknown-fixture', model: 'fixture', reasoning: 'off' } });
      await ui('ui.chat.send', { id: session.id, text: 'Observe the uncertain isolated effect without replay.' });
      if (resumed) {
        let waiting;
        await until(async () => { waiting = await invoke(services.chatService, 'status', { id: session.id }); return waiting.turn?.state === 'waiting-approval'; }, 'approval before unknown');
        assert.equal(waiting.turn.displayText, 'Before approval.');
        const accepted = await ui('ui.approvals.decide', { id: waiting.turn.approvalId, approve: true });
        await until(async () => {
          const operation = await ui('ui.approvals.operation', { id: accepted.operationId });
          return ['completed', 'failed', 'unknown'].includes(operation.status);
        }, 'approval resumes to uncertain result');
      }
      await until(async () => !(await invoke(services.chatService, 'status', { id: session.id })).turn, 'uncertain turn terminal');
      const history = await ui('ui.chat.history', { id: session.id }), message = history.messages.at(-1);
      assert.equal(message.errorCode, 'OUTCOME_UNKNOWN');
      assert.equal(message.activityState, 'error');
      assert.ok(message.toolActivity.some(row => row.status === 'outcome-unknown'));
      assert.equal(unknownCalls, 1, 'the unknown tool aborts its batch before another dispatch');
      assert.equal(modelCalls, resumed ? 2 : 1, 'unknown effects do not start a recovery model request');
      assert.equal(fs.readFileSync(marker, 'utf8'), resumed ? 'A?' : '?');
      assert.equal(services.toolExecutionCoordinator.recoveryForSession(session.id)?.state, 'needs-reconciliation');
      const expectedText = resumed ? 'Before approval. Visible after approved effect.' : 'Visible before uncertain effect.';
      assert.equal(message.text, expectedText, 'an empty partial result cannot retract already emitted public text');
      const publicEvents = (await services.uiEventBus.next({ after: 0, waitMs: 0 })).events;
      assert.doesNotMatch(JSON.stringify({ history, publicEvents }), /PRIVATE_UNKNOWN_REASONING_SENTINEL|synthetic-unknown-secret|Synthetic response lost/);
      await assert.rejects(invoke(services.chatService, 'continue', { id: session.id }), { code: 'NEEDS_RECONCILIATION' });
      assert.equal(unknownCalls, 1); assert.equal(modelCalls, resumed ? 2 : 1);
      return { modelCalls, unknownCalls, errorCode: message.errorCode, retainedText: message.text,
        recovery: services.toolExecutionCoordinator.recoveryForSession(session.id)?.state };
    } finally {
      for (const key of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[key].close();
    }
  });
}

await check('Managed approval notice is status-only and cannot replace already emitted public text', async () => {
  const base = path.join(sandbox.root, 'managed');
  let modelCalls = 0, effects = 0, task;
  const principal = { taskId: 'managed-task', workspaceId: 'managed-workspace', actor: { kind: 'agent', id: 'managed-fixture',
    grants: { taskIds: ['managed-task'], workspaceIds: ['managed-workspace'], capabilities: ['fixture.approval'] } } };
  const broker = createCapabilityBroker({ policy: createCapabilityPolicy({ resolveTask: () => task }),
    approval: createCapabilityApproval({ stateDir: base }) });
  const descriptor = { id: 'fixture.approval', permission: 'publish', risk: 'high', description: 'Return a bounded local counter receipt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ({ count: ++effects }) };
  broker.register(descriptor);
  const model = { ...runtime, chat: async () => { throw Error('Unexpected non-streaming call'); }, stream: async function* () {
    modelCalls++;
    yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: modelCalls === 1 ? 'Public preamble.' : ' Final managed reply.' } } };
    if (modelCalls === 1) yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'managed-call', capabilityId: descriptor.id, arguments: '{}' }] } };
    yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
  } };
  const coordinator = createToolExecutionCoordinator({ modelRuntime: model, capabilityBroker: broker, stateDir: base });
  const managed = createManagedAgentProvider({ modelRuntime: model, toolExecutionCoordinator: coordinator,
    taskPrincipalResolver: () => principal, buildProductTurnContext: () => ({ context: 'Controlled public tool fixture',
      manifest: [{ id: descriptor.id, description: descriptor.description, inputSchema: descriptor.inputSchema }] }) });
  const bound = await managed.provider.createSession({ modelProvider: 'fixture', model: 'fixture' });
  task = { id: principal.taskId, status: 'running', workspaceId: principal.workspaceId,
    currentAgent: { provider: 'cetamesh', sessionId: bound.sessionId } };
  const events = [];
  const chat = createChatService({ stateDir: base, defaults: { model: 'fixture' }, modelRuntime: model,
    defaultAgentProvider: () => 'cetamesh', agentProviders: [{ id: 'cetamesh', eventProtocol: 'dsh-session-events', requiresTask: true }],
    toolExecutionCoordinator: coordinator, resolveTask: () => task,
    onEvent: event => events.push(structuredClone(event)),
    platformRoute: async ({ text }) => {
      const accepted = await managed.provider.send({ sessionId: bound.sessionId, content: text });
      return { kind: 'agent', accepted: true, provider: 'cetamesh', sessionId: bound.sessionId, taskId: task.id, requestId: accepted.requestId };
    }, agentFollow: params => managed.provider.follow(params),
    agentExecute: ({ method, params }) => managed.provider[method.slice('agent.'.length)](params) });
  try {
    const session = await invoke(chat, 'sessions.create');
    await invoke(chat, 'send', { id: session.id, text: 'Observe the actual Managed approval stream.' });
    let waiting;
    try { await until(async () => { waiting = await invoke(chat, 'status', { id: session.id });
      return waiting.turn?.state === 'waiting-approval'; }, 'Managed pending'); }
    catch (error) { throw Error(error.message + ': ' + JSON.stringify({ waiting, modelCalls, events })); }
    assert.equal(waiting.turn.displayText, 'Public preamble.');
    assert.equal(waiting.turn.statusMessage, 'Waiting for Owner approval.');
    const row = broker.approvals.get(waiting.turn.approvalId);
    const decision = await broker.decide({ id: row.id, approve: true, actor: OWNER_ACTOR });
    await managed.resumeApproval({ approvalId: row.id, requestFingerprint: row.fingerprint, decisionResult: decision });
    await until(async () => !(await invoke(chat, 'status', { id: session.id })).turn, 'Managed final');
    const history = await invoke(chat, 'history', { id: session.id });
    assert.equal(history.messages.at(-1).text, 'Public preamble. Final managed reply.');
    assert.equal(effects, 1); assert.equal(modelCalls, 2);
    assert.ok(events.every(event => !event.data.replaceText?.includes('Owner approval is required')));
    return { modelCalls, effects, text: history.messages.at(-1).text, evidence: 'real Managed provider/coordinator/Broker and Follow; synthetic local model' };
  } finally { await chat.close(); await managed.close(); }
});

for (const result of results) console.log(JSON.stringify(result));
const failed = results.some(row => row.status === 'FAIL');
finalizeSuiteSandbox({ sandbox, failed });
process.exitCode = failed ? 1 : 0;
