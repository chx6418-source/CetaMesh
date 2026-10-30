import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isInsideRoot, resolveInside } from './boundary.js';
import { gitRun, gitStatus } from './tools.js';

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const protectedPath = value => value.split('/').some(part => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part));
const safeText = (value, cap = 240) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, cap);

function enrichEntries(root, rows) {
  let remaining = 64 * 1024 * 1024;
  const expanded = [...rows];
  for (const row of rows) if (row.origPath && (row.x === 'R' || row.y === 'R') && !rows.some(item => item.path === row.origPath)) expanded.push({ x: 'D', y: ' ', path: row.origPath, origPath: null });
  return expanded.slice(0, 1000).map(row => {
    const result = { ...row, conflict: conflictCodes.has(row.x + row.y), commitEligible: false };
    if (result.conflict) return { ...result, blockedReason: 'GIT_CONFLICT' };
    if (protectedPath(row.path)) return { ...result, blockedReason: 'SENSITIVE_RESOURCE' };
    try {
      const target = resolveInside(root, row.path, { forWrite: true }).absolute;
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return { ...result, sha256: null, commitEligible: true }; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) return { ...result, blockedReason: 'REGULAR_FILE_REQUIRED' };
      if (stat.size > 10 * 1024 * 1024 || stat.size > remaining) return { ...result, blockedReason: 'HASH_LIMIT' };
      remaining -= stat.size;
      return { ...result, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), commitEligible: true };
    } catch { return { ...result, blockedReason: 'PATH_UNAVAILABLE' }; }
  });
}

/** A read projection and two trusted Broker effects; no separate task/worktree store. */
export function createGitProduct({ stateDir, registry, getTask = () => null, listTasks = () => [], record = () => {} }) {
  const managedBase = path.join(path.resolve(stateDir), 'agent-worktrees');

  async function overview(entry) {
    const status = await gitStatus(entry.root, { completeFiles: true });
    const taskRows = await listTasks({ workspaceId: entry.id, limit: 100 });
    const tasks = (Array.isArray(taskRows) ? taskRows : taskRows?.tasks ?? []).slice(0, 100)
      .filter(task => task.workspaceId === entry.id).map(task => ({ id: task.id, goal: safeText(task.goal), status: task.status, workspaceId: task.workspaceId, readOnly: task.childContract?.mode === 'read-only' }));
    if (!status.isRepo) return { workspaceId: entry.id, git: status, branches: [], history: [], worktrees: [], conflicts: [], tasks, truncated: false };
    if (!samePath(status.repoRoot, fs.realpathSync.native(entry.root))) fail('GIT_ROOT_REQUIRED', 'Git management requires the registered repository root');
    const [branchOutput, historyOutput, worktreeOutput] = await Promise.all([
      gitRun(entry.root, ['for-each-ref', '--count=201', '--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)', 'refs/heads/']),
      status.headSha ? gitRun(entry.root, ['log', '-n', '50', '--format=%H%x00%P%x00%ct%x00%s']) : Promise.resolve({ stdout: '' }),
      gitRun(entry.root, ['worktree', 'list', '--porcelain', '-z'])
    ]);
    const branches = branchOutput.stdout.trim().split('\n').filter(Boolean).slice(0, 200).map(line => {
      const [name, headSha, current, upstream] = line.replace(/\r$/, '').split('\0');
      const relation = (entry.gitBranches ?? []).find(item => item.branch === name);
      return { name, headSha, current: current === '*', upstream: upstream || null, taskId: relation?.taskId ?? null, baselineHead: relation?.baselineHead ?? null };
    });
    const history = historyOutput.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [sha, parents, timestamp, subject] = line.replace(/\r$/, '').split('\0');
      return { sha, parents: parents ? parents.split(' ') : [], committedAt: Number(timestamp) * 1000, subject: safeText(subject) };
    });
    const registrations = registry.list(), worktrees = [];
    let row = null;
    const flush = () => {
      if (!row?.path) return;
      const registered = registrations.find(item => samePath(item.root, row.path));
      const relation = registered?.gitWorktree;
      const managed = !!relation && isInsideRoot(managedBase, registered.root) && !samePath(managedBase, registered.root);
      worktrees.push({ workspaceId: registered?.id ?? null, name: registered?.name ?? 'External worktree', branch: row.branch ?? null, headSha: row.headSha ?? null,
        current: samePath(entry.root, row.path), locked: !!row.locked, prunable: !!row.prunable, managed,
        taskId: managed ? relation.taskId : null, parentWorkspaceId: managed ? relation.parentWorkspaceId : null, baselineHead: managed ? relation.baselineHead : null });
    };
    for (const field of worktreeOutput.stdout.split('\0')) {
      if (!field) { flush(); row = null; continue; }
      const separator = field.indexOf(' '), key = separator < 0 ? field : field.slice(0, separator), value = separator < 0 ? '' : field.slice(separator + 1);
      if (key === 'worktree') row = { path: value };
      else if (row && key === 'HEAD') row.headSha = value;
      else if (row && key === 'branch') row.branch = value.replace(/^refs\/heads\//, '');
      else if (row && ['locked', 'prunable'].includes(key)) row[key] = true;
    }
    flush();
    const entries = enrichEntries(entry.root, status.entries);
    return { workspaceId: entry.id, git: { ...status, repoRoot: undefined, entries }, conflicts: entries.filter(item => item.conflict), branches, history, worktrees: worktrees.slice(0, 200), tasks,
      worktreeRelation: entry.gitWorktree ?? null, truncated: status.entries.length > 1000 || worktrees.length > 200 || branchOutput.stdout.split('\n').filter(Boolean).length > 200 };
  }

  async function validate(entry, params) {
    if (Object.keys(params).some(key => !['id', 'taskId', 'branch', 'expectedHead', 'actor'].includes(key))) fail('INVALID_PARAMS', 'Git creation accepts only Workspace, Task, branch and expected HEAD');
    const { branch, expectedHead, taskId } = params;
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 200) fail('TASK_REQUIRED', 'Git creation requires an existing Task');
    let task;
    try { task = await getTask(taskId); } catch { fail('TASK_NOT_AUTHORIZED', 'Task is unavailable'); }
    if (!task) fail('TASK_NOT_AUTHORIZED', 'Task is unavailable');
    if (task.workspaceId !== entry.id) fail('TASK_WORKSPACE_MISMATCH', 'Task is not associated with this source Workspace');
    if (task.childContract?.mode === 'read-only') fail('TASK_CHILD_READ_ONLY', 'Read-only child Tasks cannot create Git branches or worktrees');
    if (['completed', 'failed', 'cancelled'].includes(task.status)) fail('TASK_NOT_AUTHORIZED', 'Terminal Tasks cannot create Git branches or worktrees');
    if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch === 'HEAD' || branch.startsWith('refs/')) fail('GIT_BRANCH_INVALID', 'A literal local branch name is required');
    try { if ((await gitRun(entry.root, ['check-ref-format', '--branch', branch])).stdout.trim() !== branch) fail('GIT_BRANCH_INVALID', 'Invalid branch'); } catch { fail('GIT_BRANCH_INVALID', 'Invalid local branch name'); }
    if (!/^[a-f0-9]{40}$/.test(expectedHead ?? '')) fail('GIT_HEAD_CHANGED', 'Git creation requires the exact current commit');
    const status = await gitStatus(entry.root, { completeFiles: true });
    if (!status.isRepo || !samePath(status.repoRoot, fs.realpathSync.native(entry.root))) fail('GIT_ROOT_REQUIRED', 'Git creation requires the registered repository root');
    if (status.headSha !== expectedHead) fail('GIT_HEAD_CHANGED', 'Repository HEAD changed; refresh and review again');
    if (status.entries.some(item => conflictCodes.has(item.x + item.y))) fail('GIT_OPERATION_IN_PROGRESS', 'Review unresolved Git conflicts before creating a branch or worktree');
    return { branch, expectedHead, taskId };
  }

  async function create(entry, params, { worktree = false } = {}) {
    const binding = await validate(entry, params);
    const actor = params.actor ?? 'capability-broker';
    if (!worktree) {
      try { await gitRun(entry.root, ['update-ref', '-m', 'CetaMesh approved branch', 'refs/heads/' + binding.branch, binding.expectedHead, '0'.repeat(40)]); }
      catch { fail('GIT_BRANCH_CREATE_FAILED', 'Branch already exists, is locked or changed concurrently; existing refs were preserved'); }
      try { registry.recordGitBranch(entry.id, binding); }
      catch { fail('GIT_REGISTRATION_REVIEW_REQUIRED', 'Branch was created but its Task relation could not be persisted; review before retrying', { effectStatus: 'unknown', ...binding }); }
      record(entry, actor, 'git.branch.create', binding.branch);
      return { created: true, workspaceId: entry.id, ...binding };
    }
    fs.mkdirSync(stateDir, { recursive: true });
    const stateReal = fs.realpathSync.native(stateDir);
    const base = resolveInside(stateReal, 'agent-worktrees', { forWrite: true }).absolute;
    if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) fail('WORKTREE_ROOT_INVALID', 'Managed worktree directory must not be a link');
    fs.mkdirSync(base, { recursive: true });
    const baseReal = fs.realpathSync.native(base);
    if (!isInsideRoot(stateReal, baseReal)) fail('WORKTREE_ROOT_INVALID', 'Managed worktree directory escaped StateDir');
    const target = resolveInside(baseReal, crypto.randomUUID(), { forWrite: true }).absolute;
    if (fs.existsSync(target)) fail('WORKTREE_EXISTS', 'Generated worktree destination already exists');
    // Explicit baseline and a new branch: Git refuses occupied paths and existing refs.
    try { await gitRun(entry.root, ['-c', 'submodule.recurse=false', 'worktree', 'add', '-b', binding.branch, '--', target, binding.expectedHead]); }
    catch { fail('GIT_WORKTREE_CREATE_FAILED', 'Worktree creation did not complete; inspect Git worktree state before retrying', { effectStatus: 'unknown', ...binding }); }
    let workspace;
    try { workspace = registry.create({ name: binding.branch.slice(0, 100), root: target, gitWorktree: { parentWorkspaceId: entry.id, taskId: binding.taskId, branch: binding.branch, baselineHead: binding.expectedHead } }); registry.recordGitBranch(entry.id, binding); }
    catch { fail('GIT_REGISTRATION_REVIEW_REQUIRED', 'Worktree was created but registration needs review; its directory and branch were preserved', { effectStatus: 'unknown', ...binding }); }
    record(entry, actor, 'git.worktree.create', binding.branch);
    return { created: true, ...binding, parentWorkspaceId: entry.id, workspace: { id: workspace.id, name: workspace.name, root: workspace.root, gitWorktree: workspace.gitWorktree } };
  }
  return { overview, create };
}
