import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDshAgentProvider } from '../src/agent/dsh-agent-provider.js';
import { createDshCoreConnector } from '../src/agent/dsh-core-connector.js';
import { createDshPresetPolicy } from '../src/agent/dsh-preset-policy.js';
import { createCetaMeshServices } from '../src/app/service-container.js';

const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const streams = [];
const api = {
  async callEndpoint(endpoint, args) {
    if (endpoint === 'session/create') return { sessionId: 'coding-1', agentPreset: args.request.agentPreset };
    if (endpoint === 'session/list') return { items: [] };
    return {};
  },
  async *openRemoteStream(_endpoint, _args, { signal }) {
    const stream = { frames: [], wake: null, signal };
    streams.push(stream);
    while (!signal.aborted) {
      if (!stream.frames.length) await new Promise(resolve => { stream.wake = resolve; });
      while (stream.frames.length) yield stream.frames.shift();
    }
  }
};
function push(frame) {
  streams[0].frames.push(frame);
  streams[0].wake?.();
}
async function nextWithTimeout(iterator) {
  return Promise.race([iterator.next(), new Promise((_, reject) => setTimeout(() => reject(new Error('follow timed out')), 1000))]);
}

// The production Core must inject its optional DSH client without starting DSH or Legacy.
const connector = createDshCoreConnector({ config: { dsh: { baseUrl: 'http://127.0.0.1:3080' } }, env: {} });
assert.equal(typeof connector.api.callEndpoint, 'function');
assert.equal(typeof connector.api.openRemoteStream, 'function');
assert.equal(createDshCoreConnector({ config: { dsh: { codingPreset: 42 } } }).presetConfig.coding, null,
  'malformed optional preset configuration must not crash Core construction');

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-m3-core-'));
const crashingApi = {
  async callEndpoint() { throw Object.assign(new Error('fixture connector crashed'), { code: 'ECONNRESET' }); },
  async *openRemoteStream() { throw new Error('fixture connector crashed'); }
};
const isolated = createCetaMeshServices({ api: crashingApi, config: {},
  stateDir: path.join(isolatedRoot, 'state'), dataRoot: path.join(isolatedRoot, 'data') });
assert.equal((await isolated.agentService.execute({ method: 'agent.health', params: { provider: 'dsh' } })).available, false);
assert.equal(typeof isolated.chatService.execute, 'function');
assert.equal(typeof isolated.taskService.runtime.create, 'function');
assert.equal(typeof isolated.memoryService.runtime.create, 'function');
isolated.agentService.close();
isolated.chatService.close();
isolated.capabilityService.close();
isolated.extensionService.close();
isolated.integrationService.close();
isolated.pluginCenterService.close();
isolated.managedAgent.close();
fs.rmSync(isolatedRoot, { recursive: true, force: true });

const provider = createDshAgentProvider({ api });
const task = provider.follow({ sessionId: 'coding-1', sinceSequence: 0 })[Symbol.asyncIterator]();
const chat = provider.follow({ sessionId: 'coding-1', sinceSequence: 0 })[Symbol.asyncIterator]();
const taskFirst = nextWithTimeout(task);
const chatFirst = nextWithTimeout(chat);
await wait();
assert.equal(streams.length, 1, 'Task and Chat share one native reader');
push({ type: 'snapshot', cursor: 0, records: [], hasMore: false });
push({ type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } });
assert.equal((await taskFirst).value.event.seq, 1);
assert.equal((await chatFirst).value.event.seq, 1);
const continuity = provider.follow({ sessionId: 'coding-1', sinceSequence: 0 })[Symbol.asyncIterator]();
assert.equal((await nextWithTimeout(continuity)).value.event.seq, 1, 'late subscriber replays independently');
assert.equal(streams.length, 1);
push({ type: 'event', event: { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
assert.equal((await nextWithTimeout(task)).value.event.seq, 2);
assert.equal((await nextWithTimeout(chat)).value.event.seq, 2);
assert.equal((await nextWithTimeout(continuity)).value.event.seq, 2);
assert.equal((await nextWithTimeout(provider.follow({ sessionId: 'coding-1', sinceSequence: 1 })[Symbol.asyncIterator]())).value.event.seq, 2);
assert.equal(streams.length, 1);
await task.return();
await chat.return();
await continuity.return();
await provider.shutdown();

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-m3-preset-'));
function preset(id, body) {
  const dir = path.join(home, '.agent-presets', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent.cordis.yml');
  fs.writeFileSync(file, `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    ${body}\n`);
  return file;
}
const codingFile = preset('coding-safe', 'prefix: "You are a coding agent"');
const socialFile = preset('social-old', 'text: "QQ social persona"');
const socialBefore = fs.readFileSync(socialFile);
const policy = createDshPresetPolicy({ coding: 'coding-safe', social: 'social-old', dshHome: home });
assert.equal(policy.inspect('coding').compatible, true);
assert.equal(policy.inspect('social').reason, 'persona-prefix-required');
const createdRequests = [];
const presetProvider = createDshAgentProvider({ api: {
  async callEndpoint(endpoint, args) {
    if (endpoint === 'session/create') { createdRequests.push(args.request); return { sessionId: `preset-${createdRequests.length}` }; }
    if (endpoint === 'agentPresets/list') return { presets: [{ id: 'coding-safe' }] };
    return {};
  },
  async *openRemoteStream() {}
}, presetPolicy: policy, defaults: { model: null } });
await presetProvider.createSession({ purpose: 'coding' });
assert.equal(createdRequests[0].agentPreset, 'coding-safe');
await assert.rejects(() => presetProvider.createSession({}), error => error.code === 'INVALID_PARAMS');
await assert.rejects(() => presetProvider.createSession({ purpose: 'social' }), error => error.code === 'DSH_PRESET_INCOMPATIBLE');
assert.equal(createdRequests.length, 1, 'an incompatible social preset must not start a DSH Session');
assert.equal((await presetProvider.health()).ready, true, 'a compatible, loaded coding preset may be marked ready');
assert.deepEqual(fs.readFileSync(socialFile), socialBefore, 'user-authored preset bytes remain untouched');
assert.equal(fs.existsSync(codingFile), true);
await presetProvider.shutdown();
fs.rmSync(home, { recursive: true, force: true });

const gapApi = {
  async callEndpoint() { return {}; },
  async *openRemoteStream() {
    yield { type: 'snapshot', cursor: 0, records: [], hasMore: false };
    yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
    yield { type: 'event', event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } };
  }
};
const gapProvider = createDshAgentProvider({ api: gapApi });
const gapFollow = gapProvider.follow({ sessionId: 'gap-1' });
assert.equal((await gapFollow.next()).value.event.seq, 1);
await assert.rejects(gapFollow.next(), error => error.code === 'AGENT_EVENT_GAP');
await gapProvider.shutdown();

const eofProvider = createDshAgentProvider({ api: {
  async callEndpoint() { return {}; },
  async *openRemoteStream() {
    yield { type: 'snapshot', cursor: 0, records: [], hasMore: false };
    yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
  }
} });
const eofFollow = eofProvider.follow({ sessionId: 'eof-1' });
assert.equal((await eofFollow.next()).value.event.type, 'turn/start');
await assert.rejects(eofFollow.next(), error => error.code === 'PROVIDER_UNAVAILABLE',
  'abnormal EOF after turn/start must not complete the turn');
await eofProvider.shutdown();

let round = 0;
const replies = ['first answer', 'second answer', 'third answer'];
const roundProvider = createDshAgentProvider({ api: {
  async callEndpoint(endpoint) { return endpoint === 'session/prompt' ? { accepted: true } : {}; },
  async *openRemoteStream() {
    const turn = ++round;
    const base = (turn - 1) * 3;
    yield { type: 'snapshot', cursor: base, records: base ? [{ type: 'event', event: {
      seq: base, type: 'turn/end', data: { turn: turn - 1, reason: { kind: 'completed' } }
    } }] : [], hasMore: false };
    yield { type: 'event', event: { seq: base + 1, type: 'turn/start', data: { turn } } };
    yield { type: 'event', event: { seq: base + 2, type: 'assistant/message', data: { turn, message: {
      content: [{ type: 'text', text: replies[turn - 1] }]
    } } } };
    yield { type: 'event', event: { seq: base + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } };
  }
} });
let cursor = 0;
for (let turn = 1; turn <= 3; turn += 1) {
  const sent = await roundProvider.send({ sessionId: 'round-session', content: `different instruction ${turn}` });
  assert.equal(sent.accepted, true);
  const seen = [];
  for await (const frame of roundProvider.follow({ sessionId: 'round-session', sinceSequence: cursor })) seen.push(frame.event);
  assert.deepEqual(seen.map(event => event.seq), [cursor + 1, cursor + 2, cursor + 3]);
  assert.equal(seen.find(event => event.type === 'assistant/message').data.message.content[0].text, replies[turn - 1]);
  cursor += 3;
}
assert.equal(round, 3, 'each user turn reconnects a single native reader after the prior terminal EOF');
await roundProvider.shutdown();

console.log('PASS M3 DSH Core composition, single-reader replay, native gap, three distinct turns, and read-only purpose-specific preset validation');
