// CetaMesh Memory v1 —— 统一 Memory Runtime（阶段 04）。
//
// 固定顺序（不可交换）：authorize → retrieve → rank。
//   authorize：policy 决定"能看哪些 Scope / 哪些类型"，产出检索过滤器；
//   retrieve ：store.scanAuthorized 只扫描已授权分区（未授权分区既不读也不计数）；
//   rank     ：确定性打分（pin > 命中质量 > 新鲜度 > 类型权重），不引入向量库。
//
// Chat Memory 候选流程（长期记忆只能用户确认后写入）：
//   Agent: proposeCandidate() → status=pending（此时并不是记忆）
//   用户  : confirmCandidate(decision=accept|reject) → accept 才真正落库，带 confirmedAt/By
//   Agent 直接 create 长期类型 → 策略层拒绝（LONG_TERM_REQUIRES_CONFIRMATION）
//
// 边界：不做 Knowledge Graph、不做向量检索、不做 Marketplace。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LONG_TERM_TYPES,
  MEMORY_LIMITS,
  assertPrincipal,
  memoryError,
  normalizeContent,
  normalizeLimit,
  normalizeMemoryType,
  normalizeQuery,
  normalizeScope,
  normalizeSource,
  normalizeTags,
  scopeKey
} from './types.js';
import { createMemoryPolicy } from './policy.js';
import { createMemoryStore } from './store.js';
import { createMemoryLinks } from './links.js';
import { normalizeReferences } from './references.js';

const CANDIDATE_SCHEMA_VERSION = 1;
const MAX_CANDIDATES = 500;
const TYPE_WEIGHT = Object.freeze({ working: 5, chat: 4, user: 3, task: 2, workspace: 1 });

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw memoryError('STORE_CORRUPT', '候选读取失败：' + file);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw memoryError('STORE_CORRUPT', '候选解析失败：' + file);
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function normalizeEntityIds(values) {
  if (!Array.isArray(values) || values.length > 24 || values.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9._:@-]{1,128}$/.test(id))) {
    throw memoryError('INVALID_REFERENCE', 'entityIds must contain at most 24 bounded entity ids');
  }
  return [...new Set(values)];
}

/** 对外投影：UI 需要 来源 / 更新时间 / Scope / rev / pinned。 */
function toView(record) {
  return {
    id: record.id,
    type: record.type,
    scope: record.scope.kind === 'global' ? 'global' : record.scope.kind + ':' + record.scope.id,
    scopeKind: record.scope.kind,
    scopeId: record.scope.id,
    content: record.content,
    tags: [...record.tags],
    source: record.source,
    pinned: record.pinned === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rev: record.rev,
    confirmedAt: record.confirmedAt,
    confirmedBy: record.confirmedBy,
    origin: record.origin ? structuredClone(record.origin) : null,
    sourceRefs: structuredClone(record.sourceRefs || []),
    entityIds: [...(record.entityIds || [])]
  };
}

export function createMemoryRuntime({ stateDir, audit = null, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMemoryRuntime 需要 stateDir');
  const policy = createMemoryPolicy({ audit });
  const store = createMemoryStore({ stateDir, now });
  const candidatesFile = path.join(stateDir, 'memory', 'candidates.json');
  const links = createMemoryLinks({ stateDir, policy, store, now, list: listRecords });

  const candidates = new Map(); // id -> candidate
  const confirmingCandidates = new Set(); // only the trusted confirmation path may consume a candidate
  let candidatesLoaded = false;

  function loadCandidates() {
    if (candidatesLoaded) return;
    candidatesLoaded = true;
    const raw = readJson(candidatesFile, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const list = Array.isArray(raw.candidates) ? raw.candidates : [];
    for (const item of list) {
      if (item && typeof item.id === 'string' && item.id) candidates.set(item.id, item);
    }
  }

  function persistCandidates() {
    atomicWrite(candidatesFile, {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      updatedAt: now(),
      candidates: [...candidates.values()]
    });
  }

  function candidateView(candidate) {
    return {
      id: candidate.id,
      status: candidate.status,
      type: candidate.type,
      scope: candidate.scope.key,
      content: candidate.content,
      reason: candidate.reason,
      proposedBy: candidate.proposedBy,
      proposedAt: candidate.proposedAt,
      decidedAt: candidate.decidedAt,
      decidedBy: candidate.decidedBy,
      memoryId: candidate.memoryId,
      sourceRefs: structuredClone(candidate.sourceRefs || []),
      entityIds: [...(candidate.entityIds || [])]
    };
  }

  /** 在已授权分区内按 id 取记录：找不到与无权看都返回 null，避免泄漏存在性。 */
  function findAuthorized(decision, id) {
    const target = String(id === null || id === undefined ? '' : id);
    if (!target) return null;
    const hits = scanFor(decision, (record) => record.id === target);
    return hits.length ? hits[0] : null;
  }

  /**
   * 把用户主体的 '*' 授权展开成实际分区列表。
   * store 永远看不到 '*'，因此"扫描"始终等于"已授权分区"。
   */
  function effectiveScopes(decision) {
    return decision.scopeKeys.includes('*') ? store.allScopeKeys() : decision.scopeKeys;
  }

  function scanFor(decision, predicate) {
    return store.scanAuthorized(effectiveScopes(decision), (record) => {
      if (decision.types && !decision.types.includes(record.type)) return false;
      return predicate ? predicate(record) : true;
    });
  }

  function authorizeRead(request) {
    return policy.requireAuthorization({ ...request, action: 'read' });
  }

  function readView(record, principal) {
    const view = toView(record);
    view.sourceRefs = view.sourceRefs.filter((ref) => {
      try { links.authorizeRefs({ principal, sourceScope: record.scope, refs: [ref] }); return true; }
      catch (error) {
        if (['MEMORY_NOT_FOUND', 'SCOPE_NOT_AUTHORIZED', 'TYPE_NOT_AUTHORIZED', 'CROSS_SCOPE_LINK_REQUIRED'].includes(error.code)) return false;
        throw error;
      }
    });
    return view;
  }

  function listRecords({ principal, scope, types, pinned, query, limit } = {}) {
    const scopes = scope === undefined || scope === null ? null : [normalizeScope(scope)];
    const decision = authorizeRead({ principal, scopes, types: types || null });
    const text = normalizeQuery(query);
    const needle = text.toLowerCase();
    const max = normalizeLimit(limit, 50);
    const rows = scanFor(decision, (record) => {
      if (pinned === true && record.pinned !== true) return false;
      if (pinned === false && record.pinned === true) return false;
      if (!needle) return true;
      return record.content.toLowerCase().includes(needle)
        || record.tags.some((tag) => tag.toLowerCase().includes(needle));
    });
    const scanned = store.stats.lastScanned;
    const results = rank(rows, needle, text).slice(0, max).map((record) => readView(record, principal));
    return {
      memories: results,
      meta: {
        authorizedScopes: decision.scopeKeys,
        authorizedTypes: decision.types,
        scanned,
        returned: results.length
      }
    };
  }

  function rank(rows, needle, rawText) {
    const nowMs = now();
    return rows
      .map((record) => {
        let score = 0;
        if (record.pinned) score += 1000;
        if (needle) {
          const content = record.content.toLowerCase();
          if (content === needle) score += 200;
          else if (content.startsWith(needle)) score += 120;
          else if (content.includes(needle)) score += 60;
          if (record.tags.some((tag) => tag.toLowerCase() === needle)) score += 40;
        }
        const ageDays = Math.max(0, (nowMs - record.updatedAt) / 86400000);
        score += Math.max(0, 30 - ageDays);
        score += TYPE_WEIGHT[record.type] || 0;
        return { record, score };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.record.updatedAt !== a.record.updatedAt) return b.record.updatedAt - a.record.updatedAt;
        return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
      })
      .map((entry) => entry.record);
  }

  function createMemory({ principal, type, scope, content, tags, source, pinned, confirmationId, originRef, sourceRefs = [], entityIds = [] } = {}) {
    const normalizedType = normalizeMemoryType(type);
    const normalizedScope = normalizeScope(scope);
    const normalizedSource = normalizeSource(source);
    const text = normalizeContent(content);
    const normalizedTags = normalizeTags(tags);
    const references = normalizeReferences(sourceRefs);
    const entities = normalizeEntityIds(entityIds);

    const decision = policy.requireAuthorization({
      principal,
      action: 'write',
      scopes: [normalizedScope],
      types: [normalizedType]
    });
    links.authorizeRefs({ principal, sourceScope: normalizedScope, refs: references });

    let confirmedAt = null;
    let confirmedBy = null;
    let origin = null;

    if (normalizedSource === 'chat-candidate') {
      if (!confirmationId) {
        throw memoryError('MEMORY_CONFIRMATION_REQUIRED', '候选写入必须携带用户确认（confirmationId）');
      }
      loadCandidates();
      const candidate = candidates.get(String(confirmationId));
      if (!candidate || !confirmingCandidates.has(candidate.id) || candidate.status !== 'accepted' || candidate.memoryId || candidate.type !== normalizedType || candidate.scope.key !== scopeKey(normalizedScope) || candidate.confirmedContent !== text) {
        throw memoryError('MEMORY_CONFIRMATION_REQUIRED', '候选未经用户确认，不能写入长期记忆');
      }
      confirmedAt = candidate.decidedAt;
      confirmedBy = candidate.decidedBy;
      origin = { candidateId: candidate.id, proposedBy: candidate.proposedBy };
    } else if (normalizedSource === 'qq-adapter') {
      origin = { adapter: 'qq', ref: originRef === undefined ? null : String(originRef) };
    }

    if (principal && principal.kind === 'agent' && LONG_TERM_TYPES.includes(normalizedType) && !confirmedAt) {
      throw memoryError(
        'LONG_TERM_REQUIRES_CONFIRMATION',
        'Agent 不能静默写入长期记忆，请先提出候选并取得用户确认'
      );
    }

    const timestamp = now();
    const record = {
      id: store.newId(),
      type: normalizedType,
      scope: normalizedScope,
      scopeKey: scopeKey(normalizedScope),
      content: text,
      tags: normalizedTags,
      source: normalizedSource,
      pinned: pinned === true,
      createdAt: timestamp,
      updatedAt: timestamp,
      rev: 1,
      confirmedAt,
      confirmedBy,
      origin,
      sourceRefs: references,
      entityIds: entities
    };
    return toView(store.insert(record));
  }

  function updateMemory({ principal, id, expectedRev, content, tags, pinned } = {}) {
    const decision = policy.requireAuthorization({ principal, action: 'write' });
    const existing = findAuthorized(decision, id);
    if (!existing) throw memoryError('MEMORY_NOT_FOUND', '记忆不存在：' + String(id));
    // 目标记录类型也必须落在授权类型集合内（read 授权类型与 write 授权类型可能不同）。
    if (decision.types && !decision.types.includes(existing.type) && principal.kind === 'agent') {
      throw memoryError('TYPE_NOT_AUTHORIZED', '该记忆类型不允许由当前主体修改');
    }
    const patch = {};
    if (content !== undefined) patch.content = normalizeContent(content);
    if (tags !== undefined) patch.tags = normalizeTags(tags);
    if (pinned !== undefined) patch.pinned = pinned === true;
    if (Object.keys(patch).length === 0) throw memoryError('INVALID_PARAMS', '没有需要更新的字段');
    const updated = store.update(existing.id, expectedRev, (record) => ({ ...record, ...patch, updatedAt: now() }));
    return readView(updated, principal);
  }

  function deleteMemory({ principal, id, expectedRev } = {}) {
    const decision = policy.requireAuthorization({ principal, action: 'delete' });
    const existing = findAuthorized(decision, id);
    if (!existing) throw memoryError('MEMORY_NOT_FOUND', '记忆不存在：' + String(id));
    return store.remove(existing.id, expectedRev);
  }

  function getMemory({ principal, id } = {}) {
    const decision = authorizeRead({ principal });
    const existing = findAuthorized(decision, id);
    if (!existing) throw memoryError('MEMORY_NOT_FOUND', '记忆不存在：' + String(id));
    const scanned = store.stats.lastScanned;
    return { memory: readView(existing, principal), meta: { scanned } };
  }

  function proposeCandidate({ principal, type, scope, content, reason, sourceRefs = [], entityIds = [] } = {}) {
    const normalizedType = normalizeMemoryType(type);
    const normalizedScope = normalizeScope(scope);
    const decision = policy.requireAuthorization({
      principal,
      action: 'propose',
      scopes: [normalizedScope],
      types: [normalizedType]
    });
    if (!decision) throw memoryError('UNAUTHORIZED', '候选未被授权');
    const references = normalizeReferences(sourceRefs);
    links.authorizeRefs({ principal, sourceScope: normalizedScope, refs: references });
    const entities = normalizeEntityIds(entityIds);
    loadCandidates();
    if (candidates.size >= MAX_CANDIDATES) {
      throw memoryError('STORE_FULL', '候选数量已达上限 ' + MAX_CANDIDATES);
    }
    const candidate = {
      id: 'cand_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
      status: 'pending',
      type: normalizedType,
      scope: { kind: normalizedScope.kind, id: normalizedScope.id, key: scopeKey(normalizedScope) },
      content: normalizeContent(content),
      reason: reason === undefined || reason === null ? '' : String(reason).slice(0, 500),
      proposedBy: principal.kind + ':' + principal.id,
      proposedAt: now(),
      decidedAt: null,
      decidedBy: null,
      memoryId: null,
      sourceRefs: references,
      entityIds: entities
    };
    candidates.set(candidate.id, candidate);
    persistCandidates();
    return { candidate: candidateView(candidate) };
  }

  function listCandidates({ principal, status } = {}) {
    const decision = authorizeRead({ principal, types: null });
    loadCandidates();
    const allowed = new Set(decision.scopeKeys);
    const all = principal.kind === 'user' && decision.scopeKeys.includes('*');
    const rows = [...candidates.values()]
      .filter((candidate) => (all ? true : allowed.has(candidate.scope.key)))
      .filter((candidate) => !decision.types || decision.types.includes(candidate.type) || candidate.proposedBy === principal.kind + ':' + principal.id)
      .filter((candidate) => (status ? candidate.status === status : true))
      .sort((a, b) => b.proposedAt - a.proposedAt)
      .map(candidateView);
    return { candidates: rows };
  }

  function confirmCandidate({ principal, id, decision: verdict, content, pinned } = {}) {
    policy.requireAuthorization({ principal, action: 'confirm' });
    loadCandidates();
    const candidate = candidates.get(String(id));
    if (!candidate) throw memoryError('CANDIDATE_NOT_FOUND', '候选项不存在：' + String(id));
    if (candidate.status !== 'pending') {
      throw memoryError('CANDIDATE_DECIDED', '候选项已处理：' + candidate.status);
    }
    if (verdict !== 'accept' && verdict !== 'reject') {
      throw memoryError('INVALID_PARAMS', 'confirm 只接受 accept / reject');
    }
    if (verdict === 'reject') {
      candidate.status = 'rejected';
      candidate.decidedAt = now();
      candidate.decidedBy = principal.kind + ':' + principal.id;
      persistCandidates();
      return { candidate: candidateView(candidate), memory: null };
    }

    const confirmedContent = normalizeContent(content === undefined ? candidate.content : content);
    // Revalidate provenance before marking accepted so invalid confirmation remains pending.
    links.authorizeRefs({ principal, sourceScope: candidate.scope, refs: candidate.sourceRefs || [] });
    candidate.confirmedContent = confirmedContent;
    candidate.status = 'accepted';
    candidate.decidedAt = now();
    candidate.decidedBy = principal.kind + ':' + principal.id;
    persistCandidates();

    let memory;
    confirmingCandidates.add(candidate.id);
    try {
      memory = createMemory({
        principal, type: candidate.type, scope: candidate.scope, content: confirmedContent,
        source: 'chat-candidate', pinned: pinned === true, confirmationId: candidate.id,
        sourceRefs: candidate.sourceRefs || [], entityIds: candidate.entityIds || []
      });
    } catch (error) {
      candidate.status = 'pending';
      candidate.decidedAt = null;
      candidate.decidedBy = null;
      delete candidate.confirmedContent;
      persistCandidates();
      throw error;
    } finally {
      confirmingCandidates.delete(candidate.id);
    }
    candidate.memoryId = memory.id;
    persistCandidates();
    return { candidate: candidateView(candidate), memory };
  }

  /** 已导入的外部来源 ref 列表：供 adapter 做幂等判定（同样走授权 + 分区扫描）。 */
  function listOriginRefs({ principal, adapter } = {}) {
    const decision = authorizeRead({ principal });
    const want = String(adapter === null || adapter === undefined ? '' : adapter);
    const rows = scanFor(decision, (record) => Boolean(record.origin) && record.origin.adapter === want);
    return { refs: rows.map((record) => record.origin.ref).filter(Boolean) };
  }

  function stats({ principal } = {}) {
    const decision = authorizeRead({ principal });
    const rows = scanFor(decision);
    const byType = {};
    const byScope = {};
    let pinned = 0;
    for (const record of rows) {
      byType[record.type] = (byType[record.type] || 0) + 1;
      byScope[record.scopeKey] = (byScope[record.scopeKey] || 0) + 1;
      if (record.pinned) pinned += 1;
    }
    return {
      total: rows.length,
      pinned,
      byType,
      byScope,
      authorizedScopes: decision.scopeKeys,
      scanned: store.stats.lastScanned
    };
  }

  return {
    list: listRecords,
    search: listRecords,
    get: getMemory,
    create: createMemory,
    update: updateMemory,
    remove: deleteMemory,
    countAll: () => store.count(),
    listOriginRefs,
    proposeCandidate,
    listCandidates,
    confirmCandidate,
    createLink: links.createLink,
    listLinks: links.listLinks,
    resolveReferences: links.resolveReferences,
    buildContextPackage: links.buildContextPackage,
    stats,
    authorize: (request) => policy.authorize(request),
    _store: store,
    _candidatesFile: candidatesFile,
    _policy: policy
  };
}
