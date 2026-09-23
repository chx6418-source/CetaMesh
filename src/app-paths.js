import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sea 经 process.getBuiltinModule 读取：ESM 源码、esbuild 打包产物和 SEA 三种运行方式下
// 都不需要 import.meta / require 才能拿到它。Node 22.3+ 起 getBuiltinModule 可用。
const nodeSea = process.getBuiltinModule?.('node:sea') ?? null;

/** 当前进程是否运行在 Node SEA 单文件可执行产物中。 */
export function isPackagedRuntime() {
  try {
    return nodeSea?.isSea?.() === true;
  } catch {
    return false;
  }
}

// SEA 中 import.meta.url 指向 exe 自身（打包器改写后也可能取不到），因此这里必须容错：
// 取不到模块目录时退回可执行文件目录，绝不在模块加载期抛出。
const MODULE_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return path.dirname(process.execPath);
  }
})();
export const SOURCE_ROOT = path.resolve(MODULE_DIR, '..');

function resolveRoot(value, fallback, cwd) {
  const text = String(value ?? '').trim();
  return text ? path.resolve(cwd, text) : path.resolve(fallback);
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 解析 `--data-dir <path>` / `--data-dir=<path>`，未出现时返回空串。 */
export function parseDataDirArg(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 2; i < args.length; i += 1) {
    const arg = String(args[i] ?? '');
    if (arg === '--data-dir') return String(args[i + 1] ?? '').trim();
    if (arg.startsWith('--data-dir=')) return arg.slice('--data-dir='.length).trim();
  }
  return '';
}

/**
 * 打包运行（SEA exe）的默认根目录。
 * - resourceRoot：exe 同目录的 resources/，不存在时退回 exe 所在目录；
 * - dataRoot：exe 同目录存在 portable.flag 时用 exe 同目录的 data/（便携模式），
 *   否则用 %LOCALAPPDATA%\WhaleBridge。安装目录可能只读，绝不默认写回 exe 目录。
 */
export function packagedRoots({ env = process.env, execPath = process.execPath } = {}) {
  const exeDir = path.dirname(path.resolve(execPath));
  const bundledResources = path.join(exeDir, 'resources');
  const portable = fs.existsSync(path.join(exeDir, 'portable.flag'));
  const localAppData =
    String(env.LOCALAPPDATA ?? '').trim() || path.join(os.homedir(), 'AppData', 'Local');
  return {
    exeDir,
    portable,
    resourceRoot: isDirectory(bundledResources) ? bundledResources : exeDir,
    dataRoot: portable ? path.join(exeDir, 'data') : path.join(localAppData, 'WhaleBridge')
  };
}

/**
 * Resolve all application paths from two explicit roots:
 * - resourceRoot: immutable files shipped with WhaleBridge (public/assets/tools/roles)
 * - dataRoot: mutable per-user files (config/state/roles/logs/caches)
 *
 * Source mode (no SEA, no overrides) keeps both roots at the repository root, preserving the
 * existing layout byte-for-byte. Packaged mode (SEA exe) defaults to the resources directory
 * next to the executable and a per-user writable data directory.
 *
 * Priority: `--data-dir` > WHALEBRIDGE_DATA_DIR > portable.flag > %LOCALAPPDATA%\WhaleBridge.
 */
export function createAppPaths(env = process.env, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const packaged = options.packaged ?? isPackagedRuntime();
  const execPath = path.resolve(options.execPath ?? process.execPath);

  let defaults;
  if (packaged) {
    defaults = packagedRoots({ env, execPath });
  } else {
    const sourceRoot = path.resolve(options.sourceRoot ?? SOURCE_ROOT);
    defaults = { resourceRoot: sourceRoot, dataRoot: sourceRoot, exeDir: path.dirname(execPath), portable: false };
  }

  const argvDataDir = options.argv === undefined ? parseDataDirArg() : parseDataDirArg(options.argv);
  const resourceRoot = resolveRoot(env.WHALEBRIDGE_RESOURCE_DIR, defaults.resourceRoot, cwd);
  const dataRoot = resolveRoot(argvDataDir || env.WHALEBRIDGE_DATA_DIR, defaults.dataRoot, cwd);
  const stateDir = path.join(dataRoot, 'state');

  return Object.freeze({
    packaged,
    portable: defaults.portable,
    executableDir: defaults.exeDir,
    sourceRoot: path.resolve(options.sourceRoot ?? SOURCE_ROOT),
    resourceRoot,
    dataRoot,
    configFile: path.join(dataRoot, 'config.json'),
    stateDir,
    rolesDir: path.join(dataRoot, 'roles'),
    bundledRolesDir: path.join(resourceRoot, 'roles'),
    publicDir: path.join(resourceRoot, 'public'),
    assetsDir: path.join(resourceRoot, 'assets'),
    toolsDir: path.join(resourceRoot, 'tools'),
    errorLogFile: path.join(dataRoot, 'bridge.err.log'),
    fileSendCacheDir: path.join(stateDir, 'file-send-cache'),
    selfTestDir: path.join(stateDir, 'self-test')
  });
}

export const APP_PATHS = createAppPaths();

export function listRoleNames(paths = APP_PATHS) {
  const names = new Set();
  for (const dir of new Set([paths.bundledRolesDir, paths.rolesDir])) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.md') && file !== 'README.md') names.add(file.slice(0, -3));
      }
    } catch {}
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** User roles override bundled roles with the same name. */
export function resolveRoleFile(name, paths = APP_PATHS) {
  const fileName = `${name}.md`;
  const userFile = path.join(paths.rolesDir, fileName);
  if (fs.existsSync(userFile)) return userFile;
  const bundledFile = path.join(paths.bundledRolesDir, fileName);
  return fs.existsSync(bundledFile) ? bundledFile : null;
}
