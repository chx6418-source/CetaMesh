// CetaMesh Workspace v1 —— 桌面工作区服务（阶段 05）。
//
// 分层：IPC(workspace.*) → 本模块（方法白名单 + 参数收敛 + 策略/审批）→
//       boundary.js（安全裁决）+ tools.js（工具实现）+ registry.js（清单）。
//
// 安全立场（与 memory/service.js 一致）：
// - workspace.* 只经桌面 Shell 的命名管道暴露（bridge.js 的 startUiIpcServer），
//   调用方就是用户控制面；方法白名单之外一律 METHOD_NOT_FOUND。
// - 所有文件路径只接受"相对当前工作区 root"的输入，绝对路径 / 越界输入由
//   boundary 拒绝。服务层不出现任何绕过 boundary 的直连 fs 调用。
// - git.commit 受工作区策略约束：默认 'approval'，进入待审批队列，由用户
//   显式 decide 后才执行；'allow' 直通；'deny' 拒绝。审批请求 10 分钟过期。
// - workspace.remove 只移除登记，绝不删除用户目录。

import { WorkspaceBoundaryError } from './boundary.js';
import {
  WorkspaceRegistryError,
  workspaceRegistryFile,
  createWorkspaceRegistry
} from './registry.js';
import {
  WorkspaceToolError,
  fileSearch,
  gitCommit,
  gitDiff,
  gitStatus,
  readFile,
  testRun,
  writeFile
} from './tools.js';

const GIT_INFO_TTL_MS = 5000;

export function createWorkspaceService({ stateDir, now = () => Date.now(), audit = () => {} } = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new Error('createWorkspaceService 需要 stateDir');
  }
  const registry = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir), now });
  const gitInfoCache = new Map();

  function fail(code, message) {
    throw Object.assign(new Error(message), { code });
  }

  function requireWorkspace(params) {
    const id = String(params?.id ?? '').trim() || registry.getActiveId();
    if (!id) fail('WORKSPACE_NOT_SELECTED', '未指定工作区，也没有当前工作区（先 workspace.open）');
    return registry.get(id);
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
      git: { isRepo: git.isRepo, branch: git.branch, dirty: git.dirty }
    };
  }

  function normalizeRelPath(params, field = 'path') {
    const value = params?.[field];
    const text = String(value ?? '').trim();
    if (!text) fail('PATH_REQUIRED', `需要 ${field}（相对工作区根目录的路径）`);
    if (text.length > 1024) fail('PATH_INVALID', '路径过长（>1024 字符）');
    return text;
  }

  async function executeCommit(entry, { message, stage }) {
    const result = await gitCommit(entry.root, { message, stage });
    record(entry, 'user', 'git.commit', result.committed ? `${message}（${result.sha ?? 'no-sha'}）` : message);
    return result;
  }

  const handlers = {
    // ── 管理 ──
    'workspace.create': async (p) => {
      const entry = registry.create({
        name: p?.name,
        root: p?.root,
        createIfMissing: p?.createIfMissing === true
      });
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
      const result = registry.remove(entry.id);
      gitInfoCache.delete(entry.id);
      record(entry, 'user', 'remove', `${entry.name}（目录保留）`);
      return result;
    },

    'workspace.info': async (p) => {
      const entry = requireWorkspace(p);
      const git = await gitInfo(entry, { refresh: p?.refreshGit === true });
      return {
        workspace: await workspaceSummary(entry),
        git,
        recentFiles: entry.recentFiles ?? [],
        artifacts: entry.artifacts ?? [],
        activity: registry.listActivity({ workspaceId: entry.id, limit: 30 }),
        pending: registry.listPending({ workspaceId: entry.id }),
        taskRelation: { enabled: false, note: 'Persistent Task 未启用（所有者冻结中），暂无任务关联' }
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
      const result = readFile(entry.root, relPath, { maxBytes: p?.maxBytes });
      registry.recordFileAccess(entry.id, { relPath, action: 'read' });
      record(entry, String(p?.actor ?? 'user'), 'read', relPath);
      return result;
    },

    'workspace.write': async (p) => {
      const entry = requireWorkspace(p);
      const relPath = normalizeRelPath(p);
      const result = writeFile(entry.root, relPath, p?.content, { createDirs: p?.createDirs !== false });
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
        includeHidden: p?.includeHidden === true,
        skipNames: entry.settings?.search?.skipNames,
        limit: p?.limit
      });
      record(entry, String(p?.actor ?? 'user'), 'file.search', String(p?.query ?? p?.glob ?? ''));
      return result;
    },

    'workspace.git.status': async (p) => {
      const entry = requireWorkspace(p);
      const git = await gitInfo(entry, { refresh: true });
      record(entry, String(p?.actor ?? 'user'), 'git.status', '');
      return { git };
    },

    'workspace.git.diff': async (p) => {
      const entry = requireWorkspace(p);
      const result = await gitDiff(entry.root, { cached: p?.cached === true, context: p?.context });
      record(entry, String(p?.actor ?? 'user'), 'git.diff', '');
      return result;
    },

    'workspace.git.commit': async (p) => {
      const entry = requireWorkspace(p);
      const message = String(p?.message ?? '').trim();
      if (!message) fail('COMMIT_MESSAGE_REQUIRED', 'commit 需要提交信息');
      const policy = entry.settings?.policies?.gitCommit ?? 'approval';
      const stage = p?.stage === 'none' ? 'none' : 'all';
      if (policy === 'deny') {
        record(entry, String(p?.actor ?? 'user'), 'git.commit.denied', message);
        fail('GIT_COMMIT_DENIED', '当前工作区策略禁止 commit（policies.gitCommit=deny）');
      }
      if (policy === 'allow') {
        return { status: 'committed', ...(await executeCommit(entry, { message, stage })) };
      }
      const request = registry.addPendingCommit({ workspaceId: entry.id, message, stage });
      record(entry, String(p?.actor ?? 'user'), 'git.commit.pending', message);
      return {
        status: 'pending',
        requestId: request.id,
        expiresAt: request.expiresAt,
        note: 'commit 需要用户批准（workspace.pending.decide）'
      };
    },

    'workspace.test.run': async (p) => {
      const entry = requireWorkspace(p);
      const result = await testRun(entry.root, entry.settings?.testCommand, { timeoutMs: p?.timeoutMs });
      record(entry, String(p?.actor ?? 'user'), 'test.run', `exit=${result.exitCode}`);
      return result;
    },

    // ── 审批 ──
    'workspace.pending.list': async (p) => {
      return { pending: registry.listPending({ workspaceId: p?.workspaceId ?? null }) };
    },

    'workspace.pending.decide': async (p) => {
      const request = registry.takePending(String(p?.requestId ?? ''));
      const entry = registry.get(request.workspaceId);
      if (p?.approve !== true) {
        record(entry, 'user', 'git.commit.rejected', request.message);
        return { status: 'rejected', requestId: request.id };
      }
      const result = await executeCommit(entry, { message: request.message, stage: request.stage });
      return { status: 'committed', requestId: request.id, ...result };
    }
  };

  async function execute({ method, params } = {}) {
    const handler = handlers[method];
    if (!handler) fail('METHOD_NOT_FOUND', `Unknown workspace method: ${method}`);
    return handler(params ?? {});
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
      return { id: entry.id, name: entry.name, root: entry.root };
    } catch {
      return null;
    }
  }

  return { execute, describeWorkspace };
}

export { WorkspaceBoundaryError, WorkspaceRegistryError, WorkspaceToolError };
