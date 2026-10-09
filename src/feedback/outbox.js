// CetaMesh Desktop —— 反馈本地 Outbox（产品化任务 D，第五节）。
//
// 存在理由：反馈服务器**还没上线**，而且将来也可能不可用。产品要求很明确 ——
// 「不要因为反馈服务器不可用阻塞软件」。所以提交反馈的语义永远是「先落到本地队列」，
// 网络发送只是尽力而为的一次尝试；失败就留队，等自动重试或用户手动重试。
//
// 边界与策略：
//   - 持久化只经 Storage Primitive（src/storage/json-file.js），文件 <stateDir>/feedback/outbox.json；
//   - 队列有硬上限（默认 100 条，最老的已发送条目先淘汰）：本地状态文件不允许无限增长；
//   - 文件损坏：如实上报 lastError，并把损坏文件另存为取证副本，然后从空队列继续 ——
//     这里与引导进度的策略不同是**有意的**：反馈队列是"可以丢的待发件"，用户当前这条
//     反馈必须能提交成功，不能因为历史文件坏了就把人挡在门外；
//   - 重试策略是确定性的指数退避（可注入时钟），便于测试与 UI 展示"下次重试时间"。

import fs from 'node:fs';
import path from 'node:path';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

export const OUTBOX_VERSION = 1;
export const OUTBOX_MAX_ENTRIES_DEFAULT = 100;
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
export const MAX_ATTEMPTS_DEFAULT = 10;

export const OUTBOX_STATUSES = Object.freeze(['queued', 'sent', 'failed']);

export function outboxError(code, message, extra = {}) {
  return Object.assign(new Error(message), { name: 'FeedbackOutboxError', code, ...extra });
}

/** 退避：30s → 1m → 2m → ... 上限 6h。attempts 从 1 开始（第一次失败后算 1 次尝试）。 */
export function retryDelayMs(attempts, { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS } = {}) {
  const count = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  return Math.min(baseMs * 2 ** Math.min(count - 1, 12), maxMs);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 创建本地 Outbox。
 * maxEntries：队列上限；达到上限时优先淘汰「已发送且最老」的条目，其次是「已失败且最老」的。
 * 若队列里全是待发条目且已达上限，则拒绝入队（FEEDBACK_QUEUE_FULL）——
 * 宁可让 UI 明确告知用户，也不静默丢弃他自己写的内容。
 */
export function createFeedbackOutbox({
  stateDir,
  file = null,
  maxEntries = OUTBOX_MAX_ENTRIES_DEFAULT,
  now = () => Date.now()
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createFeedbackOutbox 需要 stateDir');
  const target = file || path.join(stateDir, 'feedback', 'outbox.json');
  const limit = Number.isFinite(maxEntries) && maxEntries >= 1 ? Math.floor(maxEntries) : OUTBOX_MAX_ENTRIES_DEFAULT;

  let entries = null;
  let lastError = null;
  let corruptCopy = null;

  function load() {
    if (entries) return entries;
    let raw;
    try {
      raw = readJsonFile(target, { missing: null });
    } catch (error) {
      if (error instanceof StorageError && error.code !== 'MISSING') {
        lastError = '反馈队列文件不可用（' + error.code + '），已从空队列继续；原文件已另存备查';
        corruptCopy = preserveCorruptCopy();
      } else if (!(error instanceof StorageError)) {
        throw error;
      }
      raw = null;
    }
    const list = Array.isArray(raw?.entries) ? raw.entries : [];
    entries = list.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string').map((entry) => ({
      ...entry,
      status: OUTBOX_STATUSES.includes(entry.status) ? entry.status : 'queued',
      attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0
    })).slice(-limit);
    return entries;
  }

  /** 损坏文件另存为 .corrupt-<时间戳>：既不阻断用户，也不销毁取证线索。 */
  function preserveCorruptCopy() {
    try {
      const copy = `${target}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(target, copy);
      return copy;
    } catch {
      return null; // 另存失败只影响取证，不影响"队列继续可用"这一主目标。
    }
  }

  function persist() {
    const document = { schemaVersion: OUTBOX_VERSION, updatedAt: new Date(now()).toISOString(), entries };
    try {
      writeJsonAtomic(target, document);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: String(error?.code || 'WRITE_FAILED'), message: String(error?.message ?? error) };
    }
  }

  function evictIfNeeded() {
    if (entries.length < limit) return true;
    const sentIndex = entries.findIndex((entry) => entry.status === 'sent');
    if (sentIndex >= 0) {
      entries.splice(sentIndex, 1);
      return true;
    }
    const failedIndex = entries.findIndex((entry) => entry.status === 'failed');
    if (failedIndex >= 0) {
      entries.splice(failedIndex, 1);
      return true;
    }
    return false; // 全是待发条目：入队方需要如实告知用户队列已满。
  }

  function enqueue(entry) {
    load();
    if (!evictIfNeeded()) {
      throw outboxError('FEEDBACK_QUEUE_FULL', '本地反馈队列已满（' + limit + ' 条），请先手动重试或清理队列');
    }
    const record = {
      ...clone(entry),
      status: 'queued',
      attempts: 0,
      createdAt: entry.createdAt ?? new Date(now()).toISOString(),
      lastAttemptAt: null,
      nextAttemptAt: null,
      lastErrorCode: null
    };
    entries.push(record);
    const written = persist();
    return { entry: clone(record), persisted: written.ok, writeError: written.ok ? null : written };
  }

  function patch(id, changes) {
    load();
    const index = entries.findIndex((entry) => entry.id === String(id));
    if (index < 0) throw outboxError('FEEDBACK_NOT_FOUND', '未找到该反馈：' + String(id));
    entries[index] = { ...entries[index], ...clone(changes) };
    persist();
    return clone(entries[index]);
  }

  function remove(id) {
    load();
    const before = entries.length;
    entries = entries.filter((entry) => entry.id !== String(id));
    if (entries.length !== before) persist();
    return { removed: before - entries.length };
  }

  function clear({ scope = 'sent' } = {}) {
    load();
    const before = entries.length;
    if (scope === 'all') entries = [];
    else entries = entries.filter((entry) => entry.status !== 'sent');
    persist();
    return { removed: before - entries.length };
  }

  /** 到期可重试的条目：从未尝试过、或下次重试时间已到、或已被标记失败但未超次数。 */
  function due(nowMs = now()) {
    load();
    return entries.filter((entry) => {
      if (entry.status === 'sent') return false;
      if (Number.isFinite(entry.attempts) && entry.attempts >= MAX_ATTEMPTS_DEFAULT) return false;
      if (!entry.nextAttemptAt) return true;
      const at = Date.parse(entry.nextAttemptAt);
      return !Number.isFinite(at) || at <= nowMs;
    }).map(clone);
  }

  function list() {
    load();
    return entries.map(clone);
  }

  return {
    file: target,
    limit,
    list,
    get: (id) => {
      load();
      const found = entries.find((entry) => entry.id === String(id));
      return found ? clone(found) : null;
    },
    enqueue,
    patch,
    remove,
    clear,
    due,
    stats: () => {
      load();
      return {
        total: entries.length,
        queued: entries.filter((entry) => entry.status === 'queued').length,
        sent: entries.filter((entry) => entry.status === 'sent').length,
        failed: entries.filter((entry) => entry.status === 'failed').length
      };
    },
    lastError: () => lastError,
    corruptCopy: () => corruptCopy
  };
}
