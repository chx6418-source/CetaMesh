// Production SEA + real Owner IPC; synthetic local model only, no real user services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const exe = path.resolve(process.env.WHALEBRIDGE_DIST_DIR ?? path.join(import.meta.dirname, '../dist/core'), 'WhaleBridgeCore.exe');
const root = fs.mkdtempSync(path.join(path.resolve(import.meta.dirname, '..'), 'cetamesh-m6-sea-'));
const token = crypto.randomBytes(32).toString('hex');
const pipe = `\\\\.\\pipe\\CetaMesh-M6-${crypto.randomUUID()}`;
let core, modelCalls = 0;
const provider = http.createServer(async (req, res) => {
  for await (const part of req) { void part; }
  modelCalls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'M6 fixture reply' } }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const workspace = path.join(root, '中文 Workspace'); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'fixture workspace bytes');
writeJsonAtomic(path.join(root, 'config.json'), { allow: { groups: [], private: [] }, dsh: { baseUrl: 'http://127.0.0.1:9' } });
function rpc(method, params = {}, authToken = token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe); let buffer = Buffer.alloc(0);
    socket.setTimeout(10000, () => socket.destroy(new Error('isolated Owner IPC timeout')));
    socket.on('error', reject);
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ version: 1, id: crypto.randomUUID(), role: 'console', authToken, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE(), response = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4); if (response.event) continue;
        socket.destroy();
        if (response.ok) resolve(response.result);
        else reject(Object.assign(new Error(response.error?.message), { code: response.error?.code }));
      }
    });
  });
}
async function eventually(check) {
  let last;
  for (let i = 0; i < 200; i++) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw last ?? new Error('M6 isolated condition timed out');
}
async function start() {
  core = spawn(exe, ['--worker', '--data-dir', root], { cwd: root, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root, DSH_HOME: path.join(root, 'absent-dsh'),
      WHALEBRIDGE_UI_PIPE: pipe, WHALEBRIDGE_UI_AUTH_TOKEN: token, WHALEBRIDGE_SUPERVISED: '1' } });
  core.stdout.resume(); core.stderr.resume(); await eventually(() => rpc('core.ping'));
}
async function stop() {
  if (!core) return;
  const current = core; core = null; const closed = once(current, 'close'); current.stdin.end();
  const timer = setTimeout(() => current.kill(), 10000);
  try { await closed; } finally { clearTimeout(timer); }
}
try {
  await start();
  assert.equal((await rpc('channel.qq.health')).ready, false);
  await assert.rejects(rpc('task.list', {}, '0'.repeat(64)), 'wrong Owner token must be denied');
  await rpc('providers.secrets.set', { provider: 'openai-compatible', apiKey: 'synthetic-m6-fixture-key', baseUrl: `http://127.0.0.1:${provider.address().port}` });
  const session = await rpc('ui.chat.sessions.create', { title: 'M6 isolated chat' });
  await rpc('ui.chat.config.set', { id: session.id, config: { mode: 'chat', agentProvider: 'none', modelProvider: 'openai-compatible', model: 'fixture-model', reasoning: 'off' } });
  await rpc('ui.chat.send', { id: session.id, text: 'synthetic request', clientMessageId: 'm6-fixture-1' });
  await eventually(async () => (await rpc('ui.chat.history', { id: session.id })).messages.some(m => m.role === 'assistant' && m.text === 'M6 fixture reply'));
  assert.equal(modelCalls, 1);
  assert.equal((await rpc('task.list')).tasks.length, 0, 'Agent none must not create a Task');
  const ws = (await rpc('workspace.create', { name: 'M6', root: workspace })).workspace;
  assert.match(JSON.stringify(await rpc('workspace.read', { id: ws.id, path: 'fixture.txt' })), /fixture workspace bytes/);
  await assert.rejects(rpc('workspace.read', { id: ws.id, path: '../config.json' }));
  const task = await rpc('task.create', { goal: 'M6 persistent fixture task', workspaceId: ws.id, requestedAgentProvider: 'none' });
  await rpc('memory.create', { type: 'knowledge', scope: 'global', content: 'M6 persistent fixture memory' });
  // A corrupt optional Social file must remain untouched across a real Core restart.
  const social = path.join(root, 'state', 'social-v2.json'); fs.writeFileSync(social, '{synthetic damaged social');
  await stop(); await start();
  assert.equal((await rpc('task.get', { id: task.id })).task.id, task.id);
  assert.match(JSON.stringify(await rpc('memory.list')), /M6 persistent fixture memory/);
  assert.match(JSON.stringify(await rpc('workspace.info', { id: ws.id })), new RegExp(ws.id));
  await new Promise(resolve => setTimeout(resolve, 10000));
  assert((await rpc('ui.chat.history', { id: session.id })).messages.some(m => m.text === 'M6 fixture reply'));
  assert.equal(fs.readFileSync(social, 'utf8'), '{synthetic damaged social');
  assert.equal((await rpc('channel.qq.health')).ready, false);
  console.log('VERIFIED_RELEASE_INTEGRATION M6 SEA/Owner IPC + synthetic streaming Chat + Agent none + Task/Memory/Workspace restart + history after 10 seconds');
} finally {
  await stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  if (!path.basename(root).startsWith('cetamesh-m6-sea-') || path.dirname(root) !== path.resolve(import.meta.dirname, '..')) throw new Error('fixture cleanup boundary');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
