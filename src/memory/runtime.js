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

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import {
  LONG_TERM_TYPES,
  MEMORY_LIMITS,
  assertPrincipal,
  memoryError,
  normalizeContent,
  normalizeFactMetadata,
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
/** 已决策候选（accepted/rejected）的保留上限：accepted 的结果已在 memories 里，这只是决策流水。 */
const MAX_DECIDED_CANDIDATES = 200;
const TYPE_WEIGHT = Object.freeze({ working: 5, chat: 4, user: 3, task: 2, workspace: 1 });

function loadCandidateFile(file, fallback) {
  try {
    return readJsonFile(file, { missing: fallback });
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === 'CORRUPT') throw memoryError('STORE_CORRUPT', '候选解析失败：' + file);
      throw memoryError('STORE_CORRUPT', '候选读取失败：' + file);
    }
    throw error;
  }
}

/** Retention：已决策候选只保留最近 MAX_DECIDED_CANDIDATES 条；pending 绝不自动清。 */
export function pruneDecidedCandidates(list) {
  const decided = list
    .filter((candidate) => candidate && candidate.status !== 'pending' && candidate.status !== 'confirming')
    .sort((a, b) => (Number(a.decidedAt) || 0) - (Number(b.decidedAt) || 0));
  if (decided.length <= MAX_DECIDED_CANDIDATES) return list;
  const evict = new Set(decided.slice(0, decided.length - MAX_DECIDED_CANDIDATES).map((c) => c.id));
  return list.filter((candidate) => !evict.has(candidate?.id));
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
    entityIds: [...(record.entityIds || [])],
    ...(record.factKey ? { factKey: record.factKey } : {}),
    ...(record.validUntil != null ? { validUntil: record.validUntil } : {})
  };
}

export function createMemoryRuntime({ stateDir, audit = null, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMemoryRuntime 需要 stateDir');
  const policy = createMemoryPolicy({ audit });
  const store = createMemoryStore({ stateDir, now });
  const candidatesFile = path.join(stateDir, 'memory', 'candidates.json');
  const links = createMemoryLinks({ stateDir, policy, store, now, list: retrieveRecords, assess: assessFact });

  const candidates = new Map(); // id -> candidate
  const confirmingCandidates = new Set(); // only the trusted confirmation path may consume a candidate
  let candidatesLoaded = false;
  let candidatesBackupPath = null;

  function backupCandidates() {
    if (candidatesBackupPath || !fs.existsSync(candidatesFile)) return;
    const backup = path.join(path.dirname(candidatesFile), `candidates.corrupt.${now()}.${crypto.randomBytes(4).toString('hex')}.json`);
    try { fs.copyFileSync(candidatesFile, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { throw memoryError('STORE_RECOVERY_FAILED', '候选文件损坏且无法备份：' + error.message); }
    candidatesBackupPath = backup;
  }

  function loadCandidates() {
    if (candidatesLoaded) return;
    let raw;
    try { raw = loadCandidateFile(candidatesFile, null); }
    catch (error) { backupCandidates(); throw error; }
    if (raw === null) { candidatesLoaded = true; return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== CANDIDATE_SCHEMA_VERSION
      || !Array.isArray(raw.candidates) || raw.candidates.length > MAX_CANDIDATES + MAX_DECIDED_CANDIDATES) {
      backupCandidates(); throw memoryError('STORE_CORRUPT', '候选文件结构或版本无效：' + candidatesFile);
    }
    const list = raw.candidates;
    const next = new Map();
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !item.id || !['pending', 'confirming', 'accepted', 'rejected'].includes(item.status)
        || typeof item.scope?.key !== 'string' || typeof item.content !== 'string' || next.has(item.id)) {
        backupCandidates();
        throw memoryError('STORE_CORRUPT', '候选记录结构无效：' + candidatesFile);
      }
      next.set(item.id, item);
    }
    candidates.clear();
    for (const [id, item] of next) candidates.set(id, item);
    candidatesLoaded = true;
  }

  function persistCandidates() {
    // Persist first. A failed write must leave the loaded candidate map unchanged.
    const pruned = pruneDecidedCandidates([...candidates.values()]);
    writeJsonAtomic(candidatesFile, {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      updatedAt: now(),
      candidates: pruned
    });
    if (pruned.length !== candidates.size) {
      const keep = new Set(pruned.map((candidate) => candidate.id));
      for (const id of [...candidates.keys()]) if (!keep.has(id)) candidates.delete(id);
    }
  }

  function replaceCandidateAndPersist(id, next) {
    const previous = candidates.get(id);
    candidates.set(id, next);
    try { persistCandidates(); }
    catch (error) { candidates.set(id, previous); throw error; }
    return next;
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
    return decision.scopeKeys.includes('*') ? store.allScopeKeys()
      .filter(key => !key.startsWith('user:') || key === `user:${decision.userScopeId}`) : decision.scopeKeys;
  }

  function scanFor(decision, predicate) {
    return store.scanAuthorized(effectiveScopes(decision), (record) => {
      if (Object.hasOwn(decision.readOnlyRefs ?? {}, record.scopeKey)
        && !decision.readOnlyRefs[record.scopeKey].includes(record.id)) return false;
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

  function listRecords({ principal, scope, types, pinned, query, limit, offset = 0 } = {}) {
    const scopes = scope === undefined || scope === null ? null : [normalizeScope(scope)];
    const decision = authorizeRead({ principal, scopes, types: types || null });
    const text = normalizeQuery(query);
    const needle = text.toLowerCase();
    const max = normalizeLimit(limit, 50);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 20000) throw memoryError('INVALID_PARAMS', 'Invalid memory offset');
    const rows = scanFor(decision, (record) => {
      if (pinned === true && record.pinned !== true) return false;
      if (pinned === false && record.pinned === true) return false;
      if (!needle) return true;
      return record.content.toLowerCase().includes(needle)
        || record.tags.some((tag) => tag.toLowerCase().includes(needle));
    });
    const scanned = store.stats.lastScanned;
    const results = rank(rows, needle, text).slice(offset, offset + max).map((record) => readView(record, principal));
    return {
      memories: results,
      meta: {
        authorizedScopes: decision.scopeKeys,
        authorizedTypes: decision.types,
        scanned,
        total: rows.length,
        offset,
        returned: results.length
      }
    };
  }

  function factEligibility(rows,principal) {
    const expired=new Set(rows.filter(row=>row.validUntil!=null&&row.validUntil<=now()).map(row=>row.id));
    const groups=new Map(),conflicted=new Set(),superseded=new Set(),visible=new Map(rows.map(row=>[row.id,row]));
    for(const scope of new Set(rows.map(row=>row.scopeKey))) {
      for(const link of links.listLinks({principal,scope}).links) {
        const source=visible.get(link.source.id),target=visible.get(link.target.id),binding=link.factBinding;
        if(link.relation==='supersedes'&&link.createdBy?.startsWith('user:')&&source&&target&&source.id!==target.id
          &&source.scopeKey===scope&&target.scopeKey===scope&&source.type===target.type&&source.factKey&&source.factKey===target.factKey
          &&binding?.sourceRevision===source.rev&&binding.targetRevision===target.rev&&!expired.has(source.id))superseded.add(target.id);
      }
    }
    for(const id of links.replacementTargets({principal,targets:rows.filter(row=>row.factKey).map(row=>({id:row.id,scope:row.scopeKey}))}))
      if(!superseded.has(id))conflicted.add(id);
    for(const row of rows)if(row.factKey&&!expired.has(row.id)&&!superseded.has(row.id)){

      const key=JSON.stringify([row.scopeKey,row.type,row.factKey]);
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
    }
    for(const group of groups.values())if(new Set(group.map(row=>row.content)).size>1)for(const row of group)conflicted.add(row.id);
    return {expired,conflicted,superseded};
  }
  function assessFact({principal,id}={}) {
    const decision=authorizeRead({principal});const row=findAuthorized(decision,id);
    if(!row)throw memoryError('MEMORY_NOT_FOUND','Memory not found');
    const state=factEligibility(scanFor(decision,item=>item.scopeKey===row.scopeKey&&item.type===row.type),principal);
    return {id:row.id,status:state.expired.has(row.id)?'expired':state.superseded.has(row.id)?'superseded':state.conflicted.has(row.id)?'conflicted':'current'};
  }
  function retrieveRecords({ principal, scope, types, query, limit } = {}) {
    const scopes = scope === undefined || scope === null ? null : [normalizeScope(scope)];
    const decision = authorizeRead({ principal, scopes, types: types || null });
    const needle = normalizeQuery(query).toLowerCase();
    const grams = [...new Set((needle.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word => {
      const chars = Array.from(word);
      return chars.length > 2 ? [...chars.slice(1).map((_, i) => chars.slice(i, i + 2).join('')), word] : [word];
    }))];
    const scannedRows = scanFor(decision), eligibility = factEligibility(scannedRows,principal);
    const rows = scannedRows.filter(row=>!eligibility.expired.has(row.id)&&!eligibility.conflicted.has(row.id)&&!eligibility.superseded.has(row.id));
    // Automatic retrieval excludes unrelated records; empty queries preserve browsing.
    const ranked = rows.map(row => {
      const haystack = (row.content + ' ' + row.tags.join(' ')).toLowerCase();
      return { row, score: grams.reduce((sum, gram) => sum + (haystack.includes(gram) ? gram.length : 0), 0) };
    }).filter(item => !needle || item.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.row.pinned) - Number(a.row.pinned)
      || b.row.updatedAt - a.row.updatedAt || a.row.id.localeCompare(b.row.id));
    const max = normalizeLimit(limit, 50);
    return { memories: ranked.slice(0, max).map(item => readView(item.row, principal)),
      meta: { total: scannedRows.length, matched: ranked.length, expired: eligibility.expired.size, conflicted: eligibility.conflicted.size, superseded: eligibility.superseded.size,
        scanned: store.stats.lastScanned, returned: Math.min(ranked.length, max) } };
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

  function createMemory({ principal, type, scope, content, tags, source, pinned, confirmationId, originRef, sourceRefs = [], entityIds = [], factKey, validUntil } = {}) {
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
      if (!candidate || !confirmingCandidates.has(candidate.id) || candidate.status !== 'confirming' || candidate.memoryId || candidate.type !== normalizedType || candidate.scope.key !== scopeKey(normalizedScope) || candidate.confirmedContent !== text) {
        throw memoryError('MEMORY_CONFIRMATION_REQUIRED', '候选未经用户确认，不能写入长期记忆');
      }
      confirmedAt = candidate.decidedAt;
      confirmedBy = candidate.decidedBy;
      origin = { candidateId: candidate.id, proposedBy: candidate.proposedBy };
    } else if (normalizedSource === 'qq-adapter') {
      origin = { adapter: 'qq', ref: originRef === undefined ? null : String(originRef),
        sourceHash: crypto.createHash('sha256').update(JSON.stringify({ content: text, tags: normalizedTags, pinned: pinned === true })).digest('hex') };
    }

    if (principal && principal.kind === 'agent' && LONG_TERM_TYPES.includes(normalizedType) && !confirmedAt) {
      throw memoryError(
        'LONG_TERM_REQUIRES_CONFIRMATION',
        'Agent 不能静默写入长期记忆，请先提出候选并取得用户确认'
      );
    }

    const timestamp = now();
    const record = {
      id: confirmationId ? 'mem_' + confirmationId : store.newId(),
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
      entityIds: entities,
      ...normalizeFactMetadata({factKey,validUntil},principal)
    };
    return toView(store.insert(record));
  }

  function updateMemory({ principal, id, expectedRev, content, tags, pinned, factKey, validUntil } = {}) {
    const decision = policy.requireAuthorization({ principal, action: 'write' });
    const existing = findAuthorized(decision, id);
    if (!existing) throw memoryError('MEMORY_NOT_FOUND', '记忆不存在：' + String(id));
    if(principal.kind!=='user'&&(existing.factKey||existing.validUntil!=null))
      throw memoryError('FACT_METADATA_REQUIRES_USER','User-established fact identity and content require user correction');
    // 目标记录类型也必须落在授权类型集合内（read 授权类型与 write 授权类型可能不同）。
    if (decision.types && !decision.types.includes(existing.type) && principal.kind === 'agent') {
      throw memoryError('TYPE_NOT_AUTHORIZED', '该记忆类型不允许由当前主体修改');
    }
    const patch = normalizeFactMetadata({factKey,validUntil},principal);
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
    const normalizedContent = normalizeContent(content);
    const duplicate = [...candidates.values()].find(item => item.status === 'pending'
      && item.type === normalizedType && item.scope.key === scopeKey(normalizedScope)
      && item.content === normalizedContent);
    if (duplicate) return { candidate: candidateView(duplicate), duplicate: true };
    const prior = [...candidates.values()].find(item => item.status === 'accepted'
      && item.type === normalizedType && item.scope.key === scopeKey(normalizedScope)
      && item.content === normalizedContent && item.memoryId);
    if (prior && store.get(prior.memoryId)?.content === normalizedContent) {
      return { candidate: null, duplicate: true, existingMemoryId: prior.memoryId };
    }
    if ([...candidates.values()].filter(item => ['pending', 'confirming'].includes(item.status)).length >= MAX_CANDIDATES) {
      throw memoryError('STORE_FULL', '候选数量已达上限 ' + MAX_CANDIDATES);
    }
    const candidate = {
      id: 'cand_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
      status: 'pending',
      type: normalizedType,
      scope: { kind: normalizedScope.kind, id: normalizedScope.id, key: scopeKey(normalizedScope) },
      content: normalizedContent,
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
    try { persistCandidates(); }
    catch (error) { candidates.delete(candidate.id); throw error; }
    return { candidate: candidateView(candidate) };
  }

  function listCandidates({ principal, status } = {}) {
    const decision = authorizeRead({ principal, types: null });
    loadCandidates();
    const allowed = new Set(decision.scopeKeys);
    const all = principal.kind === 'user' && decision.scopeKeys.includes('*');
    const rows = [...candidates.values()]
      .filter((candidate) => (all
        ? candidate.scope.kind !== 'user' || candidate.scope.id === principal.id
        : allowed.has(candidate.scope.key)))
      .filter((candidate) => !decision.types || decision.types.includes(candidate.type) || candidate.proposedBy === principal.kind + ':' + principal.id)
      .filter((candidate) => (status ? candidate.status === status : true))
      .sort((a, b) => b.proposedAt - a.proposedAt)
      .map(candidateView);
    return { candidates: rows, meta: { total: rows.length, pending: rows.filter(row => row.status === 'pending').length,
      confirming: rows.filter(row => row.status === 'confirming').length, capacity: MAX_CANDIDATES,
      remaining: Math.max(0, MAX_CANDIDATES - [...candidates.values()].filter(row => ['pending', 'confirming'].includes(row.status)).length) } };
  }

  function recoverConfirmations({ principal } = {}) {
    policy.requireAuthorization({ principal, action: 'confirm' });
    loadCandidates();
    const recovered = [];
    const failed = [];
    for (const candidate of [...candidates.values()]) {
      if (candidate.status !== 'confirming' && !(candidate.status === 'accepted' && !candidate.memoryId)) continue;
      try {
        if (candidate.status === 'accepted') {
          if (!candidate.confirmedContent || !candidate.decidedBy) throw memoryError('STORE_CORRUPT', 'Legacy accepted candidate has no recoverable confirmation intent');
          replaceCandidateAndPersist(candidate.id, { ...candidate, status: 'confirming' });
        }
        const result = confirmCandidate({ principal, id: candidate.id, decision: 'accept' });
        recovered.push(result.candidate.id);
      } catch (error) {
        // Keep the durable intent for the next recovery pass; never fabricate success.
        failed.push({ id: candidate.id, code: error?.code ?? 'STORE_WRITE_FAILED' });
      }
    }
    return { recovered, failed };
  }

  function confirmCandidate({ principal, id, decision: verdict, content, pinned } = {}) {
    policy.requireAuthorization({ principal, action: 'confirm' });
    loadCandidates();
    const candidate = candidates.get(String(id));
    if (!candidate) {
      const memory = verdict === 'accept'
        ? findAuthorized(authorizeRead({ principal }), 'mem_' + String(id)) : null;
      if (memory?.origin?.candidateId === String(id)) return { candidate: {
        id: String(id), status: 'accepted', memoryId: memory.id, scope: memory.scopeKey,
        type: memory.type, content: memory.content
      }, memory: readView(memory, principal) };
      throw memoryError('CANDIDATE_NOT_FOUND', '候选项不存在：' + String(id));
    }
    if (candidate.scope.kind === 'user' && candidate.scope.id !== principal.id) {
      throw memoryError('SCOPE_NOT_AUTHORIZED', 'Candidate belongs to another User scope');
    }
    if (verdict !== 'accept' && verdict !== 'reject') {
      throw memoryError('INVALID_PARAMS', 'confirm 只接受 accept / reject');
    }
    if (candidate.status === 'accepted' && verdict === 'accept') {
      const memory = store.get(candidate.memoryId || 'mem_' + candidate.id);
      if (!memory || memory.origin?.candidateId !== candidate.id) throw memoryError('STORE_CORRUPT', '已确认候选缺少匹配的记忆记录');
      return { candidate: candidateView(candidate), memory: readView(memory, principal) };
    }
    if (candidate.status === 'rejected' && verdict === 'reject') return { candidate: candidateView(candidate), memory: null };
    if (candidate.status !== 'pending' && candidate.status !== 'confirming') {
      throw memoryError('CANDIDATE_DECIDED', '候选项已处理：' + candidate.status);
    }
    if (verdict === 'reject' && candidate.status === 'confirming') {
      throw memoryError('CANDIDATE_DECIDED', '候选确认正在恢复，不能拒绝已批准内容');
    }
    if (verdict === 'reject') {
      const rejected = replaceCandidateAndPersist(candidate.id, { ...candidate,
        status: 'rejected', decidedAt: now(), decidedBy: principal.kind + ':' + principal.id });
      return { candidate: candidateView(rejected), memory: null };
    }

    const confirmedContent = normalizeContent(content === undefined ? (candidate.confirmedContent ?? candidate.content) : content);
    if (candidate.status === 'confirming' && (verdict !== 'accept' || confirmedContent !== candidate.confirmedContent)) {
      throw memoryError('CANDIDATE_DECIDED', '候选确认正在恢复，不能更改已批准内容');
    }
    // Revalidate provenance before marking accepted so invalid confirmation remains pending.
    links.authorizeRefs({ principal, sourceScope: candidate.scope, refs: candidate.sourceRefs || [] });
    const intent = candidate.status === 'confirming' ? candidate : replaceCandidateAndPersist(candidate.id, { ...candidate,
      confirmedContent, status: 'confirming', decidedAt: now(), decidedBy: principal.kind + ':' + principal.id,
      confirmedPinned: pinned === true });

    let memory;
    confirmingCandidates.add(candidate.id);
    try {
      const existing = store.get('mem_' + candidate.id);
      if (existing && (existing.origin?.candidateId !== candidate.id || existing.content !== confirmedContent
        || existing.scopeKey !== candidate.scope.key || existing.type !== candidate.type)) {
        throw memoryError('STORE_CORRUPT', '候选恢复记录与已批准内容不一致');
      }
      memory = existing ? readView(existing, principal) : createMemory({
        principal, type: intent.type, scope: intent.scope, content: confirmedContent,
        source: 'chat-candidate', pinned: intent.confirmedPinned === true, confirmationId: intent.id,
        sourceRefs: intent.sourceRefs || [], entityIds: intent.entityIds || []
      });
    } finally {
      confirmingCandidates.delete(candidate.id);
    }
    const completed = replaceCandidateAndPersist(candidate.id, { ...intent, status: 'accepted', memoryId: memory.id });
    return { candidate: candidateView(completed), memory };
  }

  /** 已导入的外部来源 ref 列表：供 adapter 做幂等判定（同样走授权 + 分区扫描）。 */
  function listOriginRefs({ principal, adapter } = {}) {
    const decision = authorizeRead({ principal });
    const want = String(adapter === null || adapter === undefined ? '' : adapter);
    const rows = scanFor(decision, (record) => Boolean(record.origin) && record.origin.adapter === want);
    return { refs: rows.map((record) => record.origin.ref).filter(Boolean),
      entries: rows.map(record => ({ ref: record.origin.ref, id: record.id, scope: record.scopeKey,
        content: record.content, tags: [...record.tags], rev: record.rev, sourceHash: record.origin.sourceHash ?? null })) };
  }

  function syncQqEntry({ principal, id, ref, entry = null, dryRun = false } = {}) {
    const decision = policy.requireAuthorization({ principal, action: entry ? 'write' : 'delete' });
    const record = findAuthorized(decision, id);
    if (!record || record.origin?.adapter !== 'qq' || record.origin.ref !== ref) {
      throw memoryError('MEMORY_NOT_FOUND', 'QQ import record does not match source');
    }
    const currentHash = crypto.createHash('sha256').update(JSON.stringify({ content: record.content, tags: record.tags,
      pinned: record.pinned })).digest('hex');
    if (!record.origin.sourceHash || currentHash !== record.origin.sourceHash) {
      throw memoryError('SYNC_CONFLICT', 'QQ import was edited locally or predates source tracking');
    }
    if (entry && (record.scopeKey !== scopeKey(normalizeScope(entry.scope)) || record.type !== entry.type)) {
      throw memoryError('SYNC_CONFLICT', 'QQ source identity changed scope or type');
    }
    if (!entry) return dryRun ? { id, action: 'delete' } : store.remove(id, record.rev);
    const content = normalizeContent(entry.content);
    const tags = normalizeTags(entry.tags);
    if (record.content === content && JSON.stringify(record.tags) === JSON.stringify(tags)) return { id, action: 'unchanged' };
    if (dryRun) return { id, action: 'update' };
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify({ content, tags, pinned: record.pinned })).digest('hex');
    const updated = store.update(id, record.rev, row => ({ ...row, content, tags,
      origin: { ...row.origin, sourceHash }, updatedAt: now() }));
    return { id, action: 'update', rev: updated.rev };
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
    retrieve: retrieveRecords,
    assess: assessFact,
    get: getMemory,
    create: createMemory,
    update: updateMemory,
    remove: deleteMemory,
    countAll: () => store.count(),
    listOriginRefs,
    syncQqEntry,
    proposeCandidate,
    listCandidates,
    confirmCandidate,
    recoverConfirmations,
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
