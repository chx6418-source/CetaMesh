// CetaMesh Desktop Extension v1 —— 受限执行宿主（阶段 10）。
//
// 设计立场（务必如实理解）：
// - 这里用 node:vm 提供**遏制**（containment），不是安全沙箱（sandbox）。
//   真正的隔离边界应当是"独立进程 + OS 级限制"，那是后续阶段的工作。
// - 因此在 vm 之上叠加了多重限制：
//     1) 上下文中不存在 require / module 加载器 / process / Buffer / fs / net / child_process；
//     2) createContext({ codeGeneration: { strings: false, wasm: false } })
//        直接关掉该上下文里的 eval 与 new Function，阻断"字符串变代码"的逃逸路径；
//     3) 只有被授予的权限才会注入对应能力（network 未授予时连 fetch 都不存在）；
//     4) network fetch 必须命中 manifest 声明的 hosts 白名单，并复用 safe-fetch 的 SSRF 防护；
//     5) 每次调用有墙钟超时（超时只保证不吊死调用方，不保证终止内部计算）。
// - 安装期还有 scan.js 的静态预检做纵深防御。

import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EXTENSION_LIMITS, extensionError, hostAllowed } from './types.js';

const MAX_LOG_ENTRIES = 200;

export function createVmExtensionHost({
  manifest,
  source,
  storage,
  logger = () => {},
  fetchImpl = null,
  capabilityExecutor = null,
  timeoutMs = EXTENSION_LIMITS.invokeTimeoutMs
} = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('createExtensionHost 需要 manifest');
  const granted = new Set(manifest.permissions || []);
  const logs = [];
  const invocationContext = new AsyncLocalStorage();

  const record = (level, args) => {
    const line = { at: Date.now(), level, message: args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ') };
    logs.push(line);
    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
    try { logger(line); } catch { /* 日志失败不能影响扩展调用 */ }
  };

  function safeStringify(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  async function guardedFetch(url, init) {
    if (!granted.has('network')) {
      throw extensionError('PERMISSION_DENIED', '扩展未获得 network 权限');
    }
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw extensionError('INVALID_URL', '非法 URL：' + String(url).slice(0, 120));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw extensionError('INVALID_URL', '只允许 http/https');
    }
    if (!hostAllowed(parsed.hostname, manifest.network?.hosts || [])) {
      throw extensionError('HOST_NOT_ALLOWED', '主机不在声明白名单内：' + parsed.hostname);
    }
    if (typeof capabilityExecutor !== 'function') {
      throw extensionError('CAPABILITY_BROKER_REQUIRED', 'Extension network requires Capability Broker');
    }
    const response = await capabilityExecutor('network', { url: parsed.toString(), init },
      { signal: invocationContext.getStore() });
    if (response && typeof response.body === 'string' && Number.isInteger(response.statusCode)) {
      return new Response(response.body, { status: response.statusCode });
    }
    return response;
  }

  const sandbox = Object.create(null);
  sandbox.log = (...args) => record('info', args);
  sandbox.warn = (...args) => record('warn', args);
  sandbox.error = (...args) => record('error', args);
  sandbox.console = { log: sandbox.log, warn: sandbox.warn, error: sandbox.error };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  if (granted.has('storage') && storage) {
    sandbox.storage = {
      get: (key) => storage.get(key),
      set: (key, value) => storage.set(key, value),
      delete: (key) => storage.delete(key),
      keys: () => storage.keys()
    };
  }
  if (granted.has('network')) {
    sandbox.fetch = (url, init) => guardedFetch(url, init);
  }
  const invokeCapability = async (capability, input) => {
    if (!granted.has(capability)) throw extensionError('PERMISSION_DENIED', capability + ' not declared');
    if (typeof capabilityExecutor !== 'function') throw extensionError('CAPABILITY_BROKER_REQUIRED', 'Capability Broker unavailable');
    return capabilityExecutor(capability, input, { signal: invocationContext.getStore() });
  };
  if (granted.has('memory.read') || granted.has('memory.write')) {
    sandbox.memory = {};
    if (granted.has('memory.read')) sandbox.memory.read = input => invokeCapability('memory.read', input);
    if (granted.has('memory.write')) sandbox.memory.write = input => invokeCapability('memory.write', input);
  }
  if (granted.has('filesystem.read') || granted.has('filesystem.write')) {
    sandbox.workspace = {};
    if (granted.has('filesystem.read')) sandbox.workspace.read = input => invokeCapability('filesystem.read', input);
    if (granted.has('filesystem.write')) sandbox.workspace.write = input => invokeCapability('filesystem.write', input);
  }
  // 明确把宿主对象置为 undefined，避免扩展依赖"碰巧存在"的东西。
  sandbox.require = undefined;
  sandbox.process = undefined;
  sandbox.globalThis = undefined;
  sandbox.Buffer = undefined;

  const context = vm.createContext(sandbox, {
    name: 'cetamesh-extension:' + manifest.id,
    codeGeneration: { strings: false, wasm: false }
  });

  const loadError = { code: null, message: null };
  try {
    const script = new vm.Script(String(source ?? ''), { filename: manifest.id + '/' + manifest.entry });
    script.runInContext(context, { timeout: Math.max(200, Math.min(timeoutMs, 2000)), displayErrors: true });
  } catch (error) {
    loadError.code = 'EXTENSION_LOAD_FAILED';
    loadError.message = String(error && error.message);
  }

  const handlerTable = loadError.code ? {} : (sandbox.module.exports && sandbox.module.exports.handlers) || {};

  function capabilityOrThrow(capabilityId) {
    const declared = (manifest.capabilities || []).find((c) => c.id === capabilityId);
    if (!declared) {
      throw extensionError('CAPABILITY_NOT_DECLARED', '扩展未声明该能力：' + String(capabilityId));
    }
    for (const required of declared.requires || []) {
      if (!granted.has(required)) {
        throw extensionError('PERMISSION_DENIED', '调用 ' + capabilityId + ' 需要权限 ' + required + '，但未授予');
      }
    }
    return declared;
  }

  return {
    manifest,
    logs,
    /** 扩展声明的能力清单（用于 UI 与调用前校验）。 */
    capabilities: () => (manifest.capabilities || []).map((c) => c.id),
    loadError: () => (loadError.code ? { ...loadError } : null),
    available() {
      return !loadError.code;
    },
    async invoke(capabilityId, input, { signal: outerSignal } = {}) {
      capabilityOrThrow(capabilityId);
      if (loadError.code) {
        throw extensionError(loadError.code, '扩展加载失败：' + loadError.message);
      }
      if (outerSignal?.aborted) {
        throw outerSignal.reason?.code ? outerSignal.reason
          : extensionError('INVOKE_CANCELLED', 'Extension invocation cancelled');
      }
      const handler = handlerTable[capabilityId];
      if (typeof handler !== 'function') {
        throw extensionError('CAPABILITY_NOT_IMPLEMENTED', '扩展没有实现能力：' + capabilityId);
      }
      const context = {
        extensionId: manifest.id,
        capability: capabilityId,
        log: (...args) => record('info', args),
        storage: sandbox.storage,
        fetch: sandbox.fetch
        ,memory: sandbox.memory, workspace: sandbox.workspace
      };
      const controller = new AbortController();
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      const rejectForAbort = () => {
        const reason = controller.signal.reason;
        rejectAbort(reason?.code ? reason : extensionError('INVOKE_CANCELLED', 'Extension invocation cancelled'));
      };
      controller.signal.addEventListener('abort', rejectForAbort, { once: true });
      const abortFromOuter = () => controller.abort(outerSignal.reason
        || extensionError('INVOKE_CANCELLED', 'Extension invocation cancelled'));
      outerSignal?.addEventListener('abort', abortFromOuter, { once: true });
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = extensionError('INVOKE_TIMEOUT', '扩展调用超时（' + timeoutMs + 'ms）');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        if (timer.unref) timer.unref();
      });
      if (outerSignal?.aborted) abortFromOuter();
      try {
        const started = Date.now();
        const execution = invocationContext.run(controller.signal,
          () => Promise.resolve().then(() => handler(input, context)));
        const result = await Promise.race([
          execution, timeout, aborted
        ]);
        return { capability: capabilityId, result: result === undefined ? null : result, elapsedMs: Date.now() - started };
      } finally {
        if (timer) clearTimeout(timer);
        outerSignal?.removeEventListener('abort', abortFromOuter);
        controller.signal.removeEventListener('abort', rejectForAbort);
      }
    }
  };
}

// Trusted builtin/dev Extensions may use the VM host; production third-party Extensions use ProcessExtensionHost.
export const createExtensionHost = createVmExtensionHost;
