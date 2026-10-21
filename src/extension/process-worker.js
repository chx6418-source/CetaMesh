import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, reportEntrypointError } from '../entrypoint.js';
import { createVmExtensionHost } from './host.js';
import { assertManifest, MANIFEST_FILENAMES, manifestFingerprint } from './manifest.js';
import { scanEntrySource } from './scan.js';
import { sanitizeExtensionWorkerEnv } from './worker-env.js';
import { createExtensionPrivateStorage } from './private-storage.js';
import { fingerprintExtensionPackage } from './package-fingerprint.js';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_CAPABILITY_CALLS = 16;
const CAPABILITY_TIMEOUT_MS = 30_000;
const FORBIDDEN_PERMISSIONS = new Set(['shell', 'native', 'process', 'download']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateFrame(frame) {
  if (!isPlainObject(frame) || frame.v !== PROTOCOL_VERSION
    || typeof frame.id !== 'string' || !frame.id || frame.id.length > 128
    || typeof frame.kind !== 'string') return false;
  if (frame.capability !== undefined
    && (typeof frame.capability !== 'string' || frame.capability.length > 200)) return false;
  switch (frame.kind) {
    case 'invoke': return typeof frame.capability === 'string' && isPlainObject(frame.input);
    case 'result': return typeof frame.capability === 'string';
    case 'error': return typeof frame.capability === 'string' && isPlainObject(frame.error)
      && typeof frame.error.code === 'string';
    case 'cancel': return typeof frame.capability === 'string';
    case 'ping':
    case 'pong':
    case 'shutdown': return true;
    default: return false;
  }
}

function errorFrame(id, capability, error) {
  return {
    v: PROTOCOL_VERSION,
    id,
    kind: 'error',
    capability,
    error: {
      code: String(error?.code || 'EXTENSION_ERROR').slice(0, 80),
      message: String(error?.message || error || 'Extension worker error').slice(0, 2000)
    }
  };
}

function readPackage() {
  const packageRoot = fs.realpathSync(process.cwd());
  let rawManifest = null;
  for (const name of MANIFEST_FILENAMES) {
    const candidate = path.join(packageRoot, name);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Extension manifest must be a regular package file');
    rawManifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    break;
  }
  if (!rawManifest) throw new Error('Extension package manifest is missing');
  const manifest = assertManifest(rawManifest);
  if (manifest.type === 'memory-pack') throw Object.assign(new Error('Memory Packs are data-only'), { code: 'MEMORY_PACK_INVALID' });
  if (manifest.permissions.some((permission) => FORBIDDEN_PERMISSIONS.has(permission))) {
    throw Object.assign(new Error('Extension requests a forbidden executable permission'), { code: 'FORBIDDEN_PERMISSION' });
  }
  const expectedId = process.env.CETAMESH_EXTENSION_ID;
  const expectedVersion = process.env.CETAMESH_EXTENSION_VERSION;
  const expectedFingerprint = process.env.CETAMESH_EXTENSION_FINGERPRINT;
  const expectedPackageFingerprint = process.env.CETAMESH_EXTENSION_PACKAGE_FINGERPRINT;
  if (expectedId && expectedId !== manifest.id) throw new Error('Extension package id does not match host metadata');
  if (expectedVersion && expectedVersion !== manifest.version) throw new Error('Extension package version does not match host metadata');
  if (expectedFingerprint && expectedFingerprint !== manifestFingerprint(manifest)) {
    throw new Error('Extension manifest fingerprint does not match host metadata');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(expectedPackageFingerprint || ''))
    || fingerprintExtensionPackage(packageRoot) !== expectedPackageFingerprint.toLowerCase()) {
    throw Object.assign(new Error('Extension package fingerprint does not match host metadata'), { code: 'PACKAGE_FINGERPRINT_MISMATCH' });
  }

  const entryPath = path.resolve(packageRoot, manifest.entry);
  if (!entryPath.startsWith(packageRoot + path.sep)) throw new Error('Extension entry escapes its package root');
  const entryStat = fs.lstatSync(entryPath);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error('Extension entry must be a regular package file');
  const realEntry = fs.realpathSync(entryPath);
  if (!realEntry.startsWith(packageRoot + path.sep)) throw new Error('Extension entry resolves outside its package root');
  const source = fs.readFileSync(realEntry, 'utf8');
  const scan = scanEntrySource(source);
  if (!scan.ok) throw Object.assign(new Error('Extension source failed runtime safety scan'), { code: 'SOURCE_SCAN_FAILED' });
  return { manifest, source };
}

/** Run the Extension worker on the existing newline-delimited version-1 frame protocol. */
export async function runExtensionWorker({ input = process.stdin, output = process.stdout, diagnostic = process.stderr } = {}) {
  sanitizeExtensionWorkerEnv();
  const { manifest, source } = readPackage();
  const pendingCapabilities = new Map();
  const activeInvokes = new Map();
  let nextRequest = 0;
  let stopped = false;
  let buffer = Buffer.alloc(0);
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });

  const log = (message) => {
    try {
      diagnostic.write(`extension-worker: ${String(message).slice(0, 2000)}\n`);
    } catch (error) {
      if (error?.code !== 'EPIPE') throw error;
    }
  };

  const send = (frame) => {
    const raw = JSON.stringify(frame);
    if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) throw new Error('Worker frame exceeds 2 MiB');
    output.write(raw + '\n');
  };

  const rejectPending = (error) => {
    for (const entry of pendingCapabilities.values()) {
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(error);
    }
    pendingCapabilities.clear();
  };

  const stop = (code = 0, reason = '') => {
    if (stopped) return;
    stopped = true;
    if (reason) log(reason);
    rejectPending(Object.assign(new Error('Extension worker stopped'), { code: 'PROVIDER_UNAVAILABLE' }));
    input.pause?.();
    input.removeListener?.('data', onData);
    finish(code);
  };

  const failProtocol = (message) => {
    log(`protocol violation: ${message}`);
    stop(2);
    input.destroy?.();
  };

  const requestCapability = (capability, requestInput, { signal } = {}) => {
    if (stopped) return Promise.reject(Object.assign(new Error('Extension worker stopped'), { code: 'PROVIDER_UNAVAILABLE' }));
    if (pendingCapabilities.size >= MAX_PENDING_CAPABILITY_CALLS) {
      return Promise.reject(Object.assign(new Error('Too many pending capability requests'), { code: 'INVOKE_OVERLOAD' }));
    }
    const id = `worker-cap-${++nextRequest}`;
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        const request = pendingCapabilities.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        signal?.removeEventListener('abort', request.onAbort);
        pendingCapabilities.delete(id);
        try { send({ v: PROTOCOL_VERSION, id, kind: 'cancel', capability }); }
        catch (sendError) { log(`unable to cancel Broker request: ${String(sendError?.message ?? sendError)}`); }
        reject(error);
      };
      const onAbort = () => {
        const reason = signal?.reason;
        cancel(reason?.code ? reason : Object.assign(new Error('Capability request cancelled'), { code: 'INVOKE_CANCELLED' }));
      };
      const timer = setTimeout(() => cancel(Object.assign(new Error('Capability request timed out'), { code: 'INVOKE_TIMEOUT' })), CAPABILITY_TIMEOUT_MS);
      pendingCapabilities.set(id, { capability, resolve, reject, timer, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        send({ v: PROTOCOL_VERSION, id, kind: 'invoke', capability, input: requestInput ?? {} });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pendingCapabilities.delete(id);
        reject(error);
      }
    });
  };

  const storageFile = process.env.CETAMESH_EXTENSION_STORAGE_FILE;
  const storage = manifest.permissions.includes('storage') && storageFile
    ? createExtensionPrivateStorage({ file: storageFile }) : null;
  const host = createVmExtensionHost({
    manifest, source, storage, capabilityExecutor: requestCapability,
    logger: (line) => log(`${line.level}: ${line.message}`)
  });
  if (!host.available()) throw Object.assign(new Error(host.loadError()?.message || 'Extension failed to load'), { code: 'EXTENSION_LOAD_FAILED' });

  const handleFrame = (frame) => {
    if (!validateFrame(frame)) return failProtocol('malformed or unsupported frame');
    if (frame.kind === 'ping') {
      send({ v: PROTOCOL_VERSION, id: frame.id, kind: 'pong' });
      return;
    }
    if (frame.kind === 'pong') return;
    if (frame.kind === 'shutdown') {
      stop(0);
      input.destroy?.();
      return;
    }
    if (frame.kind === 'cancel') {
      const capabilityCall = pendingCapabilities.get(frame.id);
      if (capabilityCall) {
        clearTimeout(capabilityCall.timer);
        capabilityCall.signal?.removeEventListener('abort', capabilityCall.onAbort);
        pendingCapabilities.delete(frame.id);
        capabilityCall.reject(Object.assign(new Error('Capability request cancelled'), { code: 'INVOKE_CANCELLED' }));
      } else {
        const active = activeInvokes.get(frame.id);
        if (active) {
          active.cancelled = true;
          active.controller.abort(Object.assign(new Error('Extension invocation cancelled'), { code: 'INVOKE_CANCELLED' }));
        }
      }
      return;
    }
    if (frame.kind === 'result' || frame.kind === 'error') {
      const request = pendingCapabilities.get(frame.id);
      if (!request || request.capability !== frame.capability) return failProtocol('response did not match an active Worker capability request');
      clearTimeout(request.timer);
      request.signal?.removeEventListener('abort', request.onAbort);
      pendingCapabilities.delete(frame.id);
      if (frame.kind === 'error') {
        request.reject(Object.assign(new Error(String(frame.error.message || 'Host capability failed')), { code: frame.error.code }));
      } else {
        request.resolve(frame.result ?? null);
      }
      return;
    }
    if (frame.kind === 'invoke') {
      if (activeInvokes.has(frame.id)) return failProtocol('duplicate invoke id');
      const active = { cancelled: false, controller: new AbortController() };
      activeInvokes.set(frame.id, active);
      Promise.resolve().then(() => host.invoke(frame.capability, frame.input, { signal: active.controller.signal })).then((result) => {
        if (!stopped && !active.cancelled) {
          send({ v: PROTOCOL_VERSION, id: frame.id, kind: 'result', capability: frame.capability, result: result.result ?? null });
        }
      }).catch((error) => {
        if (!stopped && !active.cancelled) send(errorFrame(frame.id, frame.capability, error));
      }).finally(() => activeInvokes.delete(frame.id));
      return;
    }
    failProtocol(`invalid direction for ${frame.kind}`);
  };

  function onData(chunk) {
    if (stopped) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > MAX_FRAME_BYTES && buffer.indexOf(0x0a) < 0) return failProtocol('unterminated frame exceeds 2 MiB');
    let newline;
    while (!stopped && (newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_FRAME_BYTES) return failProtocol('frame exceeds 2 MiB');
      if (!line.length) return failProtocol('empty frame');
      let frame;
      try { frame = JSON.parse(line.toString('utf8')); } catch { return failProtocol('malformed JSON'); }
      handleFrame(frame);
    }
    if (buffer.length > MAX_FRAME_BYTES) failProtocol('unterminated frame exceeds 2 MiB');
  }

  input.on('data', onData);
  input.on('end', () => {
    if (buffer.length > 0) failProtocol('truncated frame at end of input');
    else stop(0);
  });
  input.on('error', (error) => stop(1, error?.message || 'input stream failed'));
  return completion;
}

if (isMainModule(import.meta.url)) {
  runExtensionWorker().catch((error) => reportEntrypointError('extension-worker', error));
}
