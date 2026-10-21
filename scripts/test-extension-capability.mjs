import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../src/workspace/index.js';
import { createMemoryService } from '../src/memory/index.js';
import { createCapabilityService } from '../src/capability/index.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';
import { createProcessExtensionHost } from '../src/extension/process-host.js';
import { createExtensionService } from '../src/extension/service.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-extension-capability-'));
let extensions;
try {
  const stateDir = path.join(dir, 'state');
  const workspaceService = createWorkspaceService({ stateDir });
  const memoryService = createMemoryService({ stateDir });
  const capabilityAudit = [];
  const capabilityService = createCapabilityService({ stateDir, workspaceService, memoryService, audit: event => capabilityAudit.push(event) });
  const pendingWorkspace = await capabilityService.broker.execute({ actor: OWNER_ACTOR, capability: 'workspace.create',
    input: { name: 'Extension scope fixture', root: path.join(dir, 'workspace'), createIfMissing: true } });
  const created = await capabilityService.execute({ method: 'capability.approval.decide', params: { id: pendingWorkspace.approvalId, approve: true } });
  const workspaceId = created.result.workspace.id;
  const root = created.result.workspace.root;
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'src', 'readme.txt'), 'workspace data');
  fs.writeFileSync(path.join(root, 'docs', 'private.txt'), 'outside declared Extension path');

  const workspaceScope = 'workspace:' + workspaceId;
  const owner = { kind: 'user', id: 'desktop' };
  memoryService.runtime.create({ principal: owner, type: 'workspace', scope: workspaceScope, content: 'approved workspace reference' });

  const sourceDir = path.join(dir, 'extension-source');
  fs.mkdirSync(sourceDir);
  const manifest = {
    manifestVersion: 1,
    id: 'test.capability-adapter',
    name: 'Capability adapter fixture',
    version: '1.0.0',
    type: 'tool',
    entry: 'index.js',
    permissions: ['filesystem.read', 'memory.read', 'memory.write', 'network'],
    network: { hosts: ['127.0.0.1'] },
    scope: { workspace: workspaceId, paths: ['src'] },
    capabilities: [
      { id: 'read-file', kind: 'tool', title: 'Read file', requires: ['filesystem.read'] },
      { id: 'read-memory', kind: 'tool', title: 'Read Memory', requires: ['memory.read'] },
      { id: 'propose-memory', kind: 'tool', title: 'Propose Memory', requires: ['memory.write'] },
      { id: 'fetch-local', kind: 'tool', title: 'Safe network adapter', requires: ['network'] }
    ]
  };
  fs.writeFileSync(path.join(sourceDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'index.js'), `module.exports.handlers = {
    'read-file': async (input, ctx) => ctx.workspace.read({ path: input.path }),
    'read-memory': async (input, ctx) => ctx.memory.read({ scope: input.scope || ${JSON.stringify(workspaceScope)}, types: ['workspace'], query: 'approved workspace reference' }),
    'propose-memory': async (input, ctx) => ctx.memory.write({ type: 'user', scope: ${JSON.stringify(workspaceScope)}, content: input.content }),
    'fetch-local': async (input, ctx) => ctx.fetch(input.url)
  };`);

  extensions = createExtensionService({ stateDir: path.join(dir, 'extensions'), capabilityBroker: capabilityService.broker });
  const review = await extensions.execute({ method: 'ext.review', params: { sourceDir } });
  const installed = await extensions.execute({ method: 'ext.install', params: { sourceDir,
    approval: { approved: true, token: review.review.token } } });
  await extensions.execute({ method: 'ext.enable', params: { id: manifest.id } });
  const running = await extensions.execute({ method: 'ext.overview', params: {} });
  assert.equal(running.extensions.find(item => item.id === manifest.id).provider, 'process-child',
    'ordinary installed code Extensions run in a real Worker process');
  const read = await extensions.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'read-file', input: { path: 'src/readme.txt' } } });
  assert.equal(read.result.content, 'workspace data');
  await assert.rejects(extensions.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'read-file', input: { path: 'docs/private.txt' } } }),
    error => error.code === 'FILESYSTEM_SCOPE_DENIED');

  const memory = await extensions.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'read-memory', input: {} } });
  assert.equal(memory.result.memories[0].content, 'approved workspace reference');
  await assert.rejects(extensions.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'read-memory', input: { scope: 'chat:other-user' } } }),
    error => error.code === 'SCOPE_NOT_AUTHORIZED');
  const candidate = await extensions.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'propose-memory', input: { content: 'candidate from Extension' } } });
  assert.equal(candidate.result.candidate.status, 'pending');
  assert.equal(memoryService.runtime.list({ principal: owner, scope: workspaceScope, types: ['user'] }).memories.length, 0,
    'Extension long-term writes remain candidates until User confirmation');
  await assert.rejects(extensions.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'fetch-local', input: { url: 'http://127.0.0.1/' } } }));
  assert.ok(capabilityAudit.some(event => event.capability === 'network' && event.status === 'denied'),
    'Declared Extension network requests reach the shared Broker and its safe-fetch policy');

  // A caller timeout must cancel a real Worker reverse call and reach the Broker adapter signal.
  const cancellationBroker = createCapabilityBroker({ policy: createCapabilityPolicy() });
  let brokerSignalSeen = false;
  let brokerSignalAborted = false;
  cancellationBroker.register({ id: 'memory.read', permission: 'memory.read', risk: 'low', provider: 'cancel-fixture',
    execute: request => new Promise((_, reject) => {
      brokerSignalSeen = Boolean(request.signal);
      if (!request.signal) return;
      const abort = () => {
        brokerSignalAborted = true;
        reject(Object.assign(new Error('Broker operation cancelled'), { code: 'INVOKE_CANCELLED' }));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    })
  });
  const cancellationSource = path.join(dir, 'extension-cancellation');
  fs.mkdirSync(cancellationSource);
  fs.writeFileSync(path.join(cancellationSource, 'extension.json'), JSON.stringify({
    manifestVersion: 1, id: 'test.cancel-broker', name: 'Cancel Broker', version: '1.0.0',
    type: 'tool', entry: 'index.js', permissions: ['memory.read'], network: { hosts: [] }, scope: { paths: [] },
    capabilities: [{ id: 'read-slow', kind: 'tool', title: 'Slow read', requires: ['memory.read'] }]
  }));
  fs.writeFileSync(path.join(cancellationSource, 'index.js'),
    "module.exports.handlers = { 'read-slow': async (input, ctx) => ctx.memory.read(input) };\n");
  const cancellationService = createExtensionService({
    stateDir: path.join(dir, 'extensions-cancellation'), capabilityBroker: cancellationBroker,
    processHostFactory: options => createProcessExtensionHost({ ...options, packaged: false, timeoutMs: 2000 })
  });
  try {
    const cancellationReview = await cancellationService.execute({ method: 'ext.review', params: { sourceDir: cancellationSource } });
    await cancellationService.execute({ method: 'ext.install', params: { sourceDir: cancellationSource,
      approval: { approved: true, token: cancellationReview.review.token } } });
    await cancellationService.execute({ method: 'ext.enable', params: { id: 'test.cancel-broker' } });
    await assert.rejects(cancellationService.runtime.invoke({
      id: 'test.cancel-broker', capability: 'read-slow', input: {}
    }), error => error.code === 'INVOKE_TIMEOUT');
    const abortDeadline = Date.now() + 1000;
    while (!brokerSignalAborted && Date.now() < abortDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(brokerSignalSeen, true, 'Broker adapter receives the active cancellation signal');
    assert.equal(brokerSignalAborted, true, 'Worker cancellation aborts the in-flight Broker operation');
  } finally {
    await cancellationService.close();
  }
  console.log('Extension Capability integration: filesystem, Memory, and network use the shared broker; scopes hold; long-term writes stay candidates');
} finally {
  await extensions?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
