#!/usr/bin/env node
// 发布候选验收：用**组装好的无网页发行包**（dist/app）跑安装与运行。
//
// 与前面阶段测试的区别（这些正是"发布候选"才暴露的问题）：
//   - 用的是 release 桌面壳 + Node SEA 的 WhaleBridgeCore.exe（不是 node + 源码）；
//   - 运行全程 PATH 中没有任何 node.exe；
//   - 安装/数据/开始菜单/桌面路径都带中文与空格；
//   - 当前账号是普通用户（非管理员），因此安装到沙箱目录而不是 Program Files；
//   - 校验运行期安装目录保持只读、崩溃能自动拉起、重复启动只留单实例。
//
// 全部在临时沙箱内完成，不碰用户真实的 Program Files / 开始菜单 / HKCU / ~/.dsh / 正在运行的服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoWebUiBinaryMarkers, assertNoWebUiHtmlArtifacts } from './no-web-release-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RC_DIR = process.env.WHALEBRIDGE_RC_DIR
  ? path.resolve(process.env.WHALEBRIDGE_RC_DIR)
  : path.join(ROOT, 'dist', 'app');
const CONSOLE_TOKEN = 'rc-test-console-token-0123456789';

function step(message) {
  process.stdout.write(`${message}\n`);
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}

async function waitForHttp(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw last ?? new Error(`等待超时：${url}`);
}

async function assertJsonResponse(response, expectedStatus, label) {
  assert.equal(response.status, expectedStatus, `${label} HTTP 状态不符`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, `${label} 必须返回 JSON，不能回退到网页`);
  return response.json();
}

async function assertNativeApiSurface(port, dataDir, { waitForListener = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const anonymousRoot = waitForListener
    ? await waitForHttp(`${base}/`)
    : await fetch(`${base}/`, { redirect: 'manual' });
  await assertJsonResponse(anonymousRoot, 401, '未授权根路径');

  const authorizedRoot = await fetch(`${base}/?token=${encodeURIComponent(CONSOLE_TOKEN)}`, { redirect: 'manual' });
  const rootError = await assertJsonResponse(authorizedRoot, 403, '原生模式根路径');
  assert.match(String(rootError.error ?? ''), /原生桌面|IPC/i, '根路径应明确提示使用原生应用/IPC，不应提供控制台页面');

  // Native UI 管理能力走 IPC；HTTP 仅保留 Agent/DSH 数据 API。用隔离数据目录生成的服务令牌检查 Core 健康。
  const agentTokenPath = path.join(dataDir, 'state', 'agent-token');
  assert.ok(fs.existsSync(agentTokenPath), `Core 未生成服务令牌：${agentTokenPath}`);
  const agentToken = fs.readFileSync(agentTokenPath, 'utf8').trim();
  assert.ok(agentToken, '服务令牌不能为空');
  const status = await fetch(`${base}/api/status?token=${encodeURIComponent(agentToken)}`, { redirect: 'manual' });
  const payload = await assertJsonResponse(status, 200, 'Core 状态 API');
  assert.equal(payload.tokenModel, 'dual', 'Core 状态 API 应返回有效状态载荷');
  assert.ok(Object.hasOwn(payload, 'mode'), '状态载荷缺少 mode');
  return payload;
}

// PATH 只保留 Windows 自身目录：cmd/powershell 可用，node.exe 不可解析。
function noNodePath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter);
}

function assertNoNodeOnPath(pathValue) {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const name of ['node.exe', 'node.cmd', 'npm.cmd']) {
      assert.ok(!fs.existsSync(path.join(dir, name)), `PATH 中不应存在 ${name}：${dir}`);
    }
  }
}

function psCount(nameFilter) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter "${nameFilter}").Count`],
    { encoding: 'utf8', timeout: 60000 }
  );
  return Number.parseInt((result.stdout ?? '0').trim(), 10) || 0;
}

/** 只返回可执行路径/命令行指向本次沙箱 Core 的进程，不能把用户已安装的 MCP Core 算进来。 */
function coreProcessesAt(executablePath) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     "Get-CimInstance Win32_Process -Filter \"Name='WhaleBridgeCore.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', timeout: 60000 }
  );
  assert.equal(result.status, 0, `查询沙箱 Core 失败：${result.stderr ?? ''}`);
  const text = (result.stdout ?? '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const target = path.resolve(executablePath).toLowerCase();
  return processes.filter((item) => {
    const image = item.ExecutablePath ? path.resolve(item.ExecutablePath).toLowerCase() : '';
    const commandLine = String(item.CommandLine ?? '').toLowerCase();
    return image === target || commandLine.includes(target);
  });
}

function descendants(pid) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     `$all = Get-CimInstance Win32_Process; $ids = @(${pid}); $out = @(); for ($i=0; $i -lt 4; $i++) { $kids = $all | Where-Object { ($ids -contains $_.ParentProcessId) -and ($ids -notcontains $_.ProcessId) }; if (-not $kids) { break }; $out += $kids; $ids += $kids.ProcessId }; $out | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`],
    { encoding: 'utf8', timeout: 60000 }
  );
  const text = (result.stdout ?? '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertNoBrowserRuntime(pid, phase) {
  const browserImages = descendants(pid).filter((item) =>
    /^(msedge(?:webview2)?|chrome|chromium|firefox|iexplore|brave|opera)(\.exe)?$/i.test(
      path.basename(item.ExecutablePath ?? item.Name ?? '')
    )
  );
  assert.deepEqual(browserImages, [], `${phase} 不得启动浏览器/WebView 子进程：${JSON.stringify(browserImages, null, 2)}`);
}

function isRunning(pid) {
  if (!pid) return false;
  return psCount(`ProcessId=${pid}`) > 0;
}

function hashTree(dir) {
  const crypto = require$crypto();
  const files = [];
  const walk = (current, base) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, base);
      else if (entry.isFile()) files.push([path.relative(base, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir, dir);
  return files;
}

let cryptoModule = null;
function require$crypto() {
  if (!cryptoModule) cryptoModule = require('node:crypto');
  return cryptoModule;
}
const require = (await import('node:module')).createRequire(import.meta.url);

// ---------------------------------------------------------------- 前置

assert.ok(fs.existsSync(path.join(RC_DIR, 'WhaleBridge.exe')), `未找到发行包 ${RC_DIR}，请先执行 npm run build:release`);
const setupExe = path.join(RC_DIR, 'WhaleBridge-Setup-x64.exe');
assert.ok(fs.existsSync(setupExe), '发行包缺少 WhaleBridge-Setup-x64.exe');
assert.deepEqual([...fs.readFileSync(setupExe).subarray(0, 2)], [0x4d, 0x5a], '单文件安装器应为 Windows PE');
assert.ok(fs.existsSync(path.join(RC_DIR, 'payload', 'WhaleBridgeCore.exe')), '发行包缺少 payload/WhaleBridgeCore.exe');
const releaseManifest = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'release-manifest.json'), 'utf8'));
const noWebUi = releaseManifest.noWebUi === true;
assert.equal(noWebUi, true, '默认发行必须是 no-web 原生桌面发行，不能回退到网页兼容包');
assert.equal(releaseManifest.uiDistribution, 'native-no-web');
assertNoWebUiHtmlArtifacts(listFiles(path.join(RC_DIR, 'payload')), 'release-candidate payload');
assertNoWebUiBinaryMarkers(fs.readFileSync(path.join(RC_DIR, 'WhaleBridge.exe')), 'release-candidate shell');
assertNoWebUiBinaryMarkers(fs.readFileSync(path.join(RC_DIR, 'payload', 'WhaleBridgeCore.exe')), 'release-candidate Core');
assertNoNodeOnPath(noNodePath());
const whereNode = spawnSync('cmd.exe', ['/d', '/s', '/c', 'where node'], {
  encoding: 'utf8',
  env: { ...process.env, PATH: noNodePath(), Path: noNodePath() }
});
assert.notEqual(whereNode.status, 0, 'PATH 隔离失败：仍能解析到 node.exe');
step('✅ 前置：发行包含单文件安装器；隔离 PATH 中 where node 解析失败（全程无系统 Node.js）');

// 沙箱路径刻意带中文与空格
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-rc-'));
const sandboxRoot = path.join(tempRoot, '鲸桥 发布 候选 测试');
const installDir = path.join(sandboxRoot, '程序 安装 目录', 'WhaleBridge');
const dataDir = path.join(sandboxRoot, '用户 数据 目录', 'WhaleBridge');
const startMenuDir = path.join(sandboxRoot, '开始 菜单');
const desktopDir = path.join(sandboxRoot, '桌面');
const registryKey = `HKCU\\Software\\WhaleBridgeTest\\rc-${process.pid}`;
fs.mkdirSync(sandboxRoot, { recursive: true });

function sandboxArgs() {
  return [
    '--install-dir', installDir,
    '--data-dir', dataDir,
    '--start-menu-dir', startMenuDir,
    '--desktop-dir', desktopDir,
    '--registry-key', registryKey,
    '--no-dsh-integration'
  ];
}

function runInstaller(args, env = {}) {
  const result = spawnSync(path.join(RC_DIR, 'WhaleBridge.exe'), args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300000
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function cleanupRegistry() {
  spawnSync('reg.exe', ['delete', registryKey, '/f'], { encoding: 'utf8' });
}

cleanupRegistry();

try {
  // ------------------------------------------------------------- 1. 安装
  const dryRun = runInstaller(['--install', '--dry-run', ...sandboxArgs()]);
  assert.equal(dryRun.status, 0, dryRun.output);
  assert.ok(dryRun.stdout.includes(installDir), '预演应指向沙箱安装目录');
  assert.ok(!fs.existsSync(installDir), '--dry-run 不得创建安装目录');

  const installed = runInstaller(['--install', ...sandboxArgs()]);
  assert.equal(installed.status, 0, installed.output);
  assert.ok(fs.existsSync(path.join(installDir, 'WhaleBridge.exe')));
  assert.ok(fs.existsSync(path.join(installDir, 'WhaleBridgeCore.exe')));
  assertNoWebUiHtmlArtifacts(listFiles(path.join(installDir, 'resources')), 'installed Core resources');
  const installedBuildInfo = JSON.parse(fs.readFileSync(path.join(installDir, 'build-info.json'), 'utf8'));
  assert.equal(installedBuildInfo.version, releaseManifest.version, 'build-info 版本应与发行清单一致');
  assert.ok(
    /^[0-9a-f]{7,40}$/i.test(String(installedBuildInfo.commit ?? '')),
    `build-info 必须记录 commit SHA：${installedBuildInfo.commit}`
  );
  step(
    `✅ 安装（中文+空格路径）：程序与资源就位；build-info ${installedBuildInfo.version} @ ${String(installedBuildInfo.commitShort ?? installedBuildInfo.commit).slice(0, 12)} → ${installDir}`
  );

  // 预置隔离配置，避免回落到 3100（用户真实的桥接正在用那个端口）
  const port = await freePort();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      consolePort: port,
      consoleToken: CONSOLE_TOKEN,
      dsh: { baseUrl: 'http://127.0.0.1:9' },
      allow: { private: [], groups: [] },
      deny: { private: [], groups: [] },
      allowAllWhenEmpty: false,
      snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', allowProcessControl: false },
      socialV2: { tools: { getCardMsg: false, clickCardButton: false, fileSend: false, bilibili: false } }
    }),
    null,
    2
  );

  // ------------------------------------------------- 2. 启动（发行配置）
  const installBefore = hashTree(installDir);
  const shell = spawn(path.join(installDir, 'WhaleBridge.exe'), [], {
    cwd: sandboxRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PATH: noNodePath(),
      Path: noNodePath(),
      WHALEBRIDGE_DATA_DIR: dataDir,
      WHALEBRIDGE_INSTANCE_SUFFIX: `rc-${process.pid}`,
      LOCALAPPDATA: path.join(sandboxRoot, 'LocalAppData'),
      APPDATA: path.join(sandboxRoot, 'Roaming')
    }
  });
  let shellStderr = '';
  shell.stderr.on('data', (chunk) => {
    shellStderr += String(chunk);
  });

  let workerPid = null;
  try {
    await assertNativeApiSurface(port, dataDir, { waitForListener: true });

    const tree = descendants(shell.pid);
    assertNoBrowserRuntime(shell.pid, '首次启动');
    const images = tree.map((item) => path.basename(item.ExecutablePath ?? item.Name ?? ''));
    assert.ok(
      images.some((name) => name.toLowerCase() === 'whalebridgecore.exe'),
      `worker 必须是发行 Core（实际子进程：${images.join(', ') || '无'})`
    );
    assert.ok(
      !images.some((name) => /^node(\.exe)?$/i.test(name)),
      `子进程里出现了 node.exe：${JSON.stringify(tree, null, 2)}`
    );
    workerPid = tree.find((item) => path.basename(item.ExecutablePath ?? '').toLowerCase() === 'whalebridgecore.exe').ProcessId;
    assert.ok(isRunning(workerPid), 'worker 应当存活');
    step(`✅ 运行（发行配置）：Core(pid ${workerPid}) 由桌面壳拉起；根路径仅返回 JSON、原生管理面走 IPC、状态 API 健康，子进程里没有 node.exe`);

    // 运行期安装目录必须保持只读
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(hashTree(installDir), installBefore, '运行期不得改动安装目录（安装目录应只读）');
    assert.ok(!fs.existsSync(path.join(installDir, 'state')), '运行数据不得写进安装目录');
    step('✅ 只读安装目录：运行期安装目录逐字节不变，运行数据全部落在用户数据目录');

    // ------------------------------------------------- 3. 崩溃恢复
    const killAt = Date.now();
    spawnSync('taskkill.exe', ['/PID', String(workerPid), '/F'], { encoding: 'utf8' });
    let newPid = null;
    const recoverDeadline = Date.now() + 30000;
    while (Date.now() < recoverDeadline) {
      const current = descendants(shell.pid).find(
        (item) => path.basename(item.ExecutablePath ?? '').toLowerCase() === 'whalebridgecore.exe'
      );
      if (current && current.ProcessId !== workerPid) {
        newPid = current.ProcessId;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const recoverMs = Date.now() - killAt;
    assert.ok(newPid, `worker 被强杀后应由壳自动拉起（stderr: ${shellStderr}）`);
    assertNoBrowserRuntime(shell.pid, '崩溃恢复');
    assert.ok(recoverMs >= 4000, `异常退出应走退避（实测 ${recoverMs}ms，若 <4000ms 说明没走退避）`);
    await assertNativeApiSurface(port, dataDir, { waitForListener: true });
    step(`✅ 崩溃恢复：worker 被强杀后在 ${recoverMs}ms 内按退避自动拉起（pid ${workerPid} → ${newPid}），原生 IPC/JSON API 健康恢复`);
    workerPid = newPid;

    // ------------------------------------------------- 3b. 单实例
    const second = spawnSync(path.join(installDir, 'WhaleBridge.exe'), [], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, PATH: noNodePath(), Path: noNodePath(), WHALEBRIDGE_DATA_DIR: dataDir,
        WHALEBRIDGE_INSTANCE_SUFFIX: `rc-${process.pid}` }
    });
    assert.equal(second.status, 0, `第二个实例应静默退出（实际 ${second.status}）\n${second.stderr}`);
    assert.ok(isRunning(shell.pid), '第二个实例不得影响已在运行的实例');
    assert.equal(
      descendants(shell.pid).filter((item) => path.basename(item.ExecutablePath ?? '').toLowerCase() === 'whalebridgecore.exe').length,
      1,
      '单实例下只应有一个 Core worker'
    );
    step('✅ 单实例：第二次启动静默退出并激活已有窗口，仍只有一个 Core worker');
  } finally {
    // 强制结束壳（不连带子进程），验证孤儿守卫在发行配置下也生效
    if (shell.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(shell.pid), '/F'], { encoding: 'utf8' });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const sandboxCore = path.join(installDir, 'WhaleBridgeCore.exe');
  const orphanDeadline = Date.now() + 25000;
  while (Date.now() < orphanDeadline && coreProcessesAt(sandboxCore).length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(
    coreProcessesAt(sandboxCore).length,
    0,
    `壳退出后仍有沙箱 Core 残留（workerPid=${workerPid}）`
  );
  assert.equal(isRunning(workerPid), false, `壳退出后 worker(pid ${workerPid}) 仍残留`);
  step('✅ 孤儿守卫（发行配置）：壳被强杀后 Core 自行退出，无残留进程');

  // ------------------------------------------------------------- 4. 卸载
  const uninstalled = runInstaller(['--uninstall', ...sandboxArgs()]);
  assert.equal(uninstalled.status, 0, uninstalled.output);
  assert.ok(!fs.existsSync(path.join(installDir, 'WhaleBridgeCore.exe')), '应删除 Core');
  assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), '卸载必须保留用户数据');
  assert.equal(coreProcessesAt(sandboxCore).length, 0, '不得残留沙箱 Core 进程');
  step('✅ 卸载：程序清除、用户数据保留、无残留进程');
} finally {
  cleanupRegistry();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

step('🎉 发布候选在真实配置下通过：中文+空格路径 / 无系统 Node / 只读安装目录 / 崩溃恢复 / 单实例 / 孤儿守卫 / 卸载保留数据');
