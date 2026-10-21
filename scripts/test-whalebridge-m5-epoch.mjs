// Executable DESIGN fixture, never imported by a product entrypoint.
// Admission proofs below are synthetic; this does not implement a native OneBot live/history oracle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelDeliveryJournal } from '../src/channel/delivery-journal.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-m5-epoch-'));
const manifest = path.join(root, 'epoch-design.json');
try {
  const legacy = path.join(root, 'legacy.json'); writeJsonAtomic(legacy, { unread: ['synthetic historical input'] });
  const original = fs.readFileSync(legacy);
  let journal = createChannelDeliveryJournal({ stateDir: root });
  const activate = (id, gate) => {
    assert(gate.owner && gate.stopped && gate.lease && gate.live, 'all gates required');
    writeJsonAtomic(manifest, { version: 1, id, accountId: '10001', generation: gate.generation, state: 'LIVE' });
  };
  const admit = (message, proof) => {
    const epoch = readJsonFile(manifest);
    // Test-only authority fixture. In production these facts must come from the
    // authenticated supervisor and verified transport boundary, never message fields.
    if (epoch.version !== 1 || epoch.state !== 'LIVE' || !proof?.verifiedNew || proof.epoch !== epoch.id || proof.generation !== epoch.generation || message.accountId !== epoch.accountId) return { quarantined: true };
    return journal.append(message); // stable external identity deliberately excludes epoch
  };
  assert.throws(() => activate('e1', { owner: false, stopped: true, lease: true, live: true }));
  assert.equal(fs.existsSync(manifest), false);
  for (const missing of ['owner', 'stopped', 'lease', 'live']) {
    assert.throws(() => activate('e1', { owner: true, stopped: true, lease: true, live: true, [missing]: false }));
  }
  activate('e1', { owner: true, stopped: true, lease: true, live: true, generation: 'connection-1' });
  const message = { accountId: '10001', target: 'group:42', messageId: 'm1', text: 'fixture' };
  const proof = { verifiedNew: true, epoch: 'e1', generation: 'connection-1' };
  assert.equal(admit(message, null).quarantined, true);
  assert.equal(admit(message, { ...proof, generation: 'old-connection' }).quarantined, true);
  assert.equal(admit({ ...message, accountId: '10002' }, proof).quarantined, true);
  assert.equal(journal.snapshot().events.length, 0, 'unproven history cannot reach any consumer');
  const accepted = admit(message, proof);
  for (const consumer of ['bionic', 'task', 'audit']) journal.state(consumer, accepted, 'acknowledged');
  assert(Object.values(journal.snapshot().consumers).every(c => c.cursor === 1));
  journal = createChannelDeliveryJournal({ stateDir: root });
  assert.equal(admit(message, proof).duplicate, true);
  activate('e2', { owner: true, stopped: true, lease: true, live: true, generation: 'connection-2' });
  const nextProof = { ...proof, epoch: 'e2', generation: 'connection-2' };
  assert.equal(admit(message, proof).quarantined, true, 'old connection proof cannot enter a new epoch');
  assert.equal(admit(message, nextProof).duplicate, true, 'new epoch cannot reset external message dedup');
  assert.throws(() => admit({ ...message, text: 'different' }, nextProof), { code: 'CHANNEL_MESSAGE_CONFLICT' });
  const second = admit({ ...message, messageId: 'm2' }, nextProof);
  journal.state('bionic', second, 'in-flight'); journal.state('audit', second, 'acknowledged');
  journal = createChannelDeliveryJournal({ stateDir: root });
  assert.equal(journal.snapshot().consumers.bionic.deliveries[second.eventId], 'outcome-unknown');
  assert.equal(journal.snapshot().consumers.bionic.cursor, 1);
  assert.equal(journal.snapshot().consumers.audit.cursor, 2);
  assert.equal(admit({ ...message, messageId: 'm2' }, nextProof).duplicate, true);
  assert.deepEqual(fs.readFileSync(legacy), original);
  assert.equal(journal.snapshot().events.length, 2);
  const goodManifest = readJsonFile(manifest);
  writeJsonAtomic(manifest, { ...goodManifest, state: 'SEALED' });
  assert.equal(admit({ ...message, messageId: 'm3' }, nextProof).quarantined, true);
  fs.writeFileSync(manifest, '{interrupted');
  assert.throws(() => admit({ ...message, messageId: 'm3' }, nextProof), { code: 'CORRUPT' });
  assert.equal(journal.snapshot().events.length, 2);
  console.log('FIXTURE_EPOCH_PASS admission gates, historical quarantine, independent cursors, restart, cross-epoch dedup and unknown effects');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
