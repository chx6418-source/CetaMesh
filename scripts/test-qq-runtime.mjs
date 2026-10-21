import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createQqRuntime } from '../src/channel/qq/runtime.js';
import { acquireQqOwnership } from '../src/channel/qq/ownership.js';
import { createQqTransport } from '../src/channel/qq/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createIntegrationService } from '../src/integrations/service.js';
import { assertQqDataToolEnabled, qqSocialFlagPolicyEnabled, qqToolPolicyEnabled } from '../src/channel/qq/tool-policy.js';
import { assertMcpToolEnabled } from '../src/integrations/tool-policy.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { dataCall, resolveDataPipeName } from '../src/control/data-ipc.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
import { pathToFileURL } from 'node:url';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.privateHandlers = [];
    this.groupHandlers = [];
    this.noticeHandlers = [];
    this.connectCalls = 0;
    this.sent = [];
    this.connection = null;
  }
  onPrivateMessage(handler) { this.privateHandlers.push(handler); }
  onGroupMessage(handler) { this.groupHandlers.push(handler); }
  onNotice(name, handler) { this.noticeHandlers.push({ name, handler }); }
  connect() {
    this.connectCalls += 1;
    return new Promise(resolve => { this.connection = resolve; });
  }
  sendPrivateMessage(id, payload) { this.sent.push(['private', id, payload]); }
  sendGroupMessage(id, payload) { this.sent.push(['group', id, payload]); }
  async getLoginInfo() { return { user_id: this.accountId ?? 10001, nickname: 'fixture' }; }
  close() { this.emit('close', { code: 1000 }); }
}

const client = new FakeClient();
let factoryOptions;
const incoming = [];
const notices = [];
const runtime = createQqRuntime({
  config: { snowluma: { wsUrl: 'ws://127.0.0.1:6700', accessToken: 'token' } },
  clientFactory: options => { factoryOptions = options; return client; },
  onPrivateMessage: event => incoming.push(['private', event]),
  onGroupMessage: event => incoming.push(['group', event]),
  onNotice: event => notices.push(event),
  onOpen: () => notices.push('open'),
  onClose: () => notices.push('close'),
  log: () => {}
});
assert.equal(factoryOptions.url, 'ws://127.0.0.1:6700');
assert.equal(runtime.status().state, 'unknown');
const firstConnect = runtime.connect();
const secondConnect = await runtime.connect();
assert.equal(secondConnect.pending, true, 'concurrent connect is single-flight');
assert.equal(client.connectCalls, 1);
client.emit('open');
await Promise.resolve();
assert.equal(runtime.status().state, 'unknown', 'socket open alone cannot establish verified account readiness');
client.connection();
assert.equal((await firstConnect).connected, true);
assert.equal(runtime.status().state, 'ready');
let releaseFirstSend;
const executedSends = [];
const queuedClient = new FakeClient();
queuedClient.connect = async () => { queuedClient.emit('open'); };
const sendingRuntime = createQqRuntime({
  config: { snowluma: { wsUrl: 'ws://127.0.0.1:6709' } },
  clientFactory: () => queuedClient,
  postAction: async action => {
    executedSends.push(action);
    if (action === 'send_group_msg') await new Promise(resolve => { releaseFirstSend = resolve; });
    return { message_id: executedSends.length };
  }
});
await sendingRuntime.connect();
const sendOne = sendingRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] });
await Promise.resolve();
const sendTwo = sendingRuntime.sendOneBot('upload_group_file', { group_id: 42, file: 'fixture' });
for (let i = 0; i < 10 && executedSends.length === 0; i += 1) await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(executedSends, ['send_group_msg'], 'QQ owner must serialize distinct send actions');
releaseFirstSend();
await Promise.all([sendOne, sendTwo]);
assert.deepEqual(executedSends, ['send_group_msg', 'upload_group_file']);
await assert.rejects(sendingRuntime.sendOneBot('delete_msg', { message_id: 1 }), { code: 'QQ_ACTION_UNSUPPORTED' });
assert.deepEqual(executedSends, ['send_group_msg', 'upload_group_file'], 'unsupported action never reaches OneBot');
await sendingRuntime.stop();
const sendLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-runtime-outbound-'));
try {
  const ledgerFile = path.join(sendLedgerRoot, 'outbound.json');
  const dispatched = [];
  const makeLedgerRuntime = postAction => {
    const fixtureClient = new FakeClient();
    fixtureClient.connect = async () => { fixtureClient.emit('open'); };
    return createQqRuntime({ config: { snowluma: { wsUrl: 'ws://127.0.0.1:6711' } },
      clientFactory: () => fixtureClient, outboundFile: ledgerFile, postAction });
  };
  const firstLedgerRuntime = makeLedgerRuntime(async action => {
    dispatched.push(action);
    if (dispatched.length === 2) throw new Error('timeout after possible send');
    return { message_id: dispatched.length };
  });
  await firstLedgerRuntime.connect();
  const first = await firstLedgerRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }, { requestId: 'turn-1:0' });
  assert.equal(first.message_id, 1);
  const repeated = await firstLedgerRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }, { requestId: 'turn-1:0' });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.status, 'sent');
  await assert.rejects(firstLedgerRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }, { requestId: 'turn-2:0' }),
    { code: 'QQ_OUTCOME_UNKNOWN', requestId: 'turn-2:0' });
  assert.deepEqual(dispatched, ['send_group_msg', 'send_group_msg']);
  await firstLedgerRuntime.stop();
  const restartedLedgerRuntime = makeLedgerRuntime(async action => { dispatched.push(action); return { message_id: 3 }; });
  await restartedLedgerRuntime.connect();
  const unknown = await restartedLedgerRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }, { requestId: 'turn-2:0' });
  assert.equal(unknown.status, 'outcome-unknown', 'restart must not repeat an uncertain side effect');
  assert.equal(dispatched.length, 2);
  await restartedLedgerRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }, { requestId: 'turn-3:0' });
  assert.equal(dispatched.length, 3, 'distinct requestId is not deduplicated by content');
  await restartedLedgerRuntime.stop();
  assert.equal(restartedLedgerRuntime.sendReceipt('turn-2:0', '10001')?.status, 'outcome-unknown',
    'offline receipt inspection must preserve the unknown outcome after connector stop');
  const deniedClient = new FakeClient();
  deniedClient.connect = async () => { deniedClient.emit('open'); };
  const deniedRuntime = createQqRuntime({ config: { snowluma: { wsUrl: 'ws://127.0.0.1:6712' } },
    clientFactory: () => deniedClient, outboundFile: path.join(sendLedgerRoot, 'denied.json'),
    authorizeSend: ({ target, kind }) => {
      if (target !== 'group:42' || kind !== 'text') throw Object.assign(new Error('QQ target or media denied'), { code: 'QQ_SEND_DENIED' });
    }, postAction: async action => { dispatched.push(action); return { message_id: 4 }; } });
  await deniedRuntime.connect();
  await assert.rejects(deniedRuntime.sendOneBot('send_group_msg', { group_id: 43, message: [] }, { requestId: 'deny-target' }), { code: 'QQ_SEND_DENIED' });
  await assert.rejects(deniedRuntime.sendOneBot('send_group_msg', { group_id: 43, message: [] },
    { requestId: 'spoof-target', target: 'group:42', accountId: '99999' }), { code: 'QQ_SEND_DENIED' },
  'caller options cannot overwrite the actual dispatch account or target');
  await assert.rejects(deniedRuntime.sendOneBot('send_private_msg', { group_id: 42, user_id: 999, message: 'fixture' },
    { requestId: 'conflicting-recipient' }), { code: 'QQ_TARGET_INVALID' },
  'OneBot action cannot hide an unallowlisted private recipient behind an allowed group');
  await assert.rejects(deniedRuntime.sendOneBot('send_group_msg', { group_id: 42,
    message: [{ type: 'record', data: { file: 'fixture' } }] }, { requestId: 'deny-audio' }), { code: 'QQ_SEND_DENIED' });
  await assert.rejects(deniedRuntime.sendOneBot('send_group_msg', { group_id: 42,
    message: [{ type: 'ark', data: { content: 'fixture' } }] }, { requestId: 'deny-ark' }), { code: 'QQ_SEND_DENIED' },
  'typed cards cannot be misclassified as plain text');
  await assert.rejects(deniedRuntime.sendOneBot('send_group_msg', { group_id: 42,
    message: [{ type: 'record', data: { file: 'fixture' } }] }, { requestId: 'lie-audio', kind: 'text' }),
  { code: 'QQ_MEDIA_KIND_MISMATCH' }, 'a caller cannot label an audio payload as text to bypass media permission');
  assert.equal(dispatched.length, 3, 'denial must precede gateway IO');
  assert.equal(fs.existsSync(path.join(sendLedgerRoot, 'denied.json')), false, 'denied send must not create an attempted-send record');
  await deniedRuntime.stop();
  const sdkClient = new FakeClient();
  sdkClient.connect = async () => { sdkClient.emit('open'); };
  const sdkRuntime = createQqRuntime({ config: { snowluma: { wsUrl: 'ws://127.0.0.1:6713' } },
    clientFactory: () => sdkClient, outboundFile: path.join(sendLedgerRoot, 'sdk.json') });
  await sdkRuntime.connect();
  sdkClient.raw = async () => null;
  sdkClient.request = async () => ({ status: 'ok', retcode: 0, data: null });
  assert.deepEqual(await sdkRuntime.rawWrite('group_poke', { group_id: 42, user_id: 7 }, { requestId: 'sdk-poke:1' }),
    { status: 'ok', retcode: 0, data: null }, 'non-message writes require the verified gateway envelope');
  assert.equal(sdkRuntime.sendReceipt('sdk-poke:1')?.status, 'acknowledged');
  const sdkUnknown = await sdkRuntime.sendGroupMessage(42, { type: 'text', data: { text: 'hello' } }, { requestId: 'sdk-turn:1' });
  assert.equal(sdkUnknown.status, 'outcome-unknown', 'SDK without a gateway receipt must not be reported as sent');
  const sdkReplay = await sdkRuntime.sendGroupMessage(42, { type: 'text', data: { text: 'hello' } }, { requestId: 'sdk-turn:1' });
  assert.equal(sdkReplay.status, 'outcome-unknown');
  assert.equal(sdkClient.sent.length, 1, 'same logical SDK request must not reach the gateway twice');
  sdkClient.accountId = 10002;
  await assert.rejects(sdkRuntime.sendGroupMessage(42, { type: 'text', data: { text: 'later' } }, { requestId: 'sdk-turn:2' }),
    { code: 'QQ_ACCOUNT_CHANGED' }, 'a silent SDK account switch must be rejected before sending');
  assert.equal(sdkClient.sent.length, 1);
  assert.equal(sdkRuntime.health().ready, false, 'health must not remain ready after the account identity changes');
  await sdkRuntime.stop();
  const bridgeSource = fs.readFileSync(path.resolve(import.meta.dirname, '../src/bridge.js'), 'utf8');
  assert.match(bridgeSource, /outboundFile:\s*path\.join\(STATE_DIR, 'qq-send-ledger\.json'\)/,
    'Legacy product host must configure a persistent QQ send ledger');
  assert.match(bridgeSource, /authorizeSend:\s*\(/,
    'Legacy product host must give the Runtime a final authorization hook');
} finally {
  fs.rmSync(sendLedgerRoot, { recursive: true, force: true });
}
let postedAction = null;
let httpAccountId = 10001;
let httpSendCount = 0;
const writeGateway = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  if (req.url === '/get_login_info') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: httpAccountId } }));
    return;
  }
  httpSendCount += 1;
  postedAction = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 73 } }));
});
await new Promise(resolve => writeGateway.listen(0, '127.0.0.1', resolve));
try {
  const httpClient = new FakeClient();
  httpClient.connect = async () => { httpClient.emit('open'); };
  const httpRuntime = createQqRuntime({
    config: { snowluma: { wsUrl: 'ws://127.0.0.1:6710',
      httpUrl: `http://127.0.0.1:${writeGateway.address().port}`, accessToken: 'fixture-token' } },
    clientFactory: () => httpClient
  });
  await httpRuntime.connect();
  assert.deepEqual(await httpRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }), { message_id: 73 });
  assert.deepEqual(postedAction, { path: '/send_group_msg', authorization: 'Bearer fixture-token',
    body: { group_id: 42, message: [] } });
  httpAccountId = 10002;
  await assert.rejects(httpRuntime.sendOneBot('send_group_msg', { group_id: 42, message: [] }),
    { code: 'QQ_ACCOUNT_CHANGED' });
  assert.equal(httpSendCount, 1, 'HTTP gateway account mismatch must be caught before the send action');
  await httpRuntime.stop();
} finally {
  await new Promise(resolve => writeGateway.close(resolve));
}
await client.privateHandlers[0]({ user_id: 4 });
await client.groupHandlers[0]({ group_id: 5 });
await client.noticeHandlers[0].handler({ user_id: 8 });
assert.equal(incoming.length, 2);
assert.equal(notices[0], 'open');
assert.equal(notices[1].user_id, 8);
client.emit('close', { code: 1006 });
assert.equal(runtime.status().state, 'unavailable');
assert.equal(notices.at(-1), 'close');

// M4: an account must have one consumer and repeated gateway events must not
// produce a second side effect, including after a reconnect or process restart.
const ownershipRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-ownership-'));
try {
  const lockChild = spawn(process.execPath, ['--input-type=module', '-e',
    "const { acquireQqOwnership } = await import(process.env.QQ_LOCK_MODULE); acquireQqOwnership('account', '90001', process.env.QQ_LOCK_DIR); process.stdout.write('READY\\n'); process.stdin.resume();"],
  { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
    env: { ...process.env, QQ_LOCK_MODULE: pathToFileURL(path.resolve(import.meta.dirname, '../src/channel/qq/ownership.js')).href,
      QQ_LOCK_DIR: ownershipRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [readyChunk] = await once(lockChild.stdout, 'data');
    assert.match(String(readyChunk), /READY/);
    assert.throws(() => acquireQqOwnership('account', '90001', ownershipRoot), { code: 'QQ_ACCOUNT_BUSY' },
      'another process must not become a second sender or consumer');
  } finally {
    const closed = once(lockChild, 'close');
    lockChild.kill();
    await closed;
  }
  const recovered = acquireQqOwnership('account', '90001', ownershipRoot);
  assert.ok(recovered, 'verified dead PID may be safely recovered without a second live consumer');
  assert.throws(() => acquireQqOwnership('account', '90001', ownershipRoot), { code: 'QQ_ACCOUNT_BUSY' },
    'recovered account lease must immediately exclude another live sender');
  recovered.release();
  const unknownLock = acquireQqOwnership('account', '90002', ownershipRoot);
  const unknownPath = fs.readdirSync(ownershipRoot).find(name => name.startsWith('account-') && name.endsWith('.lock'));
  fs.writeFileSync(path.join(ownershipRoot, unknownPath), 'unverified-owner', 'utf8');
  assert.throws(() => acquireQqOwnership('account', '90002', ownershipRoot), { code: 'QQ_ACCOUNT_BUSY' },
    'unparseable lock evidence must fail closed');
  fs.rmSync(path.join(ownershipRoot, unknownPath));
  unknownLock.release();
  const processed = [];
  const makeRuntime = (accountId, wsUrl = 'ws://127.0.0.1:6700') => {
    const fixtureClient = new FakeClient();
    fixtureClient.accountId = accountId;
    fixtureClient.connect = async () => { fixtureClient.connectCalls += 1; fixtureClient.emit('open'); };
    return {
      fixtureClient,
      runtime: createQqRuntime({
        config: { snowluma: { wsUrl } },
        clientFactory: () => fixtureClient,
        ownershipDir: ownershipRoot,
        dedupFile: path.join(ownershipRoot, `dedup-${accountId}.json`),
        onGroupMessage: event => processed.push(event.message_id)
      })
    };
  };
  const first = makeRuntime(10001);
  assert.equal((await first.runtime.connect()).connected, true);
  const competing = makeRuntime(10001);
  const blocked = await competing.runtime.connect();
  assert.equal(blocked.ok, false, 'second QQ consumer must be refused');
  assert.equal(blocked.code, 'QQ_ACCOUNT_BUSY');
  assert.equal(competing.fixtureClient.connectCalls, 0, 'do not even open a second socket to the same gateway');
  const alternateGateway = makeRuntime(10001, 'ws://127.0.0.1:6701');
  const accountBlocked = await alternateGateway.runtime.connect();
  assert.equal(accountBlocked.code, 'QQ_ACCOUNT_BUSY', 'same QQ account on another gateway is still exclusive');
  await alternateGateway.runtime.stop();
  const packet = { self_id: 10001, group_id: 3, user_id: 7, message_id: 99 };
  await first.fixtureClient.groupHandlers[0](packet);
  await first.fixtureClient.groupHandlers[0](packet);
  assert.deepEqual(processed, [99], 'one message ID causes one handler call');
  const failedFile = path.join(ownershipRoot, 'failed-delivery.json');
  const failedClient = new FakeClient();
  failedClient.connect = async () => { failedClient.emit('open'); };
  let deliveryAttempts = 0;
  const failedRuntime = createQqRuntime({
    config: { snowluma: { wsUrl: 'ws://127.0.0.1:6799' } },
    clientFactory: () => failedClient,
    dedupFile: failedFile,
    onGroupMessage: async () => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error('downstream persistence failed');
    },
    log: () => {}
  });
  assert.equal((await failedRuntime.connect()).connected, true);
  await failedClient.groupHandlers[0]({ ...packet, message_id: 100 });
  await failedClient.groupHandlers[0]({ ...packet, message_id: 100 });
  assert.equal(deliveryAttempts, 1, 'uncertain downstream side effects must not be replayed blindly');
  const failedReceipt = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
  assert.equal(failedReceipt.ids.includes('10001:group:3:100'), false,
    'failed delivery must not be marked as confirmed');
  assert.equal(failedReceipt.pending.includes('10001:group:3:100'), true,
    'failed delivery must retain durable reconciliation evidence');
  await failedRuntime.stop();
  const recoveryClient = new FakeClient();
  recoveryClient.connect = async () => { recoveryClient.emit('open'); };
  const recoveryRuntime = createQqRuntime({
    config: { snowluma: { wsUrl: 'ws://127.0.0.1:6799' } },
    clientFactory: () => recoveryClient,
    dedupFile: failedFile,
    onGroupMessage: () => { deliveryAttempts += 1; },
    log: () => {}
  });
  assert.equal((await recoveryRuntime.connect()).connected, true);
  assert.deepEqual(recoveryRuntime.unresolvedInbound(), ['10001:group:3:100'],
    'restart must expose the unresolved message for Owner reconciliation');
  await recoveryClient.groupHandlers[0]({ ...packet, message_id: 100 });
  assert.equal(deliveryAttempts, 1, 'restart must not repeat an uncertain downstream side effect');
  await recoveryRuntime.stop();
  await first.fixtureClient.groupHandlers[0]({ ...packet, message_id: undefined });
  assert.deepEqual(processed, [99], 'missing external identity must not trigger a reply');
  first.fixtureClient.emit('close', { code: 1006 });
  first.fixtureClient.accountId = 10002;
  const changed = await first.runtime.reconnect();
  assert.equal(changed.ok, false, 'reconnect must not silently switch the QQ account');
  assert.equal(changed.code, 'QQ_ACCOUNT_CHANGED');
  assert.equal(first.runtime.status().ready, false);
  first.fixtureClient.accountId = 10001;
  assert.equal((await first.runtime.reconnect()).connected, true);
  await first.fixtureClient.groupHandlers[0](packet);
  assert.deepEqual(processed, [99], 'reconnect must not replay a handled message');
  await first.runtime.stop();
  let finishInFlight;
  let enteredInFlight;
  const inFlightEntered = new Promise(resolve => { enteredInFlight = resolve; });
  const inFlightClient = new FakeClient();
  inFlightClient.connect = async () => { inFlightClient.emit('open'); };
  const inFlight = createQqRuntime({ config: { snowluma: { wsUrl: 'ws://127.0.0.1:6700' } },
    clientFactory: () => inFlightClient, ownershipDir: ownershipRoot,
    postAction: async () => {
      enteredInFlight();
      await new Promise(resolve => { finishInFlight = resolve; });
      return { message_id: 100 };
    } });
  assert.equal((await inFlight.connect()).connected, true);
  const pendingSend = inFlight.sendOneBot('send_group_msg', { group_id: 3, message: [] });
  await inFlightEntered;
  const stopping = inFlight.stop();
  const duringStop = makeRuntime(10001);
  const deniedDuringStop = await duringStop.runtime.connect();
  assert.equal(deniedDuringStop.code, 'QQ_ACCOUNT_BUSY', 'in-flight send retains the account lease until it resolves');
  finishInFlight();
  await pendingSend;
  await stopping;
  const restarted = makeRuntime(10001);
  assert.equal((await restarted.runtime.connect()).connected, true);
  await restarted.fixtureClient.groupHandlers[0](packet);
  assert.deepEqual(processed, [99], 'durable receipt prevents a restart duplicate');
  await restarted.runtime.stop();
  const lostLeaseClient = new FakeClient();
  lostLeaseClient.connect = async () => { lostLeaseClient.emit('open'); };
  const lostLeaseRoot = path.join(ownershipRoot, 'lost-lease');
  let lostLeaseSends = 0;
  const lostLeaseRuntime = createQqRuntime({ config: { snowluma: { wsUrl: 'ws://127.0.0.1:6798' } },
    ownershipDir: lostLeaseRoot, clientFactory: () => lostLeaseClient,
    postAction: async () => { lostLeaseSends++; return { message_id: 1 }; } });
  assert.equal((await lostLeaseRuntime.connect()).connected, true);
  const accountLock = fs.readdirSync(lostLeaseRoot).find(name => name.startsWith('account-') && name.endsWith('.lock'));
  fs.unlinkSync(path.join(lostLeaseRoot, accountLock));
  await assert.rejects(lostLeaseRuntime.sendOneBot('send_group_msg', { group_id: 42, message: 'fixture' }), { code: 'QQ_LEASE_EXPIRED' });
  assert.equal(lostLeaseSends, 0, 'expired lease must deny actual transport');
  await lostLeaseRuntime.stop();
  const corruptFile = path.join(ownershipRoot, 'corrupt-receipts.json');
  fs.writeFileSync(corruptFile, '{broken', 'utf8');
  const corruptClient = new FakeClient();
  corruptClient.connect = async () => { corruptClient.emit('open'); };
  const corruptRuntime = createQqRuntime({
    config: { snowluma: { wsUrl: 'ws://127.0.0.1:6702' } },
    clientFactory: () => corruptClient,
    ownershipDir: ownershipRoot,
    dedupFile: corruptFile,
    onGroupMessage: event => processed.push(event.message_id)
  });
  const corruptResult = await corruptRuntime.connect();
  assert.equal(corruptResult.ok, false, 'damaged receipts must keep QQ unavailable');
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{broken', 'damaged evidence must not be overwritten');
  await corruptRuntime.stop();
} finally {
  fs.rmSync(ownershipRoot, { recursive: true, force: true });
}

const transport = createQqTransport({
  client,
  textSegment: value => ({ type: 'text', data: { text: value } })
});
await transport.send('private', '42', 'hello');
await transport.send('group', '43', 'hi');
assert.deepEqual(client.sent, [
  ['private', 42, { type: 'text', data: { text: 'hello' } }],
  ['group', 43, { type: 'text', data: { text: 'hi' } }]
]);
const deniedTransport = createQqTransport({ client, authorize: () => { throw Object.assign(new Error('disabled'), { code: 'QQ_DISABLED' }); } });
assert.throws(() => deniedTransport.send('group', '43', 'must not send'), { code: 'QQ_DISABLED' });
assert.equal(client.sent.length, 2, 'transport denial must precede the external send');

const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-policy-mcp-'));
const policyOptions = { stateDir: path.join(mcpRoot, 'state') };
const integration = createIntegrationService(policyOptions);
const clientTransport = new StdioClientTransport({ command: process.execPath,
  args: [path.resolve(import.meta.dirname, '../src/mcp-snowluma-safe.js')],
  env: { ...process.env, WHALEBRIDGE_DATA_DIR: mcpRoot }, stderr: 'pipe' });
const mcpClient = new Client({ name: 'qq-policy-fixture', version: '1.0.0' });
try {
  await mcpClient.connect(clientTransport);
  await integration.execute({ method: 'plugins.tool.toggle', params: {
    pluginId: 'cetamesh-bionic-chat', toolId: 'mcp__qq-file-send__qq_send_file', enabled: true
  } });
  await integration.execute({ method: 'plugins.disable', params: { id: 'cetamesh-snowluma' } });
  assert.throws(() => assertMcpToolEnabled('qq-file-send', 'qq_send_file', policyOptions), { code: 'QQ_DISABLED' });
  const disabledQq = await mcpClient.callTool({ name: 'qq_status', arguments: {} });
  assert.equal(disabledQq.isError, true);
  assert.match(disabledQq.content[0].text, /QQ_DISABLED/, 'QQ parent switch must deny MCP execution');
  await integration.execute({ method: 'plugins.enable', params: { id: 'cetamesh-snowluma' } });
  await integration.execute({ method: 'plugins.tool.toggle', params: {
    pluginId: 'cetamesh-bionic-chat', toolId: 'mcp__snowluma__qq_status', enabled: false
  } });
  const disabled = await mcpClient.callTool({ name: 'qq_status', arguments: {} });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /TOOL_DISABLED/, 'MCP callback must enforce a hot persisted plugin tool switch before network IO');
  await integration.execute({ method: 'plugins.tool.toggle', params: {
    pluginId: 'cetamesh-bionic-chat', toolId: 'mcp__snowluma__qq_get_card_msg', enabled: false
  } });
  assert.equal(qqSocialFlagPolicyEnabled('getCardMsg', policyOptions), false, 'Bridge prompt and cfg flag must reflect the same tool switch');
  assert.throws(() => assertQqDataToolEnabled('/api/socialV2/card-message', policyOptions), { code: 'TOOL_DISABLED' });
  assert.equal(qqToolPolicyEnabled('qq_click_card_button', policyOptions), false, 'registry cannot override default-off card policy');
  await integration.execute({ method: 'plugins.tool.toggle', params: {
    pluginId: 'cetamesh-bionic-chat', toolId: 'mcp__snowluma__qq_get_card_msg', enabled: true
  } });
  assert.equal(qqSocialFlagPolicyEnabled('getCardMsg', policyOptions), true, 'enable takes effect without restarting the MCP process');
  assert.doesNotThrow(() => assertQqDataToolEnabled('/api/socialV2/card-message', policyOptions), 'policy does not require a Core-managed MCP process');
  await integration.execute({ method: 'plugins.disable', params: { id: 'cetamesh-bionic-chat' } });
  const parentDisabled = await mcpClient.callTool({ name: 'qq_get_recent_messages', arguments: { key: 'group:1', token: 'fixture' } });
  assert.equal(parentDisabled.isError, true);
  assert.match(parentDisabled.content[0].text, /TOOL_DISABLED/);
  assert.equal(qqSocialFlagPolicyEnabled('getRecent', policyOptions), false);
  assert.throws(() => assertQqDataToolEnabled('/api/socialV2/recent', policyOptions), { code: 'TOOL_DISABLED' });
} finally {
  await mcpClient.close();
  await integration.close();
  fs.rmSync(mcpRoot, { recursive: true, force: true });
}

console.log('PASS QQ runtime connection lifecycle, transport, and persisted MCP tool policy');

// Pure Core must refuse QQ data calls; the Legacy connector retains the QQ
// policy checks exercised above when it is explicitly started.
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-policy-worker-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const diagnostic = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'send-test-group.mjs'), 'fixture', 'must-not-send'], {
  cwd: repoRoot, windowsHide: true, env: { ...process.env, CETAMESH_QQ_DIAGNOSTIC_SEND: '' }, stdio: ['ignore', 'pipe', 'pipe']
});
let diagnosticOutput = '';
diagnostic.stdout.on('data', chunk => { diagnosticOutput += String(chunk); });
diagnostic.stderr.on('data', chunk => { diagnosticOutput += String(chunk); });
const [diagnosticExit] = await once(diagnostic, 'close');
assert.equal(diagnosticExit, 2, 'manual diagnostic must require explicit real-send opt-in before loading gateway credentials');
assert.match(diagnosticOutput, /diagnostic.*disabled|诊断.*禁用/i);
const diagnosticSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'send-test-group.mjs'), 'utf8');
assert.match(diagnosticSource, /createQqRuntime\(/, 'developer diagnostic must use the same QQ send executor');
assert.doesNotMatch(diagnosticSource, /bot\.sendGroupMessage\(/, 'diagnostic may not call the SDK send action directly');
const discoveryRoot = path.join(workerRoot, 'discovery');
fs.mkdirSync(discoveryRoot);
writeJsonAtomic(path.join(workerRoot, 'config.json'), {
  consolePort: 9, consoleToken: 'qq-policy-fixture-console-token',
  allow: { groups: [], private: [] }, deny: { groups: [], private: [] }, allowAllWhenEmpty: false,
  snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', allowProcessControl: false },
  dsh: { baseUrl: 'http://127.0.0.1:9' }
});
const workerIntegration = createIntegrationService({ stateDir: path.join(workerRoot, 'state') });
const worker = spawn(process.execPath, [path.join(repoRoot, 'src', 'core-entry.js'), '--worker'], {
  cwd: repoRoot, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore',
  env: { ...process.env, WHALEBRIDGE_DATA_DIR: workerRoot, WHALEBRIDGE_RESOURCE_DIR: repoRoot,
    PATH: discoveryRoot, USERPROFILE: discoveryRoot, LOCALAPPDATA: discoveryRoot, APPDATA: discoveryRoot,
    ProgramFiles: discoveryRoot, 'ProgramFiles(x86)': discoveryRoot }
});
try {
  const pipeName = resolveDataPipeName({ dataRoot: workerRoot });
  let token;
  let ready = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !ready) {
    try {
      token = fs.readFileSync(path.join(workerRoot, 'state', 'agent-token'), 'utf8').trim();
      ready = (await dataCall({ path: '/api/status', token, pipeName, timeoutMs: 500 })).ok;
    } catch (error) {
      if (worker.exitCode !== null) throw new Error('QQ fixture Core exited before IPC readiness');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.equal(ready, true, 'isolated Core must expose its real data IPC');
  const recent = () => dataCall({ path: '/api/socialV2/recent', query: { key: 'group:1' }, sessionToken: 'invalid-fixture', token, pipeName });
  assert.equal((await recent()).status, 403);
  await workerIntegration.execute({ method: 'plugins.tool.toggle', params: {
    pluginId: 'cetamesh-bionic-chat', toolId: 'mcp__snowluma__qq_get_recent_messages', enabled: false
  } });
  const deniedRoute = await recent();
  assert.equal(deniedRoute.status, 403);
  assert.match(deniedRoute.json.error, /Core 数据面不接受 Legacy 会话令牌/);
  await workerIntegration.execute({ method: 'plugins.disable', params: { id: 'cetamesh-bionic-chat' } });
  const deniedSend = await dataCall({ method: 'POST', path: '/api/send/group', body: { groupId: 1, message: 'blocked fixture' }, token, pipeName });
  assert.equal(deniedSend.status, 403);
  assert.match(deniedSend.json.error, /Core 数据面不提供此 Legacy 接口/);
  console.log('PASS real isolated Core data IPC refuses QQ routes without QQ sends');
} finally {
  if (worker.exitCode === null) {
    const closed = once(worker, 'close');
    await terminateSuiteProcessTree(worker);
    await closed;
  }
  await workerIntegration.close();
  fs.rmSync(workerRoot, { recursive: true, force: true });
}

// A separate MCP process must never bypass the QQ owner by posting directly
// to OneBot, even when the gateway would accept its token.
const sendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-send-owner-'));
let directSends = 0;
const onebot = http.createServer((_req, res) => {
  directSends += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { file_id: 'fixture' } }));
});
await new Promise(resolve => onebot.listen(0, '127.0.0.1', resolve));
const sendIntegration = createIntegrationService({ stateDir: path.join(sendRoot, 'state') });
const fileTransport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(repoRoot, 'src', 'mcp-qq-file-send.js')],
  env: { ...process.env, WHALEBRIDGE_DATA_DIR: sendRoot }, stderr: 'pipe' });
const fileClient = new Client({ name: 'qq-send-owner-fixture', version: '1.0.0' });
try {
  writeJsonAtomic(path.join(sendRoot, 'config.json'), {
    snowluma: { httpUrl: `http://127.0.0.1:${onebot.address().port}`, accessToken: 'fixture' },
    allow: { groups: ['42'], private: [] }, deny: { groups: [], private: [] },
    allowAllWhenEmpty: false, socialV2: { tools: { fileSend: true } }
  });
  const fixtureFile = path.join(sendRoot, 'fixture.txt');
  fs.writeFileSync(fixtureFile, 'fixture', 'utf8');
  await sendIntegration.execute({ method: 'plugins.enable', params: { id: 'cetamesh-snowluma' } });
  await sendIntegration.execute({ method: 'plugins.tool.toggle', params: {
    pluginId: 'cetamesh-bionic-chat', toolId: 'mcp__qq-file-send__qq_send_file', enabled: true
  } });
  await fileClient.connect(fileTransport);
  const fileTools = await fileClient.listTools();
  assert.ok(fileTools.tools.find(tool => tool.name === 'qq_send_file')?.inputSchema?.properties?.requestId,
    'file-send MCP schema must expose stable requestId for safe retry');
  assert.ok(fileTools.tools.find(tool => tool.name === 'qq_send_audio_from_url')?.inputSchema?.properties?.requestId,
    'audio-send MCP schema must expose stable requestId for safe retry');
  const result = await fileClient.callTool({ name: 'qq_send_file', arguments: {
    target: 'group:42', filePath: fixtureFile, requestId: 'fixture-file-send-1' } });
  assert.equal(result.isError, true, 'without the QQ owner an MCP send must fail closed');
  assert.doesNotMatch(result.content[0].text, /invalid_type|Unrecognized key|invalid input/i,
    'a stable requestId must be accepted by the MCP send schema');
  assert.equal(directSends, 0, 'MCP must not call OneBot HTTP directly');
} finally {
  await fileClient.close();
  await sendIntegration.close();
  await new Promise(resolve => onebot.close(resolve));
  fs.rmSync(sendRoot, { recursive: true, force: true });
}
