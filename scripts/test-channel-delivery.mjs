import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelService } from '../src/channel/service.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createBrokeredQqRuntime } from '../src/channel/qq/broker-facade.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-channel-delivery-'));
try {
  let receive;
  const config = { allow: { groups: ['42'], private: ['7'] } };
  const make = () => createChannelService({ stateDir: root, config,
    connectorFactory: ({ onMessage }) => {
      receive = onMessage;
      return { start: async () => ({ ready: true, accountId: '10001' }),
        health: async () => ({ ready: true, accountId: '10001' }), stop: async () => ({ stopped: true }) };
    } });
  let service = make();
  const seen = [[], [], []];
  for (let i = 0; i < 3; i++) service.registerConsumer({ id: `consumer-${i}`,
    authorize: envelope => envelope.target === 'group:42',
    handle: envelope => { seen[i].push(envelope.eventId); } });
  await service.start();
  const message = { self_id: 10001, user_id: 7, group_id: 42, message_id: 9,
    message_type: 'group', message: [{ type: 'text', data: { text: '/run delete all' } }] };
  const accepted = await receive(message);
  assert.equal(accepted.accepted, true);
  await service.drain();
  assert.deepEqual(seen.map(rows => rows.length), [1, 1, 1]);
  assert.equal((await receive(message)).duplicate, true);
  await service.drain();
  assert.deepEqual(seen.map(rows => rows.length), [1, 1, 1]);
  assert.equal(service.deliverySnapshot().events[0].actor.kind, 'external');
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const during = [];
  service.registerConsumer({ id: 'during', authorize: () => true, handle: async event => {
    during.push(event.messageId); if (event.messageId === '9') { entered(); await pause; }
  } });
  const activeDrain = service.drain();
  await enteredPromise;
  await receive({ ...message, message_id: 10 });
  release();
  await activeDrain;
  assert.deepEqual(during, ['9', '10'], 'ingress during a running consumer cannot lose its drain wakeup');
  await assert.rejects(receive({ ...message, self_id: 999 }), { code: 'CHANNEL_ACCOUNT_MISMATCH' });
  await assert.rejects(receive({ ...message, group_id: 43 }), { code: 'CHANNEL_SOURCE_DENIED' });
  service.registerConsumer({ id: 'late', authorize: () => true, handle: () => { throw new Error('consumer failed'); } });
  await service.drain();
  assert.equal(service.deliverySnapshot().consumers.late.deliveries[accepted.eventId], 'outcome-unknown');
  await service.close();
  const broker = createCapabilityBroker({ stateDir: root });
  const sends = [];
  const authorized = createChannelService({ stateDir: path.join(root, 'authorized'), config, broker,
    connectorFactory: () => ({ start: async () => ({ ready: true, accountId: '10001' }),
      health: async () => ({ ready: true, accountId: '10001' }), stop: async () => ({ stopped: true }),
      send: async request => { sends.push(request);
        if (request.options.requestId.startsWith('throw-')) throw Object.assign(new Error('uncertain transport'), { code: request.options.requestId.slice(6) });
        return request.options.requestId === 'uncertain-qq' ? { status: 'outcome-unknown' } : { message_id: 1 }; } }) });
  await authorized.start();
  const request = { requestId: 'owner-text-1', approvalBinding: null, actor: { kind: 'owner', id: 'desktop' },
    input: { accountId: '10001', action: 'send_group_msg', kind: 'text', params: { group_id: 42, message: 'hello' } } };
  assert.equal((await authorized.send(request)).status, 'pending');
  assert.equal(sends.length, 0, 'missing approval cannot reach transport');
  await assert.rejects(authorized.send({ ...request, actor: { kind: 'external', id: 'qq:7' } }), { code: 'PERMISSION_DENIED' });
  for (const kind of ['file', 'audio', 'music', 'sticker', 'card']) {
    const media = { ...request, requestId: `media-${kind}`, input: { ...request.input, kind,
      action: kind === 'file' ? 'upload_group_file' : 'send_group_msg',
      params: kind === 'file' ? { group_id: 42, file: 'fixture' } : { group_id: 42,
        message: [{ type: { audio: 'record', music: 'music', sticker: 'image', card: 'json' }[kind], data: { file: 'fixture' } }] } } };
    if (kind === 'card') assert.equal((await authorized.send(media)).status, 'pending');
    else await assert.rejects(authorized.send(media), { code: 'QQ_MEDIA_PERMISSION_REQUIRED' });
  }
  const pending = await authorized.send(request);
  const approved = await broker.decide({ id: pending.approvalId, approve: true, actor: request.actor });
  assert.equal(approved.status, 'completed');
  assert.equal(sends.length, 1);
  await assert.rejects(authorized.send({ ...request, approved: true }), { code: 'REQUEST_ALREADY_DISPATCHED' });
  await assert.rejects(authorized.send({ ...request, requestId: 'uncertain-qq', approved: true }), { code: 'QQ_OUTCOME_UNKNOWN' });
  assert.equal(broker.dispatchStatus('uncertain-qq').status, 'outcome-unknown', 'Broker cannot label unknown QQ effects completed or failed');
  for (const code of ['QQ_OUTCOME_UNKNOWN', 'CHANNEL_PROCESS_CLOSED', 'CHANNEL_COMMAND_TIMEOUT']) {
    const requestId = `throw-${code}`;
    await assert.rejects(authorized.send({ ...request, requestId, approved: true }), { code });
    assert.equal(broker.dispatchStatus(requestId).status, 'outcome-unknown');
  }
  await authorized.close();
  let routed = 0;
  const facade = createBrokeredQqRuntime({ runtime: { status: () => ({ ready: true, accountId: '10001' }),
    client: {}, sendGroupMessage: () => { throw new Error('direct transport bypass'); } },
    resolveService: () => ({ execute: async () => ({ ready: true, accountId: '10001' }),
      send: async request => { routed++; assert.equal(request.actor.kind, 'extension'); return { status: 'pending', approvalId: 'fixture-approval' }; } }) });
  await assert.rejects(facade.sendGroupMessage(42, 'fixture', { requestId: 'legacy-1' }), { code: 'QQ_APPROVAL_REQUIRED' });
  assert.equal(routed, 1, 'Legacy compatibility sends must route through Core authorization');
  service = make();
  let repeated = 0;
  service.registerConsumer({ id: 'late', authorize: () => true, handle: () => { repeated++; } });
  await service.start();
  await service.drain();
  assert.equal(repeated, 0, 'restart cannot repeat an uncertain consumer effect');
  await assert.rejects(service.execute({ method: 'channel.delivery.resolve', actor: { kind: 'external', id: 'qq:7' },
    params: { consumerId: 'late', eventId: accepted.eventId, decision: 'verified-no-effect', evidence: 'Fixture confirmed no effect' } }), { code: 'PERMISSION_DENIED' });
  await service.execute({ method: 'channel.delivery.resolve', actor: { kind: 'owner', id: 'desktop' },
    params: { consumerId: 'late', eventId: accepted.eventId, decision: 'verified-no-effect', evidence: 'Fixture confirmed no effect' } });
  for (let i = 0; i < 50 && repeated < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(repeated, 2, 'only an Owner no-effect reconciliation may authorize replay');
  assert.equal((await receive(message)).duplicate, true, 'restart preserves ingress identity');
  await service.close();
  console.log('Channel delivery identity, durability and independent consumers verified');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
