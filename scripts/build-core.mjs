#!/usr/bin/env node
// 鲸桥 Core 打包：ESM 源码 → 单文件 CJS bundle → Node SEA blob → 独立 WhaleBridgeCore.exe。
//
// 产物布局（默认 dist/core）：
//   WhaleBridgeCore.exe        不依赖系统 Node.js 的核心可执行文件
//   resources/                 只读资源（public/roles/assets/dsh/plugins）
//   runtime-manifest.json      版本、构建输入与产物哈希
//   build/                     中间产物（bundle、metafile、blob），可安全删除
//
// 构建可复现要求：只用仓库内已安装的依赖（esbuild / postject 版本在 package.json 中锁定），
// 不使用任何开发机绝对路径，产物中不写入仓库路径。SEA blob 与作为宿主副本的 node.exe 必须来自
// 同一个 process.execPath，否则 blob 版本与宿主不匹配。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertNoWebUiHtmlArtifacts, isNoWebUiHtmlArtifact } from './no-web-release-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const CORE_EXE_NAME = 'WhaleBridgeCore.exe';
// Node SEA 注入哨兵；必须与 Node 官方文档中的常量完全一致。
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// ws 的可选原生加速模块：未安装时 ws 会 try/catch 回退到 JS 实现。
// 必须保持 external，否则 esbuild 会在构建期报无法解析。
const OPTIONAL_EXTERNALS = ['bufferutil', 'utf-8-validate'];

// 只读资源目录清单：这些目录按原样复制到 resources/。
const RESOURCE_DIRS = ['public', 'roles', 'assets', 'dsh', 'plugins'];

// 不进入发行产物的文件（相对仓库根，posix 分隔）。改这里必须同步更新 README 说明。
const RESOURCE_EXCLUDES = [
  { match: /\.bak-[^/\\]*$/i, reason: '开发期备份文件，非运行所需' },
  { match: /^assets\/project-intro\.mp4$/i, reason: '11MB 演示视频，Core 运行期不读取' }
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`[build-core] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { outDir: path.join(ROOT, 'dist', 'core'), verify: true, force: false, noWebUi: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.outDir = path.resolve(argv[++i] ?? '');
    else if (arg === '--no-verify') options.verify = false;
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-web-ui') options.noWebUi = true;
    else fail(`未知参数：${arg}`);
  }
  return options;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) fail(`执行失败：${command}（${result.error.message}）`);
  if (result.status !== 0) fail(`命令退出码 ${result.status}：${command} ${args.join(' ')}`);
}

// 1. 生成单文件 CJS bundle。
async function buildBundle(buildDir) {
  const esbuild = await import('esbuild');
  const bundleFile = path.join(buildDir, 'core.bundle.cjs');
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'core-sea.js')],
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    external: OPTIONAL_EXTERNALS,
    metafile: true,
    legalComments: 'eof',
    // 不压缩：保持堆栈和错误信息可读，体积影响被 90MB 级宿主 exe 吸收。
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    // CJS 单文件 bundle 里 import.meta 为空是**设计要求**，不是缺陷：bundle 内所有模块共享同一份
    // import.meta，若让它解析成 exe 自身路径，bridge.js 与五个 MCP 文件顶层的
    // `if (isMainModule(import.meta.url))` 守卫会在 SEA 中全部成立，一次性启动 bridge 加五个 MCP。
    // 因此这里刻意保留 import.meta 为空：全部守卫为假，只有 src/core-sea.js 显式分派要跑的模式。
    // src/app-paths.js 对取不到模块目录的情况已有回退，打包模式下不依赖 import.meta。
    logOverride: { 'empty-import-meta': 'silent' }
  });
  fs.writeFileSync(
    path.join(buildDir, 'core.bundle.meta.json'),
    JSON.stringify(result.metafile, null, 2)
  );
  return { bundleFile, metafile: result.metafile };
}

const NODE_BUILTIN_RE = /^(?:node:)?(?:assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:\/.*)?$/;

// 审计 bundle：报告被打包的第三方包，并对原生模块和未解析依赖直接失败。
function auditBundle(buildDir, metafile) {
  const inputs = Object.keys(metafile.inputs);
  const packages = new Map();
  let nativeFiles = [];
  for (const input of inputs) {
    if (input.includes('node_modules/')) {
      const after = input.slice(input.indexOf('node_modules/') + 'node_modules/'.length);
      const name = after.startsWith('@') ? after.split('/').slice(0, 2).join('/') : after.split('/')[0];
      packages.set(name, (packages.get(name) ?? 0) + 1);
    }
    if (input.endsWith('.node')) nativeFiles.push(input);
  }

  // 以 esbuild metafile 记录的 external import 为准（比正则扫文本可靠：ajv 的
  // `require("ajv/dist/runtime/equal")` 只是 standalone 代码生成的字符串元数据，不会在运行期执行）。
  const bundleKey = Object.keys(metafile.outputs).find((key) => key.endsWith('core.bundle.cjs'));
  const externals = (metafile.outputs[bundleKey]?.imports ?? [])
    .filter((item) => item.external)
    .map((item) => item.path);
  const unresolved = [...new Set(externals)].filter(
    (name) => !NODE_BUILTIN_RE.test(name) && !OPTIONAL_EXTERNALS.includes(name)
  );

  if (unresolved.length > 0) {
    fail(`bundle 留下未打包的裸模块依赖：${unresolved.join(', ')}（SEA 运行期无法解析 node_modules）`);
  }
  if (nativeFiles.length > 0) {
    fail(`bundle 中混入原生模块：${nativeFiles.join(', ')}`);
  }

  const sorted = [...packages.entries()].sort((a, b) => b[1] - a[1]);
  log(`  被打包模块文件数：${inputs.length}，第三方包 ${sorted.length} 个`);
  for (const [name, count] of sorted) log(`    - ${name}（${count} 文件）`);
  log(`  保留 external：${[...new Set(externals)].join(', ')}`);
  return sorted.map(([name]) => name);
}

// 发行产物禁止出现的文件（相对 resources/ 的路径或文件名模式）。
// 这些是本机运行期数据、凭据或第三方原生二进制，一旦混入发行包就是信息泄漏或授权风险。
const FORBIDDEN_ARTIFACTS = [
  { test: (rel) => rel.toLowerCase() === 'config.json', reason: '真实用户配置（只能带 config.example.json）' },
  { test: (rel) => /(^|\/)(state|logs|backups|cache)(\/|$)/i.test(rel), reason: '运行期状态/日志/缓存目录' },
  { test: (rel) => /\.(log|db|sqlite|sqlite3|key|pem|p12|pfx)$/i.test(rel), reason: '日志/数据库/密钥文件' },
  { test: (rel) => /(console-token|agent-token|credentials\.ya?ml)$/i.test(rel), reason: '访问令牌或凭据' },
  { test: (rel) => /\.(node|dll|so|dylib)$/i.test(rel), reason: '原生二进制（SnowLuma 等第三方组件不得打包）' },
  { test: (rel) => /snowluma/i.test(rel), reason: 'SnowLuma 相关文件（未获授权不得再分发）' },
  { test: (rel) => /\.(bak|bak-[^/]*)$/i.test(rel), reason: '开发期备份文件' },
  { test: (rel) => rel.toLowerCase().includes('whalebridge-integration.json'), reason: 'DSH 集成清单（属于用户环境）' }
];

// 审计发行产物：禁止项、构建机绝对路径、以及本机真实凭据的泄漏。
function auditArtifacts(outDir, bundleFile, exeFile, { noWebUi = false } = {}) {
  const problems = [];

  // 1) resources/ 里不得出现禁止项
  const resourcesDir = path.join(outDir, 'resources');
  if (fs.existsSync(resourcesDir)) {
    const resourceFiles = listFiles(resourcesDir);
    for (const relative of resourceFiles) {
      const rule = FORBIDDEN_ARTIFACTS.find((item) => item.test(relative));
      if (rule) problems.push(`resources/${relative}：${rule.reason}`);
    }
    if (noWebUi) {
      try {
        assertNoWebUiHtmlArtifacts(resourceFiles, 'Core resources');
      } catch (error) {
        problems.push(error.message);
      }
    }
  }

  // 2) bundle 与 exe 中不得出现构建机绝对路径
  for (const target of [bundleFile, exeFile]) {
    if (!target || !fs.existsSync(target)) continue;
    const bytes = fs.readFileSync(target);
    const latin = bytes.toString('latin1');
    if (latin.includes(ROOT)) {
      problems.push(`${path.basename(target)}：包含构建机仓库绝对路径`);
    }
  }

  // 3) 本机真实凭据不得出现在产物里（有真实 config.json 时才检查）
  const realConfig = path.join(ROOT, 'config.json');
  const secrets = [];
  if (fs.existsSync(realConfig)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(realConfig, 'utf8').replace(/^\uFEFF/, ''));
      for (const [label, value] of [
        ['consoleToken', parsed?.consoleToken],
        ['snowluma.accessToken', parsed?.snowluma?.accessToken],
        ['dsh.token', parsed?.dsh?.token]
      ]) {
        const text = String(value ?? '').trim();
        if (text.length >= 8) secrets.push({ label, text });
      }
    } catch {
      /* 配置无法解析：跳过内容扫描 */
    }
  }
  if (secrets.length > 0) {
    for (const target of [bundleFile, exeFile]) {
      if (!target || !fs.existsSync(target)) continue;
      const latin = fs.readFileSync(target).toString('latin1');
      for (const secret of secrets) {
        if (latin.includes(secret.text)) {
          problems.push(`${path.basename(target)}：包含本机真实凭据 ${secret.label}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    fail(`发行产物审计失败：\n  - ${problems.join('\n  - ')}`);
  }
  log(
    `  产物审计通过：${listFiles(resourcesDir).length} 个资源文件无禁止项` +
      `，bundle/exe 无构建机路径${secrets.length > 0 ? `，未泄漏 ${secrets.length} 项本机凭据` : '，本机无真实配置可对照'}`
  );
}

// 2. 生成 SEA blob。
// sea-config.json 中的 main/output 由 node --experimental-sea-config 相对**进程工作目录**解析。
// 以 build/ 为工作目录、只写文件名，是为了让 SEA 内嵌脚本名保持相对形式：
// 若写成绝对路径，exe 的异常堆栈会打印构建机的仓库路径。
function buildSeaBlob(buildDir, bundleFile) {
  const seaConfig = {
    main: path.basename(bundleFile),
    output: 'core.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  const configFile = path.join(buildDir, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify(seaConfig, null, 2));
  run(process.execPath, ['--experimental-sea-config', configFile], { cwd: buildDir });
  return path.join(buildDir, 'core.blob');
}

// 3. 复制当前 node.exe 并注入 blob。
function injectSea(outDir, buildDir, blobFile) {
  const exeFile = path.join(outDir, CORE_EXE_NAME);
  fs.copyFileSync(process.execPath, exeFile);
  const postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!fs.existsSync(postjectCli)) fail('未找到 postject，请先执行 npm install');
  log('  注入 SEA blob（Windows 下会出现签名失效警告，属预期；签名留待发布阶段处理）');
  run(process.execPath, [postjectCli, exeFile, 'NODE_SEA_BLOB', blobFile, '--sentinel-fuse', SEA_FUSE]);
  return exeFile;
}

// 4. 复制只读资源。
function stageResources(outDir, { noWebUi = false } = {}) {
  const resourcesDir = path.join(outDir, 'resources');
  fs.rmSync(resourcesDir, { recursive: true, force: true });
  const excluded = [];
  let copied = 0;
  for (const dirName of RESOURCE_DIRS) {
    const source = path.join(ROOT, dirName);
    if (!fs.existsSync(source)) {
      log(`  跳过不存在的资源目录：${dirName}/`);
      continue;
    }
    for (const relative of listFiles(source)) {
      const repoRelative = `${dirName}/${relative}`;
      if (noWebUi && isNoWebUiHtmlArtifact(repoRelative)) {
        excluded.push({ path: repoRelative, reason: 'native/no-web build excludes product HTML UI pages' });
        continue;
      }
      const exclusion = RESOURCE_EXCLUDES.find((rule) => rule.match.test(repoRelative));
      if (exclusion) {
        excluded.push({ path: repoRelative, reason: exclusion.reason });
        continue;
      }
      const target = path.join(resourcesDir, dirName, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, relative), target);
      copied += 1;
    }
  }
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(resourcesDir, 'config.example.json'));
  copied += 1;
  fs.copyFileSync(path.join(ROOT, 'release-config.json'), path.join(resourcesDir, 'release-config.json'));
  copied += 1;
  // resources/product.json 让打包后的 Core 在 --setup-dsh 时能读到自己的版本号
  // （安装目录里没有 package.json）。
  fs.writeFileSync(
    path.join(resourcesDir, 'product.json'),
    `${JSON.stringify(
      {
        product: '鲸桥 WhaleBridge',
        version: PKG.version,
        core: CORE_EXE_NAME,
        builtAt: new Date().toISOString(),
        node: process.version
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  copied += 1;
  return { resourcesDir, copied, excluded };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.outDir;
  const buildDir = path.join(outDir, 'build');

  if (process.platform !== 'win32') fail('阶段 4 只产出 Windows x64 产物，请在 Windows 上构建');
  if (process.arch !== 'x64') fail(`当前架构 ${process.arch} 不受支持，阶段 4 只验证 Windows x64`);

  const started = Date.now();
  log(`鲸桥 Core 打包（node ${process.version}, ${process.platform}-${process.arch}）`);
  log(`  输出目录：${path.relative(ROOT, outDir) || outDir}`);

  fs.mkdirSync(buildDir, { recursive: true });

  log('[1/6] esbuild 生成单文件 CJS bundle');
  const { bundleFile, metafile } = await buildBundle(buildDir);
  const bundleSize = fs.statSync(bundleFile).size;
  log(`  ${path.relative(ROOT, bundleFile)}（${(bundleSize / 1024).toFixed(0)} KB）`);

  log('[2/6] 审计 bundle');
  const packages = auditBundle(buildDir, metafile);

  log('[3/6] 生成 SEA blob');
  const blobFile = buildSeaBlob(buildDir, bundleFile);

  log('[4/6] 生成独立可执行文件');
  const exeFile = injectSea(outDir, buildDir, blobFile);

  log('[5/6] 复制只读资源');
  const { resourcesDir, copied, excluded } = stageResources(outDir, options);
  for (const item of excluded) log(`  排除 ${item.path}（${item.reason}）`);

  log('[6/6] 审计发行产物（禁止项 / 构建机路径 / 凭据泄漏）');
  auditArtifacts(outDir, bundleFile, exeFile, options);

  const esbuildVersion = require('esbuild/package.json').version;
  const manifest = {
    product: '鲸桥 WhaleBridge Core',
    version: PKG.version,
    builtAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    toolchain: { esbuild: esbuildVersion, postject: require('postject/package.json').version },
    entry: 'src/core-sea.js',
    executable: CORE_EXE_NAME,
    executableBytes: fs.statSync(exeFile).size,
    executableSha256: sha256(exeFile),
    bundleBytes: bundleSize,
    bundledPackages: packages,
    optionalExternals: OPTIONAL_EXTERNALS,
    resourceDirs: RESOURCE_DIRS,
    resourceFiles: copied,
    excludedResources: excluded,
    noWebUi: options.noWebUi,
    // 发行运行面红线（D1）：native/release 模式不启动 loopback HTTP（consolePort），
    // legacy WHALEBRIDGE_LEGACY_HTTP 在 SEA 产物中被忽略。字段供 RC 行为测试对照。
    legacyHttp: false,
    uiDistribution: options.noWebUi ? 'native-no-web' : 'web-compatibility',
    // 打包运行时可读的版本文件（安装目录里没有 package.json）
    productFile: 'resources/product.json',
    // 宿主 node.exe 是 Node.js 官方产物，随产物再分发时需附带其许可证文本。
    licenseNotice: 'includes Node.js (https://nodejs.org/) — MIT license, see resources/licenses/'
  };
  fs.writeFileSync(path.join(outDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  log('');
  log(`完成：${(Date.now() - started) / 1000}s`);
  log(`  ${CORE_EXE_NAME}  ${mb(manifest.executableBytes)}  sha256=${manifest.executableSha256.slice(0, 16)}…`);
  log(`  resources/     ${copied} 个文件 -> ${path.relative(ROOT, resourcesDir)}`);
  log(`  runtime-manifest.json`);
  log('');
  log(`验证：npm run test-core-dist`);
  log(`源码模式仍可用：node src/core-entry.js --help`);
}

await main();
