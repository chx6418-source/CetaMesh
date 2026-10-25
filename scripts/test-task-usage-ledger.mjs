import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, estimateUsageCost } from '../src/model/usage-ledger.js';
import { accumulateModelUsage } from '../src/model/usage.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-usage-ledger-'));
try {
  const file = path.join(dir, 'ledger.json');
  const price = { providerId: 'fixture', model: 'fixture-model', currency: 'USD', source: 'fixture declared tariff', version: 'fixture-v1',
    inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 1, cacheWritePerMillion: 3 };
  let ledger = createUsageLedger({ file, pricingResolver: () => price });
  let usage = accumulateModelUsage(null, { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, cacheWriteTokens: 0 }, { requestId: 'r1', providerId: 'fixture', model: 'fixture-model' });
  const first = { sessionId: 's1', taskId: 'task-a', turnId: 'turn-a', usage };
  ledger.record(first);
  assert.equal(ledger.summary({ taskId: 'task-a' }).inputTokens, 100);
  assert.equal(ledger.summary({ taskId: 'task-a' }).cost.status, 'estimated');
  assert.equal(ledger.summary({ taskId: 'task-a' }).cost.amount, 0.00022);
  const anthropic = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 };
  assert.equal(estimateUsageCost(anthropic, price, { providerId: 'fixture', model: 'fixture-model' }).amount, 0.00015);
  const reasoning = { inputTokens: 100, outputTokens: 20, reasoningTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateUsageCost(reasoning, price, { providerId: 'fixture', model: 'fixture-model' }).amount, 0.00028, 'reasoning is not billed twice');
  assert.equal(estimateUsageCost(reasoning, price, { providerId: 'other', model: 'fixture-model' }).amount, null);
  assert.equal(estimateUsageCost({ inputTokens: 100, outputTokens: 20 }, { ...price, cacheReadPerMillion: 2, cacheWritePerMillion: 2 }, { providerId: 'fixture', model: 'fixture-model' }).amount, 0.00028);
  assert.throws(() => ledger.record({ ...first, usage: { ...usage, requests: usage.requests.map(row => ({ ...row, model: 'other-model' })) } }), { code: 'USAGE_RECEIPT_CONFLICT' });
  ledger.record(first);
  ledger = createUsageLedger({ file, pricingResolver: () => ({ ...price, inputPerMillion: 99 }) });
  ledger.record(first);
  assert.equal(ledger.summary({ taskId: 'task-a' }).requestCount, 1);
  assert.equal(ledger.summary({ taskId: 'task-a' }).cost.amount, 0.00022, 'persisted tariff snapshot is immutable');
  usage = accumulateModelUsage(usage, { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 0, cacheWriteTokens: 0 }, { requestId: 'r2', providerId: 'fixture', model: 'fixture-model' });
  ledger.record({ ...first, usage });
  assert.equal(ledger.summary({ taskId: 'task-a' }).inputTokens, 150);
  const other = accumulateModelUsage(null, { prompt_tokens: 7, completion_tokens: 2 }, { requestId: 'r3', providerId: 'fixture', model: 'fixture-model' });
  ledger.record({ sessionId: 's1', taskId: 'task-b', turnId: 'turn-b', usage: other });
  assert.equal(ledger.summary({ taskId: 'task-a' }).inputTokens, 150);
  assert.equal(ledger.summary({ taskId: 'task-b' }).inputTokens, 7);
  assert.equal(ledger.summary({ sessionId: 's1' }).inputTokens, 157);
  assert.equal(ledger.summary({ taskId: 'task-b' }).cost.amount, null, 'missing cache breakdown cannot invent cost');
  const tree = ledger.summary({ taskIds: ['task-a', 'task-b', 'task-a'] });
  assert.equal(tree.requestCount, 3, 'parent and child requests are counted once');
  assert.equal(tree.inputTokens, 157);
  assert.equal(tree.cost.amount, null, 'unknown child cost keeps parent cost unknown');
  assert.throws(() => ledger.record({ ...first, taskId: 'task-b' }), { code: 'USAGE_ATTRIBUTION_CONFLICT' });
  const failed = accumulateModelUsage(usage, null, { requestId: 'failed', providerId: 'fixture', model: 'fixture-model' });
  ledger.record({ ...first, usage: { ...failed, accountingComplete: false } });
  assert.equal(ledger.summary({ taskId: 'task-a' }).inputTokens, null);
  assert.equal(ledger.summary({ taskId: 'task-a' }).knownUsage.inputTokens, 150);
  assert.equal(ledger.summary({ taskId: 'task-a' }).accountingComplete, false);
  assert.equal(ledger.summary({ taskId: 'task-a' }).cost.amount, null);
  assert.ok(ledger.summary({ taskId: 'task-a' }).cost.knownAmount > 0);
  ledger.record({ sessionId: 's2', taskId: null, turnId: 'legacy', usage: null });
  ledger.record({ sessionId: 's2', taskId: null, turnId: 'legacy', usage: null });
  assert.equal(ledger.summary({ sessionId: 's2' }).requestCount, 1);
  assert.equal(ledger.summary({ taskId: 'missing' }).inputTokens, null);
  ledger.record({ sessionId: 'billed', turnId: 'billing', taskId: 'billing-task', usage: accumulateModelUsage(null, {
    inputTokens: 100, outputTokens: 20, billingReceipt: { kind: 'actual', amount: 0.01, currency: 'USD', source: 'fixture-provider', receiptId: 'invoice-fixture', apiKey: 'DO_NOT_STORE' }
  }, { requestId: 'invoice-request', providerId: 'fixture', model: 'fixture-model' }) });
  assert.equal(ledger.summary({ taskId: 'billing-task' }).cost.status, 'actual');
  assert.equal(ledger.summary({ taskId: 'billing-task' }).cost.amount, 0.01);
  ledger.record({ sessionId: 'cancelled', turnId: 'cancelled-turn', taskId: 'cancelled-task', usage: { accountingComplete: false,
    requests: [{ requestId: 'cancelled-request', inputTokens: 12, outputTokens: null }] } });
  assert.equal(ledger.summary({ taskId: 'cancelled-task' }).knownUsage.inputTokens, 12);
  assert.equal(ledger.summary({ taskId: 'cancelled-task' }).accountingComplete, false);
  const bounded = createUsageLedger({ file: path.join(dir, 'bounded.json'), maxReceipts: 1 });
  bounded.record({ sessionId: 'bounded', turnId: 'a', usage: null });
  assert.throws(() => bounded.record({ sessionId: 'bounded', turnId: 'b', usage: null }), { code: 'USAGE_LEDGER_FULL' });
  assert.equal(bounded.summary({ sessionId: 'bounded' }).requestCount, 1, 'full store never drops old evidence');
  assert.equal(ledger.summary({ sessionIds: ['s1', 's1', 'billed'] }).requestCount, ledger.summary({ sessionId: 's1' }).requestCount + 1, 'native session aliases dedup before summing');
  for (const nativeId of ['native-1', 'native-2']) ledger.record({ sessionId: nativeId, turnId: `turn-${nativeId}`, taskId: 'reattached-task',
    usage: accumulateModelUsage(null, { inputTokens: 10, outputTokens: 2,
      billingReceipt: { kind: 'actual', amount: 0.01, currency: 'USD', source: 'fixture', receiptId: `invoice-${nativeId}` }
    }, { requestId: `request-${nativeId}`, providerId: 'fixture', model: 'fixture-model' }) });
  assert.equal(ledger.summary({ sessionIds: ['native-1', 'native-2', 'native-1'] }).cost.amount, 0.02);
  assert.equal(ledger.summary({ taskId: 'reattached-task' }).cost.amount, 0.02, 'alias aggregation never writes duplicate task receipts');
  const byteFile = path.join(dir, 'byte-cap.json');
  const seed = createUsageLedger({ file: byteFile, now: () => 1 });
  seed.record({ sessionId: 'byte-cap', turnId: 'first', usage: null });
  const originalBytes = fs.readFileSync(byteFile);
  const byteBounded = createUsageLedger({ file: byteFile, maxBytes: originalBytes.length, now: () => 1 });
  assert.throws(() => byteBounded.record({ sessionId: 'byte-cap', turnId: '第二个', usage: null }), { code: 'USAGE_LEDGER_FULL' });
  assert.deepEqual(fs.readFileSync(byteFile), originalBytes, 'byte cap rejects before atomic replacement');
  assert.equal(byteBounded.summary({ sessionId: 'byte-cap' }).requestCount, 1, 'prior file remains readable at exact byte boundary');
  assert.throws(() => createUsageLedger({ file: byteFile, maxBytes: 0 }), { code: 'USAGE_LEDGER_CONFIG_INVALID' });
  const unresolved = accumulateModelUsage(null, { inputTokens: 10, outputTokens: 2 }, { requestId: 'unknown-model', providerId: 'fixture', model: null });
  ledger.record({ sessionId: 'resolving', turnId: 'resolving-turn', usage: unresolved, model: null });
  const resolved = accumulateModelUsage(unresolved, { inputTokens: 20, outputTokens: 4 }, { requestId: 'known-model', providerId: 'fixture', model: 'actual-fixture' });
  ledger.record({ sessionId: 'resolving', turnId: 'resolving-turn', usage: resolved, model: 'actual-fixture' });
  const failedAfterResolved = accumulateModelUsage(resolved, null, { requestId: 'failed-model', providerId: null, model: null });
  ledger.record({ sessionId: 'resolving', turnId: 'resolving-turn', usage: failedAfterResolved, providerId: 'fixture', model: 'actual-fixture' });
  const resolvingRows = JSON.parse(fs.readFileSync(file, 'utf8')).receipts.filter(row => row.sessionId === 'resolving');
  assert.deepEqual(resolvingRows.map(row => row.model), [null, 'actual-fixture', null]);
  assert.equal(resolvingRows[2].providerId, null, 'explicit unknown identity never inherits the preceding request');
  assert.throws(() => ledger.summary({}), { code: 'USAGE_SCOPE_REQUIRED' });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(JSON.stringify(stored).includes('apiKey'), false);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => createUsageLedger({ file }).summary({ sessionId: 's1' }), { code: 'USAGE_STORE_UNAVAILABLE' });
  console.log('PASS durable task usage ledger: attribution, replay, restart, pricing provenance, unknown/partial, fail-closed storage');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
