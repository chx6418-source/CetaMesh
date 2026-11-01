import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createStagingWorkspace, collectStagedChanges, cleanupStagingWorkspace } from '../src/workspace/staging.js';

// Real local Git/filesystem acceptance with generated, nonprivate contents.
// These are measured controlled operations, not a claim of real model/CLI execution.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-workspace-scale-'));
const project = path.join(base, 'project'), stateDir = path.join(base, 'state');
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const metrics = { generatedFixture: true, files: 1200, branches: 30, managedWorktrees: 12, expectedConflictRejections: 0, unexpectedFailures: 0, elapsedMs: {} };
const stages = [];
const start = performance.now();
try {
  fs.mkdirSync(project, { recursive: true });
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(project, `file-${String(i).padStart(4, '0')}.txt`), `baseline ${i}\n`);
  fs.writeFileSync(path.join(project, 'unchanged.bin'), Buffer.alloc(8 * 1024 * 1024, 0xff));
  git('init', '-b', 'main'); git('config', 'user.name', 'CetaMesh fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-m', 'generated baseline');
  const head = git('rev-parse', 'HEAD');
  const tasks = createTaskRuntime({ stateDir });
  const workspace = createWorkspaceService({ stateDir, getTask: id => tasks.get({ id }).task, listTasks: query => tasks.list(query) });
  const source = (await workspace.execute({ method: 'workspace.create', params: { root: project, name: 'Large controlled project' } })).workspace;
  const task = tasks.create({ goal: 'Controlled scale acceptance', workspaceId: source.id });
  let at = performance.now();
  for (let i = 0; i < 30; i++) git('branch', `fixture/branch-${i}`);
  for (let i = 0; i < 12; i++) {
    const created = await workspace.executeApprovedGit({ method: 'workspace.git.worktree.create', params: { id: source.id, taskId: task.id, branch: `fixture/worktree-${i}`, expectedHead: head } });
    assert.equal(workspace.describeWorkspace(created.workspace.id).managedIsolation, true);
  }
  metrics.elapsedMs.worktreeCreation = Math.round(performance.now() - at);
  for (let i = 0; i < 1200; i++) fs.appendFileSync(path.join(project, `file-${String(i).padStart(4, '0')}.txt`), `user edit ${i}\n`);
  fs.writeFileSync(path.join(project, 'uncommitted.txt'), 'preserve original user intent');
  at = performance.now();
  const overview = await workspace.execute({ method: 'workspace.git.overview', params: { id: source.id } });
  assert.equal(overview.git.entries.length, 1201); assert.equal(overview.truncated, false);
  assert.equal(overview.branches.length, 43); assert.equal(overview.worktrees.length, 13);
  metrics.elapsedMs.overview = Math.round(performance.now() - at);

  const stageFor = async id => {
    const stage = await createStagingWorkspace({ taskId: id, workspaceId: source.id, sourceRoot: project, stagingRoot: path.join(base, 'stages') });
    stages.push(stage); return stage;
  };
  at = performance.now();
  const [one, two] = await Promise.all([stageFor('agent-one'), stageFor('agent-two')]);
  fs.writeFileSync(path.join(one.root, 'file-0000.txt'), 'agent one reviewed output');
  fs.writeFileSync(path.join(two.root, 'file-0001.txt'), 'agent two reviewed output');
  workspace.applyChanges({ id: source.id, changes: collectStagedChanges(one).changes });
  workspace.applyChanges({ id: source.id, changes: collectStagedChanges(two).changes });
  assert.equal(fs.readFileSync(path.join(project, 'file-0000.txt'), 'utf8'), 'agent one reviewed output');
  assert.equal(fs.readFileSync(path.join(project, 'file-0001.txt'), 'utf8'), 'agent two reviewed output');
  assert.equal(fs.readFileSync(path.join(project, 'uncommitted.txt'), 'utf8'), 'preserve original user intent');
  metrics.elapsedMs.parallelNonconflictingImport = Math.round(performance.now() - at);

  const [three, four] = await Promise.all([stageFor('agent-three'), stageFor('agent-four')]);
  fs.writeFileSync(path.join(three.root, 'file-0002.txt'), 'accepted first');
  fs.writeFileSync(path.join(four.root, 'file-0002.txt'), 'conflicting second');
  workspace.applyChanges({ id: source.id, changes: collectStagedChanges(three).changes });
  assert.throws(() => collectStagedChanges(four), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' });
  metrics.expectedConflictRejections++;
  assert.equal(fs.readFileSync(path.join(project, 'file-0002.txt'), 'utf8'), 'accepted first');
  assert.equal(git('rev-parse', 'HEAD'), head, 'no automatic commit/merge');
  assert.equal(fs.readFileSync(path.join(project, 'unchanged.bin')).length, 8 * 1024 * 1024);
  const reopened = createWorkspaceService({ stateDir, getTask: id => tasks.get({ id }).task, listTasks: query => tasks.list(query) });
  assert.equal((await reopened.execute({ method: 'workspace.info', params: { id: source.id } })).taskRelation.total, 1);
  assert.equal(fs.readFileSync(path.join(project, 'uncommitted.txt'), 'utf8'), 'preserve original user intent');
  metrics.elapsedMs.total = Math.round(performance.now() - start);
  console.log('PASS controlled real Git scale, parallel imports and restart', JSON.stringify(metrics));
} catch (error) { metrics.unexpectedFailures++; console.error('FAIL', JSON.stringify(metrics), error); process.exitCode = 1; }
finally {
  // Every deleted path was created by this test under its own unique temp root.
  for (const stage of stages) {
    assert.ok(path.resolve(stage.stagingRoot).startsWith(path.resolve(base) + path.sep));
    cleanupStagingWorkspace(stage);
  }
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(base, { recursive: true, force: true });
}
