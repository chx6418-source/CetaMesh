// CetaMesh Persistent Task v1 —— 任务持久化（阶段 07）。
//
// 落库要求：应用重启后 Task / Progress / Checkpoint / Agent History / Workspace 关联必须仍然存在。
// 因此所有变更都经过本项目唯一的原子写入口，并且每条任务带单调递增 rev（显式冲突检测）。
//
// 与 memory/chat 的存储保持同一套约定：统一走 Storage Primitive（原子写、0600、BOM 容错），
// 损坏 fail-closed，对外仍是 Task 自己的错误码（StorageError 在这里收敛为 taskError）。

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { taskError, TASK_STATUSES } from './types.js';

export const TASK_SCHEMA_VERSION = 1;
const MAX_TASKS = 5000;

function loadTaskFile(file, fallback) {
  try {
    return readJsonFile(file, { missing: fallback });
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === 'CORRUPT') throw taskError('STORE_CORRUPT', '任务数据解析失败：' + file);
      throw taskError('STORE_UNREADABLE', '任务数据读取失败：' + file);
    }
    throw error;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function assertTaskSchema(raw, file) {
  if (raw?.schemaVersion !== TASK_SCHEMA_VERSION || !Number.isSafeInteger(raw.revision) || raw.revision < 1
    || !Array.isArray(raw.tasks) || raw.tasks.length > MAX_TASKS) {
    throw taskError('STORE_CORRUPT', '任务文件版本、修订号或列表无效：' + file);
  }
  const seen = new Set();
  for (const row of raw.tasks) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id
      || seen.has(row.id) || typeof row.goal !== 'string' || !TASK_STATUSES.includes(row.status)
      || !Number.isSafeInteger(row.rev) || row.rev < 1 || !Array.isArray(row.requirements)
      || !Array.isArray(row.agentHistory) || !Array.isArray(row.artifacts)
      || (row.workspaceId !== undefined && row.workspaceId !== null && typeof row.workspaceId !== 'string')) {
      throw taskError('STORE_CORRUPT', '任务记录结构无效：' + file);
    }
    seen.add(row.id);
  }
}

/** 反序列化时补齐缺失字段，避免旧文件或手改文件把运行期炸掉。 */
function normalizeLoaded(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id === null || raw.id === undefined ? '' : raw.id).trim();
  if (!id) return null;
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  const checkpoint = raw.checkpoint && typeof raw.checkpoint === 'object' ? raw.checkpoint : null;
  return {
    id,
    goal: String(raw.goal === null || raw.goal === undefined ? '' : raw.goal),
    requirements: asArray(raw.requirements).map(String),
    status: raw.status,
    currentPhase: raw.currentPhase === undefined || raw.currentPhase === null ? '' : String(raw.currentPhase),
    progress: {
      percent: Number.isFinite(Number(progress.percent)) ? Math.max(0, Math.min(100, Math.round(Number(progress.percent)))) : 0,
      note: progress.note === undefined || progress.note === null ? '' : String(progress.note)
    },
    completedWork: asArray(raw.completedWork),
    pendingWork: asArray(raw.pendingWork),
    workspaceId: raw.workspaceId === undefined ? null : raw.workspaceId,
    artifacts: asArray(raw.artifacts),
    decisions: asArray(raw.decisions),
    memoryRefs: asArray(raw.memoryRefs),
    checkpoint: checkpoint
      ? {
        at: Number(checkpoint.at) || 0,
        summary: checkpoint.summary === undefined || checkpoint.summary === null ? '' : String(checkpoint.summary),
        nextAction: checkpoint.nextAction === undefined || checkpoint.nextAction === null ? '' : String(checkpoint.nextAction),
        ...(checkpoint.workspaceReconciliation && typeof checkpoint.workspaceReconciliation === 'object'
          ? { workspaceReconciliation: checkpoint.workspaceReconciliation }
          : {})
      }
      : null,
    acceptance: asArray(raw.acceptance),
    agentHistory: asArray(raw.agentHistory),
    currentAgent: raw.currentAgent && typeof raw.currentAgent === 'object' ? raw.currentAgent : null,
    result: raw.result && typeof raw.result === 'object' ? raw.result : null,
    failure: raw.failure && typeof raw.failure === 'object' ? raw.failure : null,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    rev: Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 1
  };
}

export function createTaskStore({ stateDir, now = () => Date.now(), idFactory } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createTaskStore 需要 stateDir');
  const dir = path.join(stateDir, 'tasks');
  const file = path.join(dir, 'tasks.json');
  const makeId = typeof idFactory === 'function'
    ? idFactory
    : () => 'task_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex');

  const tasks = new Map();
  let fileRevision = 0;
  let loaded = false;

  function backupInvalidSource() {
    const backup = path.join(dir, `tasks.corrupt.${now()}.${crypto.randomBytes(4).toString('hex')}.json`);
    try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { throw taskError('STORE_RECOVERY_FAILED', '任务文件损坏且无法备份：' + error.message); }
  }

  function load() {
    if (loaded) return;
    let raw;
    try { raw = loadTaskFile(file, null); }
    catch (error) { if (error.code === 'STORE_CORRUPT') backupInvalidSource(); throw error; }
    if (!raw) { loaded = true; return; }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      backupInvalidSource();
      throw taskError('STORE_CORRUPT', '任务数据根节点必须是对象：' + file);
    }
    try { assertTaskSchema(raw, file); }
    catch (error) { backupInvalidSource(); throw error; }
    const nextTasks = new Map();
    for (const item of raw.tasks) {
      const task = normalizeLoaded(item);
      nextTasks.set(task.id, task);
    }
    tasks.clear();
    for (const [id, task] of nextTasks) tasks.set(id, task);
    fileRevision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
    loaded = true;
  }

  function persist() {
    const nextRevision = fileRevision + 1;
    writeJsonAtomic(file, {
      schemaVersion: TASK_SCHEMA_VERSION,
      revision: nextRevision,
      updatedAt: now(),
      tasks: [...tasks.values()]
    });
    fileRevision = nextRevision;
  }

  function clone(task) {
    return JSON.parse(JSON.stringify(task));
  }

  function get(id) {
    load();
    const task = tasks.get(String(id === null || id === undefined ? '' : id));
    return task ? clone(task) : null;
  }

  function count() {
    load();
    return tasks.size;
  }

  /** 全量列表（任务没有 Memory 那样的按 Scope 授权分区需求；过滤在 runtime 层）。 */
  function listAll() {
    load();
    return [...tasks.values()].map(clone);
  }

  function insert(task) {
    load();
    if (tasks.size >= MAX_TASKS) throw taskError('STORE_FULL', '任务数量已达上限 ' + MAX_TASKS);
    if (tasks.has(task.id)) throw taskError('DUPLICATE_ID', '任务 id 已存在：' + task.id);
    tasks.set(task.id, task);
    try { persist(); } catch (error) { tasks.delete(task.id); throw error; }
    return clone(task);
  }

  function update(id, expectedRev, mutate) {
    load();
    const key = String(id);
    const task = tasks.get(key);
    if (!task) throw taskError('TASK_NOT_FOUND', '任务不存在：' + key);
    if (!Number.isSafeInteger(expectedRev)) {
      throw taskError('REVISION_REQUIRED', '修改任务必须携带 expectedRev');
    }
    if (task.rev !== expectedRev) {
      throw taskError('TASK_CONFLICT', '任务已被其它操作修改（期望 rev ' + expectedRev + '，当前 rev ' + task.rev + '）');
    }
    const next = mutate(clone(task));
    next.rev = task.rev + 1;
    next.updatedAt = now();
    tasks.set(key, next);
    try { persist(); } catch (error) { tasks.set(key, task); throw error; }
    return clone(next);
  }

  function remove(id, expectedRev) {
    load();
    const key = String(id);
    const task = tasks.get(key);
    if (!task) throw taskError('TASK_NOT_FOUND', '任务不存在：' + key);
    if (!Number.isSafeInteger(expectedRev)) {
      throw taskError('REVISION_REQUIRED', '删除任务必须携带 expectedRev');
    }
    if (task.rev !== expectedRev) {
      throw taskError('TASK_CONFLICT', '任务已被其它操作修改（期望 rev ' + expectedRev + '，当前 rev ' + task.rev + '）');
    }
    tasks.delete(key);
    try { persist(); } catch (error) { tasks.set(key, task); throw error; }
    return { id: key, deleted: true };
  }

  return {
    dir,
    file,
    load,
    get,
    count,
    listAll,
    insert,
    update,
    remove,
    newId: makeId,
    fileRevision: () => fileRevision,
    now
  };
}
