import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionStore, createExtensionRuntime } from '../src/extension/index.js';
import { createCapabilityBroker } from '../src/capability/index.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-extension-'));
const cleanups = [];
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name, error); }
}
function source(version, caps = ['run', 'removed']) {
  const dir = path.join(root, 'source-' + version);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'extension.json'), {
    manifestVersion: 1, id: 'comm.fixture', name: 'COMM fixture', version, type: 'tool', entry: 'index.js', permissions: ['log'],
    capabilities: caps.map(id => ({ id, kind: 'tool', requires: ['log'], description: version,
      inputSchema: { type: 'object', properties: { [version === '1.0.0' ? 'first' : 'second']: { type: 'string' } }, required: [version === '1.0.0' ? 'first' : 'second'] } }))
  });
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports.handlers = { ${caps.map(id => JSON.stringify(id) + ': input => ({version: ' + JSON.stringify(version) + ', input})').join(',')} };`);
  return dir;
}
function create() {
  const store = createExtensionStore({ stateDir: path.join(root, 'state') });
  const broker = createCapabilityBroker();
  const runtime = createExtensionRuntime({ store, capabilityBroker: broker, monitorIntervalMs: 0 });
  cleanups.push(() => runtime.close());
  return { store, broker, runtime };
}
const id = 'extension.comm.fixture.run';
const actor = { kind: 'owner', id: 'desktop' };
try {
  const initial = create();
  initial.runtime.install({ sourceDir: source('1.0.0') });
  initial.runtime.enable({ id: 'comm.fixture' });
  await initial.runtime.close();
  const current = create();
  await test('COMM10 restart restores reviewed descriptors without starting Workers', async () => {
    assert.equal(current.runtime.get({ id: 'comm.fixture' }).loaded, false);
    assert.ok(current.broker.registry.has(id), 'enabled descriptor absent after Core restart');
    assert.ok(current.broker.registry.require(id).descriptorVersion);
    const result = await current.broker.execute({ actor, capability: id, input: { first: 'ok' } });
    assert.equal(result.result.result.version, '1.0.0');
    assert.equal(current.runtime.get({ id: 'comm.fixture' }).loaded, true);
  });
  let oldDescriptor;
  await test('COMM11 update atomically replaces schema, removes capabilities and binds execution version', async () => {
    oldDescriptor = current.broker.registry.require(id);
    const sourceDir = source('2.0.0', ['run']);
    current.runtime.review({ sourceDir });
    await current.runtime.update({ sourceDir });
    const next = current.broker.registry.require(id);
    assert.deepEqual(next.inputSchema.required, ['second']);
    assert.notEqual(next.descriptorVersion, oldDescriptor.descriptorVersion);
    assert.equal(current.broker.registry.has('extension.comm.fixture.removed'), false);
    await assert.rejects(() => oldDescriptor.execute({ input: { first: 'stale' } }), { code: 'STALE_EXTENSION_HOST' });
    const result = await current.broker.execute({ actor, capability: id, input: { second: 'ok' } });
    assert.equal(result.result.result.version, '2.0.0');
  });
  await test('COMM11 rollback restores prior schema and removed capabilities', async () => {
    current.runtime.reviewRollback({ id: 'comm.fixture' });
    await current.runtime.rollback({ id: 'comm.fixture' });
    assert.deepEqual(current.broker.registry.require(id).inputSchema.required, ['first']);
    assert.equal(current.broker.registry.has('extension.comm.fixture.removed'), true);
  });
  await test('COMM11 authorized call queued before upgrade cannot invoke new behavior', async () => {
    let release;
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const delayedBroker = createCapabilityBroker({ policy: { async authorize() {
      entered(); await gate; return { allowed: true, risk: 'low', approvalRequired: false };
    } } });
    const delayedRuntime = createExtensionRuntime({ store: current.store, capabilityBroker: delayedBroker, monitorIntervalMs: 0 });
    cleanups.push(() => delayedRuntime.close());
    const pending = delayedBroker.execute({ actor, capability: id, input: { first: 'old input' } });
    await ready;
    const sourceDir = source('3.0.0', ['run']);
    current.runtime.review({ sourceDir });
    await current.runtime.update({ sourceDir });
    release();
    await assert.rejects(() => pending, { code: 'STALE_EXTENSION_HOST' });
    assert.equal(delayedRuntime.get({ id: 'comm.fixture' }).loaded, false);
  });
  await test('COMM10 disabled Extensions disappear from discovery immediately and after restart', async () => {
    await current.runtime.disable({ id: 'comm.fixture' });
    assert.equal(current.broker.registry.has(id), false);
    assert.equal(create().broker.registry.has(id), false);
  });
  await test('COMM10 revoked grants fail closed without Worker startup', async () => {
    const entry = current.store.get('comm.fixture');
    current.store.put({ ...entry, status: 'enabled', permissions: [] });
    const revoked = create();
    assert.equal(revoked.broker.registry.has(id), false);
    assert.equal(revoked.runtime.get({ id: entry.id }).loaded, false);
    current.store.put({ ...entry, status: 'enabled' });
  });
  await test('COMM10 modified installed package fails closed without Worker startup', async () => {
    const entry = current.store.get('comm.fixture');
    fs.appendFileSync(path.join(entry.sourceRoot, 'index.js'), '\n// modified after review');
    const corrupt = create();
    assert.equal(corrupt.broker.registry.has(id), false);
    assert.equal(corrupt.runtime.get({ id: entry.id }).loaded, false);
  });
} finally {
  for (const close of cleanups) await close();
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
