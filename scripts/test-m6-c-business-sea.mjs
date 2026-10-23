// Actual SEA/Owner IPC/Model HTTP/Broker/Extension Worker. Synthetic data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { zipSync } from 'fflate';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const exe = path.resolve(process.env.WHALEBRIDGE_DIST_DIR ?? 'dist/core', 'WhaleBridgeCore.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-m6c-business-'));
const data = path.join(root, 'data'), workspace = path.join(root, '中文 workspace');
fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'analysis.txt'), 'M6C controlled analysis content');
const token = crypto.randomBytes(32).toString('hex'), pipe = `\\\\.\\pipe\\CetaMesh-M6C-${crypto.randomUUID()}`;
writeJsonAtomic(path.join(data, 'config.json'), { allow: { groups: [], private: [] }, dsh: { baseUrl: 'http://127.0.0.1:9' } });
let core, calls = 0;
const requests = [];
const model = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'controlled-tools', capabilities: { tools: true } }] })); }
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw), latest = String(body.messages.filter(row => row.role === 'user').at(-1)?.content ?? '');
  const results = body.messages.filter(row => row.role === 'tool'); calls++;
  const name = /M6C_(WRITE|DENY|CANCEL)/.test(latest) ? 'cap_filesystem_write' : 'cap_filesystem_read';
  const input = name === 'cap_filesystem_write' ? { path: latest.includes('M6C_DENY') ? 'denied.txt' : latest.includes('M6C_CANCEL') ? 'cancelled.txt' : 'created.txt', content: 'M6C generated file' }
    : { path: latest.includes('M6C_ERROR') ? 'missing.txt' : 'analysis.txt' };
  requests.push({ latest, model: body.model, resultCount: results.length, offered: (body.tools ?? []).map(row => row.function.name) });
  let message;
  if (!results.length) message = { role: 'assistant', content: null, tool_calls: [{ id: `m6c-call-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] };
  else message = { role: 'assistant', content: 'M6C final: ' + results.at(-1).content };
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = results.length ? { content: message.content } : { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) };
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    return res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: results.length ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: results.length ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
function rpc(method, params = {}, authToken = token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe); let buffer = Buffer.alloc(0);
    socket.setTimeout(10000, () => socket.destroy(Error('isolated IPC timeout'))); socket.on('error', reject);
    socket.on('connect', () => { const body = Buffer.from(JSON.stringify({ version: 1, id: crypto.randomUUID(), role: 'console', authToken, method, params })); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body])); });
    socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) { const length = buffer.readUInt32LE(), response = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4); if (response.event) continue; socket.destroy(); if (response.ok) resolve(response.result); else reject(Object.assign(Error(response.error?.message), { code: response.error?.code })); } });
  });
}
async function eventually(check) {
  let last; for (let i = 0; i < 200; i++) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 50)); }
  throw last ?? Error('isolated business condition timeout');
}
async function start() {
  core = spawn(exe, ['--worker', '--data-dir', data], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32'), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, DSH_HOME: path.join(root, 'absent-dsh'), WHALEBRIDGE_UI_PIPE: pipe, WHALEBRIDGE_UI_AUTH_TOKEN: token, WHALEBRIDGE_SUPERVISED: '1' } });
  core.stdout.resume(); core.stderr.resume(); await eventually(() => rpc('core.ping'));
}
async function stop() {
  if (!core) return; const child = core; core = null; const closed = once(child, 'close'); child.stdin.end(); const deadline = setTimeout(() => child.kill(), 10000); try { await closed; } finally { clearTimeout(deadline); }
}
async function session(text) {
  const row = await rpc('ui.chat.sessions.create', { title: text });
  await rpc('ui.chat.config.set', { id: row.id, config: { mode: 'chat', agentProvider: 'none', workspaceId: ws.id, modelProvider: 'openai-compatible', model: 'controlled-tools', reasoning: 'off' } });
  await rpc('ui.chat.send', { id: row.id, text, clientMessageId: crypto.randomUUID() }); return row.id;
}
async function settled(id) {
  await eventually(async () => (await rpc('chat.status', { id })).turn === null);
  return rpc('ui.chat.history', { id });
}
async function finishApproval(id, approve) {
  const accepted = await rpc('ui.approvals.decide', { id, approve });
  assert.equal(accepted.status, 'accepted');
  assert.equal(typeof accepted.operationId, 'string');
  const operation = await eventually(async () => {
    const current = await rpc('ui.approvals.operation', { id: accepted.operationId });
    return ['completed', 'failed', 'unknown', 'cancelled'].includes(current.status) ? current : null;
  });
  assert.equal(operation.status, 'completed', JSON.stringify(operation));
  assert.equal(operation.decision, approve ? 'approved' : 'rejected');
  assert.equal(operation.turnResumed, true);
  return operation;
}
let ws;
try {
  await start();
  await assert.rejects(rpc('task.list', {}, '0'.repeat(64)), 'wrong Owner identity must be rejected');
  await rpc('providers.secrets.set', { provider: 'openai-compatible', apiKey: 'synthetic-loopback-only', baseUrl: `http://127.0.0.1:${model.address().port}/v1` });
  await rpc('settings.update', { section: 'models', values: { provider: 'openai-compatible', defaultModel: 'controlled-tools', openaiCompatibleToolCalling: true } });
  ws = (await rpc('workspace.create', { name: 'M6C controlled', root: workspace })).workspace;
  const readSession = await session('M6C_READ controlled source');
  const read = await settled(readSession);
  assert.ok(read.messages.some(row => row.role === 'assistant' && row.text.includes('M6C controlled analysis content')), 'real filesystem result must return to Model and formal Chat message: ' + JSON.stringify({ messages: read.messages, requests }));
  assert.ok(read.messages.some(row => row.toolActivity?.some(tool => tool.label === 'filesystem.read' && tool.status === 'completed')));
  console.log('PASS real SEA read tool result returned through Model to formal Chat');
  const writeSession = await session('M6C_WRITE controlled artifact');
  const pending = await eventually(async () => { const rows = (await rpc('ui.approvals.list')).approvals; return rows?.find(row => row.status === 'pending' && row.capability === 'filesystem.write'); });
  assert.equal(fs.existsSync(path.join(workspace, 'created.txt')), false, 'approval is checked before real write');
  await finishApproval(pending.id, true);
  const written = await settled(writeSession);
  assert.equal(fs.readFileSync(path.join(workspace, 'created.txt'), 'utf8'), 'M6C generated file');
  assert.ok(written.messages.some(row => row.role === 'assistant' && row.text.startsWith('M6C final:')));
  const denySession = await session('M6C_DENY controlled write');
  const rejected = await eventually(async () => (await rpc('ui.approvals.list')).approvals?.find(row => row.status === 'pending' && row.capability === 'filesystem.write'));
  await finishApproval(rejected.id, false); await settled(denySession);
  assert.equal(fs.existsSync(path.join(workspace, 'denied.txt')), false);
  const cancelledSession = await session('M6C_CANCEL pending write');
  const cancelledApproval = await eventually(async () => (await rpc('ui.approvals.list')).approvals?.find(row => row.status === 'pending' && row.capability === 'filesystem.write'));
  await rpc('ui.chat.stop', { id: cancelledSession });
  const cancelled = await settled(cancelledSession);
  assert.equal(fs.existsSync(path.join(workspace, 'cancelled.txt')), false);
  assert.ok(cancelled.messages.some(row => row.cancelled === true));
  assert.ok(cancelled.messages.some(row => row.toolActivity?.some(tool => tool.label === 'filesystem.write' && tool.status === 'cancelled')), 'stopped approval tool must show cancelled, not waiting or completed');
  await assert.rejects(rpc('ui.approvals.decide', { id: cancelledApproval.id, approve: true }), 'late approval must not revive a cancelled write');
  const errorSession = await session('M6C_ERROR controlled read');
  const failed = await settled(errorSession);
  assert.ok(failed.messages.some(row => row.toolActivity?.some(tool => tool.status === 'failed' || tool.status === 'error')), 'tool error must not be projected as successful');
  const task = await rpc('task.create', { goal: 'Owner associates a generated artifact', workspaceId: ws.id });
  const updated = await rpc('task.artifact.add', { id: task.id, expectedRev: task.rev, kind: 'file', label: 'M6C generated artifact', ref: 'created.txt' });
  const artifact = updated.artifacts.at(-1);
  const resolved = await rpc('task.artifact.resolveOpen', { taskId: task.id, artifactId: artifact.id });
  assert.equal(resolved.canonicalPath, fs.realpathSync.native(path.join(workspace, 'created.txt')));
  await assert.rejects(rpc('task.artifact.resolveOpen', { taskId: task.id, artifactId: 'foreign-artifact' }), error => error.code === 'ARTIFACT_NOT_FOUND');
  const pluginId = 'm6c.controlled-tool';
  const manifest = { manifestVersion: 1, id: pluginId, name: 'M6C Controlled Tool', version: '1.0.0', type: 'tool', entry: 'index.js', permissions: [], capabilities: [{ id: 'hello', kind: 'tool', title: 'Controlled result', requires: [], inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }] };
  const packageFile = path.join(root, 'controlled.cmpkg');
  fs.writeFileSync(packageFile, zipSync({ 'extension.json': Buffer.from(JSON.stringify(manifest)), 'index.js': Buffer.from('module.exports.handlers={hello:input=>({greeting:"M6C "+input.name})};') }));
  await assert.rejects(rpc('ui.plugins.stage-local', { file: packageFile }), error => error.code === 'DEVELOPER_MODE_REQUIRED');
  await rpc('settings.update', { section: 'extensions', values: { developerMode: true } });
  const stage = await rpc('ui.plugins.stage-local', { file: packageFile });
  await assert.rejects(rpc('ui.plugins.install', { stageId: stage.stageId }), error => error.code === 'PERMISSION_REVIEW_REQUIRED');
  await rpc('ui.plugins.install', { stageId: stage.stageId, reviewed: true });
  const review = await rpc('ui.plugins.enable.review', { id: pluginId });
  await rpc('ui.plugins.enable', { id: pluginId, stageId: review.stageId, reviewed: true });
  const invoked = await rpc('ext.invoke', { id: pluginId, capability: 'hello', input: { name: 'production SEA Worker' } });
  assert.equal(invoked.result.greeting, 'M6C production SEA Worker');
  await rpc('ui.plugins.disable', { id: pluginId });
  await assert.rejects(rpc('ext.invoke', { id: pluginId, capability: 'hello', input: { name: 'must not execute' } }));
  await stop(); await start();
  assert.equal((await rpc('task.get', { id: task.id })).task.artifacts.at(-1).id, artifact.id);
  assert.ok((await rpc('ui.chat.history', { id: readSession })).messages.some(row => row.text.includes('M6C controlled analysis content')));
  await assert.rejects(rpc('ext.invoke', { id: pluginId, capability: 'hello', input: { name: 'disabled across restart' } }));
  await rpc('ui.plugins.uninstall', { id: pluginId });
  await assert.rejects(rpc('ext.get', { id: pluginId }));
  assert.ok(requests.some(row => row.resultCount > 0), 'structured tool results really return across HTTP');
  // Production Owner IPC recovery for a post-exit stale Codex Task. Synthetic
  // historical metadata only: no native CLI or user project is started here.
  let stale = await rpc('task.create', { goal: 'post-exit stale Codex Task', workspaceId: ws.id });
  stale = (await rpc('task.start', { id: stale.id, expectedRev: stale.rev,
    provider: 'codex', sessionId: 'prior-core-' + stale.id })).task;
  stale = (await rpc('task.block', { id: stale.id, expectedRev: stale.rev, reason: 'STAGING_READ_FAILED' })).task;
  await stop(); await start();
  const removedOwner = await rpc('ui.task.cancel', { id: stale.id, expectedRev: stale.rev });
  assert.equal(removedOwner.task.status, 'cancelled');
  await stop(); await start();
  const restoredCancel = (await rpc('task.get', { id: stale.id })).task;
  assert.equal(restoredCancel.status, 'cancelled');
  assert.equal(restoredCancel.currentAgent, null);
  let unknown = await rpc('task.create', { goal: 'unknown Codex execution remains fenced', workspaceId: ws.id });
  unknown = (await rpc('task.start', { id: unknown.id, expectedRev: unknown.rev,
    provider: 'codex', sessionId: 'unknown-core-' + unknown.id })).task;
  unknown = (await rpc('task.block', { id: unknown.id, expectedRev: unknown.rev,
    reason: 'needs-reconciliation: native execution unconfirmed' })).task;
  await stop(); await start();
  // The router cannot reconstruct a transport from a bare historical session ID.
  // This must stay an unknown execution, rather than proof that its process stopped.
  await assert.rejects(rpc('ui.task.cancel', { id: unknown.id, expectedRev: unknown.rev }), error => error.code === 'SESSION_TRANSPORT_UNKNOWN');
  const stillOwned = (await rpc('task.get', { id: unknown.id })).task;
  assert.equal(stillOwned.status, 'blocked');
  assert.equal(stillOwned.currentAgent.sessionId, unknown.currentAgent.sessionId);
  console.log('VERIFIED_RELEASE_INTEGRATION SEA post-exit missing Codex Session cancellation survives restart; unknown native execution retains its Task owner');

  console.log('VERIFIED_RELEASE_INTEGRATION production SEA + synthetic Model HTTP → real Broker filesystem/approval/deny/error → final Chat; Owner-linked Artifact; Plugin install/review/Worker/disable/restart/uninstall; no system Node');
} finally {
  await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('cetamesh-m6c-business-')) throw Error('fixture cleanup boundary');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
