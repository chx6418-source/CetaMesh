import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACTIVE = new Set(['preparing', 'running', 'cancelling']);
const MAX_HISTORY = 20;
const MAX_PROMPT = 4000;
const MAX_REPLY = 16000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

function chatError(code, message) {
  return Object.assign(new Error(message), { code });
}

function withTimeout(promise, ms, code, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(chatError(code, message)), ms); })])
    .finally(() => clearTimeout(timer));
}

export function createDesktopChatService({ api, stateDir, model = () => ({}), turnTimeoutMs = TURN_TIMEOUT_MS }) {
  if (!api || typeof api.callEndpoint !== 'function' || typeof api.openRemoteStream !== 'function') throw new TypeError('DSH API required');
  const file = path.join(stateDir, 'desktop-chat.json');
  let stored = {};
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const state = {
    sessionId: typeof stored.sessionId === 'string' && stored.sessionId.length < 256 ? stored.sessionId : null,
    status: ACTIVE.has(stored.status) ? 'interrupted' : (typeof stored.status === 'string' ? stored.status : 'idle'),
    requestId: typeof stored.requestId === 'string' ? stored.requestId : null,
    draft: typeof stored.draft === 'string' ? stored.draft.slice(0, MAX_REPLY) : '',
    reply: typeof stored.reply === 'string' ? stored.reply.slice(0, MAX_REPLY) : '',
    error: typeof stored.error === 'string' ? stored.error.slice(0, 1000) : '',
    history: Array.isArray(stored.history) ? stored.history.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-MAX_HISTORY).map(item => ({ role: item.role, text: item.text.slice(0, MAX_REPLY) })) : []
  };
  let current = null;
  function save() {
    fs.mkdirSync(stateDir, { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  if (state.status === 'interrupted') {
    state.error = 'Core 重启中断了上一轮；提示词不会自动重发。请核对 DSH 会话后手动重试。';
    save();
  }
  function snapshot() {
    return {
      sessionId: state.sessionId, status: state.status, requestId: state.requestId,
      draft: state.draft, reply: state.reply, error: state.error,
      history: state.history.slice()
    };
  }
  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    const cwd = path.join(stateDir, 'desktop-chat-workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const workspace = await api.callEndpoint('workspace/create', { request: { path: cwd } }, AbortSignal.timeout(10000));
    const workspaceId = workspace?.workspace?.workspaceId;
    if (!workspaceId) throw chatError('DSH_INVALID_RESPONSE', 'DSH 没有返回 workspaceId');
    const created = await api.callEndpoint('session/create', { request: { workspaceId } }, AbortSignal.timeout(10000));
    if (typeof created?.sessionId !== 'string' || !created.sessionId) throw chatError('DSH_INVALID_RESPONSE', 'DSH 没有返回 sessionId');
    state.sessionId = created.sessionId;
    save();
    return state.sessionId;
  }
  async function settleCancellation(entry, sessionId, promptAttempted) {
    if (!entry.active) return;
    try {
      if (promptAttempted && sessionId) {
        await api.callEndpoint('session/cancel', { request: { sessionId } }, AbortSignal.timeout(7000));
      }
    } catch (error) {
      if (!entry.active) return;
      state.status = 'interrupted';
      state.error = '取消未确认：' + String(error?.message ?? error).slice(0, 900);
      save();
      return;
    }
    if (!entry.active) return;
    if (promptAttempted) state.sessionId = null; // isolate any late events from the old DSH turn
    state.status = 'cancelled';
    state.error = '';
    save();
    entry.active = false;
    entry.wake?.();
  }

  async function runTurn(entry, text) {
    let first;
    let complete;
    const ready = new Promise((resolve, reject) => { first = { resolve, reject }; });
    const done = new Promise(resolve => { complete = resolve; });
    entry.wake = complete;
    let sawFirst = false;
    let promptSent = false;
    let lastSeq = -1;
    let turn = null;
    const onEvent = event => {
      if (!entry.active || !event || typeof event !== 'object') return;
      if (event.type === 'turn/start') {
        turn = event.data?.turn;
        if (!entry.cancelRequested) state.status = 'running';
      } else if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta' && (turn === null || event.data?.turn === turn)) {
        const part = event.data.chunk.text;
        if (typeof part === 'string') state.draft = (state.draft + part).slice(0, MAX_REPLY);
      } else if (event.type === 'assistant/message' && (turn === null || event.data?.turn === turn)) {
        const text = (event.data?.message?.content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
        if (text) state.reply = text.slice(0, MAX_REPLY);
      } else if (event.type === 'turn/end' && (turn === null || event.data?.turn === turn)) {
        const reason = event.data?.reason?.kind;
        if (reason === 'completed') {
          state.reply ||= state.draft;
          state.status = 'completed';
          if (state.reply) state.history.push({ role: 'assistant', text: state.reply });
        } else if (reason === 'aborted') {
          state.status = 'cancelled';
        } else {
          state.status = 'error';
          state.error = String(event.data?.reason?.error?.message ?? 'Agent 回合异常').slice(0, 1000);
        }
        state.history = state.history.slice(-MAX_HISTORY);
        save();
        entry.active = false;
        complete();
      }
    };
    const onItem = item => {
      if (item?.type === 'snapshot') {
        const records = Array.isArray(item.records) ? item.records : [];
        if (!promptSent) {
          for (const record of records) {
            const seq = record?.seq ?? record?.event?.seq;
            if (Number.isSafeInteger(seq)) lastSeq = Math.max(lastSeq, seq);
          }
        } else {
          for (const record of records) consume(record?.event, record?.seq);
        }
      } else if (item?.type === 'event') consume(item.event, item.event?.seq);
      if (!sawFirst) { sawFirst = true; first.resolve(); }
    };
    const consume = (event, recordSeq) => {
      const seq = recordSeq ?? event?.seq;
      if (Number.isSafeInteger(seq)) {
        if (seq <= lastSeq) return;
        lastSeq = seq;
      }
      if (promptSent) onEvent(event);
    };
    let follow = Promise.resolve();
    const startFollow = () => (async () => {
      while (entry.active && !entry.controller.signal.aborted) {
        try {
          for await (const item of api.openRemoteStream(
            'session/follow',
            { request: { address: { kind: 'session', sessionId: state.sessionId } } },
            { signal: entry.controller.signal }
          )) {
            onItem(item);
            if (!entry.active) break;
          }
        } catch (error) {
          if (!sawFirst) first.reject(error);
          if (!entry.active || entry.controller.signal.aborted) break;
        }
        if (entry.active && !entry.controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 250));
      }
    })();
    try {
      const sessionId = await ensureSession();
      follow = startFollow();
      if (!entry.active) return;
      if (entry.cancelRequested) { await settleCancellation(entry, sessionId, false); return; }
      const defaults = model() ?? {};
      if (defaults.provider && defaults.model) {
        await api.callEndpoint('session/selectModel', {
          request: { sessionId, provider: defaults.provider, model: defaults.model, reasoningEffort: defaults.reasoningEffort ?? 'low' }
        }, AbortSignal.timeout(10000));
      }
      if (!entry.active) return;
      if (entry.cancelRequested) { await settleCancellation(entry, sessionId, false); return; }
      await withTimeout(ready, 10000, 'DSH_TIMEOUT', 'DSH 会话流未就绪');
      if (!entry.active) return;
      if (entry.cancelRequested) { await settleCancellation(entry, sessionId, false); return; }
      state.status = 'running';
      save();
      promptSent = true;
      entry.promptAttempted = true;
      await api.callEndpoint('session/prompt', {
        request: { requestId: entry.id, sessionId, mode: 'queue', content: [{ type: 'text', text }] }
      }, AbortSignal.timeout(10000));
      if (entry.cancelRequested) await settleCancellation(entry, sessionId, true);
      else await withTimeout(done, turnTimeoutMs, 'TURN_TIMEOUT', 'Agent 回合超过 5 分钟；未自动重发');
      if (entry.cancelRequested) await settleCancellation(entry, sessionId, true);
    } catch (error) {
      if (entry.cancelRequested) await settleCancellation(entry, state.sessionId, entry.promptAttempted);
      else if (entry.active) {
        state.status = entry.promptAttempted ? 'interrupted' : 'error';
        state.error = String(error?.message ?? error).slice(0, 1000);
        save();
      }
    } finally {
      entry.active = false;
      entry.controller.abort();
      await follow.catch(() => {});
      if (current === entry) current = null;
    }
  }
  function start(params) {
    const keys = Object.keys(params ?? {});
    if (keys.some(key => key !== 'text') || typeof params?.text !== 'string' || !params.text.trim() || params.text.length > MAX_PROMPT) {
      throw chatError('INVALID_PARAMS', 'chat.start text 必须为 1-4000 字符');
    }
    if (current?.active) throw chatError('CHAT_BUSY', 'chat busy: 当前回合尚未完成');
    if (state.status === 'interrupted' || state.status === 'cancelling') throw chatError('CHAT_RECOVERY_REQUIRED', '上轮中断或取消中，请先确认 DSH 回合已停止');
    const entry = { id: crypto.randomUUID(), active: true, cancelRequested: false, promptAttempted: false, controller: new AbortController() };
    state.status = 'preparing';
    state.requestId = entry.id;
    state.draft = '';
    state.reply = '';
    state.error = '';
    state.history.push({ role: 'user', text: params.text });
    state.history = state.history.slice(-MAX_HISTORY);
    save();
    current = entry;
    void runTurn(entry, params.text);
    return snapshot();
  }
  function cancel(params) {
    if (Object.keys(params ?? {}).length) throw chatError('INVALID_PARAMS', 'chat.cancel 不接收参数');
    const entry = current;
    if (entry?.active) {
      if (entry.cancelRequested) return snapshot();
      entry.cancelRequested = true;
      state.status = 'cancelling';
      save();
      entry.wake?.();
      return snapshot();
    }
    if (state.status !== 'interrupted' || !state.sessionId) return snapshot();
    state.status = 'cancelling';
    save();
    const oldSession = state.sessionId;
    void api.callEndpoint('session/cancel', { request: { sessionId: oldSession } }, AbortSignal.timeout(7000))
      .then(() => {
        if (state.status !== 'cancelling') return;
        state.sessionId = null;
        state.status = 'cancelled';
        state.error = '';
        save();
      }, error => {
        if (state.status !== 'cancelling') return;
        state.status = 'interrupted';
        state.error = '取消未确认：' + String(error?.message ?? error).slice(0, 900);
        save();
      });
    return snapshot();
  }
  return Object.freeze({
    execute(method, params = {}) {
      if (method === 'chat.status') {
        if (Object.keys(params ?? {}).length) throw chatError('INVALID_PARAMS', 'chat.status 不接收参数');
        return snapshot();
      }
      if (method === 'chat.start') return start(params);
      if (method === 'chat.cancel') return cancel(params);
      throw chatError('METHOD_NOT_FOUND', '未知桌面对话方法');
    }
  });
}
