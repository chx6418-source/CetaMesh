import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createMinimalAgentEnv, findCliExecutable } from './cli-agent-process.js';

const NAMES = Object.freeze({ gemini: 'Gemini', opencode: 'OpenCode', qwen: 'Qwen', claude: 'Claude' });
const CACHE_MS = 30_000;
const value = (env, key) => Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];

// Only installation metadata is queried. No client is launched or treated as a CLI.
function queryClaudeStore(env) {
  const root = value(env, 'SYSTEMROOT');
  if (!root || !path.isAbsolute(root)) return Promise.reject(new Error('SystemRoot unavailable'));
  const command = "$ErrorActionPreference='Stop';$p=Get-AppxPackage -Name 'Claude' | Select-Object -First 1;if($null -ne $p){[pscustomobject]@{name=$p.Name;root=$p.InstallLocation;version=$p.Version.ToString()} | ConvertTo-Json -Compress}";
  return new Promise((resolve, reject) => execFile(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { env: createMinimalAgentEnv(env), windowsHide: true, shell: false, timeout: 4000, maxBuffer: 16384, encoding: 'utf8' },
    (error, stdout) => {
      if (error) return reject(error);
      try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch (parseError) { reject(parseError); }
    }));
}

/** Installed Desktop clients and executable Agent CLIs are separate evidence. */
export function createAgentInstallationDetector({ env = process.env, platform = process.platform,
  findCli = findCliExecutable, stat = fs.statSync, storeQuery = queryClaudeStore, now = Date.now } = {}) {
  const cache = new Map();
  const fileState = file => {
    try { return stat(file).isFile(); }
    catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? false : null; }
  };
  async function inspect(id) {
    let cliInstalled = null;
    try { cliInstalled = Boolean(findCli(id, { env, platform })); } catch { cliInstalled = null; /* Discovery uncertainty is not absence. */ }
    const desktopApp = { displayName: NAMES[id], installed: null, running: null, status: 'unknown', version: null };
    const local = value(env, 'LOCALAPPDATA');
    if (platform === 'win32' && local && path.isAbsolute(local)) {
      const relatives = id === 'gemini' ? [['Google', 'Gemini', 'Gemini.exe']]
        : id === 'opencode' ? [['Programs', '@opencodedesktop', 'OpenCode.exe']]
          : id === 'qwen' ? [['Programs', 'Qwen', 'Qwen.exe']]
            : [['Claude', 'claude.exe'], ['AnthropicClaude', 'claude.exe']];
      const evidence = relatives.map(parts => fileState(path.join(local, ...parts)));
      desktopApp.installed = evidence.includes(true) ? true : evidence.includes(null) ? null : false;
      if (id === 'claude' && desktopApp.installed !== true) {
        try {
          const app = await storeQuery(env);
          if (app === null) { /* A completed empty query is an installation miss. */ }
          else if (app?.name === 'Claude' && typeof app.root === 'string' && path.isAbsolute(app.root)) {
            const installed = fileState(path.join(app.root, 'app', 'claude.exe'));
            desktopApp.installed = installed === true ? true : installed === null ? null : desktopApp.installed;
            if (installed === true && /^\d+(?:\.\d+){2,3}$/.test(app.version ?? '')) desktopApp.version = app.version;
          } else desktopApp.installed = null;
        } catch { desktopApp.installed = null; }
      }
      desktopApp.status = desktopApp.installed === true ? 'installed' : desktopApp.installed === false ? 'not-installed' : 'unknown';
    }
    return { cliInstalled, desktopApp };
  }
  return async (id, { refresh = false } = {}) => {
    if (!Object.hasOwn(NAMES, id)) return null;
    const previous = cache.get(id);
    if (previous && (previous.pending || (!refresh && now() - previous.at < CACHE_MS))) return previous.promise;
    const entry = { at: now(), pending: true };
    entry.promise = inspect(id).finally(() => { entry.pending = false; });
    cache.set(id, entry);
    return entry.promise;
  };
}
