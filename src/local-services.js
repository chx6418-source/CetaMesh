// whalebridge 本地子服务管理：SnowLuma 与 dsh。
//
// 这个模块只负责本机进程、安装文件检测和日志流，不把任何一个可选服务的
// 失败向上抛成桥接主流程启动失败。调用方可以在控制台启动后再按需重试。
import fs from 'node:fs';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const execFileAsync = promisify(execFile);

export const SNOWLUMA_RELEASE_PAGE = 'https://github.com/SnowLuma/SnowLuma/releases/latest';
export const SNOWLUMA_RELEASE_API = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';
export const DSH_INSTALL_HINT = '前置依赖：需先安装 Node.js 环境\n安装命令：npx @deepseek-ai/dsh web';

/**
 * 从进程列表里挑出「QQ 顶层进程」。
 *
 * 为什么要挑顶层：QQ 是多进程应用（主进程 + 一堆子进程），要让它彻底退出必须从顶层连子树一起结束；
 * 而反过来，只杀子进程会留下主进程继续占用。判定"顶层"用父进程不在同一批 QQ 进程里来识别，
 * 不依赖进程名以外的任何猜测。
 */
export function selectTopLevelQqProcesses(processes = []) {
  const qq = processes.filter((item) => /^qq(\.exe)?$/i.test(String(item?.name ?? '')));
  const ids = new Set(qq.map((item) => Number(item.pid)));
  return qq.filter((item) => !ids.has(Number(item.parentPid)));
}

/**
 * 结束指定的 QQ 顶层进程及其子树。`killer` 可注入，便于测试不真的杀进程。
 * 返回每个进程的结果，便于控制台如实展示（不静默失败）。
 */
export async function quitQqProcesses({ listProcesses, killer } = {}) {
  const processes = await listProcesses();
  const targets = selectTopLevelQqProcesses(processes);
  const results = [];
  for (const target of targets) {
    try {
      await killer(target.pid);
      results.push({ pid: target.pid, ok: true });
    } catch (error) {
      results.push({ pid: target.pid, ok: false, error: error?.message ?? String(error) });
    }
  }
  return { targets, results };
}
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;
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
    const raw = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findFile(root, wantedNames, maxDepth = 4) {
  const names = new Set(wantedNames.map((name) => String(name).toLowerCase()));
  const base = normalizeDir(root);
  if (!base || !fs.existsSync(base)) return '';
  const queue = [{ dir: base, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name.toLowerCase())) return full;
      if (entry.isDirectory() && depth < maxDepth && entry.name !== 'node_modules') {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return '';
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

async function findFilesAsync(root, wantedNames, maxDepth = 4, maxDirs = 500) {
  const names = new Set(wantedNames.map((name) => String(name).toLowerCase()));
  const base = normalizeDir(root);
  if (!base || !(await statSafe(base))?.isDirectory()) return [];
  const queue = [{ dir: base, depth: 0 }];
  const found = [];
  let visited = 0;
  while (queue.length && visited < maxDirs) {
    const { dir, depth } = queue.shift();
    visited += 1;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name.toLowerCase())) found.push(full);
      if (entry.isDirectory() && depth < maxDepth && !['node_modules', '.git'].includes(entry.name.toLowerCase())) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return uniquePaths(found);
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

async function validateSnowCandidate(candidate) {
  const input = normalizeDir(candidate?.path);
  if (!input) return [];
  const inputStat = await statSafe(input);
  if (!inputStat) return [];
  const explicitFile = inputStat.isFile() ? input : normalizeDir(candidate?.launcherPath);
  const homeDir = inputStat.isDirectory() ? input : path.dirname(input);
  let launchers = [];
  if (explicitFile && (await statSafe(explicitFile))?.isFile()) launchers.push(explicitFile);
  launchers.push(...await findFilesAsync(homeDir, ['launcher.bat', 'start.bat', 'snowluma.bat'], 4, 600));
  launchers = uniquePaths(launchers);
  if (!launchers.length) {
    return [{
      id: installationId('snowluma-invalid', homeDir), service: 'snowluma', homeDir,
      launcherPath: '', entrypoint: '', version: await readInstallationVersion(homeDir), valid: false,
      invalidReason: '目录存在，但缺少 launcher.bat、start.bat 或 snowluma.bat', source: candidate.source || 'unknown',
      signature: await fileSignature(homeDir, homeDir)
    }];
  }
  return Promise.all(launchers.map(async (launcherPath) => {
    const launcherHome = path.dirname(launcherPath);
    return {
      id: installationId('snowluma', launcherPath), service: 'snowluma', homeDir: launcherHome,
      launcherPath, entrypoint: launcherPath, version: await readInstallationVersion(launcherHome, launcherPath),
      valid: true, invalidReason: '', source: candidate.source || 'unknown',
      signature: await fileSignature(launcherHome, launcherPath)
    };
  }));
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

/**
 * 记录由 WhaleBridge 启动的 SnowLuma launcher，供后续管理与诊断使用。
 * WhaleBridge 完全退出时会保留 SnowLuma 进程，让它继续管理 QQ。
 */
function snowLumaMarkerFile(root) {
  return path.join(root, 'state', 'snowluma.pid');
}

export function readSnowLumaMarker(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? { ...parsed, pid } : null;
  } catch {
    return null;
  }
}

function writeSnowLumaMarker(root, { pid, launcherPath, homeDir }) {
  try {
    const file = snowLumaMarkerFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ pid, launcherPath, homeDir, startedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    /* 记录失败不影响启动：最坏情况是后续无法通过 marker 识别这个实例 */
  }
}

function clearSnowLumaMarker(root) {
  try {
    fs.rmSync(snowLumaMarkerFile(root), { force: true });
  } catch {}
}

/**
 * 结束"本应用此前启动、现在仍在运行"的 SnowLuma（跨应用重启的场景）。
 * 只认记录文件里的 pid：调用方负责先确认进程身份（见 identifyProcess），避免 pid 被复用后误杀。
 * 依赖全部可注入，便于测试不真的杀进程。
 */
export async function stopRecordedSnowLuma({
  file,
  readMarker = readSnowLumaMarker,
  identify = null,
  killer = null,
  clearMarker = null
} = {}) {
  const markerFile = file ?? null;
  if (!markerFile) return { stopped: false, reason: 'no-record-file' };
  const marker = readMarker(markerFile);
  if (!marker) return { stopped: false, reason: 'no-record' };
  const discard = () => {
    if (clearMarker) clearMarker(markerFile);
  };
  let identity = null;
  try {
    identity = identify ? await identify(marker.pid) : null;
  } catch {
    identity = null;
  }
  // 记录里有 launcherPath 时要求进程身份匹配（SnowLuma 是 node 进程），
  // 避免 pid 被复用后误杀别的程序。
  if (marker.launcherPath && identity && !String(identity).toLowerCase().includes('snowluma') && !/^node(\.exe)?$/i.test(String(identity))) {
    discard();
    return { stopped: false, reason: 'pid-reused', pid: marker.pid, identity: String(identity) };
  }
  if (identity === null) {
    discard();
    return { stopped: false, reason: 'not-running', pid: marker.pid };
  }
  try {
    if (killer) await killer(marker.pid);
    discard();
    return { stopped: true, pid: marker.pid };
  } catch (error) {
    return { stopped: false, reason: 'kill-failed', pid: marker.pid, error: error?.message ?? String(error) };
  }
}

/** 列出本机进程（pid / 父 pid / 名称）。只读查询，用于精确识别 QQ 进程树。 */
async function listWindowsProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }
    );
    const parsed = JSON.parse(String(stdout).trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.Name }));
  } catch {
    // 查询失败时返回空列表：调用方会如实报"没有可结束的 QQ 进程"，绝不猜测性杀进程。
    return [];
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

async function relatedChildDirectories(roots, keyword) {
  const found = [];
  for (const root of uniquePaths(roots)) {
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase().includes(keyword)) found.push(path.join(root, entry.name));
    }
  }
  return uniquePaths(found);
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

export function pickSnowLumaReleaseAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const zips = assets.filter((asset) => /\.zip$/i.test(String(asset?.name ?? '')) && asset?.browser_download_url);
  if (!zips.length) return null;
  const score = (asset) => {
    const name = String(asset.name).toLowerCase();
    let value = 0;
    if (name.includes('win') || name.includes('windows')) value += 50;
    if (name.includes('x64') || name.includes('amd64')) value += 30;
    if (name.includes('full')) value += 10;
    if (name.includes('lite')) value -= 2;
    return value;
  };
  return [...zips].sort((a, b) => score(b) - score(a) || String(a.name).localeCompare(String(b.name)))[0];
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

export function createLocalServiceManager({ root, config = {}, onLog = () => {}, onConfigPatch = () => {}, detectionOptions = {}, captureSnowLumaOutput = true } = {}) {
  const repoRoot = path.resolve(root || process.cwd());
  const configFile = path.join(repoRoot, 'config.json');
  const cacheFile = path.join(repoRoot, 'state', 'local-service-detection.json');
  const environment = detectionOptions.environment || process.env;
  const userHome = normalizeDir(detectionOptions.userHome || os.homedir());
  const pathDirectories = splitPathEnvironment(environment);
  const commonSnowRoots = uniquePaths([
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    environment.LOCALAPPDATA
  ]);
  const configuredFullScanRoots = Array.isArray(detectionOptions.fullScanRoots) ? detectionOptions.fullScanRoots : null;
  const state = {
    snowluma: {
      name: 'SnowLuma', status: 'checking', installed: false, running: false, ready: false,
      homeDir: '', launcherPath: '', installDir: path.join(repoRoot, 'SnowLuma'),
      source: 'unknown', pid: null, lastError: '', releasePage: SNOWLUMA_RELEASE_PAGE,
      version: '', installations: [], selectedId: '', managed: false,
      detection: { status: 'pending', layer: 'none', durationMs: 0, completedAt: '', fromCache: false },
      updatedAt: new Date().toISOString(), logs: []
    },
    dsh: {
      name: 'dsh', status: 'checking', installed: false, running: false, ready: false,
      homeDir: '', executable: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      lastError: '', installHint: DSH_INSTALL_HINT, version: '', installations: [], selectedId: '', managed: false,
      detection: { status: 'pending', layer: 'none', durationMs: 0, completedAt: '', fromCache: false },
      updatedAt: new Date().toISOString(), logs: []
    }
  };
  const processes = { snowluma: null, dsh: null };
  const listeners = new Set();
  let installPromise = null;
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
    return { snowluma: publicSnapshot(state.snowluma), dsh: publicSnapshot(state.dsh) };
  }

  function customPathsFor(service) {
    return uniquePaths([
      ...(Array.isArray(cacheData?.customPaths?.[service]) ? cacheData.customPaths[service] : []),
      ...(Array.isArray(config?.[service]?.customPaths) ? config[service].customPaths : [])
    ], repoRoot);
  }

  async function detectSnowLuma(force = false) {
    const customPaths = customPathsFor('snowluma');
    const configuredHome = normalizeDir(config?.snowluma?.homeDir, repoRoot);
    const configuredLauncher = normalizeDir(config?.snowluma?.launcherPath, repoRoot);
    const bundled = path.join(repoRoot, 'SnowLuma');
    const pathMatches = uniquePaths(pathDirectories
      .filter((item) => item.toLowerCase().includes('snowluma'))
      .flatMap((item) => [item, path.dirname(item), path.dirname(path.dirname(item))]));
    const fingerprint = detectionFingerprint('snowluma', {
      configuredHome, configuredLauncher, bundled, customPaths, commonSnowRoots, pathMatches
    });
    if (!force) {
      const cached = await cachedInstallations(cacheData?.services?.snowluma, fingerprint);
      if (cached) return { installations: cached, layer: 'cache', fromCache: true, fingerprint, scannedDirs: 0 };
    }

    const related = await relatedChildDirectories([repoRoot, ...commonSnowRoots], 'snowluma');
    const priority = [
      ...customPaths.map((item) => ({ path: item, source: 'custom' })),
      ...(configuredHome || configuredLauncher ? [{ path: configuredHome || configuredLauncher, launcherPath: configuredLauncher, source: 'configured' }] : []),
      { path: bundled, source: 'bundled' },
      ...commonSnowRoots.map((item) => ({ path: path.join(item, 'SnowLuma'), source: 'common' })),
      ...related.map((item) => ({ path: item, source: 'common' })),
      ...pathMatches.map((item) => ({ path: item, source: 'path' }))
    ];
    let installations = mergeInstallations(await Promise.all(priority.map(validateSnowCandidate)));
    if (installations.some((item) => item.valid)) {
      return { installations, layer: 'priority', fromCache: false, fingerprint, scannedDirs: priority.length };
    }

    const fullRoots = configuredFullScanRoots === null ? commonSnowRoots : uniquePaths(configuredFullScanRoots);
    const scan = await boundedDirectoryScan(fullRoots, async (dir, entries) => {
      if (path.basename(dir).toLowerCase().includes('snowluma')) return true;
      return entries.some((item) => item.isFile() && ['launcher.bat', 'start.bat', 'snowluma.bat'].includes(item.name.toLowerCase()));
    }, detectionOptions);
    const fullRecords = await Promise.all(scan.paths.map((item) => validateSnowCandidate({ path: item, source: 'full-scan' })));
    installations = mergeInstallations([installations, fullRecords]);
    return { installations, layer: 'full-scan', fromCache: false, fingerprint, scannedDirs: scan.visited, truncated: scan.truncated };
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
    const configuredEntry = service === 'snowluma'
      ? normalizeDir(config?.snowluma?.launcherPath, repoRoot)
      : normalizeDir(config?.dsh?.executable, repoRoot);
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
    if (service === 'snowluma') {
      setState(service, { ...common, homeDir: selected?.homeDir || path.join(repoRoot, 'SnowLuma'), launcherPath: selected?.launcherPath || '' });
    } else {
      const fallbackHome = normalizeDir(environment.DSH_HOME || (userHome ? path.join(userHome, '.dsh') : ''));
      setState(service, {
        ...common, homeDir: selected?.homeDir || fallbackHome, executable: selected?.executable || '',
        profileDir: selected?.homeDir ? path.join(selected.homeDir, 'profiles') : '',
        credentials: selected?.homeDir ? path.join(selected.homeDir, '.credentials.yaml') : ''
      });
    }
  }

  async function detectAll({ force = false } = {}) {
    if (detectionPromise) return detectionPromise;
    detectionPromise = (async () => {
      const started = Date.now();
      cacheData = cacheData || await readJsonAsync(cacheFile, { version: DETECTION_CACHE_VERSION, services: {}, customPaths: {}, selected: {} });
      for (const service of ['snowluma', 'dsh']) {
        setState(service, { detection: { ...state[service].detection, status: 'checking' }, status: state[service].running ? state[service].status : 'checking' });
      }
      // 两个服务的所有路径与版本校验同时进行；任一检测失败不影响另一项或主界面。
      const timed = async (task) => {
        const serviceStarted = Date.now();
        const result = await task();
        return { ...result, durationMs: Date.now() - serviceStarted };
      };
      const settled = await Promise.allSettled([
        timed(() => detectSnowLuma(force)),
        timed(() => detectDshInstallations(force))
      ]);
      const results = settled.map((item, index) => item.status === 'fulfilled'
        ? item.value
        : { installations: [], layer: 'failed', fromCache: false, fingerprint: '', error: asText(item.reason?.message ?? item.reason), scannedDirs: 0 });
      const durationMs = Date.now() - started;
      applyDetection('snowluma', results[0], results[0].durationMs ?? durationMs);
      applyDetection('dsh', results[1], results[1].durationMs ?? durationMs);
      if (settled[0].status === 'rejected') setState('snowluma', { lastError: results[0].error, status: 'failed', detection: { ...state.snowluma.detection, status: 'failed' } });
      if (settled[1].status === 'rejected') setState('dsh', { lastError: results[1].error, status: 'failed', detection: { ...state.dsh.detection, status: 'failed' } });
      cacheData = {
        version: DETECTION_CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        customPaths: cacheData?.customPaths || {},
        selected: { snowluma: state.snowluma.selectedId, dsh: state.dsh.selectedId },
        services: {
          snowluma: { fingerprint: results[0].fingerprint, installations: state.snowluma.installations },
          dsh: { fingerprint: results[1].fingerprint, installations: state.dsh.installations }
        }
      };
      try { await writeJsonAtomic(cacheFile, cacheData); } catch (error) {
        push('snowluma', `检测缓存写入失败：${error?.message ?? error}`, 'warn');
      }
      emitAll('detection-complete', {
        durationMs,
        matches: state.snowluma.installations.filter((item) => item.valid).length + state.dsh.installations.filter((item) => item.valid).length,
        invalid: state.snowluma.installations.filter((item) => !item.valid).length + state.dsh.installations.filter((item) => !item.valid).length
      });
      // 检测完立即校正一次就绪状态，保证首屏就能看到“外部已在运行”的服务。
      try { await reconcileReadiness({ force: true }); } catch {}
      return snapshot();
    })().finally(() => { detectionPromise = null; });
    return detectionPromise;
  }

  function refresh() {
    if (!detectionPromise && state.snowluma.detection.status === 'pending') {
      void detectAll();
    } else {
      // 外部启动/停止的服务不经过本管理器，取快照前顺手校正（内部节流，不会反复探活）。
      void reconcileReadiness();
    }
    return snapshot();
  }


  /** 从 SnowLuma 的 http/ws 端点里取出 host:port，用于纯 TCP 探测。 */
  function endpointHostPort(rawUrl) {
    try {
      const url = new URL(String(rawUrl));
      const port = url.port ? Number(url.port) : (url.protocol === 'wss:' || url.protocol === 'https:' ? 443 : 80);
      return { host: url.hostname || '127.0.0.1', port };
    } catch {
      return null;
    }
  }

  /**
   * 纯 TCP 探测：只要端口上有人监听就认为「外部已有 SnowLuma 在跑」。
   * 比 HTTP 探测更宽松——SnowLuma 的 WebUI 端口会因占用而漂移（实测出现过 5099 → 5100），
   * 而 OneBot 端口可能只开 WebSocket、不响应普通 HTTP GET，只靠 HTTP 探测会误判成「没在运行」
   * 并再拉起第二个实例。
   */
  async function probeTcp(rawUrl) {
    const target = endpointHostPort(rawUrl);
    if (!target) return false;
    return new Promise((resolve) => {
      const socket = net.connect({ host: target.host, port: target.port });
      let settled = false;
      const done = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
      socket.setTimeout(1500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  async function probeUrl(url, headers = {}) {
    const base = String(url ?? '').replace(/\/+$/, '');
    if (!base) return false;
    try {
      const response = await fetch(`${base}/get_login_info`, { headers, signal: AbortSignal.timeout(2500) });
      // 401/403/426 也说明 HTTP 服务已经监听，只是鉴权或协议配置不匹配。
      return response.status >= 200 && response.status < 500;
    } catch {
      return false;
    }
  }

  function snowLumaHttpUrl() {
    return String(config?.snowluma?.httpUrl || 'http://127.0.0.1:3000');
  }

  /** OneBot 端点：用于纯 TCP 探测（SnowLuma 可能只开 WebSocket，不响应普通 HTTP GET）。 */
  function snowLumaWsUrl() {
    return String(config?.snowluma?.wsUrl || config?.snowluma?.httpUrl || 'ws://127.0.0.1:3001');
  }

  function snowLumaProbeHeaders() {
    return config?.snowluma?.accessToken ? { authorization: `Bearer ${config.snowluma.accessToken}` } : {};
  }

  function dshWebUrl() {
    return String(config?.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  }

  // dsh web 探活走根路径：401/403 同样说明服务已监听（/api/status 需要控制台令牌）。
  async function probeDshUrl() {
    try {
      const response = await fetch(dshWebUrl(), { signal: AbortSignal.timeout(2000) });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  // 就绪状态校正：SnowLuma / dsh 经常由用户、系统服务或另一个控制台在**本管理器之外**启动，
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
      const [snowAlive, dshAlive] = await Promise.all([
        probeUrl(snowLumaHttpUrl(), snowLumaProbeHeaders()).catch(() => false),
        probeDshUrl().catch(() => false)
      ]);
      for (const [service, alive] of [['snowluma', snowAlive], ['dsh', dshAlive]]) {
        const current = state[service];
        // 正在启动/安装时不覆盖；由启动流程自己收敛状态。
        if (['starting', 'installing'].includes(current.status)) continue;
        const child = processes[service];
        const managed = !!child && child.exitCode == null && !child.killed;
        // 托管进程还活着、只是 HTTP 尚未就绪：交给启动流程的等待逻辑，别判成失败。
        if (!alive && managed) continue;
        applyReadiness(service, alive, managed);
      }
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

  async function startSnowLuma({ waitMs = 35000 } = {}) {
    await detectAll();
    const current = state.snowluma;
    const httpHeaders = snowLumaProbeHeaders();
    // 先探测“外部已启动”的实例，避免控制台再次拉起第二个 SnowLuma。
    if (await probeUrl(snowLumaHttpUrl(), httpHeaders)) {
      setState('snowluma', { status: 'ready', running: true, ready: true, managed: false, lastError: '' });
      return publicSnapshot(current);
    }
    // HTTP 探测可能因为端口漂移或端点不响应 HTTP 而误判「没在运行」，进而重复拉起实例
    // （实测：WebUI 一度从 5099 漂到 5106，每重启一次桥接就多一个实例）。
    // 因此再按端点做一次纯 TCP 探测：有监听就复用、不再拉起第二个。
    // 但**不能因此判定 ready**：SnowLuma 会先占住 OneBot 端口、注入 QQ 成功后才真正提供 API，
    // 早先这里直接置 ready 会盖掉更有用的「OneBot 尚未就绪」提示。
    if (await probeTcp(snowLumaWsUrl())) {
      const reuseText =
        `SnowLuma 端点 ${snowLumaWsUrl()} 已有实例在监听，直接复用（不再拉起第二个实例）；` +
        `OneBot API（${snowLumaHttpUrl()}）尚未就绪：请在 SnowLuma 网页控制台完成进程注入` +
        '（由 SnowLuma 拉起并登录 QQ）与 OneBot 配置；WhaleBridge 将继续独立运行。';
      setState('snowluma', {
        status: 'start-timeout',
        running: true,
        ready: false,
        managed: false,
        lastError: reuseText
      });
      // 同一个状态每个检测周期都会走到这里：只在文案变化时记一条，
      // 否则终端会被同一句话刷屏（实测每 10 秒一条，把有用信息挤掉了）。
      const lastLog = state.snowluma.logs[state.snowluma.logs.length - 1];
      if (!lastLog || lastLog.text !== reuseText) push('snowluma', reuseText, 'warn');
      return publicSnapshot(current);
    }
    if (!current.installed) {
      setState('snowluma', { status: 'not-installed', running: false, ready: false, lastError: '未检测到 SnowLuma 文件' });
      push('snowluma', `未检测到 SnowLuma。可在控制台确认后从 ${SNOWLUMA_RELEASE_PAGE} 安装。`, 'warn');
      return publicSnapshot(current);
    }
    if (processes.snowluma && processes.snowluma.exitCode == null && !processes.snowluma.killed) {
      const tracked = processes.snowluma;
      const ready = await waitFor(
        'snowluma',
        () => probeUrl(snowLumaHttpUrl(), httpHeaders),
        waitMs,
        () => !!tracked && tracked.exitCode == null && !tracked.killed
      );
      const alive = !!tracked && tracked.exitCode == null && !tracked.killed;
      setState('snowluma', {
        status: ready ? 'ready' : alive ? 'start-timeout' : 'failed', running: alive, ready,
        lastError: ready ? '' : alive ? '进程仍在运行，但启动超时且 HTTP API 未就绪' : (state.snowluma.lastError || 'SnowLuma 进程已退出')
      });
      return publicSnapshot(current);
    }
    if (!current.launcherPath) {
      setState('snowluma', { status: 'failed', lastError: '已找到 SnowLuma 目录，但没有 launcher.bat' });
      push('snowluma', '已找到 SnowLuma 目录，但没有 launcher.bat，无法自动启动。', 'error');
      return publicSnapshot(current);
    }
    setState('snowluma', { status: 'starting', running: false, ready: false, lastError: '' });
    push('snowluma', `按启动优先级启动：${current.launcherPath}`);
    try {
      const child = spawnServiceProcess(current.launcherPath, [], {
        cwd: current.homeDir || repoRoot,
        env: process.env,
        // SnowLuma continues running after WhaleBridge exits. Give it independent NUL output handles
        // so it cannot inherit the worker's pipes and hit EPIPE when the bridge closes.
        captureOutput: captureSnowLumaOutput
      });
      attachProcess('snowluma', child);
      // 持久化记录启动来源，便于后续管理和诊断；WhaleBridge 退出时保留 SnowLuma，
      // 下一次启动会通过 OneBot 端点探测复用这个仍在运行的实例。
      writeSnowLumaMarker(repoRoot, { pid: child.pid, launcherPath: current.launcherPath, homeDir: current.homeDir || repoRoot });
      const ready = await waitFor(
        'snowluma',
        () => probeUrl(snowLumaHttpUrl(), httpHeaders),
        waitMs,
        () => processes.snowluma === child && child.exitCode == null && !child.killed
      );
      const alive = !!processes.snowluma && processes.snowluma.exitCode == null && !processes.snowluma.killed;
      const failed = !ready && !alive;
      // 超时并不等于启动失败：SnowLuma 进程可能仍在运行，但 OneBot HTTP API 尚未就绪。
      let timeoutHint = '';
      if (!ready && alive) {
        const apiUrl = snowLumaHttpUrl();
        timeoutHint = `SnowLuma 进程仍在运行，但 OneBot API（${apiUrl}）未就绪；请检查 OneBot 网关、QQ 登录和 API 地址配置`;
      }
      setState('snowluma', { status: ready ? 'ready' : failed ? 'failed' : 'start-timeout', running: ready || alive, ready, lastError: ready ? '' : failed ? (state.snowluma.lastError || 'SnowLuma 进程已退出') : timeoutHint });
      push('snowluma', ready ? 'SnowLuma 已就绪，可以连接 鲸桥。' : failed ? 'SnowLuma 进程已退出，WhaleBridge 将继续独立运行。' : `${timeoutHint}；WhaleBridge 将继续独立运行。`, ready ? 'info' : 'warn');
      return publicSnapshot(current);
    } catch (error) {
      setState('snowluma', { status: 'failed', running: false, ready: false, lastError: asText(error?.message ?? error) });
      push('snowluma', `启动失败：${error?.message ?? error}；WhaleBridge 将继续独立运行。`, 'error');
      return publicSnapshot(current);
    }
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

  async function persistSnowLumaConfig(homeDir, launcherPath) {
    const patch = { homeDir, launcherPath };
    try {
      const parsed = await readJsonAsync(configFile, {});
      parsed.snowluma = { ...(parsed.snowluma || {}), ...patch };
      await writeJsonAtomic(configFile, parsed);
      if (!config.snowluma || typeof config.snowluma !== 'object') config.snowluma = {};
      Object.assign(config.snowluma, patch);
      onConfigPatch({ snowluma: patch });
    } catch (error) {
      push('snowluma', `安装完成但写入 config.json 失败：${error?.message ?? error}`, 'warn');
    }
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
    if (!['snowluma', 'dsh'].includes(service)) throw new Error('不支持的本地服务');
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
    if (service === 'snowluma') {
      state.snowluma.homeDir = selected.homeDir;
      state.snowluma.launcherPath = selected.launcherPath;
      await persistSnowLumaConfig(selected.homeDir, selected.launcherPath);
    } else {
      state.dsh.homeDir = selected.homeDir;
      state.dsh.executable = selected.executable;
      await persistDshConfig(selected.homeDir, selected.executable);
    }
    cacheData.selected ||= {};
    cacheData.selected[service] = selected.id;
    try { await writeJsonAtomic(cacheFile, cacheData); } catch (error) { push(service, `选择记录保存失败：${error?.message ?? error}`, 'warn'); }
    setState(service, {});
    push(service, `已选择版本 ${selected.version}：${selected.entrypoint}`);
    return publicSnapshot(state[service]);
  }

  async function installSnowLuma() {
    if (installPromise) return installPromise;
    installPromise = (async () => {
      await detectAll();
      if (state.snowluma.installed) return publicSnapshot(state.snowluma);
      const installDir = path.resolve(repoRoot, 'SnowLuma');
      const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.whalebridge-snowluma-'));
      const zipFile = path.join(tempRoot, 'SnowLuma-release.zip');
      const extractDir = path.join(tempRoot, 'extract');
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        setState('snowluma', { status: 'installing', lastError: '', installDir });
        push('snowluma', '正在查询 GitHub SnowLuma 最新发布版…');
        const releaseResponse = await fetch(SNOWLUMA_RELEASE_API, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'whalebridge-local-service-manager' },
          signal: AbortSignal.timeout(20000)
        });
        if (!releaseResponse.ok) throw new Error(`GitHub 最新发布版查询失败：HTTP ${releaseResponse.status}`);
        const release = await releaseResponse.json();
        const asset = pickSnowLumaReleaseAsset(release);
        if (!asset) throw new Error('最新发布版没有可用的 Windows ZIP 安装包');
        const assetUrl = new URL(String(asset.browser_download_url));
        if (assetUrl.protocol !== 'https:' || !/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(assetUrl.hostname)) {
          throw new Error('SnowLuma 安装包下载地址不是受信任的 GitHub HTTPS 地址');
        }
        push('snowluma', `下载 ${asset.name}…`);
        const assetResponse = await fetch(assetUrl, {
          headers: { accept: 'application/octet-stream', 'user-agent': 'whalebridge-local-service-manager' },
          signal: AbortSignal.timeout(120000)
        });
        if (!assetResponse.ok || !assetResponse.body) throw new Error(`SnowLuma 安装包下载失败：HTTP ${assetResponse.status}`);
        const declared = Number(assetResponse.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_RELEASE_BYTES) throw new Error('SnowLuma 安装包超过 2GB，已拒绝下载');
        await pipeline(Readable.fromWeb(assetResponse.body), createWriteStream(zipFile));
        const actual = fs.statSync(zipFile).size;
        if (actual <= 0 || actual > MAX_RELEASE_BYTES) throw new Error('下载的安装包大小异常，已拒绝解压');
        push('snowluma', '正在解压安装包到 WhaleBridge/SnowLuma…');
        const command = `Expand-Archive -LiteralPath ${psQuote(zipFile)} -DestinationPath ${psQuote(extractDir)} -Force`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
          windowsHide: true,
          timeout: 180000,
          maxBuffer: 2 * 1024 * 1024
        });
        const launcher = findFile(extractDir, ['launcher.bat', 'start.bat', 'snowluma.bat']);
        if (!launcher) throw new Error('安装包中没有找到 launcher.bat，无法完成安装');
        const sourceHome = path.dirname(launcher);
        if (!isInside(extractDir, sourceHome) || isInside(sourceHome, installDir)) throw new Error('安装包目录校验失败');
        fs.mkdirSync(installDir, { recursive: true });
        fs.cpSync(sourceHome, installDir, { recursive: true, force: true });
        const installedLauncher = findFile(installDir, ['launcher.bat', 'start.bat', 'snowluma.bat']);
        if (!installedLauncher) throw new Error('安装文件复制后未找到 launcher.bat');
        await persistSnowLumaConfig(installDir, installedLauncher);
        await detectAll({ force: true });
        setState('snowluma', { status: 'stopped', installed: true, homeDir: installDir, launcherPath: installedLauncher, installDir, lastError: '' });
        push('snowluma', `SnowLuma 安装完成：${installDir}`);
        return publicSnapshot(state.snowluma);
      } catch (error) {
        setState('snowluma', { status: 'failed', installed: false, lastError: asText(error?.message ?? error) });
        push('snowluma', `安装失败：${error?.message ?? error}`, 'error');
        return publicSnapshot(state.snowluma);
      } finally {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
        installPromise = null;
      }
    })();
    return installPromise;
  }

  async function startDsh({ waitMs = 15000 } = {}) {
    await detectAll();
    const current = state.dsh;
    const probeDsh = probeDshUrl;
    // 已由用户、系统服务或另一控制台实例启动时只接管监控，不重复拉起进程。
    if (await probeDsh()) {
      setState('dsh', { status: 'ready', running: true, ready: true, managed: false, lastError: '' });
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
      setState('dsh', { status: ready ? 'ready' : failed ? 'failed' : 'start-timeout', running: ready || alive, ready, lastError: ready ? '' : failed ? (state.dsh.lastError || 'dsh 进程已退出') : 'dsh 进程仍在运行，但启动超时且 Web API 未响应' });
      push('dsh', ready ? 'dsh web 服务已就绪。' : failed ? 'dsh 进程已退出，请查看监控终端。' : 'dsh 已启动但尚未探测到 Web API，请查看监控终端。', ready ? 'info' : 'warn');
      return publicSnapshot(current);
    } catch (error) {
      setState('dsh', { status: 'failed', running: false, ready: false, lastError: asText(error?.message ?? error) });
      push('dsh', `启动失败：${error?.message ?? error}`, 'error');
      return publicSnapshot(current);
    }
  }

  function subscribe(service, send) {
    const item = { service: service === 'snowluma' || service === 'dsh' ? service : 'all', send };
    listeners.add(item);
    if (item.service === 'all') {
      send({ service: 'all', event: 'snapshot', snapshot: snapshot() });
    } else {
      send({ service: item.service, event: 'snapshot', snapshot: publicSnapshot(state[item.service]) });
    }
    return () => listeners.delete(item);
  }

  void detectAll().catch((error) => {
    for (const service of ['snowluma', 'dsh']) {
      setState(service, { status: 'failed', lastError: asText(error?.message ?? error), detection: { ...state[service].detection, status: 'failed' } });
    }
  });
  // 控制台面板靠 SSE 推送、没有轮询，所以由管理器自身周期性校正就绪状态，
  // 这样用户在外部启停 SnowLuma/dsh 时面板也能跟上（unref 不影响进程退出）。
  const readinessTimer = setInterval(() => { void reconcileReadiness(); }, 10000);
  readinessTimer.unref?.();
  return {
    snapshot,
    refresh,
    detectAll,
    reconcileReadiness,
    subscribe,
    detectDsh: async () => (await detectDshInstallations()).installations,
    findSnowLuma: async () => (await detectSnowLuma()).installations,
    selectSnowLuma: (choice) => selectInstallation('snowluma', choice),
    selectDsh: (choice) => selectInstallation('dsh', choice),
    installSnowLuma,
    startSnowLuma,
    // 「退出 QQ 以便 SnowLuma 重新注入」：只结束 QQ 顶层进程及其子树，绝不按名字模糊查杀其它进程。
    listQqProcesses: async () => selectTopLevelQqProcesses(await listWindowsProcesses()),
    quitQqProcesses: () =>
      quitQqProcesses({
        listProcesses: listWindowsProcesses,
        killer: (pid) => execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 15000 })
      }),
    // 「本应用此前启动、现在仍在运行的 SnowLuma」——跨应用重启也能收掉。
    stopRecordedSnowLuma: () =>
      stopRecordedSnowLuma({
        file: snowLumaMarkerFile(repoRoot),
        clearMarker: () => clearSnowLumaMarker(repoRoot),
        identify: async (pid) => {
          const rows = await listWindowsProcesses();
          const hit = rows.find((row) => Number(row.pid) === Number(pid));
          return hit ? String(hit.name) : null;
        },
        killer: (pid) => execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 15000 })
      }),
    stopSnowLuma: () => stopService('snowluma'),
    startDsh,
    stopDsh: () => stopService('dsh'),
    getSnowLumaReleasePage: () => SNOWLUMA_RELEASE_PAGE,
    getDshInstallHint: () => DSH_INSTALL_HINT
  };
}
