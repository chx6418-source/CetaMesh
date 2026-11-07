import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createWorkspaceRegistry, workspaceRegistryFile } from '../src/workspace/registry.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createToolEvidenceStore } from '../src/context/tool-evidence.js';
import { createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider, createToolExecutionCoordinator } from '../src/model/index.js';

export const owner = { kind: 'owner', id: 'desktop' };
export const call = (id, capabilityId, input = {}) => ({ id, type: 'function', function: {
  name: 'cap_' + capabilityId.replaceAll('.', '_'), arguments: JSON.stringify(input) } });
export const toolId = (session, turn, cycle, index) => 'model:' + crypto.createHash('sha256').update(JSON.stringify([session, turn, cycle, index])).digest('hex');

// All dependencies remain real. Only an owned HTTP provider supplies deterministic
// model output; the read observer delays the completion of actual FileHandle IO.
export async function fixture({ files = { 'a.txt': 'alpha', 'b.txt': 'beta', 'c.txt': 'gamma', 'd.txt': 'delta' }, calls = [], coordinatorOptions = {}, agent = false, createBroker = null } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-model-reads-')));
  const root = path.join(base, 'workspace'), stateDir = path.join(base, 'state');
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  const registry = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir) });
  const workspaceEntry = registry.create({ name: 'Owned read fixture', root });
  const workspace = createWorkspaceService({ stateDir });
  const tasks = createTaskRuntime({ stateDir });
  const evidenceStore = createToolEvidenceStore({ stateDir });
  const capabilities = createCapabilityService({ stateDir, workspaceService: workspace, taskRuntime: tasks, evidenceStore });
  let task = null;
  if (agent) {
    task = tasks.create({ goal: 'Read owned fixtures', workspaceId: workspaceEntry.id });
    capabilities.grantTask(task.id, { capabilities: ['filesystem.read', 'filesystem.search', 'context.evidence.read', ...(capabilities.broker.registry.has('context.batch') ? ['context.batch'] : [])] });
  }
  const requests = [];
  const responses = [calls];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const next = responses.shift() ?? [];
    if (!Array.isArray(next)) { res.writeHead(next.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(next.body)); return; }
    const message = next.length ? { content: null, tool_calls: next } : { content: 'fixture complete' };
    res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
    if (body.stream) {
      const delta = next.length ? { content: null, tool_calls: next.map((item, index) => ({ ...item, index })) } : message;
      res.end('data: ' + JSON.stringify({ model: 'owned-fixture', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: next.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
    } else res.end(JSON.stringify({ model: 'owned-fixture', choices: [{ message, finish_reason: next.length ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const secrets = { raw: () => ({ apiKey: 'owned-local-fixture', baseUrl }), list: () => [{ provider: 'owned-fixture' }] };
  const provider = createOpenAiCompatibleModelProvider({ id: 'owned-fixture', label: 'Owned local HTTP fixture', baseUrl, secrets, supportsTools: true, defaultModel: 'owned-fixture' });
  const modelRuntime = createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [provider] }), secrets });
  const broker = createBroker ? createBroker({ capabilities, tasks, workspaceEntry, stateDir }) : capabilities.broker;
  const coordinator = createToolExecutionCoordinator({ stateDir, modelRuntime, capabilityBroker: broker, evidenceStore,
    ...(agent ? { actorResolver: () => capabilities.principalForTask(task.id) } : {}), ...coordinatorOptions });
  if (typeof capabilities.setReadBatchExecutor === 'function') capabilities.setReadBatchExecutor(coordinator.executeReadBatch);
  const options = { providerId: 'owned-fixture', model: 'owned-fixture', actor: agent ? capabilities.principalForTask(task.id) : owner,
    sessionId: 'read-session', turnId: 'read-turn', scope: { workspaceId: workspaceEntry.id, taskId: task?.id ?? null },
    manifest: capabilities.broker.list().filter(entry => entry.inputSchema && entry.description), messages: [{ role: 'user', content: 'Read the requested owned fixtures.' }] };
  return { base, root, stateDir, workspaceEntry, tasks, task, capabilities, broker, evidenceStore, coordinator, modelRuntime, requests, responses, options,
    journal: () => JSON.parse(fs.readFileSync(path.join(stateDir, 'model', 'tool-executions.json'), 'utf8')),
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); } };
}

export async function observeReads(root, action, { holdMs = 25, beforeRead, afterRead } = {}) {
  const originalOpen = fs.promises.open;
  const rows = [];
  let active = 0, peak = 0, opened = 0, closed = 0;
  fs.promises.open = async function (target, ...args) {
    const handle = await originalOpen.call(this, target, ...args);
    if (!path.resolve(String(target)).startsWith(root + path.sep)) return handle;
    const relative = path.relative(root, String(target)).replaceAll('\\', '/');
    opened++;
    const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
    handle.read = async (...readArgs) => {
      const row = { path: relative, start: performance.now(), end: null };
      rows.push(row); active++; peak = Math.max(peak, active);
      try {
        await beforeRead?.(row, { rows, active });
        const bytes = await originalRead(...readArgs);
        if (holdMs) await new Promise(resolve => setTimeout(resolve, relative === 'a.txt' ? holdMs * 2 : holdMs));
        await afterRead?.(row, bytes);
        return bytes;
      } finally { row.end = performance.now(); active--; }
    };
    handle.close = async (...closeArgs) => { const result = await originalClose(...closeArgs); closed++; return result; };
    return handle;
  };
  try { const result = await action({ rows, counts: () => ({ active, peak, opened, closed }) }); return { result, rows, peak, opened, closed }; }
  finally { fs.promises.open = originalOpen; }
}

async function main() {
  let passed = 0, failed = 0;
  const check = async (name, action) => { try { await action(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } };
  await check('actual HTTP model to Broker Workspace reads overlap at width two and retain original IDs/order', async () => {
    const f = await fixture({ calls: ['a', 'b', 'c', 'd'].map(id => call(id, 'filesystem.read', { path: id + '.txt' })) });
    try {
      const events = [];
      const configurations = [];
      const observed = await observeReads(f.root, () => f.coordinator.run({ ...f.options, onActivity: event => events.push(event), onConfiguration: value => configurations.push(value) }));
      assert.equal(observed.result.status, 'completed');
      assert.equal(observed.peak, 2, 'the coordinator must submit two real asynchronous FileHandle reads');
      assert.equal(observed.opened, observed.closed);
      assert(observed.rows[1].start < observed.rows[0].end, 'accepted IO execution intervals overlap');
      const toolMessages = f.requests[1].messages.filter(row => row.role === 'tool');
      assert.deepEqual(toolMessages.map(row => row.tool_call_id), ['a', 'b', 'c', 'd']);
      assert.deepEqual(toolMessages.map(row => JSON.parse(row.content).result.content), ['alpha', 'beta', 'gamma', 'delta']);
      const journal = f.journal();
      for (let index = 0; index < 4; index++) {
        const row = journal[toolId('read-session', 'read-turn', 0, index)];
        assert.equal(row.status, 'completed');
        assert.equal(row.originalIndex, index);
        assert(row.settledAt >= row.startedAt, 'actual settlement timestamps are durable');
      }
      assert.deepEqual(events.filter(row => row.status === 'completed').map(row => row.id), ['read-turn:a', 'read-turn:b', 'read-turn:c', 'read-turn:d']);
      assert(configurations.some(row => row.stage === 'serialized'));
      assert(configurations.some(row => row.stage === 'response'));
      assert.deepEqual(observed.result.configurationObservation, configurations.at(-1));
      assert.equal(observed.result.configurationObservation.effective.model, 'owned-fixture');
      assert(!JSON.stringify(configurations).includes('owned-local-fixture') && !JSON.stringify(configurations).includes('127.0.0.1'));
    } finally { await f.close(); }
  });
  await check('read groups stop before an approved writer and observe the resulting file only afterward', async () => {
    const f = await fixture({ calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' }),
      call('write', 'filesystem.write', { path: 'out.txt', content: 'written', expectedHash: null }), call('d', 'filesystem.read', { path: 'd.txt' })] });
    try {
      const observed = await observeReads(f.root, () => f.coordinator.run(f.options));
      assert.equal(observed.result.status, 'pending');
      assert.equal(observed.peak, 2);
      assert.deepEqual(observed.rows.map(row => row.path).sort(), ['a.txt', 'b.txt']);
      assert.equal(observed.opened, observed.closed);
      assert.equal(fs.existsSync(path.join(f.root, 'out.txt')), false);
      const row = f.capabilities.broker.approvals.get(observed.result.approvalId);
      const decisionResult = await f.capabilities.broker.decide({ id: row.id, approve: true, actor: owner });
      const result = await f.coordinator.resumeApproval({ approvalId: row.id, requestFingerprint: row.fingerprint, decisionResult });
      assert.equal(result.status, 'completed');
      assert.equal(fs.readFileSync(path.join(f.root, 'out.txt'), 'utf8'), 'written');
      assert.deepEqual(f.requests[1].messages.filter(row => row.role === 'tool').map(row => row.tool_call_id), ['a', 'b', 'write', 'd']);
    } finally { await f.close(); }
  });
  await check('two simultaneous turns share the coordinator width two rather than multiplying source IO', async () => {
    const calls = [call('a', 'filesystem.read', { path: 'a.txt' }), call('b', 'filesystem.read', { path: 'b.txt' })];
    const f = await fixture({ calls });
    f.responses.push(calls);
    try {
      const observed = await observeReads(f.root, () => Promise.all([
        f.coordinator.run(f.options), f.coordinator.run({ ...f.options, sessionId: 'second-session', turnId: 'second-turn' })
      ]));
      assert(observed.result.every(result => result.status === 'completed'));
      assert.equal(observed.opened, 4);
      assert.equal(observed.peak, 2, 'the existing coordinator owns one global source-width bound');
      assert.equal(observed.opened, observed.closed);
      const journal = f.journal();
      const groups = [['read-session', 'read-turn'], ['second-session', 'second-turn']].map(([session, turn]) => {
        const rows = [0, 1].map(index => journal[toolId(session, turn, 0, index)]);
        return { start: Math.min(...rows.map(row => row.startedAt)), end: Math.min(...rows.map(row => row.settledAt)) };
      }).sort((left, right) => left.start - right.start);
      assert(groups[1].start >= groups[0].end, 'durable execution starts exclude time queued behind the global read bound');
    } finally { await f.close(); }
  });
  await check('dynamic read-only tools lacking the trusted dual contract remain serial barriers', async () => {
    const f = await fixture({ calls: [call('a', 'filesystem.read', { path: 'a.txt' }), call('dynamic', 'fixture.read', { path: 'b.txt' }), call('c', 'filesystem.read', { path: 'c.txt' })] });
    try {
      const { readFileAsync } = await import('../src/workspace/tools.js');
      f.broker.register({ id: 'fixture.read', permission: 'storage', provider: 'extension', effect: 'read-only',
        description: 'Owned dynamic read fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        execute: request => readFileAsync(f.root, request.input.path) });
      f.options.manifest = f.broker.list().filter(row => row.description && row.inputSchema);
      const observed = await observeReads(f.root, () => f.coordinator.run(f.options));
      assert.equal(observed.result.status, 'completed');
      assert.equal(observed.peak, 1);
      assert.deepEqual(observed.rows.map(row => row.path), ['a.txt', 'b.txt', 'c.txt']);
      assert.deepEqual(f.requests[1].messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content).result.content), ['alpha', 'beta', 'gamma']);
    } finally { await f.close(); }
  });
  await check('non-streaming Runtime observations and malformed dynamic read results stay bounded without unhandled diagnostics', async () => {
    const f = await fixture({ calls: [call('cyclic', 'fixture.cyclic-read', { path: 'a.txt' })] });
    const unhandled = [];
    const receiveUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', receiveUnhandled);
    try {
      const { readFileAsync } = await import('../src/workspace/tools.js');
      f.broker.register({ id: 'fixture.cyclic-read', permission: 'storage', provider: 'extension', effect: 'read-only',
        description: 'Owned malformed result fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        async execute(request) { const result = await readFileAsync(f.root, request.input.path); result.self = result; return result; } });
      f.options.manifest = f.broker.list().filter(row => row.description && row.inputSchema);
      f.modelRuntime.stream = undefined;
      const configurations = [];
      let result, failure;
      try { result = await f.coordinator.run({ ...f.options, onConfiguration: value => configurations.push(value) }); }
      catch (error) { failure = error; }
      await new Promise(resolve => setImmediate(resolve));
      assert(!failure, 'malformed results retain the existing bounded representation path: ' + (failure?.code ?? 'none'));
      assert.equal(unhandled.length, 0, 'diagnostic digest work cannot reject outside the accepted promise');
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.configurationObservation, configurations.at(-1));
      assert(configurations.some(row => row.stage === 'serialized') && configurations.some(row => row.stage === 'response'));
      assert.equal(JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content).status, 'incomplete');
    } finally { await new Promise(resolve => setImmediate(resolve)); process.removeListener('unhandledRejection', receiveUnhandled); await f.close(); }
  });
  console.log(JSON.stringify({ passed, failed }));
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
