// A one-shot continuation of the retained Main acceptance budget, never a reset.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acceptanceHash } from './autonomous-handoff-acceptance.mjs';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
function document(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('RECOVERY_PARENT_INVALID', 'Bounded regular evidence files are required');
  const bytes = fs.readFileSync(file); return { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: acceptanceHash(bytes) };
}
export function readRecoveryParent(evidenceFile) {
  const file = fs.realpathSync(path.resolve(evidenceFile)), root = path.dirname(file);
  assert.equal(path.basename(file), 'acceptance-evidence.json');
  const evidence = document(file), journalFile = path.join(root, 'dispatch-budget.jsonl');
  const journalStat = fs.lstatSync(journalFile);
  assert.ok(journalStat.isFile() && !journalStat.isSymbolicLink() && journalStat.size < 1024 * 1024);
  const journalBytes = fs.readFileSync(journalFile);
  const rows = journalBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(rows.every((row, index) => row.sequence === index + 1), 'Parent journal sequence is complete');
  const sends = rows.filter(row => row.kind === 'dispatch-reserved'), turns = rows.filter(row => row.kind === 'user-turn-reserved');
  assert.equal(evidence.value.verified, true); assert.equal(evidence.value.taskStatus, 'completed');
  assert.equal(evidence.value.verifiersRetained, true); assert.deepEqual(evidence.value.changedSourceFilesDuringRun, []);
  assert.deepEqual(evidence.value.limits, { dispatches: 5, userTurns: 1, maxDispatches: 6, maxUserTurns: 3 });
  assert.equal(rows[0].kind, 'limits'); assert.equal(rows[0].maxDispatches, 6); assert.equal(rows[0].maxUserTurns, 3);
  assert.deepEqual(sends.map(row => [row.dispatch, row.provider, row.phase]), [
    [1, 'cetamesh', 'user'], [2, 'codex', 'bootstrap'], [3, 'codex', 'user'], [4, 'cetamesh', 'bootstrap'], [5, 'cetamesh', 'user'] ]);
  assert.deepEqual(turns.map(row => row.userTurn), [1]);
  for (const send of sends) assert.equal(rows.filter(row => row.kind === 'dispatch-reply' && row.dispatch === send.dispatch && row.accepted === true).length, 1);
  assert.equal(rows.filter(row => ['dispatch-failed', 'dispatch-refused'].includes(row.kind)).length, 0);
  assert.match(evidence.value.subscriptionFingerprint, /^[a-f0-9]{64}$/);
  return { root, evidenceFile: file, journalFile, evidence: evidence.value, evidenceSha256: evidence.sha256,
    journalSha256: acceptanceHash(journalBytes), baseDispatches: sends.length, baseUserTurns: turns.length };
}

export function requireRecoveryExtensionApproval(file, parent) {
  const approval = document(path.resolve(file)); const a = approval.value;
  if (a.approved !== true || a.kind !== 'codex-subscription-pause-resume-budget-v1'
    || a.maxDispatches !== 8 || a.maxUserTurns !== 3 || a.previousMaxDispatches !== 6
    || a.parentEvidenceSha256 !== parent.evidenceSha256 || a.parentJournalSha256 !== parent.journalSha256
    || path.resolve(a.project || '') !== path.resolve(parent.evidence.project)
    || typeof a.ownerApprovalReference !== 'string' || !a.ownerApprovalReference.trim()
    || a.ownerApprovalReference.length > 1000 || a.allowPaidApi !== false
    || a.scope !== 'same-project-read-sum-pause-resume-no-writes')
    fail('RECOVERY_BUDGET_APPROVAL_REQUIRED', 'The additional two-dispatch ceiling needs separate exact Owner authorization');
  return { ...a, file: path.resolve(file), sha256: approval.sha256 };
}

function requireLinkedRoot(root, parent) {
  const expected = path.join(path.dirname(parent.root), path.basename(parent.root) + '-pause-resume');
  assert.equal(path.resolve(root), path.resolve(expected));
}

function linkedWriter(root, { parent, dispatches, userTurns, sequence, prior = Buffer.alloc(0), retainedPrefix = null }) {
  const file = path.join(root, 'linked-dispatch-budget.jsonl'), lockFile = path.join(root, 'linked-dispatch-writer.lock');
  const writerId = crypto.randomUUID(), lockBytes = Buffer.from(JSON.stringify({ writerId, pid: process.pid }) + '\n');
  const lock = fs.openSync(lockFile, 'wx');
  fs.writeFileSync(lock, lockBytes); fs.fsyncSync(lock); fs.closeSync(lock);
  let fd;
  try {
    fd = fs.openSync(file, prior.length ? 'a' : 'wx');
    if (prior.length) assert.equal(fs.readFileSync(file).equals(prior), true, 'The reviewed old journal prefix must still be exact');
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); fs.unlinkSync(lockFile); throw error; }
  let closed = false, written = prior;
  function append(value) {
    assert.equal(closed, false);
    assert.equal(fs.readFileSync(file).equals(written), true, 'The unique writer must own the complete unchanged journal prefix');
    const bytes = Buffer.from(JSON.stringify({ ...value, sequence: sequence + 1, at: Date.now(), writerId }) + '\n');
    let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); fs.fsyncSync(fd);
    written = Buffer.concat([written, bytes]); sequence++;
  }
  return { file, append, retainedPrefix, writerId,
    reserveDispatch({ provider, sessionId, phase = 'user', runId = null }) {
      if (provider !== 'codex') fail('RECOVERY_PROVIDER_FORBIDDEN', 'Only the real Codex subscription adapter is authorized');
      if (dispatches >= 8) { append({ kind: 'dispatch-refused', dispatches, provider, phase }); fail('ACCEPTANCE_DISPATCH_LIMIT', 'Eight total sends are exhausted; no retry is authorized'); }
      const next = dispatches + 1; append({ kind: 'dispatch-reserved', dispatch: next, provider, sessionId, phase, runId });
      dispatches = next; return next;
    },
    reserveUserTurn() { if (userTurns >= 3) fail('ACCEPTANCE_USER_TURN_LIMIT', 'Three total Owner turns are exhausted');
      const next = userTurns + 1; append({ kind: 'user-turn-reserved', userTurn: next }); userTurns = next; return next; },
    snapshot: () => ({ dispatches, userTurns, maxDispatches: 8, maxUserTurns: 3, baseDispatches: parent.baseDispatches, baseUserTurns: parent.baseUserTurns }),
    assertParentUnchanged() { assert.equal(acceptanceHash(fs.readFileSync(parent.evidenceFile)), parent.evidenceSha256);
      assert.equal(acceptanceHash(fs.readFileSync(parent.journalFile)), parent.journalSha256); },
    close() { if (!closed) { fs.fsyncSync(fd); fs.closeSync(fd); closed = true;
      assert.equal(fs.readFileSync(lockFile).equals(lockBytes), true, 'Only this writer may release its lock'); fs.unlinkSync(lockFile); } }
  };
}

export function createLinkedRecoveryJournal(root, { parent, approval }) {
  // Existing directories are never overwritten by the normal one-shot mode.
  requireLinkedRoot(root, parent); fs.mkdirSync(root);
  const journal = linkedWriter(root, { parent, dispatches: parent.baseDispatches, userTurns: parent.baseUserTurns, sequence: 0 });
  journal.append({ kind: 'linked-extension', parentEvidenceFile: parent.evidenceFile, parentEvidenceSha256: parent.evidenceSha256,
    parentJournalFile: parent.journalFile, parentJournalSha256: parent.journalSha256, authorizationSha256: approval.sha256,
    ownerApprovalReference: approval.ownerApprovalReference, baseDispatches: parent.baseDispatches, baseUserTurns: parent.baseUserTurns,
    previousMaxDispatches: 6, maxDispatches: 8, maxUserTurns: 3 });
  return journal;
}

export function continueLinkedRecoveryJournal(root, { parent, approval, expectedPrefixSha256, failedEvidenceSha256, expectedPreviousSessionId,
  attempt = 2, originalFailedEvidenceSha256 = failedEvidenceSha256 }) {
  requireLinkedRoot(root, parent);
  assert.ok(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink());
  assert.ok(attempt === 2 || attempt === 3);assert.match(originalFailedEvidenceSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(expectedPrefixSha256 ?? '', /^[a-f0-9]{64}$/); assert.match(failedEvidenceSha256 ?? '', /^[a-f0-9]{64}$/);
  const file = path.join(root, 'linked-dispatch-budget.jsonl'), stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
  const prior = fs.readFileSync(file); assert.equal(acceptanceHash(prior), expectedPrefixSha256, 'Only the explicitly reviewed journal may be appended');
  assert.equal(prior.at(-1), 10, 'A partial journal line must never be repaired or replayed');
  const lines = prior.toString('utf8').split('\n').slice(0, -1), rows = lines.map(line => JSON.parse(line));
  assert.equal(rows.length, attempt === 3 ? 5 : 4, 'Only the explicitly reviewed pre-dispatch failure prefix may be continued');
  assert.ok(rows.every((row, index) => row.sequence === index + 1));
  const header = rows[0];
  for (const [key, value] of Object.entries({ kind: 'linked-extension', parentEvidenceFile: parent.evidenceFile,
    parentEvidenceSha256: parent.evidenceSha256, parentJournalFile: parent.journalFile, parentJournalSha256: parent.journalSha256,
    authorizationSha256: approval.sha256, ownerApprovalReference: approval.ownerApprovalReference,
    baseDispatches: 5, baseUserTurns: 1, previousMaxDispatches: 6, maxDispatches: 8, maxUserTurns: 3 })) assert.equal(header[key], value);
  assert.equal(rows[1].kind, 'user-turn-reserved'); assert.equal(rows[1].userTurn, 2);
  assert.equal(rows[2].kind, 'dispatch-reserved'); assert.equal(rows[2].dispatch, 6);
  assert.equal(rows[2].provider, 'codex'); assert.equal(rows[2].phase, 'user'); assert.ok(expectedPreviousSessionId);
  assert.equal(rows[2].sessionId, expectedPreviousSessionId, 'Dispatch six must bind the exact original Task Session');
  assert.equal(rows[3].kind, 'dispatch-reply'); assert.equal(rows[3].dispatch, 6); assert.equal(rows[3].accepted, true);
  if (attempt === 3) {
    const claim = rows[4], oldPrefix = Buffer.from(lines.slice(0, 4).join('\n') + '\n');
    assert.equal(claim.kind, 'continue-existing-claim'); assert.equal(claim.attempt, 2); assert.equal(claim.continuedUserTurn, 2);
    assert.equal(claim.failedEvidenceSha256, originalFailedEvidenceSha256); assert.equal(claim.authorizationSha256, approval.sha256);
    assert.deepEqual(claim.retainedPrefix, { sha256: acceptanceHash(oldPrefix), bytes: oldPrefix.length,
      lines: lines.slice(0, 4).map((line, index) => ({ sequence: index + 1, sha256: acceptanceHash(Buffer.from(line + '\n')) })) });
    assert.match(claim.writerId, /^[a-f0-9-]{36}$/);
  }
  const retainedPrefix = { sha256: expectedPrefixSha256, bytes: prior.length,
    lines: lines.map((line, index) => ({ sequence: index + 1, sha256: acceptanceHash(Buffer.from(line + '\n')) })) };
  const journal = linkedWriter(root, { parent, dispatches: 6, userTurns: 2, sequence: rows.length, prior, retainedPrefix });
  journal.append({ kind: 'continue-existing-claim', attempt, retainedPrefix, failedEvidenceSha256, originalFailedEvidenceSha256,
    authorizationSha256: approval.sha256, continuedUserTurn: 2 });
  return journal;
}
