import assert from 'node:assert/strict';
import { createWorkBuddyApiClient } from '../src/agent/workbuddy-api-client.js';
import { createWorkBuddyAgentProvider } from '../src/agent/workbuddy-agent-provider.js';

const secret = 'fixture-private-access';
const credential = () => ({ accessToken: secret, scopes: ['user.localassistant.readable', 'user.localassistant.invokable', 'user.task.readable', 'user.task.invokable'], expiresAt: Date.now() + 60000 });
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes(secret));
assert.throws(() => createWorkBuddyApiClient({ baseUrl: 'https://evil.example' }), /origin/);
await rejects(createWorkBuddyApiClient().localStatus(), 'developer_configuration_missing');
await rejects(createWorkBuddyApiClient({ resolveCredential: () => ({ ...credential(), scopes: [] }) }).localStatus(), 'scope_missing');
for (const altered of [{ expiresAt: 1 }, { revoked: true }]) {
  await rejects(createWorkBuddyApiClient({ resolveCredential: () => ({ ...credential(), ...altered }) }).localStatus(), 'credential_unavailable');
}
for (const status of [401, 403]) {
  await rejects(createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => reply({ token: secret }, status) }).localStatus(), `http_${status}`);
}
let calls = [];
const client = createWorkBuddyApiClient({ resolveCredential: credential, fetch: async (url, options) => {
  calls.push({ url, options });
  return reply({ code: 0, data: { online: true, message_id: 'msg-1', token: secret } });
} });
assert.deepEqual(await client.localStatus(), { online: true });
assert.equal(calls[0].url, 'https://www.workbuddy.cn/openapi/v2/localassistant');
assert.equal(calls[0].options.redirect, 'error');
await rejects(client.sendLocal({ content: 'hello' }), 'authorization_required');
await client.sendLocal({ content: 'hello', authorized: true, workspace: '/private', access_token: secret });
assert.deepEqual(JSON.parse(calls[1].options.body), { content: 'hello', msg_type: 'text' });
let attempts = 0;
const retry = createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => ++attempts === 1 ? reply({}, 429, { 'Retry-After': '0' }) : reply({ online: true }) });
await retry.localStatus(); assert.equal(attempts, 2);
attempts = 0;
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => { attempts++; throw new Error(secret); } }).createTask({ prompt: 'x', authorized: true }), 'network_error');
assert.equal(attempts, 1);
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, timeoutMs: 5, fetch: () => new Promise(() => {}) }).localStatus(), 'request_timeout');
// A secret-store hang must be bounded before any authenticated request starts.
let releaseCredential;
let lateRequests = 0;
const lateClient = createWorkBuddyApiClient({ timeoutMs: 10,
  resolveCredential: () => new Promise(resolve => { releaseCredential = resolve; }),
  fetch: async () => { lateRequests++; return reply({ online: true }); }
});
let watchdog;
try {
  await rejects(Promise.race([lateClient.localStatus(), new Promise((_, reject) => { watchdog = setTimeout(() => reject(Object.assign(new Error('test watchdog'), { code: 'watchdog' })), 250); })]), 'request_timeout');
} finally { clearTimeout(watchdog); }
releaseCredential(credential());
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(lateRequests, 0, 'late credentials cannot start HTTP after operation timeout');
const retrySignals = [];
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, timeoutMs: 25, fetch: async (_, options) => {
  retrySignals.push(options.signal);
  if (retrySignals.length === 1) return reply({}, 429, { 'Retry-After': '0' });
  return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
} }).localStatus(), 'request_timeout');
assert.equal(retrySignals.length, 2);
assert.equal(retrySignals[0], retrySignals[1], 'retry shares operation AbortController');
assert.equal(retrySignals[1].aborted, true, 'operation timeout aborts authenticated retry');
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => reply({ task_id: '1', status: 'working', link: 'https://evil.example/s', token: secret }) }).getTask('1'), 'destination_rejected');
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => reply({}, 302, { Location: 'https://evil.example' }) }).localStatus(), 'http_302');
attempts = 0;
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => { attempts++; return reply({}, 429, { 'Retry-After': '0' }); } }).createTask({ prompt: 'x', authorized: true }), 'http_429');
assert.equal(attempts, 1);
await rejects(createWorkBuddyApiClient({ resolveCredential: () => { throw new Error(`refresh failed ${secret}`); } }).localStatus(), 'credential_unavailable');
const safe = await createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => reply({ task_id: '1', status: 'working', link: 'https://acp.workbuddy.cn/sessions/1', token: secret, sandboxLink: 'https://evil.example' }) }).getTask('1');
assert.deepEqual(safe, { task_id: '1', status: 'working' });
const provider = createWorkBuddyAgentProvider({ client });
const health = await provider.health();
assert.equal(health.readyForTask, false);
assert.equal(health.reason, 'oauth_exchange_unconfigured');
assert.equal(provider.capabilities().supported.createSession, false);
assert.equal((await createWorkBuddyAgentProvider().health()).reason, 'developer_configuration_missing');
await rejects(createWorkBuddyApiClient({ resolveCredential: credential, fetch: async () => reply({ messages: [{ message_id: { token: secret } }] }) }).localHistory(), 'invalid_response');
assert.equal(JSON.stringify(health).includes(secret), false);
console.log('PASS WorkBuddy API contract/security fixtures; Real E2E NOT_RUN_ENVIRONMENT');
