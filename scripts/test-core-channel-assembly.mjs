import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-core-channel-'));
const token = crypto.randomBytes(32).toString('hex');
const pipe = process.platform === 'win32'
  ? `\\\\.\\pipe\\CetaMesh-Channel-Test-${crypto.randomUUID()}`
  : path.join(root, 'ui.sock');
let sends = 0;
const gateway = http.createServer(async (req, res) => {
  for await (const part of req) { void part; }
  if (req.url !== '/get_login_info') sends++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url === '/get_login_info'
    ? { user_id: 10001 } : { message_id: 900 + sends } }));
});
const wss = new WebSocketServer({ server: gateway });
wss.on('connection', socket => socket.on('message', data => {
  const request = JSON.parse(String(data));
  socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { user_id: 10001 } }));
}));
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
writeJsonAtomic(path.join(root, 'config.json'), { allow: { groups: ['42'], private: [] },
  dsh: { baseUrl: 'http://127.0.0.1:9' }, snowluma: { wsUrl: `ws://127.0.0.1:${gateway.address().port}`,
    httpUrl: `http://127.0.0.1:${gateway.address().port}` } });
let core;
let coreOutput = '';
async function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buffer = Buffer.alloc(0);
    socket.setTimeout(15000, () => socket.destroy(new Error('Owner IPC timeout')));
    socket.on('error', reject);
    socket.on('connect', () => {
      const data = Buffer.from(JSON.stringify({ version: 1, id: crypto.randomUUID(), role: 'console', authToken: token, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length); socket.write(Buffer.concat([header, data]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const length = buffer.readUInt32LE();
        const result = JSON.parse(buffer.subarray(4, 4 + length).toString());
        buffer = buffer.subarray(4 + length);
        if (result.event) continue;
        socket.end(); socket.destroy();
        if (!result.ok) reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
        else resolve(result.result);
      }
    });
  });
}
async function eventually(check) {
  let last;
  for (let i = 0; i < 150; i++) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw last ?? new Error('production state did not converge');
}
async function startCore() {
  const exe = process.env.WHALEBRIDGE_TEST_QQ_CONNECTOR_EXE;
  core = spawn(exe ?? process.execPath, [...(exe ? [] : [path.resolve(import.meta.dirname, '../src/core-entry.js')]), '--worker', '--data-dir', root],
    { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      WHALEBRIDGE_UI_PIPE: pipe, WHALEBRIDGE_UI_AUTH_TOKEN: token, WHALEBRIDGE_SUPERVISED: '1' } });
  coreOutput = '';
  core.stdout.on('data', chunk => { coreOutput += String(chunk); });
  core.stderr.on('data', chunk => { coreOutput += String(chunk); });
  await eventually(() => {
    if (core.exitCode !== null || core.signalCode !== null) throw new Error(`Core exited before IPC readiness: ${coreOutput}`);
    return rpc('core.ping');
  });
}
async function stopCore(crash = false) {
  if (!core) return;
  const current = core; core = null;
  if (current.exitCode === null && current.signalCode === null) {
    const closed = once(current, 'close');
    if (crash) current.kill(); else current.stdin.end();
    await closed;
  }
  await eventually(() => wss.clients.size === 0);
}
try {
  await startCore();
  assert.equal((await rpc('channel.qq.health')).ready, false, 'pure Core never auto-starts QQ');
  const task = await rpc('task.create', { goal: 'persistent Core channel fixture', requestedAgentProvider: 'none' });
  await rpc('memory.create', { type: 'knowledge', scope: 'global', content: 'persistent channel memory fixture' });
  assert.equal((await rpc('channel.qq.start')).ready, true);
  assert.equal((await rpc('channel.bionic.start')).running, true);
  const message = { post_type: 'message', message_type: 'group', self_id: 10001, user_id: 7,
    group_id: 42, message_id: 81, message: [{ type: 'text', data: { text: 'ordinary controlled fixture' } }] };
  [...wss.clients][0].send(JSON.stringify(message));
  await eventually(async () => {
    const state = await rpc('channel.delivery.status');
    return state.events.length === 1 && state.consumers['bionic-10001']?.cursor === 1;
  });
  const input = { accountId: '10001', action: 'send_group_msg', kind: 'text', params: { group_id: 42, message: 'approved fixture' } };
  const pending = await rpc('channel.qq.send', { requestId: 'assembly-1', approvalBinding: null, input });
  assert.equal(pending.status, 'pending'); assert.equal(sends, 0);
  const accepted = await rpc('capability.approval.decide', { id: pending.approvalId, approve: true });
  assert.equal(accepted.status, 'accepted', 'Owner IPC acknowledges durable work before delivery completes');
  assert.equal(typeof accepted.operationId, 'string');
  const operation = await eventually(async () => {
    const current = await rpc('capability.operation.get', { id: accepted.operationId });
    return ['completed', 'failed', 'unknown', 'cancelled'].includes(current.status) ? current : null;
  });
  assert.equal(operation.status, 'completed', JSON.stringify(operation));
  assert.equal(operation.decision, 'approved');
  assert.equal(sends, 1);
  assert.equal((await rpc('channel.qq.send.status', { accountId: '10001', requestId: 'assembly-1' })).status, 'sent');
  const duplicate = await rpc('capability.approval.decide', { id: pending.approvalId, approve: true });
  assert.equal(duplicate.operationId, accepted.operationId);
  assert.equal(duplicate.status, 'completed');
  assert.equal(sends, 1, 'duplicate operation submission cannot repeat a sent message');
  await rpc('channel.bionic.stop');
  assert.equal((await rpc('channel.qq.health')).ready, true, 'Bionic stop must leave QQ transport active');
  const connectorHealth = await rpc('channel.qq.health');
  assert.ok(connectorHealth.processId && connectorHealth.processId !== core.pid);
  process.kill(connectorHealth.processId);
  await eventually(async () => !(await rpc('channel.qq.health')).ready && wss.clients.size === 0);
  assert.equal((await rpc('task.get', { id: task.id })).task.id, task.id, 'Connector crash cannot damage Core Task');
  assert.match(JSON.stringify(await rpc('memory.list')), /persistent channel memory fixture/);
  await rpc('channel.qq.reconnect');
  assert.equal(wss.clients.size, 1, 'reconnect cannot leave a second listener');
  await stopCore(true);
  await startCore();
  assert.equal((await rpc('task.get', { id: task.id })).task.id, task.id);
  assert.match(JSON.stringify(await rpc('memory.list')), /persistent channel memory fixture/);
  assert.equal((await rpc('channel.qq.start')).ready, true);
  [...wss.clients][0].send(JSON.stringify(message));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await rpc('channel.delivery.status')).events.length, 1, 'Core crash/restart preserves ingress dedup');
  await assert.rejects(rpc('channel.qq.send', { requestId: 'assembly-1', approvalBinding: null, input, approved: true }), { code: 'REQUEST_ALREADY_DISPATCHED' });
  assert.equal(sends, 1, 'Core restart cannot repeat a dispatched send');
  assert.equal((await rpc('channel.qq.send.status', { accountId: '10001', requestId: 'assembly-1' })).status, 'sent', 'Owner receipt inspection survives Core restart');
  await rpc('channel.qq.stop');
  assert.equal((await rpc('channel.qq.health')).ready, false);
  console.log('Actual Core worker IPC, QQ/Bionic lifecycle, Broker, journal and crash recovery verified');
} finally {
  await stopCore();
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
