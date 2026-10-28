import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep TMPDIR short: suites create nested Unix sockets (typically 108-byte limit).
// The full suite ID remains in the ownership marker, not the directory basename.
const PREFIX = 'cm-test-';
const MARKER = '.cetamesh-test-run.json';

function safeSuiteId(value) {
  const result = String(value ?? 'suite').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return result || 'suite';
}

function assertMarkedDirectory(directory, tempRoot, expectedStatus = null) {
  const root = fs.realpathSync(tempRoot);
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error('test sandbox path is outside its marked Temp root');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('test sandbox is not a real directory');
  const markerPath = path.join(resolved, MARKER);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('test sandbox marker is invalid');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const suffix = path.basename(resolved).slice(PREFIX.length);
  if (!marker.runId || suffix !== marker.runId) throw new Error('test sandbox marker does not match its directory');
  if (expectedStatus && marker.status !== expectedStatus) throw new Error('test sandbox state changed');
  return { resolved, markerPath, marker };
}

function assertOwnedSandbox(sandbox) {
  const root = fs.realpathSync(sandbox.tempRoot);
  const resolved = path.resolve(sandbox.root);
  const expectedName = `${PREFIX}${sandbox.runId}`;
  if (path.dirname(resolved) !== root || path.basename(resolved) !== expectedName) {
    throw new Error('test sandbox ownership path does not match its run id');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('test sandbox is not a real directory');
  return { resolved, markerPath: path.join(resolved, MARKER) };
}

function retryFilesystemOperation(operation) {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (!retryableCodes.has(error?.code) || attempt === 5) throw error;
      // Windows may briefly keep a just-exited child process output open.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

function removeOwnedTree(target, { markerLast = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    // Remove only the link entry; recursive fs.rm does not traverse its target.
    retryFilesystemOperation(() => fs.rmSync(target, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 }));
    return;
  }
  if (!stat.isDirectory()) {
    retryFilesystemOperation(() => fs.unlinkSync(target));
    return;
  }
  const deferredMarkers = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (markerLast && entry.name === MARKER) {
      deferredMarkers.push(path.join(target, entry.name));
      continue;
    }
    removeOwnedTree(path.join(target, entry.name));
  }
  // Preserve ownership evidence if any child cannot be removed.
  for (const markerPath of deferredMarkers) removeOwnedTree(markerPath);
  retryFilesystemOperation(() => fs.rmdirSync(target));
}

function removeMarkedDirectory(directory, tempRoot, expectedStatus) {
  const { resolved } = assertMarkedDirectory(directory, tempRoot, expectedStatus);
  removeOwnedTree(resolved, { markerLast: true });
}

export function createSuiteSandbox({ suiteId, tempRoot = os.tmpdir(), now = new Date().toISOString(), pid = process.pid } = {}) {
  const safeId = safeSuiteId(suiteId);
  const runId = crypto.randomUUID();
  const root = fs.realpathSync(tempRoot);
  const directory = path.join(root, `${PREFIX}${runId}`);
  fs.mkdirSync(directory, { recursive: false });
  const marker = { suiteId: safeId, runId, status: 'running', startedAt: now, pid };
  const markerPath = path.join(directory, MARKER);
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
  return { root: directory, markerPath, runId, suiteId: safeId, tempRoot: root };
}

function registeredSecretPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('test secret path is outside its sandbox');
  const target = path.resolve(root, relative);
  const normalized = path.relative(root, target);
  if (!normalized || normalized === '..' || normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) throw new Error('test secret path is outside its sandbox');
  let cursor = root;
  const parts = normalized.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('test secret parent is not an owned directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

// Register before writing any credential. Propagate through marked parent suites so
// the runner can scrub even after taskkill, independently of diagnostic retention.
export function registerSuiteSecret({ sandbox, file } = {}) {
  const owned = assertOwnedSandbox(sandbox);
  let directory = owned.resolved;
  for (;;) {
    const info = assertMarkedDirectory(directory, path.dirname(directory));
    const relative = path.relative(directory, path.resolve(file));
    registeredSecretPath(directory, relative);
    const secretFiles = [...new Set([...(info.marker.secretFiles ?? []), relative])];
    fs.writeFileSync(info.markerPath, JSON.stringify({ ...info.marker, secretFiles }) + '\n');
    const parent = path.dirname(directory);
    if (!path.basename(parent).startsWith(PREFIX) || !fs.existsSync(path.join(parent, MARKER))) break;
    directory = parent;
  }
}

export function scrubSuiteSecrets({ sandbox } = {}) {
  const owned = assertOwnedSandbox(sandbox);
  let info;
  try { info = assertMarkedDirectory(owned.resolved, sandbox.tempRoot); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.marker.runId !== sandbox.runId || info.marker.suiteId !== sandbox.suiteId) throw new Error('suite sandbox ownership does not match');
  if (info.marker.secretFiles !== undefined && !Array.isArray(info.marker.secretFiles)) throw new Error('test secret registration is invalid');
  for (const relative of info.marker.secretFiles ?? []) {
    const target = registeredSecretPath(owned.resolved, relative);
    const targets = [target];
    // Existing credential/JSON stores use basename.pid.crypto.tmp. A killed writer
    // may leave those bytes before rename; scrub only this exact naming contract.
    const prefix = path.basename(target) + '.';
    try {
      for (const name of fs.readdirSync(path.dirname(target))) {
        if (name.startsWith(prefix) && /^\d+\.(?:[a-f0-9]{12}|[a-f0-9]{16})\.tmp$/.test(name.slice(prefix.length))) targets.push(path.join(path.dirname(target), name));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of targets) {
      try {
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) throw new Error('registered test secret is not a file');
        retryFilesystemOperation(() => fs.unlinkSync(file));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

export function finalizeSuiteSandbox({ sandbox, failed, keepFailed = false } = {}) {
  if (!sandbox?.root || !sandbox?.tempRoot) throw new Error('invalid suite sandbox');
  const owned = assertOwnedSandbox(sandbox);
  scrubSuiteSecrets({ sandbox });
  let marker = null;
  try {
    const stat = fs.lstatSync(owned.markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('test sandbox marker is invalid');
    marker = JSON.parse(fs.readFileSync(owned.markerPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (marker && (marker.runId !== sandbox.runId || marker.suiteId !== sandbox.suiteId)) {
    throw new Error('suite sandbox ownership does not match');
  }
  if (!failed || !keepFailed) {
    removeOwnedTree(owned.resolved, { markerLast: true });
    return { retained: false, removed: true };
  }

  const retainedMarker = {
    ...(marker ?? { suiteId: sandbox.suiteId, runId: sandbox.runId, startedAt: 'unknown' }),
    status: 'retained-failure', completedAt: new Date().toISOString(), pid: null
  };
  fs.writeFileSync(owned.markerPath, `${JSON.stringify(retainedMarker, null, 2)}\n`, 'utf8');
  for (const entry of fs.readdirSync(sandbox.tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === path.basename(sandbox.root) || !entry.name.startsWith(PREFIX)) continue;
    const previous = path.join(sandbox.tempRoot, entry.name);
    try {
      const info = assertMarkedDirectory(previous, sandbox.tempRoot);
      if (info.marker.suiteId === sandbox.suiteId && info.marker.status === 'retained-failure') {
        removeMarkedDirectory(previous, sandbox.tempRoot, 'retained-failure');
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError || error?.message?.startsWith('test sandbox')) continue;
      throw error;
    }
  }
  return { retained: true, removed: false };
}
