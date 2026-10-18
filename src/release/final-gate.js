// Release evidence calculator only: never starts, signs, installs or publishes.
// Evidence collection and Owner approvals remain external, explicit gates.
export const REQUIRED_ACCEPTANCE_IDS = Object.freeze([
  ...Array.from({ length: 24 }, (_, n) => `E${String(n + 1).padStart(2, '0')}`),
  ...Array.from({ length: 40 }, (_, n) => `AC-${String(n + 1).padStart(3, '0')}`)
]);
export const BLOCKER_STATES = Object.freeze(['OPEN', 'FIXED_CODE', 'VERIFIED_FIXTURE', 'VERIFIED_RELEASE_INTEGRATION',
  'VERIFIED_REAL_E2E', 'OWNER_ACTION_REQUIRED', 'NOT_RUN_ENVIRONMENT', 'DEFERRED_WITH_APPROVAL', 'CLOSED']);
const verifiedLevels = new Set(['VERIFIED_FIXTURE', 'VERIFIED_RELEASE_INTEGRATION', 'VERIFIED_REAL_E2E']);

export function evaluateFinalReleaseGate(input = {}) {
  if (Object.hasOwn(input, 'forceStatus') || Object.hasOwn(input, 'finalStatus')) throw new TypeError('Release status override is forbidden');
  const { blockers = [], scenarios = [], artifact = {}, verification = {}, owner = {}, authenticode, updateSigning } = input;
  if (!Array.isArray(blockers) || !Array.isArray(scenarios)) throw new TypeError('Release evidence arrays are required');
  const sameBuild = row => row.build === artifact.build && row.sourceCommit === artifact.sourceCommit;
  const closed = row => row.status === 'CLOSED' && verifiedLevels.has(row.level)
    && typeof row.evidence === 'string' && row.evidence.trim().length > 0 && sameBuild(row);
  for (const row of blockers) {
    if (!row.id || !['P0', 'P1'].includes(row.severity) || !BLOCKER_STATES.includes(row.status)) throw new TypeError('Invalid blocker identity, severity or state');
  }
  const open = blockers.filter(row => !closed(row));
  const openP0Count = open.filter(row => row.severity === 'P0').length;
  const openP1Count = open.filter(row => row.severity === 'P1').length;
  const cases = new Map(scenarios.map(row => [row.id, row]));
  const completeSet = cases.size === REQUIRED_ACCEPTANCE_IDS.length && scenarios.length === cases.size
    && REQUIRED_ACCEPTANCE_IDS.every(id => cases.has(id));
  // No unverified scope exclusion or textual deferral can waive a mandatory case.
  // A future approved scope revision requires a reviewed policy change, not a flag.
  const mandatoryRealE2ePending = REQUIRED_ACCEPTANCE_IDS.filter(id => {
    const row = cases.get(id);
    return !row || row.status !== 'PASS' || row.level !== 'VERIFIED_REAL_E2E' || !sameBuild(row)
      || typeof row.evidence !== 'string' || !row.evidence.trim();
  });
  const artifactVerified = artifact.verified === true && artifact.dirtySourceTree === false
    && Number.isSafeInteger(artifact.build) && artifact.build > 0 && /^[a-f0-9]{40}$/i.test(artifact.sourceCommit ?? '');
  const reasons = [];
  if (openP0Count) reasons.push('OPEN_P0');
  if (openP1Count) reasons.push('OPEN_P1');
  if (!completeSet) reasons.push('INCOMPLETE_OR_DUPLICATE_ACCEPTANCE_SET');
  if (mandatoryRealE2ePending.length) reasons.push('MANDATORY_REAL_E2E_PENDING');
  if (!artifactVerified) reasons.push('RELEASE_ARTIFACT_UNVERIFIED');
  for (const field of ['testsPassed', 'buildsPassed', 'windowsAcceptancePassed', 'updateTrustVerified', 'downloadSourcesVerified']) {
    if (verification[field] !== true) reasons.push(field);
  }
  if (Number(verification.testFailureCount ?? 0) !== 0) reasons.push('AUTOMATION_FAIL');
  if (updateSigning !== 'VERIFIED_REAL_E2E') reasons.push('UPDATE_SIGNING_PENDING');
  if (!Array.isArray(owner.approvalsPending) || owner.approvalsPending.length) reasons.push('OWNER_APPROVAL_PENDING');
  const finalStatus = reasons.length ? 'RELEASE_BLOCKED'
    : authenticode === 'Valid' && owner.releaseApproved === true ? 'STABLE_READY' : 'RC_READY';
  return { finalStatus, openP0Count, openP1Count, mandatoryRealE2ePending, artifactVerified, reasons,
    unverifiedClosures: blockers.filter(row => row.status === 'CLOSED' && !closed(row)).map(row => row.id),
    ownerApprovalPending: owner.approvalsPending ?? ['UNVERIFIED'], authenticodeStatus: authenticode ?? 'SIGNING_PENDING',
    updateSigningStatus: updateSigning ?? 'SIGNING_PENDING', sourceCommit: artifact.sourceCommit ?? null, build: artifact.build ?? null };
}
