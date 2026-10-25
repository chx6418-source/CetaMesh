import assert from 'node:assert/strict';
import { normalizeModelUsage, accumulateModelUsage } from '../src/model/usage.js';
const a = normalizeModelUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 70 }, completion_tokens_details: { reasoning_tokens: 8 } });
assert.equal(a.inputTokens, 100);
assert.equal(a.totalTokens, 120); // Cache and reasoning are subsets, never added again.
assert.equal(a.cacheReadTokens, 70);
assert.equal(a.reasoningTokens, 8);
assert.equal(a.cacheWriteTokens, null);
assert.equal(a.cacheHitRate, 0.7);
const b = normalizeModelUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 });
assert.equal(b.inputTokens, 100); // Anthropic input excludes cached input.
assert.equal(b.totalTokens, 105);
assert.equal(normalizeModelUsage({ prompt_tokens: 10 }).cacheHitRate, null);
assert.equal(normalizeModelUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }).cacheHitRate, 0);
assert.equal(normalizeModelUsage({ prompt_tokens: -1, completion_tokens: '5' }).inputTokens, null);
let sum = accumulateModelUsage(null, { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 70, secret: 'never retain' }, { requestId: 'a' });
sum = accumulateModelUsage(sum, { prompt_tokens: 50, completion_tokens: 10 }, { requestId: 'b' });
assert.equal(sum.inputTokens, 150);
assert.equal(sum.totalTokens, 180);
assert.equal(sum.cacheReadTokens, null); // Partial reporting is not a full total.
assert.equal(sum.cacheHitRate, null);
assert.equal(sum.requests[0].rawUsage.secret, undefined);
assert.equal(sum.requestCount, 2);
assert.deepEqual(accumulateModelUsage(sum, { prompt_tokens: 50 }, { requestId: 'b' }), sum);
assert.equal(accumulateModelUsage(sum, null, { requestId: 'c' }).inputTokens, null);
console.log('PASS model usage: subset accounting, unknown coverage, safe raw records, request deduplication');
const { createOpenAiCompatibleModelProvider } = await import('../src/model/providers/openai-compatible.js');
const bodies = [];
const provider = createOpenAiCompatibleModelProvider({ id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.test', defaultModel: 'fixture', supportsTools: true,
  secrets: { raw: () => ({ apiKey: 'fixture-key' }) }, fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ model: 'fixture', choices: [{ message: { content: 'ok' } }] }), { status: 200 }); } });
const x = { id: 'z.test', description: 'Z', inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } } };
const y = { id: 'a.test', description: 'A', inputSchema: { properties: {}, type: 'object' } };
await provider.chat({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], tools: [x, y] });
await provider.chat({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], tools: [y, { ...x, inputSchema: { properties: { a: { type: 'number' }, z: { type: 'string' } }, type: 'object' } }] });
assert.equal(JSON.stringify(bodies[0].tools), JSON.stringify(bodies[1].tools), 'schema serialization must not depend on registration/object key order');
console.log('PASS stable tool schemas without changing message sequence or schema array semantics');
assert.equal(provider.promptCacheCapabilities('fixture').status, 'unknown');
const cacheProvider = (id, baseUrl, model) => createOpenAiCompatibleModelProvider({ id, label: id, baseUrl, defaultModel: model, secrets: { raw: () => ({ apiKey: 'fixture-key' }) } });
assert.equal(cacheProvider('openai', 'https://api.openai.com/v1', 'gpt-4o-mini').promptCacheCapabilities().mode, 'automatic');
assert.equal(cacheProvider('openai', 'https://custom.test/v1', 'gpt-4o-mini').promptCacheCapabilities().status, 'unknown');
assert.equal(cacheProvider('openai', 'https://api.openai.com/v1', 'unverified-model').promptCacheCapabilities().status, 'unknown');
assert.equal(cacheProvider('deepseek-official', 'https://api.deepseek.com', 'deepseek-chat').promptCacheCapabilities().readUsageField, 'prompt_cache_hit_tokens');
assert.equal('prompt_cache_key' in bodies[0], false);
console.log('PASS conservative provider/model cache capabilities, custom endpoint unknown, no speculative cache parameters');

assert.equal(cacheProvider('deepseek-official', 'https://api.deepseek.com', 'deepseek-flash').promptCacheCapabilities().status, 'unknown');
assert.equal(cacheProvider('openai', 'https://api.openai.com/v1', 'gpt-5-unverified').promptCacheCapabilities().status, 'unknown');
assert.equal(cacheProvider('openai', 'https://api.openai.com/v1', 'gpt-4o-1999-01-01').promptCacheCapabilities().status, 'unknown');
const { createContinuityRuntime } = await import('../src/continuity/runtime.js');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ledger-once-'));
try {
  const options = { stateDir, taskRuntime: { get() {}, findByAgent: () => null }, agentBroker: { require() {}, send() {} } };
  let continuity = createContinuityRuntime(options);
  const pending = accumulateModelUsage(null, { prompt_tokens: 10, completion_tokens: 2 }, { requestId: 'turn-1:0' });
  const completed = accumulateModelUsage(pending, { prompt_tokens: 20, completion_tokens: 3 }, { requestId: 'turn-1:1' });
  await continuity.observeAgentTurn({ provider: 'cetamesh', sessionId: 'session', usage: pending });
  let observed = await continuity.observeAgentTurn({ provider: 'cetamesh', sessionId: 'session', usage: completed });
  assert.equal(observed.level.usedTokens, 35, 'pending then cumulative resume counts each provider request once');
  continuity = createContinuityRuntime(options);
  observed = await continuity.observeAgentTurn({ provider: 'cetamesh', sessionId: 'session', usage: completed });
  assert.equal(observed.level.usedTokens, 35, 'receipt identities survive continuity reload');
  await continuity.observeAgentTurn({ provider: 'cetamesh', sessionId: 'session', usage: { ...completed, accountingComplete: false } });
  continuity = createContinuityRuntime(options);
  assert.equal(continuity.monitor.level('cetamesh:session').accountingComplete, false,
    'revised completeness on duplicate receipts persists across reload');
  const interrupted = accumulateModelUsage(completed, null, { requestId: 'turn-1:failed' });
  observed = await continuity.observeAgentTurn({ provider: 'cetamesh', sessionId: 'session', usage: interrupted });
  assert.equal(observed.level.usedTokens, 35);
  assert.equal(observed.level.accountingComplete, false, 'known subtotal is not a measured zero for missing usage');
  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'continuity', 'monitor.json'), 'utf8'));
  assert.equal(persisted.sessions['cetamesh:session'].accountedRequestIds.length, 2);
  console.log('PASS Continuity pending/resume/reload accounting is exactly once');
} finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
{
  const first = accumulateModelUsage(null, { inputTokens: 44, outputTokens: 1, windowTokens: 100 }, { requestId: 'window:0' });
  const second = accumulateModelUsage(first, { inputTokens: 44, outputTokens: 1, windowTokens: 100 }, { requestId: 'window:1' });
  assert.equal(second.windowTokens, 100, 'model context window is latest metadata, never a summed usage metric');
  assert.equal(second.requests[0].windowTokens, 100);
  assert.equal(second.requests[0].rawUsage.windowTokens, 100);
  assert.equal(accumulateModelUsage(second, { inputTokens: 1, outputTokens: 1 }, { requestId: 'window:2' }).windowTokens, 100);
  console.log('PASS model window metadata survives ledger accumulation without summing');
}
