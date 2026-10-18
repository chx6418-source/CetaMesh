// MCP 数据面 Local IPC（D1-003）：把 mcp-snowluma-safe / mcp-host-server 依赖的
// loopback HTTP 数据面迁到 named pipe，使 release worker 可以完全不监听 127.0.0.1。
//
// 传输契约（与 control/ipc-protocol.js 的 UI IPC 同一套 framing）：
//   · 4 字节小端长度前缀 + UTF-8 JSON，协议版本 1；
//   · 客户端唯一合法 method 是 data.call，params 形如
//       { method: 'GET'|'POST', path: '/api/...', query?, body?, token?, sessionToken? }
//     其中 token 是服务令牌（state/agent-token，等价旧 HTTP x-console-token），
//     sessionToken 等价旧 HTTP x-agent-token（会话级令牌）；
//   · 服务端把 data.call 还原成一个虚拟 HTTP 请求，交给当前进程拥有的
//     handleApiRequest；纯 Core 只提供最小健康接口，显式 Legacy 入口保留旧路由；
//   · 控制面方法（control.execute / capability.* 等）在 data pipe 上一律
//     METHOD_NOT_FOUND：Control Plane != Data Plane（D1-004）。
//
// 安全说明：pipe 名按数据目录派生，默认 DACL 限定当前用户会话（与读取
// state/agent-token 的信任边界一致）；服务令牌仍逐请求校验，不因换传输而放宽。
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { APP_PATHS } from '../app-paths.js';
import { startIpcProtocol } from './ipc-protocol.js';

export const DATA_IPC_METHOD = 'data.call';
// 数据面帧上限：/api/images/message 等路由在 JSON 里返回 base64 图片，1 MiB 的
// UI-IPC 上限不够；16 MiB 覆盖 QQ 表情/图片的实际上限，同时保持有界。
export const DATA_IPC_MAX_FRAME_BYTES = 16 * 1024 * 1024;
// qq_wait_for_messages 最长可挂 timeoutMs(≤600s) + quietMs(≤120s) + 5s ≈ 725s，
// 与 MCP 侧 toolCallTimeoutMs 对齐；这里留出裕量。
export const DATA_IPC_DISPATCH_TIMEOUT_MS = 760_000;

/** 稳定短哈希（FNV-1a 32bit），用于把数据目录映射进 pipe 名。 */
function fnv1a32Hex(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 数据面 pipe 名。worker 与 MCP 进程各自用同一数据目录推导出同一名字，
 * 不依赖环境变量传递（MCP 由 DSH spawn，拿不到 worker 的 env）。
 * WHALEBRIDGE_DATA_PIPE 可显式覆盖（并行测试用）。
 */
export function resolveDataPipeName({ env = process.env, dataRoot = APP_PATHS.dataRoot } = {}) {
  const override = String(env.WHALEBRIDGE_DATA_PIPE ?? '').trim();
  if (override) return override;
  const normalized = path.resolve(String(dataRoot ?? '')).toLowerCase();
  const hash = fnv1a32Hex(normalized);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\WhaleBridge-Data-${hash}`
    : path.join(os.tmpdir(), `whalebridge-data-${hash}.sock`);
}

function dataIpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

// ── 服务端 ───────────────────────────────────────────────────────────────────

/** 把捕获的虚拟响应整理成可放进 JSON 帧的形状。 */
function finishCapture(capture) {
  const buffer = Buffer.concat(capture.chunks);
  const text = buffer.toString('utf8');
  const roundTrips = Buffer.from(text, 'utf8').equals(buffer);
  return {
    status: capture.status,
    headers: capture.headers ?? {},
    body: roundTrips ? text : undefined,
    bodyBase64: roundTrips ? undefined : buffer.toString('base64')
  };
}

/**
 * 把一次 data.call 还原成虚拟 HTTP req/res 并交给 handleApiRequest。
 * 只暴露白名单内路由可达（鉴权闸门在 handleApiRequest 内，与旧 HTTP 共用）。
 */
export async function executeDataCall(params, { handleApiRequest, signal } = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw dataIpcError('INVALID_PARAMS', 'data.call params must be a JSON object');
  }
  const httpMethod = String(params.method ?? 'GET').toUpperCase();
  if (httpMethod !== 'GET' && httpMethod !== 'POST') {
    throw dataIpcError('INVALID_PARAMS', `data.call method must be GET or POST, got: ${httpMethod}`);
  }
  const urlPath = String(params.path ?? '');
  if (!urlPath.startsWith('/api/')) {
    throw dataIpcError('INVALID_PARAMS', 'data.call path must start with /api/');
  }
  let url = urlPath;
  if (params.query !== undefined && params.query !== null) {
    if (!params.query || typeof params.query !== 'object' || Array.isArray(params.query)) {
      throw dataIpcError('INVALID_PARAMS', 'data.call query must be a JSON object');
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params.query)) search.set(String(key), String(value));
    const encoded = search.toString();
    if (encoded) url += `?${encoded}`;
  }
  const headers = { 'content-type': 'application/json' };
  // 空 token 一律不携带：与旧 HTTP 一致，空字符串不能冒充有效凭据。
  if (typeof params.token === 'string' && params.token) headers['x-console-token'] = params.token;
  if (typeof params.sessionToken === 'string') {
    // 显式携带空会话令牌时保留空值：bridge.js 的闸门会把 x-agent-token === ''
    // 判为「agent token 不能为空」拒绝，与旧 HTTP 行为一致。
    headers['x-agent-token'] = params.sessionToken;
  }

  // A Readable keeps request bytes buffered even when a route attaches its
  // body listeners after an await. autoDestroy=false reserves 'close' for an
  // actual IPC cancellation rather than an ordinary end-of-body event.
  const req = new Readable({ read() {}, autoDestroy: false });
  req.method = httpMethod;
  req.url = url;
  req.headers = headers;
  const res = new EventEmitter();
  const capture = { status: 0, headers: null, chunks: [] };
  let settled = false;

  return await new Promise((resolve, reject) => {
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    res.writeHead = (status, responseHeaders) => {
      capture.status = Number(status) || 0;
      capture.headers = responseHeaders ?? {};
      return res;
    };
    res.write = (chunk) => {
      if (chunk !== undefined && chunk !== null) {
        capture.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) res.write(chunk);
      settle(resolve, finishCapture(capture));
      return res;
    };
    // 客户端超时/断开：模拟连接关闭，让 wait 等长轮询 handler 的 req 'close'
    // 清理路径生效（activeWaits 释放），不留下悬挂会话。
    signal?.addEventListener('abort', () => {
      req.emit('aborted');
      req.emit('close');
      settle(reject, Object.assign(new Error('Data IPC call aborted'), { code: 'IPC_CLOSED' }));
    }, { once: true });

    const body = params.body;
    const bodyBuffer = body === undefined || body === null
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(body), 'utf8');
    // Start the handler before emitting the virtual request body. Otherwise
    // its readBody() listeners miss both data and end and POST hangs forever.
    let handling;
    try { handling = handleApiRequest(req, res); }
    catch (error) { settle(reject, error); return; }
    queueMicrotask(() => {
      if (settled) return;
      if (bodyBuffer.length) req.push(bodyBuffer);
      req.push(null);
    });

    Promise.resolve(handling)
      .then(() => settle(resolve, finishCapture(capture)))
      .catch((error) => settle(reject, error));
  });
}

/**
 * 启动数据面 pipe 服务。返回未 listen 的 net.Server，由调用方 listen 并处理错误
 * （与 UI IPC 同样的生命周期归属：启动该进程的 Core/Legacy 入口负责关闭）。
 */
export function startDataIpcServer({ handleApiRequest, log = () => {}, pipeName = resolveDataPipeName() } = {}) {
  if (typeof handleApiRequest !== 'function') throw new TypeError('handleApiRequest is required');
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const connection = startIpcProtocol({
      input: socket,
      output: socket,
      maxFrameBytes: DATA_IPC_MAX_FRAME_BYTES,
      dispatchTimeoutMs: DATA_IPC_DISPATCH_TIMEOUT_MS,
      // 白名单：数据面 pipe 只接受 data.call。control.execute 与产品私有方法族
      // 在这里一律 METHOD_NOT_FOUND —— 控制面不会因为 HTTP 移除而混进数据面。
      methodFilter: (method) => method === DATA_IPC_METHOD,
      dispatch: async ({ method, params }, { signal } = {}) => {
        if (method !== DATA_IPC_METHOD) {
          throw dataIpcError('METHOD_NOT_FOUND', `Unknown data IPC method: ${method}`);
        }
        return await executeDataCall(params, { handleApiRequest, signal });
      }
    });
    connection.done.catch((error) => {
      if (!socket.destroyed) log(`Data IPC connection failed: ${error?.message ?? error}`);
    });
  });
  server.maxConnections = 8;
  return server;
}

// ── 客户端 ───────────────────────────────────────────────────────────────────

const CLIENT_MAX_FRAME_BYTES = DATA_IPC_MAX_FRAME_BYTES;

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > CLIENT_MAX_FRAME_BYTES) throw new Error('Data IPC request exceeds frame limit');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function connectPipe(pipeName, connectBudgetMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.connect(pipeName);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        callback(value);
      };
      socket.once('connect', () => finish(resolve, socket));
      socket.once('error', (error) => {
        finish(() => {
          socket.destroy();
          if (Date.now() - started < connectBudgetMs) setTimeout(attempt, 100);
          else reject(Object.assign(new Error(`Data IPC connect failed: ${error?.message ?? error}`), { code: error?.code ?? 'ECONNREFUSED' }));
        });
      });
    };
    attempt();
  });
}

/** 读取帧直到拿到与 id 匹配的响应；事件帧（core.ready 等）跳过。 */
function readResponse(socket, id, deadlineMs) {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    let expectedLength = null;
    let discardRemaining = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error(`Data IPC response timeout after ${deadlineMs}ms`), { code: 'ETIMEDOUT' }));
    }, Math.max(1, deadlineMs - Date.now()));
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        if (discardRemaining > 0) {
          const skip = Math.min(discardRemaining, bytes.length - offset);
          offset += skip;
          discardRemaining -= skip;
          continue;
        }
        if (expectedLength === null) {
          const take = Math.min(4 - header.length, bytes.length - offset);
          header = header.length === 0 ? bytes.subarray(offset, offset + take) : Buffer.concat([header, bytes.subarray(offset, offset + take)]);
          offset += take;
          if (header.length < 4) continue;
          expectedLength = header.readUInt32LE(0);
          header = Buffer.alloc(0);
          payload = Buffer.alloc(0);
          if (expectedLength > CLIENT_MAX_FRAME_BYTES) {
            fail(new Error(`Data IPC response frame too large: ${expectedLength}`));
            return;
          }
        }
        const take = Math.min(expectedLength - payload.length, bytes.length - offset);
        if (take > 0) {
          payload = payload.length === 0 ? bytes.subarray(offset, offset + take) : Buffer.concat([payload, bytes.subarray(offset, offset + take)]);
          offset += take;
        }
        if (payload.length === expectedLength) {
          let message;
          try {
            message = JSON.parse(payload.toString('utf8'));
          } catch {
            fail(new Error('Data IPC response frame is not valid JSON'));
            return;
          }
          payload = Buffer.alloc(0);
          expectedLength = null;
          if (message && typeof message === 'object' && message.id === id) {
            cleanup();
            if (message.ok) resolve(message.result ?? null);
            else {
              const error = new Error(message.error?.message ?? 'Data IPC call failed');
              error.code = message.error?.code ?? 'INTERNAL_ERROR';
              reject(error);
            }
            return;
          }
          // 不匹配 id 的帧（core.ready 等事件帧）忽略。
        }
      }
    };
    const onError = (error) => fail(Object.assign(new Error(`Data IPC connection error: ${error?.message ?? error}`), { code: error?.code ?? 'ECONNRESET' }));
    const onClose = () => fail(Object.assign(new Error('Data IPC connection closed before response'), { code: 'ECONNRESET' }));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

let callSequence = 0;

/**
 * 数据面调用。返回 { status, ok, headers, text, json }，形状对齐旧 fetch 用法：
 * ok = 2xx；json 尽量解析（与旧 agentApi 的 res.json() 容错一致）。
 */
export async function dataCall({
  method = 'GET',
  path,
  query,
  body,
  token,
  sessionToken,
  timeoutMs = 15000,
  pipeName = resolveDataPipeName()
} = {}) {
  const totalMs = Math.max(1, Number(timeoutMs) || 15000);
  // 连接预算单独封顶：worker 不在场时快速失败，而不是吃满整个（可能很长的）超时。
  const socket = await connectPipe(pipeName, Math.min(totalMs, 15000));
  try {
    callSequence += 1;
    const id = `data-${process.pid}-${callSequence}-${crypto.randomBytes(4).toString('hex')}`;
    const params = {
      method: String(method).toUpperCase(),
      path: String(path ?? ''),
      ...(query !== undefined ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(typeof token === 'string' && token ? { token } : {}),
      ...(sessionToken !== undefined ? { sessionToken } : {})
    };
    socket.write(encodeFrame({ version: 1, id, method: DATA_IPC_METHOD, params }));
    const result = await readResponse(socket, id, Date.now() + totalMs);
    const status = Number(result?.status) || 0;
    const text = result?.body !== undefined
      ? String(result.body)
      : (result?.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64').toString('utf8') : '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status, ok: status >= 200 && status < 300, headers: result?.headers ?? {}, text, json };
  } finally {
    socket.destroy();
  }
}
