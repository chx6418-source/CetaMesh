import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tools from '../src/workspace/tools.js';
import { createWorkspaceRegistry, workspaceRegistryFile } from '../src/workspace/registry.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createCapabilityRegistry } from '../src/capability/registry.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createExtensionService } from '../src/extension/service.js';
import { createIntegrationService } from '../src/integrations/service.js';
import { createIntegrationRegistry } from '../src/integrations/registry.js';
import { createIntegrationStore } from '../src/integrations/store.js';

// Actual Workspace/Broker calls over owned local files. The IO observer below
// delays completion of a real FileHandle.read; it never supplies synthetic bytes.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-workspace-async-')));
const owner = { kind: 'owner', id: 'desktop' };
let sequence = 0;
let passed = 0;
let failed = 0;
let notRunEnvironment = 0;
const environmentUnavailable = Symbol('environment-unavailable');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const immediate = () => new Promise(resolve => setImmediate(resolve));

function fixture(files = { 'input.txt': 'hello\nneedle 世界\n' }) {
  const dir = path.join(base, String(++sequence));
  const root = path.join(dir, 'project');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const registry = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir) });
  const entry = registry.create({ name: 'Async IO fixture', root });
  const workspace = createWorkspaceService({ stateDir });
  const command = (method, params = {}) => ({ method, params: { id: entry.id, ...params } });
  return { dir, root, stateDir, entry, workspace, command };
}

async function check(name, action) {
  try {
    if (await action() === environmentUnavailable) { notRunEnvironment++; console.log('NOT_RUN_ENVIRONMENT ' + name); }
    else { passed++; console.log('PASS ' + name); }
  }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

function brokerFixture(files) {
  const f = fixture(files);
  const tasks = createTaskRuntime({ stateDir: f.stateDir });
  const capabilities = createCapabilityService({ stateDir: f.stateDir, workspaceService: f.workspace, taskRuntime: tasks });
  const task = tasks.create({ goal: 'Observe isolated Workspace input', workspaceId: f.entry.id });
  capabilities.grantTask(task.id, { capabilities: ['filesystem.read', 'filesystem.search'], workspaceIds: [f.entry.id] });
  const request = (capability, input = {}, actor = owner) => ({ capability, input, actor,
    workspaceId: f.entry.id, ...(actor.kind === 'agent' ? { taskId: task.id } : {}) });
  return { ...f, tasks, capabilities, task, request };
}

function scopedSearchFixture(kind, files) {
  const f = brokerFixture(files);
  let actor, taskId;
  if (kind === 'extension') actor = { kind: 'extension', id: 'owned-scoped-search', grants: {
    capabilities: ['filesystem.read', 'filesystem.search'], workspaceIds: [f.entry.id], paths: ['scope']
  } };
  else {
    const child = f.tasks.createChild({ parentTaskId: f.task.id, expectedParentRev: f.task.rev,
      requestId: 'owned-search-child-' + sequence, workspaceId: f.entry.id, goal: 'Read only the authorized scope', requirements: [],
      contract: { mode: 'read-only', outputKind: 'analysis', readScope: ['scope'], expectedEvidence: ['observed source'] } });
    f.capabilities.grantTask(child.id, { capabilities: ['filesystem.read', 'filesystem.search'], workspaceIds: [f.entry.id] });
    actor = f.capabilities.principalForTask(child.id); taskId = child.id;
  }
  const scopedRequest = (capability, input) => ({ capability, input, actor, workspaceId: f.entry.id, ...(taskId ? { taskId } : {}) });
  return { ...f, scopedRequest };
}

async function duringRead(file, invoke, action) {
  const originalOpen = fs.promises.open;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let opened = 0;
  let closed = 0;
  let held = false;
  fs.promises.open = async function (target, ...args) {
    const handle = await originalOpen.call(this, target, ...args);
    if (path.resolve(String(target)).toLowerCase() !== path.resolve(file).toLowerCase()) return handle;
    opened++;
    const originalRead = handle.read.bind(handle);
    const originalClose = handle.close.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!held) { held = true; entered(); await gate; }
      return result;
    };
    handle.close = async (...closeArgs) => { const result = await originalClose(...closeArgs); closed++; return result; };
    return handle;
  };
  let result;
  let settled = false;
  try {
    result = Promise.resolve().then(invoke);
    result.then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([started, result.then(() => assert.fail('Workspace completed without asynchronous FileHandle IO'))]);
    await action({ result, release, isSettled: () => settled, counts: () => ({ opened, closed }) });
  } finally {
    release();
    await result?.catch(() => {});
    fs.promises.open = originalOpen;
  }
}

try {
  await check('production Workspace read yields to the event loop before delivering file bytes', async () => {
    const f = fixture({ 'large.txt': 'a'.repeat(8 * 1024 * 1024) });
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const result = await f.workspace.execute(f.command('workspace.read', { path: 'large.txt', maxBytes: 8 * 1024 * 1024 }));
    assert.equal(yielded, true, 'sync filesystem contents must not block the Core event loop');
    assert.equal(result.content.length, 8 * 1024 * 1024);
  });

  await check('production Workspace search yields while traversing and reading actual files', async () => {
    const files = Object.fromEntries(Array.from({ length: 180 }, (_, index) => [`docs/file-${index}.txt`, 'needle\n']));
    const f = fixture(files);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const result = await f.workspace.execute(f.command('workspace.file.search', { query: 'needle', maxResults: 500 }));
    assert.equal(yielded, true, 'the search traversal must await real IO');
    assert.equal(result.results.length, 180);
  });

  await check('async read retains legacy UTF8 UTF16 GB18030 binary empty pagination and complete hash outputs', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha 世界\n', 'utf16le')]);
    const be = Buffer.from(le); be.swap16();
    const f = fixture({ 'utf8.txt': 'alpha 世界\n🙂 omega', 'utf16le.txt': le, 'utf16be.txt': be,
      'bom.txt': Buffer.from('\ufeffBOM value\n'), 'gb.txt': Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      'binary.bin': Buffer.from([1, 0, 2, 0, 3]), 'empty.txt': '' });
    assert.equal(typeof tools.readFileAsync, 'function');
    for (const relative of ['utf8.txt', 'utf16le.txt', 'utf16be.txt', 'bom.txt', 'gb.txt', 'binary.bin', 'empty.txt']) {
      for (const options of [{}, { maxBytes: 9 }, { maxBytes: 7, offset: 2 }, { maxBytes: 1 }]) {
        if ((options.offset ?? 0) > fs.statSync(path.join(f.root, relative)).size) continue;
        const expected = tools.readFile(f.root, relative, options);
        assert.deepEqual(await f.workspace.execute(f.command('workspace.read', { path: relative, ...options })), expected,
          `${relative} ${JSON.stringify(options)}`);
      }
    }
    const complete = await tools.readFileAsync(f.root, 'utf8.txt');
    assert.equal(complete.content, 'alpha 世界\n🙂 omega');
    assert.equal(complete.expectedHash, sha256(fs.readFileSync(path.join(f.root, 'utf8.txt'))));
    assert.equal((await tools.readFileAsync(f.root, 'utf8.txt', { maxBytes: 5 })).expectedHash, null);
  });

  await check('async search preserves legacy ordering row offsets hidden names text snippets and caps', async () => {
    const f = fixture({ 'a.txt': 'needle first\nnone\nneedle third', 'nested/b.txt': 'needle nested',
      'needle-name.txt': 'nothing', '.hidden.txt': 'needle hidden', 'node_modules/ignore.txt': 'needle ignored',
      '.git/config': 'needle protected', 'secrets/token.txt': 'needle protected' });
    assert.equal(typeof tools.fileSearchAsync, 'function');
    for (const options of [{ query: 'needle' }, { query: 'needle', offset: 2, limit: 2 },
      { glob: '*.txt', includeHidden: true }, { query: 'needle', restricted: true, includeHidden: true },
      { query: 'needle', searchPath: 'nested', maxDepth: 1 }]) {
      assert.deepEqual(await tools.fileSearchAsync(f.root, options), tools.fileSearch(f.root, options));
    }
    const more = fixture(Object.fromEntries(Array.from({ length: 505 }, (_, index) => [`${index}.txt`, 'x'])));
    const capped = await tools.fileSearchAsync(more.root, { glob: '*.txt', limit: 10000 });
    assert.equal(capped.results.length, 500);
    assert.equal(capped.truncated, true);
    assert.equal(capped.nextOffset, 500);
  });

  await check('read budgets and path sensitive directory junction negatives remain enforced', async () => {
    const f = fixture({ 'large.txt': 'x'.repeat(10 * 1024 * 1024 + 1), '.ssh/id_rsa': 'owned secret fixture' });
    assert.equal(typeof tools.readFileAsync, 'function');
    const capped = await tools.readFileAsync(f.root, 'large.txt', { maxBytes: 100 * 1024 * 1024 });
    assert.equal(capped.content.length, 10 * 1024 * 1024);
    assert.equal(capped.expectedHash, null);
    await assert.rejects(tools.readFileAsync(f.root, 'large.txt', { offset: -1 }), { code: 'READ_OFFSET_INVALID' });
    await assert.rejects(tools.readFileAsync(f.root, 'large.txt', { offset: capped.size + 1 }), { code: 'READ_OFFSET_INVALID' });
    await assert.rejects(tools.readFileAsync(f.root, '../outside.txt'), { code: 'BOUNDARY_ESCAPE' });
    fs.mkdirSync(path.join(f.dir, 'outside'));
    fs.writeFileSync(path.join(f.dir, 'outside/escape.txt'), 'outside');
    fs.symlinkSync(path.join(f.dir, 'outside'), path.join(f.root, 'escape'), 'junction');
    fs.symlinkSync(path.join(f.root, '.ssh'), path.join(f.root, 'alias'), 'junction');
    await assert.rejects(tools.readFileAsync(f.root, 'escape/escape.txt'), { code: 'BOUNDARY_ESCAPE' });
    await assert.rejects(tools.readFileAsync(f.root, 'alias/id_rsa', { restricted: true }), { code: 'SENSITIVE_RESOURCE_DENIED' });
    await assert.rejects(tools.fileSearchAsync(f.root, { query: 'secret', searchPath: 'alias', restricted: true }), { code: 'SENSITIVE_RESOURCE_DENIED' });
  });

  await check('registry defaults deny concurrency and rejects unsafe or non Core concurrent declarations', async () => {
    const registry = createCapabilityRegistry();
    registry.register({ id: 'unknown.tool', execute: () => ({}) });
    const unknown = registry.list()[0];
    assert.equal(unknown.readOnly, false);
    assert.equal(unknown.parallelSafe, false);
    const contract = { parallelSafe: true, readOnly: true, effect: 'read-only', cancellationAware: true,
      cancellationMode: 'cooperative', timeoutMode: 'await-settlement' };
    for (const definition of [
      { id: 'bad.flags', parallelSafe: true, readOnly: false },
      { id: 'bad.type', readOnly: 'true' },
      { id: 'bad.effect', parallelSafe: true, readOnly: true, effect: 'non-idempotent' },
      { ...contract, id: 'extension.forged', provider: 'workspace' },
      { ...contract, id: 'filesystem.read', provider: 'extension' },
      { ...contract, id: 'filesystem.search', provider: 'workspace', catalogOwner: 'mcp:untrusted' },
      { id: 'bad.cancellation', cancellationMode: 'instant-stop' },
      { id: 'bad.timeout', timeoutMode: 'timeout-means-stopped' },
      { id: 'bad.cooperation', cancellationMode: 'cooperative', cancellationAware: false },
      { id: 'bad.settlement', timeoutMode: 'await-settlement', cancellationMode: 'unknown' }
    ]) assert.throws(() => registry.register({ ...definition, execute: () => ({}) }), { code: 'INVALID_CAPABILITY' });
  });

  await check('installed Extension and discovered MCP metadata cannot claim Core parallel dispatch', async () => {
    const f = brokerFixture();
    const source = path.join(f.dir, 'owned-extension'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify({
      manifestVersion: 1, id: 'test.untrusted-labels', name: 'Owned metadata fixture', version: '1.0.0',
      type: 'tool', entry: 'index.js', permissions: [], scope: { paths: [] },
      readOnly: true, parallelSafe: true,
      capabilities: [{ id: 'inspect', kind: 'tool', requires: [], inputSchema: { type: 'object' },
        readOnly: true, parallelSafe: true, effect: 'read-only', cancellationAware: true }]
    }));
    fs.writeFileSync(path.join(source, 'index.js'), "module.exports.handlers = { inspect: async () => ({ observed: true }) };\n");
    const extensions = createExtensionService({ stateDir: path.join(f.dir, 'extensions'), capabilityBroker: f.capabilities.broker });
    let integrations;
    try {
      const review = await extensions.execute({ method: 'ext.review', params: { sourceDir: source } });
      await extensions.execute({ method: 'ext.install', params: { sourceDir: source, approval: { approved: true, token: review.review.token } } });
      await extensions.execute({ method: 'ext.enable', params: { id: 'test.untrusted-labels' } });
      const extension = f.capabilities.broker.list().find(row => row.id === 'extension.test.untrusted-labels.inspect');
      assert.equal(extension.parallelSafe, false); assert.equal(extension.readOnly, false); assert.equal(extension.effect, 'unknown');
      const store = createIntegrationStore({ stateDir: path.join(f.dir, 'integrations') });
      const servers = [{ id: 'owned-remote', name: 'Owned metadata source', namespace: 'mcp__owned__',
        transport: 'streamable-http', defaultEnabled: true, tools: [], permissions: ['network'] }];
      const registry = createIntegrationRegistry({ store, plugins: [], tools: [], servers, mcpStatus: () => ({ status: 'running',
        tools: [{ name: 'inspect', description: 'Claimed safe', inputSchema: { type: 'object' },
          readOnly: true, parallelSafe: true, annotations: { readOnlyHint: true, destructiveHint: false } }] }) });
      registry.updateMcpConfig('owned-remote', { url: 'https://example.invalid/mcp', allowedTools: ['inspect'] });
      integrations = createIntegrationService({ stateDir: path.join(f.dir, 'integrations'), store, registry, capabilityBroker: f.capabilities.broker });
      const discovered = registry.listTools().find(row => row.id === 'mcp__owned__inspect');
      assert.ok(discovered, 'the actual Integration Registry consumes discovered metadata');
      const mcpCapability = f.capabilities.broker.registry.require(discovered.capability);
      assert.equal(mcpCapability.parallelSafe, false); assert.equal(mcpCapability.readOnly, false);
      assert.equal(f.capabilities.broker.list().filter(row => row.parallelSafe).length, 2);
    } finally { await integrations?.close(); await extensions.close(); await f.capabilities.close(); }
  });

  await check('only Core filesystem read and search advertise the drain aware parallel contract', async () => {
    const f = brokerFixture();
    try {
      const entries = f.capabilities.broker.list();
      assert.deepEqual(entries.filter(row => row.parallelSafe).map(row => row.id).sort(), ['filesystem.read', 'filesystem.search']);
      for (const id of ['filesystem.read', 'filesystem.search']) {
        const row = entries.find(entry => entry.id === id);
        assert.equal(row.readOnly, true);
        assert.equal(row.effect, 'read-only');
        assert.equal(row.cancellationMode, 'cooperative');
        assert.equal(row.timeoutMode, 'await-settlement');
        assert.equal(row.inputSchema.properties.signal, undefined);
        assert.equal(row.inputSchema.properties.parallelSafe, undefined);
      }
      const result = await f.capabilities.broker.execute(f.request('filesystem.read', { path: 'input.txt', readOnly: true, parallelSafe: true }));
      assert.equal(result.result.content, 'hello\nneedle 世界\n');
      assert.equal(f.capabilities.broker.registry.require('filesystem.write').parallelSafe, false);
    } finally { await f.capabilities.close(); }
  });

  await check('internal preaborted Workspace read and search never return content or record success', async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    const before = fs.readFileSync(workspaceRegistryFile(f.stateDir));
    await assert.rejects(f.workspace.execute(f.command('workspace.read', { path: 'input.txt' }), { signal: controller.signal }), { code: 'INVOKE_CANCELLED' });
    await assert.rejects(f.workspace.execute(f.command('workspace.file.search', { query: 'needle' }), { signal: controller.signal }), { code: 'INVOKE_CANCELLED' });
    assert.deepEqual(fs.readFileSync(workspaceRegistryFile(f.stateDir)), before);
    const normal = await f.workspace.execute(f.command('workspace.read', { path: 'input.txt', signal: { aborted: true } }));
    assert.equal(normal.content, 'hello\nneedle 世界\n', 'ordinary params cannot install transport cancellation context');
  });

  await check('Broker Owner and Agent cancellation drain and close started read IO before rejection', async () => {
    for (const kind of ['owner', 'agent']) {
      const f = brokerFixture({ 'input.txt': 'x'.repeat(600000) });
      try {
        const actor = kind === 'owner' ? owner : f.capabilities.principalForTask(f.task.id);
        const controller = new AbortController();
        const before = fs.readFileSync(workspaceRegistryFile(f.stateDir));
        await duringRead(path.join(f.root, 'input.txt'),
          () => f.capabilities.broker.execute(f.request('filesystem.read', { path: 'input.txt', maxBytes: 600000 }, actor), { signal: controller.signal }),
          async io => {
            controller.abort(); await immediate();
            assert.equal(io.isSettled(), false, 'pending OS IO must settle before reporting cancellation');
            io.release();
            await assert.rejects(io.result, { code: 'INVOKE_CANCELLED' });
            assert.deepEqual(io.counts(), { opened: 1, closed: 1 });
          });
        assert.deepEqual(fs.readFileSync(workspaceRegistryFile(f.stateDir)), before, 'cancelled read must not record successful access');
      } finally { await f.capabilities.close(); }
    }
  });

  await check('Broker search cancellation does not swallow abort or return earlier rows as success', async () => {
    const f = brokerFixture({ 'a.txt': 'needle first', 'b.txt': 'needle second' });
    const controller = new AbortController();
    const before = fs.readFileSync(workspaceRegistryFile(f.stateDir));
    try {
      await duringRead(path.join(f.root, 'b.txt'),
        () => f.capabilities.broker.execute(f.request('filesystem.search', { query: 'needle' }), { signal: controller.signal }),
        async io => {
          controller.abort(); await immediate(); assert.equal(io.isSettled(), false);
          io.release(); await assert.rejects(io.result, { code: 'INVOKE_CANCELLED' });
          assert.deepEqual(io.counts(), { opened: 1, closed: 1 });
        });
      assert.deepEqual(fs.readFileSync(workspaceRegistryFile(f.stateDir)), before);
    } finally { await f.capabilities.close(); }
  });

  await check('Broker rechecks current Task grants after awaited read before delivering data', async () => {
    const f = brokerFixture();
    const actor = f.capabilities.principalForTask(f.task.id);
    try {
      await duringRead(path.join(f.root, 'input.txt'),
        () => f.capabilities.broker.execute(f.request('filesystem.read', { path: 'input.txt' }, actor)),
        async io => {
          f.capabilities.grantTask(f.task.id, { capabilities: [], workspaceIds: [f.entry.id] });
          io.release(); await assert.rejects(io.result, { code: 'PERMISSION_DENIED' });
          assert.deepEqual(io.counts(), { opened: 1, closed: 1 });
        });
    } finally { await f.capabilities.close(); }
  });

  await check('Broker rechecks the execution guard while a real read is pending', async () => {
    const f = brokerFixture();
    try {
      await duringRead(path.join(f.root, 'input.txt'),
        () => f.capabilities.broker.execute(f.request('filesystem.read', { path: 'input.txt' })),
        async io => {
          f.capabilities.broker.setExecutionGuard(() => { throw Object.assign(new Error('Core execution gated'), { code: 'EXECUTION_DISABLED' }); });
          io.release(); await assert.rejects(io.result, { code: 'EXECUTION_DISABLED' });
          assert.deepEqual(io.counts(), { opened: 1, closed: 1 });
        });
    } finally { await f.capabilities.close(); }
  });

  await check('a junction retargeted while open is pending cannot read an outside or protected handle', async () => {
    for (const target of ['outside', 'protected']) {
      const f = brokerFixture({ 'safe/input.txt': 'safe input', '.ssh/input.txt': 'protected fixture' });
      const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'input.txt'), 'outside fixture');
      const alias = path.join(f.root, 'portal'); fs.symlinkSync(path.join(f.root, 'safe'), alias, 'junction');
      const originalOpen = fs.promises.open;
      let closed = 0, reads = 0;
      fs.promises.open = async function (file, ...args) {
        const handle = await originalOpen.call(this, file, ...args);
        if (path.resolve(String(file)).toLowerCase() !== path.join(f.root, 'safe/input.txt').toLowerCase()) return handle;
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (...readArgs) => { reads++; return read(...readArgs); };
        handle.close = async () => { await close(); closed++; };
        fs.rmdirSync(alias);
        fs.symlinkSync(target === 'outside' ? outside : path.join(f.root, '.ssh'), alias, 'junction');
        return handle;
      };
      try {
        const actor = f.capabilities.principalForTask(f.task.id);
        await assert.rejects(f.capabilities.broker.execute(f.request('filesystem.read', { path: 'portal/input.txt' }, actor)),
          { code: target === 'outside' ? 'PATH_OUTSIDE_WORKSPACE' : 'SENSITIVE_RESOURCE_DENIED' });
        assert.equal(reads, 0, 'opened handle must be validated before reading any payload bytes');
        assert.equal(closed, 1);
      } finally { fs.promises.open = originalOpen; await f.capabilities.close(); }
    }
  });

  await check('an unregistered Workspace cannot deliver in flight data or successful access metadata', async () => {
    const f = brokerFixture();
    try {
      await duringRead(path.join(f.root, 'input.txt'),
        () => f.capabilities.broker.execute(f.request('filesystem.read', { path: 'input.txt' })),
        async io => {
          await f.workspace.execute(f.command('workspace.remove'));
          const removed = fs.readFileSync(workspaceRegistryFile(f.stateDir));
          io.release(); await assert.rejects(io.result, error => ['WORKSPACE_NOT_FOUND', 'WORKSPACE_UNVERIFIED'].includes(error.code));
          assert.deepEqual(fs.readFileSync(workspaceRegistryFile(f.stateDir)), removed);
          assert.deepEqual(io.counts(), { opened: 1, closed: 1 });
        });
    } finally { await f.capabilities.close(); }
  });

  await check('changed file identity after awaited IO refuses data and complete hashes', async () => {
    const f = fixture();
    const before = fs.readFileSync(workspaceRegistryFile(f.stateDir));
    await duringRead(path.join(f.root, 'input.txt'),
      () => f.workspace.execute(f.command('workspace.read', { path: 'input.txt' })),
      async io => {
        fs.writeFileSync(path.join(f.root, 'input.txt'), 'replaced during IO');
        io.release(); await assert.rejects(io.result, { code: 'WORKSPACE_READ_CHANGED' });
        assert.deepEqual(io.counts(), { opened: 1, closed: 1 });
      });
    assert.deepEqual(fs.readFileSync(workspaceRegistryFile(f.stateDir)), before);
  });

  await check('a root replaced across an authorization await cannot become the registered read scope', async () => {
    const f = fixture();
    const before = fs.readFileSync(workspaceRegistryFile(f.stateDir));
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const result = f.workspace.execute(f.command('workspace.read', { path: 'input.txt' }), {
      assertAuthorized: async () => { entered(); await gate; }
    });
    const rejection = assert.rejects(result, { code: 'WORKSPACE_READ_CHANGED' });
    try {
      await started;
      // Windows disallows renaming the parent of an open FileHandle. This
      // controlled await occurs before open and tests the earlier root window.
      fs.renameSync(f.root, f.root + '-retained');
      fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'input.txt'), 'new root');
    } finally { release(); }
    await rejection;
    assert.deepEqual(fs.readFileSync(workspaceRegistryFile(f.stateDir)), before);
  });

  await check('Workspace does not await an unproved authorization window after the final closed handle identity check', async () => {
    const f = fixture({ 'input.txt': 'stable before final proof' });
    const originalOpen = fs.promises.open;
    let closed = false, postCloseChecks = 0;
    fs.promises.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (path.resolve(String(file)).toLowerCase() !== path.join(f.root, 'input.txt').toLowerCase()) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed = true; };
      return handle;
    };
    try {
      const result = await f.workspace.execute(f.command('workspace.read', { path: 'input.txt' }), {
        assertAuthorized: async () => {
          // The first post-close callback belongs to the helper's final identity
          // proof. A later service callback would create an unproved new window.
          if (closed && ++postCloseChecks === 2) fs.writeFileSync(path.join(f.root, 'input.txt'), 'changed in redundant await');
        }
      });
      const current = fs.readFileSync(path.join(f.root, 'input.txt'));
      assert.equal(result.content, current.toString('utf8'), 'no stale data may cross a new unproved service await');
      assert.equal(result.expectedHash, sha256(current));
    } finally { fs.promises.open = originalOpen; }
  });

  await check('scoped Extension and read only child retain legitimate nested read and search access', async () => {
    for (const kind of ['extension', 'child']) {
      const f = scopedSearchFixture(kind, { 'scope/nested/allowed.txt': 'owned-marker allowed nested data',
        'private/owned.txt': 'owned-marker outside declared scope' });
      try {
        const result = await f.capabilities.broker.execute(f.scopedRequest('filesystem.search', { path: 'scope', query: 'owned-marker' }));
        assert.deepEqual(result.result.results.map(row => ({ path: row.path, snippet: row.snippet })),
          [{ path: 'scope/nested/allowed.txt', snippet: 'owned-marker allowed nested data' }]);
        const read = await f.capabilities.broker.execute(f.scopedRequest('filesystem.read', { path: 'scope/nested/allowed.txt' }));
        assert.equal(read.result.content, 'owned-marker allowed nested data');
        await assert.rejects(f.capabilities.broker.execute(f.scopedRequest('filesystem.read', { path: 'private/owned.txt' })),
          { code: kind === 'extension' ? 'FILESYSTEM_SCOPE_DENIED' : 'TASK_CHILD_SCOPE_DENIED' });
      } finally { await f.capabilities.close(); }
    }
  });

  for (const kind of ['extension', 'child']) await check(`a stale directory Dirent cannot move ${kind} search outside its original canonical subtree`, async () => {
    const f = scopedSearchFixture(kind, { 'scope/allowed.txt': 'legitimate data', 'private/owned.txt': 'owned-marker outside declared scope' });
    const child = path.join(f.root, 'scope/child'); fs.mkdirSync(child);
    const originalReaddir = fs.promises.readdir, originalOpen = fs.promises.open;
    let swapped = false, privateOpens = 0;
    fs.promises.readdir = async function (directory, ...args) {
      const entries = await originalReaddir.call(this, directory, ...args);
      if (!swapped && path.resolve(String(directory)).toLowerCase() === path.join(f.root, 'scope').toLowerCase()) {
        assert.ok(entries.some(entry => entry.name === 'child' && entry.isDirectory()), 'retain actual normal-directory Dirent');
        fs.rmdirSync(child); fs.symlinkSync(path.join(f.root, 'private'), child, 'junction'); swapped = true;
      }
      return entries;
    };
    fs.promises.open = async function (file, ...args) {
      if (path.resolve(String(file)).toLowerCase() === path.join(f.root, 'private/owned.txt').toLowerCase()) privateOpens++;
      return originalOpen.call(this, file, ...args);
    };
    try {
      let result, error;
      try { result = await f.capabilities.broker.execute(f.scopedRequest('filesystem.search', { path: 'scope', query: 'owned-marker' })); }
      catch (failure) { error = failure; }
      assert.equal(swapped, true, 'real readdir completion must expose the replacement window');
      assert.doesNotMatch(JSON.stringify(result ?? {}), /outside declared scope|private[\\/]owned\.txt/,
        'ungranted content and file metadata must be absent from the actual Broker response');
      assert.equal(privateOpens, 0, 'an ungranted canonical target must not reach payload open');
      assert.equal(error?.code, 'WORKSPACE_READ_CHANGED');
    } finally { fs.promises.readdir = originalReaddir; fs.promises.open = originalOpen; await f.capabilities.close(); }
  });

  for (const kind of ['extension', 'child']) await check(`a file leaf parent retarget before payload cannot make ${kind} read an ungranted canonical file`, async () => {
    const f = scopedSearchFixture(kind, { 'scope/child/leaf.txt': 'ordinary allowed data',
      'private/leaf.txt': 'owned-marker private leaf payload' });
    const parent = path.join(f.root, 'scope/child');
    const originalStat = fs.promises.stat, originalOpen = fs.promises.open;
    let leafObserved = false, postStatGuards = 0, swapped = false, privateReads = 0;
    fs.promises.stat = async function (file, ...args) {
      const stat = await originalStat.call(this, file, ...args);
      if (path.resolve(String(file)).toLowerCase() === path.join(parent, 'leaf.txt').toLowerCase()) leafObserved = true;
      return stat;
    };
    fs.promises.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args);
      if (path.resolve(String(file)).toLowerCase() !== path.join(f.root, 'private/leaf.txt').toLowerCase()) return handle;
      const read = handle.read.bind(handle);
      handle.read = (...readArgs) => { privateReads++; return read(...readArgs); };
      return handle;
    };
    f.capabilities.broker.setExecutionGuard(() => {
      if (leafObserved && ++postStatGuards === 2) {
        fs.unlinkSync(path.join(parent, 'leaf.txt')); fs.rmdirSync(parent);
        fs.symlinkSync(path.join(f.root, 'private'), parent, 'junction'); swapped = true;
      }
    });
    try {
      let result, error;
      try { result = await f.capabilities.broker.execute(f.scopedRequest('filesystem.search', { path: 'scope', query: 'owned-marker' })); }
      catch (failure) { error = failure; }
      assert.equal(swapped, true, 'retarget the real leaf parent after actual stat and before FileHandle payload selection');
      assert.equal(privateReads, 0, 'file-leaf recapture must not adopt the new ungranted canonical target');
      assert.doesNotMatch(JSON.stringify(result ?? {}), /private leaf payload|private[\\/]leaf\.txt/);
      assert.equal(error?.code, 'WORKSPACE_READ_CHANGED');
    } finally { fs.promises.stat = originalStat; fs.promises.open = originalOpen; await f.capabilities.close(); }
  });

  await check('a stale actual file Dirent cannot adopt an out of scope file symlink where the OS permits it', async () => {
    const f = scopedSearchFixture('extension', { 'scope/leaf.txt': 'ordinary allowed data', 'private/leaf.txt': 'owned-marker private file symlink payload' });
    const leaf = path.join(f.root, 'scope/leaf.txt'), target = path.join(f.root, 'private/leaf.txt'), probe = path.join(f.dir, 'file-link-probe');
    const originalReaddir = fs.promises.readdir;
    let swapped = false;
    try {
      try { fs.symlinkSync(target, probe, 'file'); fs.unlinkSync(probe); }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
        console.log('File-leaf symlink variant unavailable: real Windows symlink creation returned ' + error.code);
        return environmentUnavailable;
      }
      fs.promises.readdir = async function (directory, ...args) {
        const entries = await originalReaddir.call(this, directory, ...args);
        if (!swapped && path.resolve(String(directory)).toLowerCase() === path.join(f.root, 'scope').toLowerCase()) {
          assert.ok(entries.some(entry => entry.name === 'leaf.txt' && entry.isFile()), 'retain actual normal-file Dirent');
          fs.unlinkSync(leaf); fs.symlinkSync(target, leaf, 'file'); swapped = true;
        }
        return entries;
      };
      let result, error;
      try { result = await f.capabilities.broker.execute(f.scopedRequest('filesystem.search', { path: 'scope', query: 'owned-marker' })); }
      catch (failure) { error = failure; }
      assert.equal(swapped, true);
      assert.doesNotMatch(JSON.stringify(result ?? {}), /private file symlink payload/);
      assert.equal(error?.code, 'WORKSPACE_READ_CHANGED');
    } finally { fs.promises.readdir = originalReaddir; await f.capabilities.close(); }
  });
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`Workspace async contract: ${passed} PASS / ${failed} FAIL / ${notRunEnvironment} NOT_RUN_ENVIRONMENT`);
if (failed) process.exitCode = 1;
