import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTaskArtifactOpen } from '../src/task/artifact-open.js';
import { createTaskService } from '../src/task/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-artifact-open-'));
const workspaceRoot = path.join(tempRoot, 'workspace');
const otherWorkspaceRoot = path.join(tempRoot, 'other-workspace');
const ownedArtifactRoot = path.join(tempRoot, 'data', 'artifacts');
const outsideRoot = path.join(tempRoot, 'outside');
const stateDir = path.join(tempRoot, 'state');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(otherWorkspaceRoot, { recursive: true });
fs.mkdirSync(ownedArtifactRoot, { recursive: true });
fs.mkdirSync(outsideRoot, { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'report.md'), '# report');
fs.writeFileSync(path.join(workspaceRoot, 'unsafe.exe'), 'not executable');
fs.writeFileSync(path.join(workspaceRoot, 'unsafe.html'), '<script></script>');
fs.writeFileSync(path.join(ownedArtifactRoot, 'report.csv'), 'a,b\n1,2');
fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside');

function workspaceResolver(id) {
  if (id === 'ws-a') return { id, root: workspaceRoot };
  if (id === 'ws-b') return { id, root: otherWorkspaceRoot };
  return null;
}

const taskService = createTaskService({ stateDir, resolveWorkspace: workspaceResolver, ownedArtifactRoot });
const task = await taskService.execute({ method: 'task.create', params: { goal: 'artifact open', workspaceId: 'ws-a' } });
const currentTasks = new Map([[task.id, task]]);

async function addArtifact(ownerTask, ref, label = path.basename(ref)) {
  const current = currentTasks.get(ownerTask.id) ?? ownerTask;
  const updated = await taskService.execute({
    method: 'task.artifact.add',
    params: { id: ownerTask.id, expectedRev: current.rev, kind: 'file', label, ref }
  });
  currentTasks.set(ownerTask.id, updated);
  return { task: updated, artifact: updated.artifacts.at(-1) };
}

async function expectCode(name, promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `${name}: ${error.message}`);
    return true;
  }, name);
}

try {
  const workspaceArtifact = { id: 'artifact-valid', kind: 'file', label: 'report.md', ref: 'report.md' };
  const resolved = resolveTaskArtifactOpen({ artifact: workspaceArtifact, workspaceRoot, ownedArtifactRoot });
  assert.equal(resolved.canonicalPath, fs.realpathSync.native(path.join(workspaceRoot, 'report.md')));
  assert.equal(resolved.extension, '.md');
  console.log('PASS resolves existing Workspace artifact to canonical local path');

  const owned = resolveTaskArtifactOpen({
    artifact: { ...workspaceArtifact, ref: 'cetamesh-artifact:report.csv' },
    workspaceRoot,
    ownedArtifactRoot
  });
  assert.equal(owned.canonicalPath, fs.realpathSync.native(path.join(ownedArtifactRoot, 'report.csv')));
  assert.equal(owned.extension, '.csv');
  console.log('PASS resolves explicitly owned artifact only under dedicated root');

  const { artifact } = await addArtifact(task, 'report.md');
  const result = await taskService.execute({
    method: 'task.artifact.resolveOpen',
    params: { taskId: task.id, artifactId: artifact.id }
  });
  assert.equal(result.canonicalPath, fs.realpathSync.native(path.join(workspaceRoot, 'report.md')));
  assert.equal(result.extension, '.md');
  console.log('PASS Core resolves by Task and Artifact identity');

  await expectCode('unknown Task is denied', taskService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: 'task-unknown', artifactId: artifact.id }
  }), 'TASK_NOT_FOUND');
  await expectCode('unknown Artifact is denied', taskService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: task.id, artifactId: 'artifact-unknown' }
  }), 'ARTIFACT_NOT_FOUND');

  const otherTask = await taskService.execute({ method: 'task.create', params: { goal: 'other task', workspaceId: 'ws-a' } });
  currentTasks.set(otherTask.id, otherTask);
  await expectCode('Artifact identity from another Task is denied', taskService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: otherTask.id, artifactId: artifact.id }
  }), 'ARTIFACT_NOT_FOUND');

  const wrongWorkspaceService = createTaskService({
    stateDir,
    resolveWorkspace: id => ({ id: id === 'ws-a' ? 'ws-b' : id, root: otherWorkspaceRoot }),
    ownedArtifactRoot
  });
  await expectCode('mismatched Workspace identity is denied', wrongWorkspaceService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: task.id, artifactId: artifact.id }
  }), 'TASK_WORKSPACE_UNAVAILABLE');

  const { artifact: missing } = await addArtifact(task, 'missing.txt');
  await expectCode('missing artifact file is denied', taskService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: task.id, artifactId: missing.id }
  }), 'ARTIFACT_FILE_NOT_FOUND');

  const { artifact: traversal } = await addArtifact(task, '../outside/secret.txt');
  await expectCode('relative traversal outside Workspace is denied', taskService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: task.id, artifactId: traversal.id }
  }), 'ARTIFACT_PATH_DENIED');

  const linkPath = path.join(workspaceRoot, 'outside-link');
  fs.symlinkSync(outsideRoot, linkPath, 'junction');
  const { artifact: linked } = await addArtifact(task, 'outside-link/secret.txt');
  await expectCode('junction realpath escape is denied', taskService.execute({
    method: 'task.artifact.resolveOpen', params: { taskId: task.id, artifactId: linked.id }
  }), 'ARTIFACT_PATH_DENIED');
  const redirectedRoot = path.join(tempRoot, 'workspace-redirect');
  fs.symlinkSync(outsideRoot, redirectedRoot, 'junction');
  await expectCode('authorized root cannot be redirected by junction', Promise.resolve().then(() => resolveTaskArtifactOpen({
    artifact: { ...workspaceArtifact, ref: 'secret.txt' }, workspaceRoot: redirectedRoot, ownedArtifactRoot
  })), 'ARTIFACT_ROOT_UNAVAILABLE');

  for (const ref of ['unsafe.exe', 'unsafe.html']) {
    const { artifact: unsupported } = await addArtifact(task, ref);
    await expectCode(`unsupported extension ${ref} is denied`, taskService.execute({
      method: 'task.artifact.resolveOpen', params: { taskId: task.id, artifactId: unsupported.id }
    }), 'ARTIFACT_TYPE_UNSUPPORTED');
  }
  for (const ref of ['https://example.com/file.pdf', 'file:///C:/secret.txt', 'custom:payload']) {
    await expectCode(`non-local or unknown scheme ${ref} is denied`, Promise.resolve().then(() => resolveTaskArtifactOpen({
      artifact: { ...workspaceArtifact, ref }, workspaceRoot, ownedArtifactRoot
    })), 'ARTIFACT_REFERENCE_INVALID');
  }

  const ui = createDesktopUiService({ services: { taskService } });
  const projected = await ui.execute({ method: 'ui.task.get', params: { id: task.id } });
  assert.ok(projected.task.artifacts.some(item => item.id === artifact.id));
  assert.equal(JSON.stringify(projected).includes('report.md'), true, 'the display label stays visible');
  assert.equal(JSON.stringify(projected).includes('canonicalPath'), false);
  assert.equal(JSON.stringify(projected).includes('"ref"'), false);
  console.log('PASS renderer Task projection contains identity and label, never ref or canonical path');

  const uiOpen = await ui.execute({
    method: 'ui.task.artifact.resolveOpen', params: { taskId: task.id, artifactId: artifact.id }
  }).then(() => null, error => error);
  assert.equal(uiOpen?.code, 'METHOD_NOT_FOUND', 'artifact resolution remains Core-only');
  console.log('PASS artifact resolution is not exposed as a renderer ui.* method');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
