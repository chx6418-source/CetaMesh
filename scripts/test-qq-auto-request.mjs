import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autoReplyRequestId } from '../src/channel/qq/auto-request.js';
import { createQqTransport } from '../src/channel/qq/transport.js';
import { requireKnownQqSendResult } from '../src/channel/qq/send-result.js';

const turn = { sessionId: 'session-1', target: 'group:42', terminalSequence: 17 };
assert.equal(autoReplyRequestId({ ...turn, partIndex: 0 }), autoReplyRequestId({ ...turn, partIndex: 0 }),
  'the same native terminal event must retain its logical send identity after replay');
assert.notEqual(autoReplyRequestId({ ...turn, partIndex: 0 }), autoReplyRequestId({ ...turn, partIndex: 1 }),
  'each split message needs its own identity');
assert.notEqual(autoReplyRequestId({ ...turn, partIndex: 0 }), autoReplyRequestId({ ...turn, terminalSequence: 18, partIndex: 0 }),
  'a later turn may send identical text without content-based deduplication');
assert.notEqual(autoReplyRequestId({ ...turn, partIndex: 0 }), autoReplyRequestId({ ...turn, target: 'group:43', partIndex: 0 }),
  'two QQ groups must never share an automatic send identity');
assert.throws(() => autoReplyRequestId({ ...turn, terminalSequence: undefined, partIndex: 0 }),
  { code: 'QQ_AUTO_REQUEST_UNVERIFIED' }, 'an unsequenced turn cannot be safely retried');

const sends = [];
const transport = createQqTransport({ client: {
  sendPrivateMessage: (...args) => sends.push(args), sendGroupMessage: (...args) => sends.push(args)
}, textSegment: value => ({ type: 'text', data: { text: value } }) });
transport.send('group', '42', 'same text', { requestId: autoReplyRequestId({ ...turn, partIndex: 0 }) });
assert.equal(sends[0][2].requestId, autoReplyRequestId({ ...turn, partIndex: 0 }),
  'transport must carry the stable identity into QQ Runtime');
const bridgeSource = fs.readFileSync(path.resolve(import.meta.dirname, '../src/bridge.js'), 'utf8');
assert.match(bridgeSource, /const autoRequest = \{ sessionId, terminalSequence: event\.seq \}/,
  'Legacy automatic reply must derive its identity from the native terminal event');
assert.match(bridgeSource, /sendBurstToQQ\(key, messages, cfg\.social, undefined, autoRequest\)/,
  'all automatic split messages must pass their stable identity to the sender');
assert.throws(() => requireKnownQqSendResult({ status: 'outcome-unknown', requestId: 'auto:fixture' }),
  { code: 'QQ_OUTCOME_UNKNOWN', requestId: 'auto:fixture' },
  'an unknown SDK receipt cannot be reported as a completed automatic social reply');
assert.match(bridgeSource, /requireKnownQqSendResult\(result\)/,
  'Legacy automatic sender must consume the result status before updating social state');

console.log('PASS QQ automatic reply stable logical request identity');
