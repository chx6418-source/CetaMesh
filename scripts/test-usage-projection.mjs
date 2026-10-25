import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
const raw = { id: 'answer', role: 'assistant', text: 'Done', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, cacheHitRate: null, requestCount: 2, requests: [{ rawUsage: { secret: 'DO_NOT_EXPOSE' } }], apiKey: 'DO_NOT_EXPOSE' } };
const ui = createDesktopUiService({ services: { chatService: { execute: async () => ({ messages: [raw], sessionUsage: { ...raw.usage, inputTokens: 300 } }) } } });
const history = () => ui.execute({ method: 'ui.chat.history', params: { id: 'session' } });
const result = await history();
assert.equal(result.messages[0].usage?.inputTokens, 100, 'persisted usage must survive production renderer projection');
assert.equal(result.sessionUsage?.inputTokens, 300, 'session total comes from Core, not this page');
assert.equal(result.messages[0].usage.cacheReadTokens, null);
assert.equal(result.messages[0].usage.cost, null);
assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|rawUsage|apiKey/);
const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui');
const require = createRequire(path.join(uiRoot, 'package.json'));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
globalThis.window = { setTimeout, clearTimeout };
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { MessageBubble, UsageSummary } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  const render = message => renderToStaticMarkup(React.createElement(MessageBubble, { message }));
  const html = render(result.messages[0]);
  assert.match(html, /输入 100/); assert.match(html, /输出 20/); assert.match(html, /推理 5/);
  assert.match(html, /缓存命中 未知/); assert.match(html, /费用 未知/); assert.doesNotMatch(html, /0%/);
  raw.usage = { ...raw.usage, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 };
  assert.match(render((await history()).messages[0]), /缓存命中 0%/);
  raw.usage = { ...raw.usage, accountingComplete: false };
  const incomplete = await history();
  assert.equal(incomplete.messages[0].usage.accountingComplete, false, 'partial accounting survives ui.chat.history');
  assert.equal(incomplete.sessionUsage.accountingComplete, false);
  assert.equal(incomplete.messages[0].usage.inputTokens, 100, 'known receipts are preserved');
  assert.match(render(incomplete.messages[0]), /已知用量（不完整）/);
  const sessionHtml = renderToStaticMarkup(React.createElement(UsageSummary, { usage: incomplete.sessionUsage, label: '会话累计用量' }));
  assert.match(sessionHtml, /已知用量（不完整）/); assert.match(sessionHtml, /输入 300/);
  raw.usage = { ...raw.usage, accountingComplete: 'secret' };
  assert.equal((await history()).messages[0].usage.accountingComplete, null, 'only booleans cross the DTO boundary');
  raw.usage = { inputTokens: -1, outputTokens: Infinity, reasoningTokens: 'secret', cacheHitRate: 8 };
  const invalid = (await history()).messages[0].usage;
  assert.equal(invalid.inputTokens, null); assert.equal(invalid.outputTokens, null); assert.equal(invalid.reasoningTokens, null); assert.equal(invalid.cacheHitRate, null);
  raw.usage = { prompt_tokens: 200, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 100 }, apiKey: 'DO_NOT_EXPOSE' };
  const legacy = (await history()).messages[0].usage;
  assert.equal(legacy.inputTokens, 200); assert.equal(legacy.cacheReadTokens, 100); assert.equal(legacy.cacheHitRate, 0.5);
  assert.equal(legacy.requestCount, null, 'legacy snapshots do not prove number of Provider requests');
  raw.usage = { inputTokens: 100, outputTokens: 20, cost: { status: 'estimated', amount: 0.00022, knownAmount: 0.00022, currency: 'USD', complete: true, sources: ['fixture tariff'], versions: ['fixture-v1'], apiKey: 'DO_NOT_EXPOSE' } };
  const priced = (await history()).messages[0];
  assert.equal(priced.usage.cost.status, 'estimated');
  assert.match(render(priced), /估算费用 USD 0.00022/);
  assert.doesNotMatch(JSON.stringify(priced), /DO_NOT_EXPOSE/);
  raw.usage.cost = { ...raw.usage.cost, status: 'unknown', amount: null, complete: false };
  assert.match(render((await history()).messages[0]), /费用 未知.*已核算 USD 0.00022/);
  raw.usage = null;
  assert.equal((await history()).messages[0].usage, null);
} finally { await vite.close(); }
console.log('usage projection and renderer PASS');

// Core aggregates persisted history before pagination, including unknown legacy turns.
const { createChatService } = await import('../src/desktop/chat-service.js');
const fs = await import('node:fs');
const os = await import('node:os');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-'));
try {
  const chat = createChatService({ stateDir });
  const session = await chat.execute({ method: 'chat.sessions.create', params: {} });
  const file = path.join(stateDir, 'desktop-chat', 'history', `${session.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const messages = [1, 2].map(i => ({ id: `a${i}`, role: 'assistant', accountingSessionId: `native-${i}`, usage: { inputTokens: 100 * i, outputTokens: 10 * i, requestCount: i, cacheReadTokens: 50 * i } }));
  fs.writeFileSync(file, JSON.stringify({ messages }));
  const page = await chat.execute({ method: 'chat.history', params: { id: session.id, limit: 1 } });
  assert.equal(page.messages.length, 1);
  assert.deepEqual(page.accountingSessionIds, [session.id, 'native-1', 'native-2'], 'native aliases come from full persisted history before pagination');
  assert.equal(page.sessionUsage?.inputTokens, 300, 'Core session accounting includes older off-page messages');
  assert.equal(page.sessionUsage?.requestCount, 3);
  messages[0].usage.accountingComplete = false;
  fs.writeFileSync(file, JSON.stringify({ messages }));
  const realUi = createDesktopUiService({ services: { chatService: chat } });
  const partialPage = await realUi.execute({ method: 'ui.chat.history', params: { id: session.id, limit: 1 } });
  assert.equal(partialPage.sessionUsage.accountingComplete, false, 'off-page incomplete turn marks full session incomplete');
  assert.equal(partialPage.sessionUsage.inputTokens, 300, 'session preserves measured receipts');
  messages.push({ id: 'old' , role: 'assistant', usage: null });
  fs.writeFileSync(file, JSON.stringify({ messages }));
  const unknown = await chat.execute({ method: 'chat.history', params: { id: session.id, limit: 1 } });
  assert.equal(unknown.sessionUsage.inputTokens, null, 'missing historical evidence makes full total unknown');
  assert.equal(unknown.sessionUsage.requestCount, null);
} finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
console.log('full-history usage aggregation PASS');

// Durable summaries are scoped at the Core DTO boundary; old unledgered history
// cannot silently turn a partial bill into the session total.
const measured = { inputTokens: 10, outputTokens: 2, requestCount: 1, accountingComplete: true,
  cost: { status: 'actual', amount: 0.01, knownAmount: 0.01, currency: 'USD', complete: true, sources: ['fixture'], versions: ['receipt'] } };
const scopes = [];
const durableUi = createDesktopUiService({ services: {
  usageLedger: { summary: scope => { scopes.push(scope); return measured; } },
  chatService: { execute: async () => ({ messages: [], sessionUsage: { inputTokens: 30, outputTokens: 6, requestCount: 3 } }) },
  taskService: { execute: async () => ({ task: { id: 'task-scoped', goal: 'fixture' } }) }
} });
const mixed = await durableUi.execute({ method: 'ui.chat.history', params: { id: 'session-scoped' } });
assert.equal(mixed.sessionUsage.inputTokens, 30);
assert.equal(mixed.sessionUsage.cost.amount, null);
assert.equal(mixed.sessionUsage.cost.knownAmount, 0.01);
assert.equal(mixed.sessionUsage.accountingComplete, false);
const scopedTask = await durableUi.execute({ method: 'ui.task.get', params: { id: 'task-scoped' } });
assert.equal(scopedTask.task.usage.cost.amount, 0.01);
assert.deepEqual(scopes, [{ sessionId: 'session-scoped' }, { taskId: 'task-scoped' }]);
console.log('durable scoped usage DTO and legacy partial coverage PASS');

const nativeScopes = [];
const nativeUi = createDesktopUiService({ services: {
  usageLedger: { summary: scope => { nativeScopes.push(scope); return measured; } },
  chatService: { execute: async () => ({ id: 'desktop-id', accountingSessionId: 'native-id', messages: [], sessionUsage: measured }) }
} });
const nativeHistory = await nativeUi.execute({ method: 'ui.chat.history', params: { id: 'desktop-id' } });
assert.deepEqual(nativeScopes, [{ sessionId: 'native-id' }]);
assert.equal(nativeHistory.sessionUsage.cost.amount, 0.01);
assert.equal(Object.hasOwn(nativeHistory, 'accountingSessionId'), false);
console.log('Managed native usage scope projects into desktop history without duplicate accounting PASS');

const aliases = [];
const reattachedUi = createDesktopUiService({ services: {
  usageLedger: { summary: scope => { aliases.push(scope); return measured; } },
  chatService: { execute: async () => ({ id: 'desktop-id', accountingSessionId: 'native-2', accountingSessionIds: ['native-1', 'native-2'], messages: [], sessionUsage: measured }) }
} });
const reattached = await reattachedUi.execute({ method: 'ui.chat.history', params: { id: 'desktop-id' } });
assert.deepEqual(aliases, [{ sessionIds: ['native-1', 'native-2'] }]);
assert.equal(Object.hasOwn(reattached, 'accountingSessionIds'), false);
