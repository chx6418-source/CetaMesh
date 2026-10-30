import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelDesktopControls } from '../src/channel/desktop-controls.js';
import { createCetaMeshServices } from '../src/app/service-container.js';

const calls = [];
let qq = { ready: false, state: 'stopped', accountId: null };
let bionic = { running: false, ready: false, accountId: null };
let startUnavailable = true;
const channelService = { async execute(request) {
  calls.push(request);
  const { method } = request;
  if (method === 'channel.qq.start') {
    if (startUnavailable) throw Object.assign(new Error('Configuration unavailable'), { code: 'QQ_CONFIG_REQUIRED' });
    qq = { ready: false, state: 'running', accountId: null }; return qq;
  }
  if (method === 'channel.qq.stop') { qq = { ready: false, state: 'stopped', accountId: null }; return { stopped: true }; }
  if (method === 'channel.qq.reconnect') return { ready: false, state: 'running', accountId: null };
  if (method === 'channel.qq.health') return qq;
  if (method === 'channel.bionic.health') return bionic;
  if (method === 'channel.bionic.start') { bionic = { running: true, ready: true, accountId: '12345' }; return bionic; }
  if (method === 'channel.bionic.reconnect') { bionic = { running: true, ready: false, accountId: '12345' }; return bionic; }
  if (method === 'channel.bionic.stop') { bionic = { running: false, ready: false, accountId: null }; return { stopped: true }; }
  throw new Error('Unexpected method ' + method);
} };
const local = createChannelDesktopControls({ channelService, bionicService: {} });
assert.equal(calls.length, 0, 'constructing management actions never starts workers or probes runtime');
assert.deepEqual(Object.keys(local.actions.snowluma), ['health', 'start', 'stop', 'reconnect', 'detect']);
assert.deepEqual(Object.keys(local.actions.bionic), ['health', 'start', 'stop', 'reconnect']);
assert.equal(local().snowluma.installed, null);
assert.equal(local().snowluma.configured, null);
assert.equal(local().snowluma.running, false);
await assert.rejects(local.actions.snowluma.start({ actor: { kind: 'external' }, config: { bad: true } }), { code: 'QQ_CONFIG_REQUIRED' });
assert.equal(local().snowluma.ready, false);
assert.equal(local().snowluma.lastError.code, 'QQ_CONFIG_REQUIRED');
assert.equal(calls[0].actor.kind, 'owner');
assert.equal(calls[0].params, undefined, 'caller params cannot become arbitrary channel configuration');
startUnavailable = false;
const unauthenticated = await local.actions.snowluma.start();
assert.equal(unauthenticated.running, true);
assert.equal(unauthenticated.authenticated, false);
assert.equal(unauthenticated.ready, false);
assert.equal(unauthenticated.canSend, false);
await local.actions.snowluma.reconnect();
assert.equal(local().snowluma.authenticated, false);
assert.equal(local().snowluma.canSend, false);
qq = { ready: true, state: 'running', accountId: '12345', configured: true, installed: true, processId: 42 };
await local.refresh();
assert.equal(local().qq.authenticated, true);
assert.equal(local().qq.running, true);
assert.equal(local().qq.installed, true);
const copy = local(); copy.qq.running = false; assert.equal(local().qq.running, true);
const qqStarts = calls.filter(row => row.method === 'channel.qq.start').length;
await local.actions.bionic.start();
assert.equal(local().bionic.running, true);
assert.equal(calls.filter(row => row.method === 'channel.qq.start').length, qqStarts);
const reconnected = await local.actions.bionic.reconnect({ actor: { kind: 'external' }, config: { bad: true } });
assert.equal(reconnected.running, true);
assert.equal(reconnected.ready, false, 'reconnect cannot promote a running but unverified Bionic Agent to ready');
assert.equal(reconnected.authenticated, false);
const reconnectCall = calls.find(row => row.method === 'channel.bionic.reconnect');
assert.ok(reconnectCall, 'the Bionic reconnect action must reach the existing Channel lifecycle');
assert.deepEqual(reconnectCall.actor, { kind: 'owner', id: 'desktop' });
assert.equal(reconnectCall.params, undefined, 'reconnect cannot accept caller configuration or actor overrides');
assert.equal(calls.filter(row => row.method === 'channel.qq.start').length, qqStarts, 'Bionic reconnect does not launch another QQ connector');
await local.actions.bionic.stop(); assert.equal(local().bionic.running, false);
assert.equal(local().qq.running, true, 'Bionic stop does not stop QQ');
await local.actions.snowluma.stop(); assert.equal(local().qq.running, false);
assert.equal(Object.hasOwn(local.actions.snowluma, 'config'), false);
assert.ok(calls.every(row => row.actor.kind === 'owner'));
console.log('PASS COMM08 default desktop channel controls: discoverable narrow actions, truthful cached state, Owner binding, separate lifecycle, no autostart');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-default-controls-'));
const services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'), config: {} });
try {
  const plugin = await services.integrationService.execute({ method: 'integrations.get', params: { id: 'cetamesh-snowluma' } });
  assert.ok(plugin.actions.includes('start'), 'default composition exposes QQ start without external localServices injection');
  assert.ok(plugin.actions.includes('stop'));
  assert.ok(plugin.actions.includes('reconnect'));
  const status = await services.integrationService.execute({ method: 'integrations.action', params: { localService: 'snowluma', action: 'health', approved: true } });
  assert.equal(status.ready, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.canSend, false);
  assert.equal((await services.channelService.execute({ method: 'channel.qq.health' })).ready, false);
  assert.equal((await services.bionicService.health()).running, false);
  console.log('PASS COMM08 production default composition exposes management controls without starting QQ or Bionic');
} finally {
  await services.integrationService.close(); await services.meshService.close();
  await services.bionicService.close(); await services.channelService.close();
  fs.rmSync(root, { recursive: true, force: true });
}
