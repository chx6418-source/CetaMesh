import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStagingWorkspace, collectStagedChanges, cleanupStagingWorkspace, refreshStagingBaseline } from '../src/workspace/staging.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-stage-boundary-'));
const source = path.join(root, 'parent', 'source');
const nested = path.join(source, 'nested');
const other = path.join(root, 'other');
const stageRoot = path.join(root, 'stages');
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(other);
fs.writeFileSync(path.join(source, 'safe.txt'), 'safe');
fs.writeFileSync(path.join(nested, 'private.txt'), 'nested-secret');
fs.writeFileSync(path.join(other, 'private.txt'), 'other-secret');

const stage = async (options = {}) => createStagingWorkspace({
  taskId: 'task', workspaceId: 'workspace', sourceRoot: source, stagingRoot: stageRoot,
  additionalWorkspaceRoots: [nested, other], ...options
});

try {
  const noisySource = path.join(root, 'noisy-project'); fs.mkdirSync(noisySource);
  fs.writeFileSync(path.join(noisySource, 'main.ts'), 'source');
  for (const dir of ['node_modules', '.pnpm-store', '.npm-cache']) {
    fs.mkdirSync(path.join(noisySource, dir));
    fs.writeFileSync(path.join(noisySource, dir, 'large.bin'), Buffer.alloc(512));
  }
  const browser = path.join(noisySource, '.edge-fixture'); fs.mkdirSync(path.join(browser, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(browser, 'Local State'), 'browser profile metadata');
  fs.writeFileSync(path.join(browser, 'Default', 'Cookies'), Buffer.alloc(512));
  const filtered = await createStagingWorkspace({ taskId: 'filtered', workspaceId: 'noisy', sourceRoot: noisySource, stagingRoot: stageRoot, maxBytes: 64 });
  assert.deepEqual([...filtered.baseline.keys()], ['main.ts'], 'dependency caches and real browser profiles are not Task input');
  assert.equal(fs.existsSync(path.join(filtered.root, '.edge-fixture')), false, 'browser profile data never enters Agent staging');
  assert.deepEqual(collectStagedChanges(filtered).changes, []);
  fs.writeFileSync(path.join(filtered.root, 'main.ts'), 'updated');
  assert.equal(collectStagedChanges(filtered).changes[0].path, 'main.ts');
  fs.writeFileSync(path.join(noisySource, 'main.ts'), 'updated');
  assert.equal(refreshStagingBaseline(filtered).files, 1, 'import refresh uses the same fixed snapshot exclusions');
  fs.mkdirSync(path.join(filtered.root, 'Default'));
  fs.writeFileSync(path.join(filtered.root, 'Local State'), 'new marker must not hide original source files');
  assert.equal(collectStagedChanges(filtered).changes.some(change => change.action === 'delete'), false);
  cleanupStagingWorkspace(filtered);
  await assert.rejects(createStagingWorkspace({ taskId: 'profile', workspaceId: 'profile', sourceRoot: browser, stagingRoot: stageRoot }),
    error => error.code === 'STAGING_PATH_DENIED', 'a browser profile root must not become Agent input');
  fs.writeFileSync(path.join(noisySource, 'real-data.bin'), Buffer.alloc(128));
  await assert.rejects(createStagingWorkspace({ taskId: 'too-big', workspaceId: 'noisy', sourceRoot: noisySource, stagingRoot: stageRoot, maxBytes: 64 }),
    error => error.code === 'STAGING_TOO_LARGE' && /项目|子目录/.test(error.message), 'real source data still respects the bound and explains recovery');
  console.log('PASS generated dependencies/browser profiles excluded, real source size limit preserved');

  const normal = await stage();
  assert.equal(fs.readFileSync(path.join(normal.root, 'safe.txt'), 'utf8'), 'safe');
  assert.equal(fs.existsSync(path.join(normal.root, 'nested')), false);
  cleanupStagingWorkspace(normal);
  console.log('PASS normal staging excludes another nested Workspace');

  const liveSource = path.join(root, 'live-source'); fs.mkdirSync(liveSource);
  fs.writeFileSync(path.join(liveSource, 'runtime.txt'), 'before');
  const readOnlyStage = await createStagingWorkspace({ taskId: 'read-only', workspaceId: 'live', sourceRoot: liveSource, stagingRoot: stageRoot });
  fs.writeFileSync(path.join(liveSource, 'runtime.txt'), 'external update');
  assert.deepEqual(collectStagedChanges(readOnlyStage).changes, [], 'read-only turn has nothing to import and must not fail on source drift');
  fs.writeFileSync(path.join(readOnlyStage.root, 'runtime.txt'), 'agent update');
  assert.throws(() => collectStagedChanges(readOnlyStage), error => error.code === 'WORKSPACE_RECONCILIATION_REQUIRED', 'real staged writes still reject source conflicts');
  cleanupStagingWorkspace(readOnlyStage);
  const scanStage = await createStagingWorkspace({ taskId: 'read-only-scan', workspaceId: 'live', sourceRoot: liveSource, stagingRoot: stageRoot });
  const originalReadDir = fs.readdirSync;
  const checkedSource = fs.realpathSync.native(liveSource);
  try {
    fs.readdirSync = function(target, ...args) {
      // The production walk canonicalizes roots. Windows runners can return a
      // different drive-letter case or alias than the temp path spelling.
      if (fs.realpathSync.native(String(target)) === checkedSource) throw Object.assign(new Error('synthetic live directory unavailable'), { code: 'EACCES' });
      return originalReadDir.call(this, target, ...args);
    };
    assert.deepEqual(collectStagedChanges(scanStage).changes, [], 'no-op turn must not rescan live source or be blocked by transient source reads');
    fs.writeFileSync(path.join(scanStage.root, 'new.txt'), 'needs import');
    assert.throws(() => collectStagedChanges(scanStage), error => error.code === 'STAGING_READ_FAILED', 'actual imports still fail closed when source cannot be checked');
  } finally { fs.readdirSync = originalReadDir; cleanupStagingWorkspace(scanStage); }
  console.log('PASS read-only turns survive live source drift/read failures while real imports retain conflict/read guards');


  // Missing stagingRoot formerly resolved to cwd inside isInsideRoot(), allowing
  // provider shutdown to recursively delete the caller's current directory.
  const originalCwd = process.cwd();
  const protectedRoot = path.join(root, 'protected-cleanup-target');
  fs.mkdirSync(protectedRoot);
  const protectedFile = path.join(protectedRoot, 'keep.txt');
  fs.writeFileSync(protectedFile, 'must survive invalid cleanup');
  try {
    process.chdir(protectedRoot);
    for (const malformed of [
      { root: protectedRoot },
      { root: protectedRoot, stagingRoot: null },
      { root: protectedRoot, stagingRoot: 7 },
      { root: protectedRoot, stagingRoot: root + '\0' },
      { root: '', stagingRoot: root },
      { root: null, stagingRoot: root },
      { root: 7, stagingRoot: root },
      { root: protectedRoot + '\0', stagingRoot: root },
      { root: protectedRoot, stagingRoot: '' },
      { root: protectedRoot, stagingRoot: '.' },
      { root: '.', stagingRoot: root },
      { root: protectedRoot, stagingRoot: protectedRoot },
      { root: protectedRoot + path.sep + '.', stagingRoot: protectedRoot },
      { stagingRoot: root }
    ]) {
      assert.throws(() => cleanupStagingWorkspace(malformed),
        error => error.code === 'STAGING_PATH_INVALID',
        'invalid stage ownership must fail before filesystem removal');
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'must survive invalid cleanup');
    }
  } finally { process.chdir(originalCwd); }
  console.log('PASS malformed cleanup metadata cannot remove cwd or an aliased staging base');

  const disposable = await stage();
  cleanupStagingWorkspace(disposable);
  assert.equal(fs.existsSync(disposable.root), false);
  assert.deepEqual(cleanupStagingWorkspace(disposable), { removed: false });
  console.log('PASS owned staging cleanup remains idempotent');

  if (process.platform === 'win32') {
    const cased = await stage({ additionalWorkspaceRoots: [nested.toUpperCase(), other] });
    assert.equal(fs.existsSync(path.join(cased.root, 'nested')), false);
    cleanupStagingWorkspace(cased);
    console.log('PASS Windows case alias excludes nested Workspace');

    try {
      const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${nested}") do @echo %~sI`], { encoding: 'utf8' }).trim();
      if (!short || !short.includes('~') || !fs.existsSync(short)) {
        console.log('NOT_RUN_ENVIRONMENT Windows 8.3 alias fixture unavailable on this volume');
      } else {
        const aliased = await stage({ additionalWorkspaceRoots: [short, other] });
        assert.equal(fs.existsSync(path.join(aliased.root, 'nested')), false);
        cleanupStagingWorkspace(aliased);
        console.log('PASS Windows 8.3 alias excludes nested Workspace');
      }
    } catch (error) {
      console.log(`NOT_RUN_ENVIRONMENT Windows 8.3 alias fixture unavailable: ${error?.code ?? 'unknown'}`);
    }
  }

  await assert.rejects(stage({ stagingRoot: path.join(source, '..', 'source', 'stages') }),
    error => error.code === 'STAGING_ROOT_OVERLAPS_WORKSPACE');
  await assert.rejects(stage({ additionalWorkspaceRoots: [path.dirname(source)] }),
    error => error.code === 'WORKSPACE_OVERLAP');
  console.log('PASS path escape and parent Workspace fail closed');

  for (const kind of ['junction', 'dir']) {
    const alias = path.join(root, `${kind}-alias`);
    try { fs.symlinkSync(source, alias, kind); }
    catch (error) {
      console.log(`NOT_RUN_ENVIRONMENT ${kind} fixture unavailable: ${error?.code ?? 'unknown'}`);
      continue;
    }
    await assert.rejects(stage({ stagingRoot: path.join(alias, 'stages') }),
      error => error.code === 'STAGING_ROOT_OVERLAPS_WORKSPACE');
    assert.throws(() => cleanupStagingWorkspace({ root: alias, stagingRoot: root }),
      error => error.code === 'STAGING_PATH_INVALID', 'cleanup must not follow an unowned stage link');
    assert.equal(fs.readFileSync(path.join(source, 'safe.txt'), 'utf8'), 'safe');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.throws(() => cleanupStagingWorkspace({ root: source, stagingRoot: alias }),
      error => error.code === 'STAGING_PATH_INVALID', 'canonical aliases cannot remove the staging base itself');
    const stageAlias = path.join(stageRoot, `${kind}-escape`);
    fs.symlinkSync(source, stageAlias, kind);
    assert.throws(() => cleanupStagingWorkspace({ root: path.join(stageAlias, 'nested'), stagingRoot: stageRoot }),
      error => error.code === 'STAGING_PATH_INVALID', 'an intermediate link cannot redirect cleanup outside staging');
    assert.equal(fs.readFileSync(path.join(nested, 'private.txt'), 'utf8'), 'nested-secret');
    console.log(`PASS ${kind} alias cannot place staging inside source Workspace`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

