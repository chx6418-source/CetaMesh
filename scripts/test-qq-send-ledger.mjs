import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQqSendLedger } from '../src/channel/qq/send-ledger.js';
import { interpretQqDataSendResponse } from '../src/channel/qq/send-result.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-qq-send-ledger-'));
const file = path.join(root, 'ledger.json');
try {
  const ledger = createQqSendLedger(file, { maxRecords: 4 });
  const input = { requestId: 'turn-1:0', accountId: '10001', kind: 'text', target: 'group:42', action: 'send_group_msg', payload: [{ type: 'text', data: { text: 'same content' } }] };
  const first = ledger.claim(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.record.status, 'outcome-unknown', 'durable intent precedes external side effect');
  assert.equal(ledger.claim(input).duplicate, true);
  assert.throws(() => ledger.claim({ ...input, target: 'group:43' }), { code: 'QQ_REQUEST_ID_CONFLICT' });
  const second = ledger.claim({ ...input, requestId: 'turn-2:0' });
  assert.equal(second.duplicate, false, 'same content with a distinct requestId must remain a distinct send');
  ledger.ack('10001', 'turn-1:0', { message_id: 987 });
  ledger.ack('10001', 'turn-1:0', { message_id: 987 });
  assert.equal(ledger.get('10001', 'turn-1:0').status, 'sent');
  assert.equal(ledger.get('10001', 'turn-1:0').receipt.message_id, '987');
  assert.throws(() => ledger.ack('10001', 'turn-1:0', { message_id: 988 }), { code: 'QQ_RECEIPT_CONFLICT' });
  assert.equal(ledger.get('10001', 'turn-2:0').status, 'outcome-unknown');
  const restarted = createQqSendLedger(file, { maxRecords: 4 });
  assert.equal(restarted.claim(input).duplicate, true, 'process restart must not dispatch a completed request again');
  assert.equal(restarted.claim({ ...input, requestId: 'turn-2:0' }).record.status, 'outcome-unknown', 'unknown outcome must survive restart');
  assert.equal(restarted.claim({ ...input, requestId: 'turn-2:0' }).duplicate, true);
  assert.equal(restarted.claim({ ...input, requestId: 'turn-3:0', accountId: '10002' }).duplicate, false, 'account identity namespaces request IDs');
  assert.equal(restarted.claim({ ...input, requestId: 'turn-4:0' }).duplicate, false);
  assert.throws(() => restarted.claim({ ...input, requestId: 'turn-5:0' }), { code: 'QQ_SEND_LEDGER_FULL' });
  const corrupt = path.join(root, 'corrupt.json');
  fs.writeFileSync(corrupt, '{broken', 'utf8');
  assert.throws(() => createQqSendLedger(corrupt).claim(input), { code: 'QQ_SEND_LEDGER_UNAVAILABLE' });
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{broken', 'corrupt evidence is never overwritten');
  const actionLedger = createQqSendLedger(path.join(root, 'actions.json'));
  actionLedger.claim({ requestId: 'action-1', accountId: '10001', kind: 'custom-face', target: 'private:10001',
    action: 'modify_custom_face', payload: { emoji_id: 5, desc: 'fixture' } });
  assert.equal(actionLedger.ack('10001', 'action-1', { status: 'ok', retcode: 0 }).status, 'acknowledged',
    'a gateway success response is evidence of acceptance, not a fabricated message ID');
  assert.throws(() => interpretQqDataSendResponse({ ok: true, status: 202,
    json: { ok: false, code: 'QQ_OUTCOME_UNKNOWN', requestId: 'turn-2:0' } }), { code: 'QQ_OUTCOME_UNKNOWN' });
  assert.deepEqual(interpretQqDataSendResponse({ ok: true, status: 200,
    json: { ok: true, data: { duplicate: true, status: 'sent', receipt: { message_id: '987' } } } }),
    { message_id: '987', duplicate: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('PASS QQ outbound ledger identity, durable unknown, receipts and recovery');
