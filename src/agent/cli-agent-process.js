import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'CODEX_HOME',
  'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'
]);
const PROXY_ENV_ALLOWLIST = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
const AUTH_ENV_ALLOWLIST = Object.freeze(['OPENAI_API_KEY', 'OPENAI_BASE_URL']);

function envKey(name) {
  return process.platform === 'win32' ? String(name).toUpperCase() : String(name);
}

/** Keep only OS/runtime variables needed to locate and start a local CLI. */
function safeProxyValue(name, raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 2048) return null;
  if (name === 'NO_PROXY') {
    return value.split(',').every((entry) => /^[A-Za-z0-9.*_:\-[\]]+$/.test(entry.trim())) ? value : null;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return value;
  } catch { return null; }
}

function safeOpenAiValue(name, raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 2000 || /[\r\n\0]/.test(value)) return null;
  if (name === 'OPENAI_API_KEY') return value.length >= 16 ? value : null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return value.replace(/\/+$/, '');
  } catch { return null; }
}

/**
 * Copy only runtime essentials and validated proxy settings. API credentials are
 * accepted only from explicit overrides whose keys the caller authorized.
 */
export function createMinimalAgentEnv(source = process.env, overrides = {}, { authorizedEnvKeys = [] } = {}) {
  const allowed = new Set(ENV_ALLOWLIST.map(envKey));
  const result = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (allowed.has(envKey(key)) && value !== undefined && value !== null) result[key] = String(value);
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (allowed.has(envKey(key)) && value !== undefined && value !== null) result[key] = String(value);
  }
  for (const name of PROXY_ENV_ALLOWLIST) {
    const actual = Object.entries({ ...(source ?? {}), ...(overrides ?? {}) }).find(([key]) => envKey(key) === envKey(name));
    if (!actual) continue;
    const safe = safeProxyValue(name, actual[1]);
    if (safe) result[name] = safe;
  }
  const authorized = new Set((Array.isArray(authorizedEnvKeys) ? authorizedEnvKeys : []).map(envKey));
  for (const name of AUTH_ENV_ALLOWLIST) {
    if (!authorized.has(envKey(name))) continue;
    const actual = Object.entries(overrides ?? {}).find(([key]) => envKey(key) === envKey(name));
    if (!actual) continue;
    const safe = safeOpenAiValue(name, actual[1]);
    if (safe) result[name] = safe;
  }
  return result;
}

function resolveNpmShimScript(executable, exists = fs.existsSync) {
  const directory = path.dirname(executable);
  const candidates = [
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.resolve(directory, '..', '@openai', 'codex', 'bin', 'codex.js'),
    path.resolve(directory, '..', '..', '@openai', 'codex', 'bin', 'codex.js')
  ];
  for (const candidate of candidates) {
    try { if (exists(candidate)) return path.resolve(candidate); }
    catch { continue; /* Unreadable candidates are skipped and the remaining explicit paths are checked. */ }
  }
  return null;
}

function environmentValue(env, key) {
  return Object.entries(env ?? {}).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1] ?? '';
}

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile(); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) throw error;
    return false;
  }
}

/** Resolve executable files directly without shell invocation, including Windows GUI npm shims. */
export function findCliCandidates(name, {
  env = process.env, platform = process.platform, exists = fs.existsSync, whereImpl = spawnSync
} = {}) {
  const requested = String(name ?? '').trim();
  if (!requested) return [];
  if (path.isAbsolute(requested) || requested.includes(path.sep) || requested.includes('/')) {
    try { return isFile(requested) ? [path.resolve(requested)] : []; } catch { /* Invalid explicit paths never fall back. */ return []; }
  }
  const found = [];
  const explicit = requested === 'codex' ? environmentValue(env, 'CODEX_CLI_PATH') : '';
  if (explicit) return path.isAbsolute(explicit) && isFile(explicit) && (platform !== 'win32' || /\.exe$/i.test(explicit)) ? [path.resolve(explicit)] : [];
  const installDir = requested === 'codex' ? environmentValue(env, 'CODEX_INSTALL_DIR') : '';
  if (installDir && path.isAbsolute(installDir)) found.push(path.join(installDir, platform === 'win32' ? 'codex.exe' : 'codex'));
  const pathValue = environmentValue(env, 'PATH');
  const extensions = platform === 'win32'
    ? [...new Set([
      ...String(environmentValue(env, 'PATHEXT') || '.EXE;.COM').split(';').filter(Boolean).map(ext => ext.toLowerCase()),
      '.exe', '.com', '.bat', '.cmd'
    ])]
    : [''];
  const candidates = path.extname(requested) ? [requested] : platform === 'win32'
    ? ['.exe', '.com', '.cmd', '.bat'].map(ext => `${requested}${ext}`)
    : [requested, ...extensions.map((ext) => `${requested}${ext}`)];
  const directories = String(pathValue).split(platform === 'win32' ? ';' : path.delimiter).filter(entry => path.isAbsolute(entry));
  if (platform === 'win32') {
    const appData = environmentValue(env, 'APPDATA');
    const localAppData = environmentValue(env, 'LOCALAPPDATA');
    const userProfile = environmentValue(env, 'USERPROFILE');
    directories.push(
      appData && path.join(appData, 'npm'),
      localAppData && path.join(localAppData, 'npm'),
      appData && path.join(appData, 'pnpm'),
      localAppData && path.join(localAppData, 'pnpm'),
      environmentValue(env, 'PNPM_HOME'),
      userProfile && path.join(userProfile, 'AppData', 'Local', 'pnpm')
    );
    if (requested === 'codex' && localAppData) directories.push(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
    const systemRoot = environmentValue(env, 'SYSTEMROOT') || environmentValue(env, 'WINDIR');
    let where;
    try {
      where = whereImpl(systemRoot ? path.join(systemRoot, 'System32', 'where.exe') : 'where.exe', [requested], {
        encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024, env: createMinimalAgentEnv(env)
      });
    } catch { where = null; /* Discovery failure still permits the bounded known-directory candidates. */ }
    if (where?.status === 0) {
      const results = String(where.stdout ?? '').split(/\r?\n/).map(line => line.trim())
        .filter(result => /\.(?:exe|com|cmd|bat)$/i.test(result))
        .sort((a, b) => Number(/\.(?:cmd|bat)$/i.test(a)) - Number(/\.(?:cmd|bat)$/i.test(b)));
      for (const result of results) {
        if (isFile(result)) found.push(path.resolve(result));
      }
    }
  }
  for (const directory of [...new Set(directories.filter(entry => entry && path.isAbsolute(entry)))]) {
    for (const candidate of candidates) {
      const full = path.resolve(directory, candidate);
      if (isFile(full)) found.push(full);
    }
  }
  return [...new Set(found.filter(isFile))].sort((a, b) => Number(/\.(?:cmd|bat)$/i.test(a)) - Number(/\.(?:cmd|bat)$/i.test(b)));
}

export function findCliExecutable(name, options = {}) { return findCliCandidates(name, options)[0] ?? null; }

function cappedAppend(current, chunk) {
  const next = current + String(chunk ?? '');
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function normalizedTimeout(value, fallback) {
  const number = Number(value);
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Number.isFinite(number) && number > 0 ? number : fallback));
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    // taskkill takes an argument array (no shell interpolation) so cancellation covers
    // Codex and the local sandbox commands it started.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      env: createMinimalAgentEnv()
    });
    killer.once('error', (error) => {
      try { child.kill(); }
      catch (killError) {
        if (killError?.code !== 'ESRCH') process.emitWarning(`Unable to stop CLI process tree: ${error?.code ?? killError?.code ?? 'unknown'}`);
      }
    });
    return;
  }
  try {
    if (Number.isInteger(child.pid) && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') process.emitWarning(`Unable to stop CLI process: ${error?.code ?? 'unknown'}`);
  }
}

/** Shared lifecycle for local CLI-backed Agent Providers. Provider flags/protocol stay outside. */
export class CliAgentProcess {
  constructor({ name, executable, argsPrefix = [], envSource = process.env, spawnImpl = spawn, probeImpl = spawnSync,
    platform = process.platform, nodeExecutable = process.execPath } = {}) {
    this.name = String(name ?? 'cli-agent');
    this.executableOverride = executable;
    this.selectedExecutable = null;
    this.argsPrefix = [...argsPrefix].map(String);
    this.envSource = envSource;
    this.spawnImpl = spawnImpl;
    this.probeImpl = probeImpl;
    this.platform = platform;
    // process.execPath is the packaged Core in a SEA release, not a Node CLI.
    this.nodeExecutable = !isSea() && /^node(?:\.exe)?$/i.test(path.basename(nodeExecutable ?? '')) && isFile(nodeExecutable)
      ? nodeExecutable : null;
    this.sessions = new Map();
  }

  environment() { return typeof this.envSource === 'function' ? this.envSource() : this.envSource; }

  candidates() {
    this.selectedExecutable = null;
    if (this.executableOverride === null) return [];
    const env = this.environment();
    const explicit = environmentValue(env, 'CODEX_CLI_PATH');
    this.discoveryCode = explicit && (!path.isAbsolute(explicit) || !isFile(explicit) || (this.platform === 'win32' && !/\.exe$/i.test(explicit))) ? 'CODEX_CLI_PATH_INVALID' : null;
    return this.executableOverride !== undefined
      ? findCliCandidates(String(this.executableOverride), { env, platform: this.platform })
      : findCliCandidates(this.name, { env, platform: this.platform });
  }

  selectExecutable(executable) { this.selectedExecutable = executable; }

  installKind() {
    const exe = this.executable();
    if (environmentValue(this.environment(), 'CODEX_CLI_PATH') || this.executableOverride !== undefined) return 'explicit';
    if (/\.(cmd|bat)$/i.test(exe ?? '')) return 'npm-shim';
    return /[\\/]Programs[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]/i.test(exe ?? '') ? 'standalone' : exe ? 'path' : 'not-detected';
  }

  launchTarget() {
    const executable = this.executable();
    if (!executable) return null;
    if (this.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
      return { executable, argsPrefix: this.argsPrefix };
    }
    const script = resolveNpmShimScript(executable);
    if (!script) throw Object.assign(new Error('Windows Codex command shim does not resolve to the installed npm CLI package'), { code: 'UNSUPPORTED_WINDOWS_SHIM' });
    const nodeExecutable = this.nodeExecutable ?? findCliExecutable(this.platform === 'win32' ? 'node.exe' : 'node', { env: this.environment(), platform: this.platform });
    if (!nodeExecutable) throw Object.assign(new Error('Windows Codex npm shim requires an installed standalone Node runtime'), { code: 'NODE_RUNTIME_UNAVAILABLE' });
    return { executable: nodeExecutable, argsPrefix: [script, ...this.argsPrefix] };
  }

  executable() {
    if (this.selectedExecutable) return this.selectedExecutable;
    return this.candidates()[0] ?? null;
  }

  health() {
    const executable = this.executable();
    return { name: this.name, available: Boolean(executable), executable, ...(executable ? {} : { reason: 'not_installed' }) };
  }

  version({ timeoutMs = 5000 } = {}) {
    const result = this.probe(['--version'], { timeoutMs });
    const version = String(result.stdout ?? '').trim().split(/\r?\n/, 1)[0].slice(0, 200);
    return {
      available: result.available,
      executable: result.executable,
      version: result.available && version ? version : null,
      ...(result.available ? {} : { reason: result.code ?? 'version_unavailable' })
    };
  }

  probe(args, { timeoutMs = 5000 } = {}) {
    const executable = this.executable();
    if (!executable) return { available: false, executable: null, code: 'not_installed' };
    let target;
    try { target = this.launchTarget(); }
    catch (error) { return { available: false, executable, code: error?.code ?? 'unsupported_shim' }; }
    let result;
    try {
      result = this.probeImpl(target.executable, [...target.argsPrefix, ...args.map(String)], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
        env: createMinimalAgentEnv(this.environment())
      });
    } catch (error) {
      // A failed OS process launch is returned as provider health, not thrown from discovery.
      return { available: false, executable, code: error?.code ?? 'probe_failed' };
    }
    return {
      available: result.status === 0,
      executable,
      code: result.status === 0 ? null : (result.error?.code ?? 'probe_failed'),
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? '')
    };
  }

  startSession({ sessionId = crypto.randomUUID(), cwd, args = [], input = '', env = {}, timeoutMs = 10 * 60 * 1000,
    inputMode = 'end', authorizedEnvKeys = [], onStdout = () => {}, onStderr = () => {} } = {}) {
    const executable = this.executable();
    if (!executable) throw Object.assign(new Error(`${this.name} is not installed`), { code: 'PROVIDER_UNAVAILABLE' });
    const target = this.launchTarget();
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw Object.assign(new Error('CLI session needs an absolute CetaMesh-owned working directory'), { code: 'INVALID_PARAMS' });
    }
    if (!['end', 'open'].includes(inputMode)) throw Object.assign(new Error('CLI inputMode must be end or open'), { code: 'INVALID_PARAMS' });
    if (this.sessions.has(sessionId)) throw Object.assign(new Error('CLI session id is already active'), { code: 'INVALID_PARAMS' });
    const child = this.spawnImpl(target.executable, [...target.argsPrefix, ...args.map(String)], {
      cwd,
      env: createMinimalAgentEnv(this.environment(), env, { authorizedEnvKeys }),
      windowsHide: true,
      detached: this.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, normalizedTimeout(timeoutMs, 10 * 60 * 1000));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.sessions.delete(sessionId);
      resolveDone(result);
    };
    // Decode incrementally: a JSONL record can split in the middle of a UTF-8 character.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = cappedAppend(stdout, chunk);
      try { onStdout(String(chunk)); }
      catch (error) { process.emitWarning(`CLI stdout consumer failed: ${error?.code ?? error?.message ?? 'unknown'}`); }
    });
    child.stderr?.on('data', (chunk) => {
      stderr = cappedAppend(stderr, chunk);
      try { onStderr(String(chunk)); }
      catch (error) { process.emitWarning(`CLI stderr consumer failed: ${error?.code ?? error?.message ?? 'unknown'}`); }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.sessions.delete(sessionId);
      rejectDone(Object.assign(new Error('Unable to start local CLI process'), { code: error?.code === 'ENOENT' ? 'PROVIDER_UNAVAILABLE' : 'PROCESS_START_FAILED' }));
    });
    child.once('close', (exitCode, signal) => finish({
      sessionId, exitCode: Number.isInteger(exitCode) ? exitCode : 1, signal: signal ?? null,
      timedOut, cancelled, stdout, stderr
    }));
    const handle = {
      sessionId,
      child,
      done,
      cancel: () => {
        if (settled) return { cancelled: false, reason: 'already-finished' };
        cancelled = true;
        killProcessTree(child);
        return { cancelled: true, sessionId };
      },
      shutdown: () => { if (!settled) { cancelled = true; killProcessTree(child); } }
    };
    this.sessions.set(sessionId, handle);
    if (inputMode === 'end') child.stdin?.end(String(input ?? ''));
    else if (input) child.stdin?.write(String(input));
    return handle;
  }

  send(sessionId, content, { end = false } = {}) {
    const handle = this.sessions.get(String(sessionId ?? ''));
    if (!handle) throw Object.assign(new Error('CLI process session is not active'), { code: 'SESSION_NOT_FOUND' });
    if (!handle.child.stdin?.writable) throw Object.assign(new Error('CLI process stdin is closed'), { code: 'SESSION_CLOSED' });
    if (end) handle.child.stdin.end(String(content ?? ''));
    else handle.child.stdin.write(String(content ?? ''));
    return { sent: true, sessionId: handle.sessionId };
  }

  cancel(sessionId) {
    const handle = this.sessions.get(String(sessionId ?? ''));
    return handle ? handle.cancel() : { cancelled: false, reason: 'not-running' };
  }

  async shutdown() {
    const active = [...this.sessions.values()];
    for (const handle of active) handle.shutdown();
    await Promise.allSettled(active.map((handle) => handle.done));
    return { stopped: active.length };
  }
}
