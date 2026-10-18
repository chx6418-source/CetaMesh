import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { inspectRuntimePreflight } from '../src/migration/runtime-preflight.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-m5-preflight-'));
try {
  const absent = inspectRuntimePreflight({ dataRoot: root });
  assert.equal(absent.status, 'MIGRATION_BLOCKED');
  assert.equal(absent.stopConfirmed, false);
  assert.equal(absent.stores.send.state, 'NOT_FOUND_NOT_PROOF_OF_EMPTY');
  assert.equal(fs.readdirSync(root).length, 0, 'observer cannot create a StateDir or journal');
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state', 'bridge.lock'), '12345');
  const dead = inspectRuntimePreflight({ dataRoot: root, probePid: () => 'ABSENT' });
  assert.equal(dead.locks.find(row => row.name === 'bridge.lock').pidStatus, 'ABSENT');
  assert.equal(dead.stopConfirmed, false, 'dead PID is not a stopped consumer acknowledgement');
  fs.writeFileSync(path.join(root, 'state', '.core-owner.lock'), '12345');
  assert.equal(inspectRuntimePreflight({ dataRoot: root }).locks.find(row => row.name === '.core-owner.lock').state, 'INVALID_LOCK');
  writeJsonAtomic(path.join(root, 'state', 'qq-send-ledger.json'), { version: 1, records: [{ accountId: '10001', key: '10001:r', fingerprint: 'hash', status: 'outcome-unknown' }] });
  writeJsonAtomic(path.join(root, 'state', 'channel', 'delivery.json'), { version: 1, events: [], consumers: { social: { cursor: 0, deliveries: { e: 'in-flight' } } } });
  writeJsonAtomic(path.join(root, 'state', 'capability', 'approvals.json'), [{ status: 'pending', request: { secret: 'NEVER_PRINT_PRIVATE' } }]);
  writeJsonAtomic(path.join(root, 'state', 'capability', 'requests.json'), { r: { status: 'in-flight' } });
  const before = fs.readFileSync(path.join(root, 'state', 'channel', 'delivery.json'));
  const report = inspectRuntimePreflight({ dataRoot: root, probePid: () => 'EXISTS' });
  assert.equal(report.stores.send.unresolved, 1);
  assert.equal(report.stores.delivery.unresolved, 1);
  assert.equal(report.stores.approval.unresolved, 1);
  assert.equal(report.stores.requests.unresolved, 1);
  assert.deepEqual(fs.readFileSync(path.join(root, 'state', 'channel', 'delivery.json')), before, 'observer must not run journal recovery');
  assert.doesNotMatch(JSON.stringify(report), /NEVER_PRINT_PRIVATE|10001|12345/);
  writeJsonAtomic(path.join(root, 'state', 'qq-send-ledger.json'), { version: 99, records: [] });
  assert.equal(inspectRuntimePreflight({ dataRoot: root }).stores.send.state, 'SCHEMA_UNVERIFIED');
  fs.writeFileSync(path.join(root, 'state', 'qq-send-ledger.json'), '{broken');
  assert.equal(inspectRuntimePreflight({ dataRoot: root }).stores.send.state, 'CORRUPT');
  fs.unlinkSync(path.join(root, 'state', 'qq-send-ledger.json'));
  fs.symlinkSync(path.join(root, 'state'), path.join(root, 'state', 'qq-send-ledger.json'), 'junction');
  assert.equal(inspectRuntimePreflight({ dataRoot: root }).stores.send.state, 'UNSAFE_LINK');
  console.log('DRY_RUN_PASS read-only preflight, unknown states, unresolved effects, privacy and link rejection');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
