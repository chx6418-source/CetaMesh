import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { OneBotWebSocketClient, text } from '../src/channel/qq/onebot-client.js';
import { createQqRuntime } from '../src/channel/qq/runtime.js';

const server = http.createServer();
const wss = new WebSocketServer({ server });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}`;
const requests = [];
let socket;
let authorization;
let accountId = 10001;
wss.on('connection', (peer, request) => {
  socket = peer;
  authorization = request.headers.authorization;
  peer.on('message', bytes => {
    const requestFrame = JSON.parse(bytes);
    requests.push(requestFrame);
    if (requestFrame.action === 'hold') return;
    const data = requestFrame.action === 'get_login_info' ? { user_id: accountId } : { message_id: 9 };
    peer.send(JSON.stringify({ status: requestFrame.action === 'fail' ? 'failed' : 'ok',
      retcode: requestFrame.action === 'fail' ? 100 : 0, data, echo: requestFrame.echo }));
  });
});

const client = new OneBotWebSocketClient({ url, accessToken: 'unit-token', reconnect: false,
  requestTimeoutMs: 100, maxPendingRequests: 2 });
try {
  const opens = [client.connect(), client.connect()];
  await Promise.all(opens);
  assert.equal(wss.clients.size, 1, 'concurrent connection requests share one socket');
  assert.equal(authorization, 'Bearer unit-token');
  assert.deepEqual(await client.getLoginInfo(), { user_id: 10001 });
  assert.deepEqual(await client.sendGroupMessage(42, text('[CQ:image,file=untrusted]')), { message_id: 9 });
  assert.deepEqual(requests.at(-1).params.message, [{ type: 'text', data: { text: '[CQ:image,file=untrusted]' } }],
    'text stays a structured segment and cannot become a CQ action');
  const privateEvent = once(client, 'private-message');
  socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 7, self_id: 10001 }));
  assert.equal((await privateEvent)[0].user_id, 7);
  const groupEvents = [];
  client.onGroupMessage(event => groupEvents.push(event));
  socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 42 }));
  for (let i = 0; i < 30 && !groupEvents.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(groupEvents[0].group_id, 42);
  let notified = false;
  client.onNotice('notify', () => { notified = true; });
  socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' }));
  for (let i = 0; i < 30 && !notified; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(notified, true);
  assert.equal((await client.request('fail')).retcode, 100, 'request preserves the protocol envelope');
  await assert.rejects(client.raw('fail'), { code: 'ONEBOT_API_FAILED' });
  await assert.rejects(client.raw('hold'), { code: 'ONEBOT_TIMEOUT' });
  const blocked = [client.raw('hold'), client.raw('hold')];
  const closed = Promise.allSettled(blocked);
  await assert.rejects(client.raw('get_login_info'), { code: 'ONEBOT_QUEUE_FULL' });
  socket.close();
  const outcomes = await closed;
  assert.ok(outcomes.every(x => x.status === 'rejected' && x.reason.code === 'ONEBOT_DISCONNECTED'));
  assert.equal(requests.filter(x => x.action === 'send_group_msg').length, 1, 'writes are never automatically replayed');
  await assert.rejects(client.getStatus(), { code: 'ONEBOT_NOT_CONNECTED' });
  await client.connect();
  await client.getGroupMemberInfo(42, 7);
  assert.deepEqual(requests.at(-1).params, { group_id: 42, user_id: 7, no_cache: false });
  await client.getGroupMemberList(42);
  assert.equal(requests.at(-1).action, 'get_group_member_list');
  await client.getMessage(9);
  assert.equal(requests.at(-1).action, 'get_msg');
  await client.getImage({ file: 'fixture.png' });
  assert.deepEqual(requests.at(-1).params, { file: 'fixture.png' });
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!Object.keys(pkg.dependencies).some(name => name.startsWith('@snowluma/')));
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.ok(!Object.keys(lock.packages).some(name => name.includes('node_modules/@snowluma/')));
  const runtime = createQqRuntime({ config: { snowluma: { wsUrl: url } },
    clientFactory: options => new OneBotWebSocketClient({ ...options, reconnectDelayMs: 10 }) });
  try {
    assert.equal((await runtime.connect()).ok, true);
    let before = requests.filter(x => x.action === 'get_login_info').length;
    socket.close();
    for (let i = 0; i < 100 && (requests.filter(x => x.action === 'get_login_info').length === before || !runtime.status().ready); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(runtime.status().ready, true, 'automatic reconnect revalidates and restores readiness');
    before = requests.filter(x => x.action === 'get_login_info').length;
    accountId = 20002;
    socket.close();
    for (let i = 0; i < 100 && requests.filter(x => x.action === 'get_login_info').length === before; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runtime.status().ready, false, 'changed account never becomes ready after reconnect');
  } finally { await runtime.stop(); }
  console.log('PASS SDK-free OneBot auth, events, RPC, structured messages, bounds and disconnect safety');
} finally {
  client.close();
  for (const peer of wss.clients) peer.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
