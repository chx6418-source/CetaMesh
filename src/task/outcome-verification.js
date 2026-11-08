import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskArtifactOpen } from './artifact-open.js';

const review = (kind, reason) => ({ status: 'NEEDS_REVIEW', kind, evidenceEventIds: [], reasons: [reason] });
const verified = (kind, rows) => ({ status: 'VERIFIED', kind,
  evidenceEventIds: rows.map(row => row.eventId), reasons: [] });

/** Task-owned bounded proof shape. Provenance still comes from Core receipts. */
export function normalizePostWriteVerificationBinding(value) {
  const digest = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text);
  const identifier = text => typeof text === 'string' && text.length > 0 && text.length <= 240 && !/[\x00-\x1f\x7f]/.test(text);
  if (!value || typeof value !== 'object' || !digest(value.configDigest) || !digest(value.sourceDigest)
    || Object.keys(value).some(key => !['configDigest', 'sourceDigest', 'sourceWriteIds', 'writes'].includes(key))
    || !Array.isArray(value.sourceWriteIds) || value.sourceWriteIds.length < 1 || value.sourceWriteIds.length > 24
    || value.sourceWriteIds.some(id => !identifier(id)) || new Set(value.sourceWriteIds).size !== value.sourceWriteIds.length
    || !Array.isArray(value.writes) || value.writes.length < 1 || value.writes.length > 24
    || value.sourceWriteIds.some(id => !value.writes.some(row => row?.eventId === id))
    || value.writes.some(row => !row || !identifier(row.eventId) || !identifier(row.requestId) || !value.sourceWriteIds.includes(row.eventId)
      || (row.capability === 'workspace.apply' ? !identifier(row.operationId) || !['write','delete'].includes(row.action)
        || (row.action === 'delete' ? row.sha256 !== null : !digest(row.sha256)) : row.capability !== undefined || !digest(row.sha256))
      || typeof row.path !== 'string' || row.path.length > 1024
      || row.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || /^[\\/]|:/.test(row.path)
      || Object.keys(row).some(key => !['eventId', 'requestId', 'path', 'sha256', 'capability', 'operationId', 'action'].includes(key)))
    || new Set(value.writes.map(row => process.platform === 'win32' ? row.path.toLowerCase().replaceAll('\\','/') : row.path.replaceAll('\\','/'))).size !== value.writes.length) {
    throw Object.assign(new Error('A bounded current Core write receipt is required'), { code: 'POST_WRITE_BINDING_INVALID' });
  }
  return { configDigest: value.configDigest, sourceDigest: value.sourceDigest, sourceWriteIds: [...value.sourceWriteIds],
    writes: value.writes.map(row => ({ eventId: row.eventId, requestId: row.requestId, path: row.path, sha256: row.sha256,
      ...(row.capability === 'workspace.apply' ? {capability:row.capability,operationId:row.operationId,action:row.action} : {}) })) };
}

/** Import rows are derived from the Task's actual Core receipt, never model input. */
export function postWriteSourceRows(row) {
  if (row?.status !== 'completed') return [];
  if (row.capability === 'filesystem.write' && typeof row.filePath === 'string') return [{eventId:row.eventId,path:row.filePath}];
  if (row.capability !== 'workspace.apply' || row.source !== 'core-import' || typeof row.operationId !== 'string'
    || !row.eventId?.startsWith('core-import:') || !Array.isArray(row.changes)
    || crypto.createHash('sha256').update(JSON.stringify(row.changes)).digest('hex') !== row.resultSha256) return [];
  return row.changes.map(change => ({eventId:row.eventId,requestId:row.eventId.slice(12),path:change.path,sha256:change.sha256,
    capability:'workspace.apply',operationId:row.operationId,action:change.action}));
}

/** Interpret retained old per-check and new cumulative Core receipts together. */
export function currentPostWriteVerificationImages(task, { throughIndex = task.executionEvidence?.length - 1, requireLatestWrite = true, includeExtensions = [] } = {}) {
  const evidence = task.executionEvidence ?? [], observed = task.executionObservation;
  const current = row => row.provider === observed?.provider && row.sessionId === observed?.sessionId
    && row.runId === observed?.runId && row.phase === 'user';
  const pathKey = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replaceAll('\\', '/');
  const images = new Map();
  const invalid = () => { throw Object.assign(new Error('Current Core write provenance is unavailable'), { code: 'POST_WRITE_RECEIPT_UNVERIFIED' }); };
  for (let index = 0; index <= throughIndex; index++) {
    const row = evidence[index];
    if (row?.source !== 'core-test' || row.capability !== 'test.run' || row.status !== 'completed' || !current(row) || !row.postWriteVerification) continue;
    if (!/^[a-f0-9]{64}$/.test(row.resultSha256 ?? '')) invalid();
    const binding = normalizePostWriteVerificationBinding(row.postWriteVerification);
    for (const write of binding.writes) {
      const key = pathKey(write.path);
      const sourceIndex = evidence.findIndex(source => current(source) && postWriteSourceRows(source).some(candidate =>
        candidate.eventId === write.eventId && pathKey(candidate.path) === key && (write.capability === 'workspace.apply'
          ? candidate.capability === write.capability && candidate.operationId === write.operationId && candidate.requestId === write.requestId
            && candidate.action === write.action && candidate.sha256 === write.sha256 : candidate.capability === undefined)));
      if (sourceIndex < 0 || sourceIndex >= index) invalid();
      const previous = images.get(key);
      if (!previous || sourceIndex > previous.sourceIndex) images.set(key, { write, sourceIndex });
      else if (sourceIndex === previous.sourceIndex && (previous.write.requestId !== write.requestId || previous.write.sha256 !== write.sha256)) invalid();
    }
  }
  if (images.size > 24) invalid();
  if (requireLatestWrite) {
    const required = new Map();
    for (let index = 0; index <= throughIndex; index++) {
      const row = evidence[index];
      if (!current(row)) continue;
      for (const source of postWriteSourceRows(row)) {
        const key = pathKey(source.path);
        if (images.has(key) || includeExtensions.some(ext => source.path.toLowerCase().endsWith(ext))) required.set(key, index);
      }
    }
    if (required.size > 24 || [...required].some(([key, index]) => images.get(key)?.sourceIndex !== index)) invalid();
  }
  return [...images.values()].map(row => row.write);
}

export function currentPostWriteImage(write, workspaceRoot) {
  let handle;
  try {
    if (write.capability === 'workspace.apply' && write.action === 'delete') {
      // Resolve parent containment even for missing leaves; dangling links are not absence.
      const root = fs.realpathSync.native(workspaceRoot);
      if (fs.lstatSync(workspaceRoot).isSymbolicLink()) return false;
      let cursor = root;
      for (const part of write.path.replaceAll('\\','/').split('/')) {
        if (!part || part === '.' || part === '..' || part.includes(':')) return false;
        cursor = path.join(cursor,part);
        try { const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink() || !stat.isDirectory() && cursor !== path.resolve(root,write.path)) return false; }
        catch (error) { return error.code === 'ENOENT'; }
      }
      return false;
    }
    const resolve = () => resolveTaskArtifactOpen({ artifact: { ref: write.path }, workspaceRoot, forPreview: true }).canonicalPath;
    const file = resolve();
    if (path.relative(path.resolve(workspaceRoot, write.path), file)) return false;
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024) return false;
    const same = stat => ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => stat[key] === before[key]);
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!same(fs.fstatSync(handle))) return false;
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, Math.min(buffer.length, before.size - bytes + 1), null);
      if (!count) break;
      bytes += count;
      if (bytes > before.size) return false;
      hash.update(buffer.subarray(0, count));
    }
    return bytes === before.size && hash.digest('hex') === write.sha256
      && same(fs.fstatSync(handle)) && same(fs.lstatSync(file)) && resolve() === file;
  } catch { return false; }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

/** Machine source proof only; a verified source may belong to a failed test.
 * Callers retain acceptance, lifecycle eligibility and later-effect checks. */
export function verifyPostWriteCurrentSource(task, test, { workspaceRoot = null, postWriteVerification = null } = {}) {
  const kind = 'post-write-source', evidence = task?.executionEvidence ?? [], observed = task?.executionObservation;
  const current = row => row.provider === observed?.provider && row.sessionId === observed?.sessionId
    && row.runId === observed?.runId && row.phase === 'user';
  const index = evidence.findIndex(row => row.eventId === test?.eventId && row.provider === test?.provider
    && row.sessionId === test?.sessionId && row.runId === test?.runId);
  const receipt = evidence[index];
  if (!observed?.runId || observed.provider !== task.currentAgent?.provider || observed.sessionId !== task.currentAgent?.sessionId
    || receipt?.source !== 'core-test' || receipt.capability !== 'test.run' || receipt.status !== 'completed'
    || !current(receipt) || !Number.isSafeInteger(receipt.exitCode) || !/^[a-f0-9]{64}$/.test(receipt.resultSha256 ?? '')) {
    return review(kind, 'CURRENT_CORE_TEST_NOT_VERIFIED');
  }
  if (evidence.some(row => ['outcome-unknown', 'unknown', 'cancel-unconfirmed'].includes(row.status))) return review(kind, 'OUTCOME_UNKNOWN');
  const boundTests = evidence.slice(0, index + 1).filter(row => row.source === 'core-test' && row.capability === 'test.run'
    && row.status === 'completed' && current(row) && row.postWriteVerification);
  let binding, writes;
  try {
    binding = normalizePostWriteVerificationBinding(boundTests.at(-1)?.postWriteVerification);
    if (postWriteVerification?.enabled !== true || postWriteVerification.configDigest !== binding.configDigest) return review(kind, 'POST_WRITE_CONFIG_CHANGED');
    if (postWriteVerification.sourceDigest !== binding.sourceDigest) return review(kind, 'POST_WRITE_SOURCE_CHANGED');
    if (!Array.isArray(postWriteVerification.includeExtensions)) return review(kind, 'POST_WRITE_SOURCE_UNAVAILABLE');
    writes = currentPostWriteVerificationImages(task, { throughIndex: index, includeExtensions: postWriteVerification.includeExtensions });
  } catch { return review(kind, 'POST_WRITE_RECEIPT_UNVERIFIED'); }
  if (writes.some(write => !currentPostWriteImage(write, workspaceRoot))) return review(kind, 'POST_WRITE_POSTIMAGE_CHANGED');
  const references = writes.map(write => boundTests.findLast(row => row.postWriteVerification.writes.some(source => source.eventId === write.eventId
    && source.requestId === write.requestId && source.sha256 === write.sha256))?.eventId).filter(Boolean);
  return { status: 'VERIFIED', kind, evidenceEventIds: [...new Set([...references, receipt.eventId])], reasons: [] };
}

/** Read-only evidence check; current-code callers must additionally verify their file/test contract.
 * The opt-in current execution boundary does not change historical/Owner review semantics. */
export function verifyTaskOutcome(task, { kind, expectedFile, expectedSha256, expectedCapability, requireCurrentCodeEvidence = false } = {},
  { workspaceRoot = null, verifiedImportEventIds = null, postWriteVerification = null } = {}) {
  if (!task || !['running', 'waiting', 'completed'].includes(task.status)) return review(kind, 'TASK_NOT_ACTIVE');
  if (!Array.isArray(task.acceptance) || !task.acceptance.length || task.acceptance.some(item => item.met !== true)) {
    return review(kind, 'ACCEPTANCE_UNVERIFIED');
  }
  const evidence = Array.isArray(task.executionEvidence) ? task.executionEvidence : [];
  if (evidence.some(item => ['outcome-unknown', 'unknown', 'cancel-unconfirmed'].includes(item.status))) {
    return review(kind, 'OUTCOME_UNKNOWN');
  }
  if (kind === 'code') {
    if (typeof requireCurrentCodeEvidence !== 'boolean') return review(kind, 'CURRENT_EVIDENCE_REQUIREMENT_INVALID');
    const observed = task.executionObservation;
    const current = row => row?.provider === observed?.provider && row?.sessionId === observed?.sessionId
      && row?.runId === observed?.runId && row?.phase === 'user';
    if (requireCurrentCodeEvidence === true && (!observed?.runId || !observed.provider || !observed.sessionId
      || observed.state !== 'awaiting-review' || observed.provider !== task.currentAgent?.provider
      || observed.sessionId !== task.currentAgent?.sessionId)) return review(kind, 'CURRENT_EXECUTION_NOT_SETTLED');
    const diffIndex = evidence.findLastIndex(item => item.capability === 'git.diff');
    const currentImports=Array.isArray(verifiedImportEventIds)?evidence.filter(row=>verifiedImportEventIds.includes(row.eventId)&&row.source==='core-import'&&row.status==='completed'):[];
    const changeProof=diffIndex>=0&&evidence[diffIndex].status==='completed'&&evidence[diffIndex].hasChanges===true?[evidence[diffIndex]]:currentImports;
    if(!changeProof.length)return review(kind,'DIFF_NOT_VERIFIED');
    if(requireCurrentCodeEvidence===true&&changeProof.some(row=>!current(row)))return review(kind,'CURRENT_CHANGE_NOT_VERIFIED');
    const proofIndex=Math.max(...changeProof.map(row=>evidence.indexOf(row)));
    const mutations = new Set(['filesystem.write', 'git.commit', 'workspace.apply', 'git.apply', 'git.stage']);
    if (evidence.slice(proofIndex + 1).some(item => item.status === 'completed' && mutations.has(item.capability))) {
      return review(kind, 'CODE_CHANGED_AFTER_DIFF');
    }
    // Core records the actual runner result before Managed emits its display
    // receipt. The display receipt can agree with, but cannot replace, proof.
    const testIndex=evidence.findLastIndex(item=>item.capability==='test.run'
      &&(!requireCurrentCodeEvidence||item.source==='core-test'));
    const test=evidence[testIndex];
    if(test?.status!=='completed'||test.exitCode!==0)return review(kind,'TEST_NOT_VERIFIED');
    if(requireCurrentCodeEvidence===true&&(!current(test)||test.source!=='core-test'
      ||!/^[a-f0-9]{64}$/.test(test.resultSha256??'')))return review(kind,'CURRENT_CORE_TEST_NOT_VERIFIED');
    const boundTest = requireCurrentCodeEvidence === true ? evidence.slice(0, testIndex + 1).findLast(row => row.source === 'core-test'
      && row.capability === 'test.run' && row.status === 'completed' && current(row) && row.postWriteVerification) : null;
    let postWriteProof = null;
    if (boundTest) {
      postWriteProof = verifyPostWriteCurrentSource(task, test, { workspaceRoot, postWriteVerification });
      if (postWriteProof.status !== 'VERIFIED') return review(kind, postWriteProof.reasons[0]);
    }
    if(requireCurrentCodeEvidence===true&&evidence.slice(testIndex+1).some(row=>row.capability==='test.run'
      &&(!current(row)||row.status!=='completed'||row.exitCode!==0)))return review(kind,'LATER_TEST_NOT_VERIFIED');
    if(evidence.slice(testIndex+1).some(item=>item.status==='completed'&&mutations.has(item.capability)))return review(kind,'CODE_CHANGED_AFTER_TEST');
    const result = verified(kind,[...changeProof,test]);
    return postWriteProof ? { ...result, evidenceEventIds: [...new Set([...result.evidenceEventIds, ...postWriteProof.evidenceEventIds])] } : result;
  }
  if (kind === 'file') {
    if (typeof expectedFile !== 'string' || !expectedFile || !/^[a-f0-9]{64}$/i.test(expectedSha256 ?? '')) {
      return review(kind, 'FILE_TARGET_OR_HASH_MISSING');
    }
    const written = evidence.findLast(item => item.capability === 'filesystem.write'
      && item.status === 'completed' && item.filePath === expectedFile);
    const artifact = task.artifacts?.find(item => item.ref === expectedFile);
    if (!written || !artifact) return review(kind, 'FILE_WRITE_NOT_VERIFIED');
    try {
      const { canonicalPath } = resolveTaskArtifactOpen({ artifact, workspaceRoot, forPreview: true });
      if (fs.statSync(canonicalPath).size > 16 * 1024 * 1024) return review(kind, 'FILE_REVIEW_SIZE_LIMIT');
      const hash = crypto.createHash('sha256').update(fs.readFileSync(canonicalPath)).digest('hex');
      return hash === expectedSha256.toLowerCase() ? verified(kind, [written]) : review(kind, 'FILE_CONTENT_MISMATCH');
    } catch {
      return review(kind, 'FILE_UNAVAILABLE_OR_OUT_OF_SCOPE');
    }
  }
  if (kind === 'tool') {
    if (typeof expectedCapability !== 'string' || !expectedCapability) return review(kind, 'TOOL_TARGET_MISSING');
    const result = evidence.findLast(item => item.capability === expectedCapability);
    return result?.status === 'completed' && (result.capability !== 'test.run' || result.exitCode === 0)
      ? verified(kind, [result]) : review(kind, 'TOOL_RESULT_NOT_VERIFIED');
  }
  // Analysis quality and cited evidence require semantic review by the Owner.
  return review(kind, kind === 'analysis' ? 'ANALYSIS_EVIDENCE_REVIEW_REQUIRED' : 'TASK_KIND_UNKNOWN');
}
