import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createStagedDshAgentProvider } from '../src/agent/staged-dsh-agent-provider.js';
import { isManagedWorktree } from '../src/workspace/managed-worktree.js';

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-managed-worktree-')));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + path.join(temporary, 'no-hooks'), ...args], { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let passed = 0, failed = 0, sequence = 0;
async function check(name, run) { try { await run(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } }
// Git marks .git files hidden on Windows; r+ safely replaces only our owned fixture bytes.
function replaceFile(file, bytes) { const handle = fs.openSync(file, 'r+'); try { fs.ftruncateSync(handle); fs.writeFileSync(handle, bytes); } finally { fs.closeSync(handle); } }
function fixture({ linkedParent = false } = {}) {
  const base = path.join(temporary, String(++sequence)), main = path.join(base, 'project'), stateDir = path.join(base, 'state');
  fs.mkdirSync(main, { recursive: true }); fs.mkdirSync(path.join(stateDir, 'agent-worktrees'), { recursive: true });
  git(main, 'init', '-qb', 'main'); git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(main, 'a.txt'), 'project bytes'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'base');
  const parentRoot = linkedParent ? path.join(base, 'linked-parent') : main;
  if (linkedParent) git(main, 'worktree', 'add', '-qb', 'codex/parent', parentRoot);
  const root = path.join(stateDir, 'agent-worktrees', 'owned-target');
  git(parentRoot, 'worktree', 'add', '-qb', 'codex/target', root);
  const parent = { id: 'parent', root: fs.realpathSync.native(parentRoot) };
  const entry = { id: 'target', root: fs.realpathSync.native(root), gitWorktree: { parentWorkspaceId: parent.id, taskId: 'task', branch: 'codex/target', baselineHead: git(main, 'rev-parse', 'HEAD') } };
  const options = { stateDir, resolveWorkspace: id => id === parent.id ? parent : null };
  const trusted = (candidate = entry, settings = options) => isManagedWorktree(candidate, settings);
  return { base, main, stateDir, root, parent, entry, options, trusted };
}
try {
  await check('actual linked Worktree under managed StateDir is trusted', () => { const f = fixture(); assert.equal(f.trusted(), true); });
  await check('parent may itself be a registered linked Worktree', () => { const f = fixture({ linkedParent: true }); assert.equal(f.trusted(), true); });
  await check('StateDir directory aliases resolve to the same controlled managed base', () => { const f = fixture(), alias = path.join(f.base, 'state-alias'); fs.symlinkSync(f.stateDir, alias, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(f.trusted(f.entry, { ...f.options, stateDir: alias }), true); });
  await check('historical creation Task and branch metadata do not become execution permissions', () => { const f = fixture(); git(f.root, 'checkout', '-qb', 'codex/later-task'); assert.equal(f.trusted(), true); });
  await check('missing or foreign parent registration never grants a source exception', () => { const f = fixture(); assert.equal(f.trusted(f.entry, { ...f.options, resolveWorkspace: () => null }), false); assert.equal(f.trusted({ ...f.entry, gitWorktree: { ...f.entry.gitWorktree, parentWorkspaceId: f.entry.id } }), false); });
  await check('relation metadata cannot turn a normal repository into a managed Worktree', () => { const f = fixture(); assert.equal(f.trusted({ ...f.entry, root: f.main }), false); const ordinary = path.join(f.stateDir, 'agent-worktrees', 'ordinary'); fs.mkdirSync(ordinary); git(ordinary, 'init', '-q'); assert.equal(f.trusted({ ...f.entry, root: ordinary }), false); });
  await check('managed base and StateDir themselves cannot be used as trusted source', () => { const f = fixture(); for (const root of [f.stateDir, path.join(f.stateDir, 'agent-worktrees')]) assert.equal(f.trusted({ ...f.entry, root }), false); });
  await check('a junction source cannot borrow trust from a managed path', () => { const f = fixture(), linked = path.join(f.stateDir, 'agent-worktrees', 'alias-target'); fs.symlinkSync(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(f.trusted({ ...f.entry, root: linked }), false); });
  await check('managed base redirected through a junction is rejected', () => { const f = fixture(), aliasState = path.join(f.base, 'other-state'); fs.mkdirSync(aliasState); fs.symlinkSync(path.join(f.stateDir, 'agent-worktrees'), path.join(aliasState, 'agent-worktrees'), process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(f.trusted(f.entry, { ...f.options, stateDir: aliasState }), false); });
  await check('a forged marker pointing at the parent main Git directory is rejected', () => { const f = fixture(); replaceFile(path.join(f.root, '.git'), 'gitdir: ' + path.join(f.main, '.git') + '\n'); assert.equal(f.trusted(), false); });
  await check('a real foreign repository metadata directory is rejected', () => { const f = fixture(), foreign = fixture(); replaceFile(path.join(f.root, '.git'), fs.readFileSync(path.join(foreign.root, '.git'))); assert.equal(f.trusted(), false); });
  await check('linked metadata must point back to this exact source marker', () => { const f = fixture(), marker = fs.readFileSync(path.join(f.root, '.git'), 'utf8').trim().slice(8); fs.writeFileSync(path.join(marker, 'gitdir'), path.join(f.main, '.git') + '\n'); assert.equal(f.trusted(), false); });
  await check('linked metadata commondir must resolve to the registered parent repository', () => { const f = fixture(), foreign = fixture(), marker = fs.readFileSync(path.join(f.root, '.git'), 'utf8').trim().slice(8); fs.writeFileSync(path.join(marker, 'commondir'), path.join(foreign.main, '.git') + '\n'); assert.equal(f.trusted(), false); });
  await check('symbolic Git markers are rejected without reading outside source', () => { const f = fixture(), marker = path.join(f.root, '.git'), saved = path.join(f.base, 'saved-git-marker'), outside = path.join(f.base, 'outside-git'); fs.renameSync(marker, saved); fs.mkdirSync(outside); fs.symlinkSync(outside, marker, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(f.trusted(), false); });
  await check('malformed and oversized marker files fail closed', () => { const f = fixture(), marker = path.join(f.root, '.git'); for (const value of ['not a git marker\n', 'gitdir: x\nextra\n', 'gitdir: ' + 'x'.repeat(8192)]) { replaceFile(marker, value); assert.equal(f.trusted(), false); } });
  await check('unavailable paths and a throwing registry resolver fail closed', () => { const f = fixture(); assert.equal(f.trusted({ ...f.entry, root: path.join(f.base, 'missing') }), false); assert.equal(f.trusted(f.entry, { ...f.options, resolveWorkspace: () => { throw new Error('unavailable'); } }), false); });
  await check('registered managed Workspace reaches real provider staging while StateDir secrets remain excluded', async () => {
    const f = fixture(), tasks = createTaskRuntime({ stateDir: f.stateDir });
    const workspace = createWorkspaceService({ stateDir: f.stateDir, getTask: id => tasks.get({ id }).task });
    const { workspace: source } = await workspace.execute({ method: 'workspace.create', params: { root: f.main, name: 'source' } });
    let task = tasks.create({ goal: 'managed input', workspaceId: source.id });
    const created = await workspace.executeApprovedGit({ method: 'workspace.git.worktree.create', params: { id: source.id, taskId: task.id, branch: 'codex/provider-target', expectedHead: git(f.main, 'rev-parse', 'HEAD') } });
    tasks.update({ id: task.id, expectedRev: task.rev, workspaceId: created.workspace.id }); task = tasks.get({ id: task.id }).task;
    const target = workspace.describeWorkspace(task.workspaceId);
    assert.equal(target.managedIsolation, true);
    fs.writeFileSync(path.join(f.stateDir, 'owner-private.txt'), 'outside secret');
    fs.writeFileSync(path.join(target.root, '.env'), 'sensitive secret');
    fs.mkdirSync(path.join(target.root, 'private-output')); fs.writeFileSync(path.join(target.root, 'private-output', 'secret.txt'), 'nested secret');
    const external = defineAgentProvider({ id: 'dsh-fixture', label: 'Fixture transport', methods: {
      async createSession({ cwd }) { assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'project bytes'); return { sessionId: 'fixture-session' }; },
      async *follow() {}
    } });
    const options = { provider: external, stagingRoot: path.join(f.base, 'stages'), excludedRoots: [f.stateDir, path.join(target.root, 'private-output')],
      resolveTaskWorkspace: () => ({ task, workspace: workspace.describeWorkspace(task.workspaceId) }), applyChanges: async () => { throw new Error('No import expected'); } };
    const provider = createStagedDshAgentProvider(options);
    try {
      const session = await provider.createSession({ taskId: task.id, workspaceId: task.workspaceId });
      assert.notEqual(session.cwd, target.root);
      for (const rel of ['.git', '.env', 'owner-private.txt', 'private-output/secret.txt']) assert.equal(fs.existsSync(path.join(session.cwd, rel)), false);
      assert.equal(fs.readFileSync(path.join(target.root, 'a.txt'), 'utf8'), 'project bytes');
    } finally { await provider.shutdown(); }
    const untrusted = createStagedDshAgentProvider({ ...options, resolveTaskWorkspace: () => ({ task, workspace: { ...target, managedIsolation: false } }) });
    try { await assert.rejects(untrusted.createSession({ taskId: task.id, workspaceId: task.workspaceId, managedIsolation: true, trustedSourceRoot: target.root }), { code: 'STAGING_PATH_DENIED' }); }
    finally { await untrusted.shutdown(); }
  });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log(`Managed Worktree boundary: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
