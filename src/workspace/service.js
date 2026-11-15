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

import { WorkspaceBoundaryError, isInsideRoot, canonicalizeRoot } from './boundary.js';
import {
  WorkspaceRegistryError,
  workspaceRegistryFile,
  createWorkspaceRegistry
} from './registry.js';
import {
  WorkspaceToolError,
  fileSearchAsync,
  gitCommit,
  prepareGitCommit,
  gitDiff,
  gitStatus,
  readFileAsync,
  testRun,
  writeFile,
  applyWorkspaceChanges
} from './tools.js';
import { createGitProduct } from './git-product.js';
import { recoverWorkspaceImports, workspaceImportEvidence, inspectWorkspaceByteTransaction } from './transaction.js';
import { isManagedWorktree } from './managed-worktree.js';
import { workspaceContentProof } from './handoff-facts.js';
import { assertObservationActive } from './observation-abort.js';
import { postWriteVerificationSnapshot } from '../model/post-write-verification.js';
import { inspectIsolatedChildWorkspace as inspectChildWorkspace } from './isolated-child-proof.js';

const GIT_INFO_TTL_MS = 5000;

export function createWorkspaceService({ stateDir, excludedRoots = [], now = () => Date.now(), audit = () => {}, getTask, listTasks, nativeExecutable } = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new Error('createWorkspaceService 需要 stateDir');
  }
  const registry = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir), now });
  const recovery = new Map();
  const knownGitNoEffect = new WeakSet();
  const gitSettlements = new WeakMap();
  // One settlement may consume this exact Core error; copied fields or reuse
  // by a later executor cannot clear that later dispatch's effect fence.
  function isKnownGitNoEffect(error) { return knownGitNoEffect.delete(error); }
  function retainRecovery(workspace, error, verifiedBatches = []) {
      let retained = recovery.get(workspace.root);
      if (!retained) {
        let batches = null;
        try { batches = workspaceImportEvidence(workspace.root, { verifiedBatches }); }
        catch { batches = null; /* Incomplete evidence cannot authorize recovery. */ }
        retained = { batches };
      }
      // A retained import belongs to one project. Preserve its raw evidence and
      // fence that execution root, rather than taking every other project down.
      recovery.set(workspace.root, { ...retained, status: 'blocked', code: 'WORKSPACE_RECOVERY_REQUIRED',
        causeCode: error?.code === 'ENOENT' ? 'IMPORT_JOURNAL_INCOMPLETE' : String(error?.code ?? 'IMPORT_JOURNAL_INVALID') });
  }
  function recoverEntry(workspace, { ownerReview = false } = {}) {
    const retained = recovery.get(workspace.root);
    if (retained && (!ownerReview || !retained.batches?.length)) return;
    const verifiedBatches = [];
    try {
      recoverWorkspaceImports(workspace.root, {
        ...(retained ? { expectedBatches: retained.batches } : {}),
        onVerified: proof => {
          verifiedBatches.push(proof);
          if (retained) retained.batches = retained.batches.map(row => row.name === proof.name && row.sha256 === proof.sha256 ? proof : row);
        },
        // Record only affirmative settlement of each original batch. Partial
        // progress remains retryable; absence alone never counts as settlement.
        onRecovered: proof => { if (retained) retained.batches = retained.batches.filter(row => row.name !== proof.name || row.sha256 !== proof.sha256); }
      });
      if (retained && retained.batches.length === 0) recovery.delete(workspace.root);
    } catch (error) {
      retainRecovery(workspace, error, verifiedBatches);
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

  // Git validation runs before approval and again before dispatch. Inspect the
  // existing import owner without executing its rollback or private cleanup.
  // Settlement remains in the existing Workspace recovery path.
  function assertGitWritable(entry) {
    const refuse = () => fail('WORKSPACE_RECOVERY_REQUIRED', '项目有未核实的导入记录，请先完成工作区恢复；Git 校验不会改写文件');
    if (importRecoveryState(entry).status === 'blocked' || pendingRecoveryState(entry)) refuse();
    let batches;
    try { batches = workspaceImportEvidence(entry.root); }
    catch (error) { retainRecovery(entry, error); refuse(); }
    if (batches.length) {
      retainRecovery(entry, {code: 'IMPORT_RECONCILIATION_REQUIRED'}, batches);
      refuse();
    }
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
      if (isInsideRoot(root, entry.root) || isInsideRoot(entry.root, root)) {
        const { batches, ...projection } = state;
        return projection;
      }
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

  function readExecution(entry, context) {
    return { signal: context.signal, restricted: context.restricted === true,
      consumeReadBytes: typeof context.consumeReadBytes === 'function' ? context.consumeReadBytes : undefined,
      assertAuthorized: async () => {
        await context.assertAuthorized?.();
        if (context.signal?.aborted) fail('INVOKE_CANCELLED', 'Workspace read cancelled');
        const live = registry.get(entry.id);
        if (live.root !== entry.root) fail('WORKSPACE_UNVERIFIED', 'Workspace identity changed during read');
      } };
  }

  async function executeCommit(entry, { message, ...selection }, pendingId = null) {
    assertWritable(entry, { pendingId });
    if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', '当前工作区策略禁止 commit');
    const result = await gitCommit(entry.root, { message, ...selection });
    record(entry, 'user', 'git.commit', result.committed ? `${message}（${result.sha ?? 'no-sha'}）` : message);
    return result;
  }

  const gitProduct = createGitProduct({ stateDir, registry, getTask, listTasks, record, nativeExecutable });

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
      const entry = registry.updateSettings(String(p?.id ?? ''), p?.patch, {expectedPostWriteConfigDigest:p?.expectedPostWriteConfigDigest});
      record(entry, 'user', 'settings', JSON.stringify(p?.patch ?? {}).slice(0, 200));
      return { workspace: await workspaceSummary(entry) };
    },

    // ── 工具 ──
    'workspace.read': async (p, context) => {
      const entry = requireWorkspace(p);
      const relPath = normalizeRelPath(p);
      const execution = readExecution(entry, context);
      const result = await readFileAsync(entry.root, relPath, { ...execution, maxBytes: p?.maxBytes ?? p?.maxChars, offset: p?.offset ?? 0 });
      // The helper's last await reauthorizes, then proves the final identities.
      // Do not introduce another awaited window between that proof and delivery.
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

    'workspace.file.search': async (p, context) => {
      const entry = requireWorkspace(p);
      const execution = readExecution(entry, context);
      const result = await fileSearchAsync(entry.root, {
        ...execution,
        query: p?.query,
        glob: p?.glob,
        searchPath: p?.path ?? '.',
        offset: p?.offset,
        restricted: execution.restricted || p?.searchRestricted === true,
        includeHidden: p?.includeHidden === true,
        skipNames: entry.settings?.search?.skipNames,
        limit: p?.maxResults ?? p?.limit
      });
      record(entry, String(p?.actor ?? 'user'), 'file.search', String(p?.query ?? p?.glob ?? ''));
      return result;
    },

    'workspace.git.overview': async p => gitProduct.overview(requireWorkspace(p)),
    'workspace.git.context': (p, context) => gitProduct.context(requireWorkspace(p), {signal: context.signal}),
    'workspace.git.index.review': async p => gitProduct.reviewStaged(requireWorkspace(p), {paths: p.paths}),
    'workspace.git.checkpoint.capture': (p, context) => gitProduct.captureCheckpoint(assertGitWritable(requireWorkspace(p)), {...p,signal:context.signal}),
    'workspace.git.checkpoint.list': p => gitProduct.listCheckpoints(requireWorkspace(p)),
    'workspace.git.checkpoint.preview': p => gitProduct.previewCheckpoint(requireWorkspace(p),p),
    'workspace.git.checkpoint.review': (p,context) => gitProduct.reviewCheckpoint(assertGitWritable(requireWorkspace(p)),p,context),
    'workspace.git.checkpoint.restore': async () => fail('GIT_APPROVAL_REQUIRED','Checkpoint restore requires exact once-only approval'),
    'workspace.git.branch.review': async (p, context) => {
      const entry = requireWorkspace(p);
      let original;
      if (p.mode === 'finish-prepared') original = describeGitRecoveryWorkspace(entry.id);
      else assertGitWritable(entry);
      return {...await gitProduct.reviewSwitch(entry, p, context), ...(original?.dispatchBinding ? {taskId:original.dispatchBinding.taskId} : {})};
    },
    'workspace.git.branch.switch': async () => fail('GIT_APPROVAL_REQUIRED', 'Branch switching requires once-only Capability approval'),
    ...Object.fromEntries(['stage', 'unstage', 'commit.staged'].map(action => ['workspace.git.' + action,
      async () => fail('GIT_APPROVAL_REQUIRED', 'Exact Git index mutations must use Capability Broker approval')])),
    ...Object.fromEntries([['status.page', 'status'], ['history', 'history'], ['branches', 'branches'],
      ['commit.detail', 'commitDetail'], ['preview', 'preview'], ['review', 'reviewPaths']].map(([action, read]) => [
      'workspace.git.' + action, (p, context) => gitProduct[read](requireWorkspace(p), { ...p, signal: context.signal })
    ])),
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

  async function execute({ method, params } = {}, context = {}) {
    const handler = handlers[method];
    if (!handler) fail('METHOD_NOT_FOUND', `Unknown workspace method: ${method}`);
    return handler(params ?? {}, context);
  }

  function applyChanges({ id, changes, actor = 'capability-broker' } = {}) {
    const entry = assertWritable(requireWorkspace({ id }));
    let verifiedBatches = [];
    let result;
    try { result = applyWorkspaceChanges(entry.root, changes, {
      onRecoveryVerified: proof => verifiedBatches.push(proof),
      onRecoverySettled: proof => { verifiedBatches = verifiedBatches.filter(row => row.name !== proof.name || row.sha256 !== proof.sha256); }
    }); }
    catch (error) {
      if (verifiedBatches.length || ['WORKSPACE_RECOVERY_REQUIRED', 'IMPORT_JOURNAL_INVALID', 'IMPORT_JOURNAL_INCOMPLETE'].includes(error?.code)) {
        retainRecovery(entry, error, verifiedBatches);
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

  // Recovery identity is available only to the exact Git descriptor. The
  // ordinary Workspace projection remains fenced, including after restart.
  function describeGitRecoveryWorkspace(id, {currentBinding} = {}) {
    const entry = registry.get(id);
    if (canonicalizeRoot(entry.root) !== entry.root) fail('WORKSPACE_RECOVERY_REQUIRED', 'Registered root changed');
    if (pendingRecoveryState(entry) || registry.list().some(other => other.id !== id
      && (isInsideRoot(entry.root, other.root) || isInsideRoot(other.root, entry.root))))
      fail('WORKSPACE_RECOVERY_REQUIRED', 'Another registration or pending operation overlaps this recovery');
    const raw = inspectWorkspaceByteTransaction(entry.root);
    if (!raw) { assertGitWritable(entry); return {kind:'metadata',id:entry.id,name:entry.name,root:entry.root}; }
    const binding = raw.owner?.dispatchBinding;
    if (!raw || raw.owner.kind !== 'git-branch-switch' || raw.owner.workspaceId !== id || !binding
      || binding.workspaceId !== id || binding.capability !== 'git.branch.switch'
      || !['requestId','fingerprint','approvalId','attemptId'].every(key => typeof binding[key] === 'string' && binding[key].length > 0 && binding[key].length <= 240))
      fail('WORKSPACE_RECOVERY_REQUIRED', 'Original Core dispatch binding is missing or invalid');
    const marker = raw.completion;
    const terminal = marker?.schema === 1 && marker.requestSha256 === raw.evidence.requestSha256
      && JSON.stringify(marker.dispatchBinding) === JSON.stringify(binding) && marker.result?.phase === 'completed'
      && marker.result.targetHead === raw.owner.targetHead && marker.result.targetBranch === raw.owner.targetBranch;
    const attempts = raw.invocations;
    if (!attempts.length || attempts.some((attempt,index) => attempt.state !== 'closed'
      && !(index === attempts.length-1 && (currentBinding && JSON.stringify(attempt.binding)===JSON.stringify(currentBinding)
        || terminal && JSON.stringify(marker.invocationBinding)===JSON.stringify(attempt.binding)))))
      fail('EXECUTION_UNCONFIRMED', 'An exact Git invocation has no positive close or terminal completion proof');
    return {kind:'raw',id: entry.id, name: entry.name, root: entry.root, dispatchBinding: structuredClone(binding),
      closedBindings: attempts.filter(attempt=>!currentBinding||JSON.stringify(attempt.binding)!==JSON.stringify(currentBinding)).map(attempt=>attempt.binding),
      byteTransaction: raw.evidence, terminal, completion: marker};
  }
  function acknowledgeGitResult(result) {
    const held = gitSettlements.get(result);
    if (!held) return {cleanupPending: false};
    const settled = held.raw.settle(), transition = settled.transition;
    if (transition?.terminal && transition.previousEvidence.requestSha256 === held.raw.evidence.requestSha256) {
      if (transition.removed) { recovery.delete(held.entry.root); gitSettlements.delete(result); }
      else {
        // The journal owner positively authorized cleanup. Advance only this
        // derived fence to its verified terminal generation, never on absence.
        try { const batches = workspaceImportEvidence(held.entry.root); recovery.set(held.entry.root, {status:'blocked', code:'WORKSPACE_RECOVERY_REQUIRED', batches}); }
        catch { /* Partial private cleanup remains fenced until its owner verifies it. */ }
      }
    }
    const {transition: _proof, ...projection} = settled;
    // Raw retirement owns only this exact journal obligation. Domain finally
    // may already have retained an anchor, index lock or private index warning.
    const resources=(result.cleanupResources??[]).filter(resource=>!(resource.kind==='workspace-byte-journal'
      &&resource.id===held.raw.evidence.name&&resource.identity===held.raw.evidence.requestSha256));
    for(const resource of projection.cleanupResources??[])if(!resources.some(prior=>JSON.stringify(prior)===JSON.stringify(resource)))resources.push(resource);
    const combined={...projection,cleanupPending:projection.cleanupPending===true||resources.length>0,...(resources.length?{cleanupResources:resources}:{})};
    if(!resources.length)delete result.cleanupResources;
    Object.assign(result,combined);return combined;
  }

  // Trusted in-process entry only. Transport approval flags cannot call this path.
  function admitApprovedBranch(params, context) {
    const entry = requireWorkspace(params);
    if (params.mode === 'finish-prepared') {
      const recovery=describeGitRecoveryWorkspace(entry.id);
      if(recovery.kind==='metadata'&&!context.metadataRecovery)fail('WORKSPACE_RECOVERY_REQUIRED','Original approved metadata-only review is required');
    } else assertGitWritable(entry);
    if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', 'Workspace policy denies Git mutations');
    return entry;
  }
  async function validateApprovedGit({method, params = {}} = {}, context = {}) {
    if(method==='workspace.git.checkpoint.restore'){
      const entry=assertGitWritable(requireWorkspace(params));
      if(entry.settings?.policies?.gitCommit==='deny')fail('GIT_COMMIT_DENIED','Workspace policy denies Git mutations');
      return gitProduct.validateCheckpointRestore(entry,params);
    }
    if (method === 'workspace.git.branch.switch') {
      const entry = admitApprovedBranch(params,context);
      return gitProduct.validateSwitch(entry, params, {metadataRecovery:context.metadataRecovery});
    }
    const action = {'workspace.git.stage': 'stage', 'workspace.git.unstage': 'unstage', 'workspace.git.commit.staged': 'commit'}[method];
    if (!action) fail('METHOD_NOT_FOUND', 'Unknown exact Git index action');
    const entry = assertGitWritable(requireWorkspace(params));
    if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', 'Workspace policy denies Git mutations');
    return gitProduct.validateIndexAction(entry, params, action);
  }
  async function executeApprovedGit({ method, params = {} } = {}, context = {}) {
    if(method==='workspace.git.checkpoint.restore'){
      let entry,raw,returned;
      try{entry=assertGitWritable(requireWorkspace(params));if(!context.dispatchBinding||context.dispatchBinding.capability!=='git.checkpoint.restore')fail('GIT_APPROVAL_REQUIRED','Exact checkpoint dispatch binding is required');
        if(entry.settings?.policies?.gitCommit==='deny')fail('GIT_COMMIT_DENIED','Workspace policy denies Git mutations');
      }catch(error){knownGitNoEffect.add(error);throw error;}
      try{return returned=await gitProduct.restoreCheckpoint(entry,params,{signal:context.signal,application:{dispatchBinding:context.dispatchBinding,assertAvailable:context.assertAvailable,
        retainTransaction(value){raw=value;},deferSettlement(result,value){gitSettlements.set(result,{entry,raw:value});}}});}
      catch(error){if(gitProduct.isKnownCheckpointNoEffectError(error))knownGitNoEffect.add(error);if(raw||error.byteTransaction)retainRecovery(entry,error);throw error;}
      finally{try{if(raw){raw.closeGitInvocation(context.dispatchBinding);if(returned)returned.byteTransaction=raw.evidence;retainRecovery(entry,{code:'GIT_CHECKPOINT_REVIEW_REQUIRED'});}}catch{retainRecovery(entry,{code:'EXECUTION_UNCONFIRMED'});}gitInfoCache.delete(entry.id);}
    }
    if (method === 'workspace.git.branch.switch') {
      // The domain executor owns its exact branded, effect-free preparation.
      // Do not run a second unbranded async preparation after Broker intent.
      let entry; const binding = context.dispatchBinding;
      try {
        entry = admitApprovedBranch(params,context);
        if (!binding) fail('GIT_APPROVAL_REQUIRED', 'Core dispatch context is required');
      } catch (error) {
        // Only this exact new invocation is unexecuted. The inspected foreign
        // import, prior Git journal and all derived recovery fences stay intact.
        const refusal=Object.assign(new Error(error.message),{code:error.code??'GIT_ADMISSION_REFUSED',effectStatus:'none'});
        knownGitNoEffect.add(refusal);throw refusal;
      }
      let invocation, returned;
      try {
        return returned = await gitProduct.switchBranch(entry, params, params.actor, {signal: context.signal, application: {
          dispatchBinding: binding, assertAvailable: context.assertAvailable, metadataRecovery:context.metadataRecovery,
          retainTransaction(raw) { invocation = raw; },
          deferSettlement(result, raw) { gitSettlements.set(result, {entry, raw}); }
        }});
      } catch (error) {
        if (gitProduct.isKnownBranchNoEffectError(error)) knownGitNoEffect.add(error);
        if (error.byteTransaction || invocation) retainRecovery(entry,error);
        throw error;
      } finally {
        // Domain awaits real native/Git close, including abort and every Git
        // observation. Only this exact invocation can establish local quiescence.
        try {
          const raw = invocation ?? inspectWorkspaceByteTransaction(entry.root);
          if (raw && JSON.stringify(raw.invocations.at(-1)?.binding) === JSON.stringify(binding)) {
            raw.closeGitInvocation(binding);
            if (returned) returned.byteTransaction = raw.evidence;
          }
          if (raw) retainRecovery(entry, {code:'GIT_BRANCH_SWITCH_REVIEW_REQUIRED'});
        } catch { if (invocation) retainRecovery(entry,{code:'EXECUTION_UNCONFIRMED'}); }
        gitInfoCache.delete(entry.id);
      }
    }
    const action = {'workspace.git.stage': 'stage', 'workspace.git.unstage': 'unstage', 'workspace.git.commit.staged': 'commitStaged'}[method];
    if (action) {
      const entry = assertGitWritable(requireWorkspace(params));
      if (entry.settings?.policies?.gitCommit === 'deny') fail('GIT_COMMIT_DENIED', 'Workspace policy denies Git mutations');
      try {
        const result = await gitProduct[action](entry, params, params.actor); gitInfoCache.delete(entry.id); return result;
      } catch (error) {
        // Admission belongs to Workspace. Only the Git domain's own proof
        // after successful admission can classify this Git attempt.
        if (gitProduct.isKnownIndexNoEffectError(error)) knownGitNoEffect.add(error);
        throw error;
      }
    }
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

  function inspectIsolatedChildWorkspace({workspaceId,sourceWorkspaceId,parentTaskId,baselineHead,branch}) {
    return inspectChildWorkspace(registry.get(workspaceId),{stateDir,resolveWorkspace:id=>registry.get(id),sourceWorkspaceId,parentTaskId,baselineHead,branch});
  }
  async function captureIsolatedChildWorkspace(binding) {
    const before=inspectIsolatedChildWorkspace(binding);
    const content=await contentProof(registry.get(binding.workspaceId));
    const after=inspectIsolatedChildWorkspace(binding);
    if(JSON.stringify(before)!==JSON.stringify(after))fail('TASK_CHILD_ISOLATION_INVALID','Worktree identity changed during baseline observation');
    return {...after,baselineSha256:content.sha256};
  }

  function workspacesOverlap(leftId, rightId) {
    if (leftId === rightId) return true;
    if (!leftId || !rightId) return false;
    const left = registry.get(leftId).root, right = registry.get(rightId).root;
    return isInsideRoot(left, right) || isInsideRoot(right, left);
  }

  function contentProof(entry, relevantFiles = [], signal) {
    return workspaceContentProof(entry.root, {
      relevantFiles, signal,
      additionalWorkspaceRoots: registry.list().map(row => row.root),
      excludedRoots: [stateDir, ...excludedRoots],
      ...(managedIsolation(entry) ? { trustedSourceRoot: entry.root } : {})
    });
  }

  // Core-only observation: identity and exclusions come from this registry.
  // Unlike Owner recovery, reading Handoff facts must never recover an import.
  async function collectContentProof(id, { relevantFiles = [], expectedRoot, signal } = {}) {
    assertObservationActive(signal);
    const entry = registry.get(String(id ?? '').trim());
    if (expectedRoot !== undefined && expectedRoot !== entry.root) fail('WORKSPACE_UNVERIFIED', 'Workspace identity changed during observation');
    if (recoveryState(entry).status === 'blocked') fail('WORKSPACE_RECOVERY_REQUIRED', 'Workspace recovery remains unconfirmed');
    return contentProof(entry, relevantFiles, signal);
  }

  // Internal Owner configuration observation, never a capability or test grant.
  function readPostWriteVerificationConfig({ workspaceId } = {}) {
    return postWriteVerificationSnapshot(registry.get(String(workspaceId ?? '').trim()).settings?.postWriteVerification);
  }

  async function resolvePostWriteVerification({ workspaceId, signal } = {}) {
    assertObservationActive(signal);
    const entry = registry.get(String(workspaceId ?? '').trim());
    const config = readPostWriteVerificationConfig({ workspaceId: entry.id });
    if (!config || config.enabled !== true || config.maxRunsPerTurn === 0) return config;
    const proof = await collectContentProof(entry.id, { expectedRoot: entry.root, signal });
    assertObservationActive(signal);
    const current = readPostWriteVerificationConfig({ workspaceId: entry.id });
    if (current?.configDigest !== config.configDigest) fail('POST_WRITE_CONFIG_CHANGED', 'Owner verifier configuration changed during observation');
    return { ...config, sourceDigest: proof.sha256 };
  }

  // Owner recovery intentionally retains its existing write/recovery fence.
  async function collectRecoveryProof(id, { beforeRecovery, signal } = {}) {
    assertObservationActive(signal);
    const entry = requireWorkspace({ id });
    // Only the original registered root can recover its retained batches.
    // Alternate ancestor/descendant registrations remain fenced projections.
    if (!pendingRecoveryState(entry)) {
      // A pure observation needs no execution reservation. The Owner coordinator
      // rechecks existing ownership synchronously only when imports may mutate.
      if (recovery.has(entry.root) || workspaceImportEvidence(entry.root).length) beforeRecovery?.();
      assertObservationActive(signal);
      recoverEntry(entry, { ownerReview: true });
    }
    assertObservationActive(signal);
    return contentProof(assertWritable(entry), [], signal);
  }

  return { execute, executeApprovedGit, validateApprovedGit, isKnownGitNoEffect, describeWorkspace, describeGitRecoveryWorkspace, acknowledgeGitResult,
    gitOriginalBinding: result => gitSettlements.get(result)?.raw.owner.dispatchBinding,
    gitClosedBindings: result => gitSettlements.get(result)?.raw.invocations.filter(row=>row.state==='closed').map(row=>row.binding) ?? [],
    applyChanges, workspacesOverlap, collectContentProof, collectRecoveryProof, readPostWriteVerificationConfig, resolvePostWriteVerification,
    inspectIsolatedChildWorkspace, captureIsolatedChildWorkspace };
}

export { WorkspaceBoundaryError, WorkspaceRegistryError, WorkspaceToolError };
