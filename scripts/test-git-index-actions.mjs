import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createGitProduct } from '../src/workspace/git-product.js';
import { createWorkspaceRegistry } from '../src/workspace/registry.js';
import { createTaskRuntime } from '../src/task/runtime.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env }; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const cases = [], fixtures = [];
const test = (name, run) => cases.push({ name, run });
const git = (root, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const hash = (root, rel) => { try { return digest(fs.readFileSync(path.join(root, rel))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function fixture({ unborn = false } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-index-actions-'))); fixtures.push(base);
  const root = path.join(base, 'repo'); fs.mkdirSync(root); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'CetaMesh fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a baseline\n'); fs.writeFileSync(path.join(root, 'b.txt'), 'b baseline\n');
  if (!unborn) { git(root, 'add', '--', 'a.txt', 'b.txt'); git(root, '-c', 'commit.gpgSign=false', 'commit', '-m', 'baseline'); }
  const entry = { id: path.basename(base), root }, events = [];
  const product = createGitProduct({ stateDir: base, registry: { list: () => [] }, record: (...args) => events.push(args) });
  const result = { base, root, entry, product, events };
  result.expectedRepositoryIdentity = (await product.reviewStaged(entry, { paths: ['a.txt'] })).expectedRepositoryIdentity;
  return result;
}
function review(f, paths) {
  let expectedHead = null; try { expectedHead = git(f.root, 'rev-parse', '--verify', 'HEAD'); } catch {}
  let expectedHeadRef = null; try { expectedHeadRef = git(f.root, 'symbolic-ref', '-q', 'HEAD'); } catch {}
  const index = path.resolve(f.root, git(f.root, 'rev-parse', '--git-path', 'index'));
  return { paths, expectedHead, expectedHeadRef, expectedRepositoryIdentity: f.expectedRepositoryIdentity, expectedHashes: Object.fromEntries(paths.map(rel => [rel, hash(f.root, rel)])), indexIdentity: fs.existsSync(index) ? digest(fs.readFileSync(index)) : null };
}
const indexEntries = f => git(f.root, 'ls-files', '--stage', '-z');
const code = wanted => error => { assert.equal(error.code, wanted, error.message); return true; };
function raceOnLock(f, mutate) {
  const dir = path.resolve(f.root, git(f.root, 'rev-parse', '--git-dir'));
  let done = false, timer, watch;
  const promise = new Promise((resolve, reject) => {
    watch = fs.watch(dir, () => {
      if (done || !fs.existsSync(path.join(dir, 'index.lock'))) return;
      done = true; clearTimeout(timer); watch.close();
      try { mutate(dir); resolve(); } catch (error) { reject(error); }
    });
    timer = setTimeout(() => { watch.close(); reject(new Error('Real Git index lock was not observed')); }, 10000);
  });
  return { promise, close: () => { clearTimeout(timer); watch.close(); } };
}

// These cases catch index-wide add/reset, loss of an unrelated staged entry,
// and staging a different working-tree revision from the reviewed bytes.
test('stage and unstage selected files preserve unrelated stage and working bytes', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'a changed\n'); fs.writeFileSync(path.join(f.root, 'b.txt'), 'b staged\n'); git(f.root, 'add', '--', 'b.txt');
  assert.equal(typeof f.product.stage, 'function', 'G1 stage must exist on the existing Git product');
  const before = review(f, ['a.txt']), bOid = git(f.root, 'rev-parse', ':b.txt');
  const result = await f.product.stage(f.entry, before, 'fixture-owner');
  assert.equal(result.staged, true); assert.equal(git(f.root, 'show', ':a.txt'), 'a changed'); assert.equal(git(f.root, 'rev-parse', ':b.txt'), bOid);
  assert.equal(hash(f.root, 'a.txt'), before.expectedHashes['a.txt']); assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.expectedHead);
  const unstage = await f.product.unstage(f.entry, review(f, ['a.txt']), 'fixture-owner');
  assert.equal(unstage.unstaged, true); assert.equal(git(f.root, 'show', ':a.txt'), 'a baseline'); assert.equal(git(f.root, 'rev-parse', ':b.txt'), bOid);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'a changed\n'); assert.equal(f.events.length, 2);
});
test('unborn stage and unstage retain the files without inventing HEAD', async () => {
  const f = await fixture({ unborn: true }); await f.product.stage(f.entry, review(f, ['a.txt']));
  assert.equal(git(f.root, 'show', ':a.txt'), 'a baseline'); await f.product.unstage(f.entry, review(f, ['a.txt']));
  assert.equal(indexEntries(f), ''); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'a baseline\n'); assert.equal(review(f, ['a.txt']).expectedHead, null);
});
test('deletion and explicit rename sides can stage and unstage without touching files', async () => {
  const f = await fixture(); fs.renameSync(path.join(f.root, 'a.txt'), path.join(f.root, 'renamed.txt'));
  await f.product.stage(f.entry, review(f, ['a.txt', 'renamed.txt']));
  assert.equal(git(f.root, 'ls-files', '--', 'a.txt'), ''); assert.equal(git(f.root, 'show', ':renamed.txt'), 'a baseline');
  await f.product.unstage(f.entry, review(f, ['a.txt', 'renamed.txt']));
  assert.equal(git(f.root, 'show', ':a.txt'), 'a baseline'); assert.equal(git(f.root, 'ls-files', '--', 'renamed.txt'), ''); assert.equal(fs.existsSync(path.join(f.root, 'a.txt')), false);
});
test('literal metacharacters select only the named file', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, '[x].txt'), 'literal\n'); fs.writeFileSync(path.join(f.root, 'x.txt'), 'neighbor\n'); fs.writeFileSync(path.join(f.root, '--option.txt'), 'dash\n');
  await f.product.stage(f.entry, review(f, ['[x].txt', '--option.txt']));
  assert.equal(git(f.root, 'show', ':[x].txt'), 'literal'); assert.equal(git(f.root, 'show', ':--option.txt'), 'dash'); assert.equal(git(f.root, 'ls-files', '--', 'x.txt'), '');
});
test('stage rehashes reviewed same-sized bytes even when Git cached file timestamps match', async () => {
  const f = await fixture(); git(f.root, 'config', 'core.trustctime', 'false');
  f.expectedRepositoryIdentity = (await f.product.reviewStaged(f.entry, { paths: ['a.txt'] })).expectedRepositoryIdentity;
  const file = path.join(f.root, 'a.txt'); fs.utimesSync(file, 1000000000, 1000000000); git(f.root, 'add', '--', 'a.txt');
  const oldOid = git(f.root, 'rev-parse', ':a.txt'); fs.writeFileSync(file, 'a reviewed\n'); fs.utimesSync(file, 1000000000, 1000000000);
  const wanted = git(f.root, 'hash-object', '--path', 'a.txt', '--', 'a.txt'); assert.notEqual(wanted, oldOid);
  await f.product.stage(f.entry, review(f, ['a.txt']));
  assert.equal(git(f.root, 'rev-parse', ':a.txt'), wanted); assert.equal(git(f.root, 'show', ':a.txt'), 'a reviewed'); assert.equal(fs.readFileSync(file, 'utf8'), 'a reviewed\n');
});
test('changed file, index, HEAD and same-OID branch are rejected with all existing state retained', async () => {
  for (const kind of ['file', 'index', 'head', 'branch']) {
    const f = await fixture(), request = review(f, ['a.txt']);
    if (kind === 'file') fs.writeFileSync(path.join(f.root, 'a.txt'), 'new bytes\n');
    if (kind === 'index') { fs.writeFileSync(path.join(f.root, 'b.txt'), 'new stage\n'); git(f.root, 'add', '--', 'b.txt'); }
    if (kind === 'head') git(f.root, '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'concurrent');
    if (kind === 'branch') { git(f.root, 'branch', 'other'); git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/other'); }
    const index = indexEntries(f), current = review(f, ['a.txt']);
    await assert.rejects(f.product.stage(f.entry, request), code(kind === 'file' ? 'WORKSPACE_CONFLICT' : kind === 'index' ? 'GIT_INDEX_CHANGED' : 'GIT_HEAD_CHANGED'));
    assert.equal(indexEntries(f), index); assert.equal(review(f, ['a.txt']).expectedHead, current.expectedHead); assert.equal(hash(f.root, 'a.txt'), current.expectedHashes['a.txt']);
  }
});
test('preexisting normal index lock is never removed or rewritten', async () => {
  const f = await fixture(), request = review(f, ['a.txt']), index = indexEntries(f), lock = path.join(f.root, '.git', 'index.lock'); fs.writeFileSync(lock, 'external owner');
  await assert.rejects(f.product.stage(f.entry, request), code('GIT_INDEX_BUSY'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'external owner'); assert.equal(indexEntries(f), index);
});
test('file change while the owned normal lock is held is refused before replacing index', async () => {
  const f = await fixture(), request = review(f, ['a.txt']), index = indexEntries(f);
  const race = raceOnLock(f, () => fs.writeFileSync(path.join(f.root, 'a.txt'), 'concurrent dirty bytes\n'));
  try { await assert.rejects(f.product.stage(f.entry, request), code('WORKSPACE_CONFLICT')); await race.promise; }
  finally { race.close(); }
  assert.equal(indexEntries(f), index); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'concurrent dirty bytes\n'); assert.equal(fs.existsSync(path.join(f.root, '.git', 'index.lock')), false);
});
test('a substituted index lock remains owned by the external writer', async () => {
  const f = await fixture(), request = review(f, ['a.txt']), index = indexEntries(f);
  const race = raceOnLock(f, dir => { fs.renameSync(path.join(dir, 'index.lock'), path.join(dir, 'index.owned-backup')); fs.writeFileSync(path.join(dir, 'index.lock'), 'replacement owner'); });
  try { await assert.rejects(f.product.stage(f.entry, request), code('GIT_INDEX_BUSY')); await race.promise; }
  finally { race.close(); }
  assert.equal(fs.readFileSync(path.join(f.root, '.git', 'index.lock'), 'utf8'), 'replacement owner'); assert.equal(indexEntries(f), index);
});
test('index replacement during dispatch is refused and the concurrent staged contents survive', async () => {
  const f = await fixture(), indexPath = path.join(f.root, '.git', 'index'), original = fs.readFileSync(indexPath);
  fs.writeFileSync(path.join(f.root, 'b.txt'), 'concurrent stage\n'); git(f.root, 'add', '--', 'b.txt');
  const concurrent = fs.readFileSync(indexPath), concurrentEntries = indexEntries(f); fs.writeFileSync(indexPath, original);
  const request = review(f, ['a.txt']), race = raceOnLock(f, () => fs.writeFileSync(indexPath, concurrent));
  try { await assert.rejects(f.product.stage(f.entry, request), code('GIT_INDEX_CHANGED')); await race.promise; }
  finally { race.close(); }
  assert.equal(indexEntries(f), concurrentEntries); assert.equal(fs.readFileSync(path.join(f.root, 'b.txt'), 'utf8'), 'concurrent stage\n');
});
test('concurrent approved stage attempts have one normal-index writer', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'a reviewed\n'); fs.writeFileSync(path.join(f.root, 'b.txt'), 'b reviewed\n');
  const results = await Promise.allSettled([f.product.stage(f.entry, review(f, ['a.txt'])), f.product.stage(f.entry, review(f, ['b.txt']))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected'); assert.ok(['GIT_INDEX_BUSY', 'GIT_INDEX_CHANGED'].includes(refused.reason.code));
  const contents = [git(f.root, 'show', ':a.txt'), git(f.root, 'show', ':b.txt')];
  assert.deepEqual(contents, results[0].status === 'fulfilled' ? ['a reviewed', 'b baseline'] : ['a baseline', 'b reviewed']);
});
test('directories, parent scope, sensitive files, linked ancestors, nested repositories and gitlinks cannot expand scope', async () => {
  const f = await fixture(); fs.mkdirSync(path.join(f.root, 'sub')); fs.writeFileSync(path.join(f.root, 'sub', 'inside.txt'), 'inside'); fs.writeFileSync(path.join(f.root, '.env'), 'fixture secret');
  const cases = [['sub', 'GIT_PATH_INVALID'], ['../outside', 'GIT_PATH_INVALID'], ['.env', 'SENSITIVE_RESOURCE']];
  for (const [rel, expected] of cases) {
    const request = { ...review(f, ['a.txt']), paths: [rel], expectedHashes: { [rel]: null } };
    await assert.rejects(f.product.stage(f.entry, request), code(expected));
  }
  await assert.rejects(f.product.stage({ ...f.entry, root: path.join(f.root, 'sub') }, review(f, ['a.txt'])), code('GIT_ROOT_REQUIRED'));
  const rootAlias = path.join(f.base, 'substituted-root'); fs.symlinkSync(f.root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.product.stage({ ...f.entry, root: rootAlias }, review(f, ['a.txt'])), code('GIT_ROOT_REQUIRED'));
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'file.txt'), 'outside'); fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.product.stage(f.entry, review(f, ['linked/file.txt'])), code('GIT_PATH_INVALID'));
  fs.mkdirSync(path.join(f.root, 'nested')); git(path.join(f.root, 'nested'), 'init'); fs.writeFileSync(path.join(f.root, 'nested', 'file.txt'), 'nested');
  await assert.rejects(f.product.stage(f.entry, review(f, ['nested/file.txt'])), code('GIT_PATH_INVALID'));
  git(f.root, 'update-index', '--add', '--cacheinfo', '160000', review(f, ['a.txt']).expectedHead, 'vendor');
  await assert.rejects(f.product.stage(f.entry, review(f, ['vendor'])), code('GIT_PATH_INVALID'));
});
test('approval requires an exact hash map, index digest and explicit HEAD reference', async () => {
  const f = await fixture(), baseline = review(f, ['a.txt']);
  for (const request of [{ ...baseline, indexIdentity: undefined }, { ...baseline, expectedHeadRef: undefined }, { ...baseline, expectedRepositoryIdentity: undefined }, { ...baseline, expectedHashes: { ...baseline.expectedHashes, 'b.txt': hash(f.root, 'b.txt') } }, { ...baseline, paths: ['a.txt', 'a.txt'] }]) {
    await assert.rejects(f.product.stage(f.entry, request), error => ['GIT_INDEX_REQUIRED', 'GIT_HEAD_REQUIRED', 'GIT_REPOSITORY_REQUIRED', 'GIT_HASHES_REQUIRED', 'GIT_PATH_INVALID'].includes(error.code));
  }
  await assert.rejects(f.product.stage(f.entry, { ...baseline, expectedRepositoryIdentity: '0'.repeat(64) }), code('GIT_REPOSITORY_CHANGED'));
});
for (const pivot of ['gitfile', 'commondir']) for (const action of ['stage', 'unstage', 'commitStaged']) {
  test(`review metadata ownership rejects ${pivot} substitution before ${action}`, async () => {
    const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'approved staged bytes\n'); git(f.root, 'add', '--', 'a.txt');
    const request = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), other = path.join(f.base, 'unregistered'); fs.mkdirSync(other);
    const external = path.join(other, '.git'); fs.cpSync(path.join(f.root, '.git'), external, { recursive: true }); fs.writeFileSync(path.join(other, 'a.txt'), 'external working bytes\n');
    let original = path.join(f.root, '.git');
    if (pivot === 'gitfile') { original = path.join(f.base, 'original-metadata'); fs.renameSync(path.join(f.root, '.git'), original); fs.writeFileSync(path.join(f.root, '.git'), `gitdir: ${external.split(path.sep).join('/')}\n`); }
    else fs.writeFileSync(path.join(original, 'commondir'), external.split(path.sep).join('/') + '\n');
    const originalIndex = fs.readFileSync(path.join(original, 'index')), externalIndex = fs.readFileSync(path.join(external, 'index'));
    const originalRef = fs.readFileSync(path.join(original, 'refs', 'heads', 'main')), externalRef = fs.readFileSync(path.join(external, 'refs', 'heads', 'main'));
    await assert.rejects(f.product[action](f.entry, { ...request, message: 'reviewed staged commit' }), error => ['GIT_REPOSITORY_CHANGED', 'GIT_REPOSITORY_UNVERIFIED'].includes(error.code));
    assert.deepEqual(fs.readFileSync(path.join(original, 'index')), originalIndex); assert.deepEqual(fs.readFileSync(path.join(external, 'index')), externalIndex);
    assert.deepEqual(fs.readFileSync(path.join(original, 'refs', 'heads', 'main')), originalRef); assert.deepEqual(fs.readFileSync(path.join(external, 'refs', 'heads', 'main')), externalRef);
    assert.equal(fs.readFileSync(path.join(other, 'a.txt'), 'utf8'), 'external working bytes\n');
    if (pivot === 'gitfile') { fs.unlinkSync(path.join(f.root, '.git')); fs.renameSync(original, path.join(f.root, '.git')); }
    else fs.unlinkSync(path.join(original, 'commondir'));
    // Once the proven original relation is restored, a fresh ordinary review
    // can stage/unstage or commit through the same existing product object.
    const fresh = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] });
    const recovered = await f.product[action](f.entry, { ...fresh, message: 'recovered reviewed commit' });
    assert.equal(recovered[action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : 'committed'], true);
  });
}
test('registered managed linked worktree retains its legal common metadata relation through stage unstage and commit', async () => {
  const f = await fixture(), stateDir = path.join(f.base, 'state'), registry = createWorkspaceRegistry({ file: path.join(stateDir, 'workspaces.json') }), tasks = createTaskRuntime({ stateDir });
  const source = registry.create({ name: 'source', root: f.root }), task = tasks.create({ goal: 'managed worktree G1 fixture', workspaceId: source.id });
  const product = createGitProduct({ stateDir, registry, getTask: id => tasks.get({ id }).task });
  const created = await product.create(source, { taskId: task.id, branch: 'codex/g1-managed', expectedHead: git(f.root, 'rev-parse', 'HEAD') }, { worktree: true });
  const entry = registry.get(created.workspace.id), oldParent = git(f.root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(entry.root, 'a.txt'), 'managed bytes\n');
  await product.stage(entry, await product.reviewStaged(entry, { paths: ['a.txt'] }));
  await product.unstage(entry, await product.reviewStaged(entry, { paths: ['a.txt'] }));
  assert.equal(git(entry.root, 'show', ':a.txt'), 'a baseline');
  await product.stage(entry, await product.reviewStaged(entry, { paths: ['a.txt'] }));
  const request = await product.reviewStaged(entry, { paths: ['a.txt'] }), result = await product.commitStaged(entry, { ...request, message: 'managed exact stage' });
  assert.equal(result.committed, true); assert.match(request.expectedRepositoryIdentity, /^[a-f0-9]{64}$/); assert.equal(git(entry.root, 'show', 'HEAD:a.txt'), 'managed bytes');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), oldParent); assert.equal(git(entry.root, 'rev-parse', 'HEAD^'), oldParent);
});
test('review identity rejects a replacement metadata directory at the same canonical path', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'reviewed stage\n'); git(f.root, 'add', '--', 'a.txt');
  const request = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), original = path.join(f.base, 'original-metadata'), copy = path.join(f.base, 'copied-metadata');
  fs.cpSync(path.join(f.root, '.git'), copy, { recursive: true }); fs.renameSync(path.join(f.root, '.git'), original); fs.renameSync(copy, path.join(f.root, '.git'));
  const before = fs.readFileSync(path.join(f.root, '.git', 'index'));
  await assert.rejects(f.product.commitStaged(f.entry, { ...request, message: 'stale metadata identity' }), code('GIT_REPOSITORY_CHANGED'));
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), request.expectedHead); assert.deepEqual(fs.readFileSync(path.join(f.root, '.git', 'index')), before);
  const fresh = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }); assert.notEqual(fresh.expectedRepositoryIdentity, request.expectedRepositoryIdentity);
  assert.equal((await f.product.commitStaged(f.entry, { ...fresh, message: 'new metadata reviewed' })).committed, true);
  assert.equal(fs.readFileSync(path.join(original, 'refs', 'heads', 'main'), 'utf8').trim(), request.expectedHead);
});
test('preexisting custom ref-storage URI is refused without migrating or modifying either store', async () => {
  const f = await fixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'approved staged bytes\n'); git(f.root, 'add', '--', 'a.txt');
  const request = await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), common = path.join(f.root, '.git'), alternate = path.join(f.base, 'custom-ref-store');
  fs.cpSync(common, alternate, { recursive: true });
  const config = path.join(common, 'config'), saved = fs.readFileSync(config), index = fs.readFileSync(path.join(common, 'index')), originalRef = fs.readFileSync(path.join(common, 'refs', 'heads', 'main'));
  fs.appendFileSync(config, `\n[core]\n repositoryformatversion = 1\n[extensions]\n refStorage = files://${alternate.split(path.sep).join('/')}\n`);
  await assert.rejects(f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), code('GIT_REPOSITORY_UNVERIFIED'));
  await assert.rejects(f.product.commitStaged(f.entry, { ...request, message: 'unowned custom backend' }), code('GIT_REPOSITORY_UNVERIFIED'));
  assert.deepEqual(fs.readFileSync(path.join(common, 'index')), index); assert.deepEqual(fs.readFileSync(path.join(common, 'refs', 'heads', 'main')), originalRef); assert.deepEqual(fs.readFileSync(path.join(alternate, 'refs', 'heads', 'main')), originalRef);
  assert.ok(fs.readFileSync(config, 'utf8').includes('refStorage = files://'), 'refusal must retain existing custom metadata configuration');
  // This fixture knows the exact original relation; production does not
  // silently rewrite an unfamiliar ref-store configuration to make it pass.
  fs.writeFileSync(config, saved);
  assert.equal((await f.product.commitStaged(f.entry, { ...await f.product.reviewStaged(f.entry, { paths: ['a.txt'] }), message: 'original relation independently restored' })).committed, true);
  assert.deepEqual(fs.readFileSync(path.join(alternate, 'refs', 'heads', 'main')), originalRef);
});

let failed = 0;
try { for (const { name, run } of cases) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } } }
finally { for (const root of fixtures) fs.rmSync(root, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
else console.log(`Git index actions: ${cases.length} PASS`);
