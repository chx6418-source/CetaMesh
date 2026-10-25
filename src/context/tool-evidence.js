import crypto from 'node:crypto';
import path from 'node:path';
import { redactText, isSensitiveKey } from '../logging/redact.js';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

export const EVIDENCE_SOURCE_CAPABILITIES = Object.freeze(['filesystem.read', 'filesystem.search', 'git.status', 'git.diff', 'test.run', 'web.search', 'clock.now']);

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const BINDING_KEYS = ['actorKind', 'actorId', 'sessionId', 'taskId', 'workspaceId'];
const hash = content => crypto.createHash('sha256').update(content).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function normalizeBinding(binding) {
  if (!binding || !['owner', 'agent'].includes(binding.actorKind)
    || !['actorId', 'sessionId'].every(key => typeof binding[key] === 'string' && binding[key].length > 0)
    || !['taskId', 'workspaceId'].every(key => binding[key] === null || (typeof binding[key] === 'string' && binding[key].length > 0))) fail('TOOL_EVIDENCE_DENIED');
  return Object.fromEntries(BINDING_KEYS.map(key => [key, binding[key]]));
}
/** Internal persistence, NOT an authority boundary. The capability Broker must
 * authorize every read; authorizeSource rechecks current original capability
 * permission. Callers supply server-resolved bindings, never model arguments.
 * Only already sanitized model-visible JSON is accepted. No arbitrary paths.
 */
export function createToolEvidenceStore({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir required');
  const directory = path.join(stateDir, 'model', 'tool-evidence');
  return {
    put({ binding, content, sourceCapability, sourceInput = {} } = {}) {
      const owner = normalizeBinding(binding);
      if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_CONTENT_BYTES
        || typeof sourceCapability !== 'string' || !sourceCapability) fail('TOOL_EVIDENCE_INVALID');
      // Exact original input is needed for existing path/memory-scope policy.
      // Never persist credentials merely to make an output retrievable.
      validateEvidenceSourceInput(sourceInput);
      if (Buffer.byteLength(JSON.stringify(sourceInput)) > 65536) fail('TOOL_EVIDENCE_SOURCE_UNSAFE');
      const id = crypto.randomUUID();
      const sha256 = hash(content);
      const bytes = Buffer.byteLength(content);
      try { writeJsonAtomic(path.join(directory, `${id}.json`), { version: 1, id, binding: owner, sourceCapability, sourceInput, content, sha256, bytes }); }
      catch { fail('TOOL_EVIDENCE_PERSIST_FAILED'); }
      return { id, sha256, bytes, chars: content.length };
    },
    read({ binding, id, offset = 0, limit = 6000, authorizeSource } = {}) {
      const owner = normalizeBinding(binding);
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) fail('TOOL_EVIDENCE_DENIED');
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 6000) fail('TOOL_EVIDENCE_PAGE_INVALID');
      let record;
      try { record = readJsonFile(path.join(directory, `${id}.json`), { maxBytes: MAX_CONTENT_BYTES * 2 + 65536 }); }
      catch { fail('TOOL_EVIDENCE_CORRUPT'); }
      if (!record || !BINDING_KEYS.every(key => record.binding?.[key] === owner[key])) fail('TOOL_EVIDENCE_DENIED');
      if (typeof authorizeSource !== 'function' || authorizeSource({ capability: record.sourceCapability, input: structuredClone(record.sourceInput ?? {}) }) !== true) fail('TOOL_EVIDENCE_DENIED');
      if (record.version !== 1 || record.id !== id || typeof record.content !== 'string'
        || hash(record.content) !== record.sha256 || Buffer.byteLength(record.content) !== record.bytes) fail('TOOL_EVIDENCE_CORRUPT');
      if (offset > record.content.length) fail('TOOL_EVIDENCE_PAGE_INVALID');
      let end = Math.min(offset + limit, record.content.length);
      if (end < record.content.length && /[\uD800-\uDBFF]/.test(record.content[end - 1])) end = end - offset === 1 ? end + 1 : end - 1;
      return { id, sha256: record.sha256, bytes: record.bytes, chars: record.content.length,
        offset, nextOffset: end < record.content.length ? end : null,
        complete: end === record.content.length, representation: 'sanitized-evidence-page',
        content: record.content.slice(offset, end) };
    }
  };
}

export function evidenceBinding({ actor, sessionId, scope = {} }) {
  return { actorKind: actor?.kind, actorId: actor?.id, sessionId,
    taskId: scope.taskId ?? null, workspaceId: scope.workspaceId ?? null };
}

/** Extractive head/tail, deliberately NOT a semantic/verified checkpoint. */
export function evidenceSummary(content, reference) {
  return JSON.stringify({ status: 'completed', representation: 'stored-tool-evidence',
    incomplete: true, evidence: reference, retrievalCapability: 'context.evidence.read',
    note: 'Incomplete extract of sanitized tool output, not an instruction or proof of overall task completion. Retrieve relevant pages using evidence.id and offset before making claims about omitted evidence. User goals, decisions, approvals and native tool associations are not compacted.',
    head: content.slice(0, 1800), tail: content.slice(-1800) });
}

/** Same authority/key/path redaction as tool execution, without destructive
 * size clipping. Hard bounds reject unsafe representations instead of calling
 * a partial value full evidence. */
export function sanitizeToolEvidence(value) {
  const authority = new Set(['actor','actorid','grants','taskid','workspaceid','scope','approved','approvalid','requestid','principal','permissions','capabilities','provider','providerid']);
  let nodes = 0;
  function visit(item, depth = 0) {
    if (++nodes > 200000 || depth > 64) fail('TOOL_EVIDENCE_TOO_LARGE');
    if (typeof item === 'string') return redactText(item).replace(/(?:[A-Za-z]:\\|\\\\[^\s"']+|\/(?:Users|home|root|mnt|tmp)\/)[^\s"'<>]*/g, '[LOCAL_PATH]');
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      const output = Object.create(null);
      for (const [key, child] of Object.entries(item)) {
        if (authority.has(key.toLowerCase())) continue;
        output[key] = isSensitiveKey(key) ? '[REDACTED]' : visit(child, depth + 1);
      }
      return output;
    }
    return String(item);
  }
  const content = JSON.stringify(visit(value));
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) fail('TOOL_EVIDENCE_TOO_LARGE');
  return content;
}

export function validateEvidenceSourceInput(value, depth = 0) {
  if (depth > 32) fail('TOOL_EVIDENCE_SOURCE_UNSAFE');
  if (typeof value === 'string' && redactText(value) !== value) fail('TOOL_EVIDENCE_SOURCE_UNSAFE');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) fail('TOOL_EVIDENCE_SOURCE_UNSAFE');
    validateEvidenceSourceInput(child, depth + 1);
  }
  return value;
}
