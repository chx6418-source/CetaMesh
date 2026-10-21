import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMigrationFixture } from '../src/testing/legacy-migration-fixture.js';
import { readJsonFile } from '../src/storage/json-file.js';

const fixtures = [];
const make = () => {
  const fixture = createMigrationFixture({ accounts: [{ accountId: '10001', files: {
    'state/sessions.json': { sessions: { 'group:42': 'fixture-session' } },
    'state/qq-message-receipts.json': { version: 1, ids: [], pending: [] }
  } }] });
  fixtures.push(fixture); fixture.stopWriters(); return fixture;
};
try {
  const backup = make(), bp = backup.plan();
  assert.throws(() => backup.apply(bp, { approval: backup.approve(bp), crashAt: 'PLANNED', onCrash: () => {
    // Real filesystem failure confined to an allocated fixture: a file blocks
    // creation of the backup directory; no engine fault hook or real disk filling.
    fs.writeFileSync(path.join(backup.root, 'backups'), 'blocked fixture backup path');
  } }), { code: 'WRITE_FAILED' });
  assert.equal(backup.authority(), null);
  assert.equal(backup.verifyOriginals(bp), true);
  assert.equal(backup.recover({ approval: backup.approve(bp) }).state, 'ROLLED_BACK');

  const restore = make(), rp = restore.plan();
  restore.apply(rp, { approval: restore.approve(rp) });
  const pointer = path.join(restore.root, 'active-version.json');
  const preserved = path.join(restore.root, 'preserved-pointer.json');
  assert.throws(() => restore.rollback({ approval: restore.approve(rp), beforeSwitch: () => {
    fs.renameSync(pointer, preserved); fs.mkdirSync(pointer);
  } }), { code: 'WRITE_FAILED' });
  assert.equal(readJsonFile(path.join(restore.root, 'migration-journal.json')).state, 'ROLLING_BACK');
  assert.equal(restore.verifyOriginals(rp), true);
  // Restore only the test obstruction, then reopen recovery from the persisted journal.
  fs.rmdirSync(pointer); fs.renameSync(preserved, pointer);
  assert.equal(restore.recover({ approval: restore.approve(rp) }).state, 'COMMITTED');
  assert.equal(restore.rollback({ approval: restore.approve(rp) }).status, 'ROLLBACK_PASS');
  const aclGuard = make(), aclPlan = aclGuard.plan();
  aclGuard.apply(aclPlan, { approval: aclGuard.approve(aclPlan) });
  const aclJournal = readJsonFile(path.join(aclGuard.root, 'migration-journal.json'));
  const aclBackup = path.join(aclGuard.root, aclJournal.files[0].backup);
  const beforePointer = aclGuard.authority();
  assert.equal(aclGuard.verifyBackups(), true, 'the post-copy backup ACL snapshot is verifiable');
  fs.chmodSync(aclBackup, 0o666);
  assert.throws(() => aclGuard.verifyBackups(), { code: 'BACKUP_UNVERIFIED' },
    'changing only a backup file permission must invalidate its verification');
  assert.deepEqual(aclGuard.authority(), beforePointer,
    'a tampered backup may not silently change migration ownership');
  const targetGuard = make(), targetPlan = targetGuard.plan();
  targetGuard.apply(targetPlan, { approval: targetGuard.approve(targetPlan) });
  const targetJournal = readJsonFile(path.join(targetGuard.root, 'migration-journal.json'));
  const targetFile = path.join(targetGuard.root, targetJournal.versionDirectory, targetJournal.files[0].target);
  const oldMode = fs.statSync(targetFile).mode & 0o777;
  fs.chmodSync(targetFile, (oldMode & 0o200) ? (oldMode & ~0o222) : (oldMode | 0o200));
  const originalAuthority = targetGuard.authority();
  assert.throws(() => targetGuard.rollback({ approval: targetGuard.approve(targetPlan) }), { code: 'TARGET_UNVERIFIED' },
    'target file permission tampering must prevent rollback without switching authority');
  assert.deepEqual(targetGuard.authority(), originalAuthority);
  console.log('FIXTURE_MIGRATION_PASS / ROLLBACK_PASS backup-path failure, durable journal and permission-only tamper rejection');
} finally { for (const fixture of fixtures) fixture.dispose(); }
