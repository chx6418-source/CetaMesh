// Hermetic safe MCP contract: no real gateway, account or local user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { startDataIpcServer, resolveDataPipeName } from '../src/control/data-ipc.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-safe-mcp-'));
const actions = [];
const gateway = http.createServer((req, res) => {
  actions.push(req.url);
  assert.ok(!req.url.includes('send_'), 'denied writes must never reach the gateway');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? { user_id: 10001 } : {} }));
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
writeJsonAtomic(path.join(root, 'config.json'), { snowluma: { httpUrl: 'http://127.0.0.1:' + gateway.address().port }, allow: { groups: [123456789], private: [] } });
const pipeName = resolveDataPipeName({ env: {}, dataRoot: root });
const writes = [];
const ipc = startDataIpcServer({ pipeName, handleApiRequest: async (req, res) => {
  if (req.method === 'POST') {
    writes.push(req.url);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'fixture data-plane denial' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, mode: 'chat', messages: [{ message_id: 1 }] }));
} });
ipc.listen(pipeName);
await once(ipc, 'listening');
const client = new Client({ name: 'safe-contract', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url))],
    env: { ...process.env, WHALEBRIDGE_DATA_DIR: root, WHALEBRIDGE_DATA_PIPE: pipeName } }));
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const name of ['qq_status', 'qq_reply', 'qq_send_group_message', 'qq_slang_query', 'qq_slang_submit']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('invoke_action'));
  assert.match(JSON.stringify(tools.find(t => t.name === 'qq_send_group_message').inputSchema), /replyToMessageId/);
  const status = await client.callTool({ name: 'qq_status', arguments: {} });
  assert.equal(status.isError ?? false, false);
  assert.match(status.content[0].text, /10001/);
  for (const args of [
    { groupId: 987654321, message: 'fixture' },
    { groupId: 123456789, message: 'fixture', replyToMessageId: 'abc' },
    { groupId: 123456789, message: 'fixture', replyToMessageId: 0 },
    { groupId: 987654321, message: 'fixture', replyToMessageId: -123 }
  ]) {
    assert.equal((await client.callTool({ name: 'qq_send_group_message', arguments: args })).isError, true);
  }
  assert.equal((await client.callTool({ name: 'qq_reply', arguments: { groupId: 987654321, replyToMessageId: -123, message: 'fixture' } })).isError, true);
  assert.ok(actions.every(action => !action.includes('send_')));
  assert.equal(writes.length, 5, 'writes are delegated to the authoritative data plane');
  assert.ok(writes.includes('/api/send/reply'));
  console.log('PASS safe MCP handshake, status, schema, data-plane delegation and denial propagation without real services');
} finally {
  await client.close();
  await new Promise(resolve => ipc.close(resolve));
  await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
