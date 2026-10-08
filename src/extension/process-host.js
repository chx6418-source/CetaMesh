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
import { fileURLToPath } from 'node:url';
import { isPackagedRuntime } from '../app-paths.js';
import { manifestFingerprint } from './manifest.js';
import { createProcessTransport, resolveExtensionWorkerLaunch } from './process-transport.js';

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
  transport: injectedTransport = null,
  packageRoot = null,
  storeRoot = null,
  extensionId = null,
  version = null,
  fingerprint = null,
  storageFile = null,
  packaged = undefined,
  execPath = process.execPath,
  workerEntry = null,
  parentEnv = process.env,
  shutdownGraceMs = 1000,
  storage = null,
  logger = () => {},
  capabilityExecutor = null,
  onCrash = null,
  timeoutMs = EXTENSION_LIMITS.invokeTimeoutMs,
  maxMessageBytes = 2 * 1024 * 1024
} = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('createProcessExtensionHost 需要 manifest');
  let transport = injectedTransport;
  if (!transport) {
    const isPackaged = packaged ?? isPackagedRuntime();
    const resolvedWorkerEntry = isPackaged
      ? undefined
      : workerEntry || fileURLToPath(new URL('./process-worker.js', import.meta.url));
    const launch = resolveExtensionWorkerLaunch({ packaged: isPackaged, execPath, workerEntry: resolvedWorkerEntry });
    const activeId = extensionId || manifest.id;
    const activeVersion = version || manifest.version;
    transport = createProcessTransport({
      packageRoot,
      storeRoot,
      extensionId: activeId,
      version: activeVersion,
      launch,
      parentEnv,
      metadata: { extensionId: activeId, version: activeVersion, fingerprint: fingerprint || manifestFingerprint(manifest), storageFile },
      graceMs: shutdownGraceMs
    });
  }
  if (!transport || typeof transport.send !== 'function' || typeof transport.onMessage !== 'function') {
    throw new Error('createProcessExtensionHost 需要注入 transport（send/onMessage/close）');
  }
  const granted = new Set(manifest.permissions || []);
  const declared = new Map((manifest.capabilities || []).map((entry) => [entry.id, entry]));
  const pending = new Map(); // invokeId -> { capability, resolve, reject, timer, cancelled }
  const pendingPings = new Map();
  const reversePending = new Map();
  const logs = [];
  let closed = false;
  let crashed = false;
  let crashNotified = false;
  let cleanupPromise = Promise.resolve();
  maxMessageBytes = Math.max(1, Math.min(Number(maxMessageBytes) || 2 * 1024 * 1024, 2 * 1024 * 1024));

  const record = (level, message) => {
    logs.push({ at: Date.now(), level, message: String(message).slice(0, 2000) });
    if (logs.length > 200) logs.shift();
    try { logger(logs[logs.length - 1]); } catch { /* 日志失败不影响宿主 */ }
  };

  function fail(code, message) { throw extensionError(code, message); }

  function settlePending(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      if (!entry.settled) { entry.settled = true; entry.reject(error); }
    }
    for (const [id, entry] of pendingPings) {
      clearTimeout(entry.timer);
      pendingPings.delete(id);
      entry.resolve(false);
    }
    reversePending.clear();
  }

  function failHost(code, message) {
    if (closed) return;
    closed = true;
    crashed = true;
    settlePending(extensionError(code, message));
    record('error', message);
    try {
      const cleanup = typeof transport.killTree === 'function' ? transport.killTree() : transport.close?.();
      cleanupPromise = Promise.resolve(cleanup).catch(error => record('error', 'Worker cleanup failed: ' + String(error?.message ?? error)));
    } catch (error) {
      record('error', 'Worker cleanup failed: ' + String(error?.message ?? error));
    }
    if (!crashNotified && typeof onCrash === 'function') {
      crashNotified = true;
      try { onCrash({ code, message }); }
      catch (error) { record('error', 'Worker crash callback failed: ' + String(error?.message ?? error)); }
    }
  }

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
      return failHost('PROTOCOL_VIOLATION', 'Worker emitted an oversized frame');
    }
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return failHost('PROTOCOL_VIOLATION', 'Worker emitted malformed JSON: ' + String(error?.message ?? error));
      }
    }
    const frame = parseFrame(parsed);
    if (!frame) return failHost('PROTOCOL_VIOLATION', 'Worker emitted malformed or unsupported frame');
    if (frame.kind === 'pong') {
      const ping = pendingPings.get(frame.id);
      if (ping) {
        clearTimeout(ping.timer);
        pendingPings.delete(frame.id);
        ping.resolve(true);
      }
      return;
    }
    if (frame.kind === 'ping') {
      try {
        checkedSend({ v: PROTOCOL_VERSION, id: frame.id, kind: 'pong' });
      } catch (error) {
        record('error', 'Unable to answer Worker ping: ' + String(error?.message ?? error));
      }
      return;
    }
    if (frame.kind === 'invoke') {
      if (reversePending.has(frame.id)) return failHost('PROTOCOL_VIOLATION', 'Worker reused an active reverse capability id');
      if (reversePending.size >= MAX_INFLIGHT) {
        try { checkedSend({ v: PROTOCOL_VERSION, id: frame.id, kind: 'error', capability: frame.capability,
          error: { code: 'INVOKE_OVERLOAD', message: 'Too many pending Worker capability requests' } }); }
        catch (error) { record('error', 'Unable to reject overloaded Worker capability request: ' + String(error?.message ?? error)); }
        return;
      }
      if (typeof capabilityExecutor !== 'function') {
        try { checkedSend({ v: PROTOCOL_VERSION, id: frame.id, kind: 'error', capability: frame.capability,
          error: { code: 'CAPABILITY_BROKER_REQUIRED', message: 'Host capability broker is not configured' } }); }
        catch (error) { record('error', 'Unable to reject Worker capability request: ' + String(error?.message ?? error)); }
        return;
      }
      const active = { capability: frame.capability };
      reversePending.set(frame.id, active);
      Promise.resolve().then(() => capabilityExecutor(frame.capability, frame.input ?? {})).then((result) => {
        if (reversePending.get(frame.id) !== active) return;
        reversePending.delete(frame.id);
        checkedSend({ v: PROTOCOL_VERSION, id: frame.id, kind: 'result', capability: frame.capability, result: result ?? null });
      }).catch((error) => {
        if (reversePending.get(frame.id) !== active) return;
        reversePending.delete(frame.id);
        try { checkedSend({ v: PROTOCOL_VERSION, id: frame.id, kind: 'error', capability: frame.capability,
          error: { code: String(error?.code || 'CAPABILITY_ERROR').slice(0, 80), message: String(error?.message || error).slice(0, 2000) } }); }
        catch (sendError) { record('error', 'Unable to send Worker capability error: ' + String(sendError?.message ?? sendError)); }
      });
      return;
    }
    if (frame.kind === 'cancel') {
      if (reversePending.has(frame.id)) {
        reversePending.delete(frame.id);
        return;
      }
    }
    const entry = pending.get(frame.id);
    if (!entry) {
      record('warn', 'Ignoring late or unknown Worker response: ' + frame.kind + ':' + frame.id);
      return;
    }
    if (frame.capability !== entry.capability) {
      return failHost('PROTOCOL_VIOLATION', 'Worker response capability does not match the request');
    }
    if (frame.kind === 'cancel') {
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      if (!entry.settled) { entry.settled = true; entry.reject(extensionError('INVOKE_CANCELLED', 'Invocation cancelled by Worker')); }
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(frame.id);
    if (entry.settled) return;
    entry.settled = true;
    if (frame.kind === 'error') {
      entry.reject(extensionError(frame.error.code || 'EXTENSION_ERROR', String(frame.error.message ?? 'Extension error')));
    } else {
      entry.resolve({ capability: frame.capability, result: frame.result ?? null });
    }
  });
  transport.onExit?.(({ code, signal } = {}) => {
    if (!closed) failHost('PROVIDER_UNAVAILABLE', 'Extension Worker exited (' + String(code) + ', ' + String(signal) + ')');
  });
  transport.onError?.((error) => failHost(error?.code || 'PROTOCOL_VIOLATION', String(error?.message ?? error)));
  transport.onDiagnostic?.((message) => record('info', message));
  return {
    manifest,
    logs,
    get pid() { return transport.pid ?? null; },
    get cwd() { return transport.cwd ?? null; },
    capabilities: () => [...declared.keys()],
    loadError: () => null,
    available() { return !closed && (typeof transport.alive !== 'function' || transport.alive()); },
    health() {
      const available = this.available();
      const state = closed ? (crashed ? 'crashed' : 'stopped') : available ? (transport.pid ? 'running' : 'starting') : 'crashed';
      return { available, closed, crashed, state, inflight: pending.size,
        provider: transport.pid || typeof transport.killTree === 'function' ? 'process-child' : 'process-transport' };
    },
    ping({ timeoutMs: pingTimeoutMs = 2000 } = {}) {
      if (closed || !this.available()) return Promise.resolve(false);
      const id = 'ping_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pendingPings.delete(id); resolve(false); }, Math.max(1, Number(pingTimeoutMs) || 2000));
        timer.unref?.();
        pendingPings.set(id, { resolve, timer });
        try { checkedSend({ v: PROTOCOL_VERSION, id, kind: 'ping' }); }
        catch { clearTimeout(timer); pendingPings.delete(id); resolve(false); }
      });
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
          try { checkedSend({ v: PROTOCOL_VERSION, id, kind: 'cancel', capability: capabilityId }); }
          catch (error) { record('warn', 'Unable to send cancellation frame: ' + String(error?.message ?? error)); }
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
      if (closed) return cleanupPromise;
      closed = true;
      settlePending(extensionError('PROVIDER_UNAVAILABLE', 'Process Extension Host is shut down'));
      record('info', 'Process Extension Host shut down');
      try {
        cleanupPromise = Promise.resolve(transport.close?.()).catch((error) => {
          record('error', 'Worker shutdown failed: ' + String(error?.message ?? error));
        });
        return cleanupPromise;
      } catch (error) {
        record('error', 'Worker shutdown failed: ' + String(error?.message ?? error));
        return Promise.resolve();
      }
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
