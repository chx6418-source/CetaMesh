import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createGitProduct } from '../src/workspace/git-product.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { gitRun } from '../src/workspace/tools.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-observation-')));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), ...args], { cwd, env, windowsHide: true, encoding: 'utf8' }).trim();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let failed = 0;
async function check(name, run) { try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } }
function fixture(name) {
  const project = path.join(root, name); fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main'); git(project, 'config', 'core.autocrlf', 'false');
  git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(project, 'a.txt'), `revision ${i}\n`); git(project, 'add', '--', 'a.txt'); git(project, 'commit', '-qm', `commit ${i}`); }
  return { id: `ws-${name}`, root: project };
}
const product = createGitProduct({ stateDir: path.join(root, 'state'), registry: { list: () => [] } });
try {
  const a = fixture('a'), b = fixture('b');
  await check('trusted native reference backend override routes the ref CAS to its approved physical repository', async () => {
    const gitDir = git(a.root, 'rev-parse', '--absolute-git-dir');
    const repository = { gitDir, commonDir: gitDir, workTree: a.root };
    const pinned = await gitRun(b.root, ['rev-parse', '--absolute-git-dir'], { repository });
    assert.equal(fs.realpathSync.native(pinned.stdout.trim()), fs.realpathSync.native(gitDir));
    assert.equal(fs.realpathSync.native((await gitRun(b.root, ['rev-parse', '--show-toplevel'], { repository })).stdout.trim()), a.root);
    await assert.rejects(gitRun(a.root, ['rev-parse', 'HEAD'], { repository: { ...repository, commonDir: '.' } }), { code: 'GIT_REPOSITORY_INVALID' });
    await assert.rejects(gitRun(a.root, ['rev-parse', 'HEAD'], { repository: { ...repository, arbitraryEnv: 'not accepted' } }), { code: 'GIT_REPOSITORY_INVALID' });
    await assert.rejects(gitRun(a.root, ['rev-parse', 'HEAD'], { repository, referenceBackend: { format: 'unreviewed', root: gitDir } }), { code: 'GIT_REFERENCE_BACKEND_INVALID' });
    await assert.rejects(gitRun(a.root, ['rev-parse', 'HEAD'], { repository, referenceBackend: { format: 'files', root: path.join(root, 'other') } }), { code: 'GIT_REFERENCE_BACKEND_INVALID' });
    const source = fixture('pin-source'), sourceMetadata = path.join(source.root, '.git');
    const alternateMetadata = path.join(root, 'pin-alternate-metadata');
    fs.cpSync(sourceMetadata, alternateMetadata, { recursive: true, errorOnExist: true });
    const head = git(source.root, 'rev-parse', 'HEAD'), ref = 'refs/heads/pin-proof';
    fs.writeFileSync(path.join(sourceMetadata, 'commondir'), alternateMetadata + '\n');
    try {
      await gitRun(source.root, ['update-ref', ref, head, '0'.repeat(40)], {
        // Native refs backends reread gitDir/commondir independently of the
        // environment projection. This exact internal backend overrides that.
        repository: { gitDir: sourceMetadata, commonDir: sourceMetadata, workTree: source.root },
        referenceBackend: { format: 'files', root: sourceMetadata }
      });
      // Read the physical repositories independently of the marker and support
      // both the native files and reftable ref storage formats.
      fs.rmSync(path.join(sourceMetadata, 'commondir'));
      assert.equal(git(source.root, 'rev-parse', '--verify', ref), head,
        'the approved physical common directory receives the exact ref CAS');
      const alternateRef = git(source.root, '--git-dir=' + alternateMetadata, 'for-each-ref', '--format=%(objectname)', ref);
      assert.equal(alternateRef, '',
        'a changed commondir marker cannot redirect the pinned ref write');
    } finally {
      fs.rmSync(path.join(sourceMetadata, 'commondir'), { force: true });
    }
  });
  await check('the existing Git executor accepts bounded literal stdin and closes it before completion', async () => {
    const input = 'synthetic stdin bytes\n';
    const expected = crypto.createHash('sha1').update(Buffer.from('blob ' + Buffer.byteLength(input) + '\0')).update(input).digest('hex');
    assert.equal((await gitRun(a.root, ['hash-object', '--stdin'], { input, timeoutMs: 1000 })).stdout.trim(), expected);
    await assert.rejects(gitRun(a.root, ['hash-object', '--stdin'], { input: 'x'.repeat(65537) }), { code: 'GIT_INPUT_INVALID' });
    await assert.rejects(gitRun(a.root, ['hash-object', '--stdin'], { input: { text: 'not a string' } }), { code: 'GIT_INPUT_INVALID' });
  });
  await check('Owner Core exposes actual paged Git observations and keeps cancellation scoped to the request', async () => {
    const service = createWorkspaceService({ stateDir: path.join(root, 'owner-state') });
    const registered = await service.execute({ method: 'workspace.create', params: { root: a.root, name: 'Git observations' } });
    const ui = createDesktopUiService({ services: { workspaceService: service } });
    const call = (action, input = {}, context) => ui.execute({ method: 'ui.workspace.git.' + action, params: { id: registered.workspace.id, ...input }, ...context });
    const history = await call('history', { limit: 2 });
    assert.equal(history.entries.length, 2); assert.ok(history.nextCursor);
    const status = await call('status.page', { limit: 3 });
    assert.equal(status.totalKnown, 0);
    const branches = await call('branches', { limit: 1 }); assert.equal(branches.entries[0].name, 'main');
    const commit = await call('commit.detail', { sha: history.entries[0].sha }); assert.ok(JSON.stringify(commit).includes('commit 5'));
    const preview = await call('preview', { path: 'a.txt', maxBytes: 256 }); assert.match(JSON.stringify(preview), /revision 5/);
    const review = await call('review', { paths: ['a.txt'] }); assert.equal(review.expectedHashes['a.txt'], hash(fs.readFileSync(path.join(a.root, 'a.txt'))));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(call('history', {}, { signal: controller.signal }), error => /ABORT|CANCEL/.test(error.code ?? error.name));
    assert.equal((await call('history', { limit: 1 })).entries.length, 1, 'cancelling one observation does not disable the Workspace');
  });
  await check('history uses real anchored pages without duplicates after a newer commit', async () => {
    const first = await product.history(a, { limit: 2 });
    assert.equal(first.entries.length, 2); assert.ok(first.nextCursor); assert.equal(first.anchorHead, git(a.root, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(a.root, 'a.txt'), 'new head\n'); git(a.root, 'commit', '-qam', 'new commit');
    const second = await product.history(a, { limit: 2, cursor: first.nextCursor });
    const third = await product.history(a, { limit: 2, cursor: second.nextCursor });
    assert.equal(second.anchorHead, first.anchorHead); assert.equal(third.nextCursor, null);
    const entries = [...first.entries, ...second.entries, ...third.entries];
    assert.equal(new Set(entries.map(row => row.sha)).size, 6); assert.equal(entries.at(-1).subject, 'commit 0');
    assert.ok(first.observation.elapsedMs >= 0); assert.ok(first.observation.outputBytes > 0);
    await assert.rejects(product.history(b, { cursor: first.nextCursor }), { code: 'GIT_CURSOR_MISMATCH' });
    await assert.rejects(product.history(a, { cursor: 'untrusted-not-a-cursor' }), { code: 'GIT_CURSOR_INVALID' });
  });
  await check('status pages bind source and listing snapshot and do not eagerly hash every changed file', async () => {
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(a.root, `loose-${i}.txt`), `loose ${i}`);
    const first = await product.status(a, { limit: 3 });
    assert.equal(first.entries.length, 3); assert.equal(first.totalKnown, 7); assert.ok(first.nextCursor);
    assert.ok(first.entries.every(row => !Object.hasOwn(row, 'sha256')), 'overview must not synchronously read all changed content');
    const next = await product.status(a, { limit: 3, cursor: first.nextCursor }); assert.equal(next.snapshotId, first.snapshotId);
    await assert.rejects(product.status(b, { cursor: first.nextCursor }), { code: 'GIT_CURSOR_MISMATCH' });
    fs.writeFileSync(path.join(a.root, 'another.txt'), 'changes snapshot');
    await assert.rejects(product.status(a, { cursor: first.nextCursor }), { code: 'GIT_SNAPSHOT_CHANGED' });
  });
  await check('commit detail and untracked preview use actual bytes and bounded truthful results', async () => {
    const sha = git(a.root, 'rev-parse', 'HEAD');
    const detail = await product.commitDetail(a, { sha });
    assert.equal(detail.sha, sha); assert.equal(detail.subject, 'new commit'); assert.ok(detail.files.some(row => row.path === 'a.txt'));
    assert.match(detail.patch, /new head/);
    const preview = await product.preview(a, { path: 'loose-1.txt', maxBytes: 5 });
    assert.equal(preview.content, 'loose'); assert.equal(preview.truncated, true); assert.equal(preview.nextOffset, 5);
    await assert.rejects(product.preview(a, { path: '../b/a.txt' }));
    fs.writeFileSync(path.join(a.root, '.env'), 'PRIVATE_KEY=value');
    await assert.rejects(product.preview(a, { path: '.env' }), { code: 'SENSITIVE_RESOURCE' });
    await assert.rejects(product.commitDetail(a, { sha: '--all' }), { code: 'GIT_COMMIT_INVALID' });
  });
  await check('explicit selected paths are reviewed asynchronously against exact file and index identities', async () => {
    const review = await product.reviewPaths(a, { paths: ['loose-2.txt'] });
    assert.equal(review.headSha, git(a.root, 'rev-parse', 'HEAD'));
    assert.equal(review.expectedHashes['loose-2.txt'], hash(fs.readFileSync(path.join(a.root, 'loose-2.txt'))));
    assert.match(review.indexIdentity, /^[a-f0-9]{64}$/); assert.deepEqual(review.paths, ['loose-2.txt']);
    await assert.rejects(product.reviewPaths(a, { paths: ['loose-2.txt', 'loose-2.txt'] }), { code: 'GIT_PATH_INVALID' });
    await assert.rejects(product.reviewPaths(a, { paths: ['.env'] }), { code: 'SENSITIVE_RESOURCE' });
  });
  await check('present literal prototype-named files retain own hashes in serialized review evidence', async () => {
    const paths = ['__proto__', 'constructor', 'toString'];
    const content = Buffer.from('literal path key\n');
    for (const rel of paths) fs.writeFileSync(path.join(a.root, rel), content);
    const review = await product.reviewPaths(a, { paths });
    assert.deepEqual(review.paths, paths);
    for (const evidence of [review.expectedHashes, JSON.parse(JSON.stringify(review)).expectedHashes]) {
      assert.deepEqual(Object.keys(evidence), paths);
      for (const rel of paths) {
        assert.equal(Object.hasOwn(evidence, rel), true, rel + ' has an own content hash');
        assert.equal(evidence[rel], hash(content));
      }
    }
  });
  await check('deleted literal prototype-named files retain own absence markers in serialized review evidence', async () => {
    const paths = ['__proto__', 'constructor', 'toString'];
    for (const rel of paths) fs.unlinkSync(path.join(a.root, rel));
    const review = await product.reviewPaths(a, { paths });
    assert.deepEqual(review.paths, paths);
    for (const evidence of [review.expectedHashes, JSON.parse(JSON.stringify(review)).expectedHashes]) {
      assert.deepEqual(Object.keys(evidence), paths);
      for (const rel of paths) {
        assert.equal(Object.hasOwn(evidence, rel), true, rel + ' has an own absence marker');
        assert.equal(evidence[rel], null);
      }
    }
  });
  await check('abort refuses observation without changing repository, files or refs', async () => {
    const before = git(a.root, 'status', '--porcelain'); const controller = new AbortController(); controller.abort();
    await assert.rejects(product.history(a, { signal: controller.signal }), error => error.name === 'AbortError' || error.code === 'ABORT_ERR');
    assert.equal(git(a.root, 'status', '--porcelain'), before);
  });
  await check('a file removed after review stat is refused rather than reclassified as an approved deletion', async () => {
    const target = path.join(a.root, 'race.txt'); fs.writeFileSync(target, 'must remain a content review');
    const io = fs.promises, originalOpen = io.open; let injected = false;
    io.open = async function(file, ...args) {
      if (!injected && path.resolve(String(file)) === target) { injected = true; fs.unlinkSync(target); }
      return originalOpen.call(this, file, ...args);
    };
    try { await assert.rejects(product.reviewPaths(a, { paths: ['race.txt'] }), { code: 'GIT_SNAPSHOT_CHANGED' }); }
    finally { io.open = originalOpen; }
    assert.equal(injected, true, 'the real selected file was removed exactly at open');
  });
  await check('branches have source-bound stable pages and detect changed refs', async () => {
    for (let i = 0; i < 4; i++) git(a.root, 'branch', `topic-${i}`);
    const first = await product.branches(a, { limit: 2 }); assert.equal(first.entries.length, 2); assert.ok(first.nextCursor);
    const next = await product.branches(a, { limit: 2, cursor: first.nextCursor });
    assert.equal(new Set([...first.entries, ...next.entries].map(row => row.name)).size, 4);
    await assert.rejects(product.branches(b, { cursor: first.nextCursor }), { code: 'GIT_CURSOR_MISMATCH' });
    git(a.root, 'branch', 'new-topic');
    await assert.rejects(product.branches(a, { cursor: first.nextCursor }), { code: 'GIT_SNAPSHOT_CHANGED' });
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
assert.equal(failed, 0, 'all actual Git observation scenarios pass');
