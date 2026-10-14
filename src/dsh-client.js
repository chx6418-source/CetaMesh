// Node 环境的 DSH Web API 客户端（适配 DSH 0.1.5+ "Typert 网关"协议）。
// unary RPC：POST /api/<ns/method>，body = {type:'client-request', rpcId, method, payload:{args}}，
//           响应 {type:'server-response', rpcId, result:{ok,value|error}}。
// 事件/会话流：WebSocket /api/remote.mux，客户端发 {type:'open', streamId, endpoint, payload:{args}}，
//             服务端下发 {type:'item'|'end'|'error', streamId, ...}（ping/pong 由 ws 自动处理）。
// 鉴权：DSH 0.1.5 起 /api/* 强制浏览器会话 Cookie（回环地址也不例外），由 ./dsh-auth.js 离线锻造。
// 端点速查（0.1.5-rc.1/rc.2 实测）：session/create|prompt|selectModel|list|cancel|follow，
//   workspace/create|rename|delete|archiveSession|follow，settings/describe，agentPresets/list，
//   $events（全局事件流）、$events/result（瀑布事件应答）。旧协议 /api/events.mux 已移除。
import WebSocket from 'ws';
import { resolveDshAuthCookie } from './dsh-auth.js';

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export class NodeApiClient {
  constructor(baseUrl, { authCookie, dshHome, timeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.authCookieOption = authCookie;
    this.dshHome = dshHome;
    this.timeoutMs = Math.max(100, Math.min(120_000, Number(timeoutMs) || DEFAULT_RPC_TIMEOUT_MS));
    this.rpcSeq = 0;
    this.streamSeq = 0;
  }

  authCookie() {
    return resolveDshAuthCookie(this.baseUrl, this.authCookieOption, this.dshHome);
  }

  /** 新版 unary RPC：payload 固定包一层 {args}；业务错误与传输错误都抛 Error（含端点名）。 */
  async callEndpoint(endpoint, args = {}, signal) {
    const rpcId = `whalebridge-${Date.now().toString(36)}-${(++this.rpcSeq).toString(36)}`;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let cookie;
    try { cookie = this.authCookie(); }
    catch (error) {
      throw Object.assign(new Error(`${endpoint}: DSH auth credentials are unavailable`), { code: 'DSH_AUTH_MATERIAL_MISSING', cause: error });
    }
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: effectiveSignal
      });
    } catch (error) {
      const timedOut = deadline.aborted && !signal?.aborted;
      throw Object.assign(new Error(`${endpoint}: ${timedOut ? '请求超时' : '传输失败'}（${error?.cause?.code ?? error?.message ?? error}）`, { cause: error }), {
        code: timedOut ? 'DSH_REQUEST_TIMEOUT' : signal?.aborted ? 'ABORTED' : 'DSH_UNREACHABLE'
      });
    }
    let text;
    try { text = await res.text(); }
    catch (error) {
      const timedOut = deadline.aborted && !signal?.aborted;
      throw Object.assign(new Error(`${endpoint}: ${timedOut ? '请求超时' : '响应读取失败'}`), {
        code: timedOut ? 'DSH_REQUEST_TIMEOUT' : signal?.aborted ? 'ABORTED' : 'DSH_UNREACHABLE', cause: error
      });
    }
    let full = null;
    try { full = JSON.parse(text); } catch { /* 非 JSON（如纯文本 4xx） */ }
    if (!res.ok || !full || full.type !== 'server-response' || full.rpcId !== rpcId) {
      const hint = res.status === 401 ? '（鉴权被拒：检查 DSH 是否为 0.1.5+ 且 .dsh/.credentials.yaml 可读）'
        : res.status === 403 ? '（Host/Origin 栅栏拒绝）' : '';
      throw Object.assign(new Error(`${endpoint}: HTTP ${res.status}${hint}${full ? '' : ` ${text.slice(0, 120)}`}`), {
        code: res.status === 401 ? 'DSH_AUTHENTICATION_FAILED'
          : res.status === 403 ? 'DSH_HOST_ORIGIN_REJECTED' : 'DSH_HTTP_ERROR', status: res.status
      });
    }
    if (!full.result.ok) {
      const { code, message } = full.result.error ?? {};
      throw Object.assign(new Error(`${endpoint} failed: ${code}: ${message}`), { code: String(code || 'DSH_API_ERROR') });
    }
    return full.result.value;
  }

  /** 应答一条瀑布事件（user-questions/request 或 approval/request）。 */
  answerRemoteEvent(clientId, eventId, outcome) {
    return this.callEndpoint('$events/result', { clientId, eventId, outcome });
  }

  /**
   * 打开一条 /api/remote.mux 逻辑流，异步迭代服务端下发的每个 item.value。
   * - $events 流首帧为 {type:'ready', clientId, host}；
   * - session/follow 流首帧为 {type:'snapshot', ...}，随后为 {type:'event', event}；
   * - error 帧抛 Error；end 帧与 socket 断开正常 return（调用方据此决定重连）。
   * options.signal 中止时立即关闭 socket；options.onSocket 用于外部监听底层连接事件。
   */
  async *openRemoteStream(endpoint, args = {}, options = {}) {
    const streamId = `whalebridge-s${(++this.streamSeq).toString(36)}`;
    const url = this.baseUrl.replace(/^http/, 'ws') + '/api/remote.mux';
    const socket = new WebSocket(url, { headers: { cookie: this.authCookie() } });
    const inbox = [];
    let wake;
    let settled = false;
    const enqueue = (item) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    socket.on('open', () => {
      try {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
      } catch (error) {
        enqueue({ kind: 'socket-error', message: `打开流失败：${error?.message ?? error}` });
      }
    });
    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error(`[dsh-client] 丢弃 ${endpoint} 流上的非 JSON 帧`);
        return;
      }
      if (msg.streamId !== streamId) return;
      if (msg.type === 'item') enqueue({ kind: 'item', value: msg.value });
      else if (msg.type === 'end') enqueue({ kind: 'end' });
      else if (msg.type === 'error') enqueue({ kind: 'error', error: msg.error });
    });
    socket.on('close', (code, reason) => {
      if (!settled) enqueue({ kind: 'socket-close', code, reason: String(reason ?? '') });
    });
    socket.on('error', (error) => {
      enqueue({ kind: 'socket-error', message: error?.message ?? String(error) });
    });
    const abort = () => {
      try { socket.close(); } catch { /* 已关闭 */ }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    options.onSocket?.(socket);
    try {
      for (;;) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item.kind === 'item') {
            yield item.value;
          } else if (item.kind === 'end') {
            settled = true;
            return;
          } else if (item.kind === 'error') {
            settled = true;
            throw new Error(`${endpoint} 流错误: ${item.error?.code}: ${item.error?.message}`);
          } else if (item.kind === 'socket-error') {
            settled = true;
            throw new Error(`${endpoint} WebSocket 错误: ${item.message}`);
          } else if (item.kind === 'socket-close') {
            settled = true;
            return;
          }
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      try { socket.close(); } catch { /* 已关闭 */ }
    }
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    }
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
