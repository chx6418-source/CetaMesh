import crypto from 'node:crypto';
import { redactText } from '../logging/redact.js';
import { normalizeStringList, normalizeWorkspaceId, TASK_LIMITS } from './types.js';

const READS = new Set(['filesystem.read', 'filesystem.search']);
const UNKNOWN = new Set(['unknown', 'outcome-unknown', 'cancel-unconfirmed']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 240
  && !/[\x00-\x20\x7f]/.test(value) && clean(value, 240) === value ? value : null;
function clean(value, maximum = 600) {
  if (typeof value !== 'string') return null;
  const safe = redactText(value).replace(/(?:[A-Za-z]:\\|\\\\[^\s"']+|\/(?:Users|home|root|mnt|tmp)\/)[^\s"'<>]*/g, '[LOCAL_PATH]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  let text = safe.slice(0, maximum);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text || null;
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /^[\\/]|:/.test(value)
    || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || clean(value, 1000) !== value) return null;
  return value.replaceAll('\\', '/');
}
function parentFingerprint(parent) {
  try { return hash(JSON.stringify({ goal: String(parent.goal ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase(),
    requirements: normalizeStringList(parent.requirements, 'requirements', TASK_LIMITS.requirements),
    workspaceId: normalizeWorkspaceId(parent.workspaceId), requestedAgentProvider: null })); }
  catch { return null; }
}

/** Read-only derived facts. This never verifies, completes or starts a Task. */
export function projectChildResultFacts(child, { parent, limit = 20, maxChars = 12000 } = {}) {
  if (!child || !parent || !identifier(child.id) || !identifier(parent.id) || child.parentTaskId !== parent.id
    || !parent.workspaceId || child.workspaceId !== parent.workspaceId || parent.parentTaskId) return null;
  const cap = Number.isSafeInteger(limit) ? Math.max(1, Math.min(20, limit)) : 20;
  const budget = Number.isSafeInteger(maxChars) ? Math.max(2400, Math.min(12000, maxChars)) : 12000;
  const omitted = {}, note = (key, count = 1) => { if (count > 0) omitted[key] = (omitted[key] ?? 0) + count; };
  const text = (value, maximum = 600) => { const result = clean(value, maximum); if (typeof value === 'string' && result !== value.trim()) note('text'); return result; };
  const list = (items, key, project) => {
    const source = Array.isArray(items) ? items : [];
    const result = source.slice(0, cap).map(project).filter(Boolean); note(key, source.length - result.length); return result;
  };
  const attempts = Array.isArray(child.attempts) ? child.attempts : [], attempt = attempts.at(-1);
  const observed = child.executionObservation;
  const hasAttempt = identifier(attempt?.requestId) && identifier(attempt?.provider) && identifier(attempt?.sessionId) && Number.isSafeInteger(attempt?.taskRev);
  const observedCurrent = Boolean(hasAttempt && observed?.provider === attempt.provider && observed.sessionId === attempt.sessionId
    && observed.runId === attempt.requestId && (!child.currentAgent || child.currentAgent.provider === attempt.provider && child.currentAgent.sessionId === attempt.sessionId));
  const binding = observedCurrent ? 'current-run' : hasAttempt && !observed ? 'attempt-only' : 'unknown';
  const sameAttempt = row => Boolean(hasAttempt && row?.provider === attempt.provider && row.sessionId === attempt.sessionId
    && row.runId === attempt.requestId && row.phase === 'user' && Number.isSafeInteger(row.taskRev) && row.taskRev >= attempt.taskRev && row.taskRev <= child.rev);
  const rows = Array.isArray(child.executionEvidence) ? child.executionEvidence : [];
  const currentRows = binding !== 'unknown' ? rows.filter(sameAttempt) : [];
  note('earlierOrUnboundEvidence', rows.length - currentRows.length);
  const reportRows = Array.isArray(child.agentReports) ? child.agentReports : [];
  const final = child.status === 'completed' && attempt?.state === 'completed';
  const rawReport = final && binding !== 'unknown' ? reportRows.filter(sameAttempt).at(-1) : null;
  note('earlierOrUnsettledReports', reportRows.length - (rawReport ? 1 : 0));
  let structured = null;
  const reportIntact = !rawReport?.sha256 || typeof rawReport.text === 'string' && rawReport.sha256 === hash(rawReport.text);
  if (reportIntact && rawReport?.text?.length <= 8192) {
    try { const value = JSON.parse(rawReport.text); if (value && typeof value === 'object' && !Array.isArray(value)) structured = value; }
    catch { /* Malformed JSON remains attributed plain report text. */ }
  }
  const reportId = identifier(rawReport?.eventId);
  if (rawReport && !reportIntact) note('changedReport');
  const report = rawReport && reportId && reportIntact ? { source: 'agent-report', eventId: reportId,
    sha256: /^[a-f0-9]{64}$/.test(rawReport.sha256 ?? '') ? rawReport.sha256 : null,
    verified: false, final: true, text: text(rawReport.text, 1200) ?? '', summary: text(structured?.summary, 500),
    claimedFilesChanged: list(structured?.filesChanged, 'claimedFilesChanged', value => text(value, 200)),
    claimedCommands: list(structured?.commands, 'claimedCommands', value => text(value, 240)),
    claimedRemaining: list(structured?.remaining, 'claimedRemaining', value => text(value, 240)),
    truncated: typeof rawReport.text === 'string' && rawReport.text.length > 1200 } : null;
  const coreRead = row => READS.has(row.capability) && row.provider === 'cetamesh' && row.source !== 'native-result';
  const completeIds = new Set(currentRows.filter(row => row.status === 'completed' && coreRead(row)).map(row => row.eventId));
  const findings = list(report ? structured?.findings : [], 'findings', value => {
    const body = text(typeof value === 'string' ? value : value?.text, 500);
    if (!body) return null;
    const references = list(value?.evidenceEventIds, 'findingEvidenceIds', identifier);
    return { kind: 'agent-claim', text: body, evidenceEventIds: references.filter(id => completeIds.has(id)),
      missingEvidenceIds: references.filter(id => !completeIds.has(id)) };
  });
  const readOnly = child.childContract?.mode === 'read-only';
  const reads = list(currentRows.filter(row => READS.has(row.capability)), 'reads', row => {
    const eventId = identifier(row.eventId); if (!eventId) return null;
    // Existing Task read receipts usually omit filePath. Neither readScope nor
    // report prose can fill that evidence gap.
    const file = relative(row.filePath);
    return { eventId, capability: row.capability, status: text(row.status, 40) ?? 'unknown', path: file,
      pathCoverage: file ? 'retained' : 'not-retained', provenance: coreRead(row) ? 'core-observation' : 'native-observation',
      verified: false };
  });
  const observations = list(currentRows.filter(row => !READS.has(row.capability)), 'otherObservations', row => {
    const eventId = identifier(row.eventId); if (!eventId) return null;
    return { eventId, capability: text(row.capability, 100) ?? 'unknown', status: text(row.status, 40) ?? 'unknown',
      provenance: row.source === 'native-result' ? 'native-observation' : 'execution-observation', verified: false };
  });
  const currentIds = new Set(currentRows.map(row => row.eventId));
  const artifacts = list(child.artifacts, 'artifacts', artifact => {
    const id = identifier(artifact?.id); if (!id) return null;
    const sourceEventId = identifier(artifact.sourceEventId);
    return { id, label: text(artifact.label, 180), ref: relative(artifact.ref),
      sourceEventId: sourceEventId && currentIds.has(sourceEventId) ? sourceEventId : null,
      provenance: 'task-artifact-record', current: Boolean(sourceEventId && currentIds.has(sourceEventId)), verified: false };
  });
  const blockers = [], add = code => { if (!blockers.includes(code)) blockers.push(code); };
  const fingerprintCurrent = child.parentFingerprint === parentFingerprint(parent);
  const supersededBy = (Array.isArray(parent.children) ? parent.children : []).find(row => row.parentTaskId === parent.id
    && row.workspaceId === parent.workspaceId && row.supersedesChildId === child.id)?.id;
  if (!fingerprintCurrent) add('TASK_CHILD_PARENT_CHANGED');
  if (!['queued', 'paused', 'running', 'completed'].includes(parent.status)) add('TASK_PARENT_UNAVAILABLE');
  if (supersededBy) add('CHILD_SUPERSEDED');
  if (!hasAttempt) add('ATTEMPT_NOT_STARTED');
  else if (attempt.state !== 'completed') add(UNKNOWN.has(attempt.state) ? 'ATTEMPT_OUTCOME_UNKNOWN' : 'ATTEMPT_NOT_SETTLED');
  if (attempts.some(row => ['started', 'accepted', 'unknown'].includes(row.state) && !row.review)) add('ATTEMPT_NOT_SETTLED');
  if (binding !== 'current-run') add(observed ? 'CURRENT_RUN_CHANGED' : 'CURRENT_RUN_UNAVAILABLE');
  if (child.status === 'completed' && observed && observed.state !== 'awaiting-review') add('CURRENT_EXECUTION_NOT_SETTLED');
  if (rows.some(row => UNKNOWN.has(row.status))) add('OUTCOME_UNKNOWN');
  if (currentRows.some(row => row.source === 'native-result' || row.provider !== 'cetamesh')) add('NATIVE_OBSERVATION_UNVERIFIED');
  if (readOnly && observations.some(row => ['filesystem.write', 'test.run', 'workspace.apply', 'git.commit', 'git.stage'].includes(row.capability))) add('READ_ONLY_EFFECT_OBSERVATION');
  if (!readOnly) add('CHILD_CONTRACT_UNSUPPORTED');
  if (child.status !== 'completed') add('CHILD_NOT_COMPLETED');
  if (child.childContract?.outputKind === 'analysis' && (!report || report.sha256 !== hash(rawReport?.text ?? ''))) add('CURRENT_REPORT_UNAVAILABLE');
  const recorded = child.result ?? {};
  if (recorded.verification !== 'VERIFIED') add('CHILD_VERIFICATION_REQUIRED');
  if (recorded.verification === 'VERIFIED' && Array.isArray(recorded.verificationReasons) && recorded.verificationReasons.length) add('VERIFICATION_REASONS_PRESENT');
  if (!Number.isSafeInteger(recorded.verificationRev) || recorded.verificationRev !== child.rev) add('VERIFICATION_REV_CHANGED');
  const evidenceIds = Array.isArray(recorded.evidenceEventIds) ? recorded.evidenceEventIds : [];
  if (!evidenceIds.length || evidenceIds.some(id => !identifier(id) || !completeIds.has(id))) add('CURRENT_SOURCE_EVIDENCE_MISSING');
  if (child.childContract?.outputKind === 'tool' && (child.childContract.expectedEvidence ?? []).some(capability => {
    const latest = currentRows.filter(row => row.capability === capability).at(-1);
    return !latest || latest.status !== 'completed' || !coreRead(latest);
  })) add('LATEST_TOOL_RESULT_UNVERIFIED');
  if (child.childContract?.outputKind === 'analysis' && currentRows.filter(row => READS.has(row.capability)).at(-1)?.status !== 'completed') add('LATEST_SOURCE_RESULT_UNVERIFIED');
  const current = blockers.length === 0;
  const reviewed = attempt?.review?.disposition === 'do-not-replay' || attempt?.state === 'reviewed';
  const nextSteps = UNKNOWN.has(attempt?.state) && reviewed ? ['CONTINUE_WITH_FRESH_SESSION']
    : UNKNOWN.has(attempt?.state) || blockers.includes('OUTCOME_UNKNOWN') ? ['REVIEW_ORIGINAL_ATTEMPT_WITHOUT_REPLAY']
    : !fingerprintCurrent ? ['REVIEW_PARENT_OBJECTIVE_AND_CREATE_FRESH_CHILD']
      : supersededBy ? ['OPEN_SUPERSEDING_CHILD']
        : !TERMINAL.has(child.status) ? ['FOLLOW_OR_CANCEL_EXISTING_CHILD']
          : child.status !== 'completed' ? ['CREATE_FRESH_SUPERSEDING_CHILD']
            : !current ? [child.childContract?.outputKind === 'analysis' ? 'OWNER_REVIEW_CURRENT_ANALYSIS_SOURCES' : 'VERIFY_CURRENT_CHILD_EVIDENCE'] : [];
  const result = { schemaVersion: 1, childId: child.id, taskRev: Number.isSafeInteger(child.rev) ? child.rev : null,
    goal: text(child.goal, 500), status: text(child.status, 40) ?? 'unknown', supersedesChildId: identifier(child.supersedesChildId),
    supersededBy: identifier(supersededBy), parentRev: Number.isSafeInteger(parent.rev) ? parent.rev : null,
    attempt: hasAttempt ? { id: identifier(attempt.id), provider: attempt.provider, sessionId: attempt.sessionId, runId: attempt.requestId,
      state: text(attempt.state, 40) ?? 'unknown', reviewed, binding } : null,
    report, findings,
    hostFacts: { readOnly, coverage: currentRows.length === 0 ? 'none' : reads.some(row => !row.path) || observations.length
      || artifacts.some(row => !row.current) || binding !== 'current-run' || currentRows.some(row => !coreRead(row)) ? 'partial' : 'complete',
      reads, commands: [], writes: [], artifacts, observations,
      evidenceEventIds: list(currentRows.map(row => row.eventId), 'hostEvidenceIds', identifier) },
    verification: { status: text(recorded.verification, 40) ?? 'NEEDS_REVIEW',
      verificationRev: Number.isSafeInteger(recorded.verificationRev) ? recorded.verificationRev : null,
      current, scope: current ? 'current-run' : binding === 'unknown' ? 'unknown' : 'stale',
      reasons: [...new Set([...blockers, ...(Array.isArray(recorded.verificationReasons) ? recorded.verificationReasons.map(value => text(value, 100)).filter(Boolean) : [])])].slice(0, 20),
      evidenceEventIds: list(evidenceIds, 'verificationEvidenceIds', identifier) },
    remaining: { blockers, nextSteps }, omitted };
  // Bound presentation bytes without inventing shortened source IDs. Omit whole
  // facts and retain counts; the authoritative Task keeps the complete records.
  const arrays = [[findings, 'findings'], [report?.claimedCommands, 'claimedCommands'], [report?.claimedFilesChanged, 'claimedFilesChanged'],
    [report?.claimedRemaining, 'claimedRemaining'], [observations, 'otherObservations'], [artifacts, 'artifacts'], [reads, 'reads'],
    [result.hostFacts.evidenceEventIds, 'hostEvidenceIds'], [result.verification.evidenceEventIds, 'verificationEvidenceIds'],
    [result.verification.reasons, 'verificationReasons'], [result.remaining.blockers, 'blockers'], [result.remaining.nextSteps, 'nextSteps']];
  for (const [items, key] of arrays) while (JSON.stringify(result).length > budget && items?.length) { items.pop(); note(key); }
  if (JSON.stringify(result).length > budget && result.report) { result.report = null; note('reports'); }
  if (JSON.stringify(result).length > budget && result.goal) { result.goal = null; note('goal'); }
  if (JSON.stringify(result).length > budget && result.attempt?.id) { result.attempt.id = null; note('attemptId'); }
  if (JSON.stringify(result).length > budget) {
    result.attempt = null; result.verification.current = false; result.verification.scope = 'unknown';
    result.verification.reasons = ['PROJECTION_IDENTITY_OMITTED']; result.remaining.blockers = ['PROJECTION_IDENTITY_OMITTED'];
    result.remaining.nextSteps = ['OPEN_CHILD_RECORD']; note('attempt');
  }
  if (currentRows.length && ['reads', 'artifacts', 'otherObservations', 'hostEvidenceIds'].some(key => omitted[key])) result.hostFacts.coverage = 'partial';
  return result;
}
