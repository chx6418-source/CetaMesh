import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-product-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + path.join(temporary, 'no-hooks'), ...args], { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
let passed = 0, failed = 0;
async function check(name, run) { try { await run(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } }
async function fixture(name) {
  const root = path.join(temporary, name), stateDir = path.join(temporary, name + '-state');
  fs.mkdirSync(root); git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'core.autocrlf', 'false'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(root, 'other.txt'), 'other\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  const runtime = createTaskRuntime({ stateDir });
  const service = createWorkspaceService({ stateDir, getTask: id => runtime.get({ id }).task, listTasks: query => runtime.list(query).tasks });
  const { workspace } = await service.execute({ method: 'workspace.create', params: { name, root } });
  const task = runtime.create({ goal: 'Review Git work', workspaceId: workspace.id });
  const request = { id: workspace.id, taskId: task.id, branch: 'codex/' + name, expectedHead: git(root, 'rev-parse', 'HEAD') };
  return { root, stateDir, runtime, service, workspace, task, request };
}
try {
  await check('overview exposes real status, file hashes, branches, history and current Task without changing the repository', async () => {
    const f = await fixture('overview'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'edited\n'); fs.writeFileSync(path.join(f.root, 'loose file.txt'), 'untracked\n');
    const before = git(f.root, 'status', '--porcelain');
    const result = await f.service.execute({ method: 'workspace.git.overview', params: { id: f.workspace.id } });
    assert.equal(result.git.headSha, f.request.expectedHead); assert.equal(result.git.branch, 'main');
    assert.equal(result.git.entries.find(row => row.path === 'a.txt').sha256, digest('edited\n'));
    assert.equal(result.git.entries.find(row => row.path === 'loose file.txt').sha256, digest('untracked\n'));
    assert.ok(result.branches.some(row => row.name === 'main' && row.current)); assert.equal(result.history[0].subject, 'base');
    assert.ok(result.tasks.some(row => row.id === f.task.id)); assert.equal(git(f.root, 'status', '--porcelain'), before);
  });
  await check('normal IPC cannot authorize branch or worktree mutations by supplying approval flags', async () => {
    const f = await fixture('unapproved');
    for (const method of ['workspace.git.branch.create', 'workspace.git.worktree.create']) await assert.rejects(f.service.execute({ method, params: { ...f.request, approved: true } }), error => error.code === 'GIT_APPROVAL_REQUIRED');
    assert.equal(git(f.root, 'branch', '--list', f.request.branch), '');
  });
  await check('approved branch uses exact baseline and retains dirty staged and untracked files', async () => {
    const f = await fixture('branch'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'user staged\n'); git(f.root, 'add', 'a.txt'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'user unstaged\n'); fs.writeFileSync(path.join(f.root, 'loose.txt'), 'keep');
    const before = git(f.root, 'status', '--porcelain');
    const result = await f.service.executeApprovedGit({ method: 'workspace.git.branch.create', params: f.request });
    assert.equal(result.branch, f.request.branch); assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + f.request.branch), f.request.expectedHead);
    assert.equal(git(f.root, 'status', '--porcelain'), before); assert.equal(git(f.root, 'branch', '--show-current'), 'main');
    const overview = await f.service.execute({ method: 'workspace.git.overview', params: { id: f.workspace.id } }); assert.equal(overview.branches.find(row => row.name === f.request.branch).taskId, f.task.id);
  });
  await check('stale HEAD and a Task from another Workspace cannot create branches', async () => {
    const f = await fixture('stale');
    await assert.rejects(f.service.executeApprovedGit({ method: 'workspace.git.branch.create', params: { ...f.request, expectedHead: '0'.repeat(40) } }), error => error.code === 'GIT_HEAD_CHANGED');
    const foreign = f.runtime.create({ goal: 'Other Workspace', workspaceId: 'ws-other' });
    await assert.rejects(f.service.executeApprovedGit({ method: 'workspace.git.branch.create', params: { ...f.request, taskId: foreign.id } }), error => error.code === 'TASK_WORKSPACE_MISMATCH');
    assert.equal(git(f.root, 'branch', '--list', f.request.branch), '');
  });
  await check('worktree is generated under controlled StateDir, registered and linked to original Task after restart', async () => {
    const f = await fixture('worktree'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'user dirty\n');
    const before = git(f.root, 'status', '--porcelain');
    const result = await f.service.executeApprovedGit({ method: 'workspace.git.worktree.create', params: f.request });
    assert.ok(result.workspace.id !== f.workspace.id); const target = result.workspace.root;
    assert.ok(path.relative(path.join(f.stateDir, 'agent-worktrees'), target).split(path.sep).length === 1);
    assert.equal(git(target, 'branch', '--show-current'), f.request.branch); assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'base\n');
    fs.writeFileSync(path.join(target, 'a.txt'), 'agent edit\n'); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'user dirty\n'); assert.equal(git(f.root, 'status', '--porcelain'), before);
    const restarted = createWorkspaceService({ stateDir: f.stateDir, getTask: id => f.runtime.get({ id }).task, listTasks: query => f.runtime.list(query).tasks });
    const overview = await restarted.execute({ method: 'workspace.git.overview', params: { id: f.workspace.id } });
    const row = overview.worktrees.find(item => item.workspaceId === result.workspace.id); assert.equal(row.taskId, f.task.id); assert.equal(row.managed, true); assert.equal(row.baselineHead, f.request.expectedHead);
  });
  await check('external destination paths and invalid branch expressions are rejected without writing them', async () => {
    const f = await fixture('paths'); const external = path.join(temporary, 'outside-destination');
    await assert.rejects(f.service.executeApprovedGit({ method: 'workspace.git.worktree.create', params: { ...f.request, path: external } }), error => error.code === 'INVALID_PARAMS');
    for (const branch of ['../escape', '--force', 'HEAD', '@{-1}', 'bad\nbranch']) await assert.rejects(f.service.executeApprovedGit({ method: 'workspace.git.branch.create', params: { ...f.request, branch } }), error => error.code === 'GIT_BRANCH_INVALID');
    assert.equal(fs.existsSync(external), false); assert.equal(git(f.root, 'branch', '--list', f.request.branch), '');
  });
  await check('concurrent creation of the same branch has one winner and preserves its target', async () => {
    const f = await fixture('concurrent');
    const results = await Promise.allSettled([1, 2].map(() => f.service.executeApprovedGit({ method: 'workspace.git.branch.create', params: f.request })));
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.filter(row => row.status === 'rejected').length, 1);
    assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + f.request.branch), f.request.expectedHead); assert.equal(git(f.root, 'status', '--porcelain'), '');
  });
  await check('real merge conflicts are visible and never silently resolved or eligible for commit', async () => {
    const f = await fixture('conflicts'); git(f.root, 'checkout', '-qb', 'fixture-conflict'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'branch edit\n'); git(f.root, 'commit', '-qam', 'branch edit'); git(f.root, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'main edit\n'); git(f.root, 'commit', '-qam', 'main edit');
    assert.throws(() => git(f.root, 'merge', 'fixture-conflict')); const before = fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8');
    const overview = await f.service.execute({ method: 'workspace.git.overview', params: { id: f.workspace.id } });
    assert.equal(overview.conflicts[0].path, 'a.txt'); assert.equal(overview.git.entries.find(row => row.path === 'a.txt').commitEligible, false); assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), before);
  });
  await check('Broker-approved exact commit completes once and preserves unrelated staged changes', async () => {
    const f = await fixture('approved-commit'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'owned\n'); fs.writeFileSync(path.join(f.root, 'other.txt'), 'user staged\n'); git(f.root, 'add', 'other.txt');
    const result = await f.service.executeApprovedGit({ method: 'workspace.git.commit', params: { id: f.workspace.id, message: 'reviewed selection', paths: ['a.txt'], expectedHead: f.request.expectedHead, expectedHashes: { 'a.txt': digest('owned\n') } } });
    assert.equal(result.committed, true); assert.equal(result.status, 'committed'); assert.equal(git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.sha), 'a.txt'); assert.equal(git(f.root, 'diff', '--cached', '--name-only'), 'other.txt');
    const pending = await f.service.execute({ method: 'workspace.pending.list', params: { workspaceId: f.workspace.id } }); assert.equal(pending.pending.length, 0);
  });
  await check('ordinary commit still requires exact content review and creates no commit before its approval', async () => {
    const f = await fixture('pending-commit'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'owned\n');
    const result = await f.service.execute({ method: 'workspace.git.commit', params: { id: f.workspace.id, message: 'reviewed selection', paths: ['a.txt'], expectedHead: f.request.expectedHead, expectedHashes: { 'a.txt': digest('owned\n') }, approved: true } });
    assert.equal(result.status, 'pending'); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.request.expectedHead);
  });
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
console.log(`Git product: ${passed} PASS / ${failed} FAIL`); if (failed) process.exitCode = 1;
