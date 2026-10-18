import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createQqRuntime } from '../src/channel/qq/runtime.js';
import { createQqTransport } from '../src/channel/qq/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createIntegrationService } from '../src/integrations/service.js';
import { assertQqDataToolEnabled, qqSocialFlagPolicyEnabled, qqToolPolicyEnabled } from '../src/channel/qq/tool-policy.js';
import { assertMcpToolEnabled } from '../src/integrations/tool-policy.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { dataCall, resolveDataPipeName } from '../src/control/data-ipc.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

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
assert.equal(runtime.status().state, 'ready');
client.connection();
assert.equal((await firstConnect).connected, true);
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
  await first.fixtureClient.groupHandlers[0]({ ...packet, message_id: undefined });
  assert.deepEqual(processed, [99], 'missing external identity must not trigger a reply');
  first.fixtureClient.emit('close', { code: 1006 });
  assert.equal((await first.runtime.reconnect()).connected, true);
  await first.fixtureClient.groupHandlers[0](packet);
  assert.deepEqual(processed, [99], 'reconnect must not replay a handled message');
  await first.runtime.stop();
  const restarted = makeRuntime(10001);
  assert.equal((await restarted.runtime.connect()).connected, true);
  await restarted.fixtureClient.groupHandlers[0](packet);
  assert.deepEqual(processed, [99], 'durable receipt prevents a restart duplicate');
  await restarted.runtime.stop();
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
