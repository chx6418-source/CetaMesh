import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripTypeScriptTypes } from 'node:module';
import { startIpcProtocol, IPC_PROTOCOL_MAX_FRAME_BYTES } from '../src/control/ipc-protocol.js';
import { createDesktopUiEventBus, createDesktopUiService } from '../src/desktop/ui-service.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

let failures = 0;
await check('Harbor recovery drains forward pages and stops stale sessions or invalid cursors', async () => {
  const source = fs.readFileSync(new URL('../desktop-ui/src/app/chat-history.ts', import.meta.url), 'utf8');
  const { recoverForwardHistory } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  const cursors = []; const applied = [];
  await recoverForwardHistory('a', async cursor => {
    cursors.push(cursor);
    return { messages: [{ id: cursor + '1' }], hasMoreAfter: cursor !== 'c', nextAfterMessageId: cursor === 'a' ? 'b' : 'c' };
  }, () => true, (page, first) => applied.push([page.messages[0].id, first]));
  assert.deepEqual(cursors, ['a', 'b', 'c']);
  assert.deepEqual(applied, [['a1', true], ['b1', false], ['c1', false]]);
  let current = true;
  await recoverForwardHistory('a', async () => { current = false; return { messages: [{ id: 'stale' }], hasMoreAfter: false }; }, () => current, () => assert.fail('stale session applied'));
  await assert.rejects(recoverForwardHistory('a', async () => ({ messages: [], hasMoreAfter: true, nextAfterMessageId: 'a' }), () => true, () => {}), /游标/);
});
async function check(name, run) {
  try { await run(); console.log('PASS COMM12 ' + name); }
  catch (error) { failures++; console.error('FAIL COMM12 ' + name + '\n' + error.stack); }
}
async function wire(dispatch, method, params = {}, id = '\0'.repeat(200), expectedId = id) {
  const input = new PassThrough(); const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const protocol = startIpcProtocol({ input, output, dispatch });
  const body = Buffer.from(JSON.stringify({ version: 1, id, method, params }));
  const request = Buffer.alloc(4 + body.length); request.writeUInt32LE(body.length); body.copy(request, 4);
  input.end(request); await protocol.done;
  const bytes = Buffer.concat(chunks);
  assert.ok(bytes.length >= 4, 'actual serializer emitted a response');
  const frames = [];
  for (let at = 0; at < bytes.length;) {
    const length = bytes.readUInt32LE(at); assert.ok(length + 4 <= IPC_PROTOCOL_MAX_FRAME_BYTES, 'actual complete response frame fits 1 MiB');
    assert.ok(at + 4 + length <= bytes.length);
    frames.push(JSON.parse(bytes.subarray(at + 4, at + 4 + length).toString('utf8'))); at += length + 4;
  }
  const response = frames.find(row => row.id === expectedId);
  assert.ok(response, 'request received its own framed response');
  assert.equal(response.id, expectedId, 'request id is preserved or rejected explicitly');
  return response;
}
async function rpc(dispatch, method, params) {
  const response = await wire(dispatch, method, params);
  assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result;
}
const streamedText = rows => {
  let text = '';
  for (const row of rows) {
    if (row.data.reset) text = '';
    if (typeof row.data.replaceText === 'string') text = row.data.replaceText;
    if (typeof row.data.delta === 'string') text += row.data.delta;
  }
  return text;
};
async function drain(bus) {
  const rows = []; let after = 0;
  for (let count = 0; count < 100; count++) {
    const page = await rpc(({ params }) => bus.next(params), 'ui.events.next', { after, waitMs: 0 });
    assert.equal(page.reset, undefined);
    if (!page.events.length) return rows;
    assert.ok(page.cursor > after); rows.push(...page.events); after = page.cursor;
  }
  assert.fail('event drain did not terminate');
}
const patterns = { ascii: 'a', chinese: '鲸', emoji: '🐳', escaped: '\0"\\\n' };
await check('overlimit request ID is refused before dispatch with bounded error frame', async () => {
  let dispatched = false;
  const response = await wire(() => { dispatched = true; }, 'ui.events.next', {}, '\0'.repeat(201), null);
  assert.equal(dispatched, false); assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_REQUEST');
});
for (const [label, pattern] of Object.entries(patterns)) {
  await check('12 x 32k ' + label + ' events cross actual IPC without loss', async () => {
    const bus = createDesktopUiEventBus();
    const text = pattern.repeat(Math.ceil(32000 / pattern.length)).slice(0, 32000);
    for (let n = 0; n < 12; n++) bus.publish('chat.streaming', { sessionId: 'stream-a', turnId: 'turn-a', requestId: 'request-a', delta: text });
    const events = await drain(bus);
    assert.equal(events.length, 12); assert.equal(streamedText(events), text.repeat(12));
    assert.ok(events.every(row => row.data.turnId === 'turn-a' && row.data.requestId === 'request-a'));
  });
  await check('large delta and 256k replacement preserve ' + label + ' content', async () => {
    const bus = createDesktopUiEventBus();
    const delta = pattern.repeat(Math.ceil(95000 / pattern.length)).slice(0, 95000);
    const replacement = pattern.repeat(Math.ceil(256000 / pattern.length)).slice(0, 256000);
    bus.publish('chat.streaming', { sessionId: 'a', delta });
    bus.publish('chat.streaming', { sessionId: 'b', replaceText: replacement, reset: true });
    const events = await drain(bus);
    assert.equal(streamedText(events.filter(row => row.data.sessionId === 'a')), delta);
    assert.equal(streamedText(events.filter(row => row.data.sessionId === 'b')), replacement);
  });
}
await check('oversized individual stream refused; event gap asks for authoritative reset', async () => {
  const bus = createDesktopUiEventBus({ maxEvents: 3 });
  assert.throws(() => bus.publish('chat.streaming', { sessionId: 'a', delta: 'x'.repeat(256001) }), { code: 'IPC_ITEM_TOO_LARGE' });
  assert.throws(() => bus.publish('chat.streaming', { sessionId: 'a', replaceText: 'x'.repeat(256001) }), { code: 'IPC_ITEM_TOO_LARGE' });
  for (let i = 0; i < 5; i++) bus.publish('chat.updated', { sessionId: 'a', messageId: 'm' + i, turnId: 't', historyRevision: i });
  const page = await rpc(({ params }) => bus.next(params), 'ui.events.next', { after: 0, waitMs: 0 });
  assert.equal(page.reset, true); assert.deepEqual(page.events, []); assert.deepEqual(page.gap, { from: 1, to: 2 });
  assert.equal(page.cursor, 5);
  const other = createDesktopUiEventBus(); assert.notEqual(other.instanceId, bus.instanceId);
});
await check('surrogate boundary splitting preserves exact emoji text', async () => {
  const bus = createDesktopUiEventBus(); const text = 'a' + '🐳'.repeat(60000);
  bus.publish('chat.streaming', { sessionId: 'emoji-edge', delta: text });
  assert.equal(streamedText(await drain(bus)), text);
});

await check('actual frontend event pump consumes gap reset and resumes at authoritative cursor', async () => {
  const oldWindow = globalThis.window; const bus = createDesktopUiEventBus({ maxEvents: 3 });
  for (let i = 0; i < 5; i++) bus.publish('chat.updated', { sessionId: 'fixture', messageId: 'old-' + i });
  const requests = []; const resets = []; const seen = []; let unsubscribeReset; let unsubscribeStream;
  let resolveReceived; let rejectReceived; let timer;
  const received = new Promise((resolve, reject) => { resolveReceived = resolve; rejectReceived = reject; timer = setTimeout(() => reject(new Error('Frontend reset/resume timed out')), 3000); });
  const fakeWindow = { setTimeout, clearTimeout, ipc: { postMessage(raw) {
    const request = JSON.parse(raw); requests.push(request.params.after);
    if (request.params.after === 5) bus.publish('chat.streaming', { sessionId: 'fixture', delta: 'fresh' });
    void rpc(({ params }) => bus.next({ ...params, waitMs: 0 }), request.method, request.params)
      .then(result => fakeWindow.__cetameshReceive({ id: request.id, ok: true, result }), rejectReceived);
  } } };
  globalThis.window = fakeWindow;
  try {
    const source = fs.readFileSync(new URL('../desktop-ui/src/bridge/typed-client.ts', import.meta.url), 'utf8');
    const javascript = stripTypeScriptTypes(source);
    const { bridge } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
    unsubscribeReset = bridge.subscribe('core.restarted', data => resets.push(data));
    unsubscribeStream = bridge.subscribe('chat.streaming', data => { seen.push(data); unsubscribeReset(); unsubscribeStream(); resolveReceived(); });
    await received;
    assert.deepEqual(requests, [0, 5]); assert.deepEqual(resets, [{ reset: true }]); assert.equal(seen[0].delta, 'fresh');
  } finally { clearTimeout(timer); unsubscribeReset?.(); unsubscribeStream?.(); fakeWindow.ipc = null; globalThis.window = oldWindow; }
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-event-budget-'));
let chat;
try {
  chat = createChatService({ stateDir: root });
  const session = await chat.execute({ method: 'chat.sessions.create', params: { title: 'Byte budget fixture' } });
  const historyFile = path.join(chat._store.historyDir, session.id + '.json');
  const messages = Array.from({ length: 32 }, (_, n) => ({ id: 'message-' + String(n).padStart(3, '0'), role: n % 2 ? 'assistant' : 'user',
    text: ['x'.repeat(10400), '鲸'.repeat(85000), '🐳'.repeat(40000), '\0'.repeat(40000)][n % 4], at: 1 }));
  writeJsonAtomic(historyFile, { schemaVersion: 1, messages });
  const ui = createDesktopUiService({ services: { chatService: chat } });
  for (const [label, dispatch, method] of [['raw ChatService', request => chat.execute(request), 'chat.history'], ['UI projection', request => ui.execute(request), 'ui.chat.history']]) {
    await check(label + ' backward and forward paging preserves every message ID', async () => {
      const backward = []; let beforeMessageId;
      for (let i = 0; i < 101; i++) {
        const page = await rpc(dispatch, method, { id: session.id, limit: 100, ...(beforeMessageId ? { beforeMessageId } : {}) });
        assert.ok(page.messages.length); backward.unshift(...page.messages.map(row => row.id));
        if (!page.hasMore) break;
        assert.ok(page.nextBeforeMessageId); assert.notEqual(page.nextBeforeMessageId, beforeMessageId); beforeMessageId = page.nextBeforeMessageId;
      }
      assert.deepEqual(backward, messages.map(row => row.id)); assert.equal(new Set(backward).size, messages.length);
      const forward = []; let afterMessageId = messages[0].id;
      for (let i = 0; i < 101; i++) {
        const page = await rpc(dispatch, method, { id: session.id, limit: 100, afterMessageId });
        forward.push(...page.messages.map(row => row.id));
        assert.equal(typeof page.hasMoreAfter, 'boolean', 'forward continuation flag survives projection');
        if (!page.hasMoreAfter) break;
        assert.ok(page.nextAfterMessageId); assert.notEqual(page.nextAfterMessageId, afterMessageId); afterMessageId = page.nextAfterMessageId;
      }
      assert.deepEqual(forward, messages.slice(1).map(row => row.id)); assert.equal(new Set(forward).size, messages.length - 1);
    });
  }
  await check('UI projection budgets its own DTO expansion before actual framing', async () => {
    const dense = Array.from({ length: 100 }, (_, n) => ({ id: 'dense-' + n, role: 'assistant', text: 'a'.repeat(10400) }));
    writeJsonAtomic(historyFile, { schemaVersion: 1, messages: dense });
    const raw = await rpc(request => chat.execute(request), 'chat.history', { id: session.id, limit: 100 });
    const first = await rpc(request => ui.execute(request), 'ui.chat.history', { id: session.id, limit: 100 });
    assert.ok(first.messages.length > 0);
    assert.ok(first.messages.length < raw.messages.length, 'fixture exercises extra UI DTO budget trimming');
    const ids = [...first.messages.map(row => row.id)]; let before = first.nextBeforeMessageId; let more = first.hasMore;
    while (more) {
      const page = await rpc(request => ui.execute(request), 'ui.chat.history', { id: session.id, limit: 100, beforeMessageId: before });
      ids.unshift(...page.messages.map(row => row.id)); more = page.hasMore; before = page.nextBeforeMessageId;
    }
    assert.deepEqual(ids, dense.map(row => row.id));
  });
} finally { await chat?.close(); }

await check('formal ChatService commit retains persisted identity through bus and IPC', async () => {
  const bus = createDesktopUiEventBus(); let service; let dshSequence = 0;
  const api = {
    async callEndpoint(endpoint) {
      if (endpoint === 'session/create') return { sessionId: 'fixture-' + (++dshSequence) };
      if (endpoint === 'session/selectModel') return {};
      if (endpoint === 'session/prompt') return { accepted: true };
      if (endpoint === 'session/cancel') return {};
      throw new Error('Unexpected fixture endpoint ' + endpoint);
    },
    async *openRemoteStream(_endpoint, _params, { signal }) { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
  };
  service = createChatService({ stateDir: path.join(root, 'producer'), api, defaults: { provider: 'fixture', model: 'fixture' },
    onEvent: ({ event, data }) => bus.publish(event, data) });
  try {
    const session = await service.execute({ method: 'chat.sessions.create', params: {} });
    await service.execute({ method: 'chat.send', params: { id: session.id, text: 'fixture question' } });
    for (let i = 0; i < 100; i++) {
      const status = await service.execute({ method: 'chat.status', params: { id: session.id } });
      if (status.dshSessionId || dshSequence) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    service._injectEvent(session.id, { type: 'turn/start', data: { turn: 1 } });
    service._injectEvent(session.id, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '鲸桥🐳' } } });
    service._injectEvent(session.id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '鲸桥🐳' }] } } });
    service._injectEvent(session.id, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    const stored = readJsonFile(path.join(service._store.historyDir, session.id + '.json'));
    const assistant = stored.messages.findLast(row => row.role === 'assistant'); assert.ok(assistant, 'actual ChatService persisted assistant result');
    const events = await drain(bus);
    const committed = events.find(row => row.event === 'chat.updated' && row.data.messageId === assistant.id);
    assert.ok(committed, 'formal commit event survives bus + framed IPC');
    assert.equal(committed.data.turnId, assistant.turnId); assert.equal(committed.data.messageId, assistant.id);
    assert.equal(committed.data.historyRevision, stored.messages.length);
  } finally { await service.close(); }
});
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
