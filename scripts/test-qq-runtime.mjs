import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQqRuntime } from '../src/channel/qq/runtime.js';
import { createQqTransport } from '../src/channel/qq/transport.js';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.privateHandlers = [];
    this.groupHandlers = [];
    this.noticeHandlers = [];
    this.connectCalls = 0;
    this.sent = [];
    this.connection = null;
  }
  onPrivateMessage(handler) { this.privateHandlers.push(handler); }
  onGroupMessage(handler) { this.groupHandlers.push(handler); }
  onNotice(name, handler) { this.noticeHandlers.push({ name, handler }); }
  connect() {
    this.connectCalls += 1;
    return new Promise(resolve => { this.connection = resolve; });
  }
  sendPrivateMessage(id, payload) { this.sent.push(['private', id, payload]); }
  sendGroupMessage(id, payload) { this.sent.push(['group', id, payload]); }
}

const client = new FakeClient();
let factoryOptions;
const incoming = [];
const notices = [];
const runtime = createQqRuntime({
  config: { snowluma: { wsUrl: 'ws://127.0.0.1:6700', accessToken: 'token' } },
  clientFactory: options => { factoryOptions = options; return client; },
  onPrivateMessage: event => incoming.push(['private', event]),
  onGroupMessage: event => incoming.push(['group', event]),
  onNotice: event => notices.push(event),
  onOpen: () => notices.push('open'),
  onClose: () => notices.push('close'),
  log: () => {}
});
assert.equal(factoryOptions.url, 'ws://127.0.0.1:6700');
assert.equal(runtime.status().state, 'unknown');
const firstConnect = runtime.connect();
const secondConnect = await runtime.connect();
assert.equal(secondConnect.pending, true, 'concurrent connect is single-flight');
assert.equal(client.connectCalls, 1);
client.emit('open');
await Promise.resolve();
assert.equal(runtime.status().state, 'ready');
client.connection();
assert.equal((await firstConnect).connected, true);
await client.privateHandlers[0]({ user_id: 4 });
await client.groupHandlers[0]({ group_id: 5 });
await client.noticeHandlers[0].handler({ user_id: 8 });
assert.equal(incoming.length, 2);
assert.equal(notices[0], 'open');
assert.equal(notices[1].user_id, 8);
client.emit('close', { code: 1006 });
assert.equal(runtime.status().state, 'unavailable');
assert.equal(notices.at(-1), 'close');

const transport = createQqTransport({
  client,
  textSegment: value => ({ type: 'text', data: { text: value } })
});
await transport.send('private', '42', 'hello');
await transport.send('group', '43', 'hi');
assert.deepEqual(client.sent, [
  ['private', 42, { type: 'text', data: { text: 'hello' } }],
  ['group', 43, { type: 'text', data: { text: 'hi' } }]
]);

console.log('PASS QQ runtime connection lifecycle and basic transport adapter');
