import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extensionError } from './types.js';
import { terminateProcessTree, waitForChildExit } from './process-tree.js';
import { buildExtensionWorkerEnv } from './worker-env.js';
import { fingerprintExtensionPackage } from './package-fingerprint.js';
export { buildExtensionWorkerEnv } from './worker-env.js';

const PROTOCOL_VERSION = 1;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_QUEUED_MESSAGES = 32;
const MAX_QUEUED_STDIN_BYTES = 4 * 1024 * 1024;

/** Resolve the source Node entry or the Release Core SEA mode without guessing executable type. */
export function resolveExtensionWorkerLaunch({ packaged = false, execPath = process.execPath, workerEntry } = {}) {
  if (typeof execPath !== 'string' || !execPath) throw extensionError('INVALID_PARAMS', 'Worker executable is required');
  if (packaged) return { executable: execPath, args: ['--extension-worker'] };
  if (typeof workerEntry !== 'string' || !workerEntry) throw extensionError('INVALID_PARAMS', 'Source Worker entry is required');
  return { executable: execPath, args: [workerEntry] };
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolvePackageRoot({ packageRoot, storeRoot, extensionId, version }) {
  if (!packageRoot || !storeRoot || !extensionId || !version) {
    throw extensionError('INVALID_PARAMS', 'Process Worker requires a versioned package root owned by the Extension store');
  }
  if (['.', '..'].includes(String(extensionId)) || ['.', '..'].includes(String(version))
    || path.basename(String(extensionId)) !== String(extensionId) || path.basename(String(version)) !== String(version)) {
    throw extensionError('INVALID_PACKAGE_ROOT', 'Extension id or version is not a safe path component');
  }
  const lexicalStore = path.resolve(storeRoot);
  const expected = path.resolve(lexicalStore, String(extensionId), String(version));
  if (!samePath(packageRoot, expected)) {
    throw extensionError('INVALID_PACKAGE_ROOT', 'Worker cwd must be the active Extension id/version package root');
  }
  let canonicalStore;
  let canonicalPackage;
  try {
    canonicalStore = fs.realpathSync(lexicalStore);
    canonicalPackage = fs.realpathSync(expected);
  } catch (error) {
    throw extensionError('INVALID_PACKAGE_ROOT', 'Worker package root is missing or unreadable: ' + String(error?.message ?? error));
  }
  const idPath = path.join(canonicalStore, String(extensionId));
  const versionPath = path.join(idPath, String(version));
  for (const component of [idPath, versionPath]) {
    const stat = fs.lstatSync(component);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw extensionError('INVALID_PACKAGE_ROOT', 'Worker package path cannot contain a symlink');
    }
  }
  if (!samePath(canonicalPackage, versionPath)) {
    throw extensionError('INVALID_PACKAGE_ROOT', 'Worker package root resolves outside the Extension store');
  }
  return canonicalPackage;
}

function asError(value, code = 'PROTOCOL_VIOLATION') {
  return value instanceof Error ? value : extensionError(code, String(value));
}

export function createProcessTransport({
  packageRoot,
  storeRoot,
  extensionId,
  version,
  launch,
  parentEnv = process.env,
  metadata = {},
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  graceMs = 1000
} = {}) {
  const cwd = resolvePackageRoot({ packageRoot, storeRoot, extensionId, version });
  if (!launch || typeof launch.executable !== 'string' || !launch.executable
    || !Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== 'string')) {
    throw extensionError('INVALID_PARAMS', 'Process Worker launch configuration is invalid');
  }
  const frameLimit = Math.max(1, Math.min(Number(maxFrameBytes) || DEFAULT_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES));
  const env = buildExtensionWorkerEnv({
    parentEnv,
    metadata: {
      extensionId, version, fingerprint: metadata.fingerprint,
      packageFingerprint: metadata.packageFingerprint || fingerprintExtensionPackage(cwd),
      storageFile: metadata.storageFile
    }
  });
  const child = spawn(launch.executable, launch.args, {
    shell: false,
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  let messageHandler = null;
  let exitHandler = null;
  let errorHandler = null;
  let diagnosticHandler = null;
  let messages = [];
  let errors = [];
  let diagnostics = [];
  let exited = false;
  let closing = false;
  let killPromise = null;
  let closePromise = null;
  let buffer = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);

  const notifyError = (error) => {
    const detail = asError(error);
    if (errorHandler) errorHandler(detail);
    else if (errors.length < 8) errors.push(detail);
  };
  const notifyExit = (info) => {
    if (exited) return;
    exited = true;
    if (exitHandler) exitHandler(info);
  };
  const protocolFailure = (message) => {
    const error = extensionError('PROTOCOL_VIOLATION', message);
    notifyError(error);
    void killTree();
  };
  const deliver = (raw) => {
    if (messageHandler) messageHandler(raw);
    else if (messages.length < MAX_QUEUED_MESSAGES) messages.push(raw);
    else protocolFailure('Worker emitted too many frames before host registration');
  };

  const send = (raw) => {
    if (closing || exited || child.stdin.destroyed || !child.stdin.writable) {
      throw extensionError('PROVIDER_UNAVAILABLE', 'Extension Worker stdin is closed');
    }
    if (typeof raw !== 'string') throw extensionError('INVALID_PARAMS', 'Process transport accepts serialized frame strings');
    const size = Buffer.byteLength(raw, 'utf8');
    if (size > frameLimit) throw extensionError('MESSAGE_TOO_LARGE', `Process frame exceeds ${frameLimit} bytes`);
    if (raw.includes('\n')) throw extensionError('INVALID_PARAMS', 'Process frame must contain one JSON line');
    if (child.stdin.writableLength + size + 1 > MAX_QUEUED_STDIN_BYTES) {
      throw extensionError('INVOKE_OVERLOAD', 'Extension Worker stdin queue is full');
    }
    child.stdin.write(raw + '\n');
  };

  child.stdout.on('data', (chunk) => {
    if (exited) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > frameLimit) return protocolFailure(`Worker frame exceeds ${frameLimit} bytes`);
      if (line.length === 0) return protocolFailure('Worker emitted an empty frame');
      deliver(line.toString('utf8'));
    }
    if (buffer.length > frameLimit) protocolFailure(`Worker partial frame exceeds ${frameLimit} bytes`);
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]);
    if (stderrTail.length > MAX_STDERR_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - MAX_STDERR_BYTES);
    const diagnostic = Buffer.from(chunk).toString('utf8').slice(-2000);
    if (diagnosticHandler) diagnosticHandler(diagnostic);
    else if (diagnostics.length < 16) diagnostics.push(diagnostic);
  });
  child.once('error', (error) => {
    notifyError(extensionError('PROVIDER_UNAVAILABLE', 'Unable to spawn Extension Worker: ' + String(error?.message ?? error)));
    notifyExit({ code: null, signal: null, error });
  });
  child.once('exit', (code, signal) => {
    if (buffer.length > 0) notifyError(extensionError('PROTOCOL_VIOLATION', 'Worker exited with a truncated frame'));
    notifyExit({ code, signal });
  });

  function killTree() {
    if (!killPromise) {
      closing = true;
      child.stdin.destroy();
      killPromise = terminateProcessTree(child, { systemRoot: env.SystemRoot });
    }
    return killPromise;
  }

  function close({ graceMs: requestedGraceMs = graceMs } = {}) {
    if (!closePromise) {
      closePromise = (async () => {
        if (!exited && !closing) {
          const shutdownFrame = JSON.stringify({ v: PROTOCOL_VERSION, id: 'worker-shutdown', kind: 'shutdown' });
          try { send(shutdownFrame); } catch (error) { notifyError(error); }
          closing = true;
          if (!child.stdin.destroyed) child.stdin.end();
        }
        await waitForChildExit(child, Math.max(0, requestedGraceMs));
        await killTree();
      })();
    }
    return closePromise;
  }

  return {
    cwd,
    get pid() { return child.pid ?? null; },
    send,
    onMessage(handler) {
      messageHandler = handler;
      for (const raw of messages.splice(0)) handler(raw);
    },
    onExit(handler) {
      exitHandler = handler;
      if (exited) handler({ code: child.exitCode, signal: child.signalCode });
    },
    onError(handler) {
      errorHandler = handler;
      for (const error of errors.splice(0)) handler(error);
    },
    onDiagnostic(handler) {
      diagnosticHandler = handler;
      for (const diagnostic of diagnostics.splice(0)) handler(diagnostic);
    },
    alive() { return !exited && child.exitCode === null && child.signalCode === null; },
    stderr() { return stderrTail.toString('utf8'); },
    close,
    killTree
  };
}
