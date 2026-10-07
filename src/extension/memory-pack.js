// Data-only Memory Pack protocol. The immutable Base and User Overlay never execute code.
import crypto from 'node:crypto';
import { parseJsonText } from '../storage/json-file.js';
import { extensionError } from './types.js';
import { normalizeMemoryType } from '../memory/types.js';
import { normalizeContextPackage } from '../memory/references.js';

export const MEMORY_PACK_SCHEMA_VERSION = 1;
export const MEMORY_PACK_OVERLAY_KEY = 'memory-pack.user-overlay';
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
const ESCALATION = /(?:ignore\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions?|rules?)|system\s*(?:prompt|instructions?)\s*[:：]|<\/?(?:script|system)>|(?:eval|require|exec|spawn|fetch)\s*\(|(?:忽略|覆盖|绕过).{0,16}(?:系统|权限|安全|规则|指令)|(?:执行|运行).{0,12}(?:shell|powershell|cmd\.exe))/i;

function fail(message) { throw extensionError('MEMORY_PACK_INVALID', message); }
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + ' must be a plain JSON object');
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(label + ' has unsupported fields (code and system instructions are forbidden)');
}
function safeText(value, max, label) {
  if (typeof value !== 'string' || value.length > max || ESCALATION.test(value)) fail(label + ' contains unsupported instructions or exceeds its limit');
  return value.trim();
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Throws on executable legacy packs. Caller must not fall back to the JS host. */
export function validateMemoryPackManifest(manifest) {
  if (!manifest || manifest.type !== 'memory-pack') fail('Expected a memory-pack manifest');
  if (typeof manifest.entry !== 'string' || !/\.json$/i.test(manifest.entry)) fail('Memory Pack entry must be JSON; legacy JavaScript packs require migration');
  const allowed = new Set(['log', 'storage', 'memory.read']);
  for (const permission of manifest.permissions || []) if (!allowed.has(permission)) {
    throw extensionError('MEMORY_PACK_PERMISSION_DENIED', 'Memory Packs cannot request code, shell, native, network, filesystem or Memory write access');
  }
  if ((manifest.network?.hosts || []).length || (manifest.scope?.paths || []).length) throw extensionError('MEMORY_PACK_PERMISSION_DENIED', 'Memory Packs cannot declare network or filesystem access');
  for (const capability of manifest.capabilities || []) {
    if (!['memory', 'memory-pack'].includes(capability.kind)) fail('Memory Pack capabilities must be data references');
    for (const permission of capability.requires || []) if (!allowed.has(permission) || !(manifest.permissions || []).includes(permission)) throw extensionError('MEMORY_PACK_PERMISSION_DENIED', 'Memory Pack capability requests unsupported permission');
  }
  return manifest;
}

/** Strict, bounded reference JSON. Base entries carry reference summaries, never message arrays. */
export function validateMemoryPack(source) {
  let raw = source;
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) fail('Memory Pack exceeds 256 KiB');
    try { raw = parseJsonText(source); } catch { fail('Memory Pack must be reference JSON, never JavaScript'); }
  }
  object(raw, ['schemaVersion', 'kind', 'base'], 'Memory Pack');
  if (raw.schemaVersion !== MEMORY_PACK_SCHEMA_VERSION || raw.kind !== 'memory-pack') fail('Unsupported Memory Pack protocol');
  object(raw.base, ['summary', 'entries'], 'Base');
  if (!Array.isArray(raw.base.entries) || raw.base.entries.length > MAX_ENTRIES) fail('Base requires at most 200 entries');
  const ids = new Set();
  const entries = raw.base.entries.map((entry) => {
    object(entry, ['id', 'type', 'summary', 'keyDecisions', 'sourceRefs', 'timeRange', 'confidence', 'relatedMemories'], 'Base entry');
    const id = safeText(entry.id, 128, 'Entry id');
    if (!/^[A-Za-z0-9._:@-]+$/.test(id) || ids.has(id)) fail('Invalid or duplicate Base entry id');
    ids.add(id);
    const type = normalizeMemoryType(entry.type);
    let packet;
    try {
      const { id: ignoredId, type: ignoredType, ...context } = entry;
      packet = normalizeContextPackage(context);
    } catch (error) { fail(error.message); }
    packet.summary = safeText(packet.summary, 2000, 'Entry summary');
    packet.keyDecisions = packet.keyDecisions.map((text) => safeText(text, 240, 'Key decision'));
    return { id, type, ...packet };
  });
  const result = { schemaVersion: MEMORY_PACK_SCHEMA_VERSION, kind: 'memory-pack', base: { summary: safeText(raw.base.summary ?? '', 2000, 'Base summary'), entries } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) fail('Memory Pack exceeds 256 KiB');
  return freeze(result);
}

function normalizeOverlay(raw, base) {
  object(raw, ['schemaVersion', 'disabledIds', 'notes', 'tags'], 'User Overlay');
  if (raw.schemaVersion !== 1) fail('Unsupported User Overlay version');
  const ids = new Set(base.entries.map((entry) => entry.id));
  if (!Array.isArray(raw.disabledIds) || raw.disabledIds.length > MAX_ENTRIES || raw.disabledIds.some((id) => !ids.has(id))) fail('Overlay refers to an unknown Base entry');
  const notes = raw.notes ?? {}, tags = raw.tags ?? {};
  object(notes, [...ids], 'Overlay notes');
  object(tags, [...ids], 'Overlay tags');
  const normalizedNotes = Object.fromEntries(Object.entries(notes).map(([id, text]) => [id, safeText(text, 2000, 'User note')]));
  const normalizedTags = Object.fromEntries(Object.entries(tags).map(([id, values]) => {
    if (!Array.isArray(values) || values.length > 16) fail('Overlay tags must be a bounded array');
    return [id, values.map((value) => safeText(value, 40, 'User tag'))];
  }));
  return { schemaVersion: 1, disabledIds: [...new Set(raw.disabledIds)], notes: normalizedNotes, tags: normalizedTags };
}

/** Compatible host shape; no vm import, handler loading, network or filesystem capability. */
export function createMemoryPackHost({ manifest, source, storage } = {}) {
  let pack = null, failure = null;
  try { manifest = freeze(structuredClone(manifest)); validateMemoryPackManifest(manifest); pack = validateMemoryPack(source); }
  catch (error) { failure = { code: error.code || 'MEMORY_PACK_INVALID', message: error.message }; }
  function requireAvailable() { if (failure) throw extensionError(failure.code, failure.message); }
  function overlay() {
    requireAvailable();
    const stored = storage?.get(MEMORY_PACK_OVERLAY_KEY);
    if (stored == null) return { schemaVersion: 1, disabledIds: [], notes: {}, tags: {} };
    // Updates can remove Base entries. Keep valid user annotations across a pack update.
    const ids = new Set(pack.base.entries.map((entry) => entry.id));
    object(stored, ['schemaVersion', 'disabledIds', 'notes', 'tags'], 'Stored User Overlay');
    return normalizeOverlay({ ...stored,
      disabledIds: (stored.disabledIds || []).filter((id) => ids.has(id)),
      notes: Object.fromEntries(Object.entries(stored.notes || {}).filter(([id]) => ids.has(id))),
      tags: Object.fromEntries(Object.entries(stored.tags || {}).filter(([id]) => ids.has(id)))
    }, pack.base);
  }
  function view() {
    const userOverlay = overlay();
    return { schemaVersion: 1, kind: 'memory-pack', trust: 'untrusted-reference-data', baseHash: crypto.createHash('sha256').update(JSON.stringify(pack.base)).digest('hex'), base: structuredClone(pack.base), userOverlay,
      entries: pack.base.entries.filter((entry) => !userOverlay.disabledIds.includes(entry.id)).map((entry) => ({ ...structuredClone(entry), userNote: userOverlay.notes[entry.id] || '', userTags: userOverlay.tags[entry.id] || [] })) };
  }
  return {
    manifest: freeze(structuredClone(manifest)), logs: [], available: () => failure === null, loadError: () => failure ? { ...failure } : null,
    capabilities: () => (manifest.capabilities || []).map((capability) => capability.id),
    read: view,
    updateOverlay({ principal, patch } = {}) {
      requireAvailable();
      if (!principal || principal.kind !== 'user' || typeof principal.id !== 'string' || !principal.id.trim()) throw extensionError('MEMORY_PACK_CONFIRMATION_REQUIRED', 'Only a trusted user can update the User Overlay');
      if (!storage || !(manifest.permissions || []).includes('storage')) throw extensionError('PERMISSION_DENIED', 'User Overlay requires declared private storage');
      object(patch, ['disabledIds', 'notes', 'tags'], 'User Overlay patch');
      const updated = normalizeOverlay({ ...overlay(), ...patch, schemaVersion: 1 }, pack.base);
      storage.set(MEMORY_PACK_OVERLAY_KEY, updated);
      return structuredClone(updated);
    },
    async invoke(capabilityId, input = null) {
      requireAvailable();
      const capability = (manifest.capabilities || []).find((item) => item.id === capabilityId);
      if (!capability) throw extensionError('CAPABILITY_NOT_DECLARED', 'Undeclared Memory Pack capability');
      const operation = input?.operation ?? 'list';
      if (!['list', 'get', 'overlay.read'].includes(operation)) throw extensionError('MEMORY_PACK_OPERATION_DENIED', 'Memory Pack invocation supports reference reads only');
      const data = view();
      const result = operation === 'overlay.read' ? data.userOverlay : operation === 'get' ? { trust: data.trust, entry: data.entries.find((entry) => entry.id === input?.id) || null } : data;
      return { capability: capabilityId, result, elapsedMs: 0 };
    }
  };
}
