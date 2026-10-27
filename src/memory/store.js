// CetaMesh Memory v1 —— 持久化与 revision / 冲突检测（阶段 04）。
//
// 关键约束：本模块是唯一接触记忆文件的层，而且**只对外提供按授权分区检索的原语**。
// store 不提供"读取全部再过滤"的接口，因此"授权先于检索"是结构上可保证的，
// 而不是靠调用方自觉：runtime 拿不到全量记录，只能传入已授权的 scopeKey 列表。
//
// 冲突策略：每条记录带单调递增 rev。update / remove 必须携带 expectedRev，
// 不匹配即 MEMORY_CONFLICT，避免并发写覆盖（与 Chat 会话存储同为原子写 + 显式冲突）。

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { memoryError, scopeKey, isMemoryType, normalizeScope, MEMORY_SOURCES } from './types.js';

export const MEMORY_SCHEMA_VERSION = 1;
const MAX_RECORDS = 20000;
const MAX_IDS_PER_SCOPE = 5000;

function loadMemoryFile(file, fallback) {
  try {
    return readJsonFile(file, { missing: fallback });
  } catch (error) {
    if (error instanceof StorageError) {
      const detail = error?.cause?.message ?? error.message;
      if (error.code === 'CORRUPT') {
        throw memoryError('STORE_CORRUPT', '记忆数据解析失败：' + file + '（' + detail + '）');
      }
      throw memoryError('STORE_CORRUPT', '记忆数据读取失败：' + file + '（' + detail + '）');
    }
    throw error;
  }
}

function normalizeLoadedRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id === null || raw.id === undefined ? '' : raw.id).trim();
  if (!id) return null;
  return {
    id,
    type: raw.type,
    scope: raw.scope,
    scopeKey: raw.scopeKey,
    content: String(raw.content === null || raw.content === undefined ? '' : raw.content),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    source: raw.source,
    pinned: raw.pinned === true,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    rev: Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 1,
    confirmedAt: raw.confirmedAt === undefined ? null : raw.confirmedAt,
    confirmedBy: raw.confirmedBy === undefined ? null : raw.confirmedBy,
    origin: raw.origin && typeof raw.origin === 'object' ? raw.origin : null,
    sourceRefs: Array.isArray(raw.sourceRefs) ? structuredClone(raw.sourceRefs) : [],
    entityIds: Array.isArray(raw.entityIds) ? [...raw.entityIds] : [],
    factKey: raw.factKey ?? null, validUntil: raw.validUntil ?? null
  };
}

function assertMemorySchema(raw, file) {
  if (raw?.schemaVersion !== MEMORY_SCHEMA_VERSION || !Number.isSafeInteger(raw.revision) || raw.revision < 1
    || !Array.isArray(raw.memories) || raw.memories.length > MAX_RECORDS) {
    throw memoryError('STORE_CORRUPT', '记忆文件版本、修订号或列表无效：' + file);
  }
  const ids = new Set();
  for (const row of raw.memories) {
    let normalizedScope;
    try { normalizedScope = normalizeScope(row?.scope); }
    catch { throw memoryError('STORE_CORRUPT', '记忆 Scope 无效：' + file); }
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id
      || ids.has(row.id) || !isMemoryType(row.type)
      || (row.scopeKey !== scopeKey(normalizedScope) && !(normalizedScope.kind === 'global' && row.scopeKey === 'global:'))
      || typeof row.content !== 'string' || !row.content || !Array.isArray(row.tags)
      || row.tags.some(tag => typeof tag !== 'string') || (row.source !== undefined && !MEMORY_SOURCES.includes(row.source))
      || !Number.isSafeInteger(row.rev) || row.rev < 1
      || (row.factKey!=null && (typeof row.factKey!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(row.factKey)))
      || (row.validUntil!=null && (!Number.isSafeInteger(row.validUntil)||row.validUntil<=0))) {
      throw memoryError('STORE_CORRUPT', '记忆记录结构无效：' + file);
    }
    ids.add(row.id);
  }
}

export function createMemoryStore({ stateDir, now = () => Date.now(), idFactory } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMemoryStore 需要 stateDir');
  const dir = path.join(stateDir, 'memory');
  const file = path.join(dir, 'memories.json');
  const makeId = typeof idFactory === 'function'
    ? idFactory
    : () => 'mem_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex');

  const records = new Map();   // id -> record
  const byScope = new Map();   // scopeKey -> Set<id>（授权分区索引）
  let fileRevision = 0;        // 文件级修订号：每次成功落盘 +1
  let loaded = false;

  function backupInvalidSource() {
    const backup = path.join(dir, `memories.corrupt.${now()}.${crypto.randomBytes(4).toString('hex')}.json`);
    try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { throw memoryError('STORE_RECOVERY_FAILED', '记忆文件损坏且无法备份：' + error.message); }
  }

  // 仅用于测试 / 诊断：证明授权检索没有扫描未授权分区。
  const stats = { scanned: 0, lastScanned: 0, lastScopeKeys: [] };

  function indexRecord(record) {
    records.set(record.id, record);
    let ids = byScope.get(record.scopeKey);
    if (!ids) {
      ids = new Set();
      byScope.set(record.scopeKey, ids);
    }
    ids.add(record.id);
  }

  function unindexRecord(record) {
    records.delete(record.id);
    const ids = byScope.get(record.scopeKey);
    if (ids) {
      ids.delete(record.id);
      if (ids.size === 0) byScope.delete(record.scopeKey);
    }
  }

  function load() {
    if (loaded) return;
    let raw;
    try { raw = loadMemoryFile(file, null); }
    catch (error) { if (error.code === 'STORE_CORRUPT') backupInvalidSource(); throw error; }
    if (!raw) { loaded = true; return; }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      backupInvalidSource();
      throw memoryError('STORE_CORRUPT', '记忆数据根节点必须是对象：' + file);
    }
    try { assertMemorySchema(raw, file); }
    catch (error) { backupInvalidSource(); throw error; }
    const list = raw.memories;
    const nextRecords = [];
    for (const item of list) {
      const record = normalizeLoadedRecord(item);
      nextRecords.push(record);
    }
    for (const record of nextRecords) indexRecord(record);
    fileRevision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
    loaded = true;
  }

  function persist() {
    const nextRevision = fileRevision + 1;
    writeJsonAtomic(file, {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      revision: nextRevision,
      updatedAt: now(),
      memories: [...records.values()]
    });
    fileRevision = nextRevision;
  }

  function get(id) {
    load();
    const record = records.get(String(id === null || id === undefined ? '' : id));
    return record ? { ...record, tags: [...record.tags] } : null;
  }

  function count() {
    load();
    return records.size;
  }

  function fileRevisionValue() {
    return fileRevision;
  }

  /**
   * 授权分区检索：只遍历传入的 scopeKey 分区。
   * 未授权的分区不会被读取、不会被计数、也不会进入结果。
   */
  function scanAuthorized(authorizedScopeKeys, predicate) {
    load();
    const keys = Array.isArray(authorizedScopeKeys) ? authorizedScopeKeys : [];
    const seen = new Set();
    const out = [];
    let scanned = 0;
    for (const key of keys) {
      const ids = byScope.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const record = records.get(id);
        if (!record) continue;
        scanned += 1;
        if (!predicate || predicate(record)) out.push({ ...record, tags: [...record.tags] });
      }
    }
    stats.lastScanned = scanned;
    stats.lastScopeKeys = [...keys];
    stats.scanned += scanned;
    return out;
  }

  function insert(record) {
    load();
    if (records.size >= MAX_RECORDS) {
      throw memoryError('STORE_FULL', '记忆条数已达上限 ' + MAX_RECORDS);
    }
    const key = record.scopeKey;
    const ids = byScope.get(key);
    if (ids && ids.size >= MAX_IDS_PER_SCOPE) {
      throw memoryError('STORE_FULL', 'Scope ' + key + ' 的记忆条数已达上限 ' + MAX_IDS_PER_SCOPE);
    }
    if (records.has(record.id)) throw memoryError('DUPLICATE_ID', '记忆 id 已存在：' + record.id);
    indexRecord(record);
    try { persist(); } catch (error) { unindexRecord(record); throw error; }
    return { ...record, tags: [...record.tags] };
  }

  /** 读取-修改-写回，带 revision 冲突检测。 */
  function update(id, expectedRev, mutate) {
    load();
    const record = records.get(String(id));
    if (!record) throw memoryError('MEMORY_NOT_FOUND', '记忆不存在：' + String(id));
    if (!Number.isSafeInteger(expectedRev)) {
      throw memoryError('REVISION_REQUIRED', '更新必须携带 expectedRev');
    }
    if (record.rev !== expectedRev) {
      throw memoryError('MEMORY_CONFLICT', '记忆已被其它操作修改（期望 rev ' + expectedRev + '，当前 rev ' + record.rev + '）');
    }
    const next = mutate({ ...record, tags: [...record.tags] });
    next.rev = record.rev + 1;
    next.updatedAt = next.updatedAt || now();
    records.set(record.id, next);
    try { persist(); } catch (error) { records.set(record.id, record); throw error; }
    return { ...next, tags: [...next.tags] };
  }

  function remove(id, expectedRev) {
    load();
    const record = records.get(String(id));
    if (!record) throw memoryError('MEMORY_NOT_FOUND', '记忆不存在：' + String(id));
    if (!Number.isSafeInteger(expectedRev)) {
      throw memoryError('REVISION_REQUIRED', '删除必须携带 expectedRev');
    }
    if (record.rev !== expectedRev) {
      throw memoryError('MEMORY_CONFLICT', '记忆已被其它操作修改（期望 rev ' + expectedRev + '，当前 rev ' + record.rev + '）');
    }
    unindexRecord(record);
    try { persist(); } catch (error) { indexRecord(record); throw error; }
    return { id: record.id, deleted: true };
  }

  return {
    dir,
    file,
    load,
    get,
    count,
    fileRevision: fileRevisionValue,
    /** 全部（已存在的）分区键；仅供 runtime 把用户主体的 '*' 授权展开为实际分区。 */
    allScopeKeys() {
      load();
      return [...byScope.keys()];
    },
    scanAuthorized,
    insert,
    update,
    remove,
    now,
    newId: makeId,
    stats,
    /** 仅供诊断 / 导出，明确取名以提醒调用方它不是检索入口。 */
    _adminAll() {
      load();
      return [...records.values()].map((r) => ({ ...r, tags: [...r.tags] }));
    }
  };
}
