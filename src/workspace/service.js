// CetaMesh Workspace v1 —— 桌面工作区服务（阶段 05）。
//
// 分层：IPC(workspace.*) → 本模块（方法白名单 + 参数收敛 + 策略/审批）→
//       boundary.js（安全裁决）+ tools.js（工具实现）+ registry.js（清单）。
//
// 安全立场（与 memory/service.js 一致）：
// - workspace.* 只经桌面 Shell 的命名管道暴露（src/app/ipc-runtime.js 路由），
//   调用方就是用户控制面；方法白名单之外一律 METHOD_NOT_FOUND。
// - 所有文件路径只接受"相对当前工作区 root"的输入，绝对路径 / 越界输入由
//   boundary 拒绝。服务层不出现任何绕过 boundary 的直连 fs 调用。
// - git.commit 受工作区策略约束：默认 'approval'，进入待审批队列，由用户
//   显式 decide 后才执行；'allow' 直通；'deny' 拒绝。审批请求 10 分钟过期。
// - workspace.remove 只移除登记，绝不删除用户目录。

import { WorkspaceBoundaryError, isInsideRoot } from './boundary.js';
import {
  WorkspaceRegistryError,
  workspaceRegistryFile,
  createWorkspaceRegistry
} from './registry.js';
import {
  WorkspaceToolError,
  fileSearch,
  gitCommit,
  prepareGitCommit,
  gitDiff,
  gitStatus,
  readFile,
  testRun,
  writeFile,
  applyWorkspaceChanges
} from './tools.js';
import { createGitProduct } from './git-product.js';
import { recoverWorkspaceImports } from './transaction.js';
import { isManagedWorktree } from './managed-worktree.js';
import { workspaceContentProof } from './handoff-facts.js';

const GIT_INFO_TTL_MS = 5000;

export function createWorkspaceService({ stateDir, excludedRoots = [], now = () => Date.now(), audit = () => {}, getTask, listTasks } = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new Error('createWorkspaceService 需要 stateDir');
  }
  const registry = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir), now });
  const recovery = new Map();
  function recoverEntry(workspace) {
    try { recoverWorkspaceImports(workspace.root); }
    catch (error) {
      // A retained import belongs to one project. Preserve its raw evidence and
      // fence that execution root, rather than taking every other project down.
      recovery.set(workspace.root, { status: 'blocked', code: 'WORKSPACE_RECOVERY_REQUIRED',
        causeCode: error?.code === 'ENOENT' ? 'IMPORT_JOURNAL_INCOMPLETE' : String(error?.code ?? 'IMPORT_JOURNAL_INVALID') });
    }
  }
  for (const workspace of registry.list()) recoverEntry(workspace);
  const gitInfoCache = new Map();
  const pendingExecutions = new Set();

  function fail(code, message) {
    throw Object.assign(new Error(message), { code });
  }

  function requireWorkspace(params) {
    const id = String(params?.id ?? '').trim() || registry.getActiveId();
    if (!id) fail('WORKSPACE_NOT_SELECTED', '未指定工作区，也没有当前工作区（先 workspace.open）');
    return registry.get(id);
  }

  function assertWritable(entry, { pendingId = null } = {}) {
    if (importRecoveryState(entry).status !== 'blocked') recoverEntry(entry);
    if (importRecoveryState(entry).status === 'blocked' || pendingRecoveryState(entry, pendingId)) fail('WORKSPACE_RECOVERY_REQUIRED', '项目存在执行中或未核实的恢复记录；原文件与日志已保留，核对前暂停执行');
    return entry;
  }

  function managedIsolation(entry) {
    return isManagedWorktree(entry, { stateDir, resolveWorkspace: id => {
      try { return registry.get(id); } catch { return null; }
    } });
  }

  function importRecoveryState(entry) {
    // Identity changes and alternate ancestor/descendant registrations must not
    // grant another write path to the same unresolved project files.
    for (const [root, state] of recovery) {
      if (isInsideRoot(root, entry.root) || isInsideRoot(entry.root, root)) return state;
    }
    return { status: 'ready' };
  }

  function pendingRecoveryState(entry, ownedId = null) {
    for (const request of registry.listPending()) {
      if (!['executing', 'outcome-unknown'].includes(request.status)) continue;
      if (request.id === ownedId && pendingExecutions.has(ownedId)) continue;
      let source;
      try { source = registry.get(request.workspaceId); } catch { continue; }
      if (isInsideRoot(source.root, entry.root) || isInsideRoot(entry.root, source.root)) {
        return { status: 'blocked', code: 'WORKSPACE_RECOVERY_REQUIRED', causeCode: 'GIT_COMMIT_RECONCILIATION_REQUIRED' };
      }
    }
    return null;
  }

  function recoveryState(entry) {
    const state = importRecoveryState(entry);
    return state.status === 'blocked' ? state : pendingRecoveryState(entry) ?? state;
  }

  function record(ws, actor, action, detail) {
    registry.recordActivity({ workspaceId: ws?.id ?? null, actor, action, detail });
    if (action !== 'read' && action !== 'file.search' && action !== 'git.status' && action !== 'git.diff') {
      audit({ action: `workspace.${action}`, workspaceId: ws?.id ?? null, actor });
    }
  }

  async function gitInfo(entry, { refresh = false } = {}) {
    const cached = gitInfoCache.get(entry.id);
    if (!refresh && cached && Date.now() - cached.at < GIT_INFO_TTL_MS) return cached.info;
    const info = await gitStatus(entry.root).catch((error) => ({
      isRepo: false,
      error: error?.code ?? 'GIT_FAILED'
    }));
    gitInfoCache.set(entry.id, { at: Date.now(), info });
    return info;
  }

  async function workspaceSummary(entry, { refresh = false } = {}) {
    const git = await gitInfo(entry, { refresh });
    return {
      id: entry.id,
      name: entry.name,
      root: entry.root,
      createdAt: entry.createdAt,
      lastOpenedAt: entry.lastOpenedAt,
      active: registry.getActiveId() === entry.id,
      settings: entry.settings,
      recovery: recoveryState(entry),
      gitWorktree: entry.gitWorktree ?? null,
      managedIsolation: managedIsolation(entry),
      git: { isRepo: git.isRepo, branch: git.branch, headSha: git.headSha, dirty: git.dirty,
        ...(git.error ? { error: git.error } : {}) }
    };
  }

  function normalizeRelPath(params, field = 'path') {
    const value = params?.[field];
    const text = String(value ?? '').trim();
    if (!text) fail('PATH_REQUIRED', `需要 ${field}（相对工作区根目录的路径）`);
    if (text.length > 1024) fail('PATH_INVALID', '路径过长（>1024 字符）');
    return text;
  }

  async function executeCommit(entry, { message, ...selection }, pendingId = null) {
    assertWritable(entry, { pendingId });
    if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', '当前工作区策略禁止 commit');
    const result = await gitCommit(entry.root, { message, ...selection });
    record(entry, 'user', 'git.commit', result.committed ? `${message}（${result.sha ?? 'no-sha'}）` : message);
    return result;
  }

  const gitProduct = createGitProduct({ stateDir, registry, getTask, listTasks, record });

  const handlers = {
    // Local read contract for startup; no Git child, file content, audit or recovery.
    'workspace.health': () => { const rows=registry.list(),active=registry.getActiveId();return {registered:rows.length,activeValid:!active||rows.some(row=>row.id===active),blockedProjects:rows.filter(row=>recoveryState(row).status==='blocked').length}; },
    // ── 管理 ──
    'workspace.create': async (p) => {
      const entry = registry.create({
        name: p?.name,
        root: p?.root,
        createIfMissing: p?.createIfMissing === true
      });
      recoverEntry(entry);
      record(entry, 'user', 'create', entry.root);
      return { workspace: await workspaceSummary(entry) };
    },

    'workspace.list': async () => {
      const entries = registry.list();
      const workspaces = [];
      for (const entry of entries) workspaces.push(await workspaceSummary(entry));
      return { workspaces, activeId: registry.getActiveId() };
    },

    'workspace.open': async (p) => {
      const entry = registry.open(String(p?.id ?? ''));
      record(entry, 'user', 'open', entry.root);
      return { workspace: await workspaceSummary(entry, { refresh: true }) };
    },

    'workspace.rename': async (p) => {
      const entry = registry.rename(String(p?.id ?? ''), p?.name);
      record(entry, 'user', 'rename', entry.name);
      return { workspace: await workspaceSummary(entry) };
    },

    'workspace.remove': async (p) => {
      const entry = registry.get(String(p?.id ?? ''));
      if (recoveryState(entry).status === 'blocked') fail('WORKSPACE_RECOVERY_REQUIRED', '项目恢复尚未确认；保留登记以避免丢失恢复归属');
      // Query the synchronous Task store immediately before removing the execution scope.
      const linked = listTasks?.({workspaceId:entry.id,statuses:['queued','running','waiting','paused','blocked'],limit:1});
      if (linked && !Array.isArray(linked.tasks)) fail('WORKSPACE_RECOVERY_REQUIRED', '任务归属当前无法核验');
      if (linked?.tasks.length) fail('WORKSPACE_TASK_ACTIVE', '项目仍有关联的未结束任务；请先核验并结束任务');
      const result = registry.remove(entry.id);
      gitInfoCache.delete(entry.id);
      record(entry, 'user', 'remove', `${entry.name}（目录保留）`);
      return result;
    },

    'workspace.info': async (p) => {
      const entry = requireWorkspace(p);
      const git = await gitInfo(entry, { refresh: p?.refreshGit === true });
      let taskRelation = { enabled: false, status: 'unavailable', total: null, tasks: [], note: 'Task service unavailable' };
      if (typeof listTasks === 'function') {
        try {
          const result = await listTasks({ workspaceId: entry.id, limit: 20 });
          const rows = Array.isArray(result) ? result : result?.tasks ?? [];
          // The injected runtime can preserve bounded list metadata; old array
          // adapters remain readable without claiming a complete project total.
          taskRelation = { enabled: true, status: 'available',
            total: Number.isSafeInteger(result?.total) ? result.total : rows.length < 20 ? rows.length : null,
            tasks: rows.slice(0, 20).map(row => ({ id: row.id, goal: row.goal, status: row.status })) };
        } catch { taskRelation = { enabled: true, status: 'unknown', total: null, tasks: [], code: 'TASK_RELATION_UNAVAILABLE' }; }
      }
      return {
        workspace: await workspaceSummary(entry),
        git,
        recentFiles: entry.recentFiles ?? [],
        artifacts: entry.artifacts ?? [],
        activity: registry.listActivity({ workspaceId: entry.id, limit: 30 }),
        pending: registry.listPending({ workspaceId: entry.id }),
        taskRelation
      };
    },

    'workspace.settings': async (p) => {
      const entry = registry.updateSettings(String(p?.id ?? ''), p?.patch);
      record(entry, 'user', 'settings', JSON.stringify(p?.patch ?? {}).slice(0, 200));
      return { workspace: await workspaceSummary(entry) };
    },

    // ── 工具 ──
    'workspace.read': async (p) => {
      const entry = requireWorkspace(p);
      const relPath = normalizeRelPath(p);
      const result = readFile(entry.root, relPath, { maxBytes: p?.maxBytes ?? p?.maxChars, offset: p?.offset ?? 0 });
      registry.recordFileAccess(entry.id, { relPath, action: 'read' });
      record(entry, String(p?.actor ?? 'user'), 'read', relPath);
      return result;
    },

    'workspace.write': async (p) => {
      const entry = assertWritable(requireWorkspace(p));
      const relPath = normalizeRelPath(p);
      const result = writeFile(entry.root, relPath, p?.content, { createDirs: p?.createDirs !== false,
        append: p?.append === true, expectedHash: p?.expectedHash });
      registry.recordFileAccess(entry.id, { relPath, action: 'write' });
      if (p?.artifact === true) registry.recordArtifact(entry.id, { relPath, note: p?.artifactNote });
      record(entry, String(p?.actor ?? 'user'), 'write', relPath);
      return result;
    },

    'workspace.file.search': async (p) => {
      const entry = requireWorkspace(p);
      const result = fileSearch(entry.root, {
        query: p?.query,
        glob: p?.glob,
        searchPath: p?.path ?? '.',
        offset: p?.offset,
        restricted: p?.searchRestricted === true,
        includeHidden: p?.includeHidden === true,
        skipNames: entry.settings?.search?.skipNames,
        limit: p?.maxResults ?? p?.limit
      });
      record(entry, String(p?.actor ?? 'user'), 'file.search', String(p?.query ?? p?.glob ?? ''));
      return result;
    },

    'workspace.git.overview': async p => gitProduct.overview(requireWorkspace(p)),
    'workspace.git.branch.create': async () => fail('GIT_APPROVAL_REQUIRED', 'Git branch creation must use Capability Broker approval'),
    'workspace.git.worktree.create': async () => fail('GIT_APPROVAL_REQUIRED', 'Git worktree creation must use Capability Broker approval'),

    'workspace.git.status': async (p) => {
      const entry = requireWorkspace(p);
      const git = p?.completeFiles === true
        ? await gitStatus(entry.root, { completeFiles: true })
        : await gitInfo(entry, { refresh: true });
      record(entry, String(p?.actor ?? 'user'), 'git.status', '');
      return { git };
    },

    'workspace.git.diff': async (p) => {
      const entry = requireWorkspace(p);
      const result = await gitDiff(entry.root, { cached: p?.cached === true, context: p?.context, excludeSensitive: p?.excludeSensitive === true, path: p?.path });
      record(entry, String(p?.actor ?? 'user'), 'git.diff', '');
      return result;
    },

    'workspace.git.commit': async (p) => {
      const entry = assertWritable(requireWorkspace(p));
      const message = String(p?.message ?? '').trim();
      if (!message) fail('COMMIT_MESSAGE_REQUIRED', 'commit 需要提交信息');
      const policy = entry.settings?.policies?.gitCommit ?? 'approval';

      if (policy === 'deny') {
        record(entry, String(p?.actor ?? 'user'), 'git.commit.denied', message);
        fail('GIT_COMMIT_DENIED', '当前工作区策略禁止 commit（policies.gitCommit=deny）');
      }
      const selection = await prepareGitCommit(entry.root,p);
      if (policy === 'allow') {
        return { status: 'committed', ...(await executeCommit(entry, { message, ...selection })) };
      }
      const request = registry.addPendingCommit({ workspaceId: entry.id, message, ...selection });
      record(entry, String(p?.actor ?? 'user'), 'git.commit.pending', message);
      return {
        status: 'pending',
        requestId: request.id,
        expiresAt: request.expiresAt,
        note: 'commit 需要用户批准（workspace.pending.decide）'
      };
    },

    'workspace.test.run': async (p) => {
      const entry = assertWritable(requireWorkspace(p));
      const result = await testRun(entry.root, entry.settings?.testCommand, { timeoutMs: p?.timeoutMs });
      record(entry, String(p?.actor ?? 'user'), 'test.run', `exit=${result.exitCode}`);
      return result;
    },

    // ── 审批 ──
    'workspace.pending.list': async (p) => {
      return { pending: registry.listPending({ workspaceId: p?.workspaceId ?? null }) };
    },

    'workspace.pending.decide': async (p) => {
      const id = String(p?.requestId ?? '');
      if (pendingExecutions.has(id)) fail('PENDING_BUSY', '该审批已在执行，请等待当前结果');
      const request = registry.getPending(id);
      if (!['pending', 'failed-no-effect'].includes(request.status ?? 'pending')) {
        fail('PENDING_RECONCILIATION_REQUIRED', '审批执行结果未确认；核对 Git 状态前不能重放或丢弃记录');
      }
      const entry = assertWritable(registry.get(request.workspaceId));
      if (p?.approve !== true) {
        registry.takePending(id);
        record(entry, 'user', 'git.commit.rejected', request.message);
        return { status: 'rejected', requestId: request.id };
      }
      if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', '当前工作区策略禁止 commit');
      registry.claimPending(id); // Durable intent before any Git side effect.
      pendingExecutions.add(id);
      try {
        const result = await executeCommit(entry, request, id);
        registry.takePending(id);
        gitInfoCache.delete(entry.id);
        return { status: 'committed', requestId: request.id, ...result };
      } catch (error) {
        // These errors originate before update-ref. Any other failure could have
        // lost a successful response and must retain its execution fence.
        const noEffect = ['GIT_INDEX_BUSY', 'GIT_HEAD_CHANGED', 'GIT_OPERATION_IN_PROGRESS',
          'WORKSPACE_CONFLICT', 'GIT_NOT_REPOSITORY', 'GIT_COMMIT_DENIED', 'COMMIT_PATHS_REQUIRED',
          'COMMIT_BASELINE_REQUIRED', 'COMMIT_HASHES_REQUIRED', 'COMMIT_PATH_INVALID', 'COMMIT_ROOT_REQUIRED',
          'COMMIT_MESSAGE_REQUIRED', 'COMMIT_MESSAGE_TOO_LONG'].includes(error?.code);
        registry.recordPendingFailure(id, { noEffect, code: error?.code });
        throw Object.assign(error, { effectStatus: noEffect ? 'no-effect' : 'unknown', requestId: id });
      } finally { pendingExecutions.delete(id); }
    }
  };

  async function execute({ method, params } = {}) {
    const handler = handlers[method];
    if (!handler) fail('METHOD_NOT_FOUND', `Unknown workspace method: ${method}`);
    return handler(params ?? {});
  }

  function applyChanges({ id, changes, actor = 'capability-broker' } = {}) {
    const entry = assertWritable(requireWorkspace({ id }));
    let result;
    try { result = applyWorkspaceChanges(entry.root, changes); }
    catch (error) {
      if (['WORKSPACE_RECOVERY_REQUIRED', 'IMPORT_JOURNAL_INVALID', 'IMPORT_JOURNAL_INCOMPLETE'].includes(error?.code)) {
        recovery.set(entry.root, { status: 'blocked', code: 'WORKSPACE_RECOVERY_REQUIRED', causeCode: error.code });
      }
      throw error;
    }
    registry.recordFileChanges(entry.id, result.changes, String(actor));
    for (const change of result.changes) audit({ action: `workspace.${change.action}`, workspaceId: entry.id, actor: String(actor) });
    return { workspaceId: entry.id, ...result };
  }

  /**
   * 只读内部入口（Continuity Workspace Reconciliation 适配用）：按 id 取登记条目投影。
   * 不存在时返回 null（不抛错，由调用方决定"事实不可得"的语义）；绝不触发审计或状态写。
   */
  function describeWorkspace(id) {
    const text = String(id ?? '').trim();
    if (!text) return null;
    try {
      const entry = registry.get(text);
      if (recoveryState(entry).status === 'blocked') return null;
      return { id: entry.id, name: entry.name, root: entry.root, managedIsolation: managedIsolation(entry) };
    } catch {
      return null;
    }
  }

  // Trusted in-process entry only. Transport approval flags cannot call this path.
  async function executeApprovedGit({ method, params = {} } = {}) {
    if (method === 'workspace.git.commit') {
      const entry = assertWritable(requireWorkspace(params));
      if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', 'Workspace policy denies commits');
      const selection = await prepareGitCommit(entry.root, params);
      const result = await executeCommit(entry, { message: params.message, ...selection });
      gitInfoCache.delete(entry.id);
      return { status: 'committed', ...result };
    }
    if (!['workspace.git.branch.create', 'workspace.git.worktree.create'].includes(method)) fail('METHOD_NOT_FOUND', 'Unknown approved Git effect');
    return gitProduct.create(assertWritable(requireWorkspace(params)), params, { worktree: method === 'workspace.git.worktree.create' });
  }

  function workspacesOverlap(leftId, rightId) {
    if (leftId === rightId) return true;
    if (!leftId || !rightId) return false;
    const left = registry.get(leftId).root, right = registry.get(rightId).root;
    return isInsideRoot(left, right) || isInsideRoot(right, left);
  }

  function contentProof(entry, relevantFiles = []) {
    return workspaceContentProof(entry.root, {
      relevantFiles,
      additionalWorkspaceRoots: registry.list().map(row => row.root),
      excludedRoots: [stateDir, ...excludedRoots],
      ...(managedIsolation(entry) ? { trustedSourceRoot: entry.root } : {})
    });
  }

  // Core-only observation: identity and exclusions come from this registry.
  // Unlike Owner recovery, reading Handoff facts must never recover an import.
  async function collectContentProof(id, { relevantFiles = [], expectedRoot } = {}) {
    const entry = registry.get(String(id ?? '').trim());
    if (expectedRoot !== undefined && expectedRoot !== entry.root) fail('WORKSPACE_UNVERIFIED', 'Workspace identity changed during observation');
    if (recoveryState(entry).status === 'blocked') fail('WORKSPACE_RECOVERY_REQUIRED', 'Workspace recovery remains unconfirmed');
    return contentProof(entry, relevantFiles);
  }

  // Owner recovery intentionally retains its existing write/recovery fence.
  async function collectRecoveryProof(id) {
    return contentProof(assertWritable(requireWorkspace({ id })));
  }

  return { execute, executeApprovedGit, describeWorkspace, applyChanges, workspacesOverlap, collectContentProof, collectRecoveryProof };
}

export { WorkspaceBoundaryError, WorkspaceRegistryError, WorkspaceToolError };
