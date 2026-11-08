// Private protocol sources owned by Managed, never an execution-state loader.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { fingerprintHistorySource } from '../context/history-synopsis.js';

export const MANAGED_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sourcePointer = value => value && Object.keys(value).every(key => ['sessionId', 'sourceFingerprint', 'revision'].includes(key))
  && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 240
  && /^[a-f0-9]{64}$/.test(value.sourceFingerprint) && /^[a-f0-9]{64}$/.test(value.revision);
const validGap = value => value && value.version === 1 && value.representation === 'retained-history-gap'
  && typeof value.retainedOriginal === 'boolean' && value.noReplay === true
  && ['missing-source', 'incomplete-source', 'missing-predecessor', 'inherited-gap', 'legacy-transcript-order'].includes(value.reason)
  && (value.retainedOrigin === null || sourcePointer(value.retainedOrigin))
  && Number.isSafeInteger(value.omittedMessageCount) && value.omittedMessageCount >= 0
  && Array.isArray(value.skippedSessionIds) && value.skippedSessionIds.length <= 100
  && value.skippedSessionIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 240);
const privateProtocol = value => value && typeof value === 'object' && Object.entries(value)
  .some(([key, child]) => /continuation|reasoning|thinking|signature|encrypted_content/i.test(key) || privateProtocol(child));
// Only the leading system prefix is refreshable context. Core feedback after
// conversation starts belongs to the exact ordered transcript, including its role.
export function splitManagedHistoryMessages(messages) {
  const first = messages.findIndex(message => message.role !== 'system');
  const boundary = first < 0 ? messages.length : first;
  return { headers: messages.slice(0, boundary), body: messages.slice(boundary) };
}
export function managedHistoryHasLegacyOrder(messages) {
  const marker = 'CetaMesh post-write verification feedback (JSON reference data):\n';
  // This known Core fact only belongs after a tool receipt. A legacy leading
  // copy proves lost ordering, never effect settlement or recovery authority.
  return splitManagedHistoryMessages(messages).headers.some(message => {
    if (typeof message.content !== 'string' || !message.content.startsWith(marker)) return false;
    let fact;
    try { fact = JSON.parse(message.content.slice(marker.length)); } catch { return false; }
    return fact?.kind === 'post-write-verification'
      && ['not-run', 'pending', 'passed', 'failed', 'unknown'].includes(fact.state)
      && Array.isArray(fact.sourceWriteIds) && fact.sourceWriteIds.every(id => typeof id === 'string')
      && (fact.configDigest === null || typeof fact.configDigest === 'string' && /^[a-f0-9]{64}$/.test(fact.configDigest))
      && (fact.operationRef === null || typeof fact.operationRef === 'string')
      && (fact.code === undefined || typeof fact.code === 'string')
      && Object.keys(fact).every(key => ['kind', 'state', 'sourceWriteIds', 'configDigest', 'operationRef', 'code'].includes(key));
  });
}
export function managedHistorySettled(messages) {
  const pending = new Set();
  for (const message of messages) {
    // Native protocol belongs to its original live model session. Retain it on
    // disk, but do not inject signatures/private continuation into a cold one.
    if (privateProtocol(message)) return false;
    for (const call of message.tool_calls ?? []) {
      if (pending.has(call.id)) return false;
      pending.add(call.id);
    }
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) return false;
      let result;
      try { result = JSON.parse(message.content); } catch { return false; }
      if (['pending', 'pending_approval', 'running', 'unknown', 'outcome-unknown', 'cancel-unconfirmed', 'needs-reconciliation', 'interrupted'].includes(result?.status)
        || result?.effectStatus === 'unknown' || result?.error?.effectStatus === 'unknown') return false;
    }
  }
  return pending.size === 0;
}

export function createManagedHistorySource({ stateDir } = {}) {
  if (!stateDir) return null;
  const fileFor = sessionId => path.join(stateDir, 'agent', 'managed-history', createHash('sha256').update(sessionId).digest('hex') + '.json');
  function read(binding, { missing = false } = {}) {
    let row;
    try { row = readJsonFile(fileFor(binding.sessionId), { missing: null, maxBytes: MANAGED_HISTORY_MAX_BYTES }); }
    catch { fail('CONTEXT_HISTORY_UNAVAILABLE', 'Managed source cannot be read; preserve the original and restore its storage.'); }
    if (row === null) {
      if (missing) return null;
      fail('CONTEXT_HISTORY_UNAVAILABLE', 'Managed source is missing; original history must be restored before retrieval.');
    }
    if (row.schemaVersion !== 1 || !Array.isArray(row.messages) || !Array.isArray(row.pendingCallIds)
      || !['settled-transcript', 'request-projection', 'tool-calls', 'turn-complete'].includes(row.phase)
      || !/^[a-f0-9]{64}$/.test(row.revision) || typeof row.turnId !== 'string'
      || row.derivedFrom !== undefined && !sourcePointer(row.derivedFrom)
      || row.historyGap !== undefined && !validGap(row.historyGap)
      || row.integrity !== hash(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'integrity')))) {
      fail('CONTEXT_HISTORY_UNAVAILABLE', 'Managed source version or integrity is unavailable; original bytes are retained.');
    }
    if (!same(row.binding, binding)) fail('CONTEXT_HISTORY_DENIED', 'Managed source belongs to a different Task, Workspace, actor or Session.');
    if (row.sourceFingerprint !== fingerprintHistorySource({ messages: row.messages, sourceBinding: binding })) fail('CONTEXT_SYNOPSIS_STALE', 'Managed source content changed.');
    return row;
  }
  function write(payload) {
    const previous = read(payload.binding, { missing: true });
    if (previous) {
      const before = splitManagedHistoryMessages(previous.messages).body;
      const after = splitManagedHistoryMessages(payload.messages).body;
      if (!same(after.slice(0, before.length), before)) fail('CONTEXT_SYNOPSIS_STALE', 'Managed checkpoint cannot replace retained protocol history.');
      if (previous.turnId === payload.turnId && previous.revision !== payload.revision) fail('CONTEXT_SYNOPSIS_STALE', 'Managed turn authorization changed.');
    }
    const row = { schemaVersion: 1, binding: payload.binding, revision: payload.revision, turnId: payload.turnId,
      runId: payload.runId ?? null, phase: payload.phase, messages: payload.messages,
      sourceFingerprint: fingerprintHistorySource({ messages: payload.messages, sourceBinding: payload.binding }),
      synopsis: payload.synopsis ?? (previous?.turnId === payload.turnId
        && same(splitManagedHistoryMessages(previous.messages).headers, splitManagedHistoryMessages(payload.messages).headers) ? previous.synopsis : null), pendingCallIds: payload.pendingCallIds ?? [],
      ...(payload.derivedFrom ? { derivedFrom: payload.derivedFrom } : previous?.derivedFrom ? { derivedFrom: previous.derivedFrom } : {}) };
    if (payload.historyGap ?? previous?.historyGap) row.historyGap = payload.historyGap ?? previous.historyGap;
    row.integrity = hash(row);
    if (Buffer.byteLength(JSON.stringify(row)) + 1 > MANAGED_HISTORY_MAX_BYTES) fail('CONTEXT_HISTORY_LIMIT', 'Managed history storage limit reached; preserve the source and continue through verified Continuity.');
    try { writeJsonAtomic(fileFor(payload.binding.sessionId), row, { indent: 0 }); }
    catch { fail('CONTEXT_HISTORY_CHECKPOINT_PERSIST_FAILED', 'Managed checkpoint storage failed; original sources and execution receipts are retained.'); }
    return row;
  }
  return { read, write };
}
