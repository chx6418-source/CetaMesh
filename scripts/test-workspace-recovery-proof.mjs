import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { workspaceContentProof } from '../src/workspace/handoff-facts.js';
import { createStagingWorkspace } from '../src/workspace/staging.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createWorkspaceRegistry, workspaceRegistryFile } from '../src/workspace/registry.js';
import { workspaceJournalDir } from '../src/workspace/transaction.js';
import { createWorkspaceReconciler } from '../src/continuity/reconcile.js';
import { gitStatus, gitHead, gitDiff } from '../src/workspace/tools.js';

// Real temporary folders only. No models, user state, Git conversion or imports.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-recovery-proof-')));
let sequence = 0;
let failures = 0;
const journals = [];
const scope = { additionalWorkspaceRoots: [], excludedRoots: [] };
const samePath = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const denied = error => error?.code === 'WORKSPACE_UNVERIFIED';

function fixture(files = { 'input.txt': 'before' }) {
  const root = path.join(base, 'source-' + ++sequence);
  fs.mkdirSync(root);
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return root;
}

async function check(name, action) {
  try { await action(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
}

function registered(root, { excludedRoots = [], additionalRoots = [] } = {}) {
  const stateDir = path.join(base, 'service-' + ++sequence);
  const file = workspaceRegistryFile(stateDir);
  const registry = createWorkspaceRegistry({ file });
  const entry = registry.create({ root, name: 'Proof fixture' });
  for (const nested of additionalRoots) registry.create({ root: nested, name: 'Nested fixture' });
  return { service: createWorkspaceService({ stateDir, excludedRoots }), entry, stateDir, file };
}

function importIntent(root, original = 'original', staged = 'staged') {
  const dir = workspaceJournalDir(root);
  journals.push(dir);
  const batch = path.join(dir, 'fixture-batch');
  fs.mkdirSync(batch, { recursive: true });
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(root, 'input.txt'), staged);
  fs.writeFileSync(path.join(batch, '0.preimage'), original);
  const manifest = path.join(batch, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, root, status: 'committing',
    rows: [{ action: 'write', path: 'input.txt', originalHash: hash(original), stagedHash: hash(staged), backup: '0.preimage' }] }));
  return { manifest, preimage: path.join(batch, '0.preimage') };
}

try {
  await check('registered content observation owns exclusions and binds the resolved Workspace identity', async () => {
    const root = fixture({ 'input.txt': 'visible', 'child/other.txt': 'nested', 'private/local.txt': 'private' });
    const child = path.join(root, 'child'), privateRoot = path.join(root, 'private');
    const { service, entry, stateDir, file } = registered(root, { excludedRoots: [privateRoot], additionalRoots: [child] });
    assert.equal(typeof service.collectContentProof, 'function', 'Workspace owns read-only content observation');
    const before = fs.readFileSync(file);
    const expected = await workspaceContentProof(root, { additionalWorkspaceRoots: [root, child], excludedRoots: [stateDir, privateRoot] });
    const first = await service.collectContentProof(entry.id, { expectedRoot: root });
    assert.deepEqual(first, expected, 'moving policy assembly preserves the existing proof bytes');
    assert.equal(first.fileCount, 1);
    assert.equal(first.totalBytes, 7);
    fs.writeFileSync(path.join(child, 'other.txt'), 'changed nested');
    fs.writeFileSync(path.join(privateRoot, 'local.txt'), 'changed private');
    assert.deepEqual(await service.collectContentProof(entry.id, {
      excludedRoots: [], additionalWorkspaceRoots: [], trustedSourceRoot: root
    }), first, 'caller options cannot widen registered exclusions');
    await assert.rejects(service.collectContentProof(entry.id, { relevantFiles: ['child/other.txt'] }), denied);
    await assert.rejects(service.collectContentProof(entry.id, { expectedRoot: child }), denied);
    await assert.rejects(service.collectContentProof('missing'), { code: 'WORKSPACE_NOT_FOUND' });
    await service.execute({ method: 'workspace.open', params: { id: entry.id } });
    await assert.rejects(service.collectContentProof(''), { code: 'WORKSPACE_NOT_FOUND' }, 'missing identity cannot borrow active Workspace');
    // Opening above deliberately persists the Owner selection; observation itself must not.
    const opened = fs.readFileSync(file);
    assert.notDeepEqual(opened, before);
    await service.collectContentProof(entry.id);
    assert.deepEqual(fs.readFileSync(file), opened);
    fs.writeFileSync(path.join(root, 'input.txt'), 'changed');
    assert.notEqual((await service.collectContentProof(entry.id)).sha256, first.sha256);
  });

  await check('content observation does not recover imports or rewrite registry and journal bytes', async () => {
    const root = fixture({ 'input.txt': 'original' });
    const { service, entry, file } = registered(root);
    assert.equal(typeof service.collectContentProof, 'function');
    const intent = importIntent(root);
    const before = [file, intent.manifest, intent.preimage].map(name => fs.readFileSync(name));
    const proof = await service.collectContentProof(entry.id);
    assert.equal(proof.fileCount, 1);
    assert.equal(proof.totalBytes, 6);
    assert.equal(fs.readFileSync(path.join(root, 'input.txt'), 'utf8'), 'staged', 'read observation must never restore preimage');
    [file, intent.manifest, intent.preimage].forEach((name, index) => assert.deepEqual(fs.readFileSync(name), before[index]));
  });

  await check('known blocked import refuses proof while preserving its unknown file and journal', async () => {
    const root = fixture();
    const { entry, stateDir, file } = registered(root);
    const intent = importIntent(root);
    fs.writeFileSync(path.join(root, 'input.txt'), 'external edit');
    const before = [file, intent.manifest, intent.preimage].map(name => fs.readFileSync(name));
    const service = createWorkspaceService({ stateDir });
    assert.equal(typeof service.collectContentProof, 'function');
    await assert.rejects(service.collectContentProof(entry.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(fs.readFileSync(path.join(root, 'input.txt'), 'utf8'), 'external edit');
    [file, intent.manifest, intent.preimage].forEach((name, index) => assert.deepEqual(fs.readFileSync(name), before[index]));
  });

  await check('registered observation keeps unavailable and nested-repository failures explicit', async () => {
    const root = fixture({ 'input.txt': 'before', 'nested/source.txt': 'independent' });
    const { service, entry } = registered(root);
    assert.equal(typeof service.collectContentProof, 'function');
    fs.writeFileSync(path.join(root, 'nested/.git'), 'gitdir: unavailable');
    await assert.rejects(service.collectContentProof(entry.id), error => denied(error) && error.reasonCode === 'WORKSPACE_CONTENT_NESTED_REPOSITORY');
    fs.renameSync(root, root + '-preserved');
    await assert.rejects(service.collectContentProof(entry.id), denied);
  });

  await check('managed Worktree proof retains verified provenance under excluded StateDir', async () => {
    const source = fixture({ 'input.txt': 'tracked' });
    const stateDir = path.join(base, 'managed-state-' + ++sequence);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(base, 'no-hooks'),
      '-c', 'commit.gpgSign=false', ...args], { cwd: source, env, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.name', 'Proof fixture']); git(['config', 'user.email', 'proof@example.invalid']);
    git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const file = workspaceRegistryFile(stateDir), registry = createWorkspaceRegistry({ file });
    const parent = registry.create({ root: source, name: 'Parent' });
    const managedRoot = path.join(stateDir, 'agent-worktrees', 'proof');
    git(['worktree', 'add', '-q', '-b', 'proof', managedRoot]);
    const managed = registry.create({ root: managedRoot, name: 'Managed', gitWorktree: { parentWorkspaceId: parent.id } });
    const service = createWorkspaceService({ stateDir, excludedRoots: [stateDir] });
    assert.equal(typeof service.collectContentProof, 'function');
    assert.equal(service.describeWorkspace(managed.id).managedIsolation, true);
    const before = fs.readFileSync(file);
    const expected = await workspaceContentProof(managedRoot, { additionalWorkspaceRoots: [source, managedRoot],
      excludedRoots: [stateDir, stateDir], trustedSourceRoot: managedRoot });
    const proof = await service.collectContentProof(managed.id, { expectedRoot: managedRoot });
    assert.equal(proof.kind, 'git-workspace-v1');
    assert.deepEqual(proof, expected);
    assert.deepEqual(fs.readFileSync(file), before);
    const untrustedRoot = path.join(stateDir, 'agent-worktrees', 'forged');
    fs.mkdirSync(untrustedRoot); fs.writeFileSync(path.join(untrustedRoot, 'input.txt'), 'private');
    const forged = registry.create({ root: untrustedRoot, name: 'Forged', gitWorktree: { parentWorkspaceId: parent.id } });
    const reopened = createWorkspaceService({ stateDir, excludedRoots: [stateDir] });
    assert.equal(reopened.describeWorkspace(forged.id).managedIsolation, false);
    await assert.rejects(reopened.collectContentProof(forged.id, { trustedSourceRoot: untrustedRoot }), denied);
  });

  await check('Continuity fact observation carries registered identity to the Workspace owner', async () => {
    const root = fixture();
    const { service, entry, file } = registered(root);
    assert.equal(typeof service.collectContentProof, 'function');
    const before = fs.readFileSync(file);
    const reconciler = createWorkspaceReconciler({
      resolveWorkspace: id => service.describeWorkspace(id), gitStatus, gitHead,
      gitDiffSummary: async root => (await gitDiff(root, { statOnly: true })).output,
      fileExists: (root, relative) => fs.existsSync(path.join(root, relative)),
      contentProof: (root, options) => service.collectContentProof(options.workspaceId,
        { expectedRoot: root, relevantFiles: options.relevantFiles })
    });
    const facts = await reconciler.collectFacts({ workspaceId: entry.id, relevantFiles: ['input.txt'] });
    assert.equal(facts.available, true, 'reconciler passes the resolved ID rather than an implicit active Workspace');
    assert.equal(facts.contentProof.fileCount, 1);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  // Hashing only relevantFiles would accept all four mutations below.
  await check('a complete non-Git proof observes edits, additions and deletions outside relevant files', async () => {
    const root = fixture({ 'input.txt': 'before', 'nested/other.bin': Buffer.from([0, 1, 2, 3]) });
    const first = await workspaceContentProof(root, scope);
    assert.equal(first.kind, 'filtered-workspace-v1');
    assert.equal(first.fileCount, 2);
    assert.equal(first.totalBytes, 10);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.match(first.scopeSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await workspaceContentProof(root, scope), first);
    fs.writeFileSync(path.join(root, 'nested/other.bin'), Buffer.from([0, 3, 2, 1]));
    const edited = await workspaceContentProof(root, scope);
    assert.notEqual(edited.sha256, first.sha256, 'same-length binary edits require full content hashes');
    assert.equal(edited.scopeSha256, first.scopeSha256);
    fs.writeFileSync(path.join(root, 'added.txt'), 'new');
    const added = await workspaceContentProof(root, scope);
    assert.notEqual(added.sha256, edited.sha256);
    assert.equal(added.fileCount, 3);
    fs.unlinkSync(path.join(root, 'input.txt'));
    const removed = await workspaceContentProof(root, scope);
    assert.notEqual(removed.sha256, added.sha256);
    assert.equal(removed.fileCount, 2);
    assert.equal(fs.existsSync(path.join(root, '.git')), false);
    assert.deepEqual(Object.keys(first).sort(), ['fileCount', 'kind', 'scopeSha256', 'sha256', 'totalBytes']);
    assert.equal(JSON.stringify(first).includes('input.txt'), false);
    assert.equal(JSON.stringify(first).includes(root), false);
  });

  await check('non-Git recovery requires an explicit trusted Workspace exclusion scope', async () => {
    const root = fixture();
    for (const options of [undefined, {}, { additionalWorkspaceRoots: [] }, { excludedRoots: [] },
      { additionalWorkspaceRoots: ['relative-root'], excludedRoots: [] },
      { additionalWorkspaceRoots: [], excludedRoots: [null] }]) {
      await assert.rejects(workspaceContentProof(root, options), denied);
    }
  });

  await check('empty source is proved by bounded enumeration and scope, never a missing-file shortcut', async () => {
    const root = fixture({});
    const first = await workspaceContentProof(root, scope);
    assert.equal(first.fileCount, 0);
    fs.writeFileSync(path.join(root, 'appeared.txt'), 'content');
    assert.notEqual((await workspaceContentProof(root, scope)).sha256, first.sha256);
    await assert.rejects(workspaceContentProof(path.join(base, 'missing'), scope), denied);
  });

  // Proof and staging must share the filter authority, including nested registered roots.
  await check('proof covers exactly the staging-safe source and never reads filtered credentials or nested Workspaces', async () => {
    const root = fixture({
      'safe.txt': 'hello', 'nested/source.txt': 'inside', '.env': 'private env',
      'server.key': 'private key', 'service-token.json': 'private token', '.codex/config.toml': 'private profile',
      'node_modules/pkg/index.js': 'generated', 'child/other.txt': 'another project',
      'private/local.txt': 'private state', 'browser/Local State': '{}', 'browser/Default/state': 'browser private'
    });
    const options = { additionalWorkspaceRoots: [path.join(root, 'child')], excludedRoots: [path.join(root, 'private')] };
    const stage = await createStagingWorkspace({ taskId: 'task', workspaceId: 'workspace', sourceRoot: root,
      stagingRoot: path.join(base, 'stages'), ...options });
    assert.deepEqual([...stage.baseline.keys()].sort(), ['nested/source.txt', 'safe.txt']);
    const forbidden = [...Object.keys({ '.env': 1, 'server.key': 1, 'service-token.json': 1 }), '.codex', 'node_modules', 'child', 'private', 'browser']
      .map(relative => path.join(root, relative));
    const open = fs.openSync, read = fs.readFileSync;
    const rejectFilteredRead = file => {
      if (typeof file === 'string' && forbidden.some(target => samePath(file, target) || file.startsWith(target + path.sep)))
        throw new Error('filtered content must never be read');
    };
    let first;
    try {
      fs.openSync = function(file, ...args) { rejectFilteredRead(file); return open.call(this, file, ...args); };
      fs.readFileSync = function(file, ...args) { rejectFilteredRead(file); return read.call(this, file, ...args); };
      first = await workspaceContentProof(root, options);
    } finally { fs.openSync = open; fs.readFileSync = read; }
    assert.equal(first.fileCount, 2);
    assert.equal(first.totalBytes, 11);
    fs.writeFileSync(path.join(root, '.env'), 'changed credential');
    fs.writeFileSync(path.join(root, 'child/other.txt'), 'changed unrelated project');
    assert.deepEqual(await workspaceContentProof(root, options), first);
    const wider = await workspaceContentProof(root, { ...scope, excludedRoots: options.excludedRoots });
    assert.notEqual(wider.scopeSha256, first.scopeSha256);
    assert.notEqual(wider.sha256, first.sha256);
  });

  await check('excluded or overlapping source cannot produce an empty successful proof', async () => {
    const root = fixture();
    await assert.rejects(workspaceContentProof(root, { ...scope, excludedRoots: [base] }), denied);
    await assert.rejects(workspaceContentProof(root, { ...scope, additionalWorkspaceRoots: [base] }), denied);
    await assert.rejects(workspaceContentProof(root, { ...scope, excludedRoots: [base], trustedSourceRoot: path.join(base, 'other') }), denied);
    const trusted = await workspaceContentProof(root, { ...scope, excludedRoots: [base], trustedSourceRoot: root });
    assert.equal(trusted.fileCount, 1);
  });

  await check('independent nested repositories remain unverified and untouched', async () => {
    const root = fixture({ 'safe.txt': 'safe', 'nested/.git': 'gitdir: independent', 'nested/source.txt': 'nested content' });
    await assert.rejects(workspaceContentProof(root, scope), error => denied(error) && error.reasonCode === 'WORKSPACE_CONTENT_NESTED_REPOSITORY');
    assert.equal(fs.readFileSync(path.join(root, 'nested/source.txt'), 'utf8'), 'nested content');
  });

  await check('dangling nested Git metadata cannot masquerade as ordinary source', async () => {
    const root = fixture({ 'nested/source.txt': 'independent source' });
    const metadata = fixture({});
    fs.symlinkSync(metadata, path.join(root, 'nested/.git'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.renameSync(metadata, metadata + '-preserved');
    await assert.rejects(workspaceContentProof(root, scope), error => denied(error) && error.reasonCode === 'WORKSPACE_CONTENT_NESTED_REPOSITORY');
  });

  await check('junctions and source-root aliases cannot broaden content authority', async () => {
    const root = fixture({ 'safe.txt': 'safe' });
    const outside = fixture({ 'private.txt': 'outside' });
    fs.symlinkSync(outside, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(workspaceContentProof(root, scope), denied);
    await assert.rejects(workspaceContentProof(path.join(root, 'alias'), scope), denied);
    assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside');
  });

  await check('file and byte budgets refuse incomplete proof without partial success', async () => {
    const root = fixture({ 'a.txt': 'aa', 'b.txt': 'bb' });
    await assert.rejects(workspaceContentProof(root, { ...scope, maxFiles: 1 }), denied);
    await assert.rejects(workspaceContentProof(root, { ...scope, maxBytes: 3 }), denied);
    for (const bad of [0, -1, Infinity, NaN, 1.5]) {
      await assert.rejects(workspaceContentProof(root, { ...scope, maxFiles: bad }), denied);
      await assert.rejects(workspaceContentProof(root, { ...scope, maxBytes: bad }), denied);
    }
  });

  await check('unreadable source files do not become a successful partial manifest', async () => {
    const root = fixture();
    const open = fs.openSync, read = fs.readFileSync;
    const failure = () => { throw Object.assign(new Error('fixture unavailable'), { code: 'EACCES' }); };
    try {
      fs.openSync = function(file, ...args) { return samePath(file, path.join(root, 'input.txt')) ? failure() : open.call(this, file, ...args); };
      fs.readFileSync = function(file, ...args) { return samePath(file, path.join(root, 'input.txt')) ? failure() : read.call(this, file, ...args); };
      await assert.rejects(workspaceContentProof(root, scope), denied);
    } finally { fs.openSync = open; fs.readFileSync = read; }
  });

  await check('source replacement cannot bind new files to the old root identity', async () => {
    const root = fixture();
    const inspect = fs.lstatSync;
    let replaced = false;
    try {
      fs.lstatSync = function(file, ...args) {
        const stat = inspect.call(this, file, ...args);
        if (!replaced && samePath(file, root)) {
          replaced = true;
          fs.renameSync(root, root + '-preserved');
          fs.mkdirSync(root);
          fs.writeFileSync(path.join(root, 'input.txt'), 'replacement');
        }
        return stat;
      };
      await assert.rejects(workspaceContentProof(root, scope), denied);
      assert.equal(replaced, true);
    } finally { fs.lstatSync = inspect; }
  });

  // Inject real filesystem effects at native I/O boundaries; never replace the proof itself.
  for (const mutation of ['edit', 'add', 'delete']) {
    await check(`a ${mutation} racing content collection cannot certify mixed Workspace versions`, async () => {
      const root = fixture({ 'a.txt': 'aaaa', 'b.txt': 'bbbb' });
      const read = fs.readSync, readFile = fs.readFileSync, open = fs.openSync, close = fs.closeSync;
      const paths = new Map();
      let changed = false;
      const mutate = file => {
        if (changed || !samePath(file, path.join(root, 'a.txt'))) return;
        changed = true;
        if (mutation === 'edit') fs.writeFileSync(path.join(root, 'a.txt'), 'zzzz');
        if (mutation === 'add') fs.writeFileSync(path.join(root, 'c.txt'), 'cccc');
        if (mutation === 'delete') fs.unlinkSync(path.join(root, 'b.txt'));
      };
      try {
        fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); paths.set(fd, file); return fd; };
        fs.closeSync = function(fd, ...args) { paths.delete(fd); return close.call(this, fd, ...args); };
        fs.readSync = function(fd, ...args) { const count = read.call(this, fd, ...args); if (count) mutate(paths.get(fd)); return count; };
        fs.readFileSync = function(file, ...args) { const bytes = readFile.call(this, file, ...args); mutate(file); return bytes; };
        await assert.rejects(workspaceContentProof(root, scope), denied);
        assert.equal(changed, true, 'the race must execute against a real hashed file');
      } finally { fs.readSync = read; fs.readFileSync = readFile; fs.openSync = open; fs.closeSync = close; }
    });
  }
} finally {
  for (const journal of journals) fs.rmSync(journal, { recursive: true, force: true });
  // The exact canonical test-owned root was created above; no registered project is removed.
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
