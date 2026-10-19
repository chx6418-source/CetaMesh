import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStagingWorkspace, cleanupStagingWorkspace } from '../src/workspace/staging.js';

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
  const normal = await stage();
  assert.equal(fs.readFileSync(path.join(normal.root, 'safe.txt'), 'utf8'), 'safe');
  assert.equal(fs.existsSync(path.join(normal.root, 'nested')), false);
  cleanupStagingWorkspace(normal);
  console.log('PASS normal staging excludes another nested Workspace');

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

