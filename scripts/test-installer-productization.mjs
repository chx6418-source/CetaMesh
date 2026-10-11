#!/usr/bin/env node
// CetaMesh Installer 产品化专项验证（Windows Installer Productization）。
//
// 全程沙箱：安装目录 / 数据目录 / 开始菜单 / 桌面 / 注册表键全部注入临时目录，
// 不触碰真实 Program Files、开始菜单、HKCU 卸载项与 ~/.dsh。
//
// 覆盖：
//   1. 子进程策略（运行期审计）：安装期间每个控制台子进程（reg.exe / powershell.exe …）
//      都被记录为 hidden=true —— 即 CREATE_NO_WINDOW，绝不弹黑框；
//   2. 子进程策略（静态红线）：安装器三个源文件里不得出现裸 Command::new("reg.exe" 等)；
//   3. 无控制台窗口（窗口枚举）：安装前后对比，不出现新的可见 ConsoleWindowClass 窗口；
//   4. 升级位置复用：--detect-install 报告既有安装目录与版本（版本以安装清单为准）；
//   5. 全新机器：--detect-install 如实报告 installed=false；
//   6. 安装失败回滚：中途失败后目录回到执行前状态，且错误说明已回滚；
//   7. 安装向导 GUI 冒烟：窗口可启动（标题含 CetaMesh 安装程序）并可正常关闭。

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = path.join(ROOT, 'desktop-shell', 'target', 'debug', 'whalebridge-desktop.exe');
const CORE_DIST = path.join(ROOT, 'dist', 'core');

function step(message) {
  process.stdout.write(`${message}\n`);
}

function run(exe, args, env = {}) {
  const result = spawnSync(exe, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300000
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

// ---------------------------------------------------------------- Windows 控制台窗口枚举

const CONSOLE_SCAN = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CetaConsoleWatch {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static string Scan() {
    var sb = new StringBuilder();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var name = new StringBuilder(64);
      GetClassName(h, name, name.Capacity);
      if (name.ToString() == "ConsoleWindowClass") sb.Append(h.ToInt64()).Append(';');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  public static string FindByTitle(string fragment) {
    var found = new StringBuilder();
    EnumWindows((h, p) => {
      var n = GetWindowTextLength(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().Contains(fragment)) found.Append(h.ToInt64()).Append(';');
      return true;
    }, IntPtr.Zero);
    return found.ToString();
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
}
"@
`;

function consoleWindows() {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `${CONSOLE_SCAN}[CetaConsoleWatch]::Scan()`],
    { encoding: 'utf8', timeout: 30000 }
  );
  return (result.stdout ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

/** 安装期间持续扫描新增的可见控制台窗口（每 25ms 一次）。 */
function startConsoleWatcher() {
  const script = `${CONSOLE_SCAN}
$seen = @{}
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  foreach ($h in ([CetaConsoleWatch]::Scan() -split ';')) {
    if ($h -and -not $seen.ContainsKey($h)) { $seen[$h] = 1; Write-Output $h }
  }
  Start-Sleep -Milliseconds 25
}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
  });
  return {
    stop() {
      return new Promise((resolve) => {
        child.once('exit', () => resolve(buffer));
        child.kill();
      });
    }
  };
}

// ---------------------------------------------------------------- 沙箱

assert.ok(fs.existsSync(SHELL), `未找到 ${path.relative(ROOT, SHELL)}，请先执行 npm run desktop:build:debug`);
assert.ok(fs.existsSync(CORE_DIST), '未找到 dist/core，请先执行 npm run build:core');
step('✅ 前置：桌面壳（含安装器）与 dist/core 就绪');

/** 构造一份可安装的 payload（模拟 dist/core 布局，不复制 90MB 的真实 Core）。 */
function makePayload(dir, { coreMarker = 'core-v1' } = {}) {
  fs.mkdirSync(path.join(dir, 'resources', 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'WhaleBridgeCore.exe'), coreMarker);
  fs.writeFileSync(path.join(dir, 'runtime-manifest.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(dir, 'resources', 'product.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(dir, 'resources', 'config.example.json'), JSON.stringify({ consolePort: 3100 }));
  fs.writeFileSync(path.join(dir, 'resources', 'public', 'console.html'), 'resources-v1');
  return dir;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-installer-'));
const sandbox = {
  installDir: path.join(tempRoot, 'ProgramFiles', 'CetaMesh'),
  dataDir: path.join(tempRoot, 'LocalAppData', 'CetaMesh'),
  startMenuDir: path.join(tempRoot, 'StartMenu', 'Programs'),
  desktopDir: path.join(tempRoot, 'Desktop'),
  registryKey: `HKCU\\Software\\CetaMeshInstallerTest\\suite-${process.pid}`
};

const stagingDir = path.join(tempRoot, 'staging');
fs.mkdirSync(stagingDir, { recursive: true });
const payloadV1 = makePayload(path.join(stagingDir, 'payload'));
fs.copyFileSync(SHELL, path.join(stagingDir, 'CetaMesh.exe'));
const installer = path.join(stagingDir, 'CetaMesh.exe');

function sandboxArgs(overrides = {}) {
  return [
    '--install-dir', overrides.installDir ?? sandbox.installDir,
    '--data-dir', overrides.dataDir ?? sandbox.dataDir,
    '--start-menu-dir', sandbox.startMenuDir,
    '--desktop-dir', overrides.desktopDir ?? sandbox.desktopDir,
    '--registry-key', overrides.registryKey ?? sandbox.registryKey,
    '--payload-core', payloadV1,
    '--no-dsh-integration'
  ];
}

function runInstaller(args, extraEnv = {}) {
  return run(installer, [...args, ...sandboxArgs()], extraEnv);
}

function cleanupRegistry(key = sandbox.registryKey) {
  spawnSync('reg.exe', ['delete', key, '/f'], { encoding: 'utf8' });
}

cleanupRegistry();

const spawnLog = path.join(tempRoot, 'spawn-audit.jsonl');
const baselineConsoles = consoleWindows();

try {
  // ---------------------------------------------------------------- 1+3. 安装 + 子进程审计
  const watcher = startConsoleWatcher();
  const installed = runInstaller(['--install'], { WHALEBRIDGE_INSTALLER_SPAWN_LOG: spawnLog });
  const seenConsoles = await watcher.stop();

  assert.equal(installed.status, 0, installed.output);
  step('✅ 沙箱安装完成');

  const records = fs
    .readFileSync(spawnLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.length > 0, 'spawn 审计必须记录安装期间的控制台子进程');
  const unhidden = records.filter((record) => record.hidden !== true);
  assert.deepEqual(unhidden, [], `存在未隐藏的控制台子进程：${JSON.stringify(unhidden)}`);
  const programs = records.map((record) => path.basename(record.program).toLowerCase());
  assert.ok(programs.includes('reg.exe'), `审计应覆盖注册表写入（实际：${programs.join(', ')}）`);
  assert.ok(programs.includes('powershell.exe'), `审计应覆盖快捷方式创建（实际：${programs.join(', ')}）`);
  step(`✅ 子进程审计：${records.length} 次 spawn 全部 hidden=true（${[...new Set(programs)].join(', ')}）`);

  const newConsoles = seenConsoles
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((hwnd) => !baselineConsoles.includes(hwnd));
  assert.deepEqual(newConsoles, [], `安装期间出现了新的可见控制台窗口：HWND ${newConsoles.join(', ')}`);
  step('✅ 无控制台窗口：安装全程未出现新的 ConsoleWindowClass 窗口');

  // ---------------------------------------------------------------- 2. 静态红线
  const consolePrograms = ['reg.exe', 'powershell.exe', 'taskkill.exe', 'tasklist.exe', 'cmd.exe', 'pwsh.exe', 'cmd', 'powershell'];
  const barePattern = new RegExp(`Command::new\\(\\s*"(${consolePrograms.join('|')})"\\s*\\)`);
  for (const file of ['installer.rs', 'install_cli.rs', 'native_installer_ui.rs', 'migrate.rs']) {
    const source = fs.readFileSync(path.join(ROOT, 'desktop-shell', 'src', file), 'utf8');
    const match = source.match(barePattern);
    assert.equal(match, null, `${file} 中不允许裸启动控制台程序：${match?.[0]}`);
  }
  step('✅ 静态红线：安装器源文件不存在裸启动控制台程序的写法');

  // ---------------------------------------------------------------- 4. 升级位置复用
  const detect = run(installer, ['--detect-install', '--registry-key', sandbox.registryKey, '--install-dir', path.join(tempRoot, 'unused-default')]);
  assert.equal(detect.status, 0, detect.output);
  const detected = JSON.parse(detect.stdout.trim().split('\n').pop());
  assert.equal(detected.installed, true, detect.output);
  assert.equal(path.resolve(detected.installDir).toLowerCase(), path.resolve(sandbox.installDir).toLowerCase());
  assert.equal(detected.version, '0.1.0', '版本应来自安装目录内的安装清单');
  step(`✅ 升级位置复用：detect-install → ${detected.installDir}（v${detected.version}）`);

  // ---------------------------------------------------------------- 5. 全新机器如实报告
  const freshKey = `HKCU\\Software\\CetaMeshInstallerTest\\fresh-${process.pid}`;
  cleanupRegistry(freshKey);
  const freshDetect = run(installer, [
    '--detect-install',
    '--registry-key', freshKey,
    '--install-dir', path.join(tempRoot, 'empty-default')
  ]);
  assert.equal(freshDetect.status, 0, freshDetect.output);
  const fresh = JSON.parse(freshDetect.stdout.trim().split('\n').pop());
  assert.equal(fresh.installed, false, freshDetect.output);
  step('✅ 全新机器：detect-install 如实报告 installed=false');

  // ---------------------------------------------------------------- 6. 失败回滚
  // 先人为删除一个已安装文件：失败安装若部分执行，回滚必须把它恢复到“不存在”的执行前状态。
  const rollbackRoot = path.join(tempRoot, 'rollback');
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const rollbackData = path.join(rollbackRoot, 'data');
  const rollbackBlock = path.join(rollbackRoot, 'desktop-blocker');
  fs.writeFileSync(rollbackBlock, 'this is a file, not a directory');
  fs.rmSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'), { force: true });
  const rollback = run(installer, [
    '--install',
    '--install-dir', sandbox.installDir,
    '--data-dir', rollbackData,
    '--start-menu-dir', sandbox.startMenuDir,
    '--desktop-dir', rollbackBlock,
    '--registry-key', sandbox.registryKey,
    '--payload-core', payloadV1,
    '--no-dsh-integration'
  ]);
  assert.notEqual(rollback.status, 0, `把桌面目录指向普通文件时必须失败：${rollback.output}`);
  assert.match(rollback.output, /回滚/, rollback.output);
  assert.ok(
    !fs.existsSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe')),
    '回滚后必须恢复到执行前状态（此前已删除的 Core 不得残留）'
  );
  assert.ok(
    !fs.existsSync(path.join(rollbackData, 'config.json')),
    '回滚后不得留下新建的数据目录文件'
  );
  step('✅ 失败回滚：中途失败后目录回到执行前状态，错误信息明确说明');

  // 恢复被删文件，供后续用例使用（重新安装）。
  const restore = runInstaller(['--install']);
  assert.equal(restore.status, 0, restore.output);

  // ---------------------------------------------------------------- 7. 安装向导 GUI 冒烟
  const ui = spawn(installer, ['--installer-ui'], { stdio: 'ignore', env: { ...process.env } });
  const findTitle = `${CONSOLE_SCAN}[CetaConsoleWatch]::FindByTitle('CetaMesh 安装程序')`;
  let windowHandles = '';
  const uiDeadline = Date.now() + 30000;
  while (Date.now() < uiDeadline) {
    const scan = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', findTitle], { encoding: 'utf8', timeout: 30000 });
    windowHandles = (scan.stdout ?? '').trim();
    if (windowHandles) break;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 250'], { encoding: 'utf8', timeout: 10000 });
  }
  assert.ok(windowHandles, '安装向导窗口必须在 30 秒内出现（标题应含 CetaMesh 安装程序）');
  const hwnd = windowHandles.split(';').filter(Boolean)[0];
  spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `${CONSOLE_SCAN}
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CetaClose { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); public static void Close(long h) { SendMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); } }
"@
[CetaClose]::Close(${hwnd})`
  ], { encoding: 'utf8', timeout: 30000 });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    ui.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) ui.kill();
  assert.ok(exited, '安装向导关闭后应在 15 秒内退出');
  step('✅ 安装向导 GUI 冒烟：窗口启动并可正常关闭');
} finally {
  cleanupRegistry();
  cleanupRegistry(`HKCU\\Software\\CetaMeshInstallerTest\\fresh-${process.pid}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

step('✅ test-installer-productization: 全部检查通过');
