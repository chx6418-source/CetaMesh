// Memory v2 reference contracts. References bind entities; they never contain chat history.
import { memoryError, normalizeScope, scopeKey } from './types.js';

export const MEMORY_RELATIONS = Object.freeze(['related-to', 'derived-from', 'used-by', 'supersedes', 'proposed-by', 'belongs-to']);
export const REFERENCE_KINDS = Object.freeze(['memory', 'chat', 'task', 'workspace', 'user', 'social', 'knowledge', 'skill', 'agent', 'candidate']);
export const CONTEXT_LIMITS = Object.freeze({ summaryChars: 2000, decisions: 12, decisionChars: 240, refs: 24, related: 20 });

function bounded(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw memoryError('INVALID_REFERENCE', label + ' must be a bounded string');
  return value.trim();
}

export function normalizeReference(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw memoryError('INVALID_REFERENCE', 'Reference must be an object');
  if (Object.keys(raw).some((key) => !['kind', 'id', 'scope'].includes(key))) throw memoryError('INVALID_REFERENCE', 'Reference accepts only kind, id and scope');
  if (!REFERENCE_KINDS.includes(raw.kind)) throw memoryError('INVALID_REFERENCE', 'Unknown reference kind');
  const id = bounded(raw.id, 128, 'Reference id');
  if (!/^[A-Za-z0-9._:@-]+$/.test(id)) throw memoryError('INVALID_REFERENCE', 'Invalid reference id');
  return { kind: raw.kind, id, scope: scopeKey(normalizeScope(raw.scope)) };
}

export function normalizeReferences(raw = []) {
  if (!Array.isArray(raw) || raw.length > CONTEXT_LIMITS.refs) throw memoryError('INVALID_REFERENCE', 'Too many source references');
  const refs = raw.map(normalizeReference);
  return refs.filter((ref, index) => refs.findIndex((other) => referenceKey(ref) === referenceKey(other)) === index);
}

export function referenceKey(ref) { return ref.scope + '/' + ref.kind + '/' + ref.id; }

export function normalizeContextPackage(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw memoryError('INVALID_CONTEXT_PACKAGE', 'Context package must be an object');
  if (Object.keys(raw).some((key) => !['summary', 'keyDecisions', 'sourceRefs', 'timeRange', 'confidence', 'relatedMemories'].includes(key))) {
    throw memoryError('INVALID_CONTEXT_PACKAGE', 'Context packages accept bounded summaries and references only');
  }
  const decisions = raw.keyDecisions ?? [];
  if (!Array.isArray(decisions) || decisions.length > CONTEXT_LIMITS.decisions) throw memoryError('INVALID_CONTEXT_PACKAGE', 'Too many key decisions');
  const related = raw.relatedMemories ?? [];
  if (!Array.isArray(related) || related.length > CONTEXT_LIMITS.related) throw memoryError('INVALID_CONTEXT_PACKAGE', 'Too many related memories');
  let timeRange = null;
  if (raw.timeRange != null) {
    const range = raw.timeRange;
    if (!range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).some((key) => !['start', 'end'].includes(key))) throw memoryError('INVALID_CONTEXT_PACKAGE', 'Invalid time range');
    const start = range.start == null ? null : range.start;
    const end = range.end == null ? null : range.end;
    if ([start, end].some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0)) || (start !== null && end !== null && start > end)) throw memoryError('INVALID_CONTEXT_PACKAGE', 'Invalid time range bounds');
    timeRange = { start, end };
  }
  const confidence = raw.confidence ?? null;
  if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw memoryError('INVALID_CONTEXT_PACKAGE', 'confidence must be null or between 0 and 1');
  return {
    summary: bounded(raw.summary ?? '', CONTEXT_LIMITS.summaryChars, 'Summary'),
    keyDecisions: decisions.map((value) => bounded(value, CONTEXT_LIMITS.decisionChars, 'Decision')),
    sourceRefs: normalizeReferences(raw.sourceRefs ?? []),
    timeRange,
    confidence,
    relatedMemories: related.map(normalizeReference)
  };
}
