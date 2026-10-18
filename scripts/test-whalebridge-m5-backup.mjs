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
  console.log('FIXTURE_MIGRATION_PASS / ROLLBACK_PASS backup-path failure, failed pointer rollback and durable journal recovery');
} finally { for (const fixture of fixtures) fixture.dispose(); }
