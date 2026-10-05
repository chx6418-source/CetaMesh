// CetaMesh Desktop 产品级 Chat 运行时（阶段 03）。
//
// 分层：IPC(chat.*) → 本模块（会话存储 + 回合状态机）→ dsh-client.js（唯一 DSH 通道）。
// 不依赖 bridge.js 内部状态；模型目录经注入的 controlExecute 复用现有
// model.catalog.list，不另造第二套 Provider Runtime。
//
// 回合协议（DSH 0.1.5 Typert 网关，与 QQ 桥接同源）：
//   session/create → session/selectModel → session/prompt(mode:'queue')
//   → session/follow 流（turn/start / assistant/chunk(text-delta 增量)
//     / assistant/message(该段完整组装文本，覆盖校准) / turn/end(reason)）
//   → session/cancel。
// 流式展示 = 已定稿段落连接 + 当前段 chunk 增量；turn/end 以最终文本定稿。
// usage：仅在事件携带结构化 usage 时透传，否则为 null（UI 显示"未知"），禁止伪造。
//
// 会话独占假设：一个 Chat 会话同时只允许一个回合（TURN_BUSY）；
// 与 DSH 网页端并发使用同一会话时事件可能混流，属已知限制。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { blocksToText } from '../dsh-client.js';
import { selectDshSessionModel } from '../dsh-model-selection.js';

const SCHEMA_VERSION = 1;
const REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
const CHAT_MODES = Object.freeze(['chat', 'smart']);
const PROVIDERS = Object.freeze(['dsh']);

const MAX_TITLE_CHARS = 200;
const MAX_PROMPT_CHARS = 32 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_CHARS = 256 * 1024;
const MAX_MESSAGES_RETURNED = 200;
const MAX_MESSAGE_CHARS_RETURNED = 32 * 1024;
const FOLLOW_RECONNECT_MS = 2000;

function chatError(code, message) {
  return Object.assign(new Error(message), { code });
}

function readJsonFile(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw chatError('STORE_CORRUPT', `会话数据读取失败：${file}（${error?.message ?? error}）`);
  }
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function requireText(value, label, maxChars) {
  if (typeof value !== 'string' || !value.trim()) throw chatError('INVALID_PARAMS', `${label}不能为空`);
  if (value.length > maxChars) throw chatError('INVALID_PARAMS', `${label}超过 ${maxChars} 字符上限`);
  return value;
}

/** 事件中的结构化 usage（存在才透传，找不到返回 null——不伪造）。 */
function extractUsage(event) {
  const candidates = [event?.data?.message?.usage, event?.data?.usage, event?.data?.reason?.usage];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

export function createChatService({
  api,
  controlExecute,
  agentExecute = null,
  agentProviders = [],
  defaults,
  stateDir,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (!api?.callEndpoint) throw new Error('chat-service 需要 DSH api 客户端');
  if (typeof controlExecute !== 'function') throw new Error('chat-service 需要 controlExecute（模型目录）');
  // Agent Provider（阶段 06）：会话可选指定 agentProvider（如 'dsh'），其回合经标准
  // AgentProvider 契约（agent.createSession / agent.send / agent.cancel）执行；
  // 未指定时保持"普通模型"直连路径，行为与阶段 03 完全一致。
  // 只有事件协议与 Chat 回合状态机兼容（dsh-session-events）的 Provider 可被选择。
  const selectableAgentProviders = new Map(
    (Array.isArray(agentProviders) ? agentProviders : [])
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => [entry.id, entry])
  );
  const dir = path.join(stateDir, 'desktop-chat');
  const sessionsFile = path.join(dir, 'sessions.json');
  const historyDir = path.join(dir, 'history');
  const baseConfig = {
    provider: 'dsh',
    model: String(defaults?.model ?? ''),
    reasoning: String(defaults?.reasoningEffort ?? 'max'),
    mode: 'chat'
  };

  const sessions = new Map(); // id -> record（含 config / dshSessionId / archived）
  const runtime = new Map(); // id -> { turn?, follow?: { controller, active } }

  function loadStore() {
    const store = readJsonFile(sessionsFile, null);
    const list = Array.isArray(store?.sessions) ? store.sessions : [];
    for (const record of list) {
      if (record && typeof record.id === 'string') sessions.set(record.id, normalizeRecord(record));
    }
  }

  function normalizeRecord(record) {
    return {
      id: record.id,
      title: typeof record.title === 'string' && record.title.trim() ? record.title : '新会话',
      createdAt: Number(record.createdAt) || 0,
      updatedAt: Number(record.updatedAt) || 0,
      archived: record.archived === true,
      dshSessionId: typeof record.dshSessionId === 'string' && record.dshSessionId ? record.dshSessionId : null,
      config: {
        provider: PROVIDERS.includes(record.config?.provider) ? record.config.provider : baseConfig.provider,
        model: typeof record.config?.model === 'string' ? record.config.model : baseConfig.model,
        reasoning: REASONING_EFFORTS.includes(record.config?.reasoning) ? record.config.reasoning : baseConfig.reasoning,
        mode: CHAT_MODES.includes(record.config?.mode) ? record.config.mode : baseConfig.mode,
        agentProvider: typeof record.config?.agentProvider === 'string' && record.config.agentProvider
          ? record.config.agentProvider
          : null
      }
    };
  }

  function saveStore() {
    atomicWriteJson(sessionsFile, { schemaVersion: SCHEMA_VERSION, sessions: [...sessions.values()] });
  }

  function historyFile(id) {
    return path.join(historyDir, `${id}.json`);
  }

  function readHistory(id) {
    const store = readJsonFile(historyFile(id), null);
    return Array.isArray(store?.messages) ? store.messages : [];
  }

  function appendMessage(id, message) {
    const messages = readHistory(id);
    messages.push(message);
    atomicWriteJson(historyFile(id), { schemaVersion: SCHEMA_VERSION, messages });
  }

  function touch(record) {
    record.updatedAt = now();
    saveStore();
  }

  function sessionOrThrow(id) {
    const record = sessions.get(String(id ?? ''));
    if (!record) throw chatError('SESSION_NOT_FOUND', '会话不存在或已删除');
    return record;
  }

  function runtimeOf(id) {
    let state = runtime.get(id);
    if (!state) {
      state = {};
      runtime.set(id, state);
    }
    return state;
  }

  // ── 会话 CRUD ────────────────────────────────────────────────────────────
  function listSessions({ includeArchived = false } = {}) {
    return [...sessions.values()]
      .filter((record) => includeArchived || !record.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, createdAt, updatedAt, archived, config }) => ({
        id, title, createdAt, updatedAt, archived, config
      }));
  }

  function createSession({ title } = {}) {
    const record = normalizeRecord({
      id: crypto.randomUUID(),
      title: title === undefined || title === null || title === '' ? '新会话' : requireText(String(title), '会话标题', MAX_TITLE_CHARS),
      createdAt: now(),
      updatedAt: now(),
      config: { ...baseConfig }
    });
    sessions.set(record.id, record);
    saveStore();
    return publicSession(record);
  }

  function publicSession(record) {
    const { id, title, createdAt, updatedAt, archived, config } = record;
    return { id, title, createdAt, updatedAt, archived, config, dshSessionId: record.dshSessionId };
  }

  function renameSession({ id, title }) {
    const record = sessionOrThrow(id);
    record.title = requireText(String(title), '会话标题', MAX_TITLE_CHARS);
    touch(record);
    return publicSession(record);
  }

  function archiveSession({ id, archived = true }) {
    const record = sessionOrThrow(id);
    record.archived = archived === true;
    touch(record);
    return publicSession(record);
  }

  function deleteSession({ id }) {
    const record = sessionOrThrow(id);
    stopFollow(String(record.id));
    sessions.delete(record.id);
    saveStore();
    try { fs.rmSync(historyFile(record.id), { force: true }); } catch { /* 尽力清理 */ }
    return { id: record.id, deleted: true };
  }

  function history({ id, limit } = {}) {
    const record = sessionOrThrow(id);
    const all = readHistory(record.id);
    const count = Math.min(Number(limit) || MAX_MESSAGES_RETURNED, MAX_MESSAGES_RETURNED);
    const tail = all.slice(-count).map((message) => ({
      ...message,
      text: typeof message.text === 'string' && message.text.length > MAX_MESSAGE_CHARS_RETURNED
        ? message.text.slice(0, MAX_MESSAGE_CHARS_RETURNED)
        : message.text
    }));
    return { id: record.id, total: all.length, messages: tail };
  }

  // ── 每会话配置 ───────────────────────────────────────────────────────────
  function setConfig({ id, config } = {}) {
    const record = sessionOrThrow(id);
    if (config?.provider !== undefined && !PROVIDERS.includes(config.provider)) {
      throw chatError('INVALID_PARAMS', `未知 Provider：${String(config.provider)}`);
    }
    if (config?.reasoning !== undefined && !REASONING_EFFORTS.includes(config.reasoning)) {
      throw chatError('INVALID_PARAMS', `reasoning 必须是 ${REASONING_EFFORTS.join('/')}`);
    }
    if (config?.mode !== undefined && !CHAT_MODES.includes(config.mode)) {
      throw chatError('INVALID_PARAMS', `mode 必须是 ${CHAT_MODES.join('/')}`);
    }
    if (config?.model !== undefined && (typeof config.model !== 'string' || config.model.length > 200)) {
      throw chatError('INVALID_PARAMS', 'model 必须是不超过 200 字符的字符串');
    }
    if (config?.agentProvider !== undefined) {
      // 普通模型 = null / ''；Agent Provider = 已注册且事件协议兼容的 id。
      if (config.agentProvider === null || config.agentProvider === '') {
        config.agentProvider = null;
      } else {
        const entry = selectableAgentProviders.get(String(config.agentProvider));
        if (!entry) {
          throw chatError('INVALID_PARAMS', `未知 Agent Provider：${String(config.agentProvider)}`);
        }
        if (entry.eventProtocol !== 'dsh-session-events') {
          throw chatError('INVALID_PARAMS', `Agent Provider「${entry.id}」的事件协议与 Chat 回合状态机不兼容`);
        }
        config.agentProvider = entry.id;
      }
    }
    if (config.provider !== undefined) record.config.provider = config.provider;
    if (config.model !== undefined) record.config.model = config.model;
    if (config.reasoning !== undefined) record.config.reasoning = config.reasoning;
    if (config.mode !== undefined) record.config.mode = config.mode;
    if (config.agentProvider !== undefined) record.config.agentProvider = config.agentProvider;
    touch(record);
    // 模型/reasoning 变更即时生效：已有 DSH 会话立即重新绑定（切换模型验收项）。
    if (record.dshSessionId && (config.model !== undefined || config.reasoning !== undefined)) {
      return selectModel(record).then(() => publicSession(record), (error) => {
        throw chatError('MODEL_BIND_FAILED', `模型切换失败：${error?.message ?? error}`);
      });
    }
    return publicSession(record);
  }

  async function selectModel(record) {
    // provider 归一化：config.json 的 dsh.provider 可能是历史值（llm-deepseek / dsh
    // 等）而非 DSH 可路由 provider；selectDshSessionModel 会在 NO_ADAPTER 时按官方
    // 模型目录解析并重试一次，其余错误（模型不存在等）原样上抛。
    const { value } = await selectDshSessionModel(api, {
      sessionId: record.dshSessionId,
      provider: record.config.provider === 'dsh' ? (defaults?.provider ?? 'deepseek-official') : record.config.provider,
      model: record.config.model,
      reasoningEffort: record.config.reasoning
    });
    return value;
  }

  async function catalog() {
    try {
      const value = await controlExecute({ method: 'model.catalog.list', params: {} });
      const entries = Array.isArray(value?.models) ? value.models : Array.isArray(value) ? value : [];
      return {
        providers: [...PROVIDERS],
        agentProviders: [...selectableAgentProviders.values()].map((entry) => ({ id: entry.id, label: entry.label ?? entry.id })),
        modes: [...CHAT_MODES],
        reasoning: [...REASONING_EFFORTS],
        models: entries.map((entry) => ({
          id: String(entry?.model ?? entry?.id ?? ''),
          label: String(entry?.label ?? entry?.model ?? entry?.id ?? ''),
          provider: String(entry?.provider ?? defaults?.provider ?? 'deepseek-official')
        })).filter((entry) => entry.id),
        error: null
      };
    } catch (error) {
      // 空 Provider / 目录不可用：返回明确 error，UI 下拉显示不可用而不是伪造列表。
      return {
        providers: [...PROVIDERS],
        agentProviders: [...selectableAgentProviders.values()].map((entry) => ({ id: entry.id, label: entry.label ?? entry.id })),
        modes: [...CHAT_MODES],
        reasoning: [...REASONING_EFFORTS],
        models: [],
        error: String(error?.message ?? error)
      };
    }
  }

  // ── DSH 会话与 follow 流 ─────────────────────────────────────────────────
  async function ensureDshSession(record) {
    if (record.dshSessionId) return record.dshSessionId;
    const value = await api.callEndpoint('session/create', { request: {} });
    record.dshSessionId = String(value?.sessionId ?? '');
    if (!record.dshSessionId) throw chatError('PROVIDER_ERROR', 'DSH 未返回 sessionId');
    try {
      await selectModel(record);
    } catch (error) {
      // 会话已建但模型绑定失败：保留会话，回合提交前给出明确错误。
      throw chatError('MODEL_BIND_FAILED', `模型绑定失败（${record.config.model}）：${error?.message ?? error}`);
    }
    saveStore();
    return record.dshSessionId;
  }

  function displayTextOf(state) {
    return state.messageTexts.join('') + state.chunkBuffer;
  }

  function handleChatEvent(record, state, event) {
    const data = event?.data ?? {};
    if (event.type === 'turn/start') {
      if (state.chunkBuffer) state.chunkBuffer = '';
      return;
    }
    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        state.chunkBuffer += chunk.text;
        if (state.turn) state.turn.displayText = displayTextOf(state);
      }
      return;
    }
    if (event.type === 'assistant/message') {
      const part = blocksToText(data.message?.content);
      if (part) {
        // 该段完整组装文本到达：定稿本段，清空 chunk 增量（避免翻倍）。
        state.messageTexts.push(part);
        state.chunkBuffer = '';
        if (state.turn) {
          state.turn.displayText = displayTextOf(state);
          const usage = extractUsage(event);
          if (usage) state.turn.usage = usage;
        }
      }
      return;
    }
    if (event.type === 'turn/end') {
      if (!state.turn) return;
      const text = displayTextOf(state);
      const reasonKind = String(data?.reason?.kind ?? 'unknown');
      const errorMessage = data?.reason?.error?.message ? String(data.reason.error.message).slice(0, 1000) : null;
      state.turn.displayText = text;
      const usage = extractUsage(event) ?? state.turn.usage ?? null;
      state.turn.usage = usage;
      if (reasonKind === 'completed') {
        state.turn.state = 'done';
      } else if (reasonKind === 'cancelled' || reasonKind === 'aborted') {
        state.turn.state = 'cancelled';
      } else {
        state.turn.state = 'error';
        state.turn.error = errorMessage ?? `回合异常结束（${reasonKind}）`;
      }
      finalizeTurn(record, state);
    }
  }

  /** 回合终态：有文本就落盘 assistant 消息；取消后丢弃 DSH 会话以隔离迟到事件。 */
  function finalizeTurn(record, state) {
    const turn = state.turn;
    const text = turn.displayText ?? '';
    if (text.trim() || turn.state === 'done') {
      appendMessage(record.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text,
        at: now(),
        turnId: turn.id,
        usage: turn.usage ?? null,
        ...(turn.state === 'error' ? { error: turn.error ?? '回合异常' } : {}),
        ...(turn.state === 'cancelled' ? { cancelled: true } : {})
      });
    }
    turn.state = turn.state === 'done' ? 'idle-done' : turn.state;
    state.turn = null;
    state.messageTexts = [];
    state.chunkBuffer = '';
    if (turn.state === 'cancelled' || turn.state === 'error') {
      // 取消/异常后丢弃 DSH 会话：下一条消息创建新会话，隔离迟到事件。
      record.dshSessionId = null;
      saveStore();
    }
    stopFollow(record.id);
  }

  function ensureFollow(record) {
    const state = runtimeOf(record.id);
    if (state.follow?.active) return;
    const controller = new AbortController();
    state.follow = { controller, active: true };
    const sessionId = record.dshSessionId;
    (async () => {
      while (state.follow?.active && state.follow.controller === controller) {
        try {
          for await (const item of api.openRemoteStream('session/follow', { request: { address: { kind: 'session', sessionId } } }, { signal: controller.signal })) {
            if (item.type !== 'event' || !item.event) continue;
            handleChatEvent(record, state, item.event);
          }
        } catch {
          if (controller.signal.aborted) break;
        }
        if (!state.follow?.active || state.follow.controller !== controller) break;
        await sleep(FOLLOW_RECONNECT_MS);
      }
    })();
  }

  function stopFollow(id) {
    const state = runtime.get(id);
    if (state?.follow?.active) {
      state.follow.active = false;
      try { state.follow.controller.abort(); } catch { /* 已退出 */ }
      state.follow = null;
    }
  }

  // ── 回合操作 ─────────────────────────────────────────────────────────────
  async function send({ id, text, attachments } = {}) {
    const record = sessionOrThrow(id);
    const content = requireText(text, '消息内容', MAX_PROMPT_CHARS);
    const state = runtimeOf(record.id);
    if (state.turn) throw chatError('TURN_BUSY', '当前会话有回合进行中，请先停止或等待完成');
    let promptText = content;
    const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
    for (const attachment of list) {
      const name = requireText(String(attachment?.name ?? 'attachment'), '附件名', 200);
      const body = requireText(String(attachment?.content ?? ''), `附件「${name}」内容`, MAX_ATTACHMENT_CHARS);
      promptText += `\n\n[附件 ${name}]\n${body}`;
    }
    const userMessage = { id: crypto.randomUUID(), role: 'user', text: content, at: now(), attachments: list.map((item) => String(item?.name ?? 'attachment')) };
    appendMessage(record.id, userMessage);
    await startTurn(record, state, promptText);
    return { userMessageId: userMessage.id };
  }

  async function retry({ id } = {}) {
    const record = sessionOrThrow(id);
    const state = runtimeOf(record.id);
    if (state.turn) throw chatError('TURN_BUSY', '当前会话有回合进行中');
    const messages = readHistory(record.id);
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') throw chatError('NOTHING_TO_RETRY', '没有可重试的用户消息（最后一回合已正常完成）');
    const attachments = Array.isArray(last.attachments) ? last.attachments : [];
    let promptText = last.text;
    // retry 只重发内容，不重复落盘 user 消息（同一条用户消息的新一次尝试）。
    for (const name of attachments) promptText += `\n\n[附件 ${name}]（内容见上一条消息）`;
    await startTurn(record, state, promptText);
    return { userMessageId: last.id };
  }

  async function continueTurn({ id } = {}) {
    const record = sessionOrThrow(id);
    const state = runtimeOf(record.id);
    if (state.turn) throw chatError('TURN_BUSY', '当前会话有回合进行中');
    await startTurn(record, state, '继续');
    return { continued: true };
  }

  async function startTurn(record, state, promptText) {
    state.messageTexts = [];
    state.chunkBuffer = '';
    state.turn = { id: crypto.randomUUID(), state: 'streaming', displayText: '', error: null, usage: null };
    const agentProviderId = record.config.agentProvider ?? null;
    try {
      if (agentProviderId && agentExecute) {
        // Agent Provider 路径：会话生命周期与回合提交经标准契约；
        // 事件流协议已由 setConfig 校验为 dsh-session-events，follow 状态机不变。
        if (!record.dshSessionId) {
          const created = await agentExecute({
            method: 'agent.createSession',
            params: {
              provider: agentProviderId,
              model: record.config.model || undefined,
              reasoningEffort: record.config.reasoning || undefined
            }
          });
          record.dshSessionId = String(created?.sessionId ?? '');
          if (!record.dshSessionId) throw chatError('PROVIDER_ERROR', 'Agent Provider 未返回 sessionId');
          saveStore();
        }
        ensureFollow(record);
        await agentExecute({
          method: 'agent.send',
          params: { provider: agentProviderId, sessionId: record.dshSessionId, content: promptText }
        });
      } else {
        if (agentProviderId && !agentExecute) {
          throw chatError('PROVIDER_ERROR', `Agent Provider 运行时不可用（${agentProviderId}）`);
        }
        await ensureDshSession(record);
        ensureFollow(record);
        await api.callEndpoint('session/prompt', {
          request: {
            requestId: `cetamesh-chat-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
            sessionId: record.dshSessionId,
            mode: 'queue',
            content: [{ type: 'text', text: promptText }]
          }
        });
      }
    } catch (error) {
      state.turn = null;
      state.messageTexts = [];
      state.chunkBuffer = '';
      throw error instanceof Error && error.code ? error : chatError('PROVIDER_ERROR', String(error?.message ?? error));
    }
  }

  function status({ id } = {}) {
    const record = sessionOrThrow(id);
    const state = runtimeOf(record.id);
    const turn = state.turn;
    if (!turn) {
      const messages = readHistory(record.id);
      const last = messages[messages.length - 1];
      return {
        id: record.id,
        turn: null,
        lastState: last?.role === 'user' ? 'awaiting-reply' : 'idle',
        dshSessionAlive: Boolean(record.dshSessionId)
      };
    }
    return {
      id: record.id,
      turn: {
        id: turn.id,
        state: turn.state,
        displayText: turn.displayText,
        error: turn.error,
        usage: turn.usage
      }
    };
  }

  async function stop({ id } = {}) {
    const record = sessionOrThrow(id);
    const state = runtimeOf(record.id);
    const turn = state.turn;
    if (!turn || turn.state !== 'streaming') {
      return { stopped: false, reason: 'no-active-turn' };
    }
    turn.state = 'cancelling';
    try {
      if (record.dshSessionId) {
        if (record.config.agentProvider && agentExecute) {
          await agentExecute({
            method: 'agent.cancel',
            params: { provider: record.config.agentProvider, sessionId: record.dshSessionId }
          });
        } else {
          await api.callEndpoint('session/cancel', { request: { sessionId: record.dshSessionId } });
        }
      }
      // turn/end（cancelled）由 follow 流异步确认；此处仅上报已受理。
      return { stopped: true, state: 'cancelling' };
    } catch (error) {
      turn.state = 'streaming';
      throw chatError('CANCEL_FAILED', `取消未确认：${error?.message ?? error}`);
    }
  }

  function close() {
    for (const id of [...runtime.keys()]) stopFollow(id);
  }

  loadStore();

  const handlers = {
    'chat.sessions.list': (params) => ({ sessions: listSessions(params ?? {}) }),
    'chat.sessions.create': (params) => createSession(params ?? {}),
    'chat.sessions.rename': (params) => renameSession(params ?? {}),
    'chat.sessions.archive': (params) => archiveSession(params ?? {}),
    'chat.sessions.delete': (params) => deleteSession(params ?? {}),
    'chat.history': (params) => history(params ?? {}),
    'chat.send': (params) => send(params ?? {}),
    'chat.status': (params) => status(params ?? {}),
    'chat.stop': (params) => stop(params ?? {}),
    'chat.retry': (params) => retry(params ?? {}),
    'chat.continue': (params) => continueTurn(params ?? {}),
    'chat.config.set': (params) => setConfig(params ?? {}),
    'chat.catalog': () => catalog()
  };

  return {
    execute({ method, params }) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(chatError('METHOD_NOT_FOUND', `未知 Chat 方法：${method}`));
      // 统一异步语义：同步 handler 的 throw 也转为 rejected Promise。
      return Promise.resolve().then(() => handler(params));
    },
    /** 测试钩子：直接投递一条 follow 事件（等价于 DSH 流下发）。 */
    _injectEvent(id, event) {
      const record = sessionOrThrow(id);
      handleChatEvent(record, runtimeOf(record.id), event);
    },
    _store: { dir, sessionsFile, historyDir },
    close
  };
}
