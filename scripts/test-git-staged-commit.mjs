import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createGitProduct } from '../src/workspace/git-product.js';
import { gitRun } from '../src/workspace/tools.js';
import { createWorkspaceRegistry } from '../src/workspace/registry.js';
import { createTaskRuntime } from '../src/task/runtime.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env }; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const cases = [], fixtures = [], test = (name, run) => cases.push({ name, run });
const git = (root, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const hash = (root, rel) => { try { return digest(fs.readFileSync(path.join(root, rel))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function fixture({ unborn = false, refFormat = 'files' } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-staged-commit-'))); fixtures.push(base);
  const root = path.join(base, 'repo'); fs.mkdirSync(root); git(root, 'init', '-b', 'main', ...(refFormat === 'files' ? [] : ['--ref-format=' + refFormat])); git(root, 'config', 'user.name', 'CetaMesh fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a baseline\n'); fs.writeFileSync(path.join(root, 'b.txt'), 'b baseline\n');
  if (!unborn) { git(root, 'add', '--', 'a.txt', 'b.txt'); git(root, '-c', 'commit.gpgSign=false', 'commit', '-m', 'baseline'); }
  const events = [], entry = { id: path.basename(base), root }, product = createGitProduct({ stateDir: base, registry: { list: () => [] }, record: (...args) => events.push(args) });
  const result = { base, root, entry, product, events };
  result.expectedRepositoryIdentity = (await product.reviewStaged(entry, { paths: ['a.txt'] })).expectedRepositoryIdentity;
  return result;
}
function review(f, paths) {
  let expectedHead = null, expectedHeadRef = null; try { expectedHead = git(f.root, 'rev-parse', '--verify', 'HEAD'); } catch {} try { expectedHeadRef = git(f.root, 'symbolic-ref', '-q', 'HEAD'); } catch {}
  const index = path.resolve(f.root, git(f.root, 'rev-parse', '--git-path', 'index'));
  const all = git(f.root, 'ls-files', '--stage', '-z').split('\0').filter(Boolean).map(line => { const match = /^(\d+) ([a-f0-9]{40}) (\d)\t([\s\S]+)$/.exec(line); return { mode: match[1], oid: match[2], stage: match[3], path: match[4] }; });
  return { paths, expectedHead, expectedHeadRef, expectedRepositoryIdentity: f.expectedRepositoryIdentity, expectedHashes: Object.fromEntries(paths.map(rel => [rel, hash(f.root, rel)])), indexIdentity: fs.existsSync(index) ? digest(fs.readFileSync(index)) : null,
    expectedIndexEntries: paths.map(rel => { const entry = all.find(item => item.path === rel); return entry ? { path: rel, mode: entry.mode, oid: entry.oid } : { path: rel, mode: null, oid: null }; }), message: 'Reviewed staged content' };
}
const code = wanted => error => { assert.equal(error.code, wanted, error.message); return true; };
function raceOnEvent(dir, filename, mutate) {
  let complete = false, watch, timer;
  const promise = new Promise((resolve, reject) => {
    watch = fs.watch(dir, (_event, name) => {
      if (complete || String(name) !== filename) return;
      complete = true; clearTimeout(timer); watch.close();
      try { mutate(); resolve(); } catch (error) { reject(error); }
    });
    timer = setTimeout(() => { watch.close(); reject(new Error('Expected native Git lock event was not observed')); }, 10000);
  });
  return { promise, close: () => { clearTimeout(timer); watch.close(); } };
}
async function managedFixture() {
  const f = await fixture(), sourceRoot = f.root, stateDir = path.join(f.base, 'state'), registry = createWorkspaceRegistry({ file: path.join(stateDir, 'workspaces.json') }), tasks = createTaskRuntime({ stateDir });
  const source = registry.create({ root: sourceRoot, name: 'race source' }), task = tasks.create({ workspaceId: source.id, goal: 'managed native CAS race' });
  f.product = createGitProduct({ stateDir, registry, getTask: id => tasks.get({ id }).task, record: (...args) => f.events.push(args) });
  const created = await f.product.create(source, { taskId: task.id, branch: 'codex/g1-native-race', expectedHead: git(sourceRoot, 'rev-parse', 'HEAD') }, { worktree: true });
  f.entry = registry.get(created.workspace.id); f.root = f.entry.root; f.sourceRoot = sourceRoot;
  return f;
}

for (const linked of [false, true]) for (const pivot of ['commondir', 'refStorage']) {
  test(`actual native CAS startup ${pivot} race retains only approved physical effects (${linked ? 'managed worktree' : 'main repository'})`, async () => {
    const f = linked ? await managedFixture() : await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'candidate staged content\n'); git(f.root, 'add', '--', 'a.txt');
    const request = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), gitDir = git(f.root, 'rev-parse', '--absolute-git-dir'), common = git(f.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const alternate = path.join(f.base, 'alternate-metadata'); fs.cpSync(common, alternate, { recursive: true });
    // Both physical stores can resolve the candidate; a missing-object failure
    // must not masquerade as a successful scope boundary.
    fs.writeFileSync(path.join(alternate, 'objects', 'info', 'alternates'), path.join(common, 'objects').split(path.sep).join('/') + '\n');
    const marker = path.join(gitDir, 'commondir'), savedMarker = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
    const config = path.join(common, 'config'), savedConfig = fs.readFileSync(config), index = fs.readFileSync(path.join(gitDir, 'index')), working = fs.readFileSync(path.join(f.root, 'a.txt'));
    const sourceRef = path.join(common, ...request.expectedHeadRef.split('/')), alternateRef = path.join(alternate, ...request.expectedHeadRef.split('/'));
    let triggered = false, receipt;
    const originalExecFile = childProcess.execFile;
    // Observe and forward the real native launch. No Git output or process is
    // substituted: the real writer changes the marker after the last source
    // check and immediately before Git initializes the ref backend.
    childProcess.execFile = function(command, args, ...rest) {
      if (command === 'git' && args.includes('update-ref') && !triggered) {
        triggered = true;
        if (pivot === 'commondir') fs.writeFileSync(marker, alternate.split(path.sep).join('/') + '\n');
        else fs.appendFileSync(config, `\n[core]\n repositoryformatversion = 1\n[extensions]\n refStorage = files://${alternate.split(path.sep).join('/')}\n`);
      }
      return originalExecFile.call(this, command, args, ...rest);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.product.commitStaged(f.entry, { ...request, message: 'actual native startup race' }), error => { receipt = error; assert.equal(error.effectStatus, 'unknown'); assert.match(error.sha, /^[a-f0-9]{40}$/); assert.equal(error.ref, request.expectedHeadRef); return true; });
      assert.equal(triggered, true); assert.equal(fs.readFileSync(sourceRef, 'utf8').trim(), receipt.sha, 'only the approved physical ref receives the CAS');
      assert.equal(fs.readFileSync(alternateRef, 'utf8').trim(), request.expectedHead, 'alternate physical ref remains unchanged');
      assert.equal(fs.existsSync(path.join(common, 'objects', receipt.sha.slice(0, 2), receipt.sha.slice(2))), true);
      assert.equal(fs.existsSync(path.join(alternate, 'objects', receipt.sha.slice(0, 2), receipt.sha.slice(2))), false);
      assert.deepEqual(fs.readFileSync(path.join(gitDir, 'index')), index); assert.deepEqual(fs.readFileSync(path.join(f.root, 'a.txt')), working);
      assert.ok(fs.readFileSync(path.join(common, 'logs', ...request.expectedHeadRef.split('/')), 'utf8').includes(receipt.sha));
    } finally {
      childProcess.execFile = originalExecFile; syncBuiltinESMExports();
      if (savedMarker === null) { if (fs.existsSync(marker)) fs.unlinkSync(marker); } else fs.writeFileSync(marker, savedMarker);
      fs.writeFileSync(config, savedConfig);
    }
    await assert.rejects(f.product.commitStaged(f.entry, { ...request, message: 'must not replay' }), error => ['GIT_HEAD_CHANGED', 'GIT_REPOSITORY_CHANGED'].includes(error.code));
    const recovered = await f.product.commitStaged(f.entry, { ...await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), message: 'fresh independent review' });
    assert.equal(recovered.committed, false); assert.equal(git(f.root, 'rev-parse', request.expectedHeadRef), receipt.sha);
    if (linked) assert.equal(git(f.sourceRoot, 'rev-parse', 'HEAD'), request.expectedHead);
  });
}
test('ordinary reftable repository keeps its native backend through exact staged commit', async () => {
  const f = await fixture({ refFormat: 'reftable' }); fs.writeFileSync(path.join(f.root, 'a.txt'), 'reftable staged bytes\n');
  await f.product.stage(f.entry, await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }));
  const request = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), result = await f.product.commitStaged(f.entry, { ...request, message: 'reftable G1 commit' });
  assert.equal(result.committed, true); assert.equal(git(f.root, 'rev-parse', '--show-ref-format'), 'reftable'); assert.equal(git(f.root, 'show', 'HEAD:a.txt'), 'reftable staged bytes'); assert.equal(git(f.root, 'rev-parse', 'HEAD^'), request.expectedHead);
});

test('native no-deref CAS updates only the approved branch even if HEAD changes', async () => {
  const f = await fixture(), expectedHead = review(f, ['a.txt']).expectedHead;
  git(f.root, 'branch', 'other'); const tree = git(f.root, 'rev-parse', 'HEAD^{tree}'), next = git(f.root, 'commit-tree', tree, '-p', expectedHead, '-m', 'approved ref fixture');
  git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  await gitRun(f.root, ['update-ref', '--stdin'], { input: `start\noption no-deref\nupdate refs/heads/main ${next} ${expectedHead}\nprepare\ncommit\n` });
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), expectedHead); assert.equal(git(f.root, 'rev-parse', 'refs/heads/main'), next); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), 'refs/heads/other');
});

// Re-adding a working file, committing the entire normal index, or resetting the
// normal index would each destroy a distinct piece of this observable fixture.
test('partial staged commit uses the reviewed OID and preserves dirty bytes and unrelated stage', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'a staged\n'); fs.writeFileSync(path.join(f.root, 'b.txt'), 'b staged\n'); git(f.root, 'add', '--', 'a.txt', 'b.txt'); fs.appendFileSync(path.join(f.root, 'a.txt'), 'a unstaged\n');
  assert.equal(typeof f.product.commitStaged, 'function', 'G1 exact staged commit must exist on the existing Git product');
  const request = review(f, ['a.txt']), bOid = git(f.root, 'rev-parse', ':b.txt'), before = fs.readFileSync(path.join(f.root, 'a.txt')), normalIndex = fs.readFileSync(path.join(f.root, '.git', 'index'));
  const result = await f.product.commitStaged(f.entry, request, 'fixture-owner');
  assert.equal(result.committed, true); assert.equal(result.indexUpdated, true); assert.equal(git(f.root, 'show', 'HEAD:a.txt'), 'a staged'); assert.equal(git(f.root, 'show', 'HEAD:b.txt'), 'b baseline');
  assert.equal(git(f.root, 'rev-parse', 'HEAD^'), request.expectedHead); assert.equal(git(f.root, 'rev-parse', ':b.txt'), bOid); assert.equal(git(f.root, 'rev-parse', ':a.txt'), request.expectedIndexEntries[0].oid);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'a.txt')), before); assert.deepEqual(fs.readFileSync(path.join(f.root, '.git', 'index')), normalIndex); assert.equal(git(f.root, 'log', '-1', '--format=%s'), request.message); assert.equal(f.events.length, 1);
});
test('reviewStaged binds exact normal-index OIDs, raw working hashes and the HEAD reference', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'staged\n'); git(f.root, 'add', '--', 'a.txt'); fs.appendFileSync(path.join(f.root, 'a.txt'), 'unstaged\n');
  const actual = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), expected = review(f, ['a.txt']);
  assert.equal(actual.expectedHead, expected.expectedHead); assert.equal(actual.expectedHeadRef, 'refs/heads/main'); assert.equal(actual.indexIdentity, expected.indexIdentity); assert.deepEqual(actual.expectedHashes, expected.expectedHashes); assert.deepEqual(actual.expectedIndexEntries, expected.expectedIndexEntries);
});
test('clean selection does not commit unrelated staged content', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'b.txt'), 'b staged\n'); git(f.root, 'add', '--', 'b.txt');
  const request = review(f, ['a.txt']), before = git(f.root, 'ls-files', '--stage', '-z'); const result = await f.product.commitStaged(f.entry, request);
  assert.equal(result.committed, false); assert.equal(result.reason, 'nothing-to-commit'); assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead); assert.equal(git(f.root, 'ls-files', '--stage', '-z'), before);
});
test('unborn selection creates a root commit and retains other staged files', async () => {
  const f = await fixture({ unborn: true }); git(f.root, 'add', '--', 'a.txt', 'b.txt'); const request = review(f, ['a.txt']), bOid = git(f.root, 'rev-parse', ':b.txt');
  const result = await f.product.commitStaged(f.entry, request); assert.equal(result.committed, true); assert.equal(git(f.root, 'rev-list', '--parents', '-1', 'HEAD'), result.sha);
  assert.equal(git(f.root, 'ls-tree', '--name-only', 'HEAD'), 'a.txt'); assert.equal(git(f.root, 'rev-parse', ':b.txt'), bOid);
});
test('detached commit refusal has a verified local-branch recovery without losing staged work', async () => {
  const f = await fixture(); git(f.root, 'switch', '--detach', 'HEAD'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'reviewed stage\n');
  const stage = review(f, ['a.txt']); await f.product.stage(f.entry, stage); const request = review(f, ['a.txt']);
  assert.equal(request.expectedHeadRef, null); await assert.rejects(f.product.commitStaged(f.entry, request), code('GIT_DETACHED_COMMIT_UNSUPPORTED'));
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead); assert.equal(git(f.root, 'show', ':a.txt'), 'reviewed stage');
  git(f.root, 'switch', '-c', 'reviewed-branch'); const result = await f.product.commitStaged(f.entry, review(f, ['a.txt']));
  assert.equal(result.committed, true); assert.equal(git(f.root, 'symbolic-ref', 'HEAD'), 'refs/heads/reviewed-branch'); assert.equal(git(f.root, 'show', 'HEAD:a.txt'), 'reviewed stage');
});
test('staged deletion commits absence while preserving resurrected unstaged bytes', async () => {
  const f = await fixture(); git(f.root, 'rm', '--', 'a.txt'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'resurrected dirty bytes\n');
  const result = await f.product.commitStaged(f.entry, review(f, ['a.txt'])); assert.equal(result.committed, true);
  assert.equal(git(f.root, 'ls-tree', '--name-only', 'HEAD', '--', 'a.txt'), ''); assert.equal(git(f.root, 'ls-files', '--', 'a.txt'), ''); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'resurrected dirty bytes\n');
});
test('staged rename sides and executable mode are committed exactly', async () => {
  const f = await fixture(); git(f.root, 'mv', '--', 'a.txt', '[renamed].txt'); git(f.root, 'update-index', '--chmod=+x', '--', '[renamed].txt'); fs.appendFileSync(path.join(f.root, '[renamed].txt'), 'unstaged\n');
  const request = review(f, ['a.txt', '[renamed].txt']); await f.product.commitStaged(f.entry, request);
  assert.equal(git(f.root, 'ls-tree', '--name-only', 'HEAD', '--', 'a.txt'), ''); assert.match(git(f.root, 'ls-tree', 'HEAD', '--', '[renamed].txt'), /^100755 blob /); assert.equal(git(f.root, 'show', 'HEAD:[renamed].txt'), 'a baseline'); assert.equal(fs.readFileSync(path.join(f.root, '[renamed].txt'), 'utf8'), 'a baseline\nunstaged\n');
});
test('changed working bytes, selected staged OID, full index and HEAD are rejected before ref effects', async () => {
  for (const kind of ['file', 'entry', 'index', 'head', 'branch']) {
    const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'a staged\n'); git(f.root, 'add', '--', 'a.txt'); const request = review(f, ['a.txt']);
    if (kind === 'file') fs.appendFileSync(path.join(f.root, 'a.txt'), 'concurrent\n');
    if (kind === 'entry') request.expectedIndexEntries[0].oid = '1'.repeat(40);
    if (kind === 'index') { fs.writeFileSync(path.join(f.root, 'b.txt'), 'b concurrent\n'); git(f.root, 'add', '--', 'b.txt'); }
    if (kind === 'head') git(f.root, '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'concurrent');
    if (kind === 'branch') { git(f.root, 'branch', 'other'); git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/other'); }
    const before = review(f, ['a.txt']), index = git(f.root, 'ls-files', '--stage', '-z');
    await assert.rejects(f.product.commitStaged(f.entry, request), code(kind === 'file' ? 'WORKSPACE_CONFLICT' : ['head', 'branch'].includes(kind) ? 'GIT_HEAD_CHANGED' : 'GIT_INDEX_CHANGED'));
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.expectedHead); assert.equal(git(f.root, 'ls-files', '--stage', '-z'), index); assert.equal(hash(f.root, 'a.txt'), before.expectedHashes['a.txt']);
  }
});
test('external index lock prevents commit and remains intact', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'staged\n'); git(f.root, 'add', '--', 'a.txt'); const request = review(f, ['a.txt']), lock = path.join(f.root, '.git', 'index.lock'); fs.writeFileSync(lock, 'external lock');
  await assert.rejects(f.product.commitStaged(f.entry, request), code('GIT_INDEX_BUSY')); assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead); assert.equal(fs.readFileSync(lock, 'utf8'), 'external lock');
});
test('failed ref CAS preserves normal index and reachable user history', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'staged\n'); git(f.root, 'add', '--', 'a.txt'); const request = review(f, ['a.txt']), index = git(f.root, 'ls-files', '--stage', '-z');
  const lock = path.join(f.root, '.git', 'refs', 'heads', 'main.lock'); fs.writeFileSync(lock, 'external ref lock');
  await assert.rejects(f.product.commitStaged(f.entry, request), code('GIT_REF_CHANGED')); assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead); assert.equal(git(f.root, 'ls-files', '--stage', '-z'), index); assert.equal(fs.readFileSync(lock, 'utf8'), 'external ref lock'); assert.equal(fs.existsSync(path.join(f.root, '.git', 'index.lock')), false);
});
test('HEAD advancement while the normal lock is held preserves the concurrent commit and staged index', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'a staged\n'); git(f.root, 'add', '--', 'a.txt');
  const request = review(f, ['a.txt']), index = fs.readFileSync(path.join(f.root, '.git', 'index'));
  const next = git(f.root, 'commit-tree', git(f.root, 'rev-parse', 'HEAD^{tree}'), '-p', request.expectedHead, '-m', 'concurrent user history');
  const race = raceOnEvent(path.join(f.root, '.git'), 'index.lock', () => git(f.root, 'update-ref', 'refs/heads/main', next, request.expectedHead));
  try { await assert.rejects(f.product.commitStaged(f.entry, request), code('GIT_HEAD_CHANGED')); await race.promise; }
  finally { race.close(); }
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), next); assert.deepEqual(fs.readFileSync(path.join(f.root, '.git', 'index')), index); assert.equal(git(f.root, 'show', ':a.txt'), 'a staged');
});
test('a HEAD switch during ref dispatch retains the approved-ref commit as unknown with an auditable recovery', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'a staged\n'); git(f.root, 'add', '--', 'a.txt'); git(f.root, 'branch', 'other');
  const request = review(f, ['a.txt']), index = fs.readFileSync(path.join(f.root, '.git', 'index'));
  // A real writer deliberately ignores Git's lock. The result must retain the
  // exact approved ref and SHA instead of claiming a no-effect failure.
  const race = raceOnEvent(path.join(f.root, '.git', 'refs', 'heads'), 'main.lock', () => fs.writeFileSync(path.join(f.root, '.git', 'HEAD'), 'ref: refs/heads/other\n'));
  let receipt;
  try { await assert.rejects(f.product.commitStaged(f.entry, request), error => { receipt = error; assert.equal(error.effectStatus, 'unknown'); assert.equal(error.code, 'GIT_OPERATION_REVIEW_REQUIRED'); return true; }); await race.promise; }
  finally { race.close(); }
  assert.equal(receipt.ref, 'refs/heads/main'); assert.match(receipt.sha, /^[a-f0-9]{40}$/); assert.equal(git(f.root, 'rev-parse', 'refs/heads/main'), receipt.sha); assert.equal(git(f.root, 'rev-parse', 'refs/heads/other'), request.expectedHead);
  assert.equal(git(f.root, 'rev-parse', receipt.sha + '^'), request.expectedHead); assert.equal(git(f.root, 'show', receipt.sha + ':a.txt'), 'a staged'); assert.deepEqual(fs.readFileSync(path.join(f.root, '.git', 'index')), index);
  assert.ok(f.events.some(event => event[2] === 'git.commit.staged' && event[3].includes('sha=' + receipt.sha) && event[3].includes('ref=refs/heads/main')));
  git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await assert.rejects(f.product.commitStaged(f.entry, request), code('GIT_HEAD_CHANGED'));
  const fresh = await f.product.commitStaged(f.entry, review(f, ['a.txt'])); assert.equal(fresh.committed, false); assert.equal(git(f.root, 'rev-parse', 'HEAD'), receipt.sha);
});
test('gitlink and symbolic index entries cannot be committed as regular files', async () => {
  for (const mode of ['160000', '120000']) {
    const f = await fixture(), oid = mode === '160000' ? review(f, ['a.txt']).expectedHead : git(f.root, 'rev-parse', 'HEAD:a.txt');
    git(f.root, 'update-index', '--add', '--cacheinfo', mode, oid, 'special');
    const request = review(f, ['special']); await assert.rejects(f.product.commitStaged(f.entry, request), code('GIT_PATH_INVALID')); assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead);
  }
});
test('configured hooks, signing and clean filters do not execute during approved stage or staged commit', async () => {
  const f = await fixture(), marker = path.join(f.base, 'unexpected-effect'), program = path.join(f.base, 'unexpected.cjs');
  fs.writeFileSync(program, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(19);`);
  const command = `node "${program.split(path.sep).join('/')}"`;
  git(f.root, 'config', 'filter.fixture.clean', command); git(f.root, 'config', 'filter.fixture.required', 'true'); git(f.root, 'config', 'commit.gpgSign', 'true'); git(f.root, 'config', 'gpg.program', program);
  const hooks = path.join(f.base, 'hooks'); fs.mkdirSync(hooks); fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\n${command}\n`, { mode: 0o755 }); git(f.root, 'config', 'core.hooksPath', hooks);
  fs.writeFileSync(path.join(f.root, '.gitattributes'), 'a.txt filter=fixture\n'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'reviewed bytes\n');
  f.expectedRepositoryIdentity = (await f.product.reviewStaged(f.entry, { paths: ['a.txt'] })).expectedRepositoryIdentity;
  await f.product.stage(f.entry, review(f, ['a.txt'])); await f.product.commitStaged(f.entry, review(f, ['a.txt']));
  assert.equal(fs.existsSync(marker), false); assert.equal(git(f.root, 'show', 'HEAD:a.txt'), 'reviewed bytes');
});
async function heldCleanupFixture(action, { receiptFailure = false } = {}) {
  if (process.platform !== 'win32') { console.log('NOT_RUN_ENVIRONMENT Windows FileShare.None cleanup fixture'); return; }
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'reviewed effect\n'); if (action === 'commitStaged') git(f.root, 'add', '--', 'a.txt');
  const request = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), originalMkdtemp = fs.mkdtempSync;
  let temporary, temporaryStat, lockerExited, lockerCode;
  const release = path.join(f.base, 'release-locker'), ready = path.join(f.base, 'locker-ready');
  fs.mkdtempSync = (...args) => { const actual = originalMkdtemp(...args); if (String(args[0]).includes('cm-git-approved-index-')) { temporary = actual; temporaryStat = fs.lstatSync(actual); } return actual; };
  const events = [], product = createGitProduct({ stateDir: f.base, registry: { list: () => [] }, record: (...args) => {
    events.push(args); if (!temporary || !['git.stage', 'git.commit.staged'].includes(args[2])) return;
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = `$s=[System.IO.File]::Open(${quote(path.join(temporary, 'held.bin'))},[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); [System.IO.File]::WriteAllText(${quote(ready)},'ready'); $deadline=[DateTime]::UtcNow.AddSeconds(20); while(-not [System.IO.File]::Exists(${quote(release)}) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 25}; $s.Dispose();`;
    const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: 'ignore' });
    lockerExited = new Promise(resolve => locker.once('close', exitCode => { lockerCode = exitCode; resolve(); }));
    const deadline = Date.now() + 6000; while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    assert.equal(fs.existsSync(ready), true, 'owned hidden Windows locker must hold the actual cleanup file');
    if (receiptFailure) throw new Error('fixture Workspace receipt failure after CAS');
  } });
  let result, error;
  try { result = await product[action](f.entry, { ...request, message: 'held cleanup effect' }); }
  catch (failure) { error = failure; }
  finally {
    fs.mkdtempSync = originalMkdtemp; if (lockerExited) { fs.writeFileSync(release, 'release'); await lockerExited; }
  }
  try {
    assert.equal(lockerCode, 0); assert.ok(temporary); assert.equal(fs.existsSync(temporary), true, 'held owned resource must be retained for cleanup');
    if (receiptFailure) { assert.equal(error?.code, 'GIT_AUDIT_REVIEW_REQUIRED'); assert.equal(error?.effectStatus, 'unknown'); assert.match(error?.sha, /^[a-f0-9]{40}$/); assert.equal(error?.ref, 'refs/heads/main'); assert.equal(error.cleanupPending, true); }
    else { assert.equal(error, undefined, 'temporary cleanup must not replace a known successful effect'); assert.equal(result[action === 'stage' ? 'staged' : 'committed'], true); assert.equal(result.cleanupPending, true); }
    const sha = result?.sha ?? error?.sha;
    if (action === 'commitStaged') { assert.equal(git(f.root, 'rev-parse', 'HEAD'), sha); assert.equal(git(f.root, 'show', sha + ':a.txt'), 'reviewed effect'); }
    else { assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead); assert.equal(git(f.root, 'show', ':a.txt'), 'reviewed effect'); }
    assert.ok(events.some(event => event[2] === 'git.cleanup.pending'));
  } finally {
    if (temporary) {
      const current = fs.lstatSync(temporary); assert.equal(current.dev, temporaryStat.dev); assert.equal(current.ino, temporaryStat.ino); assert.equal(current.isSymbolicLink(), false);
      assert.equal(path.dirname(path.resolve(temporary)), fs.realpathSync.native(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('cm-git-approved-index-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
test('known stage success survives actual Windows temporary cleanup failure', () => heldCleanupFixture('stage'));
test('known commit success survives actual Windows temporary cleanup failure', () => heldCleanupFixture('commitStaged'));
test('existing unknown commit receipt survives actual Windows temporary cleanup failure', () => heldCleanupFixture('commitStaged', { receiptFailure: true }));

let failed = 0;
try { for (const { name, run } of cases) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } } }
finally { for (const root of fixtures) fs.rmSync(root, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
else console.log(`Git staged commit: ${cases.length} PASS`);
