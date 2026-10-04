import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDesktopChatService } from '../src/desktop-chat-service.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-chat-'));
const calls = [];
let nextTurn = 1;
class FakeDsh {
  async callEndpoint(endpoint, args) {
    calls.push({ endpoint, args });
    if (endpoint === 'workspace/create') return { workspace: { workspaceId: 'workspace-1' }, created: true };
    if (endpoint === 'session/create') return { sessionId: 'session-1' };
    if (endpoint === 'session/selectModel') return { ok: true };
    if (endpoint === 'session/prompt') {
      const turn = nextTurn++;
      records.push({ seq: turn * 10, event: { type: 'turn/start', data: { turn } } });
      records.push({ seq: turn * 10 + 1, event: { type: 'assistant/chunk', data: { turn, chunk: { type: 'text-delta', text: '流式' } } } });
      records.push({ seq: turn * 10 + 2, event: { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: '完整回答' }] } } } });
      records.push({ seq: turn * 10 + 3, event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } });
      return { accepted: true };
    }
    if (endpoint === 'session/cancel') return { ok: true };
    throw Error('unexpected ' + endpoint);
  }
  async *openRemoteStream(endpoint, args, options) {
    assert.equal(endpoint, 'session/follow');
    assert.equal(args.request.address.sessionId, 'session-1');
    yield { type: 'snapshot', records: records.slice() };
    if (!options.signal.aborted) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const records = [];
async function until(service, predicate) {
  for (let i = 0; i < 80; i++) {
    const state = service.execute('chat.status', {});
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('chat did not settle');
}
try {
  const dsh = new FakeDsh();
  const service = createDesktopChatService({
    api: dsh, stateDir: dir, model: () => ({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
  });
  assert.throws(() => service.execute('chat.start', { text: ' ' }), /text/);
  assert.throws(() => service.execute('chat.start', { text: 'x'.repeat(4001) }), /text/);
  service.execute('chat.start', { text: '你好' });
  assert.throws(() => service.execute('chat.start', { text: '第二条' }), /busy/);
  let state = await until(service, s => s.status === 'completed');
  assert.equal(state.reply, '完整回答');
  assert.equal(state.history[0].text, '你好');
  assert.equal(state.history[1].text, '完整回答');
  assert.ok(calls.some(c => c.endpoint === 'session/selectModel'));
  const restarted = createDesktopChatService({ api: dsh, stateDir: dir, model: () => ({}) });
  assert.equal(restarted.execute('chat.status', {}).history.length, 2);
  restarted.execute('chat.start', { text: '继续' });
  state = await until(restarted, s => s.status === 'completed');
  assert.equal(state.history.length, 4);
  assert.equal(calls.filter(c => c.endpoint === 'session/create').length, 1, 'reuse persisted DSH session');
  const deferred = {
    async callEndpoint(endpoint) {
      if (endpoint === 'workspace/create') return { workspace: { workspaceId: 'w' } };
      if (endpoint === 'session/create') return { sessionId: 'session-1' };
      if (endpoint === 'session/prompt') return { accepted: true };
      if (endpoint === 'session/cancel') return { ok: true };
      return {};
    },
    async *openRemoteStream(_endpoint, _args, options) {
      yield { type: 'snapshot', records: [] };
      await new Promise(resolve => setTimeout(resolve, 40));
      if (options.signal.aborted) return;
    }
  };
  const cancelDir = path.join(dir, 'cancel');
  const pending = createDesktopChatService({ api: deferred, stateDir: cancelDir, model: () => ({}) });
  pending.execute('chat.start', { text: '请暂停' });
  await until(pending, s => s.status === 'running');
  assert.equal(pending.execute('chat.cancel', {}).status, 'cancelling');
  await until(pending, value => value.status === 'cancelled');
  assert.equal(createDesktopChatService({ api: deferred, stateDir: cancelDir, model: () => ({}) }).execute('chat.status', {}).status, 'cancelled');
  const failed = createDesktopChatService({ api: { callEndpoint: async () => { throw Error('DSH unavailable'); }, openRemoteStream: deferred.openRemoteStream }, stateDir: path.join(dir, 'error'), model: () => ({}) });
  failed.execute('chat.start', { text: '失败' });
  assert.match((await until(failed, s => s.status === 'error')).error, /DSH unavailable/);
  assert.equal(createDesktopChatService({ api: deferred, stateDir: path.join(dir, 'error'), model: () => ({}) }).execute('chat.status', {}).status, 'error');
  const interruptedDir = path.join(dir, 'interrupted');
  fs.mkdirSync(interruptedDir);
  fs.writeFileSync(path.join(interruptedDir, 'desktop-chat.json'), JSON.stringify({ status: 'running', sessionId: 'session-1', history: [] }));
  const interrupted = createDesktopChatService({ api: deferred, stateDir: interruptedDir, model: () => ({}) });
  assert.equal(interrupted.execute('chat.status', {}).status, 'interrupted');
  assert.throws(() => interrupted.execute('chat.start', { text: '不应重复提交' }), /中断/);
  assert.equal(interrupted.execute('chat.cancel', {}).status, 'cancelling');
  await until(interrupted, value => value.status === 'cancelled');
  assert.equal(interrupted.execute('chat.status', {}).sessionId, null);

  // Cancel must not reach DSH before an in-flight prompt RPC settles.
  let releasePrompt;
  let earlyCancelCalls = 0;
  const raceApi = {
    async callEndpoint(endpoint) {
      if (endpoint === 'workspace/create') return { workspace: { workspaceId: 'w' } };
      if (endpoint === 'session/create') return { sessionId: 'race-session' };
      if (endpoint === 'session/prompt') return new Promise(resolve => { releasePrompt = resolve; });
      if (endpoint === 'session/cancel') { earlyCancelCalls += 1; return {}; }
      return {};
    },
    async *openRemoteStream() { yield { type: 'snapshot', records: [] }; }
  };
  const raceService = createDesktopChatService({ api: raceApi, stateDir: path.join(dir, 'race'), model: () => ({}) });
  raceService.execute('chat.start', { text: 'race' });
  await until(raceService, s => s.status === 'running' && releasePrompt);
  assert.equal(raceService.execute('chat.cancel', {}).status, 'cancelling');
  assert.equal(earlyCancelCalls, 0, 'cancel must wait for prompt submission');
  releasePrompt({ accepted: true });
  await until(raceService, s => s.status === 'cancelled');
  assert.equal(earlyCancelCalls, 1);
  assert.equal(raceService.execute('chat.status', {}).sessionId, null);

  // An ambiguous prompt failure or no turn/end must block a new prompt on the same DSH session.
  const uncertainApi = {
    async callEndpoint(endpoint) {
      if (endpoint === 'workspace/create') return { workspace: { workspaceId: 'w' } };
      if (endpoint === 'session/create') return { sessionId: 'uncertain-session' };
      if (endpoint === 'session/prompt') throw Error('transport reset after remote acceptance');
      if (endpoint === 'session/cancel') return {};
      return {};
    },
    async *openRemoteStream() { yield { type: 'snapshot', records: [] }; }
  };
  const uncertain = createDesktopChatService({ api: uncertainApi, stateDir: path.join(dir, 'uncertain'), model: () => ({}) });
  uncertain.execute('chat.start', { text: 'first' });
  await until(uncertain, s => s.status === 'interrupted');
  assert.throws(() => uncertain.execute('chat.start', { text: 'duplicate' }), /中断|取消/);
  uncertain.execute('chat.cancel', {});
  await until(uncertain, s => s.status === 'cancelled');
  assert.equal(uncertain.execute('chat.status', {}).sessionId, null);

  const hanging = createDesktopChatService({ api: deferred, stateDir: path.join(dir, 'timeout'), model: () => ({}), turnTimeoutMs: 90 });
  hanging.execute('chat.start', { text: 'timeout' });
  await until(hanging, s => s.status === 'interrupted');
  assert.throws(() => hanging.execute('chat.start', { text: 'unsafe retry' }), /中断|取消/);
  hanging.execute('chat.cancel', {});
  await until(hanging, s => s.status === 'cancelled');

  // A late cancel failure must preserve a turn that completed while DSH processed cancellation.
  const finishDuringCancelApi = {
    async callEndpoint(endpoint) {
      if (endpoint === 'workspace/create') return { workspace: { workspaceId: 'w' } };
      if (endpoint === 'session/create') return { sessionId: 'complete-session' };
      if (endpoint === 'session/prompt') return { accepted: true };
      if (endpoint === 'session/cancel') { await new Promise(r => setTimeout(r, 300)); throw Error('late cancel failure'); }
      return {};
    },
    async *openRemoteStream() {
      yield { type: 'snapshot', records: [] };
      await new Promise(r => setTimeout(r, 90));
      yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
      await new Promise(r => setTimeout(r, 90));
      yield { type: 'event', event: { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'finished' }] } } } };
      yield { type: 'event', event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } };
    }
  };
  const finishDuringCancel = createDesktopChatService({ api: finishDuringCancelApi, stateDir: path.join(dir, 'complete-during-cancel'), model: () => ({}) });
  finishDuringCancel.execute('chat.start', { text: 'finish' });
  await until(finishDuringCancel, s => s.status === 'running');
  finishDuringCancel.execute('chat.cancel', {});
  await until(finishDuringCancel, s => s.status === 'completed');
  await new Promise(r => setTimeout(r, 320));
  assert.equal(finishDuringCancel.execute('chat.status', {}).status, 'completed');
  console.log('PASS: chat create/model/prompt/stream/result, session reuse, cancel, failure and restart recovery');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
