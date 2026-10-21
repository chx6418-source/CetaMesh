import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBionicService } from '../src/bionic/service.js';
import { createBionicChannelFacade } from '../src/bionic/channel-facade.js';

const reads = [];
const facade = createBionicChannelFacade({ accountId: '10001', request: async (method, params) => {
  reads.push(params); return params.envelope ? { status: 'ok', retcode: 0, data: { fixture: true } } : { fixture: true };
} });
assert.deepEqual(await facade.client.fetchFaceEntity(14), { fixture: true });
assert.deepEqual(reads[0], { action: 'fetch_face_entity', params: { face_id: 14, refresh: false }, envelope: false });
assert.equal((await facade.client.request('fetch_custom_face_detail', {})).retcode, 0);
assert.deepEqual(await facade.client.raw('get_login_info', {}), { fixture: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-runtime-'));
let consumer;
const channel = {
  execute: async () => ({ ready: true, accountId: '10001' }),
  registerConsumer: spec => { consumer = spec; return () => { consumer = null; }; },
  send: async () => { throw Object.assign(new Error('approval required'), { code: 'QQ_APPROVAL_REQUIRED' }); },
  read: async action => action === 'get_login_info' ? { user_id: 10001, nickname: 'fixture' } : {}
};
const config = { allow: { groups: ['42', '43'], private: [] }, dsh: { baseUrl: 'http://127.0.0.1:9' },
  socialV2: { wake: { triggers: { anyMessage: false, probability: 0 } } } };
const service = createBionicService({ dataRoot: root, stateDir: path.join(root, 'state'), config, channelService: channel,
  executable: process.env.WHALEBRIDGE_TEST_QQ_CONNECTOR_EXE });
try {
  assert.equal((await service.start()).running, true);
  await consumer.handle({ accountId: '10001', native: { self_id: 10001, user_id: 7, group_id: 42,
    message_id: 1, message: [{ type: 'text', data: { text: 'ordinary fixture message' } }] } });
  await consumer.handle({ accountId: '10001', native: { self_id: 10001, user_id: 8, group_id: 43,
    message_id: 2, message: [{ type: 'text', data: { text: 'another isolated group' } }] } });
  const health = await service.health();
  assert.equal(health.socialLoopRunning, true, 'new lifecycle must actually own the existing Social loop');
  assert.deepEqual(health.conversations.sort(), ['group:42', 'group:43']);
  const stateFile = path.join(root, 'channel', 'qq', '10001', 'bionic', 'state', 'social-v2.json');
  const savedBeforeFailure = fs.readFileSync(stateFile);
  fs.unlinkSync(stateFile); fs.mkdirSync(stateFile);
  await assert.rejects(consumer.handle({ accountId: '10001', native: { self_id: 10001, user_id: 7, group_id: 42,
    message_id: 3, message: [{ type: 'text', data: { text: 'must not acknowledge a failed durable write' } }] } }),
  { code: 'BIONIC_STATE_WRITE_FAILED' });
  fs.rmdirSync(stateFile); fs.writeFileSync(stateFile, savedBeforeFailure);
  await service.stop();
  assert.equal(consumer, null);
  assert.equal((await service.health()).running, false);
  const ownedState = path.join(root, 'channel', 'qq', '10001', 'bionic', 'state', 'social-v2.json');
  const originalOwnedState = fs.readFileSync(ownedState);
  fs.writeFileSync(ownedState, '{broken owned state');
  await assert.rejects(service.start(), { code: 'BIONIC_STATE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(ownedState, 'utf8'), '{broken owned state');
  fs.writeFileSync(ownedState, originalOwnedState);
  const legacyFile = path.join(root, 'state', 'social-v2.json');
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, '{"legacy":"must remain byte exact"}');
  await assert.rejects(service.start(), { code: 'BIONIC_MIGRATION_APPROVAL_REQUIRED' });
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), '{"legacy":"must remain byte exact"}');
  console.log('Bionic Social production policy lifecycle, group isolation and migration gate verified');
} finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
