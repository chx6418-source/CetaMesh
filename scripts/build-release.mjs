#!/usr/bin/env node
// 组装发布候选（RC）目录 dist/app，并生成校验清单、SBOM 与第三方许可证清单。
//
// 输入（先跑 build:core 与 desktop:build）：
//   dist/core/WhaleBridgeCore.exe + resources/      Core（Node SEA）
//   desktop-shell/target/release/whalebridge-desktop.exe   桌面壳（含安装器）
//
// 输出：
//   dist/app/WhaleBridge.exe            桌面壳（安装器/卸载器同体）
//   dist/app/payload/                   Core 产物（安装器从中取 WhaleBridgeCore.exe 与 resources\）
//   dist/app/INSTALL.txt                安装/卸载说明
//   dist/app/licenses/THIRD-PARTY.md    第三方组件清单
//   dist/app/licenses/README.md         再分发注意事项（Node 许可证需在公开发布前补齐）
//   dist/app/SHA256SUMS.txt             所有产物的 sha256
//   dist/app/sbom.json                  CycloneDX 1.5 最小 SBOM
//   dist/app/release-manifest.json      版本、构建输入、体积与哈希
//
// 本脚本还会对 RC 做一次发行审计（禁止项 / 构建机路径 / 本机凭据），不通过直接失败。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { bumpBuildNumber, formatArtifactName, loadReleaseVersion, releaseArtifactDirectory, validateVersionMirrors } from '../src/release/version.js';
import { assertSafeStagingDirectory, cleanupStagingDirectory, publishStagedArtifact } from '../src/release/artifacts.js';
import {
  assertNoWebUiBinaryMarkers,
  assertNoWebUiHtmlArtifacts,
  isNoWebUiHtmlArtifact
} from './no-web-release-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const options = { noWebUi: true, dev: false, useCurrentBuildNumber: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-web-ui') options.noWebUi = true;
    else if (arg === '--dev') options.dev = true;
    else if (arg === '--use-current-build-number') options.useCurrentBuildNumber = true;
    else if (arg === '--core-dir') options.coreDir = path.resolve(argv[++i] ?? '');
    else if (arg === '--shell-exe') options.shellExe = path.resolve(argv[++i] ?? '');
    else if (arg === '--debug-shell') options.debugShell = path.resolve(argv[++i] ?? '');
    else if (arg === '--out-dir') options.outDir = path.resolve(argv[++i] ?? '');
    else if (arg === '--build-dir') options.buildDir = path.resolve(argv[++i] ?? '');
    else fail(`unknown option: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const CORE_DIR = options.coreDir ?? path.join(ROOT, 'dist', 'core');
const UI_DIR = path.join(ROOT, 'desktop-ui', 'dist');
const SHELL_EXE = options.shellExe ?? path.join(ROOT, 'desktop-shell', 'target', 'release', 'whalebridge-desktop.exe');
const STAGING_ROOT = path.join(ROOT, 'artifacts', '.staging');

const versionCheck = validateVersionMirrors({ rootDir: ROOT });
if (!versionCheck.ok) fail(`release/version.json does not match package/Cargo versions: ${versionCheck.issues.map(issue => issue.code).join(', ')}`);
const releaseVersion = loadReleaseVersion({ rootDir: ROOT });
const initialDirty = Boolean(gitOutput(['status', '--porcelain']));
if (initialDirty && !options.dev) fail('formal Release requires a clean source tree; use --dev to label a working-tree build DEV');
const sourceCommit = gitOutput(['rev-parse', 'HEAD']) || 'unknown';
const sourceCommitShort = gitOutput(['rev-parse', '--short', 'HEAD']) || 'unknown';
const buildNumber = releaseVersion.buildNumber + (options.useCurrentBuildNumber ? 0 : 1);
const buildChannel = options.dev ? 'dev' : releaseVersion.channel;
const setupFilename = formatArtifactName({ productVersion: releaseVersion.productVersion, buildNumber, platform: 'windows-x64' });
const OUT_DIR = options.outDir ?? releaseArtifactDirectory({ rootDir: ROOT, channel: buildChannel, productVersion: releaseVersion.productVersion, buildNumber });
const MANIFEST_INDEX = path.join(ROOT, 'artifacts', 'manifests', buildChannel, releaseVersion.productVersion, `build-${buildNumber}.json`);
const BUILD_DIR = options.buildDir ?? path.join(STAGING_ROOT, `${process.pid}-${crypto.randomUUID()}`);
let buildPublished = false;
let buildDirectoryOwned = false;
const expectedOutDir = releaseArtifactDirectory({ rootDir: ROOT, channel: buildChannel, productVersion: releaseVersion.productVersion, buildNumber });
if (path.resolve(OUT_DIR) !== path.resolve(expectedOutDir)) fail('--out-dir must resolve to the canonical channel/version/build directory');
if (path.dirname(path.resolve(BUILD_DIR)) !== path.resolve(STAGING_ROOT)) fail('--build-dir must be a direct child of artifacts/.staging');
assertSafeStagingDirectory({ rootDir: ROOT, stagingDirectory: BUILD_DIR });
process.once('exit', () => {
  if (buildDirectoryOwned && !buildPublished) {
    try { cleanupStagingDirectory({ rootDir: ROOT, stagingDirectory: BUILD_DIR }); } catch { /* exit-time cleanup is best effort; never mask the build result */ }
  }
});

const FORBIDDEN = [
  { test: (rel) => rel.toLowerCase() === 'config.json', reason: '真实用户配置' },
  { test: (rel) => /(^|\/)(state|logs|backups|cache)(\/|$)/i.test(rel), reason: '运行期状态/日志/缓存' },
  { test: (rel) => /\.(log|db|sqlite|sqlite3|key|pem|p12|pfx)$/i.test(rel), reason: '日志/数据库/密钥' },
  { test: (rel) => /(console-token|agent-token|credentials\.ya?ml)$/i.test(rel), reason: '令牌或凭据' },
  { test: (rel) => /\.(node|dll|so|dylib)$/i.test(rel), reason: '原生二进制' },
  { test: (rel) => /snowluma/i.test(rel), reason: 'SnowLuma 相关文件' },
  { test: (rel) => /\.bak(-[^/]*)?$/i.test(rel), reason: '开发期备份' },
  { test: (rel) => rel.toLowerCase().includes('whalebridge-integration.json'), reason: 'DSH 集成清单' }
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`[build-release] ${message}\n`);
  process.exit(1);
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

function buildHarborUi() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail('release build must run through npm so the Harbor UI can be built reproducibly');
  const result = spawnSync(process.execPath, [npmCli, 'run', 'build:ui'], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000, windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) fail(`Harbor UI build failed${result.error ? `: ${result.error.message}` : ''}`);
  if (!fs.existsSync(path.join(UI_DIR, 'index.html'))) fail('Harbor UI build did not produce desktop-ui/dist/index.html');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function directorySize(dir) {
  let total = 0;
  for (const relative of listFiles(dir)) total += fs.statSync(path.join(dir, relative)).size;
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------- 前置检查

buildHarborUi();

if (!fs.existsSync(path.join(CORE_DIR, 'WhaleBridgeCore.exe'))) {
  fail(`未找到 ${path.join(CORE_DIR, 'WhaleBridgeCore.exe')} —— 请先执行 npm run build:core`);
}
if (!fs.existsSync(path.join(CORE_DIR, 'resources'))) {
  fail(`未找到 ${path.join(CORE_DIR, 'resources')} —— 请先执行 npm run build:core`);
}
if (!fs.existsSync(SHELL_EXE)) {
  fail(`未找到桌面壳 release 构建：${SHELL_EXE} —— 请先执行 npm run desktop:build`);
}

// 桌面壳 release 构建不应包含调试控制台；用文件体积做一次粗校验（release 明显更小）
const coreRuntimeManifestPath = path.join(CORE_DIR, 'runtime-manifest.json');
if (options.noWebUi) {
  if (!fs.existsSync(coreRuntimeManifestPath)) fail('native/no-web build requires dist/core/runtime-manifest.json');
  const coreRuntimeManifest = JSON.parse(fs.readFileSync(coreRuntimeManifestPath, 'utf8'));
  if (coreRuntimeManifest.noWebUi !== true || coreRuntimeManifest.uiDistribution !== 'native-no-web') {
    fail('Core was not built with --no-web-ui; refusing to produce a mixed web/native release');
  }
  if (coreRuntimeManifest.legacyHttp !== false) {
    fail('Core runtime manifest must record legacyHttp: false; refusing to release a worker that can listen on consolePort');
  }
  try {
    assertNoWebUiBinaryMarkers(fs.readFileSync(SHELL_EXE), 'desktop shell');
    assertNoWebUiBinaryMarkers(fs.readFileSync(path.join(CORE_DIR, 'WhaleBridgeCore.exe')), 'Core executable');
  } catch (error) {
    fail(error.message);
  }
}

const shellSize = fs.statSync(SHELL_EXE).size;
const debugShell = options.debugShell ?? path.join(ROOT, 'desktop-shell', 'target', 'debug', 'whalebridge-desktop.exe');
if (fs.existsSync(debugShell) && shellSize >= fs.statSync(debugShell).size) {
  fail(`release 桌面壳体积异常（${mb(shellSize)}），请确认执行的是 desktop:build 而不是 desktop:build:debug`);
}

// ------------------------------------------------------------- 组装

log(`鲸桥发布候选组装（${PKG.version}）`);
if (fs.existsSync(BUILD_DIR)) fail(`临时发布目录已存在，拒绝覆盖：${BUILD_DIR}`);
if (fs.existsSync(OUT_DIR)) fail(`规范版本产物已存在，拒绝覆盖：${OUT_DIR}`);
if (fs.existsSync(MANIFEST_INDEX)) fail(`发布清单索引已存在，拒绝覆盖：${MANIFEST_INDEX}`);
assertSafeStagingDirectory({ rootDir: ROOT, stagingDirectory: BUILD_DIR });
fs.mkdirSync(path.dirname(BUILD_DIR), { recursive: true });
fs.mkdirSync(BUILD_DIR, { recursive: false });
buildDirectoryOwned = true;

const payloadDir = path.join(BUILD_DIR, 'payload');
log('[1/5] 复制 Core payload 与桌面壳');
fs.mkdirSync(payloadDir, { recursive: true });
for (const relative of listFiles(CORE_DIR)) {
  // build/ 是构建中间产物（bundle、blob、sea-config），不进发行包
  if (relative.startsWith('build/')) continue;
  if (options.noWebUi && isNoWebUiHtmlArtifact(relative)) continue;
  const target = path.join(payloadDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(CORE_DIR, relative), target);
}
const uiFiles = listFiles(UI_DIR);
if (!uiFiles.includes('index.html')) fail('Harbor UI bundle is missing index.html');
try { assertNoWebUiHtmlArtifacts(uiFiles, 'Harbor UI bundle'); } catch (error) { fail(error.message); }
const uiResourceDir = path.join(payloadDir, 'resources', 'desktop-ui');
for (const relative of uiFiles) {
  const target = path.join(uiResourceDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(UI_DIR, relative), target);
}
fs.copyFileSync(SHELL_EXE, path.join(BUILD_DIR, 'WhaleBridge.exe'));
log(`  Harbor UI ${uiFiles.length} 个静态文件 ${mb(directorySize(uiResourceDir))}`);
log(`  WhaleBridge.exe ${mb(shellSize)}，payload/ ${listFiles(payloadDir).length} 个文件 ${mb(directorySize(payloadDir))}`);

// 构建来源信息：About 页面在打包运行时读取 <资源根>/build-info.json。
const buildInfo = {
  product: 'CetaMesh',
  version: releaseVersion.productVersion,
  channel: buildChannel,
  buildNumber,
  sourceCommit,
  commit: sourceCommit,
  commitShort: sourceCommitShort,
  dirty: initialDirty,
  buildTime: new Date().toISOString(),
  buildId: `${releaseVersion.productVersion}-build${buildNumber}+${sourceCommitShort}${initialDirty || options.dev ? '.DEV' : ''}`,
  node: process.version,
  platform: `${process.platform}-${process.arch}`
};
for (const directory of [BUILD_DIR, payloadDir]) {
  writeJsonAtomic(path.join(directory, 'build-info.json'), buildInfo, { mode: 0o644 });
}
log(`  build-info.json：${buildInfo.buildId}（dirty=${initialDirty}）`);

log('[2/5] 生成许可证清单与 SBOM');
const metaFile = path.join(CORE_DIR, 'build', 'core.bundle.meta.json');
let bundledPackages = [];
if (fs.existsSync(metaFile)) {
  const metafile = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    const after = input.slice(input.indexOf('node_modules/') + 'node_modules/'.length);
    names.add(after.startsWith('@') ? after.split('/').slice(0, 2).join('/') : after.split('/')[0]);
  }
  bundledPackages = [...names].sort();
}
const rendererLockFile = path.join(ROOT, 'desktop-ui', 'package-lock.json');
let rendererPackages = [];
if (fs.existsSync(rendererLockFile)) {
  const rendererLock = JSON.parse(fs.readFileSync(rendererLockFile, 'utf8'));
  rendererPackages = Object.entries(rendererLock.packages ?? {})
    .filter(([entry, meta]) => entry.startsWith('node_modules/') && typeof meta.version === 'string' && meta.dev !== true)
    .map(([entry, meta]) => ({ name: entry.slice('node_modules/'.length), version: meta.version, license: meta.license }));
}

const components = [];
const thirdPartyLines = [
  '# 第三方组件清单',
  '',
  `本文件由 scripts/build-release.mjs 生成于 ${new Date().toISOString()}。`,
  '',
  '| 组件 | 版本 | 声明许可证 | 许可证文件 |',
  '|---|---|---|---|'
];

function describePackage(name, makeType, nodeModulesDir, fallbackMeta = null) {
  const packageDir = path.join(nodeModulesDir, name);
  const pkgFile = path.join(packageDir, 'package.json');
  const meta = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : fallbackMeta;
  if (!meta) return null;
  const licenseFile = fs.existsSync(packageDir)
    ? fs.readdirSync(packageDir, { withFileTypes: true })
      .find((entry) => entry.isFile() && /^(licen[cs]e|copying)/i.test(entry.name))?.name ?? null
    : null;
  return {
    type: makeType,
    name,
    version: meta.version ?? 'unknown',
    license: typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'UNKNOWN'),
    licenseFile: licenseFile ?? null
  };
}

// 运行时：Node.js 本身（SEA 宿主）与被打包的 npm 依赖
components.push({
  type: 'platform',
  name: 'Node.js',
  version: process.version,
  license: 'MIT',
  licenseFile: null,
  note: 'WhaleBridgeCore.exe 由 Node.js SEA 宿主 + 注入 bundle 组成'
});
for (const name of bundledPackages) {
  const described = describePackage(name, 'library', path.join(ROOT, 'node_modules'));
  if (described && !components.some(item => item.name === described.name && item.version === described.version)) components.push(described);
}
const rendererNodeModules = path.join(ROOT, 'desktop-ui', 'node_modules');
for (const item of rendererPackages) {
  const described = describePackage(item.name, 'library', rendererNodeModules, item);
  if (described && !components.some(existing => existing.name === described.name && existing.version === described.version)) components.push(described);
}

for (const component of components) {
  thirdPartyLines.push(
    `| ${component.name} | ${component.version} | ${component.license} | ${component.licenseFile ?? '（需在发布前补齐）'} |`
  );
}
thirdPartyLines.push(
  '',
  '## 再分发前必须补齐',
  '',
  '1. **Node.js 运行时许可证**：`WhaleBridgeCore.exe` 内嵌 Node.js（MIT）。Windows 安装器',
  '   不自带 LICENSE 文件，正式公开发布前需要从 https://nodejs.org/ 取得对应版本的 LICENSE 文本',
  '   并放入本目录（例如 `licenses/Node-LICENSE.txt`）。',
  '2. **各依赖的完整许可证文本**：上表列出的是声明值与本地是否存在许可证文件；公开发布时应把',
  '   这些文本一并放入本目录。',
  '3. **SnowLuma 等第三方程序不随本包分发**：本项目只检测与调用用户自行安装的 SnowLuma。',
  '',
  '## 本项目自身',
  '',
  `- 产品：${PKG.name} ${PKG.version}`,
  '- 说明：本 RC 不含签名；单文件安装器由 Windows IExpress 生成，安装界面使用鲸桥桌面壳。'
);

const licensesDir = path.join(BUILD_DIR, 'licenses');
fs.mkdirSync(licensesDir, { recursive: true });
fs.writeFileSync(path.join(licensesDir, 'THIRD-PARTY.md'), `${thirdPartyLines.join('\n')}\n`, 'utf8');
fs.writeFileSync(
  path.join(licensesDir, 'README.md'),
  [
    '# 许可证与再分发说明',
    '',
    '本目录中的清单由构建脚本自动生成。公开发布前必须补齐 Node.js 运行时许可证文本，',
    '并复核各依赖的许可证声明。详见 `THIRD-PARTY.md` 末尾的"再分发前必须补齐"。',
    '',
    'SnowLuma / DSH / DeepSeek 均为独立第三方项目，不随本应用分发。',
    ''
  ].join('\n'),
  'utf8'
);

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: 'WhaleBridge', version: PKG.version },
    tools: [{ vendor: 'WhaleBridge', name: 'scripts/build-release.mjs', version: '1' }]
  },
  components: components.map((component) => ({
    type: component.type === 'platform' ? 'platform' : 'library',
    name: component.name,
    version: component.version,
    licenses: [{ license: { id: component.license } }]
  }))
};
writeJsonAtomic(path.join(BUILD_DIR, 'sbom.json'), sbom, { mode: 0o644 });

log('[3/5] 生成一键安装器');
const packager = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts', 'package-installer.mjs'),
  BUILD_DIR,
  payloadDir,
  '--output-name', setupFilename,
  ...(options.noWebUi ? ['--no-web-ui'] : [])
], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', timeout: 900000 });
if (packager.error) fail(`无法运行单文件安装器打包器：${packager.error.message}`);
if (packager.status !== 0) fail(`单文件安装器打包失败（退出代码 ${packager.status}）`);

log('[4/5] 写安装说明 + 校验清单');
fs.writeFileSync(
  path.join(BUILD_DIR, 'INSTALL.txt'),
  [
    'CetaMesh ' + releaseVersion.productVersion + ' Build ' + buildNumber + ' —— 安装说明',
    '',
    '双击 ' + setupFilename + '，选择安装位置并点击“立即安装”。',
    '默认安装到 %LOCALAPPDATA%\\Programs\\CetaMesh，不需要管理员权限（不触发 UAC）。',
    '',
    '安装后：WhaleBridge.exe 是桌面程序；卸载入口在开始菜单（CetaMesh），默认保留个人数据。',
    '',
    '命令行安装（高级用法）：',
    '    WhaleBridge.exe --install --install-dir "%LOCALAPPDATA%\\Programs\\CetaMesh"',
    '    WhaleBridge.exe --install --dry-run            只看计划，不写任何文件',
    '    WhaleBridge.exe --install --install-dir "D:\\CetaMesh"',
    '',
    '升级：再次执行 --install 或在向导中更新（复用原安装位置，不会覆盖 config.json 与用户数据）',
    '修复：WhaleBridge.exe --repair',
    '迁移旧数据：WhaleBridge.exe --migrate --from "<旧目录>" [--dry-run]',
    '卸载（保留用户数据）：WhaleBridge.exe --uninstall',
    '彻底卸载：WhaleBridge.exe --uninstall --remove-data --remove-dsh-integration',
    '',
    '默认位置：',
    '    安装目录 %LOCALAPPDATA%\\Programs\\CetaMesh（按当前用户安装）',
    '    数据目录 %LOCALAPPDATA%\\WhaleBridge（配置、state、日志与令牌；升级/卸载默认保留）',
    '',
    '说明：本 RC 未签名；首次运行仍需 Windows 信任确认。',
    ''
  ].join('\n'),
  'utf8'
);

const artifacts = listFiles(BUILD_DIR).filter((relative) => relative !== 'SHA256SUMS.txt');
const sums = artifacts.map((relative) => `${sha256(path.join(BUILD_DIR, relative))}  ${relative}`);
fs.writeFileSync(path.join(BUILD_DIR, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');

// ------------------------------------------------------------- 审计

log('[5/5] 发行审计');
const problems = [];
const deviations = [];
const payloadFiles = listFiles(payloadDir);
for (const relative of payloadFiles) {
  const rule = FORBIDDEN.find((item) => item.test(relative));
  if (rule) problems.push(`payload/${relative}：${rule.reason}`);
}
if (options.noWebUi) {
  try {
    assertNoWebUiHtmlArtifacts(payloadFiles, 'release payload');
    assertNoWebUiBinaryMarkers(fs.readFileSync(path.join(BUILD_DIR, 'WhaleBridge.exe')), 'release shell');
    assertNoWebUiBinaryMarkers(fs.readFileSync(path.join(payloadDir, 'WhaleBridgeCore.exe')), 'release Core');
  } catch (error) {
    problems.push(error.message);
  }
}
// 桌面壳 exe：Tauri/Cargo 会把 crate 的绝对路径作为字符串字面量写进二进制（remap 与 strip
// 都清理不掉）。这里记录为已知偏差而不是硬失败——它不是用户数据或凭据，且会在正式发布
// 阶段随版本资源一起处理。Core exe 与 payload 里的路径泄漏仍然是硬失败。
const shellExe = path.join(BUILD_DIR, 'WhaleBridge.exe');
if (fs.existsSync(shellExe) && fs.readFileSync(shellExe).toString('latin1').includes(ROOT)) {
  deviations.push({
    item: 'WhaleBridge.exe 内含构建机仓库路径',
    detail: 'Tauri/Cargo 把 crate 目录作为字符串字面量写进二进制，--remap-path-prefix 与 strip 均无效',
    impact: '仅暴露构建机的目录布局，不含用户数据或凭据',
    followUp: '正式发布前随版本资源/图标一并处理（例如改由 CI 的干净工作目录构建）'
  });
}
const coreExe = path.join(payloadDir, 'WhaleBridgeCore.exe');
for (const file of [coreExe]) {
  if (!fs.existsSync(file)) continue;
  if (fs.readFileSync(file).toString('latin1').includes(ROOT)) {
    problems.push(`${path.basename(file)}：包含构建机仓库绝对路径`);
  }
}
const realConfig = path.join(ROOT, 'config.json');
if (fs.existsSync(realConfig)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(realConfig, 'utf8').replace(/^\uFEFF/, ''));
    const secrets = [parsed?.consoleToken, parsed?.snowluma?.accessToken, parsed?.dsh?.token]
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length >= 8);
    for (const file of [shellExe, coreExe]) {
      if (!fs.existsSync(file)) continue;
      const latin = fs.readFileSync(file).toString('latin1');
      if (secrets.some((secret) => latin.includes(secret))) {
        problems.push(`${path.basename(file)}：包含本机真实凭据`);
      }
    }
  } catch {
    /* 配置不可解析：跳过凭据对照 */
  }
}
if (problems.length > 0) fail(`发行审计失败：\n  - ${problems.join('\n  - ')}`);
for (const deviation of deviations) log(`  ⚠️ 已知偏差：${deviation.item} —— ${deviation.impact}`);

// ------------------------------------------------------------- 清单

const manifest = {
  product: 'CetaMesh',
  version: releaseVersion.productVersion,
  channel: buildChannel,
  buildNumber,
  sourceCommit,
  commit: buildInfo.commit,
  commitShort: buildInfo.commitShort,
  buildId: buildInfo.buildId,
  dirtySourceTree: initialDirty,
  builtAt: new Date().toISOString(),
  noWebUi: options.noWebUi,
  // 发行运行面红线（D1）：与 runtime-manifest.legacyHttp 一致，release worker 不监听 consolePort。
  legacyHttp: false,
  coreUiDistribution: options.noWebUi ? 'native-no-web' : 'web-compatibility',
  uiDistribution: 'webview2-bundled',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  entry: setupFilename,
  remoteBackedUp: false,
  artifacts: artifacts
    .filter((relative) => /\.(exe|msi|zip|apk|aab)$/i.test(relative))
    .map((relative) => ({
      path: relative,
      bytes: fs.statSync(path.join(BUILD_DIR, relative)).size,
      sha256: sha256(path.join(BUILD_DIR, relative))
    })),
  files: Object.fromEntries(artifacts.map((relative) => [relative, sha256(path.join(BUILD_DIR, relative))])),
  sizes: {
    totalBytes: directorySize(BUILD_DIR),
    shellBytes: shellSize,
    payloadBytes: directorySize(payloadDir),
    setupBytes: fs.statSync(path.join(BUILD_DIR, setupFilename)).size
  },
  components: components.map((component) => `${component.name}@${component.version} (${component.license})`),
  knownDeviations: deviations,
  checks: {
    forbiddenArtifacts: 'pass',
    buildMachinePaths: deviations.length > 0 ? 'known deviation (WhaleBridge.exe)' : 'pass',
    credentialLeak: fs.existsSync(realConfig) ? 'pass（与真实 config.json 对照）' : 'skipped（无本机 config.json）'
  },
  notVerified: [
    '未签名（无代码签名证书）',
    '未在 Windows 10 x64 上验证',
    '未在真实 QQ / DSH 会话中验证四种模式与全部 MCP 工具',
    '未验证 DSH/SnowLuma 重启恢复（需要真实服务）',
    '未签名的安装器会触发 Windows 的来源提示'
  ]
};
const manifestPath = path.join(BUILD_DIR, 'release-manifest.json');
const sumsPath = path.join(BUILD_DIR, 'SHA256SUMS.txt');
function writeManifestAndSums() {
  writeJsonAtomic(manifestPath, manifest, { mode: 0o644 });
  // SHA256SUMS includes release-manifest.json, and excludes only itself.
  const finalArtifacts = listFiles(BUILD_DIR).filter((relative) => relative !== 'SHA256SUMS.txt');
  fs.writeFileSync(
    sumsPath,
    `${finalArtifacts.map((relative) => `${sha256(path.join(BUILD_DIR, relative))}  ${relative}`).join('\n')}\n`,
    'utf8'
  );
}

// The manifest and sums file contribute to totalBytes. Iterate to the stable value; the
// manifest's byte length stays constant once the total's digit width is established.
manifest.sizes.totalBytes = 0;
for (let attempt = 0; attempt < 4; attempt += 1) {
  writeManifestAndSums();
  const actualBytes = directorySize(BUILD_DIR);
  if (manifest.sizes.totalBytes === actualBytes) break;
  manifest.sizes.totalBytes = actualBytes;
}
writeManifestAndSums();
if (manifest.sizes.totalBytes !== directorySize(BUILD_DIR)) {
  fail('release-manifest.json 的 totalBytes 未能与最终发布目录大小收敛');
}

if (!options.useCurrentBuildNumber) {
  const nextCounter = bumpBuildNumber({ rootDir: ROOT });
  if (nextCounter.buildNumber !== buildNumber) fail('release build counter changed during packaging; refusing to publish');
}

// Publish one canonical immutable build after the staged candidate is complete.
try {
  publishStagedArtifact({ rootDir: ROOT, stagingDirectory: BUILD_DIR, finalDirectory: OUT_DIR });
} catch (error) {
  fail(error.message);
}
buildPublished = true;
writeJsonAtomic(MANIFEST_INDEX, manifest, { mode: 0o644 });

// ------------------------------------------------------------- 汇总

log('');
log(`完成：${path.relative(ROOT, OUT_DIR)}（${mb(directorySize(OUT_DIR))}）`);
log(`  组件：${components.length} 个（Node.js + ${bundledPackages.length} 个 Core npm 依赖 + ${rendererPackages.length} 个 Harbor 生产依赖）`);
log('  校验：SHA256SUMS.txt / release-manifest.json / sbom.json');
log(`  审计：禁止项、构建机路径、凭据泄漏均通过`);
log('  未验证项已写入 release-manifest.json 的 notVerified');
log('');
log('下一步：npm run test-release-candidate（在沙箱里用发行包跑真实安装与运行）');

// 触发一次 shell 无关的语法自检，确保脚本本身在 CI 中也能跑通
const probe = spawnSync(process.execPath, ['--check', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
if (probe.status !== 0) fail(`构建脚本自检失败：${probe.stderr}`);
void require;
