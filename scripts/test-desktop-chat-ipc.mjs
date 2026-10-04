import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const coreCommand = process.env.CETAMESH_TEST_CORE || process.execPath;
const coreArgs = process.env.CETAMESH_TEST_CORE ? ['--worker'] : ['src/core-entry.js', '--worker'];
const resourceRoot = process.env.CETAMESH_TEST_RESOURCES || root;
const temp = fs.mkdtempSync(path.join(root, 'output', 'desktop-chat-ipc-'));
const data = path.join(temp, 'data');
const home = path.join(temp, 'home');
fs.mkdirSync(path.join(data, 'state'), { recursive: true });
fs.mkdirSync(home);
const pipe = '\\\\.\\pipe\\cetamesh-chat-test-' + crypto.randomUUID();
const records = [];
const sockets = new Set();
let turn = 0;
let worker;
let dsh;
let wss;
let consolePort;
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const value = Buffer.alloc(4 + body.length);
  value.writeUInt32LE(body.length, 0);
  body.copy(value, 4);
  return value;
}
async function connectPipe() {
  for (let i = 0; i < 80; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.connect(pipe);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw Error('Core IPC pipe did not open');
}
async function readFrame(socket) {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(4, 4 + len).toString()));
    };
    const onClose = () => { cleanup(); reject(Error('IPC closed')); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', onClose); socket.off('close', onClose); };
    socket.on('data', onData);
    socket.once('error', onClose);
    socket.once('close', onClose);
  });
}
async function ipc(method, params = {}) {
  const socket = await connectPipe();
  try {
    const ready = await readFrame(socket);
    assert.equal(ready.event, 'core.ready');
    socket.write(frame({ version: 1, id: 'chat-test-7', method, params }));
    const response = await readFrame(socket);
    assert.equal(response.id, 'chat-test-7');
    return response;
  } finally { socket.end(); }
}
async function waitStatus(desired) {
  for (let i = 0; i < 100; i++) {
    const response = await ipc('chat.status');
    assert.equal(response.ok, true, JSON.stringify(response));
    if (response.result.status === desired) return response.result;
    await new Promise(r => setTimeout(r, 60));
  }
  throw Error('chat did not reach ' + desired);
}
try {
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  consolePort = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  dsh = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body || '{}');
    const endpoint = req.url?.slice('/api/'.length);
    let value = {};
    if (endpoint === 'settings/describe') value = { namespaces: [{ ns: 'whale-mode', value: { mode: 'chat' } }] };
    else if (endpoint === 'workspace/create') value = { workspace: { workspaceId: 'w-1' }, created: false };
    else if (endpoint === 'session/create') value = { sessionId: 'desktop-s-1' };
    else if (endpoint === 'session/selectModel') value = {};
    else if (endpoint === 'session/prompt') {
      const t = ++turn;
      const add = event => {
        const record = { seq: records.length + 1, event };
        records.push(record);
        for (const client of sockets) {
          if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type: 'item', streamId: client.id, value: { type: 'event', event: { ...event, seq: record.seq } } }));
        }
      };
      setTimeout(() => add({ type: 'turn/start', data: { turn: t } }), 40);
      setTimeout(() => add({ type: 'assistant/chunk', data: { turn: t, chunk: { type: 'text-delta', text: '正在回复' } } }), 90);
      if (t === 1) {
        setTimeout(() => add({ type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: '本地测试回答' }] } } }), 380);
        setTimeout(() => add({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } }), 400);
      }
    } else if (endpoint === 'session/cancel') {
      const t = turn;
      const record = { seq: records.length + 1, event: { type: 'turn/end', data: { turn: t, reason: { kind: 'aborted' } } } };
      records.push(record);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } }));
  });
  wss = new WebSocketServer({ noServer: true });
  dsh.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'open') return;
      const holder = { ws, id: msg.streamId };
      sockets.add(holder);
      ws.on('close', () => sockets.delete(holder));
      ws.send(JSON.stringify({ type: 'item', streamId: msg.streamId, value: { type: 'snapshot', records: records.slice() } }));
    });
  }));
  await new Promise(resolve => dsh.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    consolePort, dsh: { baseUrl: 'http://127.0.0.1:' + dsh.address().port, authCookie: 'fixture=local', provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' },
    snowluma: { wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9', allowProcessControl: false },
    slang: { enabled: false }
  }));
  worker = spawn(coreCommand, coreArgs, {
    cwd: root, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, WHALEBRIDGE_DATA_DIR: data, WHALEBRIDGE_RESOURCE_DIR: resourceRoot, WHALEBRIDGE_UI_PIPE: pipe, WHALEBRIDGE_SUPERVISED: '1',
      USERPROFILE: home, HOME: home, LOCALAPPDATA: home, APPDATA: home, DSH_HOME: home, ProgramFiles: home, 'ProgramFiles(x86)': home,
      ...(process.env.CETAMESH_TEST_CORE ? { PATH: 'C:\\Windows\\System32;C:\\Windows', Path: 'C:\\Windows\\System32;C:\\Windows' } : {}) }
  });
  console.log('worker ready');
  assert.equal((await ipc('chat.status')).result.status, 'idle');
  const started = await ipc('chat.start', { text: '你好，CetaMesh' });
  assert.equal(started.ok, true, JSON.stringify(started));
  console.log('start accepted');
  let sawDraft = false;
  for (let i = 0; i < 12; i++) {
    const state = (await ipc('chat.status')).result;
    if (state.draft.includes('正在回复') && state.status === 'running') { sawDraft = true; break; }
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(sawDraft, 'partial text must cross Windows IPC before turn end');
  const result = await waitStatus('completed');
  assert.equal(result.reply, '本地测试回答');
  assert.equal(result.history[0].text, '你好，CetaMesh');
  assert.equal((await ipc('chat.start', { text: '暂停这轮' })).ok, true);
  await waitStatus('running');
  assert.equal((await ipc('chat.cancel')).result.status, 'cancelling');
  await waitStatus('cancelled');
  assert.equal((await ipc('chat.status')).result.sessionId, null);
  console.log('cancel accepted');
  worker.stdin.end();
  await new Promise(resolve => worker.once('exit', resolve));
  worker = spawn(coreCommand, coreArgs, {
    cwd: root, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, WHALEBRIDGE_DATA_DIR: data, WHALEBRIDGE_RESOURCE_DIR: resourceRoot, WHALEBRIDGE_UI_PIPE: pipe, WHALEBRIDGE_SUPERVISED: '1',
      USERPROFILE: home, HOME: home, LOCALAPPDATA: home, APPDATA: home, DSH_HOME: home, ProgramFiles: home, 'ProgramFiles(x86)': home,
      ...(process.env.CETAMESH_TEST_CORE ? { PATH: 'C:\\Windows\\System32;C:\\Windows', Path: 'C:\\Windows\\System32;C:\\Windows' } : {}) }
  });
  const recovered = (await ipc('chat.status')).result;
  assert.equal(recovered.history[1].text, '本地测试回答');
  assert.equal(recovered.status, 'cancelled');
  console.log('PASS: Windows Named Pipe chat.start/status/cancel -> actual Core -> local DSH protocol fixture -> persisted reply after Core restart');
} finally {
  if (worker && worker.exitCode === null) { worker.kill(); await new Promise(resolve => worker.once('exit', resolve)); }
  for (const holder of sockets) holder.ws.close();
  await new Promise(resolve => wss?.close(resolve));
  await new Promise(resolve => dsh?.close(resolve));
  assert.ok(temp.startsWith(path.join(root, 'output') + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
}
