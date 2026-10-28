import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveTaskArtifactOpen } from './artifact-open.js';

const review = (kind, reason) => ({ status: 'NEEDS_REVIEW', kind, evidenceEventIds: [], reasons: [reason] });
const verified = (kind, rows) => ({ status: 'VERIFIED', kind,
  evidenceEventIds: rows.map(row => row.eventId), reasons: [] });

/** Read-only check of observed Task evidence. It never changes Task status or grants. */
export function verifyTaskOutcome(task, { kind, expectedFile, expectedSha256, expectedCapability } = {},
  { workspaceRoot = null, verifiedImportEventIds = null } = {}) {
  if (!task || !['running', 'waiting', 'completed'].includes(task.status)) return review(kind, 'TASK_NOT_ACTIVE');
  if (!Array.isArray(task.acceptance) || !task.acceptance.length || task.acceptance.some(item => item.met !== true)) {
    return review(kind, 'ACCEPTANCE_UNVERIFIED');
  }
  const evidence = Array.isArray(task.executionEvidence) ? task.executionEvidence : [];
  if (evidence.some(item => ['outcome-unknown', 'unknown', 'cancel-unconfirmed'].includes(item.status))) {
    return review(kind, 'OUTCOME_UNKNOWN');
  }
  if (kind === 'code') {
    const diffIndex = evidence.findLastIndex(item => item.capability === 'git.diff');
    const currentImports=Array.isArray(verifiedImportEventIds)?evidence.filter(row=>verifiedImportEventIds.includes(row.eventId)&&row.source==='core-import'&&row.status==='completed'):[];
    const changeProof=diffIndex>=0&&evidence[diffIndex].status==='completed'&&evidence[diffIndex].hasChanges===true?[evidence[diffIndex]]:currentImports;
    if(!changeProof.length)return review(kind,'DIFF_NOT_VERIFIED');
    const proofIndex=Math.max(...changeProof.map(row=>evidence.indexOf(row)));
    const mutations = new Set(['filesystem.write', 'git.commit', 'workspace.apply', 'git.apply', 'git.stage']);
    if (evidence.slice(proofIndex + 1).some(item => item.status === 'completed' && mutations.has(item.capability))) {
      return review(kind, 'CODE_CHANGED_AFTER_DIFF');
    }
    const testIndex=evidence.findLastIndex(item=>item.capability==='test.run');
    const test=evidence[testIndex];
    if(test?.status!=='completed'||test.exitCode!==0)return review(kind,'TEST_NOT_VERIFIED');
    if(evidence.slice(testIndex+1).some(item=>item.status==='completed'&&mutations.has(item.capability)))return review(kind,'CODE_CHANGED_AFTER_TEST');
    return verified(kind,[...changeProof,test]);
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
