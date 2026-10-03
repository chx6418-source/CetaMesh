import { CetaError } from '../../shared/errors/CetaError';
import { memoryKinds } from './Memory';
import type {
  MemoryInput,
  MemoryPatch,
  MemoryQuery,
  MemoryRecord,
  MemorySource,
} from './Memory';
export function invalidMemory(): never {
  throw new CetaError('invalid_protocol', 'Invalid memory input');
}
function content(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 16000 ||
    value.includes('\0')
  ) {
    return invalidMemory();
  }
  return value.trim();
}
function score(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return invalidMemory();
  }
  return value;
}
function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 200 ||
    Array.from(value).some(character => character.charCodeAt(0) < 32)
  ) {
    return invalidMemory();
  }
  return value;
}
function source(value: MemorySource): MemorySource {
  if (!value || typeof value !== 'object') {
    return invalidMemory();
  }
  if (value.kind === 'manual') {
    return { kind: 'manual' };
  }
  if (value.kind === 'task') {
    return { kind: 'task', taskId: identifier(value.taskId) };
  }
  if (
    value.kind === 'chat' &&
    Array.isArray(value.messageIds) &&
    value.messageIds.length > 0 &&
    value.messageIds.length <= 200
  ) {
    return {
      kind: 'chat',
      sessionId: identifier(value.sessionId),
      messageIds: [...new Set(value.messageIds.map(identifier))].sort(),
    };
  }
  return invalidMemory();
}
export function normalizeMemory(input: MemoryInput): Required<MemoryInput> {
  if (
    !input ||
    !memoryKinds.includes(input.kind) ||
    (input.scope !== undefined && input.scope !== 'local-only')
  ) {
    return invalidMemory();
  }
  return {
    kind: input.kind,
    scope: 'local-only',
    content: content(input.content),
    source: source(input.source ?? { kind: 'manual' }),
    importance: score(input.importance ?? 0.5),
    confidence: score(input.confidence ?? 0.5),
  };
}
export function validatePatch(patch: MemoryPatch): MemoryPatch {
  if (
    !patch ||
    !Object.keys(patch).length ||
    Object.keys(patch).some(
      k => !['content', 'kind', 'importance', 'confidence'].includes(k),
    )
  ) {
    return invalidMemory();
  }
  const result: MemoryPatch = {};
  if (patch.content !== undefined) {
    result.content = content(patch.content);
  }
  if (patch.kind !== undefined) {
    if (!memoryKinds.includes(patch.kind)) {
      return invalidMemory();
    }
    result.kind = patch.kind;
  }
  if (patch.importance !== undefined) {
    result.importance = score(patch.importance);
  }
  if (patch.confidence !== undefined) {
    result.confidence = score(patch.confidence);
  }
  return result;
}
export function validateQuery(
  query: MemoryQuery,
): Required<Pick<MemoryQuery, 'limit' | 'offset' | 'query'>> & MemoryQuery {
  const limit = query.limit ?? 30,
    offset = query.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    (query.kind !== undefined && !memoryKinds.includes(query.kind)) ||
    (query.pinned !== undefined && typeof query.pinned !== 'boolean') ||
    (query.query !== undefined &&
      (typeof query.query !== 'string' || query.query.length > 200))
  ) {
    return invalidMemory();
  }
  if (query.sourceSessionId !== undefined) {
    identifier(query.sourceSessionId);
  }
  return { ...query, query: query.query?.trim() ?? '', limit, offset };
}
export function requireRevision(record: MemoryRecord, revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    return invalidMemory();
  }
  if (record.revision !== revision) {
    throw new CetaError(
      'sync_conflict',
      'Memory changed; reload before editing',
    );
  }
}
