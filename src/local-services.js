// 本地 DSH 子服务管理；外部 OneBot 网关只由 Channel transport 连接。
//
// 这个模块只负责本机进程、安装文件检测和日志流，不把任何一个可选服务的
// 失败向上抛成桥接主流程启动失败。调用方可以在控制台启动后再按需重试。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonFile, writeJsonAtomic as writeJsonFileAtomic } from './storage/json-file.js';
import { NodeApiClient } from './dsh-client.js';

const execFileAsync = promisify(execFile);

export const DSH_INSTALL_HINT = '前置依赖：需先安装 Node.js 环境\n安装命令：npx @deepseek-ai/dsh web';

const LOG_LIMIT = 600;
const DETECTION_CACHE_VERSION = 2;
const FULL_SCAN_MAX_DIRS = 4000;
const FULL_SCAN_MAX_DEPTH = 4;

function asText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDir(value, base = process.cwd()) {
  const text = String(value ?? '').trim();
  return text ? path.resolve(base, text) : '';
}

function pathKey(value) {
  const resolved = normalizeDir(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function statSafe(target) {
  try { return await fsp.stat(target); } catch { return null; }
}

async function readJsonAsync(file, fallback = null) {
  try {
    return readJsonFile(file);
  } catch (error) {
    // A missing or invalid detection cache is recoverable; the next scan rebuilds it.
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  writeJsonFileAtomic(file, value);
}

function uniquePaths(values, base = process.cwd()) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const resolved = normalizeDir(value, base);
    if (!resolved) continue;
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function isInside(parent, target) {
  const p = process.platform === 'win32' ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const t = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
  return t === p || t.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function splitPathEnvironment(environment = process.env) {
  return String(environment.PATH || environment.Path || environment.path || '')
    .split(path.delimiter)
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function installationId(service, entrypoint) {
  return `${service}-${crypto.createHash('sha256').update(pathKey(entrypoint)).digest('hex').slice(0, 12)}`;
}

function versionFromPath(value) {
  const match = String(value || '').match(/(?:^|[^\d])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9a-z.-]+)?)/i);
  return match?.[1] || '';
}

async function readInstallationVersion(homeDir, entrypoint = '') {
  const dirs = uniquePaths([homeDir, entrypoint ? path.dirname(entrypoint) : '']);
  for (const start of dirs) {
    let cursor = start;
    for (let depth = 0; depth < 4 && isInside(homeDir, cursor); depth += 1) {
      const packageJson = await readJsonAsync(path.join(cursor, 'package.json'));
      if (packageJson?.version) return String(packageJson.version);
      for (const marker of ['VERSION', 'version.txt']) {
        try {
          const value = (await fsp.readFile(path.join(cursor, marker), 'utf8')).trim().split(/\r?\n/)[0];
          if (value) return value.replace(/^v/i, '');
        } catch {}
      }
      if (pathKey(cursor) === pathKey(homeDir)) break;
      cursor = path.dirname(cursor);
    }
  }
  return versionFromPath(entrypoint) || versionFromPath(homeDir) || '未知';
}

async function fileSignature(homeDir, entrypoint) {
  const [homeStat, entryStat] = await Promise.all([statSafe(homeDir), statSafe(entrypoint)]);
  return {
    homeMtimeMs: Math.trunc(homeStat?.mtimeMs || 0),
    entryMtimeMs: Math.trunc(entryStat?.mtimeMs || 0),
    entrySize: Number(entryStat?.size || 0)
  };
}

async function resolveDshPackageExecutable(packageDir, npmBinDir) {
  const packageJson = await readJsonAsync(path.join(packageDir, 'package.json'));
  const binValue = typeof packageJson?.bin === 'string'
    ? packageJson.bin
    : packageJson?.bin && typeof packageJson.bin === 'object'
      ? packageJson.bin.dsh || Object.values(packageJson.bin)[0]
      : '';
  const shims = process.platform === 'win32'
    ? [path.join(npmBinDir || path.dirname(packageDir), 'dsh.cmd'), path.join(npmBinDir || path.dirname(packageDir), 'dsh.exe')]
    : [path.join(npmBinDir || path.dirname(packageDir), 'dsh')];
  for (const shim of shims) if ((await statSafe(shim))?.isFile()) return shim;
  const target = binValue ? path.resolve(packageDir, String(binValue)) : '';
  // Windows 必须通过 npm 生成的 cmd/exe shim 启动；直接把 JS 文件交给 cmd 会产生误判。
  return process.platform !== 'win32' && target && (await statSafe(target))?.isFile() ? target : '';
}

async function readDshExecutableVersion(executable) {
  try {
    const result = process.platform === 'win32'
      ? await execFileAsync(
          environmentComSpec(),
          ['/d', '/s', '/c', `chcp 65001>nul & call ${commandLineQuoteStatic(executable)} --version`],
          { windowsHide: true, windowsVerbatimArguments: true, timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8' }
        )
      : await execFileAsync(executable, ['--version'], { timeout: 3000, maxBuffer: 64 * 1024 });
    const output = `${result.stdout || ''} ${result.stderr || ''}`;
    return versionFromPath(output) || '';
  } catch {
    return '';
  }
}

function environmentComSpec() {
  return process.env.ComSpec || 'cmd.exe';
}

function commandLineQuoteStatic(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function validateDshCandidate(candidate, defaultHome) {
  const input = normalizeDir(candidate?.path || candidate?.executable || candidate?.packageDir);
  if (!input) return [];
  const inputStat = await statSafe(input);
  if (!inputStat) return [];
  let executable = normalizeDir(candidate?.executable);
  let packageDir = normalizeDir(candidate?.packageDir);
  let homeDir = normalizeDir(candidate?.homeDir || defaultHome);
  if (inputStat.isFile()) executable = input;
  if (inputStat.isDirectory() && path.basename(input).toLowerCase() === '.dsh') homeDir = input;
  if (inputStat.isDirectory() && (await statSafe(path.join(input, 'package.json')))?.isFile()) packageDir = input;
  if (!executable && packageDir) executable = await resolveDshPackageExecutable(packageDir, candidate?.npmBinDir);
  if (!executable && inputStat.isDirectory()) {
    const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh'];
    for (const name of names) {
      const possible = path.join(input, name);
      if ((await statSafe(possible))?.isFile()) { executable = possible; break; }
    }
  }
  const executableStat = executable ? await statSafe(executable) : null;
  const recordHome = homeDir || (packageDir ? path.dirname(packageDir) : inputStat.isDirectory() ? input : path.dirname(input));
  if (!executableStat?.isFile()) {
    return [{
      id: installationId('dsh-invalid', input), service: 'dsh', homeDir: recordHome, packageDir,
      executable: '', entrypoint: '', version: packageDir ? await readInstallationVersion(packageDir) : '未知', valid: false,
      invalidReason: '检测到 dsh 目录，但未找到可执行文件 dsh/dsh.cmd', source: candidate.source || 'unknown',
      signature: await fileSignature(inputStat.isDirectory() ? input : path.dirname(input), input)
    }];
  }
  const versionHome = packageDir || path.dirname(executable);
  let version = await readInstallationVersion(versionHome, executable);
  if (version === '未知') version = await readDshExecutableVersion(executable) || '未知';
  return [{
    id: installationId('dsh', executable), service: 'dsh', homeDir: recordHome, packageDir,
    executable, entrypoint: executable, version, valid: true,
    invalidReason: '', source: candidate.source || 'unknown', signature: await fileSignature(versionHome, executable)
  }];
}

async function boundedDirectoryScan(roots, matcher, { maxDirs = FULL_SCAN_MAX_DIRS, maxDepth = FULL_SCAN_MAX_DEPTH } = {}) {
  const queue = uniquePaths(roots).map((dir) => ({ dir, depth: 0 }));
  const found = [];
  let visited = 0;
  while (queue.length && visited < maxDirs) {
    const { dir, depth } = queue.shift();
    visited += 1;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (await matcher(dir, entries)) found.push(dir);
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.git', '$recycle.bin'].includes(entry.name.toLowerCase())) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return { paths: uniquePaths(found), visited, truncated: queue.length > 0 };
}

function mergeInstallations(records) {
  const byKey = new Map();
  for (const item of records.flat().filter(Boolean)) {
    const key = pathKey(item.entrypoint || item.homeDir || item.packageDir);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || (!previous.valid && item.valid)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => Number(b.valid) - Number(a.valid) || String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
}

function detectionFingerprint(service, values) {
  return crypto.createHash('sha256').update(JSON.stringify({ version: DETECTION_CACHE_VERSION, service, values })).digest('hex');
}

// 单行自适应解码：优先“严格 UTF-8”，失败再按 GBK/GB18030（中文 Windows 控制台默认）解。
// 逐行判断而不是整条流只判一次——Node 自己输出 UTF-8，而 cmd/原生工具的本地化报错是 GBK，
// 同一份日志里两种编码混排很常见；一旦首行是纯 ASCII 就锁定编码，后面的中文就会变成乱码。
export function decodeAdaptiveLine(line) {
  if (!line || !line.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(line);
  } catch {
    try { return new TextDecoder('gb18030').decode(line); } catch { return Buffer.from(line).toString('latin1'); }
  }
}

export function createAdaptiveProcessDecoder() {
  const MAX_PENDING = 64 * 1024;
  let pending = Buffer.alloc(0);
  const drain = (flushAll) => {
    let out = '';
    for (;;) {
      const idx = pending.indexOf(0x0a);
      if (idx < 0) break;
      out += decodeAdaptiveLine(pending.subarray(0, idx + 1));
      pending = pending.subarray(idx + 1);
    }
    // 只有到流结束（或单行异常长）才解码没有换行的残留，避免把一个多字节字符截断成半个。
    if (pending.length && (flushAll || pending.length > MAX_PENDING)) {
      out += decodeAdaptiveLine(pending);
      pending = Buffer.alloc(0);
    }
    return out;
  };
  return {
    write(chunk) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      return drain(false);
    },
    end() {
      return drain(true);
    }
  };
}

async function cachedInstallations(cacheEntry, fingerprint) {
  if (!cacheEntry || cacheEntry.fingerprint !== fingerprint || !Array.isArray(cacheEntry.installations)) return null;
  const valid = cacheEntry.installations.filter((item) => item.valid && item.entrypoint);
  if (!valid.length) return null;
  const checks = await Promise.all(cacheEntry.installations.map(async (item) => {
    const entrypoint = item.entrypoint || item.packageDir || item.homeDir;
    if (!entrypoint) return false;
    const homeDir = item.valid && item.service === 'dsh'
      ? item.packageDir || path.dirname(entrypoint)
      : item.homeDir || item.packageDir || path.dirname(entrypoint);
    const signature = await fileSignature(homeDir, entrypoint);
    return signature.homeMtimeMs === item.signature?.homeMtimeMs
      && signature.entryMtimeMs === item.signature?.entryMtimeMs
      && signature.entrySize === item.signature?.entrySize;
  }));
  return checks.every(Boolean) ? cacheEntry.installations : null;
}

function publicSnapshot(state) {
  const result = { ...state };
  delete result.process;
  result.logs = Array.isArray(state.logs) ? state.logs.slice(-120) : [];
  result.installations = Array.isArray(state.installations)
    ? state.installations.map(({ signature, ...installation }) => installation)
    : [];
  return result;
}

export function connectorProcessEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !/^WHALEBRIDGE_UI_/i.test(name)));
}

export function createLocalServiceManager({ root, config = {}, onLog = () => {}, onConfigPatch = () => {}, detectionOptions = {} } = {}) {
  const repoRoot = path.resolve(root || process.cwd());
  const configFile = path.join(repoRoot, 'config.json');
  const cacheFile = path.join(repoRoot, 'state', 'local-service-detection.json');
  const environment = detectionOptions.environment || process.env;
  const userHome = normalizeDir(detectionOptions.userHome || os.homedir());
  const pathDirectories = splitPathEnvironment(environment);
  const configuredFullScanRoots = Array.isArray(detectionOptions.fullScanRoots) ? detectionOptions.fullScanRoots : null;
  const state = {
    dsh: {
      name: 'dsh', status: 'checking', installed: false, running: false, ready: false,
      processAlive: null, reachable: null, authenticated: null, sessionCapable: null,
      homeDir: '', executable: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      lastError: '', installHint: DSH_INSTALL_HINT, version: '', installations: [], selectedId: '', managed: false,
      detection: { status: 'pending', layer: 'none', durationMs: 0, completedAt: '', fromCache: false },
      updatedAt: new Date().toISOString(), logs: []
    }
  };
  const processes = { dsh: null };
  const listeners = new Set();
  let detectionPromise = null;
  let cacheData = null;

  function emit(service, event = 'status') {
    const payload = { service, event, snapshot: publicSnapshot(state[service]) };
    for (const listener of listeners) {
      if (listener.service !== 'all' && listener.service !== service) continue;
      try { listener.send(payload); } catch {}
    }
  }

  function emitAll(event, details = {}) {
    const payload = { service: 'all', event, snapshot: snapshot(), ...details };
    for (const listener of listeners) {
      if (listener.service !== 'all') continue;
      try { listener.send(payload); } catch {}
    }
  }

  function push(service, text, level = 'info') {
    const line = asText(text);
    if (!line) return;
    const entry = { time: new Date().toISOString(), level, text: line };
    state[service].logs.push(entry);
    if (state[service].logs.length > LOG_LIMIT) state[service].logs.splice(0, state[service].logs.length - LOG_LIMIT);
    state[service].updatedAt = entry.time;
    try { onLog(`[${service}] ${line}`); } catch {}
    emit(service, 'log');
  }

  function setState(service, patch) {
    Object.assign(state[service], patch, { updatedAt: new Date().toISOString() });
    emit(service, 'status');
  }

  function snapshot() {
    return { dsh: publicSnapshot(state.dsh) };
  }

  function customPathsFor(service) {
    return uniquePaths([
      ...(Array.isArray(cacheData?.customPaths?.[service]) ? cacheData.customPaths[service] : []),
      ...(Array.isArray(config?.[service]?.customPaths) ? config[service].customPaths : [])
    ], repoRoot);
  }

  async function detectDshInstallations(force = false) {
    const customPaths = customPathsFor('dsh');
    const appData = normalizeDir(environment.APPDATA);
    const npmBin = appData ? path.join(appData, 'npm') : '';
    const npmPackage = npmBin ? path.join(npmBin, 'node_modules', '@deepseek-ai', 'dsh') : '';
    const npmPrefix = normalizeDir(environment.npm_config_prefix);
    const prefixBin = npmPrefix ? (process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin')) : '';
    const prefixPackage = npmPrefix ? path.join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh') : '';
    const configuredHome = normalizeDir(config?.dsh?.homeDir, repoRoot);
    const configuredExecutable = normalizeDir(config?.dsh?.executable, repoRoot);
    // 只依据「配置 / DSH_HOME / 当前用户主目录」推导，不硬编码某个机器的用户名：
    // 写死 C:\Users\<某人>\.dsh 在别人机器上必然落空，还会把本机信息带进仓库。
    const dshHomeCandidates = uniquePaths([
      configuredHome,
      environment.DSH_HOME,
      userHome ? path.join(userHome, '.dsh') : '',
      // 兼容早期部署使用的非标准目录名（少一个点）。
      userHome ? path.join(path.dirname(userHome), path.basename(userHome) + '.dsh') : ''
    ]);
    const executableNames = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh'];
    const pathExecutables = pathDirectories.flatMap((dir) => executableNames.map((name) => path.join(dir, name)));
    const fingerprint = detectionFingerprint('dsh', {
      configuredHome, configuredExecutable, customPaths, dshHomeCandidates, npmBin, npmPackage, npmPrefix, prefixBin, prefixPackage, pathDirectories
    });
    if (!force) {
      const cached = await cachedInstallations(cacheData?.services?.dsh, fingerprint);
      if (cached) return { installations: cached, layer: 'cache', fromCache: true, fingerprint, scannedDirs: 0 };
    }

    const defaultHome = dshHomeCandidates.find((item) => pathKey(item) === pathKey(configuredHome))
      || dshHomeCandidates.find((item) => pathKey(item) === pathKey(path.join(userHome, '.dsh')))
      || dshHomeCandidates[0] || '';
    const priority = [
      ...customPaths.map((item) => ({ path: item, homeDir: defaultHome, npmBinDir: npmBin, source: 'custom' })),
      ...(configuredExecutable ? [{ path: configuredExecutable, executable: configuredExecutable, homeDir: configuredHome || defaultHome, source: 'configured' }] : []),
      ...(npmPackage ? [{ path: npmPackage, packageDir: npmPackage, homeDir: defaultHome, npmBinDir: npmBin, source: 'npm-global' }] : []),
      ...(prefixPackage ? [{ path: prefixPackage, packageDir: prefixPackage, homeDir: defaultHome, npmBinDir: prefixBin, source: 'npm-prefix' }] : []),
      ...(npmBin ? executableNames.map((name) => ({ path: path.join(npmBin, name), homeDir: defaultHome, source: 'npm-global-bin' })) : []),
      ...(prefixBin ? executableNames.map((name) => ({ path: path.join(prefixBin, name), homeDir: defaultHome, source: 'npm-prefix-bin' })) : []),
      ...pathExecutables.map((item) => ({ path: item, homeDir: defaultHome, source: 'path' }))
    ];
    let installations = mergeInstallations(await Promise.all(priority.map((item) => validateDshCandidate(item, defaultHome))));
    if (installations.some((item) => item.valid)) {
      // .dsh 是运行数据/配置目录，不是程序安装目录；已有全局可执行文件时不应把它误报为损坏安装。
      installations = installations.filter((item) => item.valid || path.basename(item.homeDir || '').toLowerCase() !== '.dsh');
      return { installations, layer: 'priority', fromCache: false, fingerprint, scannedDirs: priority.length };
    }

    const defaultRoots = uniquePaths([npmBin, npmPrefix, ...pathDirectories.filter((item) => /npm|node/i.test(item))]);
    const fullRoots = configuredFullScanRoots === null ? defaultRoots : uniquePaths(configuredFullScanRoots);
    const scan = await boundedDirectoryScan(fullRoots, async (dir, entries) => {
      const lower = path.basename(dir).toLowerCase();
      if (lower === 'dsh' || lower.includes('deepseek')) return true;
      return entries.some((item) => item.isFile() && executableNames.includes(item.name.toLowerCase()));
    }, detectionOptions);
    const fullRecords = await Promise.all(scan.paths.map((item) => validateDshCandidate({ path: item, homeDir: defaultHome, npmBinDir: npmBin, source: 'full-scan' }, defaultHome)));
    installations = mergeInstallations([installations, fullRecords]);
    if (installations.some((item) => item.valid)) {
      installations = installations.filter((item) => item.valid || path.basename(item.homeDir || '').toLowerCase() !== '.dsh');
    } else {
      const existingHomes = [];
      for (const item of dshHomeCandidates) if ((await statSafe(item))?.isDirectory()) existingHomes.push(item);
      const homeRecords = await Promise.all(existingHomes.map((item) => validateDshCandidate({ path: item, homeDir: item, source: 'home' }, item)));
      installations = mergeInstallations([installations, homeRecords]);
      // .dsh 是运行数据/配置目录，不是程序安装目录：即便机器上暂时没有可用的 dsh 可执行文件，
      // 也只能报“未检测到 dsh 服务”，不能把数据目录误报成“不完整安装”吓用户去重装。
      // 只有用户显式指定（custom/configured）时才保留该诊断记录。
      installations = installations.filter((item) => item.valid
        || path.basename(item.homeDir || '').toLowerCase() !== '.dsh'
        || ['custom', 'configured'].includes(item.source));
    }
    return { installations, layer: 'full-scan', fromCache: false, fingerprint, scannedDirs: scan.visited, truncated: scan.truncated };
  }

  function applyDetection(service, result, durationMs) {
    const installations = result.installations || [];
    const valid = installations.filter((item) => item.valid);
    const previousSelected = state[service].selectedId || cacheData?.selected?.[service] || '';
    const configuredEntry = normalizeDir(config?.dsh?.executable, repoRoot);
    const selected = valid.find((item) => item.id === previousSelected)
      || valid.find((item) => configuredEntry && pathKey(item.entrypoint) === pathKey(configuredEntry))
      || valid[0]
      || null;
    const child = processes[service];
    const alive = !!child && child.exitCode == null && !child.killed;
    const busy = ['starting', 'installing'].includes(state[service].status);
    const invalid = installations.filter((item) => !item.valid);
    const common = {
      installed: !!selected,
      installations,
      selectedId: selected?.id || '',
      version: selected?.version || '',
      source: selected?.source || (invalid.length ? 'invalid' : 'missing'),
      lastError: selected ? '' : invalid[0]?.invalidReason || '',
      detection: {
        status: 'complete', layer: result.layer, durationMs, fromCache: result.fromCache === true,
        scannedDirs: result.scannedDirs || 0, truncated: result.truncated === true,
        completedAt: new Date().toISOString(), invalidCount: invalid.length
      },
      running: alive || state[service].running === true && state[service].ready === true,
      status: busy ? state[service].status : selected
        ? (state[service].ready ? 'ready' : alive ? 'running' : 'stopped')
        : invalid.length ? 'invalid' : 'not-installed'
    };
    const fallbackHome = normalizeDir(environment.DSH_HOME || (userHome ? path.join(userHome, '.dsh') : ''));
    setState(service, {
      ...common, homeDir: selected?.homeDir || fallbackHome, executable: selected?.executable || '',
      profileDir: selected?.homeDir ? path.join(selected.homeDir, 'profiles') : '',
      credentials: selected?.homeDir ? path.join(selected.homeDir, '.credentials.yaml') : ''
    });
  }

  async function detectAll({ force = false } = {}) {
    if (detectionPromise) return detectionPromise;
    detectionPromise = (async () => {
      const started = Date.now();
      cacheData = cacheData || await readJsonAsync(cacheFile, { version: DETECTION_CACHE_VERSION, services: {}, customPaths: {}, selected: {} });
      setState('dsh', { detection: { ...state.dsh.detection, status: 'checking' }, status: state.dsh.running ? state.dsh.status : 'checking' });
      let result;
      try {
        result = await detectDshInstallations(force);
        applyDetection('dsh', result, Date.now() - started);
      } catch (error) {
        result = { fingerprint: '', installations: [] };
        setState('dsh', { lastError: asText(error?.message ?? error), status: 'failed', detection: { ...state.dsh.detection, status: 'failed' } });
      }
      // Preserve historical cache fields as inert records; retirement does not migrate user data.
      cacheData = {
        ...cacheData,
        version: DETECTION_CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        customPaths: cacheData?.customPaths || {},
        selected: { ...cacheData?.selected, dsh: state.dsh.selectedId },
        services: { ...cacheData?.services, dsh: { fingerprint: result.fingerprint, installations: state.dsh.installations } }
      };
      try { await writeJsonAtomic(cacheFile, cacheData); } catch (error) {
        push('dsh', '检测缓存写入失败：' + (error?.message ?? error), 'warn');
      }
      emitAll('detection-complete', {
        durationMs: Date.now() - started,
        matches: state.dsh.installations.filter(item => item.valid).length,
        invalid: state.dsh.installations.filter(item => !item.valid).length
      });
      try { await reconcileReadiness({ force: true }); } catch {}
      return snapshot();
    })().finally(() => { detectionPromise = null; });
    return detectionPromise;
  }

  function refresh() {
    if (!detectionPromise && state.dsh.detection.status === 'pending') {
      void detectAll();
    } else {
      // 外部启动/停止的服务不经过本管理器，取快照前顺手校正（内部节流，不会反复探活）。
      void reconcileReadiness();
    }
    return snapshot();
  }


  function dshWebUrl() {
    return String(config?.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  }

  let dshProbeState = { processAlive: null, reachable: false, authenticated: false, sessionCapable: false };
  // DSH Ready 必须通过已鉴权 API 并确认 session API 可用；根路径/任意 4xx 只代表 HTTP 存在。
  async function probeDshUrl() {
    const dshHome = state.dsh.homeDir || environment.DSH_HOME || path.join(userHome, '.dsh');
    const dshApi = detectionOptions.dshApi || new NodeApiClient(dshWebUrl(), { dshHome });
    try {
      await dshApi.callEndpoint('settings/describe', {}, AbortSignal.timeout(3000));
    } catch (error) {
      const processAlive = processes.dsh && processes.dsh.exitCode == null && !processes.dsh.killed ? true : null;
      dshProbeState = { processAlive,
        reachable: error?.code === 'DSH_UNREACHABLE' ? false : error?.status ? true : null,
        authenticated: error?.code === 'DSH_AUTHENTICATION_FAILED' || error?.code === 'DSH_AUTH_MATERIAL_MISSING' ? false : null,
        sessionCapable: false };
      return false;
    }
    try {
      await dshApi.callEndpoint('session/list', { _request: {} }, AbortSignal.timeout(3000));
      dshProbeState = { processAlive: processes.dsh && processes.dsh.exitCode == null && !processes.dsh.killed ? true : null,
        reachable: true, authenticated: true, sessionCapable: true };
      return true;
    } catch {
      dshProbeState = { processAlive: processes.dsh && processes.dsh.exitCode == null && !processes.dsh.killed ? true : null,
        reachable: true, authenticated: true, sessionCapable: false };
      return false;
    }
  }

  // 就绪状态校正：DSH 可由用户、系统服务或另一个控制台在本管理器之外启动，
  // 只凭“本进程是否托管了子进程”判断会把已经在跑的服务显示成“未运行”。
  // 这里统一以端口探活为准，并区分“托管”（可停止）与“外部”（只监控、不重复拉起）。
  let lastReconcileAt = 0;
  let reconcilePromise = null;

  function applyReadiness(service, alive, managed) {
    const current = state[service];
    const next = {
      running: !!alive,
      ready: !!alive,
      managed: alive ? !!managed : false,
      pid: alive && managed ? (processes[service]?.pid ?? null) : null,
      status: alive ? 'ready' : (current.lastError ? 'failed' : (current.installed ? 'stopped' : 'not-installed')),
      // 探活成功说明服务确实健康，清掉历史失败原因；探不到时保留最后一次原因供排查。
      lastError: alive ? '' : current.lastError
    };
    const changed = current.running !== next.running
      || current.ready !== next.ready
      || current.managed !== next.managed
      || (current.pid ?? null) !== next.pid
      || current.status !== next.status;
    if (changed) setState(service, next);
  }

  async function reconcileReadiness({ throttleMs = 4000, force = false } = {}) {
    if (reconcilePromise) return reconcilePromise;
    if (!force && Date.now() - lastReconcileAt < throttleMs) return null;
    lastReconcileAt = Date.now();
    reconcilePromise = (async () => {
      const alive = await probeDshUrl().catch(() => false);
      const current = state.dsh;
      // 启动流程自己收敛状态；外部 DSH 只监控，不取得进程控制权。
      if (current.status === 'starting') return snapshot();
      const child = processes.dsh;
      const managed = !!child && child.exitCode == null && !child.killed;
      setState('dsh', { ...dshProbeState, processAlive: managed ? true : dshProbeState.processAlive });
      if (!alive && managed) return snapshot();
      applyReadiness('dsh', alive, managed);
      setState('dsh', dshProbeState);
      return snapshot();
    })().finally(() => { reconcilePromise = null; });
    return reconcilePromise;
  }

  async function waitFor(service, probe, waitMs, shouldContinue = () => true) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() <= deadline) {
      if (await probe()) return true;
      if (!shouldContinue()) return false;
      await sleep(1000);
    }
    return false;
  }

  function attachProcess(service, child) {
    processes[service] = child;
    state[service].process = child;
    setState(service, { running: true, ready: false, status: 'starting', pid: child.pid ?? null, lastError: '', managed: true });
    const decoders = { stdout: createAdaptiveProcessDecoder(), stderr: createAdaptiveProcessDecoder() };
    const partial = { stdout: '', stderr: '' };
    const recentOutput = [];
    const consume = (text, stream, flush = false) => {
      const parts = (partial[stream] + text).split(/\r?\n/);
      partial[stream] = flush ? '' : parts.pop() || '';
      if (flush && parts.length && parts.at(-1) === '') parts.pop();
      if (flush && !parts.length && partial[stream]) parts.push(partial[stream]);
      for (const line of parts) {
        const clean = asText(line);
        if (!clean) continue;
        recentOutput.push(clean);
        if (recentOutput.length > 12) recentOutput.shift();
        push(service, clean, stream === 'stderr' ? 'warn' : 'info');
      }
    };
    const write = (buf, stream) => {
      const text = Buffer.isBuffer(buf) ? decoders[stream].write(buf) : String(buf);
      if (text) consume(text, stream);
    };
    child.stdout?.on('data', (buf) => write(buf, 'stdout'));
    child.stderr?.on('data', (buf) => write(buf, 'stderr'));
    let spawnFailed = false;
    child.on('error', (error) => {
      spawnFailed = true;
      if (processes[service] !== child) return;
      processes[service] = null;
      state[service].process = null;
      setState(service, { running: false, ready: false, status: 'failed', lastError: asText(error?.message ?? error), pid: null, managed: false });
      push(service, `进程异常：${error?.message ?? error}`, 'error');
    });
    child.on('close', (code, signal) => {
      for (const stream of ['stdout', 'stderr']) {
        const tail = decoders[stream].end();
        if (tail || partial[stream]) consume(tail, stream, true);
      }
      if (processes[service] !== child) return;
      processes[service] = null;
      state[service].process = null;
      if (spawnFailed) return;
      const intentionallyStopped = child.qqBridgeStopping === true;
      const failed = !intentionallyStopped && code !== 0;
      const exitSummary = `进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      const detail = recentOutput.slice(-3).join('；').slice(0, 600);
      setState(service, {
        running: false, ready: false, status: failed ? 'failed' : 'stopped', pid: null, managed: false,
        lastError: failed ? `${exitSummary}${detail ? `：${detail}` : ''}` : intentionallyStopped ? '' : state[service].lastError
      });
      push(service, exitSummary, failed ? 'error' : 'info');
    });
  }

  function commandLineQuote(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  // 参数**只在必要时**加引号：批处理里 %1 会把引号一起带进来
  // （`call x.cmd "web"` → %1 = "web"），不加引号才能拿到干净的参数值。
  // 含空白或 cmd 元字符的参数仍必须加引号，否则会被拆成多个参数。
  function commandLineArg(value) {
    const text = String(value);
    if (text && !/[\s"&|<>^()]/.test(text)) return text;
    return commandLineQuote(text);
  }

  function spawnServiceProcess(executable, args, { cwd, env, captureOutput = true } = {}) {
    env = connectorProcessEnv(env ?? process.env);
    const stdio = captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'];
    if (process.platform !== 'win32') {
      return spawn(executable, args, { cwd, env, windowsHide: true, stdio });
    }
    const isBatch = /\.(?:bat|cmd)$/i.test(executable);
    const invocation = `${isBatch ? 'call ' : ''}${commandLineQuote(executable)}${args.length ? ` ${args.map(commandLineArg).join(' ')}` : ''}`;
    // Node 默认会把 /c 后的整段再次转义为 \"…\"，cmd 会把它当作命令名并立即报错。
    // windowsVerbatimArguments 保留这里已经完成的 cmd 引号；切到 UTF-8 让中文错误和 Node 日志共用编码。
    const command = `chcp 65001>nul & ${invocation}`;
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      cwd, env, windowsHide: true, windowsVerbatimArguments: true,
      stdio
    });
  }

  async function stopService(service) {
    const child = processes[service];
    if (!child) {
      if (state[service].running && state[service].ready) {
        setState(service, { status: 'ready', lastError: '该服务由控制台外部进程运行，无法从这里停止', managed: false });
        return publicSnapshot(state[service]);
      }
      setState(service, { running: false, ready: false, status: state[service].installed ? 'stopped' : 'not-installed' });
      return publicSnapshot(state[service]);
    }
    push(service, '收到停止请求。', 'warn');
    child.qqBridgeStopping = true;
    try {
      if (process.platform === 'win32' && child.pid) {
        await execFileAsync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 10000 });
      } else {
        child.kill('SIGTERM');
      }
    } catch (error) {
      try { child.kill(); } catch {}
      push(service, `停止进程时出现提示：${error?.message ?? error}`, 'warn');
    }
    setState(service, { running: false, ready: false, status: 'stopped', pid: null, managed: false, lastError: '' });
    return publicSnapshot(state[service]);
  }

  async function persistDshConfig(homeDir, executable) {
    const patch = { homeDir, executable };
    try {
      const parsed = await readJsonAsync(configFile, {});
      parsed.dsh = { ...(parsed.dsh || {}), ...patch };
      await writeJsonAtomic(configFile, parsed);
      if (!config.dsh || typeof config.dsh !== 'object') config.dsh = {};
      Object.assign(config.dsh, patch);
      onConfigPatch({ dsh: patch });
    } catch (error) {
      push('dsh', `写入 config.json 失败：${error?.message ?? error}`, 'warn');
    }
  }

  async function selectInstallation(service, choice = {}) {
    if (service !== 'dsh') throw new Error('不支持的本地服务');
    if (state[service].running) {
      setState(service, { lastError: '服务运行中，切换版本前请先停止当前进程' });
      return publicSnapshot(state[service]);
    }
    cacheData = cacheData || await readJsonAsync(cacheFile, { version: DETECTION_CACHE_VERSION, services: {}, customPaths: {}, selected: {} });
    const manualPath = normalizeDir(choice.path, repoRoot);
    if (manualPath) {
      cacheData.customPaths ||= {};
      cacheData.customPaths[service] = uniquePaths([...(cacheData.customPaths[service] || []), manualPath]);
      await detectAll({ force: true });
    } else if (state[service].detection.status !== 'complete') {
      await detectAll();
    }
    const selected = state[service].installations.find((item) => item.valid && (
      item.id === choice.id
      || manualPath && [item.homeDir, item.entrypoint, item.packageDir].some((value) => value && (pathKey(value) === pathKey(manualPath) || isInside(manualPath, value)))
    ));
    if (!selected) {
      setState(service, { lastError: manualPath ? '所选路径不是完整、可启动的安装目录' : '未找到所选安装版本' });
      return publicSnapshot(state[service]);
    }
    state[service].selectedId = selected.id;
    state[service].installed = true;
    state[service].version = selected.version;
    state[service].source = selected.source;
    state[service].lastError = '';
    if (!state[service].running) state[service].status = 'stopped';
    state.dsh.homeDir = selected.homeDir;
    state.dsh.executable = selected.executable;
    await persistDshConfig(selected.homeDir, selected.executable);
    cacheData.selected ||= {};
    cacheData.selected[service] = selected.id;
    try { await writeJsonAtomic(cacheFile, cacheData); } catch (error) { push(service, `选择记录保存失败：${error?.message ?? error}`, 'warn'); }
    setState(service, {});
    push(service, `已选择版本 ${selected.version}：${selected.entrypoint}`);
    return publicSnapshot(state[service]);
  }

  async function startDsh({ waitMs = 15000 } = {}) {
    await detectAll();
    const current = state.dsh;
    const probeDsh = probeDshUrl;
    // 已由用户、系统服务或另一控制台实例启动时只接管监控，不重复拉起进程。
    if (await probeDsh()) {
      setState('dsh', { ...dshProbeState, status: 'ready', running: true, ready: true, managed: false, lastError: '' });
      return publicSnapshot(current);
    }
    if (!current.installed) {
      setState('dsh', { status: 'not-installed', lastError: '未检测到 dsh 服务目录' });
      push('dsh', `未检测到 dsh 服务。${DSH_INSTALL_HINT.replace(/\n/g, '；')}`, 'warn');
      return publicSnapshot(current);
    }
    if (processes.dsh && processes.dsh.exitCode == null && !processes.dsh.killed) {
      setState('dsh', { status: 'running', running: true });
      return publicSnapshot(current);
    }
    setState('dsh', { status: 'starting', running: false, ready: false, lastError: '' });
    push('dsh', '正在启动 dsh web 服务…');
    try {
      const child = spawnServiceProcess(current.executable, ['web'], {
        cwd: repoRoot,
        env: current.homeDir && fs.existsSync(current.homeDir)
          ? { ...process.env, DSH_HOME: current.homeDir }
          : process.env
      });
      attachProcess('dsh', child);
      const ready = await waitFor(
        'dsh', probeDsh, waitMs,
        () => processes.dsh === child && child.exitCode == null && !child.killed
      );
      const alive = !!processes.dsh && processes.dsh.exitCode == null && !processes.dsh.killed;
      const failed = !ready && !alive;
      setState('dsh', { ...dshProbeState, processAlive: alive, status: ready ? 'ready' : failed ? 'failed' : 'start-timeout', running: ready || alive, ready, lastError: ready ? '' : failed ? (state.dsh.lastError || 'dsh 进程已退出') : 'dsh 进程仍在运行，但 Agent Session API 尚未就绪' });
      push('dsh', ready ? 'dsh web 服务已就绪。' : failed ? 'dsh 进程已退出，请查看监控终端。' : 'dsh 已启动但尚未探测到 Web API，请查看监控终端。', ready ? 'info' : 'warn');
      return publicSnapshot(current);
    } catch (error) {
      setState('dsh', { status: 'failed', running: false, ready: false, lastError: asText(error?.message ?? error) });
      push('dsh', `启动失败：${error?.message ?? error}`, 'error');
      return publicSnapshot(current);
    }
  }

  function subscribe(service, send) {
    const item = { service: service === 'dsh' ? service : 'all', send };
    listeners.add(item);
    if (item.service === 'all') {
      send({ service: 'all', event: 'snapshot', snapshot: snapshot() });
    } else {
      send({ service: item.service, event: 'snapshot', snapshot: publicSnapshot(state[item.service]) });
    }
    return () => listeners.delete(item);
  }

  void detectAll().catch((error) => {
    setState('dsh', { status: 'failed', lastError: asText(error?.message ?? error), detection: { ...state.dsh.detection, status: 'failed' } });
  });
  // 控制台面板靠 SSE 推送、没有轮询，所以由管理器自身周期性校正就绪状态，
  // 这样用户在外部启停 DSH 时面板也能跟上（unref 不影响进程退出）。
  const readinessTimer = setInterval(() => { void reconcileReadiness(); }, 10000);
  readinessTimer.unref?.();
  return {
    snapshot,
    refresh,
    detectAll,
    reconcileReadiness,
    subscribe,
    detectDsh: async () => (await detectDshInstallations()).installations,
    selectDsh: (choice) => selectInstallation('dsh', choice),
    startDsh,
    stopDsh: () => stopService('dsh'),
    getDshInstallHint: () => DSH_INSTALL_HINT
  };
}
