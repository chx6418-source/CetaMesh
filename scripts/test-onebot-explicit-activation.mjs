import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { test } from 'node:test';
import { migrateLegacyConfig } from '../src/config/migrate.js';
import { createQqRuntime } from '../src/channel/qq/runtime.js';
import { createQqConnectorHost } from '../src/channel/qq/connector-host.js';
import { createChannelService } from '../src/channel/service.js';
import { createChannelDesktopControls } from '../src/channel/desktop-controls.js';
import { createBionicService } from '../src/bionic/service.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createIntegrationStore } from '../src/integrations/store.js';
import { enableOneBotFixture } from './fixtures/onebot-activation.mjs';

test('legacy gateway configuration cannot activate or construct a QQ transport', async () => {
  const raw = { snowluma: { wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: 'legacy-secret' } };
  const original = structuredClone(raw);
  const config = migrateLegacyConfig(raw);
  assert.deepEqual(config.onebot, { enabled: false, wsUrl: '', httpUrl: '', accessToken: '', httpAccessToken: '' });
  assert.deepEqual(raw, original, 'reading configuration preserves legacy fields byte values');
  let constructed = 0;
  assert.throws(() => createQqRuntime({ config, clientFactory: () => { constructed++; throw new Error('transport constructed'); } }), { code: 'QQ_DISABLED' });
  assert.equal(constructed, 0, 'disabled legacy credentials never reach a transport constructor');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-onebot-disabled-'));
  try {
    const host = createQqConnectorHost({ config, dataRoot: root, stateDir: path.join(root, 'state') });
    await assert.rejects(host.start(), { code: 'QQ_DISABLED' });
    assert.equal((await host.health()).processId, undefined, 'denied startup owns no child');
    let connectors = 0;
    const channel = createChannelService({ config, stateDir: path.join(root, 'state'), connectorFactory: () => { connectors++; throw new Error('connector constructed'); } });
    await assert.rejects(channel.execute({ method: 'channel.qq.start', actor: { kind: 'external', id: 'qq:7' } }), { code: 'PERMISSION_DENIED' });
    await assert.rejects(channel.execute({ method: 'channel.bionic.check', actor: { kind: 'external', id: 'qq:7' } }), { code: 'PERMISSION_DENIED' });
    await assert.rejects(channel.start(), { code: 'QQ_DISABLED' });
    assert.equal(connectors, 0);
    assert.equal((await channel.execute({ method: 'channel.qq.health' })).configured, false);
    await channel.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stopped channel health and Desktop refresh perform no DSH network requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-onebot-health-'));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected network request'); };
  const config = migrateLegacyConfig({});
  const channel = createChannelService({ config, stateDir: path.join(root, 'state') });
  const bionic = createBionicService({ config, dataRoot: root, stateDir: path.join(root, 'state'), channelService: channel });
  channel.attachBionic(bionic);
  try {
    const controls = createChannelDesktopControls({ channelService: channel, bionicService: bionic });
    await controls.refresh();
    assert.equal(requests, 0, 'default status projection cannot probe third-party services');
    assert.deepEqual(Object.keys(controls()).sort(), ['bionic', 'onebot', 'qq']);
    assert.deepEqual(Object.keys(controls.actions).sort(), ['bionic', 'onebot', 'qq']);
    assert.equal((await bionic.health()).ready, false);
  } finally {
    await channel.close();
    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saved valid endpoints remain configured while activation stays disabled', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-onebot-configured-disabled-'));
  const config={onebot:{enabled:false,wsUrl:'ws://127.0.0.1:19001',httpUrl:'http://127.0.0.1:19000'}};
  let constructed=0;
  const channel=createChannelService({config,stateDir:path.join(root,'state'),connectorFactory:()=>{constructed++;throw Error('must remain disabled');}});
  try{
    const health=await channel.execute({method:'channel.qq.health'});
    assert.equal(health.configured,true,'configuration presence is independent of activation authority');
    assert.equal(health.connected,false);assert.equal(health.authenticated,false);assert.equal(health.canSend,false);
    await assert.rejects(channel.start(),{code:'QQ_DISABLED'});assert.equal(constructed,0);assert.equal(config.onebot.enabled,false);
  }finally{await channel.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('explicit OneBot activation rejects missing endpoints before transport construction', () => {
  for (const onebot of [{ enabled: true }, { enabled: true, wsUrl: '' }, { enabled: true, wsUrl: 'http://127.0.0.1:1' },
    { enabled: true, wsUrl: 'ws://user:password@127.0.0.1:1' }, { enabled: true, wsUrl: 'ws://127.0.0.1:1?token=not-a-credential-channel' },
    { enabled: true, wsUrl: ' ws://127.0.0.1:1' }]) {
    let constructed = false;
    assert.throws(() => createQqRuntime({ config: { onebot }, clientFactory: () => { constructed = true; throw new Error('transport constructed'); } }), { code: 'QQ_CONFIG_REQUIRED' });
    assert.equal(constructed, false);
  }
});

test('HTTP sends cannot invent a gateway endpoint or record an effect before configuration is valid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-onebot-http-required-'));
  const runtime = createQqRuntime({ config: { onebot: { enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: 'websocket-only' } },
    outboundFile: path.join(root, 'outbound.json') });
  try {
    await assert.rejects(runtime.sendOneBot('send_group_msg', { group_id: 42, message: [] }, { requestId: 'no-http-endpoint' }), { code: 'QQ_HTTP_CONFIG_REQUIRED' });
    assert.equal(fs.existsSync(path.join(root, 'outbound.json')), false, 'configuration rejection occurs before uncertain-effect accounting');
  } finally { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('only explicit neutral configuration and a new Owner switch can connect and send through the existing Broker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-onebot-authority-'));
  const stateDir = path.join(root, 'state');
  const requests = [];
  let sends = 0;
  const gateway = http.createServer(async (req, res) => {
    for await (const part of req) { void part; }
    assert.equal(req.headers.authorization, 'Bearer fixture-http');
    if (req.url === '/send_group_msg') sends++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? { user_id: 10001 } : { message_id: 70 + sends } }));
  });
  const sockets = new WebSocketServer({ server: gateway });
  sockets.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-ws');
    socket.on('message', bytes => {
      const frame = JSON.parse(String(bytes)); requests.push(frame);
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: { user_id: 10001 } }));
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const port = gateway.address().port;
  const config = migrateLegacyConfig({ snowluma: { wsUrl: `ws://127.0.0.1:${port}`, accessToken: 'old-secret' }, allow: { groups: ['42'], private: [] } });
  createIntegrationStore({ stateDir }).update(value => ({ ...value, plugins: { 'cetamesh-snowluma': { enabled: true } } }));
  const broker = createCapabilityBroker({ stateDir });
  const service = createChannelService({ config, stateDir, dataRoot: root, broker,
    connectorFactory: callbacks => createQqConnectorHost({ config, stateDir, dataRoot: root, ...callbacks }) });
  try {
    await assert.rejects(service.start(), { code: 'QQ_DISABLED' });
    assert.equal(sockets.clients.size, 0, 'legacy switch and endpoint grant no new channel authority');
    config.onebot = { enabled: true, wsUrl: `ws://127.0.0.1:${port}`, httpUrl: `http://127.0.0.1:${port}`, accessToken: 'fixture-ws', httpAccessToken: 'fixture-http' };
    await assert.rejects(service.start(), { code: 'QQ_DISABLED' });
    assert.equal(sockets.clients.size, 0, 'configuration alone cannot inherit the retired plugin grant');
    enableOneBotFixture(stateDir, { bionic: true });
    await Promise.all([service.start(), service.start()]);
    assert.equal(sockets.clients.size, 1, 'explicit concurrent starts retain the sole Connector');
    const actor = { kind: 'owner', id: 'desktop' };
    const request = { actor, requestId: 'neutral-approved-send', approvalBinding: null, input: { accountId: '10001', kind: 'text', action: 'send_group_msg', params: { group_id: 42, message: [{ type: 'text', data: { text: 'authorized local fixture' } }] } } };
    const pending = await service.send(request);
    assert.equal(pending.status, 'pending'); assert.equal(sends, 0);
    assert.equal((await broker.decide({ id: pending.approvalId, approve: true, actor })).status, 'completed');
    assert.equal(sends, 1);
    assert.equal(service.sendReceipt(request.requestId, '10001').status, 'sent');
    await assert.rejects(service.send({ ...request, approved: true }), { code: 'REQUEST_ALREADY_DISPATCHED' });
    assert.equal(sends, 1, 'retained broker identity prevents a second effect');
    assert.ok(requests.some(frame => frame.action === 'get_login_info'));
  } finally {
    await service.close();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => gateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
