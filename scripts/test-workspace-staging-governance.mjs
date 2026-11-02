import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStagingWorkspace, collectStagedChanges, refreshStagingBaseline } from '../src/workspace/staging.js';

// A trusted source grant is a frozen canonical identity, not a mutable alias.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-stage-governance-')));
let failures = 0;
let sequence = 0;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function fixture(files = { 'edit.txt': 'before' }, options = {}) {
  const source = path.join(root, 'source-' + ++sequence);
  fs.mkdirSync(source);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), content);
  }
  return createStagingWorkspace({ taskId: 'task', workspaceId: 'workspace', sourceRoot: source, stagingRoot: path.join(root, 'stages'), ...(typeof options === 'function' ? options(source) : options) });
}

async function check(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
}

try {
  await check('an excluded source root cannot become a successful empty staging Workspace', async () => {
    await assert.rejects(fixture({ 'safe.txt': 'safe' }, { excludedRoots: [root] }), { code: 'STAGING_PATH_DENIED' });
    await assert.rejects(fixture({ 'safe.txt': 'safe' }, { excludedRoots: [root], trustedSourceRoot: path.join(root, 'other') }), { code: 'STAGING_PATH_DENIED' });
  });

  await check('trusted exact source keeps private subpaths and nested Workspaces excluded', async () => {
    const stage = await fixture({ 'safe.txt': 'safe', '.env': 'credential', 'blocked/omitted.txt': 'private', 'nested/other.txt': 'another Workspace' }, source => ({
      excludedRoots: [root, path.join(source, 'blocked')], additionalWorkspaceRoots: [path.join(source, 'nested')], trustedSourceRoot: source
    }));
    assert.deepEqual([...stage.baseline.keys()], ['safe.txt']);
    for (const rel of ['.env', 'blocked', 'nested']) assert.equal(fs.existsSync(path.join(stage.root, rel)), false);
    for (const rel of ['blocked', 'nested']) {
      fs.mkdirSync(path.join(stage.root, rel)); fs.writeFileSync(path.join(stage.root, rel, 'new.txt'), 'must stay excluded');
    }
    fs.writeFileSync(path.join(stage.root, '.env'), 'must stay excluded');
    fs.writeFileSync(path.join(stage.root, 'safe.txt'), 'after');
    assert.deepEqual(collectStagedChanges(stage).changes.map(change => change.path), ['safe.txt']);
  });

  await check('a granted canonical source replaced by a junction cannot acquire new private authority', async () => {
    const state = path.join(root, 'private-state-' + ++sequence);
    const source = path.join(state, 'managed-project'), privateRoot = path.join(state, 'private-notes');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(privateRoot);
    fs.writeFileSync(path.join(source, 'safe.txt'), 'project input');
    fs.writeFileSync(path.join(privateRoot, 'notes.txt'), 'must not enter staging');
    const granted = fs.realpathSync.native(source);
    fs.renameSync(source, path.join(state, 'original-project'));
    fs.symlinkSync(privateRoot, granted, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createStagingWorkspace({ taskId: 'task', workspaceId: 'workspace', sourceRoot: granted,
      trustedSourceRoot: granted, excludedRoots: [state], stagingRoot: path.join(root, 'stages') }), { code: 'STAGING_PATH_DENIED' });
    assert.equal(fs.readFileSync(path.join(privateRoot, 'notes.txt'), 'utf8'), 'must not enter staging');
  });

  // Removing encoding validation would silently import replacement bytes.
  await check('irreversible UTF-8 output is rejected before any Workspace import', async () => {
    for (const bytes of [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]), Buffer.from([0xff, 0xfe, 0x61, 0x00])]) {
      const stage = await fixture();
      fs.writeFileSync(path.join(stage.root, 'output.bin'), bytes);
      assert.throws(() => collectStagedChanges(stage), { code: 'STAGING_ENCODING_UNSUPPORTED' });
      assert.equal(fs.existsSync(path.join(stage.sourceRoot, 'output.bin')), false);
      assert.ok(fs.readFileSync(path.join(stage.root, 'output.bin')).equals(bytes));
    }
  });

  await check('UTF-8 BOM and non-ASCII text preserve the exact staged bytes', async () => {
    const stage = await fixture();
    const bytes = Buffer.from('\ufeffhello \u4e16\u754c\n', 'utf8');
    fs.writeFileSync(path.join(stage.root, 'edit.txt'), bytes);
    const [change] = collectStagedChanges(stage).changes;
    assert.ok(Buffer.from(change.content, 'utf8').equals(bytes));
    assert.equal(change.hash, hash(bytes));
    fs.writeFileSync(path.join(stage.sourceRoot, 'edit.txt'), change.content);
    refreshStagingBaseline(stage);
    assert.deepEqual(collectStagedChanges(stage).changes, []);
  });

  // Force the real filesystem race between scan hashing and import-byte reading.
  await check('a staged file changing after the scan cannot become an approved delta', async () => {
    const stage = await fixture();
    const target = path.join(stage.root, 'edit.txt');
    fs.writeFileSync(target, 'staged');
    const read = fs.readFileSync;
    let reads = 0;
    try {
      fs.readFileSync = function(file, ...args) {
        if (samePath(file, target) && ++reads === 2) fs.writeFileSync(target, 'changed during scan');
        return read.call(this, file, ...args);
      };
      assert.throws(() => collectStagedChanges(stage), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' });
    } finally { fs.readFileSync = read; }
    assert.equal(fs.readFileSync(path.join(stage.sourceRoot, 'edit.txt'), 'utf8'), 'before');
  });

  // A full live-source walk would read the deliberately unavailable unrelated subtree.
  await check('collection and accepted-baseline refresh read only changed live paths', async () => {
    const stage = await fixture({ 'edit.txt': 'before', 'unrelated/keep.txt': 'baseline' });
    fs.writeFileSync(path.join(stage.root, 'edit.txt'), 'after');
    fs.writeFileSync(path.join(stage.sourceRoot, 'unrelated/keep.txt'), 'external change');
    const unrelated = path.join(stage.sourceRoot, 'unrelated');
    const read = fs.readFileSync, readdir = fs.readdirSync;
    try {
      fs.readFileSync = function(file, ...args) {
        if (typeof file === 'string' && file.startsWith(unrelated + path.sep)) throw Object.assign(new Error('unrelated file unavailable'), { code: 'EACCES' });
        return read.call(this, file, ...args);
      };
      fs.readdirSync = function(dir, ...args) {
        if (samePath(dir, unrelated)) throw Object.assign(new Error('unrelated subtree unavailable'), { code: 'EACCES' });
        return readdir.call(this, dir, ...args);
      };
      assert.deepEqual(collectStagedChanges(stage).changes.map(change => change.path), ['edit.txt']);
      fs.writeFileSync(path.join(stage.sourceRoot, 'edit.txt'), 'after');
      refreshStagingBaseline(stage);
      assert.equal(stage.baseline.get('unrelated/keep.txt').hash, hash('baseline'), 'unrelated live writes must not be silently adopted');
      assert.deepEqual(collectStagedChanges(stage).changes, []);
    } finally { fs.readFileSync = read; fs.readdirSync = readdir; }
    fs.writeFileSync(path.join(stage.root, 'unrelated/keep.txt'), 'agent change');
    assert.throws(() => collectStagedChanges(stage), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' });
  });

  await check('changed live paths retain conflict and unknown-read guards', async () => {
    const stage = await fixture();
    fs.writeFileSync(path.join(stage.root, 'edit.txt'), 'after');
    fs.writeFileSync(path.join(stage.sourceRoot, 'edit.txt'), 'external');
    assert.throws(() => collectStagedChanges(stage), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' });
    fs.writeFileSync(path.join(stage.sourceRoot, 'edit.txt'), 'before');
    const read = fs.readFileSync;
    try {
      fs.readFileSync = function(file, ...args) {
        if (samePath(file, path.join(stage.sourceRoot, 'edit.txt'))) throw Object.assign(new Error('changed file unreadable'), { code: 'EACCES' });
        return read.call(this, file, ...args);
      };
      assert.throws(() => collectStagedChanges(stage), error => error.code === 'STAGING_READ_FAILED' && error.snapshotArea === 'source');
    } finally { fs.readFileSync = read; }
  });

  await check('new nested paths and deletions can refresh only after their exact import', async () => {
    const stage = await fixture({ 'delete.txt': 'old', 'keep.txt': 'keep' });
    fs.unlinkSync(path.join(stage.root, 'delete.txt'));
    fs.mkdirSync(path.join(stage.root, 'new/nested'), { recursive: true });
    fs.writeFileSync(path.join(stage.root, 'new/nested/result.txt'), 'result');
    assert.deepEqual(collectStagedChanges(stage).changes.map(change => [change.action, change.path]), [['delete', 'delete.txt'], ['write', 'new/nested/result.txt']]);
    assert.throws(() => refreshStagingBaseline(stage), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' });
    fs.unlinkSync(path.join(stage.sourceRoot, 'delete.txt'));
    fs.mkdirSync(path.join(stage.sourceRoot, 'new/nested'), { recursive: true });
    fs.writeFileSync(path.join(stage.sourceRoot, 'new/nested/result.txt'), 'result');
    refreshStagingBaseline(stage);
    assert.deepEqual(collectStagedChanges(stage).changes, []);
  });

  await check('a changed live ancestor cannot redirect validation through a junction', async () => {
    const stage = await fixture({ 'nested/edit.txt': 'before' });
    fs.writeFileSync(path.join(stage.root, 'nested/edit.txt'), 'after');
    const outside = path.join(root, 'outside-' + ++sequence); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'edit.txt'), 'before');
    fs.renameSync(path.join(stage.sourceRoot, 'nested'), path.join(stage.sourceRoot, 'original'));
    fs.symlinkSync(outside, path.join(stage.sourceRoot, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => collectStagedChanges(stage), error => ['STAGING_PATH_ESCAPE', 'WORKSPACE_RECONCILIATION_REQUIRED'].includes(error.code));
    assert.equal(fs.readFileSync(path.join(outside, 'edit.txt'), 'utf8'), 'before');
  });
} finally {
  // This process created the exact temporary root above; no user projects are removed.
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
