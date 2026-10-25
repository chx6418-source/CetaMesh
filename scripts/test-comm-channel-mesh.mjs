import { installMeshLoopbackFixture } from './helpers/mesh-loopback-fixture.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { createChannelProcessLink } from '../src/channel/qq/process-link.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMeshService } from '../src/mesh/service.js';
import { loadOrCreateIdentity, publicKeyPemToX963, signPayload, transcript, httpsPostPinned, createMeshEnvelope } from '../src/mesh/index.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function packet(bytes, id) {
  const row = { version: 1, type: 'request', id, method: 'echo', params: '' };
  row.params = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(row) + '\n'));
  return Buffer.from(JSON.stringify(row) + '\n');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-channel-mesh-'));
let service;
const restoreInterfaces = installMeshLoopbackFixture();
try {
  let enabled = true; let changed; let clock = Date.now();
  const settingsStore = { get: () => ({ settings: { devices: { meshEnabled: enabled } } }), onChange(fn) { changed = fn; return () => {}; } };
  const options = { stateDir: root, isEnabled: () => enabled, settingsStore, now: () => clock };
  service = createMeshService(options);
  await service.ready;
  assert.equal(service.node.status().transport.listening, false, 'fresh enabled instance stays closed');
  const session = await service.node.startPairingSession();
  const invitation = JSON.parse(session.invitation).payload;
  const identity = loadOrCreateIdentity({ stateDir: path.join(root, 'mobile'), name: 'Fixture Mobile', role: 'mobile' });
  const device = { deviceId: identity.nodeId, deviceName: 'Fixture Mobile', publicKey: publicKeyPemToX963(identity.publicKeyPem), keyAlgorithm: 'p256', platform: 'android', createdAt: new Date().toISOString() };
  const nonce = cryptoRandom();
  const post = (route, body) => httpsPostPinned({ url: session.endpoint + '/cetamesh/v1/' + route, tlsPin: session.tlsPin, body: JSON.stringify(body) });
  const envelope = (type, payload) => ({ protocol: 'cetamesh', version: 1, id: crypto.randomUUID(), timestamp: new Date().toISOString(), type, payload });
  assert.equal((await post('pairing/exchange', envelope('pairing.exchange', { invitationId: invitation.invitationId, token: invitation.token, device, nonce, signature: signPayload(identity.privateKeyPem, transcript(invitation, device, nonce, 'exchange')) }))).status, 200);
  assert.equal((await post('pairing/confirm', envelope('pairing.confirm', { invitationId: invitation.invitationId, deviceId: device.deviceId, nonce, signature: signPayload(identity.privateKeyPem, transcript(invitation, device, nonce, 'confirm')) }))).status, 200);
  const ping = async () => {
    const message = createMeshEnvelope({ type: 'mesh.presence.ping', from: device.deviceId, to: service.node.identity().nodeId, payload: {}, privateKeyPem: identity.privateKeyPem, nowMs: Date.now() });
    const result = await post('mesh/envelope', message);
    assert.equal(result.status, 200, result.body);
    assert.equal(JSON.parse(result.body).type, 'mesh.presence.pong');
  };
  await ping();
  await service.close();
  service = createMeshService(options); await service.ready;
  await ping();
  assert.equal(service.node.pairingStatus()?.active ?? false, false, 'restart does not issue an invitation');
  enabled = false; changed({ devices: { meshEnabled: false } }); await service.ready;
  assert.equal(service.node.status().transport.listening, false);
  enabled = true; changed({ devices: { meshEnabled: true } }); await service.ready;
  await ping();
  await service.node.startPairingSession(); service.node.cancelPairingSession(); await ping();
  await service.node.startPairingSession({ ttlMs: 60000 }); clock += 60001;
  assert.equal(service.node.pairingStatus().expired, true); await ping();
  clock = Date.now();
  enabled = false; changed({ devices: { meshEnabled: false } }); await service.ready;
  assert.equal(service.node.pairingStatus().active, false);
  await service.close(); service = createMeshService(options); await service.ready;
  assert.equal(service.node.status().transport.listening, false, 'disabled persisted paired node stays closed');
  enabled = true; changed({ devices: { meshEnabled: true } }); await service.ready; await ping();
  await service.close();
  const blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(session.port, '0.0.0.0', resolve); });
  try {
    service = createMeshService(options); await service.ready;
    assert.equal(service.node.status().transport.listening, false);
    assert.equal(service.node.status().transport.error.code, 'PAIRING_SERVER_FAILED');
    await assert.rejects(service.restoreTransport(), { code: 'PAIRING_SERVER_FAILED' });
  } finally { await service.close(); await new Promise(resolve => blocker.close(resolve)); }
  service = createMeshService(options); await service.ready; await ping();
  await service.close();
  await assert.rejects(service.restoreTransport(), { code: 'MESH_CLOSED' });
  await assert.rejects(service.node.restoreTransport(), { code: 'MESH_CLOSED' });
  await assert.rejects(service.execute({ method: 'mesh.pairing.start' }), { code: 'MESH_CLOSED' });
  await assert.rejects(service.execute({ method: 'mesh.pair' }), { code: 'MESH_CLOSED' });
  assert.throws(() => service.node.pair(), { code: 'MESH_CLOSED' });
  await assert.rejects(service.node.startPairingSession(), { code: 'MESH_CLOSED' });
  assert.equal(service.node.status().transport.listening, false);
  service = createMeshService(options);
  const earlyClose = service.close(); assert.equal(service.close(), earlyClose); await earlyClose; await service.ready;
  changed({ devices: { meshEnabled: true } }); await service.ready;
  assert.equal(service.node.status().transport.listening, false, 'closing before queued startup runs prevents future listening');
  await assert.rejects(service.restoreTransport(), { code: 'MESH_CLOSED' });
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(session.port, '0.0.0.0', resolve); });
  await new Promise(resolve => probe.close(resolve));
  console.log('PASS COMM09 terminal close rejects restore/pair while temporary disable supports reenable');
  console.log('PASS COMM09 loopback-fixture real TLS pairing, restart, disable, enable and invitation cancellation');
} finally {
  restoreInterfaces();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function cryptoRandom() { return crypto.randomBytes(32).toString('base64'); }
const joined = Buffer.concat([packet(1048384, 'a'), packet(1085, 'b')]);
for (const mode of ['64k', 'random', 'byte', 'coalesced']) {
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  const received = []; let closes = 0;
  const link = createChannelProcessLink({ input, output, onRequest: (_, params) => { received.push(params.length); return true; }, onClose: () => closes++ });
  let seed = 123;
  for (let at = 0; at < joined.length;) {
    seed = (seed * 16807) % 2147483647;
    const size = mode === '64k' ? 65536 : mode === 'random' ? 1 + seed % 90000 : mode === 'byte' ? 1 : joined.length;
    input.write(joined.subarray(at, at += size));
  }
  await turn();
  assert.equal(received.length, 2, mode + ' preserves valid frame boundaries');
  assert.equal(closes, 0); link.close();
  console.log('PASS COMM13 frame partition ' + mode);
}

function pipes(options = {}) {
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  let closes = 0; const rows = [];
  const link = createChannelProcessLink({ input, output, onRequest: (_, p) => { rows.push(p); return true; }, onClose: () => closes++, ...options });
  return { input, output, link, rows, get closes() { return closes; } };
}
{
  const pair = pipes();
  const row = Buffer.from(JSON.stringify({ version: 1, type: 'request', id: 'unicode', method: 'echo', params: '中文🐳' }) + '\n');
  for (const byte of row) pair.input.write(Buffer.from([byte]));
  await turn(); assert.deepEqual(pair.rows, ['中文🐳']); pair.link.close();
}
const invalidUtf8 = Buffer.concat([Buffer.from('{"version":1,"type":"request","id":"bad","method":"echo","params":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]);
for (const bytes of [invalidUtf8, Buffer.alloc(128, 120), Buffer.concat([Buffer.alloc(128, 120), Buffer.from('\n')])]) {
  const pair = pipes({ maxFrameBytes: 128 });
  const pending = pair.link.request('wait', {}).catch(error => error.code);
  pair.input.write(bytes); await turn();
  assert.equal(pair.closes, 1); assert.equal(await pending, 'CHANNEL_PROCESS_CLOSED');
  pair.link.close(); assert.equal(pair.closes, 1);
  await assert.rejects(pair.link.request('closed', {}), { code: 'CHANNEL_PROCESS_CLOSED' });
}
{
  const pair = pipes({ maxFrameBytes: 128 });
  pair.input.write(packet(128, 'edge')); await turn(); assert.equal(pair.rows.length, 1); pair.link.close();
}
{
  const pair = pipes();
  const pending = Array.from({ length: 256 }, () => pair.link.request('wait', {}).catch(error => error.code));
  await assert.rejects(pair.link.request('full', {}), { code: 'CHANNEL_QUEUE_FULL' });
  pair.input.emit('close'); pair.output.emit('error', new Error('closed')); pair.link.close();
  assert.equal(pair.closes, 1); assert.ok((await Promise.all(pending)).every(code => code === 'CHANNEL_PROCESS_CLOSED'));
}
{
  const pair = pipes({ onRequest: () => new Promise(() => {}) });
  pair.input.write(Buffer.concat(Array.from({ length: 257 }, (_, id) => packet(100, String(id)))));
  await turn(); assert.equal(pair.closes, 1);
}
{
  const input = new PassThrough();
  const output = { writableLength: 210, write() { throw new Error('should never write beyond budget'); }, once() {} };
  const link = createChannelProcessLink({ input, output, maxFrameBytes: 128, onRequest() {} });
  await assert.rejects(link.request('x', {}), { code: 'CHANNEL_FRAME_LIMIT' }); link.close();
}
{
  const pair = pipes(); const waiting = pair.link.request('wait', {}).catch(error => error.code);
  pair.input.end('{"version":1'); await turn(); assert.equal(pair.closes, 1); assert.equal(await waiting, 'CHANNEL_PROCESS_CLOSED');
}
console.log('PASS COMM13 UTF-8, frame edge/tail/oversize, active/pending/write capacity and single close settlement');
