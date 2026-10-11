import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';

export const DSH_OFFICIAL_DOWNLOAD_URL = 'https://www.deepseek.com/en/download/';
export const DSH_DESKTOP_EXECUTABLE = 'DeepSeek Harness.exe';
export const DSH_DESKTOP_STATUS_CACHE_MS = 30_000;
const DSH_DESKTOP_STARTUP_GRACE_MS = 10_000;

const APP_NAME = 'DeepSeek Harness';
const CHILD_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH'];
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
];
const APP_PATH_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\DeepSeek Harness.exe'
];

function describeError(error) {
  return String(error?.message ?? error ?? 'Unknown DSH Desktop integration failure');
}

function minimalChildEnvironment(source = process.env) {
  return Object.fromEntries(CHILD_ENV_KEYS
    .map(key => [key, source[key]])
    .filter(([, value]) => typeof value === 'string' && value.length > 0));
}

function execFile(file, args, { timeout = 5_000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout, maxBuffer, windowsHide: true, shell: false, env: minimalChildEnvironment(), encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function parseRegistryValues(output) {
  const values = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/i);
    if (!match) continue;
    values[match[1].trim()] = match[2].trim();
  }
  return values;
}

function parseRegistryKeys(output) {
  return String(output ?? '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\/i.test(line));
}

export function parseDshVersion(value) {
  const match = String(value ?? '').match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/);
  return match?.[1] ?? null;
}

function expandWindowsEnvironment(value, env = process.env) {
  return String(value ?? '').replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}

function cleanIconPath(value) {
  let candidate = String(value ?? '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('"')) {
    const close = candidate.indexOf('"', 1);
    if (close > 1) candidate = candidate.slice(1, close);
  } else {
    candidate = candidate.replace(/,\s*-?\d+\s*$/, '');
  }
  return candidate;
}

async function queryRegistry(key, run = execFile) {
  try {
    const { stdout } = await run('reg.exe', ['query', key]);
    return stdout;
  } catch (error) {
    // Missing registry branches are normal on machines without a per-user or 32-bit install.
    if (error?.code === 'ENOENT' || error?.code === 'ERROR_FILE_NOT_FOUND' || error?.code === '1' || error?.code === 1) return '';
    throw error;
  }
}

async function findUninstallEntries({ run = execFile } = {}) {
  const entries = [];
  for (const root of UNINSTALL_ROOTS) {
    let result = '';
    try {
      ({ stdout: result } = await run('reg.exe', ['query', root, '/s', '/f', APP_NAME, '/d']));
    } catch (error) {
      // A missing optional hive or app is a normal detection miss.
      if (error?.code === 'ENOENT' || error?.code === 'ERROR_FILE_NOT_FOUND' || error?.code === '1' || error?.code === 1) continue;
      throw error;
    }
    for (const key of parseRegistryKeys(result)) {
      const values = parseRegistryValues(await queryRegistry(key, run));
      if (!String(values.DisplayName ?? '').toLowerCase().includes(APP_NAME.toLowerCase())) continue;
      entries.push({
        displayName: values.DisplayName ?? APP_NAME,
        version: parseDshVersion(values.DisplayVersion) ?? values.DisplayVersion ?? null,
        installLocation: expandWindowsEnvironment(values.InstallLocation),
        displayIcon: expandWindowsEnvironment(values.DisplayIcon),
        key
      });
    }
  }
  return entries;
}

async function findAppPathEntries({ run = execFile } = {}) {
  const results = [];
  for (const key of APP_PATH_KEYS) {
    const values = parseRegistryValues(await queryRegistry(key, run));
    const executablePath = expandWindowsEnvironment(values['(Default)'] ?? values['']);
    if (executablePath) results.push({ executablePath, source: 'app-paths', version: null });
  }
  return results;
}

async function hasStartMenuShortcut({ env = process.env, fsImpl = fs.promises } = {}) {
  const roots = [
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.PROGRAMDATA && path.join(env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ].filter(Boolean);
  const pending = roots.map(root => ({ root, depth: 0 }));
  let inspected = 0;
  while (pending.length && inspected < 2_000) {
    const current = pending.shift();
    let entries;
    try {
      entries = await fsImpl.readdir(current.root, { withFileTypes: true });
    } catch (error) {
      // Start Menu roots and nested folders can be absent or access restricted.
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') continue;
      throw error;
    }
    for (const entry of entries) {
      inspected += 1;
      const target = path.join(current.root, entry.name);
      if (entry.isDirectory() && current.depth < 5) pending.push({ root: target, depth: current.depth + 1 });
      if (entry.isFile() && /deepseek[\s._-]*harness/i.test(entry.name) && /\.lnk$/i.test(entry.name)) return true;
      if (inspected >= 2_000) break;
    }
  }
  return false;
}

async function pathIsFile(candidate, fsImpl = fs.promises) {
  if (!candidate || typeof candidate !== 'string') return false;
  try {
    const stat = await fsImpl.stat(candidate);
    return stat.isFile();
  } catch (error) {
    // Stale uninstall records and optional default paths are expected during detection.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return false;
    throw error;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter(candidate => {
    if (!candidate) return false;
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function discoverDshDesktop({ platform = process.platform, env = process.env, fsImpl = fs.promises, run = execFile } = {}) {
  if (platform !== 'win32') return null;
  const entries = await findUninstallEntries({ run });
  const appPaths = await findAppPathEntries({ run });
  const shortcutFound = await hasStartMenuShortcut({ env, fsImpl });
  const defaults = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', APP_NAME, DSH_DESKTOP_EXECUTABLE),
    env.ProgramFiles && path.join(env.ProgramFiles, APP_NAME, DSH_DESKTOP_EXECUTABLE),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], APP_NAME, DSH_DESKTOP_EXECUTABLE)
  ].filter(Boolean).map(executablePath => ({ executablePath, source: 'known-install-location', version: null }));

  const candidates = [];
  for (const entry of entries) {
    candidates.push({ executablePath: cleanIconPath(entry.displayIcon), source: 'uninstall-registry', version: entry.version, registered: true });
    if (entry.installLocation) candidates.push({ executablePath: path.join(entry.installLocation, DSH_DESKTOP_EXECUTABLE), source: 'uninstall-registry', version: entry.version, registered: true });
  }
  candidates.push(...appPaths, ...defaults);
  let executable = null;
  for (const candidate of uniquePaths(candidates.map(item => item.executablePath)).map(file => candidates.find(item => item.executablePath && path.resolve(item.executablePath).toLowerCase() === path.resolve(file).toLowerCase()))) {
    if (await pathIsFile(candidate.executablePath, fsImpl)) {
      executable = candidate;
      break;
    }
  }
  if (!executable && !entries.length && !appPaths.length && !shortcutFound) return null;
  return {
    installed: entries.length > 0 || appPaths.length > 0 || shortcutFound || Boolean(executable),
    executablePath: executable?.executablePath ?? null,
    version: executable?.version ?? entries.find(entry => entry.version)?.version ?? null,
    source: executable?.source ?? (shortcutFound ? 'start-menu' : 'registration-only'),
    registered: entries.length > 0 || appPaths.length > 0,
    startMenuShortcutFound: shortcutFound
  };
}

export async function isDshDesktopRunning({ platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return false;
  try {
    const { stdout } = await run('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq ' + DSH_DESKTOP_EXECUTABLE]);
    return stdout.split(/\r?\n/).some(line => line.split(',')[0]?.replace(/^"|"$/g, '').toLowerCase() === DSH_DESKTOP_EXECUTABLE.toLowerCase());
  } catch (error) {
    // Process enumeration can fail in restricted sessions; that means unknown/not-running, not app failure.
    if (error?.code === 'ENOENT' || error?.code === '1' || error?.code === 1) return false;
    throw error;
  }
}

function findDshCliPath({ platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  const pathValue = String(env.PATH ?? env.Path ?? '');
  const extensions = platform === 'win32'
    ? [...new Set(['.exe', '.cmd', '.bat', ...(String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(item => item.toLowerCase()))])]
    : [''];
  for (const folder of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(folder, 'dsh' + ext);
      try {
        if (fsImpl.statSync(candidate).isFile()) return candidate;
      } catch (error) {
        // A PATH entry without dsh is a normal lookup miss.
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && error?.code !== 'EACCES') throw error;
      }
    }
  }
  return null;
}

function parseVersionOutput(output) {
  const match = String(output ?? '').match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m);
  return match?.[1] ?? null;
}

async function probeDshCli({ platform = process.platform, env = process.env, fsImpl = fs, run = execFile } = {}) {
  const executablePath = findDshCliPath({ platform, env, fsImpl });
  if (!executablePath) return { available: false, executablePath: null, version: null };
  let output = '';
  try {
    const extension = path.extname(executablePath).toLowerCase();
    if (platform === 'win32' && ['.cmd', '.bat'].includes(extension)) {
      const shim = fsImpl.readFileSync(executablePath, 'utf8');
      if (/node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(shim)) {
        const entry = path.join(path.dirname(executablePath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
        if (await pathIsFile(entry, fs.promises)) output = (await run(process.execPath, [entry, '--version'], { timeout: 3_000 })).stdout;
      }
    } else {
      output = (await run(executablePath, ['--version'], { timeout: 3_000 })).stdout;
    }
  } catch (error) {
    // The command may be present but not executable in this session; preserve availability and omit the version.
    return { available: true, executablePath, version: null, diagnosticsError: describeError(error) };
  }
  return { available: true, executablePath, version: parseVersionOutput(output) };
}

function launchDirect(executablePath) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(executablePath, [], {
      cwd: path.dirname(executablePath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: minimalChildEnvironment()
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ started: true });
    });
  });
}

function unavailableCli(error = null) {
  return {
    available: false,
    executablePath: null,
    version: null,
    ...(error ? { diagnosticsError: describeError(error) } : {})
  };
}

export function createDshDesktopIntegration({
  platform = process.platform,
  now = () => Date.now(),
  cacheMs = DSH_DESKTOP_STATUS_CACHE_MS,
  discoverDesktop = options => discoverDshDesktop({ ...options, platform }),
  isRunning = () => isDshDesktopRunning({ platform }),
  discoverCli = () => probeDshCli({ platform }),
  pathExists = file => pathIsFile(file),
  launchExecutable = launchDirect,
  supportedVersionRange = null,
  isSupportedVersion = null
} = {}) {
  let cached = null;
  let inFlight = null;
  let openInFlight = null;
  let recentLaunchAt = 0;

  function cachedStatus() {
    return cached ? structuredClone(cached) : null;
  }

  async function detect() {
    let app = null;
    let running = false;
    let cli = unavailableCli();
    let detectionError = null;
    try { running = await isRunning(null); }
    catch (error) { detectionError = error; }
    try { app = await discoverDesktop(); }
    catch (error) { detectionError ??= error; }
    try { cli = await discoverCli(); }
    catch (error) { cli = unavailableCli(error); }

    let executableAvailable = false;
    if (app?.executablePath) {
      try { executableAvailable = await pathExists(app.executablePath); }
      catch (error) { detectionError ??= error; }
    }
    const installed = app?.installed === true || running || executableAvailable;
    const version = app?.version ?? null;
    let unsupported = false;
    if (version && typeof isSupportedVersion === 'function') {
      try { unsupported = isSupportedVersion(version) === false; }
      catch (error) { detectionError ??= error; }
    }
    const status = unsupported
      ? 'unsupported_version'
      : running
        ? 'running'
        : detectionError
          ? 'unavailable'
          : !installed
            ? (platform === 'win32' ? 'not_installed' : 'unavailable')
            : executableAvailable
              ? 'installed'
              : 'unavailable';
    const diagnostics = {
      executablePath: app?.executablePath ?? null,
      discoverySource: app?.source ?? null,
      registrationFound: app?.registered === true,
      startMenuShortcutFound: app?.startMenuShortcutFound === true,
      lastError: detectionError ? describeError(detectionError) : null
    };
    return {
      id: 'dsh-desktop',
      displayName: APP_NAME,
      status,
      installed,
      available: installed && executableAvailable,
      executablePath: app?.executablePath ?? null,
      version,
      detectedVersion: version,
      supportedVersionRange,
      running,
      lastCheckedAt: now(),
      lastError: detectionError ? 'DETECTION_FAILED' : (installed && !executableAvailable && !running ? 'EXECUTABLE_MISSING' : null),
      diagnostics,
      cli: {
        available: cli?.available === true,
        executablePath: cli?.executablePath ?? null,
        version: cli?.version ?? null,
        diagnosticsError: cli?.diagnosticsError ?? null
      }
    };
  }

  async function status({ refresh = false } = {}) {
    if (!refresh && cached && now() - cached.lastCheckedAt < cacheMs) return cachedStatus();
    if (inFlight) return inFlight;
    inFlight = detect().then(result => {
      cached = result;
      return cachedStatus();
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function rememberRunning(running) {
    if (!cached) return;
    cached.running = running;
    if (running) {
      cached.installed = true;
      if (cached.status !== 'unsupported_version') cached.status = 'running';
    } else if (cached.status === 'running') {
      cached.status = cached.available ? 'installed' : 'unavailable';
    }
    cached.lastCheckedAt = now();
  }

  async function openOnce() {
    const state = await status();
    let runningNow = false;
    try {
      runningNow = await isRunning();
    } catch (error) {
      // Avoid a duplicate launch when the current process state cannot be verified.
      return {
        opened: false,
        action: 'unavailable',
        status: 'unavailable',
        message: '无法确认 DeepSeek Harness 是否正在运行。',
        diagnostics: { lastError: describeError(error) }
      };
    }
    if (runningNow) {
      rememberRunning(true);
      return { opened: true, action: 'already_running', status: cached.status, message: 'DeepSeek Harness 已经在运行。' };
    }
    if (recentLaunchAt && now() - recentLaunchAt < DSH_DESKTOP_STARTUP_GRACE_MS) {
      return { opened: true, action: 'starting', status: 'starting', message: '正在启动 DeepSeek Harness。' };
    }
    rememberRunning(false);
    state.running = false;
    state.status = cached?.status ?? state.status;
    if (state.running) return { opened: true, action: 'already_running', status: state.status, message: 'DeepSeek Harness 已在运行。' };
    if (!state.installed) return { opened: false, action: 'not_installed', status: state.status, message: '尚未安装 DeepSeek Harness。' };
    const executablePath = state.diagnostics.executablePath;
    if (!executablePath || !(await pathExists(executablePath))) {
      return { opened: false, action: 'unavailable', status: 'unavailable', message: '无法启动 DeepSeek Harness，请确认应用安装完整。' };
    }
    try {
      await launchExecutable(executablePath);
      recentLaunchAt = now();
      rememberRunning(true);
      return { opened: true, action: 'launched', status: 'starting', message: '正在打开 DeepSeek Harness。' };
    } catch (error) {
      return {
        opened: false,
        action: 'failed',
        status: 'unavailable',
        message: '无法启动 DeepSeek Harness，请确认应用安装完整。',
        diagnostics: { lastError: describeError(error) }
      };
    }
  }

  function open() {
    if (openInFlight) return openInFlight;
    openInFlight = openOnce().finally(() => { openInFlight = null; });
    return openInFlight;
  }

  async function settings({ agentEnabled = false, agentHealth = null, workspaceBoundary = 'unknown', defaultAgentProvider = 'dsh' } = {}) {
    const state = await status();
    return {
      id: 'dsh',
      displayName: APP_NAME,
      settingsRoute: 'agents.dsh',
      desktop: {
        status: state.status,
        installed: state.installed,
        running: state.running,
        version: state.version,
        officialDownloadUrl: DSH_OFFICIAL_DOWNLOAD_URL
      },
      agent: {
        id: 'dsh',
        enabled: agentEnabled === true,
        available: agentHealth?.available === true,
        health: agentHealth?.health ?? (agentHealth?.available === true ? 'ready' : agentHealth?.reason ?? 'unknown'),
        version: agentHealth?.version ?? null,
        workspaceMode: workspaceBoundary,
        supportsFreshSession: agentHealth?.supportsFreshSession ?? true,
        supportsResume: agentHealth?.supportsResume ?? true
      },
      workspaceMode: workspaceBoundary,
      continuity: { enabled: true, runtime: 'CetaMesh Continuity Runtime' },
      defaultAgentProvider,
      advanced: {
        diagnostics: state.diagnostics,
        cli: state.cli
      }
    };
  }

  return {
    status,
    refresh: () => status({ refresh: true }),
    open,
    settings,
    cachedStatus,
    downloadUrl: DSH_OFFICIAL_DOWNLOAD_URL
  };
}
