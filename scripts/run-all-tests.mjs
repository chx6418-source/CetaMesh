#!/usr/bin/env node
// 统一测试入口（D2）：把散落的 scripts/test-*.mjs 全量登记、分类、聚合执行。
//
// 设计约束：
//   · 真实分类来自实际文件清单 —— 新增 scripts/test-*.mjs 而不登记会直接 FAIL（孤儿检测），
//     「脚本存在但没人会跑」从此不可能悄悄发生；
//   · 依赖真实外部环境的 suite（真实 SnowLuma 网关 / 真实 DSH / 公网 / 发行产物 / Rust 工具链）
//     在环境不具备时如实报告 NOT_RUN_ENVIRONMENT，绝不假装 PASS；
//   · 默认串行（很多 suite 会 spawn worker / 绑定探测端口），--jobs N 可对相互独立的
//     suite 提并发；失败即最终失败（exit 1）。
//
// 用法：
//   npm test                          # 全量（环境不具备的 suite 记 NOT_RUN_ENVIRONMENT）
//   npm run test:core                 # 只跑 core 分类
//   node scripts/run-all-tests.mjs --list
//   node scripts/run-all-tests.mjs --jobs 4 --category security --category core
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { readRawConfigOrEmpty } from '../src/config/loader.js';
import { APP_PATHS } from '../src/app-paths.js';
import { isLegacyBridgeTestOptedIn } from './environment-policy.mjs';
import { loadReleaseVersion, releaseArtifactDirectory } from '../src/release/version.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
import { classifySuiteOutcome } from '../src/testing/suite-result.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CORE_DIST_DIR = process.env.WHALEBRIDGE_DIST_DIR
  ? path.resolve(process.env.WHALEBRIDGE_DIST_DIR)
  : path.join(ROOT, 'dist', 'core');

export const CATEGORIES = ['core', 'architecture', 'security', 'runtime', 'integration', 'desktop', 'release', 'environment'];

// ── 登记表：scripts/test-*.mjs 的每一个文件都必须出现在这里（或能从 package.json 映射）。
// requires 的取值见 probeAvailability()；category 取值见 CATEGORIES。
const REGISTRY = {
  // ── core：基础服务 / 纯函数 / 传输协议 ─────────────────────────────────────
  'test-agent-provider.mjs': { category: 'core' },
  'test-app-paths.mjs': { category: 'core' },
  'test-config-service.mjs': { category: 'core' },
  'test-json-storage.mjs': { category: 'core' },
  'test-storage-migrations.mjs': { category: 'core' },
  'test-control-service.mjs': { category: 'core' },
  'test-bridge-privilege.mjs': { category: 'security' },
  'test-ipc-protocol.mjs': { category: 'core' },
  'test-md-to-plain.mjs': { category: 'core' },
  'test-v2-wait.mjs': { category: 'core' },
  'test-slang-learn.mjs': { category: 'core' },
  'test-owner-agent-mode.mjs': { category: 'core' },
  'test-core-entry.mjs': { category: 'core' },
  'test-service-container.mjs': { category: 'core' },
  'test-ipc-runtime.mjs': { category: 'core' },
  'test-dsh-lifecycle.mjs': { category: 'core' },
  'test-qq-runtime.mjs': { category: 'core' },
  'test-runner-environment.mjs': { category: 'core' },
  'test-integration-tool-registry.mjs': { category: 'core', note: '产品化任务 B：Tools Registry 目录/开关/持久化' },
  'test-release-versioning.mjs': { category: 'release', note: 'Plugin Center: canonical release version and build numbering' },
  'test-release-staging-protection.mjs': { category: 'release', note: 'Pre-existing release staging directory protection' },
  'test-storage-hygiene.mjs': { category: 'release', note: 'Exact-path cleanup and release retention fixtures' },
  'test-suite-process-tree.mjs': { category: 'security', note: 'Timeout termination waits for suite process trees' },

  // ── architecture：结构契约 / 源码不变量 ────────────────────────────────────
  'test-desktop-architecture.mjs': { category: 'architecture' },
  'test-composition-boundary.mjs': { category: 'architecture' },
  'test-capability-coverage.mjs': { category: 'architecture' },
  'test-desktop-chat-product.mjs': { category: 'architecture' },
  'test-desktop-ui-v2-production.mjs': { category: 'architecture', note: 'Owner-selected Harbor WebView2 UI, typed bridge, secure bundle, and production no-HTTP contract' },
  'test-desktop-chat-virtualization.mjs': { category: 'architecture', note: 'Harbor Chat React virtual-window, dynamic-height, and long-content fixtures' },
  'test-process-extension-host.mjs': { category: 'architecture' },
  'test-workspace-ipc.mjs': { category: 'architecture' },
  'test-smart-platform-routing.mjs': { category: 'architecture' },
  'test-integration-descriptors.mjs': { category: 'architecture', note: '产品化任务 B：SnowLuma/DSH 集成描述符 + IPC 路由 + 容器装配' },
  'test-dsh-desktop-integration.mjs': { category: 'integration', note: 'DSH Desktop detection, launch, settings contract, and Agent/Desktop separation' },

  // ── security：权限 / 能力 / 攻击负面 ──────────────────────────────────────
  'test-agent-test-run-security.mjs': { category: 'security' },
  'test-capability-broker.mjs': { category: 'security' },
  'test-phase1-security.mjs': { category: 'security' },
  'test-isolated-runner.mjs': { category: 'security' },
  'test-security-negatives.mjs': { category: 'security' },
  'test-extension-capability.mjs': { category: 'security' },
  'test-provider-secrets.mjs': { category: 'security' },
  'test-error-hygiene.mjs': { category: 'security' },
  'test-bionic-chat-plugin.mjs': { category: 'security', note: '产品化任务 B：仿生聊天插件开关 + Capability 强制' },
  'test-artifact-open-boundary.mjs': { category: 'security', note: 'Task and Workspace identity based native artifact opening' },

  // ── runtime：产品运行时（chat/memory/task/continuity/model/social…） ───────
  'test-agent-broker.mjs': { category: 'runtime' },
  'test-agent-provider-expansion.mjs': { category: 'security' },
  'test-workspace-staging-boundary.mjs': { category: 'security' },
  'test-managed-agent-provider.mjs': { category: 'runtime' },
  'test-phase2-chat-model.mjs': { category: 'runtime' },
  'test-phase3-task-handoff.mjs': { category: 'runtime' },
  'test-phase3-real-codex.mjs': { category: 'environment', requires: ['real-codex'], timeoutMs: 180_000,
    note: 'Owner-authorized real Codex CLI Task E2E in an isolated disposable Workspace' },
  'test-memory-runtime.mjs': { category: 'runtime' },
  'test-memory-link.mjs': { category: 'runtime' },
  'test-state-retention.mjs': { category: 'runtime' },
  'test-task-runtime.mjs': { category: 'runtime' },
  'test-product-context.mjs': { category: 'runtime' },
  'test-continuity-rollover.mjs': { category: 'runtime' },
  'test-continuity-auto-rollover.mjs': { category: 'runtime' },
  'test-model-runtime.mjs': { category: 'runtime' },
  'test-model-tool-calling.mjs': { category: 'runtime' },
  'test-smart-router.mjs': { category: 'runtime' },
  'test-standalone-model-path.mjs': { category: 'runtime' },
  'test-dsh-model-selection.mjs': { category: 'runtime' },
  'test-workshop-runtime.mjs': { category: 'runtime' },
  'test-workspace-runtime.mjs': { category: 'runtime' },
  'test-workspace-reconciliation.mjs': { category: 'runtime' },
  'test-extension-runtime.mjs': { category: 'runtime' },
  'test-plugin-center.mjs': { category: 'runtime', note: 'Catalog, package validation, offline cache, and Extension Runtime delegation' },
  'test-plugin-sdk.mjs': { category: 'runtime', note: 'Plugin authoring template, validator, and Hello Tool sample' },
  'test-mesh-runtime.mjs': { category: 'runtime' },
  'test-mesh-pairing-interop.mjs': { category: 'runtime', note: '统一配对 v1.1：golden fixtures + 真实局域网 TLS/HTTP 互操作（Node fixture 模拟 Mobile）' },
  'test-card.mjs': { category: 'runtime' },
  'test-stickers.mjs': { category: 'runtime' },
  'test-forward.mjs': { category: 'runtime' },
  'test-vision-media.mjs': { category: 'runtime' },
  'test-local-services.mjs': { category: 'runtime' },
  'test-system-pages.mjs': { category: 'runtime' },
  'test-product-services.mjs': { category: 'runtime', note: '产品化 D：About / 更新公告 / 诊断本机展示 / 新 IPC 命名空间' },
  'test-feedback-links.mjs': { category: 'runtime', note: '反馈修正：只提供官网入口（query 白名单 version/build/platform，无软件内收集）' },
  'test-onboarding.mjs': { category: 'runtime', note: '产品化 D：首次运行引导（无 QQ/DSH/移动端也可完成）' },
  'test-product-copy.mjs': { category: 'runtime', note: '产品化 D：空状态文案与 Provider 基础/高级字段分离' },
  'test-update-source.mjs': { category: 'runtime', note: '分发运行时：GitCode 主源 + GitHub 备用 + 校验下载' },
  'test-mcp-registry.mjs': { category: 'runtime', note: '产品化任务 B：MCP Registry/Runtime（启停/发现/崩溃/重启）' },

  // ── integration：DSH / MCP / 进程间链路 ────────────────────────────────────
  'test-dsh-integration.mjs': { category: 'integration' },
  'test-mcp-safe.mjs': { category: 'integration' },
  'test-mcp-host.mjs': { category: 'integration' },
  'test-desktop-platform-integration.mjs': { category: 'integration' },
  'test-desktop-supervisor.mjs': { category: 'integration' },
  'test-no-web-release.mjs': { category: 'integration', note: 'no-web 政策 + 无 HTTP 运行面行为断言' },
  // 依赖真实外部环境的 integration（缺环境 → NOT_RUN_ENVIRONMENT）
  'test-mcp-exec.mjs': { category: 'environment', requires: ['gateway'], note: '需要真实 SnowLuma 网关（@snowluma/mcp 执行工具）' },
  'test-mcp-web-search.mjs': { category: 'environment', requires: ['network'], note: '访问公网搜索引擎' },
  'test-onebot-connection.mjs': { category: 'environment', requires: ['gateway'], note: '连接真实 OneBot WebSocket 网关' },
  'test-console.mjs': { category: 'environment', requires: ['legacy-bridge'], note: '仅在显式设置 WHALEBRIDGE_TEST_LEGACY_BRIDGE=1 且测试端口指向隔离开发桥接时运行' },

  // ── desktop：桌面壳 / 安装器（需要 Rust 构建） ─────────────────────────────
  'test-desktop-shell.mjs': { category: 'desktop', requires: ['shell-debug'], timeoutMs: 600_000 },
  'test-desktop-install.mjs': { category: 'desktop', requires: ['shell-debug'], timeoutMs: 600_000 },
  'test-installer-productization.mjs': { category: 'desktop', requires: ['shell-debug'], note: 'Installer 产品化：无控制台子进程/窗口、升级位置复用、失败回滚、向导 GUI 冒烟', timeoutMs: 600_000 },

  // ── release：打包 / 产物 / 发行验收 ───────────────────────────────────────
  'test-installer-package.mjs': { category: 'release' },
  'test-app-icon.mjs': { category: 'release' },
  'test-core-dist.mjs': { category: 'release', requires: ['core-dist'], timeoutMs: 600_000 },
  'test-process-extension-sea.mjs': { category: 'release', requires: ['core-dist'], timeoutMs: 600_000 },
  'test-release-candidate.mjs': { category: 'release', requires: ['release-dist'], timeoutMs: 900_000 },

  // cargo 套件不是 test-*.mjs，作为虚拟 suite 登记（见 EXTRA_SUITES）。
};

// 非 test-*.mjs 的套件：直接以 cargo 命令行表达（避免经 npm.cmd —— Node ≥ 20.12
// 出于 CVE-2024-27980 加固，spawn .cmd 必须开 shell，聚合器不做这种包装）。
const EXTRA_SUITES = [
  {
    id: 'cargo:check',
    command: ['cargo', ['check', '--manifest-path', 'desktop-shell/Cargo.toml']],
    category: 'desktop',
    requires: ['cargo-opt-in'],
    timeoutMs: 900_000
  },
  {
    id: 'cargo:test',
    command: ['cargo', ['test', '--manifest-path', 'desktop-shell/Cargo.toml']],
    category: 'desktop',
    requires: ['cargo-opt-in'],
    timeoutMs: 900_000
  }
];

// ── 环境探测 ─────────────────────────────────────────────────────────────────

function probeTcp(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

let availabilityCache = null;
async function probeAvailability() {
  if (availabilityCache) return availabilityCache;
  const cfg = readRawConfigOrEmpty(APP_PATHS.configFile);
  const gatewayUrl = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000');
  let gatewayPort = 3000;
  try {
    gatewayPort = Number(new URL(gatewayUrl).port) || (new URL(gatewayUrl).protocol === 'https:' ? 443 : 80);
  } catch { /* 默认 3000 */ }
  const consolePort = Number(cfg.consolePort) || 3100;
  const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
  const gatewayConfigPresent = fs.existsSync(path.join(ROOT, 'config.json'));
  let canonicalReleaseAvailable = false;
  try {
    const release = loadReleaseVersion({ rootDir: ROOT });
    const releaseDir = releaseArtifactDirectory({ rootDir: ROOT, ...release });
    canonicalReleaseAvailable = fs.existsSync(path.join(releaseDir, 'release-manifest.json'));
  } catch {
    // A missing or malformed release source means the RC suite is unavailable, not a runner crash.
  }
  availabilityCache = {
    'shell-debug': exists(path.join('desktop-shell', 'target', 'debug', 'whalebridge-desktop.exe')),
    'core-dist': fs.existsSync(path.join(CORE_DIST_DIR, 'WhaleBridgeCore.exe')),
    'release-dist': canonicalReleaseAvailable,
    network: process.env.WHALEBRIDGE_TEST_NETWORK === '1',
    gateway: gatewayConfigPresent && await probeTcp(gatewayPort),
    // A live TCP listener may be the user’s real desktop bridge; this suite mutates roles/allowlists and sends a test QQ message.
    'legacy-bridge': isLegacyBridgeTestOptedIn() && await probeTcp(consolePort),
    'cargo-opt-in': process.env.WHALEBRIDGE_TEST_CARGO === '1'
      && spawnSync('cargo', ['--version'], { timeout: 20000 }).status === 0,
    'real-codex': process.env.WHALEBRIDGE_TEST_REAL_CODEX === '1'
      && spawnSync('codex', ['login', 'status'], { timeout: 20000 }).status === 0
  };
  return availabilityCache;
}

// ── 套件发现与孤儿检测 ───────────────────────────────────────────────────────

function discoverSuites() {
  const files = fs.readdirSync(SCRIPTS)
    .filter((f) => /^test-.*\.mjs$/.test(f))
    .sort();
  const orphans = files.filter((f) => !REGISTRY[f]);
  const suites = files
    .filter((f) => REGISTRY[f])
    .map((f) => ({
      id: f.replace(/\.mjs$/, ''),
      file: path.join(SCRIPTS, f),
      command: null,
      category: REGISTRY[f].category ?? 'runtime',
      requires: REGISTRY[f].requires ?? [],
      note: REGISTRY[f].note ?? '',
      timeoutMs: REGISTRY[f].timeoutMs ?? 300_000
    }));
  for (const extra of EXTRA_SUITES) {
    suites.push({
      id: extra.id,
      file: null,
      command: extra.command,
      category: extra.category,
      requires: extra.requires ?? [],
      note: extra.note ?? '',
      timeoutMs: extra.timeoutMs ?? 600_000
    });
  }
  return { suites, orphans };
}

// package.json 里的同名脚本（仅用于展示 npm 名，不改变执行方式）
function npmNameFor(file) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [key, value] of Object.entries(pkg.scripts)) {
    if (String(value).includes(`scripts/${path.basename(file)}`)) return key;
  }
  return null;
}

// ── 执行 ─────────────────────────────────────────────────────────────────────

function runSuite(suite, { verbose }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [command, commandArgs] = suite.command ?? [process.execPath, [suite.file]];
    const sandbox = createSuiteSandbox({ suiteId: suite.id });
    const childEnvironment = {
      ...process.env,
      TMPDIR: sandbox.root,
      TEMP: sandbox.root,
      TMP: sandbox.root,
      WHALEBRIDGE_TEST_TMPDIR: sandbox.root
    };
    let child;
    let output = '';
    let timer = null;
    let timedOut = false;
    let settled = false;
    let closeResult = null;
    let spawnError = null;
    let terminationSettled = false;
    let terminationError = null;
    const finish = (code, signal, error = null, treeError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const outcome = classifySuiteOutcome({ code, signal, error, treeError, timedOut, output });
      const failed = outcome.failed;
      let sandboxNote = '';
      let cleanupFailed = false;
      if (treeError) {
        cleanupFailed = true;
        sandboxNote = `\n[test sandbox retained because suite process-tree termination could not be confirmed] ${sandbox.root}`;
      } else {
        try {
          const result = finalizeSuiteSandbox({ sandbox, failed, keepFailed: process.env.KEEP_TEST_ARTIFACTS === '1' });
          if (result.retained) sandboxNote = `\n[test sandbox retained] ${sandbox.root}`;
        } catch (cleanupError) {
          cleanupFailed = true;
          sandboxNote = `\n[test sandbox cleanup failed] ${cleanupError?.message ?? cleanupError}`;
        }
      }
      const detail = error
        ? `${output}\n[run-all-tests] suite process error: ${error?.message ?? error}`
        : treeError
          ? `${output}\n[suite process-tree termination failed: ${treeError?.message ?? treeError}]`
        : timedOut
          ? `${output}\n[suite timeout (> ${Math.round(suite.timeoutMs / 1000)}s), terminated]`
          : output;
      resolve({ suite, status: cleanupFailed ? 'FAIL' : outcome.status, durationMs: Date.now() - started, detail: `${detail}${sandboxNote}` });
    };
    const completeAfterClose = () => {
      if (!closeResult || (timedOut && !terminationSettled)) return;
      finish(closeResult.code, closeResult.signal, spawnError, terminationError);
    };
    try {
      child = spawn(command, commandArgs, {
        cwd: ROOT,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: childEnvironment
      });
    } catch (error) {
      // spawn 自身失败（如 .cmd 安全限制、命令不存在）必须成为该 suite 的 FAIL，
      // 不能让聚合器崩溃 —— 否则整个测试体系失去汇总与孤儿检测。
      finish(null, null, error);
      return;
    }
    const collect = (chunk) => {
      const text = String(chunk);
      if (verbose) process.stdout.write(text);
      else output += text;
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      closeResult = { code, signal };
      completeAfterClose();
    });
    timer = setTimeout(() => {
      timedOut = true;
      terminateSuiteProcessTree(child).then(() => {
        terminationSettled = true;
        completeAfterClose();
      }, (error) => {
        terminationError = error;
        terminationSettled = true;
        try { child.kill(); } catch { /* tree termination failed; keep the suite sandbox for safety */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        completeAfterClose();
      });
    }, suite.timeoutMs);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const wantedCategories = [];
  let jobs = 1;
  let verbose = false;
  let listOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--category' || args[i] === '-c') wantedCategories.push(args[++i]);
    else if (args[i] === '--jobs' || args[i] === '-j') jobs = Math.max(1, Number(args[++i]) || 1);
    else if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    else if (args[i] === '--list') listOnly = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`用法：node scripts/run-all-tests.mjs [--category <名称>]... [--jobs N] [--verbose] [--list]\n分类：${CATEGORIES.join(', ')}\n`);
      return;
    }
  }
  for (const category of wantedCategories) {
    if (!CATEGORIES.includes(category)) {
      console.error(`未知分类：${category}（可选：${CATEGORIES.join(', ')}）`);
      process.exitCode = 1;
      return;
    }
  }

  const { suites, orphans } = discoverSuites();
  if (orphans.length) {
    console.error(`✗ 孤儿测试（scripts/test-*.mjs 未在 run-all-tests.mjs 登记）：`);
    for (const orphan of orphans) console.error(`  - ${orphan}`);
    console.error('每个测试都必须进入聚合器；确属废弃请删除文件，不要让它游离在测试体系外。');
    process.exitCode = 1;
    return;
  }

  const selected = wantedCategories.length
    ? suites.filter((suite) => wantedCategories.includes(suite.category))
    : suites;
  if (listOnly) {
    for (const suite of selected) {
      const npm = suite.file ? npmNameFor(suite.file) : null;
      process.stdout.write(`${suite.category.padEnd(12)} ${suite.id.padEnd(36)} ${npm ? `npm run ${npm}` : ''}${suite.requires.length ? `  [requires: ${suite.requires.join(',')}]` : ''}\n`);
    }
    process.stdout.write(`共 ${selected.length} 个 suite\n`);
    return;
  }

  const availability = await probeAvailability();
  const results = [];
  for (const suite of selected) {
    const missing = suite.requires.filter((requirement) => !availability[requirement]);
    if (missing.length) {
      const detail = missing.includes('cargo-opt-in')
        ? '未设置 WHALEBRIDGE_TEST_CARGO=1；跳过可能触发大规模 Rust 重编译的 Cargo suite'
        : `缺少环境：${missing.join(', ')}`;
      results.push({ suite, status: 'NOT_RUN_ENVIRONMENT', durationMs: 0, detail });
      continue;
    }
    results.push(await runSuite(suite, { verbose }));
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  const counts = { PASS: 0, FAIL: 0, NOT_RUN_ENVIRONMENT: 0 };
  process.stdout.write(`\n${'═'.repeat(72)}\n汇总（${selected.length} suites）\n`);
  for (const result of results) {
    const label = result.status === 'PASS' ? '✅ PASS   ' : result.status === 'FAIL' ? '❌ FAIL   ' : '↷ NOT_RUN_ENVIRONMENT';
    process.stdout.write(`${label}  ${result.suite.category.padEnd(12)} ${result.suite.id.padEnd(36)} ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.status === 'NOT_RUN_ENVIRONMENT') process.stdout.write(`  ${result.detail}`);
    process.stdout.write('\n');
    counts[result.status] += 1;
    if (result.status === 'FAIL' && !verbose) {
      const tail = String(result.detail ?? '').trim().split('\n').slice(-40).join('\n');
      if (tail) process.stdout.write(`    ── 输出末尾 ──\n${tail.split('\n').map((line) => `    ${line}`).join('\n')}\n`);
    }
  }
  process.stdout.write(
    `PASS ${counts.PASS} · FAIL ${counts.FAIL} · NOT_RUN_ENVIRONMENT ${counts.NOT_RUN_ENVIRONMENT}\n` +
    (counts.NOT_RUN_ENVIRONMENT ? `（NOT_RUN_ENVIRONMENT = 依赖本机不具备的真实环境，如实记录、不计失败，也不计通过）\n` : '')
  );
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[run-all-tests] 聚合器自身失败:', error?.stack ?? error);
  process.exitCode = 1;
});
