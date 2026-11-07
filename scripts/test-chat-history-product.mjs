import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createOpenAiCompatibleModelProvider } from '../src/model/index.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';
const sandbox = createSuiteSandbox({ suiteId: 'chat-history-product' }), root = sandbox.root;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let services, server, leafFailure, failed = true, sourceId;
const requests = [], provider = 'owned-chat-history';
const closeCore = async () => { if (!services) return; for (const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','extensionService']) await services[name]?.close?.(); services = null; };
try {
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const fileBytes = Buffer.from('OWNED-PRODUCT-HISTORY-FILE\n'); fs.writeFileSync(path.join(project, 'proof.txt'), fileBytes);
  server = http.createServer(async (request, response) => { try {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    assert.equal(request.url, '/v1/chat/completions'); let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); let tool;
    if (requests.length === 1) {
      const synopsis = body.messages.map(row => { try { return JSON.parse(row.content); } catch { return null; } }).find(row => row?.representation === 'extractive-history-reference');
      assert.ok(synopsis?.sources.length, 'ordinary composed Chat reaches actual HTTP with a retained-source synopsis');
      sourceId = synopsis.sources[0].sourceId;
      tool = { index: 0, id: 'product-history-read', type: 'function', function: { name: 'cap_context_history_read', arguments: JSON.stringify({ sourceId, maxChars: 3000 }) } };
    } else if (requests.length === 2) {
      assert.ok(body.messages.some(row => row.tool_call_id === 'product-history-read' && row.content.includes('PRODUCT-ORIGINAL-OWNER-0')), 'real product Broker returns original public Chat source');
      tool = { index: 0, id: 'product-file-read', type: 'function', function: { name: 'cap_filesystem_read', arguments: '{"path":"proof.txt"}' } };
    } else {
      assert.equal(requests.length, 3, 'the ordinary product loop is bounded to its expected three requests');
      assert.ok(body.messages.some(row => row.tool_call_id === 'product-file-read' && row.content.includes('OWNED-PRODUCT-HISTORY-FILE')));
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: tool ? { tool_calls: [tool] } : { content: 'Retained original history and the actual file were read.' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { leafFailure = error; response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Owned history fixture failed' } })); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const secrets = createProviderSecrets({ root: path.join(root, 'credentials') }); secrets.set({ provider, apiKey: 'owned-synthetic-only' });
  const options = { stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'), providerSecrets: secrets, deferOptionalStart: true };
  services = createCetaMeshServices(options);
  const register = () => services.modelRegistry.register(createOpenAiCompatibleModelProvider({ id: provider, label: 'Owned loopback history fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', defaultModel: 'fixture', supportsTools: true, secrets }));
  register();
  const workspace = (await services.workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Product history source' } })).workspace;
  const session = await services.chatService.execute({ method: 'chat.sessions.create', params: { title: 'Product retained history' } });
  await services.chatService.execute({ method: 'chat.config.set', params: { id: session.id, config: { agentProvider: 'none', modelProvider: provider, model: 'fixture', mode: 'chat', workspaceId: workspace.id } } });
  const historyFile = path.join(services.chatService._store.historyDir, session.id + '.json');
  const originals = [];
  for (let i = 0; i < 40; i++) originals.push({ id: 'product-owner-' + i, role: 'user', text: 'PRODUCT-ORIGINAL-OWNER-' + i + ' ' + 'retained public conversation. '.repeat(280), at: i * 2, sourceWorkspaceId: workspace.id },
    { id: 'product-assistant-' + i, role: 'assistant', text: 'Attributed response ' + i + ' ' + 'unverified historical detail. '.repeat(260), at: i * 2 + 1, sourceWorkspaceId: workspace.id });
  writeJsonAtomic(historyFile, { schemaVersion: 1, messages: originals });
  const originalBytes = Buffer.byteLength(JSON.stringify(originals)); assert.ok(originalBytes > 512 * 1024);
  const text = 'Retrieve the retained earlier public messages, then read proof.txt and report exact results.';
  await services.chatService.execute({ method: 'chat.send', params: { id: session.id, text, clientMessageId: 'product-history-owner-request' } });
  let status;
  for (let i = 0; i < 1000; i++) { if (leafFailure) throw leafFailure; status = await services.chatService.execute({ method: 'chat.status', params: { id: session.id } }); if (!status.turn) break; await delay(10); }
  if (leafFailure) throw leafFailure;
  assert.equal(status.turn, null); assert.equal(status.lastState, 'idle', status.lastErrorCode); assert.equal(requests.length, 3);
  assert.equal(hash(fs.readFileSync(path.join(project, 'proof.txt'))), hash(fileBytes));
  const stored = readJsonFile(historyFile); assert.deepEqual(stored.messages.slice(0, 80), originals);
  assert.ok(!stored.activeTurn); assert.ok(stored.messages.at(-1).modelMessages?.some(row => row.tool_call_id === 'product-file-read'));
  const publicHistory = await services.chatService.execute({ method: 'chat.history', params: { id: session.id, limit: 100 } });
  for (const message of publicHistory.messages) { assert.equal(message.modelHistory, undefined); assert.equal(message.modelMessages, undefined); assert.equal(message.contextSynopsis, undefined); }
  const receipts = Object.values(readJsonFile(path.join(options.stateDir, 'model', 'tool-executions.json'))).filter(row => row.sessionId === session.id);
  assert.deepEqual(receipts.map(row => [row.capability, row.status]), [['context.history.read', 'completed'], ['filesystem.read', 'completed']]);
  const snapshot = JSON.stringify(stored), count = requests.length;
  await closeCore(); services = createCetaMeshServices(options); register();
  assert.equal(requests.length, count); assert.equal(JSON.stringify(readJsonFile(historyFile)), snapshot, 'ordinary Core restart retains submitted history without recreating tool or model effects');
  await assert.rejects(services.capabilityService.broker.execute({ actor: { kind: 'owner', id: 'desktop' }, requestId: 'outside-original-history-frame', workspaceId: workspace.id,
    capability: 'context.history.read', input: { sourceId } }), { code: 'CONTEXT_HISTORY_DENIED' });
  assert.equal(requests.length, count);
  console.log(JSON.stringify({ fixture: 'ordinary-composed-chat-retained-history', originalBytes, firstRequestBytes: Buffer.byteLength(JSON.stringify(requests[0])), modelRequests: requests.length,
    actualTools: receipts.map(row => row.capability), originalRows: 80, restartWithoutReplay: true, realAccount: false }));
  failed = false;
} finally { await closeCore(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed }); }
