import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';
import { createExtensionRuntime, createExtensionStore, createProcessExtensionHost } from '../src/extension/index.js';

const distDir = process.env.WHALEBRIDGE_DIST_DIR
  ? path.resolve(process.env.WHALEBRIDGE_DIST_DIR)
  : path.resolve('dist/core');
const coreExe = path.join(distDir, 'WhaleBridgeCore.exe');
assert.ok(fs.existsSync(coreExe), `Core SEA executable is required: ${coreExe}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-process-sea-e2e-'));
const sourceDir = path.join(root, 'sea-extension');
fs.mkdirSync(sourceDir);
const manifest = {
  manifestVersion: 1,
  id: 'test.sea-worker',
  name: 'SEA Worker E2E',
  version: '1.0.0',
  type: 'tool',
  entry: 'index.js',
  permissions: ['memory.read'],
  network: { hosts: [] },
  scope: { paths: [] },
  capabilities: [{ id: 'sample.run', kind: 'tool', title: 'Broker probe', requires: ['memory.read'] }]
};
fs.writeFileSync(path.join(sourceDir, 'extension.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(sourceDir, 'index.js'), [
  'module.exports.handlers = {',
  "  'sample.run': async (input, ctx) => ctx.memory.read({ query: input.query })",
  '};'
].join('\n'));

const brokerCalls = [];
const capabilityBroker = createCapabilityBroker({ policy: createCapabilityPolicy() });
capabilityBroker.register({
  id: 'memory.read', permission: 'memory.read', risk: 'low', provider: 'sea-e2e-memory',
  execute: async request => {
    brokerCalls.push({ actor: request.actor, input: request.input });
    return { answer: 'SEA child reached the Capability Broker', query: request.input.query };
  }
});

const store = createExtensionStore({ stateDir: path.join(root, 'state') });
let workerHost = null;
const runtime = createExtensionRuntime({
  store,
  capabilityBroker,
  monitorIntervalMs: 0,
  processHostFactory: options => {
    workerHost = createProcessExtensionHost({ ...options, packaged: true, execPath: coreExe });
    return workerHost;
  }
});

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`SEA Worker process ${pid} did not exit`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

try {
  const review = runtime.review({ sourceDir });
  assert.equal(review.review.id, manifest.id);
  runtime.install({ sourceDir });
  await runtime.enable({ id: manifest.id });

  assert.ok(workerHost, 'runtime creates a ProcessExtensionHost');
  assert.equal(workerHost.health().provider, 'process-child');
  assert.ok(Number.isInteger(workerHost.pid), 'SEA Worker is a separate child process');
  const childPid = workerHost.pid;
  const active = runtime.get({ id: manifest.id }).extension;
  assert.equal(path.resolve(workerHost.cwd), path.resolve(active.sourceRoot), 'SEA Worker cwd is the versioned package root');
  assert.equal(await workerHost.ping({ timeoutMs: 5000 }), true, 'Core SEA --extension-worker answers the frame protocol');

  const result = await runtime.invoke({
    id: manifest.id,
    capability: 'sample.run',
    input: { query: 'release-e2e' }
  });
  assert.equal(result.result.answer, 'SEA child reached the Capability Broker');
  assert.equal(result.result.query, 'release-e2e');
  assert.equal(brokerCalls.length, 1);
  assert.equal(brokerCalls[0].actor.kind, 'extension');
  assert.equal(brokerCalls[0].actor.id, manifest.id);
  assert.equal(brokerCalls[0].input.query, 'release-e2e');

  await runtime.close();
  assert.equal(workerHost.health().state, 'stopped');
  await waitForExit(childPid);
  console.log('ProcessExtensionHost SEA E2E: real Core SEA child invoked an Extension, reached the Capability Broker, and shut down cleanly.');
} finally {
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}
