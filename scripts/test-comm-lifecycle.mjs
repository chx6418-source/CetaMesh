import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApplicationLifecycle } from '../src/app/lifecycle.js';
import { acquireStateOwner } from '../src/app/state-owner.js';
import { bootstrapCetaMesh } from '../src/app/bootstrap.js';
import { runCoreWorker } from '../src/app/core-worker.js';
import net from 'node:net';
import { createChatService } from '../src/desktop/chat-service.js';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-lifecycle-'));
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name, error); }
}
await test('COMM06 awaits isolated child exit before owner release with one idempotent stop Promise', async () => {
  const owner = acquireStateOwner(path.join(root, 'delayed'));
  const order = [];
  const child = spawn(process.execPath, ['-e', "process.on('message',()=>setTimeout(()=>process.exit(0),35));process.send('ready');"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  const lifecycle = createApplicationLifecycle({ handlerTimeoutMs: 1000 });
  lifecycle.register(() => { order.push('owner'); owner.release(); }, { name: 'owner', requireCleanShutdown: true });
  lifecycle.register(async () => {
    const exited = once(child, 'exit'); child.send('stop'); await exited; order.push('child');
  }, { name: 'child' });
  try {
    const first = lifecycle.stop();
    assert.equal(lifecycle.stop(), first);
    assert.equal(lifecycle.isStopping(), true);
    assert.equal(fs.existsSync(owner.file), true);
    const result = await first;
    assert.equal(result.ok, true);
    assert.deepEqual(order, ['child', 'owner']);
    assert.equal(fs.existsSync(owner.file), false);
  } finally { child.kill(); owner.release(); }
});
await test('COMM06 timeout is bounded, reported and retains StateDir owner', async () => {
  const owner = acquireStateOwner(path.join(root, 'hung'));
  const lifecycle = createApplicationLifecycle({ handlerTimeoutMs: 30, shutdownTimeoutMs: 80 });
  lifecycle.register(() => owner.release(), { name: 'owner', requireCleanShutdown: true });
  lifecycle.register(() => new Promise(() => {}), { name: 'hung' });
  try {
    const start = Date.now();
    const result = await lifecycle.stop();
    assert.equal(result.ok, false);
    assert.ok(Date.now() - start < 600);
    assert.equal(result.outcomes.find(row => row.name === 'hung').status, 'timed_out');
    assert.equal(result.outcomes.find(row => row.name === 'owner').status, 'skipped');
    assert.equal(fs.existsSync(owner.file), true);
  } finally { owner.release(); }
});
await test('COMM06 rejected cleanup is reported, later cleanup runs, owner remains held', async () => {
  const owner = acquireStateOwner(path.join(root, 'failed'));
  const order = [];
  const lifecycle = createApplicationLifecycle();
  lifecycle.register(() => owner.release(), { name: 'owner', requireCleanShutdown: true });
  lifecycle.register(() => order.push('later'), { name: 'later' });
  lifecycle.register(async () => { throw Object.assign(new Error('child uncertain'), { code: 'CHILD_UNCERTAIN' }); }, { name: 'failed' });
  try {
    const result = await lifecycle.stop();
    assert.equal(result.ok, false);
    assert.equal(result.outcomes[0].code, 'CHILD_UNCERTAIN');
    assert.deepEqual(order, ['later']);
    assert.equal(fs.existsSync(owner.file), true);
  } finally { owner.release(); }
});
await test('COMM06 bootstrap awaits Mesh close before releasing owner', async () => {
  const order = [];
  const app = bootstrapCetaMesh({ stateDir: path.join(root, 'bootstrap-state'), dataRoot: path.join(root, 'bootstrap-data'),
    processRef: new EventEmitter(), owner: { release() { order.push('owner'); } } });
  app.services.meshService.close = async () => { await new Promise(resolve => setTimeout(resolve, 15)); order.push('mesh'); };
  const result = await app.lifecycle.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['mesh', 'owner']);
});
await test('COMM06 resolved failure outcome retains owner instead of claiming successful cleanup', async () => {
  let released = false;
  const lifecycle = createApplicationLifecycle();
  lifecycle.register(() => { released = true; }, { name: 'owner', requireCleanShutdown: true });
  lifecycle.register(async () => ({ ok: false, code: 'QQ_SEND_DRAIN_TIMEOUT' }), { name: 'QQ connector' });
  const report = await lifecycle.stop();
  assert.equal(report.ok, false);
  assert.equal(released, false);
  assert.equal(report.outcomes[0].code, 'QQ_SEND_DRAIN_TIMEOUT');
});
await test('COMM06 Chat close awaits aborted model cleanup and rejects new work immediately', async () => {
  let abortSeen; let finish;
  const aborted = new Promise(resolve => { abortSeen = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const chat = createChatService({ stateDir: path.join(root, 'chat-drain'), modelRuntime: {
    defaultProviderId: () => 'fixture', resolveProvider: () => ({ id: 'fixture', defaultModel: 'fixture' }),
    isRegistered: () => true, supportsToolCalling: () => false,
    async *stream({ signal }) {
      yield { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'partial' } } };
      await new Promise(resolve => signal.addEventListener('abort', () => { abortSeen(); resolve(); }, { once: true }));
      await gate;
      throw Object.assign(new Error('cancelled after cleanup'), { name: 'AbortError' });
    }
  } });
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.send', params: { id: session.id, text: 'start model drain fixture' } });
  let settled = false;
  const closing = Promise.resolve(chat.close()).then(() => { settled = true; });
  try {
    await aborted;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false, 'Chat must wait for model stream cleanup before close resolves');
    await assert.rejects(chat.execute({ method: 'chat.sessions.create', params: {} }), { code: 'SERVICE_CLOSED' });
  } finally { finish(); await closing; }
});
await test('COMM06 Managed Agent close drains raw model work and turn accounting after cancellation', async () => {
  let started; let abortSeen; let finishModel; let finishAccounting;
  const ready = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { abortSeen = resolve; });
  const modelGate = new Promise(resolve => { finishModel = resolve; });
  const accountingGate = new Promise(resolve => { finishAccounting = resolve; });
  const principal = { taskId: 'drain-task', workspaceId: 'drain-workspace', actor: { kind: 'agent', id: 'drain-agent',
    grants: { taskIds: ['drain-task'], workspaceIds: ['drain-workspace'], capabilities: [] } } };
  const managed = createManagedAgentProvider({ taskPrincipalResolver: () => principal, capabilityExecutor: async () => ({}),
    modelRuntime: { async chat({ signal }) {
      started();
      await new Promise(resolve => signal.addEventListener('abort', () => { abortSeen(); resolve(); }, { once: true }));
      await modelGate;
      throw Object.assign(new Error('model cleanup complete'), { name: 'AbortError' });
    } }, onTurnEnd: async () => { await accountingGate; } });
  const session = await managed.provider.createSession({});
  await managed.provider.send({ sessionId: session.sessionId, content: 'start managed drain fixture' });
  await ready;
  let settled = false;
  const closing = managed.close().then(() => { settled = true; });
  try {
    await aborted;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false, 'Managed close must join work behind the fast cancellation ACK');
    finishAccounting();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false, 'Managed close must also wait for the raw model cleanup promise');
    await assert.rejects(managed.provider.createSession({}), { code: 'PROVIDER_UNAVAILABLE' });
    await assert.rejects(managed.provider.send({ sessionId: session.sessionId, content: 'after close' }), { code: 'SESSION_ARCHIVED' });
  } finally { finishModel(); finishAccounting(); await closing; }
});
for (const trigger of ['SIGINT', 'SIGTERM', 'beforeExit', 'stdin-end', 'data-error']) {
  await test('COMM06 Core ' + trigger + ' waits for unified cleanup and connected data socket closure before exit', async () => {
    const workerRoot = path.join(root, trigger);
    const fakeProcess = new EventEmitter();
    fakeProcess.env = { WHALEBRIDGE_SUPERVISED: '1', WHALEBRIDGE_DATA_PIPE: process.platform === 'win32'
      ? '\\\\.\\pipe\\comm-lifecycle-' + process.pid + '-' + trigger : path.join(root, trigger + '.sock') };
    fakeProcess.stdin = new EventEmitter();
    fakeProcess.stdin.resume = () => {};
    fakeProcess.ppid = 0;
    const exits = [];
    fakeProcess.exit = code => exits.push(code);
    const app = await runCoreWorker({ processRef: fakeProcess, log: () => {}, paths: {
      configFile: path.join(workerRoot, 'missing.json'), stateDir: path.join(workerRoot, 'state'),
      dataRoot: workerRoot, sourceRoot: path.resolve(import.meta.dirname, '..'), resourceRoot: path.resolve(import.meta.dirname, '..')
    } });
    if (!app.dataServer.listening) await once(app.dataServer, 'listening');
    const socket = net.connect(fakeProcess.env.WHALEBRIDGE_DATA_PIPE);
    await once(socket, 'connect');
    socket.resume();
    const closed = once(socket, 'close');
    let childStopped = false;
    app.lifecycle.register(async () => { await new Promise(resolve => setTimeout(resolve, 35)); childStopped = true; }, { name: 'delayed child fixture' });
    try {
      if (trigger === 'stdin-end') fakeProcess.stdin.emit('end');
      else if (trigger === 'data-error') app.dataServer.emit('error', Object.assign(new Error('fixture pipe failure'), { code: 'EADDRINUSE' }));
      else fakeProcess.emit(trigger);
      await new Promise(resolve => setTimeout(resolve, 8));
      assert.deepEqual(exits, [], 'process exit must wait for asynchronous cleanup');
      const report = await app.lifecycle.stop();
      assert.equal(report.ok, true);
      for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(childStopped, true);
      assert.deepEqual(exits, [trigger === 'data-error' ? 2 : 0]);
      await closed;
      assert.equal(fs.existsSync(path.join(workerRoot, 'state', '.core-owner.lock')), false);
    } finally { socket.destroy(); await app.lifecycle.stop(); }
  });
}
await test('COMM06 incomplete Core shutdown keeps its live owner until explicit process termination', async () => {
  const workerRoot = path.join(root, 'uncertain-worker');
  const pipeName = process.platform === 'win32' ? '\\\\.\\pipe\\comm-uncertain-' + process.pid : path.join(root, 'uncertain.sock');
  const program = `
    import { once } from 'node:events';
    import { runCoreWorker } from ${JSON.stringify(new URL('../src/app/core-worker.js', import.meta.url).href)};
    const app = await runCoreWorker({ log: () => {}, paths: ${JSON.stringify({ configFile: path.join(workerRoot, 'missing.json'),
      stateDir: path.join(workerRoot, 'state'), dataRoot: workerRoot, sourceRoot: path.resolve(import.meta.dirname, '..'), resourceRoot: path.resolve(import.meta.dirname, '..') })} });
    if (!app.dataServer.listening) await once(app.dataServer, 'listening');
    app.lifecycle.register(async () => { throw new Error('owned resource cleanup unconfirmed'); }, { name: 'uncertain fixture' });
    const report = await app.shutdown();
    process.send({ ok: report.ok, exitCode: process.exitCode });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...process.env, WHALEBRIDGE_SUPERVISED: '0', WHALEBRIDGE_DATA_PIPE: pipeName }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  try {
    const received = once(child, 'message');
    const earlyExit = once(child, 'exit').then(([code]) => { throw new Error('Core exited before retaining ownership: ' + code + ' ' + diagnostics); });
    const [report] = await Promise.race([received, earlyExit]);
    assert.deepEqual(report, { ok: false, exitCode: 1 });
    assert.equal(child.exitCode, null);
    assert.throws(() => acquireStateOwner(path.join(workerRoot, 'state')), { code: 'STATE_DIR_BUSY' });
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});
fs.rmSync(root, { recursive: true, force: true });
if (failures) process.exitCode = 1;
