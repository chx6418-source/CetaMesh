// Persistent links contain authorized references and bounded context, never copied sessions.
import crypto from 'node:crypto';
import path from 'node:path';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { memoryError, normalizeScope, scopeKey } from './types.js';
import { CONTEXT_LIMITS, MEMORY_RELATIONS, normalizeContextPackage, normalizeReference, normalizeReferences, referenceKey } from './references.js';

export function createMemoryLinks({ stateDir, policy, store, now, list, assess = null }) {
  const file = path.join(stateDir, 'memory', 'links.json');
  let links = null;
  function load() {
    if (links) return;
    let raw;
    try {
      raw = readJsonFile(file, { missing: null });
    } catch (error) {
      if (error instanceof StorageError) throw memoryError('STORE_CORRUPT', 'Memory links could not be read');
      throw error;
    }
    if (raw === null) {
      links = [];
      return;
    }
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || !Array.isArray(raw.links) || raw.links.length > 5000) throw memoryError('STORE_CORRUPT', 'Invalid Memory links');
    const loaded = raw.links.map((link) => {
      if (!link || typeof link.id !== 'string' || !MEMORY_RELATIONS.includes(link.relation)) throw memoryError('STORE_CORRUPT', 'Invalid Memory link');
      const source = normalizeReference(link.source), target = normalizeReference(link.target);
      if (source.scope !== target.scope && link.explicit !== true) throw memoryError('STORE_CORRUPT', 'Implicit cross-scope link');
      return { ...link, source, target, context: normalizeContextPackage(link.context) };
    });
    links = loaded;
  }
  function persist() {
    writeJsonAtomic(file, { schemaVersion: 1, links });
  }
  function authorized(principal, ref) {
    return policy.requireAuthorization({ principal, action: 'read', scopes: [normalizeScope(ref.scope)] });
  }
  function retrieve(decision, ref) {
    if (ref.kind !== 'memory') return { reference: ref, status: 'bound' };
    const rows = store.scanAuthorized(decision.scopeKeys, (record) => record.id === ref.id
      && (!decision.types || decision.types.includes(record.type))
      && (!Object.hasOwn(decision.readOnlyRefs ?? {}, record.scopeKey)
        || decision.readOnlyRefs[record.scopeKey].includes(record.id)));
    if (!rows.length) throw memoryError('MEMORY_NOT_FOUND', 'Referenced memory is unavailable');
    return { reference: ref, status: 'resolved', memory: rows[0] };
  }
  function authorizeRefs({ principal, refs, sourceScope, explicitCrossScope = false }) {
    const origin = scopeKey(normalizeScope(sourceScope));
    authorized(principal, { scope: origin });
    if (!Array.isArray(refs) || refs.length > CONTEXT_LIMITS.refs + CONTEXT_LIMITS.related + 2) throw memoryError('INVALID_REFERENCE', 'Too many authorization references');
    const normalized = refs.map(normalizeReference);
    if (!explicitCrossScope && normalized.some((ref) => ref.scope !== origin)) throw memoryError('CROSS_SCOPE_LINK_REQUIRED', 'Cross-scope references require an explicit authorized link');
    // Finish authorization for every endpoint before retrieving any referenced record.
    const decisions = normalized.map((ref) => authorized(principal, ref));
    return normalized.map((ref, index) => retrieve(decisions[index], ref));
  }
  function createLink({ principal, source, target, relation, explicit = false, context = {} } = {}) {
    policy.requireAuthorization({ principal, action: 'confirm' });
    if (!MEMORY_RELATIONS.includes(relation)) throw memoryError('INVALID_RELATION', 'Unknown Memory relation');
    const from = normalizeReference(source), to = normalizeReference(target);
    if (from.scope !== to.scope && explicit !== true) throw memoryError('CROSS_SCOPE_LINK_REQUIRED', 'Cross-scope linking must be explicit');
    const packet = normalizeContextPackage(context);
    authorizeRefs({ principal, sourceScope: from.scope, refs: [from, to, ...packet.sourceRefs, ...packet.relatedMemories], explicitCrossScope: explicit });
    load();
    const existing = links.find((link) => referenceKey(link.source) === referenceKey(from) && referenceKey(link.target) === referenceKey(to) && link.relation === relation);
    if (existing) return { link: structuredClone(existing), created: false };
    if (links.length >= 5000) throw memoryError('STORE_FULL', 'Memory link limit reached');
    const link = { id: 'link_' + crypto.randomBytes(8).toString('hex'), source: from, target: to, relation, explicit: explicit === true, context: packet, createdAt: now(), createdBy: principal.kind + ':' + principal.id };
    links.push(link);
    try { persist(); } catch (error) { links.pop(); throw error; }
    return { link: structuredClone(link), created: true };
  }
  function listLinks({ principal, scope, entityId, explicitCrossScope = false } = {}) {
    const key = scopeKey(normalizeScope(scope));
    authorized(principal, { scope: key });
    load();
    const visible = [];
    for (const link of links) {
      if (link.source.scope !== key && link.target.scope !== key) continue;
      if (entityId && link.source.id !== entityId && link.target.id !== entityId) continue;
      if (link.source.scope !== link.target.scope && explicitCrossScope !== true) continue;
      try {
        authorizeRefs({ principal, sourceScope: key, refs: [link.source, link.target, ...link.context.sourceRefs, ...link.context.relatedMemories], explicitCrossScope });
        visible.push(structuredClone(link));
      } catch (error) {
        if (!['SCOPE_NOT_AUTHORIZED', 'TYPE_NOT_AUTHORIZED', 'MEMORY_NOT_FOUND', 'CROSS_SCOPE_LINK_REQUIRED'].includes(error.code)) throw error;
      }
    }
    return { links: visible };
  }
  function resolveReferences(request = {}) {
    const normalized = normalizeReferences(request.refs);
    const key = scopeKey(normalizeScope(request.sourceScope));
    // Authorize both ends and verify the saved binding before reading the target record.
    authorized(request.principal, { scope: key });
    if (!request.explicitCrossScope && normalized.some((ref) => ref.scope !== key)) throw memoryError('CROSS_SCOPE_LINK_REQUIRED', 'Cross-scope references require an explicit authorized link');
    const decisions = normalized.map((ref) => authorized(request.principal, ref));
    const visible = listLinks({ principal: request.principal, scope: key, explicitCrossScope: request.explicitCrossScope }).links;
    for (const ref of normalized) {
      if (ref.scope !== key && !visible.some((link) => referenceKey(link.source) === referenceKey(ref) || referenceKey(link.target) === referenceKey(ref))) {
        throw memoryError('CROSS_SCOPE_LINK_REQUIRED', 'No explicit authorized link binds this reference');
      }
    }
    const refs = normalized.map((ref, index) => retrieve(decisions[index], ref));
    return { references: refs.map(({ reference, status, memory }) => {
      const validity=memory&&assess?assess({principal:request.principal,id:memory.id}).status:'current';
      return validity==='current'?{reference,status,...(memory?{type:memory.type,summary:memory.content.slice(0,240)}:{})}
        :{reference,status:'needs-review',validity};
    }) };
  }
  function buildContextPackage({ principal, scope, query, types, limit = 8, explicitCrossScope = false } = {}) {
    const key = scopeKey(normalizeScope(scope));
    const memories = list({ principal, scope: key, query, types, limit: Math.min(Number(limit) || 8, CONTEXT_LIMITS.related) }).memories;
    const eligible=ref=>ref.kind!=='memory'||!assess||assess({principal,id:ref.id}).status==='current';
    const visible = listLinks({ principal, scope: key, explicitCrossScope }).links.filter(link=>
      [link.source,link.target,...link.context.sourceRefs,...link.context.relatedMemories].every(eligible));
    const related = [...memories.map((memory) => ({ kind: 'memory', id: memory.id, scope: memory.scope }))];
    for (const link of visible) {
      for (const ref of [link.source, link.target, ...link.context.relatedMemories]) if (ref.kind === 'memory' && !related.some((other) => referenceKey(other) === referenceKey(ref))) related.push(ref);
    }
    const decisions = visible.flatMap((link) => link.context.keyDecisions).slice(0, CONTEXT_LIMITS.decisions);
    const sourceRefs = [...related, ...memories.flatMap((memory) => memory.sourceRefs || []), ...visible.flatMap((link) => [link.source, link.target, ...link.context.sourceRefs])].filter((ref, index, refs) => eligible(ref)&&refs.findIndex((other) => referenceKey(other) === referenceKey(ref)) === index).slice(0, CONTEXT_LIMITS.refs);
    const dates = memories.flatMap((memory) => [memory.createdAt, memory.updatedAt]);
    return normalizeContextPackage({
      summary: memories.map((memory) => memory.content.slice(0, 240)).join('\n').slice(0, CONTEXT_LIMITS.summaryChars),
      keyDecisions: decisions, sourceRefs, relatedMemories: related.slice(0, CONTEXT_LIMITS.related),
      timeRange: dates.length ? { start: Math.min(...dates), end: Math.max(...dates) } : null,
      confidence: null
    });
  }
  return { createLink, listLinks, resolveReferences, buildContextPackage, authorizeRefs };
}
