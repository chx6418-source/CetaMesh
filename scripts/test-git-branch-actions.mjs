import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { gitRun } from '../src/workspace/tools.js';
import {workspaceJournalDir} from '../src/workspace/transaction.js';

let createGitBranchActions;
try { ({ createGitBranchActions } = await import('../src/workspace/git-branch-actions.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('git-branch-actions.js')) throw error; }
const env = { ...process.env }; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cases = [], roots = [], test = (name, run) => cases.push({ name, run });
const git = (root, ...args) => execFileSync('git', ['--literal-pathspecs', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
function fixture({ linked = false, refFormat = 'files' } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-branch-actions-'))); roots.push(base);
  const parent = path.join(base, 'repo'); fs.mkdirSync(parent); git(parent, 'init', '-b', 'main', ...(refFormat === 'files' ? [] : ['--ref-format=' + refFormat]));
  git(parent, 'config', 'user.name', 'Branch fixture'); git(parent, 'config', 'user.email', 'branch@example.invalid'); git(parent, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(parent, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(parent, 'keep.txt'), 'untouched\n'); fs.writeFileSync(path.join(parent, '[literal].txt'), 'literal\n');
  git(parent, 'add', '--', 'a.txt', 'keep.txt', '[literal].txt'); git(parent, 'commit', '-m', 'base');
  const oldHead = git(parent, 'rev-parse', 'HEAD'); git(parent, 'switch', '-c', 'target');
  fs.writeFileSync(path.join(parent, 'a.txt'), 'target\n'); fs.writeFileSync(path.join(parent, 'new.txt'), 'added\n'); fs.unlinkSync(path.join(parent, '[literal].txt'));
  git(parent, 'add', '--', 'a.txt', 'new.txt', '[literal].txt'); git(parent, 'commit', '-m', 'target'); const targetHead = git(parent, 'rev-parse', 'HEAD'); git(parent, 'switch', 'main');
  let root = parent;
  if (linked) { root = path.join(base, 'state', 'agent-worktrees', crypto.randomUUID()); fs.mkdirSync(path.dirname(root), { recursive: true }); git(parent, 'worktree', 'add', '-b', 'codex/worker', root, oldHead); root = fs.realpathSync.native(root); }
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir'), commonDir = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const entry = { id: path.basename(base), root }, events = [], slot = linked ? 'worktrees/' + path.basename(gitDir) + '/HEAD' : 'main-worktree/HEAD';
  return { base, parent, root, gitDir, commonDir, slot, refFormat, entry, events, oldHead, targetHead,
    oldRef: linked ? 'refs/heads/codex/worker' : 'refs/heads/main', targetBranch: 'refs/heads/target' };
}
function actions(f, { record } = {}) { assert.equal(typeof createGitBranchActions, 'function', 'G2 clean-switch domain factory must exist'); return createGitBranchActions({nativeExecutable: process.env.CETAMESH_TEST_WORKSPACE_NATIVE, record: record ?? ((...args) => f.events.push(args)) }); }
const filePhase = args => args.some(arg => arg.startsWith('--workspace-byte-transaction='));
const native = (f, args, options = {}) => gitRun(f.root, args, { ...options, literalPaths: true, repository: { gitDir: f.gitDir, commonDir: f.commonDir, workTree: f.root }, referenceBackend: { format: f.refFormat, root: f.commonDir } });
const index = f => fs.readFileSync(path.join(f.gitDir, 'index'));
const code = wanted => error => { assert.equal(error.code, wanted, error.message); return true; };
function interceptNative(predicate, mutate) {
  const original = childProcess.execFile; let triggered = false;
  childProcess.execFile = function(command, args, ...rest) { if ((command === 'git' || filePhase(args)) && !triggered && predicate(args)) { triggered = true; mutate(); } return original.call(this, command, args, ...rest); };
  syncBuiltinESMExports(); return { happened: () => triggered, release: () => { childProcess.execFile = original; syncBuiltinESMExports(); } };
}

// Native qualified HEAD names are readable, but Git 2.55's symbolic-ref
// transaction validates them differently. Preserve that negative proof.
for (const linked of [false, true]) for (const refFormat of ['files', 'reftable']) {
  test(`native exact-tree and ordinary HEAD CAS; qualified symbolic writes are unsupported (${linked ? 'linked' : 'main'} ${refFormat})`, async () => {
    const f = fixture({ linked, refFormat }), parentHead = git(f.parent, 'symbolic-ref', 'HEAD');
    await native(f, ['read-tree', '-m', '-u', '--no-recurse-submodules', f.oldHead, f.targetHead], { indexFile: path.join(f.gitDir, 'index') });
    assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'target\n');
    await assert.rejects(native(f, ['update-ref', '--stdin'], { input: `start\noption no-deref\nverify ${f.targetBranch} ${f.targetHead}\noption no-deref\nsymref-update ${f.slot} ${f.targetBranch} ref ${f.oldRef}\nprepare\ncommit\n` }), error => error.exitCode === 128 && error.message.includes('bad name'));
    await native(f, ['update-ref', '--stdin'], { input: `start\noption no-deref\nverify ${f.targetBranch} ${f.targetHead}\noption no-deref\nsymref-update HEAD ${f.targetBranch} ref ${f.oldRef}\nprepare\ncommit\n` });
    assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.targetHead); assert.equal(git(f.root, 'diff-index', '--cached', '--name-only', f.targetHead, '--'), '');
    assert.equal(git(f.root, 'rev-parse', f.oldRef), f.oldHead); if (linked) { assert.equal(git(f.parent, 'symbolic-ref', 'HEAD'), parentHead); assert.equal(fs.readFileSync(path.join(f.parent, 'a.txt'), 'utf8'), 'base\n'); }
  });
}
for (const linked of [false, true]) for (const refFormat of ['files', 'reftable']) {
  test(`native original GIT_DIR cannot pin ordinary HEAD when commondir presence changes (${linked ? 'linked' : 'main'} ${refFormat})`, async () => {
    const f = fixture({ linked, refFormat }), marker = path.join(f.gitDir, 'commondir'), saved = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
    let wrongSlot;
    if (linked) { git(f.parent, 'symbolic-ref', 'HEAD', f.oldRef); wrongSlot = f.commonDir; }
    else {
      const other = path.join(f.base, 'routing-control'); git(f.root, 'worktree', 'add', '--detach', other, f.oldHead); git(other, 'symbolic-ref', 'HEAD', f.oldRef);
      wrongSlot = path.join(f.commonDir, 'worktrees', path.basename(f.gitDir)); fs.cpSync(git(other, 'rev-parse', '--absolute-git-dir'), wrongSlot, { recursive: true });
    }
    try {
      if (saved) fs.unlinkSync(marker); else fs.writeFileSync(marker, f.commonDir.split(path.sep).join('/') + '\n');
      await native(f, ['update-ref', '--stdin'], { input: `start\noption no-deref\nverify ${f.targetBranch} ${f.targetHead}\noption no-deref\nsymref-update HEAD ${f.targetBranch} ref ${f.oldRef}\nprepare\ncommit\n` });
    } finally { if (saved) fs.writeFileSync(marker, saved); else fs.unlinkSync(marker); }
    assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef, 'original source HEAD was not the native write destination');
    assert.equal(git(f.root, '--git-dir=' + wrongSlot, 'symbolic-ref', 'HEAD'), f.targetBranch, 'counterexample must change the other physical HEAD');
  });
}
for (const linked of [false, true]) for (const refFormat of ['files', 'reftable']) {
  test(`clean switch reaches the reviewed local branch and exact tree (${linked ? 'managed layout' : 'main'} ${refFormat})`, async () => {
    const f = fixture({ linked, refFormat }), product = actions(f), beforeParent = git(f.parent, 'rev-parse', 'HEAD'), beforeKeep = fs.readFileSync(path.join(f.root, 'keep.txt'));
    const request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }); assert.equal(request.canSwitch, true); assert.equal(request.expectedTargetHead, f.targetHead);
    const result = await product.switchBranch(f.entry, request, 'fixture-owner');
    assert.equal(result.switched, true); assert.equal(result.phase, 'completed'); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.targetHead);
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'target\n'); assert.equal(fs.existsSync(path.join(f.root, '[literal].txt')), false); assert.equal(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8'), 'added\n'); assert.deepEqual(fs.readFileSync(path.join(f.root, 'keep.txt')), beforeKeep);
    assert.equal(git(f.root, 'diff-index', '--cached', '--name-only', f.targetHead, '--'), ''); assert.equal(git(f.root, 'status', '--porcelain'), ''); assert.equal(git(f.root, 'rev-parse', f.oldRef), f.oldHead);
    assert.ok(f.events.some(row => row[2] === 'git.branch.switch' && row[3].includes(f.targetHead))); if (linked) assert.equal(git(f.parent, 'rev-parse', 'HEAD'), beforeParent);
  });
}
test('dirty tracked and untracked state is refused with exact bytes and index retained', async () => {
  for (const kind of ['tracked', 'staged', 'untracked']) {
    const f = fixture(), product = actions(f);
    fs.writeFileSync(path.join(f.root, kind === 'untracked' ? 'local.txt' : 'a.txt'), 'owned dirty bytes\n'); if (kind === 'staged') git(f.root, 'add', '--', 'a.txt');
    const before = index(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch });
    assert.equal(request.canSwitch, false); await assert.rejects(product.switchBranch(f.entry, request), code('GIT_WORKTREE_DIRTY')); assert.deepEqual(index(f), before); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef);
    assert.equal(fs.readFileSync(path.join(f.root, kind === 'untracked' ? 'local.txt' : 'a.txt'), 'utf8'), 'owned dirty bytes\n');
  }
});
test('same-size cached-stat dirty bytes on an affected file are not discarded', async () => {
  const f = fixture(); git(f.root, 'config', 'core.trustctime', 'false'); fs.utimesSync(path.join(f.root, 'a.txt'), 1000000000, 1000000000); git(f.root, 'add', '--', 'a.txt');
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'evil\n'); fs.utimesSync(path.join(f.root, 'a.txt'), 1000000000, 1000000000);
  const product = actions(f), before = index(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch });
  assert.equal(request.canSwitch, false); await assert.rejects(product.switchBranch(f.entry, request), code('GIT_WORKTREE_DIRTY')); assert.deepEqual(index(f), before); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'evil\n');
});
test('stale HEAD ref, index, affected hashes and target OID refuse before working-tree effects', async () => {
  for (const kind of ['head', 'index', 'file', 'target']) {
    const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch });
    if (kind === 'head') { git(f.root, 'branch', 'same-oid'); git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/same-oid'); }
    if (kind === 'index') { fs.writeFileSync(path.join(f.root, 'keep.txt'), 'staged concurrent\n'); git(f.root, 'add', '--', 'keep.txt'); }
    if (kind === 'file') fs.writeFileSync(path.join(f.root, 'a.txt'), 'concurrent working\n');
    if (kind === 'target') git(f.root, 'update-ref', f.targetBranch, f.oldHead, f.targetHead);
    const before = index(f), hash = digest(fs.readFileSync(path.join(f.root, 'a.txt'))), head = git(f.root, 'rev-parse', 'HEAD');
    await assert.rejects(product.switchBranch(f.entry, request), error => ['GIT_HEAD_CHANGED', 'GIT_INDEX_CHANGED', 'WORKSPACE_CONFLICT', 'GIT_BRANCH_CHANGED'].includes(error.code));
    assert.deepEqual(index(f), before); assert.equal(digest(fs.readFileSync(path.join(f.root, 'a.txt'))), hash); assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  }
});
test('ignored collision is refused and sensitive or gitlink target scope cannot expand', async () => {
  const f = fixture(), product = actions(f); fs.writeFileSync(path.join(f.root, '.gitignore'), 'new.txt\n'); git(f.root, 'add', '--', '.gitignore'); git(f.root, 'commit', '-m', 'ignore destination'); fs.writeFileSync(path.join(f.root, 'new.txt'), 'ignored user bytes\n');
  const before = index(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }); assert.equal(request.canSwitch, false);
  await assert.rejects(product.switchBranch(f.entry, request), code('GIT_CHECKOUT_COLLISION')); assert.deepEqual(index(f), before); assert.equal(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8'), 'ignored user bytes\n');
  for (const special of ['.env', 'submodule']) {
    const g = fixture(); git(g.root, 'switch', 'target');
    if (special === '.env') { fs.writeFileSync(path.join(g.root, '.env'), 'fixture secret'); git(g.root, 'add', '--', '.env'); }
    else git(g.root, 'update-index', '--add', '--cacheinfo', '160000', g.oldHead, 'submodule');
    git(g.root, 'commit', '-m', 'special target'); git(g.root, 'switch', 'main');
    await assert.rejects(actions(g).reviewSwitch(g.entry, { targetBranch: g.targetBranch }), error => ['SENSITIVE_RESOURCE', 'GIT_PATH_INVALID'].includes(error.code)); assert.equal(git(g.root, 'symbolic-ref', 'HEAD'), g.oldRef);
  }
});
test('an occupied branch is refused and works after its actual other owner moves away', async () => {
  const f = fixture(), other = path.join(f.base, 'other-owner'); git(f.root, 'worktree', 'add', other, 'target'); const product = actions(f);
  const request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }); assert.equal(request.canSwitch, false); await assert.rejects(product.switchBranch(f.entry, request), code('GIT_BRANCH_IN_USE'));
  assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef); git(other, 'switch', '-c', 'other-owner-branch');
  assert.equal((await product.switchBranch(f.entry, await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }))).switched, true); assert.equal(git(other, 'symbolic-ref', 'HEAD'), 'refs/heads/other-owner-branch');
});
test('normal index and HEAD locks are respected without removing external owners', async () => {
  for (const lock of ['index.lock', 'HEAD.lock']) {
    const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), before = index(f), location = path.join(f.gitDir, lock); fs.writeFileSync(location, 'external owner');
    await assert.rejects(product.switchBranch(f.entry, request), error => ['GIT_INDEX_BUSY', 'GIT_HEAD_BUSY'].includes(error.code));
    assert.equal(fs.readFileSync(location, 'utf8'), 'external owner'); assert.deepEqual(index(f), before); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'base\n');
  }
});
test('target movement between phases retains prepared data as unknown and does not attach a new unreviewed tip', async () => {
  const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch });
  const race = interceptNative(args => args.includes('update-ref') && args.includes('--stdin'), () => git(f.root, 'update-ref', f.targetBranch, f.oldHead, f.targetHead)); let receipt;
  try { await assert.rejects(product.switchBranch(f.entry, request), error => { receipt = error; assert.equal(error.effectStatus, 'unknown'); return true; }); assert.equal(race.happened(), true); }
  finally { race.release(); }
  assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'target\n'); assert.equal(receipt.targetHead, f.targetHead); assert.ok(['tree-written', 'head-pending'].includes(receipt.phase));
  git(f.root, 'update-ref', f.targetBranch, f.targetHead, f.oldHead);
  await assert.rejects(product.switchBranch(f.entry, request), error => ['GIT_INDEX_CHANGED', 'WORKSPACE_CONFLICT'].includes(error.code));
  const finish = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch, mode: 'finish-prepared' }); assert.equal(finish.canSwitch, true);
  assert.equal((await product.switchBranch(f.entry, finish)).switched, true); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.targetHead);
});
for (const linked of [false, true]) for (const refFormat of ['files', 'reftable']) {
  test(`commondir presence race at final native HEAD launch never changes another physical HEAD (${linked ? 'linked' : 'main'} ${refFormat})`, async () => {
    const f = fixture({ linked, refFormat }), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), marker = path.join(f.gitDir, 'commondir'), saved = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
    const other = path.join(f.base, 'alternate-metadata'); fs.cpSync(f.commonDir, other, { recursive: true }); const parentHead = git(f.parent, 'symbolic-ref', 'HEAD');
    const race = interceptNative(args => args.includes('update-ref') && args.includes('--stdin'), () => { if (saved) fs.unlinkSync(marker); else fs.writeFileSync(marker, other.split(path.sep).join('/') + '\n'); }); let receipt;
    try { await assert.rejects(product.switchBranch(f.entry, request), error => { receipt = error; assert.equal(error.effectStatus, 'unknown'); assert.equal(error.targetHead, f.targetHead); return true; }); assert.equal(race.happened(), true); }
    finally { race.release(); if (saved) fs.writeFileSync(marker, saved); else if (fs.existsSync(marker)) fs.unlinkSync(marker); }
    assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.targetHead); assert.equal(git(f.parent, '--git-dir=' + other, 'symbolic-ref', 'HEAD'), parentHead);
    if (linked) assert.equal(git(f.parent, 'symbolic-ref', 'HEAD'), parentHead); assert.equal(receipt.phase, 'head-written');
    const fresh = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }); const observed = await product.switchBranch(f.entry, fresh); assert.equal(observed.switched, false); assert.equal(observed.reason, 'already-current');
  });
}
test('finish-prepared is evidence-based and rejects changed working bytes', async () => {
  const f = fixture(), product = actions(f); await native(f, ['read-tree', '-m', '-u', '--no-recurse-submodules', f.oldHead, f.targetHead], { indexFile: path.join(f.gitDir, 'index') });
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'third-party postimage\n');
  const request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch, mode: 'finish-prepared' }); assert.equal(request.canSwitch, false);
  await assert.rejects(product.switchBranch(f.entry, request), code('GIT_WORKTREE_DIRTY')); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'third-party postimage\n'); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef);
});

test('retained raw recovery rejects replacement metadata despite matching HEAD/index, then resumes after the original owner is restored', async () => {
  const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, {targetBranch: f.targetBranch});
  const lock = path.join(f.gitDir, 'HEAD.lock'), race = interceptNative(args => args.includes('update-ref') && args.includes('--stdin'), () => fs.writeFileSync(lock, 'owned fault'));
  let interrupted;
  try { await assert.rejects(product.switchBranch(f.entry, request), error => { interrupted = error; return error.effectStatus === 'unknown'; }); }
  finally { race.release(); }
  const originalMetadata = path.join(f.base, 'original-metadata'), replacement = path.join(f.base, 'replaced-metadata');
  const before = fs.readFileSync(path.join(f.gitDir, 'index')), fileTime = fs.statSync(path.join(f.root, 'a.txt'), {bigint: true}).mtimeNs;
  fs.renameSync(f.gitDir, originalMetadata); fs.cpSync(originalMetadata, f.gitDir, {recursive: true}); fs.unlinkSync(lock);
  assert.deepEqual(fs.readFileSync(path.join(f.gitDir, 'index')), before); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.oldHead);
  await assert.rejects(product.reviewSwitch(f.entry, {targetBranch: f.targetBranch, mode: 'finish-prepared'}), {code: 'WORKSPACE_RECOVERY_REQUIRED'});
  const batch = path.join(workspaceJournalDir(f.root), interrupted.byteTransaction.name);
  assert.equal(fs.readFileSync(path.join(batch, 'manifest.json'), 'utf8').includes('git-branch-switch'), true);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'target\n');
  fs.renameSync(f.gitDir, replacement); fs.renameSync(originalMetadata, f.gitDir); fs.unlinkSync(lock);
  const fresh = await product.reviewSwitch(f.entry, {targetBranch: f.targetBranch, mode: 'finish-prepared'}); assert.equal(fresh.canSwitch, true);
  const guard = interceptNative(filePhase, () => { throw Error('Recovery must not write the file phase again'); });
  try { assert.equal((await product.switchBranch(f.entry, fresh)).switched, true); assert.equal(guard.happened(), false); }
  finally { guard.release(); }
  assert.equal(fs.statSync(path.join(f.root, 'a.txt'), {bigint: true}).mtimeNs, fileTime); assert.deepEqual(fs.readdirSync(workspaceJournalDir(f.root)), []);
});

test('a prepared completion that fails before native dispatch has no new unknown effect', async () => {
  const f = fixture(); await native(f, ['read-tree', '-m', '-u', '--no-recurse-submodules', f.oldHead, f.targetHead], { indexFile: path.join(f.gitDir, 'index') });
  const product = actions(f, { record: (_entry, _actor, action) => { if (action === 'git.branch.switch.prepared') throw Object.assign(new Error('fixture audit store refusal'), { code: 'AUDIT_WRITE_FAILED' }); } });
  const request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch, mode: 'finish-prepared' }), before = index(f);
  await assert.rejects(product.switchBranch(f.entry, request), error => { assert.equal(error.code, 'AUDIT_WRITE_FAILED'); assert.equal(error.effectStatus, 'none'); assert.equal(product.isKnownBranchNoEffectError(error), true); return true; });
  assert.deepEqual(index(f), before); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'target\n');
});
test('a sparse-config launch race cannot remove an unchanged file outside the reviewed delta', async () => {
  const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), beforeKeep = fs.readFileSync(path.join(f.root, 'keep.txt')), configPath = path.join(f.commonDir, 'config'), config = fs.readFileSync(configPath);
  const race = interceptNative(filePhase, () => { fs.mkdirSync(path.join(f.gitDir, 'info'), { recursive: true }); fs.writeFileSync(path.join(f.gitDir, 'info', 'sparse-checkout'), '/a.txt\n'); git(f.root, 'config', 'core.sparseCheckout', 'true'); });
  try { await assert.rejects(product.switchBranch(f.entry, request), error => { assert.equal(error.effectStatus, 'unknown'); return true; }); assert.equal(race.happened(), true); }
  finally { race.release(); fs.writeFileSync(configPath, config); }
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'keep.txt')), beforeKeep, 'unselected file bytes must survive the actual native sparse race'); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef);
});
test('binary target bytes and unrelated raw bytes survive the native two-tree switch', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'binary.bin'), Buffer.from([0, 255, 1, 0, 23])); git(f.root, 'add', '--', 'binary.bin'); git(f.root, 'commit', '-m', 'binary baseline'); const old = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'switch', 'target'); const targetBytes = Buffer.from([0, 254, 2, 0, 24, 0, 128]); fs.writeFileSync(path.join(f.root, 'binary.bin'), targetBytes); git(f.root, 'add', '--', 'binary.bin'); git(f.root, 'commit', '-m', 'binary target'); git(f.root, 'switch', 'main');
  const product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), keep = fs.readFileSync(path.join(f.root, 'keep.txt')); assert.equal(request.canSwitch, true);
  assert.equal((await product.switchBranch(f.entry, request)).switched, true); assert.deepEqual(fs.readFileSync(path.join(f.root, 'binary.bin')), targetBytes); assert.deepEqual(fs.readFileSync(path.join(f.root, 'keep.txt')), keep); assert.equal(git(f.root, 'rev-parse', f.oldRef), old);
});
test('native absent index after an empty commit is bound explicitly and can switch cleanly', async () => {
  const f = fixture(); git(f.root, 'switch', '--orphan', 'empty-source'); git(f.root, 'commit', '--allow-empty', '-m', 'empty baseline');
  if (fs.existsSync(path.join(f.gitDir, 'index'))) fs.unlinkSync(path.join(f.gitDir, 'index'));
  const product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }); assert.equal(request.indexIdentity, null); assert.equal(request.canSwitch, true);
  assert.equal((await product.switchBranch(f.entry, request)).switched, true); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, 'status', '--porcelain'), '');
});
test('a new other-worktree owner at final HEAD dispatch remains explicit unknown until that owner moves', async () => {
  const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), other = path.join(f.base, 'racing-other-owner');
  const race = interceptNative(args => args.includes('update-ref') && args.includes('--stdin'), () => git(f.root, 'worktree', 'add', other, 'target'));
  try { await assert.rejects(product.switchBranch(f.entry, request), error => { assert.equal(error.effectStatus, 'unknown'); assert.equal(error.phase, 'head-written'); return true; }); assert.equal(race.happened(), true); }
  finally { race.release(); }
  assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(other, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(fs.readFileSync(path.join(other, 'a.txt'), 'utf8'), 'target\n');
  git(other, 'switch', '-c', 'other-owner-recovered'); const fresh = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }); assert.equal(fresh.canSwitch, true); assert.equal((await product.switchBranch(f.entry, fresh)).reason, 'already-current'); assert.equal(git(other, 'symbolic-ref', 'HEAD'), 'refs/heads/other-owner-recovered');
});

for (const linked of [false, true]) for (const refFormat of ['files', 'reftable']) {
  test(`config backend URI substituted at final launch retains only source HEAD effect (${linked ? 'linked' : 'main'} ${refFormat})`, async () => {
    const f = fixture({ linked, refFormat }), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), configPath = path.join(f.commonDir, 'config'), beforeConfig = fs.readFileSync(configPath);
    const other = path.join(f.base, 'config-alternate'); fs.cpSync(f.commonDir, other, { recursive: true }); const parentHead = git(f.parent, 'symbolic-ref', 'HEAD');
    const race = interceptNative(args => args.includes('update-ref') && args.includes('--stdin'), () => { git(f.root, 'config', 'core.repositoryFormatVersion', '1'); git(f.root, 'config', 'extensions.refStorage', refFormat + '://' + other.split(path.sep).join('/')); });
    try { await assert.rejects(product.switchBranch(f.entry, request), error => { assert.equal(error.effectStatus, 'unknown'); assert.equal(error.phase, 'head-written'); assert.equal(error.targetHead, f.targetHead); return true; }); assert.equal(race.happened(), true); }
    finally { race.release(); fs.writeFileSync(configPath, beforeConfig); }
    assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, '--git-dir=' + other, 'symbolic-ref', 'HEAD'), parentHead); if (linked) assert.equal(git(f.parent, 'symbolic-ref', 'HEAD'), parentHead);
  });
}
for (const kind of ['same-oid-head', 'source-branch-oid', 'index-lock', 'head-lock']) {
  test(`native phase race retains real state and exact phase (${kind})`, async () => {
    const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch });
    const lock = path.join(f.gitDir, kind === 'index-lock' ? 'index.lock' : 'HEAD.lock'); if (kind === 'same-oid-head') git(f.root, 'branch', 'same-oid', f.oldHead);
    let competingIndexRefused = false;
    const race = interceptNative(args => kind === 'index-lock' ? filePhase(args) : args.includes('update-ref') && args.includes('--stdin'), () => {
      if (kind === 'same-oid-head') git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/same-oid');
      else if (kind === 'source-branch-oid') git(f.root, 'update-ref', f.oldRef, f.targetHead, f.oldHead);
      else if (kind === 'index-lock') { assert.throws(() => git(f.root, 'update-index', '--refresh'), error => error.status === 128 && /index\.lock/.test(String(error.stderr))); competingIndexRefused = true; }
      else fs.writeFileSync(lock, 'external race owner');
    }); let receipt;
    try { if (kind === 'index-lock') { const completed = await product.switchBranch(f.entry, request); assert.equal(completed.switched, true); assert.equal(competingIndexRefused, true); } else await assert.rejects(product.switchBranch(f.entry, request), error => { receipt = error; assert.equal(error.effectStatus, 'unknown'); assert.equal(error.targetHead, f.targetHead); return true; }); assert.equal(race.happened(), true); }
    finally { race.release(); }
    if (kind === 'index-lock') { assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(fs.existsSync(lock), false); }
    else if (kind === 'source-branch-oid') { assert.equal(receipt.phase, 'head-written'); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.targetBranch); assert.equal(git(f.root, 'rev-parse', f.oldRef), f.targetHead); }
    else if (kind === 'same-oid-head') { assert.equal(receipt.phase, 'head-pending'); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), 'refs/heads/same-oid'); }
    else { assert.equal(fs.readFileSync(lock, 'utf8'), 'external race owner'); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), f.oldRef); fs.unlinkSync(lock); }
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'target\n');
    if (!['source-branch-oid', 'index-lock'].includes(kind)) { const fresh = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch, mode: 'finish-prepared' }); assert.equal(fresh.canSwitch, true); assert.equal((await product.switchBranch(f.entry, fresh)).switched, true); }
  });
}
for (const phase of ['file-set', 'update-ref']) {
  test(`native cancellation at ${phase} preserves its observed phase for fresh review`, async () => {
    const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), controller = new AbortController();
    const original = childProcess.execFile; let started = false;
    childProcess.execFile = function(command, args, ...rest) { const child = original.call(this, command, args, ...rest); if (phase === 'file-set' ? filePhase(args) : command === 'git' && args.includes(phase)) child.once('spawn', () => { started = true; controller.abort(); }); return child; }; syncBuiltinESMExports();
    try { await assert.rejects(product.switchBranch(f.entry, request, 'fixture-owner', { signal: controller.signal }), error => { assert.equal(error.effectStatus, 'unknown'); assert.equal(error.targetHead, f.targetHead); assert.equal(error.phase, phase === 'file-set' ? 'tree-pending' : 'head-pending'); return true; }); assert.equal(started, true); }
    finally { childProcess.execFile = original; syncBuiltinESMExports(); }
    const head = git(f.root, 'symbolic-ref', 'HEAD'); assert.ok([f.oldRef, f.targetBranch].includes(head)); assert.equal(git(f.root, 'rev-parse', f.oldRef), f.oldHead); assert.equal(git(f.root, 'rev-parse', f.targetBranch), f.targetHead);
    assert.ok(f.events.some(row => row[2] === 'git.branch.switch.unknown' && row[3].includes(f.targetHead)));
  });
}

async function lockOwnedFile(location, cwd) {
  const script = `$ownedStream=[System.IO.File]::Open('${location.replaceAll("'", "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $ownedStream.Dispose()`;
  const child = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Owned lock helper was not ready')), 10000); child.once('error', reject); child.stdout.on('data', bytes => { output += bytes; if (output.includes('ready')) { clearTimeout(timer); resolve(); } }); });
  return async () => { child.stdin.end('\n'); await closed; };
}
if (process.platform === 'win32') for (const verdict of ['confirmed', 'unknown']) {
  test(`real FileShare.None cleanup cannot replace ${verdict} HEAD outcome`, async () => {
    const f = fixture(), product = actions(f), request = await product.reviewSwitch(f.entry, { targetBranch: f.targetBranch }), original = childProcess.execFile;
    let releaseLock, anchorBase, outcome, lockingError, capturedIdentity;
    childProcess.execFile = function(command, args, options, callback) {
      if (command !== 'git' || !args.includes('update-ref') || !args.includes('--stdin')) return original.call(this, command, args, options, callback);
      if (verdict === 'unknown') git(f.root, 'update-ref', f.targetBranch, f.oldHead, f.targetHead);
      anchorBase = path.resolve(path.dirname(options.env.GIT_DIR)); capturedIdentity = fs.lstatSync(anchorBase, { bigint: true });
      return original.call(this, command, args, options, async (...values) => { try { releaseLock = await lockOwnedFile(path.join(options.env.GIT_DIR, 'HEAD'), f.base); } catch (error) { lockingError = error; } callback(...values); });
    }; syncBuiltinESMExports();
    try {
      if (verdict === 'confirmed') { outcome = await product.switchBranch(f.entry, request); assert.equal(outcome.switched, true); assert.equal(outcome.phase, 'completed'); }
      else await assert.rejects(product.switchBranch(f.entry, request), error => { outcome = error; assert.equal(error.effectStatus, 'unknown'); assert.equal(error.phase, 'head-pending'); return true; });
      assert.equal(lockingError, undefined); assert.equal(outcome.targetHead, f.targetHead); assert.equal(outcome.targetBranch, f.targetBranch); assert.equal(outcome.cleanupPending, true); assert.equal(outcome.cleanupResources[0].kind, 'git-head-routing-anchor');
      assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), verdict === 'confirmed' ? f.targetBranch : f.oldRef); assert.equal(fs.existsSync(anchorBase), true);
    } finally {
      childProcess.execFile = original; syncBuiltinESMExports(); await releaseLock?.();
      if (anchorBase) { assert.equal(path.dirname(anchorBase), fs.realpathSync.native(os.tmpdir())); assert.ok(path.basename(anchorBase).startsWith('cm-git-head-routing-')); const current = fs.lstatSync(anchorBase, { bigint: true }); assert.equal(current.dev, capturedIdentity.dev); assert.equal(current.ino, capturedIdentity.ino); fs.rmSync(anchorBase, { recursive: true, force: true }); }
    }
  });
}

let failed = 0;
try { for (const { name, run } of cases) { try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); } } }
finally { for (const root of roots) { assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir())); assert.ok(path.basename(root).startsWith('cm-git-branch-actions-')); fs.rmSync(root, { recursive: true, force: true }); } }
console.log(`Git branch actions: ${cases.length - failed} PASS, ${failed} FAIL (${cases.length} groups)`);
if (failed) process.exitCode = 1;
