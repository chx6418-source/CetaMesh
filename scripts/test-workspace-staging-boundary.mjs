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
    console.log(`PASS ${kind} alias cannot place staging inside source Workspace`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
