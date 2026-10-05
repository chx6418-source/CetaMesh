// CetaMesh Extension —— ProcessExtensionHost 契约（v2 hardening / Phase F）。
//
// 立场（如实）：node:vm 是遏制不是隔离。真正想给"不受信任代码"的隔离是独立进程
// + OS 限制。本轮**只交付契约与协议**，不交付真实进程沙箱：
//   - `createExtensionHost`（当前 = VmExtensionHost）保持不变，仍是 Alpha/受信扩展
//     的活动宿主；
//   - 本模块定义 ProcessExtensionHost 的**接口与消息协议**，transport 是注入的
//     （fixture 可全测）；真实进程 transport 有意不在本轮实现（半吊子进程沙箱
//     比没有更危险），待用户批准后按同一契约接入。
//
// 协议（帧 = 一个 JSON 对象，经 transport 单向发送）：
//   { v:1, id, kind:'invoke',  capability, input }
//   { v:1, id, kind:'result',  capability, result }
//   { v:1, id, kind:'error',   capability, error:{ code, message } }
//   { v:1, id, kind:'cancel',  capability }
//   { v:1, id, kind:'ping' } / { v:1, id, kind:'pong' }
//
// 强制安全契约（host 侧执行，缺一拒绝）：
//   - 能力白名单：invoke 只允许 manifest.capabilities 声明过且权限已授予的能力
//     （与 VmExtensionHost 的 capabilityOrThrow 同语义），未知能力**不出帧**；
//   - 帧大小上限：超过 maxMessageBytes 的帧拒绝发送/接收（防 IPC 载荷攻击）；
//   - 帧模式校验：不符合协议形状的帧一律丢弃并计入错误，不进入调用方；
//   - 每次 invoke 有墙钟超时；cancel 后迟到的 result 一律丢弃（防重放/串话）；
//   - shutdown 后不可再用；health 反映 transport 存活。

import { EXTENSION_LIMITS, extensionError } from './types.js';

const PROTOCOL_VERSION = 1;
const MAX_INFLIGHT = 16;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 帧模式校验：协议形状不对的帧一律拒绝（返回 null）。 */
function parseFrame(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.v !== PROTOCOL_VERSION) return null;
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) return null;
  if (typeof raw.kind !== 'string') return null;
  if (raw.capability !== undefined && (typeof raw.capability !== 'string' || raw.capability.length > 200)) return null;
  switch (raw.kind) {
    case 'invoke':
      if (typeof raw.capability !== 'string' || !isPlainObject(raw.input)) return null;
      break;
    case 'result':
      if (typeof raw.capability !== 'string') return null;
      break;
    case 'error':
      if (typeof raw.capability !== 'string' || !isPlainObject(raw.error)
        || typeof raw.error.code !== 'string') return null;
      break;
    case 'cancel':
      if (typeof raw.capability !== 'string') return null;
      break;
    case 'ping':
    case 'pong':
      break;
    default:
      return null;
  }
  return raw;
}

export function createProcessExtensionHost({
  manifest,
  transport,               // 注入：{ send(frame), onMessage(handler), close(), alive() }
  storage = null,
  logger = () => {},
  capabilityExecutor = null,
  timeoutMs = EXTENSION_LIMITS.invokeTimeoutMs,
  maxMessageBytes = 2 * 1024 * 1024
} = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('createProcessExtensionHost 需要 manifest');
  if (!transport || typeof transport.send !== 'function' || typeof transport.onMessage !== 'function') {
    throw new Error('createProcessExtensionHost 需要注入 transport（send/onMessage/close）');
  }
  const granted = new Set(manifest.permissions || []);
  const declared = new Map((manifest.capabilities || []).map((entry) => [entry.id, entry]));
  const pending = new Map(); // invokeId -> { capability, resolve, reject, timer, cancelled }
  const logs = [];
  let closed = false;

  const record = (level, message) => {
    logs.push({ at: Date.now(), level, message: String(message).slice(0, 2000) });
    if (logs.length > 200) logs.shift();
    try { logger(logs[logs.length - 1]); } catch { /* 日志失败不影响宿主 */ }
  };

  function fail(code, message) { throw extensionError(code, message); }

  function capabilityOrThrow(capabilityId) {
    const entry = declared.get(capabilityId);
    if (!entry) fail('CAPABILITY_NOT_DECLARED', '扩展未声明该能力：' + capabilityId);
    for (const required of entry.requires || []) {
      if (!granted.has(required)) {
        fail('PERMISSION_DENIED', `调用 ${capabilityId} 需要权限 ${required}，但未授予`);
      }
    }
    return entry;
  }

  function checkedSend(frame) {
    if (closed) fail('PROVIDER_UNAVAILABLE', 'Process extension host 已关闭');
    const payload = JSON.stringify(frame);
    // UTF-16 长度是上界近似；对 JSON 载荷足够作为发送前上限检查。
    if (Buffer.byteLength(payload, 'utf8') > maxMessageBytes) {
      fail('MESSAGE_TOO_LARGE', `帧超过大小上限（${maxMessageBytes} 字节）`);
    }
    try {
      transport.send(payload);
    } catch (error) {
      fail('PROVIDER_ERROR', 'transport 发送失败：' + String(error?.message ?? error));
    }
  }

  transport.onMessage((raw) => {
    if (closed) return;
    if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > maxMessageBytes) {
      record('error', '收到超限帧，已丢弃');
      return;
    }
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { record('error', '收到非 JSON 帧，已丢弃'); return; }
    }
    const frame = parseFrame(parsed);
    if (!frame) { record('error', '收到不合协议的帧，已丢弃'); return; }
    if (frame.kind === 'pong') return;
    if (frame.kind === 'ping') {
      checkedSend({ v: PROTOCOL_VERSION, id: frame.id, kind: 'pong' });
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) {
      // 未知的 id：串话/重放/迟到的结果——一律丢弃并记录，不进入任何调用方。
      record('warn', `丢弃未知 id 的帧：${frame.kind}:${frame.id}`);
      return;
    }
    if (frame.kind === 'cancel') {
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      if (!entry.settled) { entry.settled = true; entry.reject(extensionError('INVOKE_CANCELLED', '调用已被取消')); }
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(frame.id);
    if (entry.settled) return;
    entry.settled = true;
    if (frame.kind === 'error') {
      entry.reject(extensionError(frame.error.code || 'EXTENSION_ERROR', String(frame.error.message ?? '扩展返回错误')));
    } else {
      entry.resolve({ capability: frame.capability, result: frame.result ?? null });
    }
  });

  return {
    manifest,
    logs,
    capabilities: () => [...declared.keys()],
    loadError: () => null,
    available() { return !closed && (typeof transport.alive !== 'function' || transport.alive()); },
    health() {
      return { available: this.available(), closed, inflight: pending.size, provider: 'process-contract' };
    },
    /** 发起一次受控调用：能力白名单 → 帧发送 → 超时/取消/结果裁决（async：同步拒绝即 rejection）。 */
    async invoke(capabilityId, input) {
      const entry = capabilityOrThrow(capabilityId); // 未声明/未授权的能力：不出帧，直接拒绝
      void entry;
      if (closed) fail('PROVIDER_UNAVAILABLE', 'Process extension host 已关闭');
      if (pending.size >= MAX_INFLIGHT) fail('INVOKE_OVERLOAD', '在途调用过多（>16），稍后再试');
      const id = 'inv_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(extensionError('INVOKE_TIMEOUT', `进程扩展调用超时（${timeoutMs}ms）`));
        }, timeoutMs);
        // 不 unref：等待子进程应答期间超时必须能够触发（否则挂死调用方）。
        pending.set(id, { capability: capabilityId, resolve, reject, timer, settled: false });
        let frame;
        try {
          frame = JSON.stringify({ v: PROTOCOL_VERSION, id, kind: 'invoke', capability: capabilityId, input: input ?? {} });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(extensionError('INVALID_PARAMS', 'invoke 输入不可序列化'));
          return;
        }
        if (Buffer.byteLength(frame, 'utf8') > maxMessageBytes) {
          clearTimeout(timer);
          pending.delete(id);
          reject(extensionError('MESSAGE_TOO_LARGE', `帧超过大小上限（${maxMessageBytes} 字节）`));
          return;
        }
        try {
          transport.send(frame);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(extensionError('PROVIDER_ERROR', 'transport 发送失败：' + String(error?.message ?? error)));
        }
      });
    },
    /** 取消在途调用（尽力而为：发 cancel 帧 + 本地立即裁决）。 */
    cancel(invokeId) {
      const entry = pending.get(String(invokeId));
      if (!entry) return { cancelled: false };
      pending.delete(String(invokeId));
      clearTimeout(entry.timer);
      if (!entry.settled) { entry.settled = true; entry.reject(extensionError('INVOKE_CANCELLED', '调用已被取消')); }
      try { checkedSend({ v: PROTOCOL_VERSION, id: String(invokeId), kind: 'cancel', capability: entry.capability }); } catch { /* 已关闭 */ }
      return { cancelled: true };
    },
    shutdown() {
      if (closed) return;
      closed = true;
      for (const [id, entry] of [...pending]) {
        clearTimeout(entry.timer);
        if (!entry.settled) { entry.settled = true; entry.reject(extensionError('PROVIDER_UNAVAILABLE', '宿主已关闭')); }
        pending.delete(id);
      }
      try { transport.close?.(); } catch { /* transport 自行处理 */ }
      record('info', 'Process extension host 已关闭');
    },
    /** 测试/诊断：直接查看在途集合。 */
    _inflight: () => [...pending.keys()]
  };
}

/**
 * 进程内双工 transport fixture（仅测试用）：host 端与"进程端"各持一半，
 * 通过队列互投。真实进程 transport（子进程 + 同一帧协议）是后续工作。
 */
export function createInProcessTransportPair({ onHostFrame = null, latencyMs = 0 } = {}) {
  const deliver = (queue, frame) => {
    if (latencyMs > 0) setTimeout(() => queue.handler?.(frame), latencyMs);
    else queue.handler?.(frame);
  };
  const hostSide = { handler: null, queue: [] };
  const childSide = { handler: null, queue: [] };
  return {
    host: {
      send: (frame) => { hostSide.queue.push(frame); deliver(childSide, frame); },
      onMessage: (handler) => { hostSide.handler = handler; for (const frame of hostSide.queue.splice(0)) handler(frame); },
      close: () => { hostSide.closed = true; },
      alive: () => !hostSide.closed
    },
    child: {
      send: (frame) => { childSide.queue.push(frame); deliver(hostSide, frame); },
      onMessage: (handler) => { childSide.handler = handler; for (const frame of childSide.queue.splice(0)) handler(frame); },
      closed: false
    }
  };
}
