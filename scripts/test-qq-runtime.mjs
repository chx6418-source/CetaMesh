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
