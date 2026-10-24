import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { createIntegrationStore } from '../src/integrations/store.js';
import { waitForDataIpc } from './helpers/wait-for-data-ipc.mjs';
import { createLegacyShutdown } from '../src/app/legacy-shutdown.js';

let failed = 0;
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } }
await test('COMM06 Legacy production shutdown awaits async resources then both ownership releases and exit', async () => {
  const order = [];
  const processRef = new EventEmitter();
  processRef.exit = code => order.push('exit:' + code);
  const shutdown = createLegacyShutdown({ processRef, owner: { release() { order.push('owner'); } },
    releaseLegacyLock() { order.push('bridge-lock'); } });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  shutdown.register(async () => { await gate; order.push('child'); }, { name: 'child' });
  const first = shutdown.shutdown(10);
  assert.equal(shutdown.shutdown(10), first);
  assert.equal(shutdown.isStopping(), true);
  await Promise.resolve();
  assert.deepEqual(order, []);
  finish();
  assert.equal((await first).ok, true);
  assert.deepEqual(order, ['child', 'bridge-lock', 'owner', 'exit:10']);
});
await test('COMM06 Legacy incomplete resource cleanup retains live owner and does not exit', async () => {
  const order = [];
  const processRef = new EventEmitter(); processRef.exit = code => order.push('exit:' + code);
  const shutdown = createLegacyShutdown({ processRef, handlerTimeoutMs: 20, shutdownTimeoutMs: 80,
    owner: { release() { order.push('owner'); } }, releaseLegacyLock() { order.push('bridge-lock'); },
    retainOwnership() { order.push('retained-live-owner'); } });
  shutdown.register(() => new Promise(() => {}), { name: 'uncertain child' });
  const report = await shutdown.shutdown();
  assert.equal(report.ok, false);
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(order, ['retained-live-owner']);
});
await test('COMM06 Legacy resource rejection or explicit failed outcome cannot release ownership', async () => {
  for (const handler of [async () => { throw new Error('cleanup rejected'); }, async () => ({ ok: false, code: 'SEND_DRAIN_TIMEOUT' })]) {
    let released = false;
    const shutdown = createLegacyShutdown({ processRef: { exit() { assert.fail('must not exit'); } },
      owner: { release() { released = true; } }, releaseLegacyLock() { released = true; }, retainOwnership() {} });
    shutdown.register(handler, { name: 'child' });
    assert.equal((await shutdown.shutdown()).ok, false);
    assert.equal(released, false);
  }
});
await test('COMM06 Legacy owns socket cleanup and awaits server closure before ownership release', async () => {
  const order = [];
  const shutdown = createLegacyShutdown({ processRef: { exit() { order.push('exit'); } },
    owner: { release() { order.push('owner'); } }, releaseLegacyLock() {} });
  const server = net.createServer();
  shutdown.registerServer(server, { name: 'fixture server' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect(server.address().port, '127.0.0.1'); socket.resume();
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  try {
    const report = await shutdown.shutdown();
    await closed;
    assert.equal(report.ok, true);
    assert.equal(server.listening, false);
    assert.deepEqual(order, ['owner', 'exit']);
  } finally { socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
});
await test('COMM06 Legacy shutdown wiring routes runtime exits and keeps Owner release centralized', async () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /createLegacyShutdown/);
  assert.match(source, /onFatalError:.*legacyShutdown\.shutdown/);
  assert.match(source, /legacyShutdown\.registerServer\(dataServer/);
  assert.match(source, /legacyShutdown\.registerServer\(server/);
  assert.doesNotMatch(source, /process\.once\('exit',\s*\(\)\s*=>\s*owner\.release\(\)\)/);
  const runtime = source.slice(source.indexOf('function startProductSurfaces()'));
  assert.doesNotMatch(runtime, /process\.exit\(/, 'runtime exits must pass through awaited Legacy shutdown');
});
await test('COMM06 actual isolated Legacy exits on supervisor EOF after closing data IPC and releasing both locks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-legacy-eof-'));
  const stateDir = path.join(root, 'state');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  writeJsonAtomic(path.join(root, 'config.json'), {
    consolePort: 9, consoleToken: 'comm-legacy-fixture-token',
    allow: { private: [], groups: [] }, deny: { private: [], groups: [] }, allowAllWhenEmpty: false,
    snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', accessToken: '', allowProcessControl: false },
    socialV2: { sticker: { enabled: false } }
  });
  createIntegrationStore({ stateDir }).write({ plugins: {
    'cetamesh-snowluma': { enabled: false }, 'cetamesh-bionic-chat': { enabled: false }, 'cetamesh-dsh': { enabled: false }
  } });
  const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'bridge.js'), '--legacy-exclusive'], {
    cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      WHALEBRIDGE_DATA_DIR: root, WHALEBRIDGE_RESOURCE_DIR: repoRoot, WHALEBRIDGE_SUPERVISED: '1', WHALEBRIDGE_LEGACY_HTTP: '0',
      WHALEBRIDGE_DATA_PIPE: '', WHALEBRIDGE_UI_PIPE: '' }
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  try {
    try { await waitForDataIpc(root); }
    catch (error) { error.message += '\nLegacy startup output: ' + output; throw error; }
    assert.equal(fs.existsSync(path.join(stateDir, '.core-owner.lock')), true);
    assert.equal(fs.existsSync(path.join(stateDir, 'bridge.lock')), true);
    const exited = once(child, 'exit');
    child.stdin.end();
    let timer;
    const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(timer);
    assert.ok(result, 'Legacy did not finish supervised EOF shutdown: ' + output);
    assert.equal(result[0], 0, output);
    assert.equal(fs.existsSync(path.join(stateDir, '.core-owner.lock')), false, output);
    assert.equal(fs.existsSync(path.join(stateDir, 'bridge.lock')), false, output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
if (failed) process.exitCode = 1;
