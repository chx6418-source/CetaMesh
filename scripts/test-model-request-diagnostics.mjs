import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { aggregateModelUsage, accumulateModelUsage } from '../src/model/usage.js';
import { createUsageLedger } from '../src/model/usage-ledger.js';
import { createOpenAiCompatibleModelProvider, createModelProviderRegistry, createModelRuntimeService, createToolExecutionCoordinator } from '../src/model/index.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';

const failures = [];
async function check(name, test) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
await check('mixed cache reports keep full totals unknown and paired denominators explicit', () => {
  let usage = accumulateModelUsage(null, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 0 }, { requestId: 'a' });
  usage = accumulateModelUsage(usage, { inputTokens: 200, outputTokens: 20 }, { requestId: 'b' });
  usage = accumulateModelUsage(usage, { cacheReadTokens: 9 }, { requestId: 'c' });
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.cacheHitRate, null);
  assert.equal(usage.knownUsage.inputTokens, 300);
  assert.equal(usage.knownUsage.cacheReadTokens, 69);
  assert.deepEqual(usage.cacheCoverage, { totalRequests: 3, inputReportedRequests: 2, knownInputTokens: 300,
    read: { reportedRequests: 2, inputReportedRequests: 1, knownInputTokens: 100, knownTokens: 69, matchedReadTokens: 60, reportedHitRate: 0.6 },
    write: { reportedRequests: 1, inputReportedRequests: 1, knownInputTokens: 100, knownTokens: 0 } });
  assert.equal(accumulateModelUsage(usage, { inputTokens: 999 }, { requestId: 'a' }), usage, 'duplicate final cannot replace an established receipt');
  assert.equal(aggregateModelUsage([]).cacheCoverage.read.reportedRequests, 0);
  assert.equal(aggregateModelUsage([{ inputTokens: 10, cacheReadTokens: 0 }]).cacheCoverage.read.reportedHitRate, 0);
  assert.equal(aggregateModelUsage([{ inputTokens: 10, cacheReadTokens: 20 }]).cacheCoverage.read.reportedHitRate, null);
  const snapshots = aggregateModelUsage([{ inputTokens: 100, cacheReadTokens: 50 }, { inputTokens: 200, cacheReadTokens: 100 }], { granularity: 'snapshot' });
  assert.equal(snapshots.cacheCoverage, null);
  assert.equal(snapshots.inputTokens, 300);
  assert.equal(snapshots.knownUsage.cacheReadTokens, 150);
});
await check('legacy turn snapshots preserve six requests without inventing per-request cache report coverage in Chat or mixed Core DTO', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-snapshot-coverage-'));
  const chat = createChatService({ stateDir });
  try {
    const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
    const file = path.join(stateDir, 'desktop-chat', 'history', `${session.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ messages: [1, 2].map(i => ({ id: `turn-${i}`, role: 'assistant',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, requestCount: 3 } })) }));
    const page = await chat.execute({ method: 'chat.history', params: { id: session.id, limit: 1 } });
    assert.equal(page.sessionUsage.requestCount, 6);
    assert.equal(page.sessionUsage.inputTokens, 200);
    assert.equal(page.sessionUsage.cacheReadTokens, 100);
    assert.equal(page.sessionUsage.knownUsage.inputTokens, 200);
    assert.equal(page.sessionUsage.cacheCoverage, null, 'two aggregated turns cannot prove that two of six provider requests reported cache reads');
    const legacyUi = createDesktopUiService({ services: { chatService: chat } });
    const legacy = await legacyUi.execute({ method: 'ui.chat.history', params: { id: session.id } });
    assert.equal(legacy.sessionUsage.requestCount, 6);
    assert.equal(legacy.sessionUsage.cacheCoverage, null);
    const ledger = createUsageLedger({ file: path.join(stateDir, 'partial-ledger.json') });
    ledger.record({ sessionId: session.id, turnId: 'measured', usage: accumulateModelUsage(null,
      { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0 }, { requestId: 'measured' }) });
    const mixedUi = createDesktopUiService({ services: { chatService: chat, usageLedger: ledger } });
    const mixed = await mixedUi.execute({ method: 'ui.chat.history', params: { id: session.id } });
    assert.equal(mixed.sessionUsage.requestCount, 6);
    assert.equal(mixed.sessionUsage.inputTokens, 200, 'partial ledger must not hide the wider historical totals');
    assert.equal(mixed.sessionUsage.accountingComplete, false);
    assert.equal(mixed.sessionUsage.cacheCoverage, null, 'fallback cannot relabel turn-snapshot reporting as request-level coverage');
    assert.equal(ledger.summary({ sessionId: session.id }).cacheCoverage.totalRequests, 1, 'real receipt coverage remains request-scoped');
  } finally { await chat.close(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});
await check('synthetic legacy continuations retain tokens but leave request coverage and diagnostic request counts unknown', () => {
  const previous = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, requestCount: 3 };
  let resumed = accumulateModelUsage(previous, { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0 }, { requestId: 'resumed' });
  assert.equal(resumed.inputTokens, 120);
  assert.equal(resumed.knownUsage.cacheReadTokens, 50);
  assert.equal(resumed.cacheCoverage, null, 'synthetic legacy entry is an aggregate snapshot, not one observed provider request');
  assert.equal(resumed.requestDiagnostics, null, 'snapshot rows cannot establish a diagnostic request-count denominator');
  resumed = accumulateModelUsage(resumed, { inputTokens: 30, outputTokens: 3, cacheReadTokens: 0 }, { requestId: 'again' });
  assert.equal(resumed.inputTokens, 150);
  assert.equal(resumed.cacheCoverage, null, 'snapshot semantics survive subsequent actual receipts');
  assert.equal(resumed.requestDiagnostics, null);
});
await check('new and old v1 ledger snapshots retain totals without inventing report or diagnostic request coverage', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-synthetic-coverage-'));
  try {
    const file = path.join(stateDir, 'new.json');
    let ledger = createUsageLedger({ file });
    const receipt = { sessionId: 'snapshot', turnId: 'snapshot', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, requestCount: 3 } };
    const recorded = ledger.record(receipt);
    assert.equal(recorded.inputTokens, 100);
    assert.equal(recorded.cacheCoverage, null);
    assert.equal(recorded.requestDiagnostics, null);
    ledger.record(receipt);
    ledger = createUsageLedger({ file });
    assert.equal(ledger.summary({ sessionId: 'snapshot' }).cacheCoverage, null);
    assert.equal(ledger.summary({ sessionId: 'snapshot' }).requestDiagnostics, null);
    ledger.record({ sessionId: 'snapshot', turnId: 'actual', usage: accumulateModelUsage(null,
      { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0 }, { requestId: 'actual' }) });
    assert.equal(ledger.summary({ sessionId: 'snapshot' }).inputTokens, 120);
    assert.equal(ledger.summary({ sessionId: 'snapshot' }).knownUsage.cacheReadTokens, 50);
    assert.equal(ledger.summary({ sessionId: 'snapshot' }).cacheCoverage, null);
    const legacyFile = path.join(stateDir, 'v1.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, receipts: [{ sessionId: 'old', turnId: 'old', taskId: null,
      requestId: 'snapshot:old', providerId: null, model: null, usage: { inputTokens: 80, cacheReadTokens: 40 }, accountingComplete: false }] }));
    const original = fs.readFileSync(legacyFile);
    const old = createUsageLedger({ file: legacyFile }).summary({ sessionId: 'old' });
    assert.equal(old.inputTokens, 80);
    assert.equal(old.cacheCoverage, null);
    assert.equal(old.requestDiagnostics, null);
    assert.deepEqual(fs.readFileSync(legacyFile), original, 'old v1 observation does not migrate or rewrite production-compatible storage');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

const captures = [];
let failTransport = false;
const server = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  captures.push({ raw, path: request.url });
  const body = JSON.parse(raw);
  if (failTransport) { response.writeHead(503); response.end('{"error":{"message":"fixture failure"}}'); return; }
  const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } };
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ model: 'observed-model', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: 'observed-model', choices: [{ message: { content: 'ok' } }], usage }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/tenant-private/v1`;
const apiKey = 'fixture-only-credential-do-not-retain';
const secrets = { raw: () => ({ apiKey }), list: () => [{ provider: 'fixture' }] };
const provider = createOpenAiCompatibleModelProvider({ id: 'fixture', label: 'Fixture', baseUrl, defaultModel: 'fixture-model', supportsTools: true,
  imageProfiles: { 'fixture-model': { supported: true, baseUrl } }, secrets });
const request = { model: 'fixture-model', messages: [{ role: 'system', content: 'private-system' }, { role: 'user', content: 'private-user-A' }] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-request-diagnostics-'));
try {
  await check('actual HTTP body hash follows final serialization with bounded content-free components', async () => {
    const first = await provider.chat(request);
    const d = first.requestDiagnostics;
    assert.equal(d.bodyHash, hash(captures.at(-1).raw));
    assert.equal(d.bodyBytes, Buffer.byteLength(captures.at(-1).raw));
    assert.equal(d.messageCount, 2);
    assert.equal(d.version, 1);
    assert.equal(d.responseModelHash, hash(JSON.stringify('observed-model')));
    assert.match(d.endpointHash, /^[a-f0-9]{64}$/);
    for (const value of [apiKey, 'private-system', 'private-user-A', baseUrl, 'tenant-private']) assert.equal(JSON.stringify(d).includes(value), false);
    const changed = await provider.chat({ ...request, messages: [request.messages[0], { role: 'user', content: 'private-user-B' }] });
    assert.notEqual(changed.requestDiagnostics.bodyHash, d.bodyHash, 'same message count content replacement changes actual projection');
    assert.notEqual(changed.requestDiagnostics.historyHash, d.historyHash);
    assert.equal(changed.requestDiagnostics.systemHash, d.systemHash);
    const reordered = await provider.chat({ ...request, messages: [...request.messages].reverse() });
    assert.notEqual(reordered.requestDiagnostics.inputHash, d.inputHash, 'message order remains semantic');
    const differentModel = await provider.chat({ ...request, model: 'other-model' });
    assert.notEqual(differentModel.requestDiagnostics.requestHash, d.requestHash);
    const otherRoute = createOpenAiCompatibleModelProvider({ id: 'fixture', label: 'Fixture', baseUrl: baseUrl.replace('tenant-private', 'tenant-other'), secrets });
    const routed = await otherRoute.chat(request);
    assert.equal(routed.requestDiagnostics.bodyHash, d.bodyHash);
    assert.notEqual(routed.requestDiagnostics.requestHash, d.requestHash, 'request identity includes actual endpoint route');
    const x = { id: 'read', description: 'Read permitted data', inputSchema: { type: 'object', properties: { b: { type: 'number' }, a: { type: 'string' } } } };
    const a = await provider.chat({ ...request, tools: [x] });
    const b = await provider.chat({ ...request, tools: [{ ...x, inputSchema: { properties: { a: { type: 'string' }, b: { type: 'number' } }, type: 'object' } }] });
    assert.equal(a.requestDiagnostics.toolsHash, b.requestDiagnostics.toolsHash);
    assert.equal(a.requestDiagnostics.bodyHash, b.requestDiagnostics.bodyHash);
    const arrayA = await provider.chat({ ...request, tools: [{ ...x, inputSchema: { type: 'object', properties: { mode: { enum: ['A', 'B'] } } } }] });
    const arrayB = await provider.chat({ ...request, tools: [{ ...x, inputSchema: { type: 'object', properties: { mode: { enum: ['B', 'A'] } } } }] });
    assert.notEqual(arrayA.requestDiagnostics.toolsHash, arrayB.requestDiagnostics.toolsHash);
    const image = value => ({ ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: value, detail: 'low' } }] }] });
    const imageA = await provider.chat(image('data:image/png;base64,AAAA'));
    const imageB = await provider.chat(image('data:image/png;base64,BBBB'));
    assert.notEqual(imageA.requestDiagnostics.historyHash, imageB.requestDiagnostics.historyHash);
    assert.equal(imageA.requestDiagnostics.imagePartCount, 1);
    const system = await provider.chat({ ...request, messages: [{ ...request.messages[0], content: 'changed-system' }, request.messages[1]] });
    assert.notEqual(system.requestDiagnostics.systemHash, d.systemHash);
    assert.equal(system.requestDiagnostics.historyHash, d.historyHash);
    const parameters = createOpenAiCompatibleModelProvider({ id: 'fixture', label: 'Fixture', baseUrl, secrets, reasoningParam: 'reasoning_effort', supportsReasoning: true });
    const low = await parameters.chat({ ...request, model: 'o3', reasoning: 'low' });
    const high = await parameters.chat({ ...request, model: 'o3', reasoning: 'high' });
    assert.equal(low.requestDiagnostics.inputHash, high.requestDiagnostics.inputHash);
    assert.notEqual(low.requestDiagnostics.parametersHash, high.requestDiagnostics.parametersHash);
    const native = createOpenAiCompatibleModelProvider({ id: 'fixture', label: 'Fixture', baseUrl, secrets, protocolProfile: 'deepseek-chat-v1' });
    const continuation = value => ({ ...request, reasoning: 'off', messages: [...request.messages, { role: 'assistant', content: 'answer',
      modelContinuation: { profile: 'deepseek-chat-v1', providerId: 'fixture', model: 'fixture-model', reasoningContent: value } }] });
    const nativeA = await native.chat(continuation('private-continuation-A'));
    assert.equal(nativeA.requestDiagnostics.bodyHash, hash(captures.at(-1).raw));
    assert.equal(JSON.parse(captures.at(-1).raw).messages.at(-1).reasoning_content, 'private-continuation-A');
    const nativeB = await native.chat(continuation('private-continuation-B'));
    assert.notEqual(nativeA.requestDiagnostics.historyHash, nativeB.requestDiagnostics.historyHash, 'native continuation must be observed after its actual wire projection');
    assert.equal(JSON.stringify(nativeA.requestDiagnostics).includes('private-continuation'), false);
    const serialized = await provider.chat({ ...request, messages: [{ role: 'user', content: { toJSON: () => 'final-private-content' } }] });
    assert.equal(serialized.requestDiagnostics.bodyHash, hash(captures.at(-1).raw));
    const direct = await provider.chat({ ...request, messages: [{ role: 'user', content: 'final-private-content' }] });
    assert.equal(serialized.requestDiagnostics.inputHash, direct.requestDiagnostics.inputHash, 'components must use final JSON values rather than pre-serialization objects');
  });
  await check('default provider attribution and diagnostics reach real coordinator receipts in chat, stream and HTTP failure', async () => {
    const runtime = createModelRuntimeService({ registry: createModelProviderRegistry({ providers: [provider] }), secrets });
    const ledger = createUsageLedger({ file: path.join(dir, 'coordinator.json') });
    const run = async (modelRuntime, turnId) => {
      const c = createToolExecutionCoordinator({ modelRuntime, capabilityBroker: { execute: async () => assert.fail('no tool execution expected') },
        onUsage: receipt => ledger.record(receipt) });
      return c.run({ providerId: null, messages: request.messages, actor: { kind: 'owner', id: 'owner' }, sessionId: 's', turnId });
    };
    for (const [mode, modelRuntime] of [['chat', { chat: runtime.chat, supportsToolCalling: runtime.supportsToolCalling }], ['stream', runtime]]) {
      const result = await run(modelRuntime, mode);
      assert.equal(result.usage.requestCount, 1);
      assert.equal(result.usage.requests[0].providerId, 'fixture');
      assert.equal(result.usage.requests[0].model, 'observed-model');
      assert.equal(result.usage.requests[0].requestDiagnostics.bodyHash, hash(captures.at(-1).raw));
    }
    failTransport = true;
    for (const [mode, modelRuntime] of [['chat-fail', { chat: runtime.chat, supportsToolCalling: runtime.supportsToolCalling }], ['stream-fail', runtime]]) {
      await assert.rejects(run(modelRuntime, mode), error => {
        assert.equal(error.usage.requests[0].providerId, 'fixture');
        assert.equal(error.usage.requests[0].model, null, 'requested alias is not an observed response model');
        assert.equal(error.usage.inputTokens, null);
        assert.equal(error.usage.accountingComplete, false);
        assert.equal(error.usage.requests[0].requestDiagnostics.bodyHash, hash(captures.at(-1).raw));
        return true;
      });
    }
    failTransport = false;
    await assert.rejects(run({ supportsToolCalling: () => true, chat: async () => { throw new Error('before provider observation'); } }, 'unobserved-fail'), error => {
      assert.equal(error.usage.requests[0].providerId, null);
      assert.equal(error.usage.requests[0].model, null);
      assert.equal(error.usage.requests[0].requestDiagnostics, undefined);
      return true;
    });
    const summary = ledger.summary({ sessionId: 's' });
    assert.equal(summary.requestCount, 5);
    assert.equal(summary.cacheCoverage.read.reportedRequests, 2);
    assert.equal(summary.cacheCoverage.totalRequests, 5);
    assert.equal(summary.knownUsage.inputTokens, 200);
    for (const value of [apiKey, 'private-system', 'private-user-A', 'tenant-private']) assert.equal(fs.readFileSync(path.join(dir, 'coordinator.json'), 'utf8').includes(value), false);
  });
  await check('diagnostic retention is separate from complete coverage and survives replay/reload without rewriting old identity', async () => {
    const file = path.join(dir, 'bounded.json');
    let ledger = createUsageLedger({ file });
    const response = await provider.chat(request);
    for (let i = 0; i < 70; i++) {
      const usage = accumulateModelUsage(null, { inputTokens: 10, outputTokens: 1, ...(i % 2 ? { cacheReadTokens: 0 } : {}) },
        { requestId: `r${i}`, providerId: 'fixture', model: 'observed-model', requestDiagnostics: response.requestDiagnostics });
      const receipt = { sessionId: 'bounded', turnId: `t${i}`, usage };
      ledger.record(receipt);
      ledger.record(receipt);
      if (i === 0) {
        assert.throws(() => ledger.record({ ...receipt, usage: { ...usage, requests: usage.requests.map(row => ({ ...row,
          requestDiagnostics: { ...row.requestDiagnostics, bodyHash: 'f'.repeat(64) } })) } }), { code: 'USAGE_RECEIPT_CONFLICT' });
      }
    }
    ledger = createUsageLedger({ file });
    const summary = ledger.summary({ sessionId: 'bounded' });
    assert.equal(summary.cacheCoverage.totalRequests, 70);
    assert.equal(summary.cacheCoverage.read.reportedRequests, 35);
    assert.equal(summary.requestDiagnostics.retainedRequests, 64);
    assert.equal(summary.requestDiagnostics.omittedRequests, 6);
    assert.equal(summary.requestDiagnostics.unreportedRequests, 0);
    assert.equal(summary.requestDiagnostics.latest.requestId, 'r69');
    assert.deepEqual(summary.requestDiagnostics.changes, ['unchanged']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).receipts.filter(r => r.requestDiagnostics).length, 64);
    ledger.record({ sessionId: 'bounded', turnId: 'unobserved', usage: accumulateModelUsage(null, null, { requestId: 'unobserved' }) });
    assert.equal(ledger.summary({ sessionId: 'bounded' }).requestDiagnostics.latest, null, 'no stale diagnostic may impersonate latest unknown request');
    assert.equal(ledger.summary({ sessionId: 'bounded' }).requestDiagnostics.unreportedRequests, 1);
    const legacyFile = path.join(dir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, receipts: [{ sessionId: 'old', turnId: 'old', taskId: null, requestId: 'old', providerId: null, model: null, usage: { inputTokens: 5 }, accountingComplete: false }] }));
    assert.equal(createUsageLedger({ file: legacyFile }).summary({ sessionId: 'old' }).requestDiagnostics.unreportedRequests, 1);
    const unsafe = accumulateModelUsage(null, null, { requestId: 'unsafe', requestDiagnostics: { ...response.requestDiagnostics,
      headers: { authorization: apiKey }, messages: request.messages, arbitraryBody: 'never retain' } });
    assert.equal(JSON.stringify(unsafe).includes(apiKey), false);
    assert.equal(JSON.stringify(unsafe).includes('private-system'), false);
    assert.equal(JSON.stringify(unsafe).includes('never retain'), false);
  });
  await check('local change reasons describe exact observations without cache support or eviction inference', async () => {
    const ledger = createUsageLedger({ file: path.join(dir, 'changes.json') });
    async function record(messages, id) {
      const response = await provider.chat({ ...request, messages });
      return ledger.record({ sessionId: 'changes', turnId: id, usage: accumulateModelUsage(null, response.usage,
        { requestId: id, providerId: 'fixture', model: response.model, requestDiagnostics: response.requestDiagnostics }) });
    }
    assert.deepEqual((await record(request.messages, 'first')).requestDiagnostics.changes, ['first-request']);
    assert.deepEqual((await record([request.messages[0], { role: 'user', content: 'changed' }], 'second')).requestDiagnostics.changes, ['history-changed']);
    ledger.record({ sessionId: 'changes', turnId: 'gap', usage: accumulateModelUsage(null, null, { requestId: 'gap' }) });
    const afterGap = await record(request.messages, 'after-gap');
    assert.deepEqual(afterGap.requestDiagnostics.changes, ['unknown']);
    assert.equal(afterGap.requestDiagnostics.comparedRequestId, null);
    assert.equal(afterGap.cacheCoverage.read.reportedRequests, 3);
    assert.equal(afterGap.cacheReadTokens, null, 'an unknown transport report prevents a complete cache total');
    assert.equal(afterGap.cacheCoverage.read.reportedHitRate, 0, 'reported explicit zeros remain observed zero with a known paired denominator');
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
assert.deepEqual(failures, [], 'all deterministic local observation scenarios must pass');
