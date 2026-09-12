// DSH 0.1.5+ API 探测脚本：校验 Cookie 鉴权与 remote.mux 流协议的线上行为。
// 用法：node scripts/probe-dsh-api.mjs [baseUrl]
// 会创建一个一次性会话并 prompt 一句，观察事件帧后取消并归档清理。
import WebSocket from 'ws';
import { resolveDshAuthCookie } from '../src/dsh-auth.js';

const baseUrl = process.argv[2] || 'http://127.0.0.1:3080';
const base = baseUrl.replace(/\/+$/, '');
const cookie = resolveDshAuthCookie(baseUrl, process.env.DSH_AUTH_COOKIE);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let rpcSeq = 0;
async function call(endpoint, args) {
  const rpcId = `probe-${++rpcSeq}`;
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const full = JSON.parse(text);
  if (full.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId 不匹配`);
  if (!full.result.ok) throw new Error(`${endpoint}: ${JSON.stringify(full.result.error).slice(0, 300)}`);
  return full.result.value;
}

// ---- 1. unary 探活 + 会话列表 ----
log('[1] cookie:', cookie.slice(0, 40) + '…');
const list = await call('session/list', { _request: {} });
log('[1] session/list ok, sessions:', Array.isArray(list) ? list.length : Object.keys(list ?? {}).length);

// ---- 2. remote.mux 事件流 ----
let eventsClientId = null; // $events ready 帧分配的 clientId（应答瀑布事件必须携带）
const wsUrl = base.replace(/^http/, 'ws') + '/api/remote.mux';
const socket = new WebSocket(wsUrl, { headers: { cookie } });
let streamSeq = 0;
const pendingStreams = new Map();
const inboxByStream = new Map();
function openStream(endpoint, payload) {
  const streamId = `s${++streamSeq}`;
  const inbox = [];
  let wake;
  pendingStreams.set(streamId, endpoint);
  inboxByStream.set(streamId, { inbox, get wake() { return wake; }, set wake(v) { wake = v; } });
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
  return (async function* () {
    for (;;) {
      while (inbox.length > 0) {
        const item = inbox.shift();
        if (item.kind === 'end') return;
        if (item.kind === 'error') throw new Error(`stream ${endpoint}: ${JSON.stringify(item.error)}`);
        yield item.value;
      }
      await new Promise((r) => { wake = r; });
    }
  })();
}
function pushStream(streamId, item) {
  const box = inboxByStream.get(streamId);
  if (!box) return;
  box.inbox.push(item);
  box.wake?.();
  box.wake = undefined;
}
socket.on('open', () => log('[2] remote.mux 已连接'));
socket.on('close', (code, reason) => log('[2] remote.mux 关闭:', code, String(reason || '')));
socket.on('error', (err) => log('[2] remote.mux 错误:', err.message));
socket.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'item') {
    if (pendingStreams.get(msg.streamId) === '$events' && msg.value?.clientId) eventsClientId = msg.value.clientId;
    log(`[2] ▶ item stream=${msg.streamId}(${pendingStreams.get(msg.streamId)})`, JSON.stringify(msg.value).slice(0, 220));
  } else if (msg.type === 'end') {
    log(`[2] ⏹ end stream=${msg.streamId}(${pendingStreams.get(msg.streamId)})`);
  } else if (msg.type === 'error') {
    log(`[2] ✗ error stream=${msg.streamId}(${pendingStreams.get(msg.streamId)})`, JSON.stringify(msg.error).slice(0, 200));
  } else {
    log('[2] ?', JSON.stringify(msg).slice(0, 200));
  }
  pushStream(msg.streamId, msg.type === 'item' ? { kind: 'item', value: msg.value } : msg.type === 'end' ? { kind: 'end' } : { kind: 'error', error: msg.error });
});

await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const eventsIterator = openStream('$events', { args: {} });
const eventsDone = (async () => {
  try { for await (const v of eventsIterator) { /* message 处已打印 */ } } catch (e) { log('[2] $events 流错误:', e.message); }
})();
await new Promise((r) => setTimeout(r, 500));

// ---- 3. 创建一次性会话 + follow + prompt ----
log('[3] session/create …');
const created = await call('session/create', { request: {} });
log('[3] created:', JSON.stringify(created));
const sessionId = created.sessionId;

const followIterator = openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId } } } });
const followDone = (async () => {
  try {
    for await (const value of followIterator) { /* 已在 message 处打印 */ }
  } catch (e) { log('[3] follow 流错误:', e.message); }
})();

await new Promise((r) => setTimeout(r, 800));
log('[3] session/prompt …');
const promptValue = await call('session/prompt', {
  request: {
    requestId: `probe-req-${Date.now()}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '请只回复两个字：收到' }]
  }
});
log('[3] prompt 响应:', JSON.stringify(promptValue));

// 观察 20 秒 turn 事件
await new Promise((r) => setTimeout(r, 20000));

// ---- 3.5 触发提问瀑布并应答 ----
log('[3.5] 触发 ask_user_question …');
const waterfalls = [];
socket.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.streamId && pendingStreams.get(msg.streamId) === '$events' && msg.type === 'item') {
      if (msg.value?.type === 'ready') eventsClientId = msg.value.clientId;
      if (msg.value?.type === 'waterfall') waterfalls.push(msg.value);
    }
  } catch {}
});
await call('session/prompt', {
  request: {
    requestId: `probe-q-${Date.now()}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '请调用 ask_user_question 工具问我一个问题：你好吃什么？(options: 苹果/香蕉)' }]
  }
});
let wf = null;
for (let i = 0; i < 60 && !wf; i++) {
  await new Promise((r) => setTimeout(r, 500));
  wf = waterfalls.find((w) => w.event === 'user-questions/request');
}
if (wf) {
  log('[3.5] 瀑布事件完整结构:', JSON.stringify(wf));
  try {
    const outcomeValue = { answers: (wf.request?.questions ?? wf.request?.args?.questions ?? []).map((q) => ({ id: q.id, selected: q.options?.[0] ? [q.options[0].label] : [], custom: '' })) };
    await call('$events/result', { clientId: eventsClientId, eventId: wf.eventId, outcome: { kind: 'result', value: outcomeValue } });
    log('[3.5] 已应答提问 clientId=', eventsClientId);
  } catch (e) {
    log('[3.5] 应答失败:', e.message);
  }
} else {
  log('[3.5] 30 秒内未观察到提问瀑布（该 preset 可能未启用 ask_user 或模型未调用）');
}
await new Promise((r) => setTimeout(r, 15000));

// ---- 4. 清理 ----
try { await call('session/cancel', { request: { sessionId } }); log('[4] session/cancel ok'); } catch (e) { log('[4] session/cancel:', e.message); }
try { await call('workspace/archiveSession', { request: { sessionId } }); log('[4] archiveSession ok'); } catch (e) { log('[4] archiveSession:', e.message); }
socket.close();
await Promise.race([eventsDone, new Promise((r) => setTimeout(r, 1000))]);
process.exit(0);
