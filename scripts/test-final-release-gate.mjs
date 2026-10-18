import assert from 'node:assert/strict';
import { evaluateFinalReleaseGate, REQUIRED_ACCEPTANCE_IDS } from '../src/release/final-gate.js';

function ready() {
  const build = 1089, sourceCommit = 'a'.repeat(40);
  return { blockers: [], scenarios: REQUIRED_ACCEPTANCE_IDS.map(id => ({ id, status: 'PASS', level: 'VERIFIED_REAL_E2E', evidence: 'unit-fixture-evidence', build, sourceCommit })),
    artifact: { build, sourceCommit, dirtySourceTree: false, verified: true },
    verification: { testsPassed: true, buildsPassed: true, windowsAcceptancePassed: true, updateTrustVerified: true, downloadSourcesVerified: true },
    owner: { releaseApproved: false, approvalsPending: [] }, authenticode: 'NotSigned', updateSigning: 'VERIFIED_REAL_E2E' };
}
assert.equal(REQUIRED_ACCEPTANCE_IDS.length, 64);
assert.equal(evaluateFinalReleaseGate(ready()).finalStatus, 'RC_READY');
for (const level of ['VERIFIED_FIXTURE', 'VERIFIED_RELEASE_INTEGRATION', 'NOT_RUN_ENVIRONMENT']) {
  const input = ready(); input.scenarios[0].level = level;
  assert.equal(evaluateFinalReleaseGate(input).finalStatus, 'RELEASE_BLOCKED', `${level} cannot satisfy a mandatory real scenario`);
}
for (const status of ['FAIL', 'NOT_RUN_ENVIRONMENT', 'NOT_APPLICABLE', 'DEFERRED_WITH_APPROVAL']) {
  const input = ready(); input.scenarios[0].status = status;
  assert.equal(evaluateFinalReleaseGate(input).finalStatus, 'RELEASE_BLOCKED', 'unverified scope/deferral never waives a required case');
}
for (const severity of ['P0', 'P1']) {
  const input = ready(); input.blockers = [{ id: 'gate-open', severity, status: 'FIXED_CODE', evidence: 'code is not closure' }];
  const result = evaluateFinalReleaseGate(input);
  assert.equal(result.finalStatus, 'RELEASE_BLOCKED'); assert.equal(result[severity === 'P0' ? 'openP0Count' : 'openP1Count'], 1);
}
const fakeClosed = ready(); fakeClosed.blockers = [{ id: 'fake-close', severity: 'P0', status: 'CLOSED' }];
assert.equal(evaluateFinalReleaseGate(fakeClosed).openP0Count, 1, 'CLOSED text without verified evidence does not close a gate');
for (const flag of ['testsPassed', 'buildsPassed', 'windowsAcceptancePassed', 'updateTrustVerified', 'downloadSourcesVerified']) {
  const input = ready(); input.verification[flag] = false; assert.equal(evaluateFinalReleaseGate(input).finalStatus, 'RELEASE_BLOCKED', flag);
}
const dirty = ready(); dirty.artifact.dirtySourceTree = true; assert.equal(evaluateFinalReleaseGate(dirty).finalStatus, 'RELEASE_BLOCKED');
const stale = ready(); stale.scenarios[0].build = 1088; assert.equal(evaluateFinalReleaseGate(stale).finalStatus, 'RELEASE_BLOCKED', 'old evidence cannot verify a new build');
const missing = ready(); missing.scenarios.pop(); assert.equal(evaluateFinalReleaseGate(missing).finalStatus, 'RELEASE_BLOCKED');
const duplicate = ready(); duplicate.scenarios.push(duplicate.scenarios[0]); assert.equal(evaluateFinalReleaseGate(duplicate).finalStatus, 'RELEASE_BLOCKED');
const badSigning = ready(); badSigning.updateSigning = 'SIGNING_PENDING'; assert.equal(evaluateFinalReleaseGate(badSigning).finalStatus, 'RELEASE_BLOCKED');
const stable = ready(); stable.owner.releaseApproved = true; stable.authenticode = 'Valid';
assert.equal(evaluateFinalReleaseGate(stable).finalStatus, 'STABLE_READY');
stable.owner.approvalsPending = ['required high-risk approval']; assert.equal(evaluateFinalReleaseGate(stable).finalStatus, 'RELEASE_BLOCKED');
assert.throws(() => evaluateFinalReleaseGate({ ...ready(), forceStatus: 'STABLE_READY' }), /override/i);
console.log('PASS final gate strict precedence, all 64 cases, real-vs-fixture, provenance, closure proof, signing and Owner approval; unit fixtures are not release evidence');
