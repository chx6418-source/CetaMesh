import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';
import os from 'node:os';
import { createMigrationFixture, openFixtureForChild } from '../src/testing/legacy-migration-fixture.js';

const files = (id = 'topic-1') => ({
  'config.json': { ownerQQ: '99999', snowluma: { wsUrl: 'ws://127.0.0.1:9' } },
  'state/social-v2.json': { conversations: { 'group:42': { activeTopics: [{ id, text: 'fixture only', scope: 'group:42' }] }, 'group:43': { memberImpressions: { '7': { preference: 'fixture preference' } } } } },
  'state/sessions.json': { sessions: { 'group:42': 's-42', 'group:43': 's-43' } },
  'state/qq-message-receipts.json': { version: 1, ids: ['10001:group:42:9'], pending: [] },
  'state/qq-send-ledger.json': { version: 1, records: [] },
  'state/slang.json': [{ id: 'slang-1', content: 'fixture slang', sources: ['group:42'] }],
  'state/memory/memories.json': { schemaVersion: 1, revision: 1, memories: [{ id: 'mem-1', scope: { kind: 'global' }, scopeKey: 'global:', content: 'fixture', rev: 1 }] }
  , 'roles/测试 人设.md': 'synthetic persona, original bytes and Unicode filename preserved\n'
});
const active = [];
function fixture(options = {}) { const f = createMigrationFixture({ accounts: [{ accountId: '10001', files: files() }], ...options }); active.push(f); return f; }
try {
  assert.throws(() => openFixtureForChild({ root: process.cwd(), nonce: 'forged' }), { code: 'REAL_DATA_NOT_AUTHORIZED' });
  const forged = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-m5-fixture-'));
  try {
    writeJsonAtomic(path.join(forged, '.m5-fixture.json'), { purpose: 'SYNTHETIC_FIXTURE_ONLY', root: forged, nonce: 'f'.repeat(64) });
    assert.throws(() => openFixtureForChild({ root: forged, nonce: 'f'.repeat(64) }), { code: 'REAL_DATA_NOT_AUTHORIZED' });
  } finally { fs.rmSync(forged, { recursive: true, force: true }); }
  const f = fixture({ volume: 'workspace' });
  const plan = f.plan(); assert.equal(plan.report.status, 'DRY_RUN_PASS');
  assert.throws(() => f.apply(plan), { code: 'OWNER_APPROVAL_REQUIRED' });
  assert.throws(() => f.apply(plan, { approval: f.approve(plan) }), { code: 'WRITER_STOP_UNCONFIRMED' });
  f.stopWriters();
  const result = f.apply(plan, { approval: f.approve(plan) });
  assert.equal(result.status, 'FIXTURE_MIGRATION_PASS');
  assert.equal(f.apply(plan, { approval: f.approve(plan) }).duplicate, true);
  f.setForeignLease(true);
  assert.throws(() => f.apply(plan, { approval: f.approve(plan) }), { code: 'ACCOUNT_LEASE_BUSY' });
  f.setForeignLease(false);
  assert.throws(() => f.legacyWrite('state/social-v2.json', {}), { code: 'LEGACY_READ_ONLY' });
  assert.equal(f.verifyOriginals(plan), true);
  assert.equal(f.rollback({ approval: f.approve(plan) }).status, 'ROLLBACK_PASS');
  assert.equal(f.authority(), null);
  assert.equal(f.verifyOriginals(plan), true, 'rollback never changes original IDs, scopes or bytes');
  assert.equal(f.verifyBackups(), true);
  const immutableBackup = path.join(f.root, 'backups', plan.report.planId, '0.snapshot');
  assert.equal(fs.statSync(immutableBackup).mode & 0o222, 0, 'backup snapshots must be read-only');
  const wrongPointer = fixture(); const wp = wrongPointer.plan(); wrongPointer.stopWriters(); wrongPointer.apply(wp, { approval: wrongPointer.approve(wp) });
  const pointer = wrongPointer.authority();
  writeJsonAtomic(path.join(wrongPointer.root, 'active-version.json'), { ...pointer, directory: 'versions/not-verified' });
  assert.throws(() => wrongPointer.recover({ approval: wrongPointer.approve(wp) }), { code: 'AUTHORITY_UNCERTAIN' });
  assert.throws(() => wrongPointer.apply(wp, { approval: wrongPointer.approve(wp) }), { code: 'AUTHORITY_UNCERTAIN' });
  writeJsonAtomic(path.join(wrongPointer.root, 'active-version.json'), pointer);
  const completeJournal = readJsonFile(path.join(wrongPointer.root, 'migration-journal.json'));
  writeJsonAtomic(path.join(wrongPointer.root, 'migration-journal.json'), { ...completeJournal, files: [] });
  assert.throws(() => wrongPointer.recover({ approval: wrongPointer.approve(wp) }), { code: 'JOURNAL_UNVERIFIED' });
  writeJsonAtomic(path.join(wrongPointer.root, 'migration-journal.json'), completeJournal);
  const committedFile = path.join(wrongPointer.root, completeJournal.versionDirectory, completeJournal.files[0].target);
  const originalTarget = fs.readFileSync(committedFile);
  fs.writeFileSync(committedFile, 'new writer changed target');
  assert.throws(() => wrongPointer.rollback({ approval: wrongPointer.approve(wp) }), { code: 'TARGET_UNVERIFIED' });
  fs.writeFileSync(committedFile, originalTarget);
  assert.throws(() => wrongPointer.rollback({ approval: wrongPointer.approve(wp), beforeSwitch: () => {
    const lock = fs.readdirSync(path.join(wrongPointer.root, 'leases')).find(name => name.endsWith('.lock'));
    fs.writeFileSync(path.join(wrongPointer.root, 'leases', lock), 'foreign-epoch');
  } }), { code: 'ACCOUNT_LEASE_BUSY' });
  assert.deepEqual(wrongPointer.authority(), pointer, 'lost lease must block authority writes');

  const changed = fixture(); const stale = changed.plan(); changed.stopWriters();
  writeJsonAtomic(path.join(changed.sources[0], 'state', 'social-v2.json'), files('user-edited')['state/social-v2.json']);
  assert.throws(() => changed.apply(stale, { approval: changed.approve(stale) }), { code: 'STALE_PLAN' });
  assert.notEqual(changed.plan().report.planId, stale.report.planId);
  assert.throws(() => changed.apply(changed.plan(), { approval: changed.approve(stale) }), { code: 'OWNER_APPROVAL_REQUIRED' });
  const during = fixture(); const dp = during.plan(); during.stopWriters();
  assert.throws(() => during.apply(dp, { approval: during.approve(dp), beforeVerify: () => {
    writeJsonAtomic(path.join(during.sources[0], 'state', 'current-role.json'), { role: 'newly-added', mode: 'active' });
  } }), { code: 'STALE_PLAN' });
  assert.equal(during.authority(), null, 'new source files during staging invalidate the plan');

  for (const phase of ['PLANNED', 'BACKED_UP', 'STAGED', 'VERIFIED', 'AFTER_POINTER', 'COMMITTED']) {
    const interrupted = fixture(); const p = interrupted.plan(); interrupted.stopWriters();
    const crash = interrupted.crashInChild(p, phase);
    assert.equal(crash.error, undefined);
    assert.notEqual(crash.status, 0, `actual child must be killed during ${phase}`);
    assert.ok(fs.readdirSync(path.join(interrupted.root, 'leases')).some(name => name.endsWith('.lock')), 'hard crash must leave a lease for PID-verified recovery');
    const recovered = interrupted.recover({ approval: interrupted.approve(p) });
    assert.equal(recovered.state, ['AFTER_POINTER', 'COMMITTED'].includes(phase) ? 'COMMITTED' : 'ROLLED_BACK');
    assert.equal(interrupted.verifyOriginals(p), true);
    if (['AFTER_POINTER', 'COMMITTED'].includes(phase)) assert.equal(interrupted.rollback({ approval: interrupted.approve(p) }).status, 'ROLLBACK_PASS');
  }
  for (const failure of ['ENOSPC', 'EACCES', 'WRITE_FAILED']) {
    const broken = fixture(); const p = broken.plan(); broken.stopWriters();
    assert.throws(() => broken.apply(p, { approval: broken.approve(p), failure }), { code: failure });
    assert.equal(broken.authority(), null);
    assert.equal(broken.recover({ approval: broken.approve(p) }).state, 'ROLLED_BACK');
    assert.equal(broken.verifyOriginals(p), true);
  }
  const account = fixture(); const ap = account.plan(); account.stopWriters(); account.setForeignLease(true);
  assert.throws(() => account.apply(ap, { approval: account.approve(ap) }), { code: 'ACCOUNT_LEASE_BUSY' });
  account.setForeignLease(false);
  const conflict = fixture(); const cp = conflict.plan(); conflict.stopWriters();
  conflict.createTargetConflict(cp);
  assert.throws(() => conflict.apply(cp, { approval: conflict.approve(cp) }), { code: 'TARGET_CONFLICT' });
  const targetExists = fixture();
  const existing = path.join(targetExists.sources[0], 'channel', 'qq', '10001', 'bionic', 'state', 'social-v2.json');
  writeJsonAtomic(existing, { conversations: {} });
  assert.ok(targetExists.plan().report.blockers.some(row => row.code === 'TARGET_EXISTS_REQUIRES_REVIEW'));
  const tampered = fixture(); const bp = tampered.plan(); tampered.stopWriters(); tampered.apply(bp, { approval: tampered.approve(bp) });
  const journal = readJsonFile(path.join(tampered.root, 'migration-journal.json'));
  const backup = path.join(tampered.root, journal.files[0].backup); fs.chmodSync(backup, 0o666); fs.writeFileSync(backup, 'tampered');
  assert.throws(() => tampered.rollback({ approval: tampered.approve(bp) }), { code: 'BACKUP_UNVERIFIED' });
  assert.equal(tampered.authority().planId, bp.report.planId, 'unverified rollback cannot switch authority');
  const linkTarget = fixture(); const lp = linkTarget.plan(); linkTarget.stopWriters();
  fs.symlinkSync(linkTarget.sources[0], path.join(linkTarget.root, 'versions'), 'junction');
  assert.throws(() => linkTarget.apply(lp, { approval: linkTarget.approve(lp) }), { code: 'UNSAFE_LINK' });
  fs.unlinkSync(path.join(linkTarget.root, 'versions'));

  const secondAccount = files('account-b'); secondAccount['state/qq-message-receipts.json'].ids = ['10002:group:42:9'];
  const two = fixture({ accounts: [{ accountId: '10001', files: files('account-a') }, { accountId: '10002', files: secondAccount }] });
  const tp = two.plan(); two.stopWriters(); two.apply(tp, { approval: two.approve(tp) });
  const groups = two.readCommittedSocial();
  assert.equal(groups['10001'].conversations['group:42'].activeTopics[0].id, 'account-a');
  assert.equal(groups['10002'].conversations['group:42'].activeTopics[0].id, 'account-b');
  assert.notDeepEqual(groups['10001'], groups['10002']);
  assert.equal(two.uninstallConnector().dataRetained, true);
  assert.equal(two.rollback({ approval: two.approve(tp) }).status, 'ROLLBACK_PASS');
  console.log('FIXTURE_MIGRATION_PASS / ROLLBACK_PASS owner, hashes, IDs/scopes, leases, crash, disk and account isolation');
} finally { for (const f of active) f.dispose(); }
