// CetaMesh Workspace v1 —— 工作区注册表（阶段 05）。
//
// 只管理 CetaMesh 自己的清单（哪个目录被登记为工作区、叫什么、谁在用），
// **从不代表用户删除目录**：workspace.remove 只从清单移除登记，目录原样保留。
// 持久化复用 src/config/loader.js 的原子写原语（阶段 01 产物）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteConfig, readRawConfig } from '../config/loader.js';
import { assertSafeRootForm, canonicalizeRoot } from './boundary.js';

const SCHEMA_VERSION = 1;
const ACTIVITY_LIMIT = 100;
const RECENT_FILES_LIMIT = 20;
const ARTIFACTS_LIMIT = 50;
const PENDING_TTL_MS = 10 * 60 * 1000;

export const COMMIT_POLICIES = Object.freeze(['allow', 'approval', 'deny']);

export class WorkspaceRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceRegistryError(code, message);
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    activeId: null,
    workspaces: [],
    pending: [],
    activity: []
  };
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) fail('NAME_REQUIRED', '工作区名称不能为空');
  if (trimmed.length > 100) fail('NAME_TOO_LONG', '工作区名称过长（>100 字符）');
  return trimmed;
}

export function createWorkspaceRegistry({ file, now = () => Date.now() } = {}) {
  if (!file || typeof file !== 'string') {
    throw new Error('createWorkspaceRegistry 需要 file（workspaces.json 路径）');
  }

  let state = load();

  function load() {
    try {
      const raw = readRawConfig(file, { required: true });
      return {
        ...emptyState(),
        ...raw,
        workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
        pending: Array.isArray(raw.pending) ? raw.pending : [],
        activity: Array.isArray(raw.activity) ? raw.activity : []
      };
    } catch (error) {
      // Only a truly absent registry is a new installation. Preserve corrupt or
      // unreadable existing state instead of allowing the next write to erase it.
      if (error?.code === 'CONFIG_MISSING' && error?.cause?.code === 'ENOENT') return emptyState();
      throw new WorkspaceRegistryError('REGISTRY_CORRUPT', `工作区清单无法读取；原文件已保留：${file}（${error?.message ?? error}）`);
    }
  }

  function save() {
    atomicWriteConfig(file, state);
  }

  function requireEntry(id) {
    const entry = state.workspaces.find((item) => item.id === id);
    if (!entry) fail('WORKSPACE_NOT_FOUND', `工作区不存在：${id}`);
    return entry;
  }

  function defaultSettings() {
    return {
      testCommand: '',
      policies: { gitCommit: 'approval' },
      search: { includeHidden: false, skipNames: ['.git', 'node_modules'] }
    };
  }

  return {
    /** 登记（或按 root 去重返回）一个工作区。root 会先经边界规范化校验。 */
    create({ name, root, createIfMissing = false }) {
      // createIfMissing 支持产品里的"新建工作区目录"：先做危险形态静态检查
      // （绝不把目录先建进系统位置再拒绝），建完后再做完整的 canonicalizeRoot。
      if (createIfMissing && !fs.existsSync(String(root ?? ''))) {
        assertSafeRootForm(root);
        const target = path.resolve(String(root));
        try {
          fs.mkdirSync(target, { recursive: true });
        } catch (error) {
          fail('ROOT_CREATE_FAILED', `创建工作区目录失败：${error?.message ?? error}`);
        }
        // 若 mkdir 因父目录 junction 等原因落到 root 外，这里会被 canonicalizeRoot 拒绝；
        // 尽力清掉刚建的空目录，避免留下越界残骸。
        try {
          canonicalizeRoot(root);
        } catch (error) {
          try {
            fs.rmdirSync(target);
          } catch {}
          throw error;
        }
      }
      const realRoot = canonicalizeRoot(root);
      const existing = state.workspaces.find(
        (item) => item.root.toLowerCase() === realRoot.toLowerCase()
      );
      if (existing) fail('ROOT_ALREADY_REGISTERED', `该目录已登记为工作区：${existing.name}`);
      const entry = {
        id: newId('ws'),
        name: normalizeName(name),
        root: realRoot,
        createdAt: now(),
        lastOpenedAt: 0,
        settings: defaultSettings(),
        recentFiles: [],
        artifacts: []
      };
      state.workspaces.push(entry);
      save();
      return entry;
    },

    list() {
      // Recent Workspaces：按最近打开倒序（未打开过的排最后，同序按登记时间倒序）。
      return [...state.workspaces]
        .sort((a, b) => (b.lastOpenedAt - a.lastOpenedAt) || (b.createdAt - a.createdAt))
        .map((entry) => ({ ...entry }));
    },

    get(id) {
      return { ...requireEntry(id) };
    },

    findRoot(root) {
      const realRoot = canonicalizeRoot(root);
      const found = state.workspaces.find(
        (item) => item.root.toLowerCase() === realRoot.toLowerCase()
      );
      return found ? { ...found } : null;
    },

    rename(id, name) {
      const entry = requireEntry(id);
      entry.name = normalizeName(name);
      save();
      return { ...entry };
    },

    /** 从 CetaMesh 清单移除登记。绝不删除用户目录本身。 */
    remove(id) {
      const entry = requireEntry(id);
      state.workspaces = state.workspaces.filter((item) => item.id !== id);
      state.pending = state.pending.filter((item) => item.workspaceId !== id);
      if (state.activeId === id) state.activeId = null;
      save();
      return { removed: entry.id, root: entry.root, directoryPreserved: true };
    },

    /** 打开 = 刷新 lastOpenedAt 并设为当前工作区。 */
    open(id) {
      const entry = requireEntry(id);
      entry.lastOpenedAt = now();
      state.activeId = entry.id;
      save();
      return { ...entry };
    },

    getActiveId() {
      return state.activeId;
    },

    updateSettings(id, patch) {
      const entry = requireEntry(id);
      const patchObject = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
      if (patchObject.testCommand !== undefined) {
        const cmd = String(patchObject.testCommand ?? '').trim();
        if (cmd.length > 500) fail('SETTING_INVALID', 'testCommand 过长（>500 字符）');
        entry.settings.testCommand = cmd;
      }
      if (patchObject.policies && typeof patchObject.policies === 'object') {
        if (patchObject.policies.gitCommit !== undefined) {
          const policy = String(patchObject.policies.gitCommit);
          if (!COMMIT_POLICIES.includes(policy)) {
            fail('SETTING_INVALID', `gitCommit 策略必须是 ${COMMIT_POLICIES.join(' | ')}，收到：${policy}`);
          }
          entry.settings.policies.gitCommit = policy;
        }
      }
      if (patchObject.search && typeof patchObject.search === 'object') {
        if (patchObject.search.includeHidden !== undefined) {
          entry.settings.search.includeHidden = patchObject.search.includeHidden === true;
        }
      }
      save();
      return { ...entry };
    },

    recordActivity({ workspaceId = null, actor = 'user', action, detail = '' }) {
      state.activity.unshift({
        id: newId('ev'),
        workspaceId,
        actor: String(actor ?? 'user'),
        action: String(action ?? ''),
        detail: String(detail ?? '').slice(0, 300),
        at: now()
      });
      if (state.activity.length > ACTIVITY_LIMIT) state.activity.length = ACTIVITY_LIMIT;
      save();
    },

    recordFileAccess(id, { relPath, action }) {
      const entry = requireEntry(id);
      const normalized = String(relPath ?? '').split('\\').join('/');
      entry.recentFiles = [
        { path: normalized, action: String(action ?? ''), at: now() },
        ...entry.recentFiles.filter((item) => item.path !== normalized)
      ].slice(0, RECENT_FILES_LIMIT);
      save();
    },

    recordArtifact(id, { relPath, note = '' }) {
      const entry = requireEntry(id);
      const normalized = String(relPath ?? '').split('\\').join('/');
      entry.artifacts = [
        { path: normalized, note: String(note ?? '').slice(0, 200), at: now() },
        ...entry.artifacts.filter((item) => item.path !== normalized)
      ].slice(0, ARTIFACTS_LIMIT);
      save();
    },

    /** 活动流（全局，供 UI 的 Agent activity 面板）。 */
    listActivity({ workspaceId = null, limit = 50 } = {}) {
      const items = workspaceId
        ? state.activity.filter((item) => item.workspaceId === workspaceId)
        : state.activity;
      return items.slice(0, Math.max(1, Math.min(100, limit)));
    },

    addPendingCommit({ workspaceId, message, paths, expectedHead, expectedHashes }) {
      requireEntry(workspaceId);
      const request = {
        id: newId('pnd'),
        workspaceId,
        kind: 'git.commit',
        message: String(message ?? ''),
        paths: [...paths], expectedHead, expectedHashes: {...expectedHashes},
        createdAt: now(),
        expiresAt: now() + PENDING_TTL_MS
      };
      state.pending.push(request);
      save();
      return { ...request };
    },

    listPending({ workspaceId = null } = {}) {
      const items = workspaceId
        ? state.pending.filter((item) => item.workspaceId === workspaceId)
        : state.pending;
      return items.map((item) => ({ ...item }));
    },

    getPending(id) {
      const request = state.pending.find((item) => item.id === id);
      if (!request) fail('PENDING_NOT_FOUND', `待审批请求不存在：${id}`);
      if (request.expiresAt <= now()) {
        state.pending = state.pending.filter((item) => item.id !== id);
        save();
        fail('PENDING_EXPIRED', '待审批请求已过期（10 分钟）');
      }
      return { ...request };
    },

    takePending(id) {
      const request = this.getPending(id);
      state.pending = state.pending.filter((item) => item.id !== id);
      save();
      return request;
    }
  };
}

/** 工作区清单文件的标准位置。 */
export function workspaceRegistryFile(stateDir) {
  return path.join(stateDir, 'workspaces.json');
}
