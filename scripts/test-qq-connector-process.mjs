import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createQqConnectorHost } from '../src/channel/qq/connector-host.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-child-'));
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, message_id: 71 } }));
});
const wss = new WebSocketServer({ server });
let socket;
wss.on('connection', client => {
  socket = client;
  client.on('message', data => {
    const request = JSON.parse(String(data));
    client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo,
      data: request.action === 'get_login_info' ? { user_id: 10001, nickname: 'fixture' } : { message_id: 71 } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let received;
let ingressAttempts = 0;
const config = { allow: { groups: ['42'], private: [] },
  snowluma: { wsUrl: `ws://127.0.0.1:${server.address().port}`, httpUrl: `http://127.0.0.1:${server.address().port}` } };
const host = createQqConnectorHost({ config, dataRoot: root, stateDir: path.join(root, 'state'),
  executable: process.env.WHALEBRIDGE_TEST_QQ_CONNECTOR_EXE,
  onMessage: async event => {
    if (event.message_id === 10 && ++ingressAttempts === 1) throw new Error('Core durable append temporarily unavailable');
    received = event; return { accepted: true };
  } });
try {
  assert.equal((await host.start()).ready, true);
  assert.equal((await host.health()).accountId, '10001');
  socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 10001,
    user_id: 7, group_id: 42, message_id: 9, message: [{ type: 'text', data: { text: 'fixture' } }] }));
  for (let i = 0; i < 100 && !received; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.message_id, 9);
  const retriedIngress = { post_type: 'message', message_type: 'group', self_id: 10001,
    user_id: 7, group_id: 42, message_id: 10, message: [{ type: 'text', data: { text: 'retry before Core accepted' } }] };
  socket.send(JSON.stringify(retriedIngress));
  for (let i = 0; i < 100 && ingressAttempts < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  socket.send(JSON.stringify(retriedIngress));
  for (let i = 0; i < 100 && ingressAttempts < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ingressAttempts, 2, 'Connector cannot suppress ingress that Core did not durably accept');
  const competing = createQqConnectorHost({ config, dataRoot: root, stateDir: path.join(root, 'state'),
    executable: process.env.WHALEBRIDGE_TEST_QQ_CONNECTOR_EXE, onMessage: async () => ({ accepted: true }) });
  try { assert.equal((await competing.start()).ready, false); } finally { await competing.stop(); }
  assert.equal(fs.existsSync(path.join(root, 'state', '.core-owner.lock')), false, 'Connector cannot own Core');
  assert.equal(fs.existsSync(path.join(root, 'state', 'task')), false, 'Connector cannot construct Task store');
  assert.equal((await host.stop()).stopped, true);
  assert.equal((await host.health()).ready, false);
  console.log('QQ production child transport, lifecycle and account exclusion verified');
} finally {
  await host.stop();
  for (const client of wss.clients) client.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
