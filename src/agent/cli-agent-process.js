import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'CODEX_HOME',
  'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'
]);

function envKey(name) {
  return process.platform === 'win32' ? String(name).toUpperCase() : String(name);
}

/** Keep only OS/runtime variables needed to locate and start a local CLI. */
export function createMinimalAgentEnv(source = process.env, overrides = {}) {
  const allowed = new Set(ENV_ALLOWLIST.map(envKey));
  const result = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (allowed.has(envKey(key)) && value !== undefined && value !== null) result[key] = String(value);
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (allowed.has(envKey(key)) && value !== undefined && value !== null) result[key] = String(value);
  }
  return result;
}

/** Resolve executable files directly from PATH without invoking a shell. */
export function findCliExecutable(name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const requested = String(name ?? '').trim();
  if (!requested) return null;
  if (path.isAbsolute(requested) || requested.includes(path.sep) || requested.includes('/')) {
    try { return exists(requested) ? path.resolve(requested) : null; } catch { /* An invalid explicit path is treated as not installed. */ return null; }
  }
  const pathValue = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const extensions = platform === 'win32'
    ? (String(Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '.EXE;.COM')
      .split(';').filter(Boolean).map((ext) => ext.toLowerCase()))
    : [''];
  const candidates = path.extname(requested) ? [requested] : [requested, ...extensions.map((ext) => `${requested}${ext}`)];
  for (const directory of String(pathValue).split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const full = path.resolve(directory, candidate);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) return full;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) throw error;
      }
    }
  }
  return null;
}

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
  constructor({ name, executable, argsPrefix = [], envSource = process.env, spawnImpl = spawn, probeImpl = spawnSync } = {}) {
    this.name = String(name ?? 'cli-agent');
    this.executableOverride = executable;
    this.argsPrefix = [...argsPrefix].map(String);
    this.envSource = envSource;
    this.spawnImpl = spawnImpl;
    this.probeImpl = probeImpl;
    this.sessions = new Map();
  }

  executable() {
    if (this.executableOverride === null) return null;
    if (this.executableOverride !== undefined) {
      const text = String(this.executableOverride).trim();
      if (!text) return null;
      try { return fs.statSync(text).isFile() ? path.resolve(text) : findCliExecutable(text, { env: this.envSource }); }
      catch { /* Non-absolute executable names may still resolve from PATH. */ return findCliExecutable(text, { env: this.envSource }); }
    }
    return findCliExecutable(this.name, { env: this.envSource });
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
    let result;
    try {
      result = this.probeImpl(executable, [...this.argsPrefix, ...args.map(String)], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
        env: createMinimalAgentEnv(this.envSource)
      });
    } catch {
      // A failed OS process launch is returned as provider health, not thrown from discovery.
      return { available: false, executable, code: 'probe_failed' };
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
    inputMode = 'end', onStdout = () => {}, onStderr = () => {} } = {}) {
    const executable = this.executable();
    if (!executable) throw Object.assign(new Error(`${this.name} is not installed`), { code: 'PROVIDER_UNAVAILABLE' });
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw Object.assign(new Error('CLI session needs an absolute CetaMesh-owned working directory'), { code: 'INVALID_PARAMS' });
    }
    if (!['end', 'open'].includes(inputMode)) throw Object.assign(new Error('CLI inputMode must be end or open'), { code: 'INVALID_PARAMS' });
    if (this.sessions.has(sessionId)) throw Object.assign(new Error('CLI session id is already active'), { code: 'INVALID_PARAMS' });
    const child = this.spawnImpl(executable, [...this.argsPrefix, ...args.map(String)], {
      cwd,
      env: createMinimalAgentEnv(this.envSource, env),
      windowsHide: true,
      detached: process.platform !== 'win32',
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
