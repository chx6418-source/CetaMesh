import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBionicService } from '../src/bionic/service.js';
import { createQqSendLedger } from '../src/channel/qq/send-ledger.js';
import { createIntegrationStore } from '../src/integrations/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-readiness-'));
let qq = { ready: true, authenticated: true, accountId: '10001' };
let consumer = null;
const journal = { events: [{ accountId: '10001', eventId: 'in-1', createdAt: 1700000000000 },
  { accountId: '20002', eventId: 'in-other', createdAt: 1800000000000 }],
  consumers: { 'bionic-10001': { deliveries: { 'in-1': 'acknowledged' } } } };
const ledger = createQqSendLedger(path.join(root, 'state', 'qq-send-ledger.json'));
ledger.claim({ requestId: 'sent-1', accountId: '10001', kind: 'text', target: 'group:42', action: 'send_group_msg', payload: {} });
ledger.ack('10001', 'sent-1', { message_id: 100 });
ledger.claim({ requestId: 'unknown-1', accountId: '10001', kind: 'text', target: 'group:42', action: 'send_group_msg', payload: {} });
ledger.claim({ requestId: 'other', accountId: '20002', kind: 'text', target: 'group:42', action: 'send_group_msg', payload: {} });
const service = createBionicService({ dataRoot: root, stateDir: path.join(root, 'state'),
  config: { allow: { groups: ['42'], private: [] }, dsh: { baseUrl: 'http://127.0.0.1:9', homeDir: path.join(root, 'dsh') },
    socialV2: { wake: { triggers: { anyMessage: false, probability: 0 } } } },
  channelService: { execute: async () => qq,
    registerConsumer: spec => { consumer = spec; return () => { consumer = null; }; },
    read: async () => ({ user_id: 10001 }), deliverySnapshot: () => journal } });
try {
  const started = await service.start();
  assert.equal(started.running, true, 'the source policy process can run in degraded mode');
  assert.equal(started.ready, false, 'a running policy process with an unavailable DSH must not report ready');
  assert.equal(started.readiness.dsh.ready, false);
  assert.ok(started.activity, 'Bionic exposes observed durable receive and send activity');
  assert.equal(started.activity.receive.total, 1, 'receive activity excludes another QQ account');
  assert.equal(started.activity.receive.acknowledged, 1);
  assert.equal(started.activity.send.sent, 1, 'sent requires a persisted gateway receipt');
  assert.equal(started.activity.send.outcomeUnknown, 1, 'unknown send effects never become sent');
  const switches = createIntegrationStore({ stateDir: path.join(root, 'state') });
  switches.update(value => ({ ...value, plugins: { ...value.plugins, 'cetamesh-bionic-chat': { enabled: false } } }));
  assert.equal((await service.health()).readiness.enabled, false, 'live plugin disable is observed without restarting the policy process');
  assert.equal(consumer.authorize({ accountId: '10001' }), false, 'disabled Bionic cannot accept another inbound event');
  switches.update(value => ({ ...value, plugins: { ...value.plugins, 'cetamesh-bionic-chat': { enabled: true } } }));
  qq = { ready: true, accountId: '20002' };
  assert.equal((await service.health()).readiness.qq.ready, false, 'a changed active QQ account cannot inherit Bionic readiness');
  qq = { ready: false, accountId: '10001' };
  assert.equal((await service.health()).ready, false, 'a disconnected QQ connector immediately removes readiness');
  qq = { ready: true, authenticated: true, accountId: '10001' };
  const reconnected = await service.reconnect();
  assert.equal(reconnected.running, true);
  assert.equal(reconnected.ready, false, 'reconnect never changes an unavailable DSH into a ready dependency');
  assert.notEqual(reconnected.processId, started.processId, 'reconnect actually replaces the owned policy process');
  await service.stop();
  assert.equal(consumer, null);
  assert.equal((await service.health()).running, false);
  console.log('PASS Bionic source process readiness stays false for unavailable dependencies');
} finally {
  await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}



// The shipped Social preset must satisfy the same production schema gate as an
// installed preset; this catches the obsolete persona.text template itself.
{
  const { inspectDshPreset } = await import('../src/agent/dsh-preset-policy.js');
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-preset-'));
  try {
    const source = path.resolve('dsh', 'agent-presets', 'whale-chat-v2');
    const target = path.join(fixtureHome, '.agent-presets', 'whale-chat-v2');
    fs.cpSync(source, target, { recursive: true });
    assert.equal(inspectDshPreset({ id: 'whale-chat-v2', dshHome: fixtureHome }).compatible, true,
      'the shipped whale-chat-v2 persona must satisfy the native prefix schema');
  } finally { fs.rmSync(fixtureHome, { recursive: true, force: true }); }
}

// Read-only API fixtures exercise the real DSH client/auth envelope and schema
// inspector. No session creation, prompt, QQ send or paid model request occurs.
{
  const http = await import('node:http');
  const { createBionicReadiness } = await import('../src/bionic/readiness.js');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-native-check-'));
  const home = path.join(fixtureRoot, 'dsh');
  const accountRoot = path.join(fixtureRoot, 'account');
  const accountState = path.join(accountRoot, 'state');
  fs.cpSync(path.resolve('dsh/agent-presets/whale-chat-v2'), path.join(home, '.agent-presets', 'whale-chat-v2'), { recursive: true });
  fs.mkdirSync(accountState, { recursive: true });
  let roster = [{ id: 'whale-chat-v2' }];
  let nativeSessions = [{ sessionId: 'social-1' }];
  let rejectAuth = false;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const rpc = JSON.parse(text); calls.push(rpc.method);
    if (rejectAuth) { res.writeHead(401); res.end('credential-fixture-must-not-escape'); return; }
    const values = { 'settings/describe': {}, 'session/list': { items: nativeSessions }, 'agentPresets/list': { presets: roster } };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value: values[rpc.method] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const now = 1900000000000;
  const startedAt = now - 1000;
  const config = { allow: { groups: ['42'], private: [] }, socialV2: { agentPreset: 'whale-chat-v2' },
    dsh: { baseUrl: `http://127.0.0.1:${server.address().port}`, authCookie: 'fixture-cookie', homeDir: home } };
  const check = createBionicReadiness({ config, now: () => now });
  const saveEvidence = (overrides = {}) => {
    fs.writeFileSync(path.join(accountState, 'sessions.json'), JSON.stringify({ sessions: { 'group:42': 'social-1' } }));
    fs.writeFileSync(path.join(accountState, 'tool-calls.jsonl'), JSON.stringify({ type: 'result', key: 'group:42',
      sessionId: 'social-1', time: new Date(now - 100).toISOString(), tool: 'mcp__snowluma__qq_get_prompt', ok: true, ...overrides }) + '\n');
  };
  try {
    const first = await check({ accountRoot, startedAt });
    assert.equal(first.canStart, true, 'missing MCP evidence must not prevent first startup');
    assert.equal(first.ready, false, 'configuration and native preset discovery are not a successful MCP tool receipt');
    assert.equal(first.state, 'needs-verification');
    saveEvidence();
    assert.equal((await check({ accountRoot, startedAt })).ready, true, 'current account, live session and successful QQ tool result establish readiness');
    for (const bad of [
      { type: 'call' }, { ok: false }, { sessionId: 'another-session' }, { key: 'group:43' },
      { time: new Date(startedAt - 1).toISOString() }, { time: new Date(now + 1).toISOString() },
      { tool: 'mcp__other__qq_get_prompt' }
    ]) {
      saveEvidence(bad);
      assert.equal((await check({ accountRoot, startedAt })).ready, false, 'unscoped, stale, uncompleted or failed evidence cannot mark Bionic ready');
    }
    saveEvidence();
    assert.equal((await check({ accountRoot, startedAt: now })).ready, false, 'restart invalidates old process evidence');
    nativeSessions = [];
    assert.equal((await check({ accountRoot, startedAt })).ready, false, 'a removed native session invalidates readiness');
    nativeSessions = [{ sessionId: 'social-1' }];
    roster = [{ id: 'whale-chat-v2', broken: 'native-load-fixture-error' }];
    assert.equal((await check({ accountRoot, startedAt })).preset.ready, false, 'a broken native preset is not loaded');
    roster = [{ id: 'whale-chat-v2' }];
    rejectAuth = true;
    const denied = await check({ accountRoot, startedAt });
    assert.equal(denied.ready, false);
    assert.equal(denied.code, 'DSH_AUTHENTICATION_FAILED');
    assert.equal(JSON.stringify(denied).includes('fixture-cookie'), false);
    assert.equal(JSON.stringify(denied).includes('credential-fixture-must-not-escape'), false);
    assert.ok(calls.every(method => ['settings/describe', 'session/list', 'agentPresets/list'].includes(method)), 'environment checks use only read-only RPC methods');
    console.log('PASS Bionic native API, social persona, account-scoped current tool evidence and redaction');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// Existing installer ownership rules upgrade an unmodified official template,
// while keeping unknown/user-modified persona bytes and social state intact.
{
  const { planIntegration, applyPlan, hashTree } = await import('../src/dsh-integration.js');
  const { inspectDshPreset } = await import('../src/agent/dsh-preset-policy.js');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-owned-upgrade-'));
  const home = path.join(fixtureRoot, 'dsh');
  const dataRoot = path.join(fixtureRoot, 'data');
  const destination = path.join(home, '.agent-presets', 'whale-chat-v2');
  fs.cpSync(path.resolve('dsh/agent-presets/whale-chat-v2'), destination, { recursive: true });
  const personaFile = path.join(destination, 'agent.cordis.yml');
  const current = fs.readFileSync(personaFile, 'utf8');
  fs.writeFileSync(personaFile, current.replace('    prefix: >-', '    text: >-'));
  const oldHash = hashTree(destination);
  fs.mkdirSync(path.join(dataRoot, 'state'), { recursive: true });
  const socialFile = path.join(dataRoot, 'state', 'social-v2.json');
  const socialBytes = '{"conversations":{"group:42":{"privateMemory":"preserve exact fixture bytes"}}}';
  fs.writeFileSync(socialFile, socialBytes);
  const plan = manifest => planIntegration({ dshHome: home, profile: 'web', resourceRoot: path.resolve('.'), dataRoot,
    version: 'readiness-fixture', core: { packaged: false, command: process.execPath, argsPrefix: [path.resolve('src/core-entry.js')] }, manifest });
  try {
    const owned = plan({ presets: { 'whale-chat-v2': { owned: true, hash: oldHash } } });
    assert.equal(owned.presets['whale-chat-v2'].action, 'update');
    assert.equal(fs.readFileSync(personaFile, 'utf8').includes('    text: >-'), true, 'planning never overwrites the installed persona');
    applyPlan(owned);
    assert.equal(inspectDshPreset({ id: 'whale-chat-v2', dshHome: home }).compatible, true);
    assert.equal(fs.readFileSync(socialFile, 'utf8'), socialBytes, 'official persona upgrade preserves social state byte-for-byte');
    const userBytes = fs.readFileSync(personaFile, 'utf8') + '\n# fixture user customization\n';
    const installedHash = hashTree(destination);
    fs.writeFileSync(personaFile, userBytes);
    const customized = plan({ presets: { 'whale-chat-v2': { owned: true, hash: installedHash } } });
    assert.equal(customized.presets['whale-chat-v2'].action, 'keep-user-modified');
    assert.ok(customized.warnings.some(warning => warning.includes('whale-chat-v2')));
    assert.equal(customized.effects.some(effect => effect.path === destination), false);
    const unknown = plan(null);
    assert.equal(unknown.presets['whale-chat-v2'].action, 'keep-unknown');
    assert.equal(unknown.effects.some(effect => effect.path === destination), false);
    assert.equal(fs.readFileSync(personaFile, 'utf8'), userBytes);
    assert.equal(fs.readFileSync(socialFile, 'utf8'), socialBytes);
    console.log('PASS Bionic official persona upgrade and unknown/user-modified state preservation');
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
}
