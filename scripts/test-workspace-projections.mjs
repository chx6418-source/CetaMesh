// Real Task/Workspace services: bounded pagination and truthful product projections.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskService } from '../src/task/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-workspace-projections-'));
let passed = 0, failed = 0, timestamp = 1900000000000;
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
const stateDir = path.join(temporary, 'state'), root = path.join(temporary, 'project');
fs.mkdirSync(root); fs.mkdirSync(stateDir);
const taskService = createTaskService({ stateDir, now: () => timestamp++ });
const workspaceService = createWorkspaceService({ stateDir, now: () => timestamp++,
  getTask: id => taskService.runtime.get({ id }).task, listTasks: query => taskService.runtime.list(query).tasks });
const ui = createDesktopUiService({ services: { workspaceService, taskService } });
try {
  const { workspace } = await workspaceService.execute({ method: 'workspace.create', params: { name: 'Projection project', root } });
  for (let index = 0; index < 105; index++) taskService.runtime.create({ goal: 'Project task ' + index, workspaceId: workspace.id });
  taskService.runtime.create({ goal: 'Other project task', workspaceId: 'ws-other-project' });

  await check('Task pages reach every matching Task beyond the first 100 without duplicates', () => {
    const first = taskService.runtime.list({ workspaceId: workspace.id, limit: 50 });
    const second = taskService.runtime.list({ workspaceId: workspace.id, limit: 50, offset: 50 });
    const last = taskService.runtime.list({ workspaceId: workspace.id, limit: 50, offset: 100 });
    assert.equal(first.total, 105); assert.equal(first.offset, 0); assert.equal(first.nextOffset, 50);
    assert.equal(second.offset, 50); assert.equal(second.nextOffset, 100);
    assert.equal(last.tasks.length, 5); assert.equal(last.nextOffset, null);
    const tasks = [...first.tasks, ...second.tasks, ...last.tasks];
    assert.equal(new Set(tasks.map(task => task.id)).size, 105);
    assert.ok(tasks.every(task => task.workspaceId === workspace.id));
    assert.equal(taskService.runtime.list({ limit: 1000 }).tasks.length, 100);
    assert.equal(taskService.runtime.list({}).tasks.length, 100);
    assert.equal(taskService.runtime.list({ workspaceId: workspace.id, offset: 5000 }).tasks.length, 0);
    assert.equal(taskService.runtime.list({ workspaceId: workspace.id, offset: -1, limit: 1 }).tasks[0].id, first.tasks[0].id);
  });

  await check('Owner Task overview preserves Workspace scope and truthful page metadata', async () => {
    const page = await ui.execute({ method: 'ui.task.overview', params: { workspaceId: workspace.id, offset: 100, limit: 50 } });
    assert.equal(page.total, 105); assert.equal(page.offset, 100); assert.equal(page.limit, 50);
    assert.equal(page.nextOffset, null); assert.equal(page.tasks.length, 5);
    assert.ok(page.tasks.every(task => task.workspaceId === workspace.id));
    assert.equal(page.counts.queued, 105);
    const other = await ui.execute({ method: 'ui.task.overview', params: { workspaceId: 'ws-other-project', limit: 50 } });
    assert.equal(other.total, 1); assert.equal(other.tasks[0].goal, 'Other project task');
    assert.equal((await ui.execute({ method: 'ui.task.overview', params: { limit: 100 } })).total, 106);
  });

  await check('Workspace cards use real registration/open times and observed directory state', async () => {
    let list = await ui.execute({ method: 'ui.workspace.list' });
    let projected = list.workspaces.find(item => item.id === workspace.id);
    assert.equal(projected.status, 'directory'); assert.equal(projected.lastActivity, workspace.createdAt);
    assert.equal(projected.activitySource, 'created');
    const opened = await workspaceService.execute({ method: 'workspace.open', params: { id: workspace.id } });
    list = await ui.execute({ method: 'ui.workspace.list' }); projected = list.workspaces.find(item => item.id === workspace.id);
    assert.equal(projected.lastActivity, opened.workspace.lastOpenedAt); assert.equal(projected.activitySource, 'opened');
  });

  await check('Task version reports the complete change count when its file preview is bounded', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, windowsHide: true, stdio: 'pipe' });
    const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
    for (let index = 0; index < 105; index++) fs.writeFileSync(path.join(nested, 'change-' + String(index).padStart(3, '0') + '.txt'), 'fixture\n');
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, encoding: 'utf8' });
    const version = await ui.execute({ method: 'ui.workspace.version', params: { id: workspace.id } });
    assert.equal(version.total, 105); assert.equal(version.changes.length, 100); assert.equal(version.truncated, true);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, encoding: 'utf8' }), before);
  });
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
console.log(`Workspace projections: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
