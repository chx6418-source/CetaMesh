import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceContentProof } from '../src/workspace/handoff-facts.js';
import { createStagingWorkspace } from '../src/workspace/staging.js';

// Real temporary folders only. No models, user state, Git conversion or imports.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-recovery-proof-')));
let sequence = 0;
let failures = 0;
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

try {
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
  // The exact canonical test-owned root was created above; no registered project is removed.
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
