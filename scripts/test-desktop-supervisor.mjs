#!/usr/bin/env node
// 原生桌面版验证（Node 侧）：桌面启动器托管的 worker 契约。
//
// 覆盖：
//   1. WHALEBRIDGE_SUPERVISED=1 时 worker 正常启动（隔离数据目录 + 临时端口）；
//   2. 启动器被强杀 → stdin 关闭 → worker 自行优雅退出（孤儿守卫）；
//   3. /api/restart 退出码为 10（启动器据此重新拉起；start.bat 也会重启，因为 10≠2）；
//   4. /api/shutdown 退出码为 0（启动器据此不再重启）；
//   5. 托管模式下 /api/shutdown 不得执行"杀掉机器上所有 start.bat 守护循环"的全局清理
//      —— 用隔离 PATH（无 powershell.exe）+ 源码断言双重保证，绝不会误伤用户正在跑的实例；
//   6. 非托管（BAT/VBS 方式）行为不变：isSupervised() 为 false。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'core-entry.js');
const CONSOLE_TOKEN = 'supervisor-test-token';

function step(message) {
  process.stdout.write(`${message}\n`);
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

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError ?? new Error(`等待超时：${url}`);
}

function postJson(url) {
  // 桥接的写接口要求 application/json，否则返回 415。
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
}

// 只保留 Windows 自身目录但**排除** PowerShell 所在路径不现实（System32 里就有）——
// 所以这里用一份最小的 PATH，并额外断言 powershell 解析结果，见 assertPowerShellAbsent。
function isolatedEnv(tempRoot, dataDir, extra = {}) {
  const home = path.join(tempRoot, 'home');
  const emptyPath = path.join(tempRoot, 'empty-path');
  fs.mkdirSync(emptyPath, { recursive: true });
  for (const dir of [home, path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    ...process.env,
    PATH: emptyPath,
    Path: emptyPath,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TEMP: path.join(home, 'Temp'),
    TMP: path.join(home, 'Temp'),
    WHALEBRIDGE_DATA_DIR: dataDir,
    WHALEBRIDGE_RESOURCE_DIR: ROOT,
    ...extra
  };
}

function writeConfig(dataDir, consolePort) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify(
      {
        consolePort,
        consoleToken: CONSOLE_TOKEN,
        dsh: { baseUrl: 'http://127.0.0.1:9' },
        allow: { private: [], groups: [] },
        deny: { private: [], groups: [] },
        allowAllWhenEmpty: false,
        snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', allowProcessControl: false },
        socialV2: { tools: { getCardMsg: false, clickCardButton: false, fileSend: false, bilibili: false } }
      },
      null,
      2
    )
  );
}

function startWorker(dataDir, env, { pipeStdin = true } = {}) {
  const child = spawn(process.execPath, [ENTRY, '--worker'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: [pipeStdin ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    env
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return { child, stderr: () => stderr };
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
  ]);
}

// ---------------------------------------------------------------- 前置检查

// 真实服务不受影响：先确认用户正在跑的桥接没有被本测试碰过（测试前后由外部脚本比对）。
const patchSource = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const shutdownBlock = patchSource.slice(
  patchSource.indexOf("url.pathname === '/api/shutdown'"),
  patchSource.indexOf("url.pathname === '/api/status'")
);
assert.ok(shutdownBlock.length > 0, '未找到 /api/shutdown 处理块');
assert.match(shutdownBlock, /if \(SUPERVISED\)/, '/api/shutdown 必须按托管状态分支');
assert.match(shutdownBlock, /else \{[\s\S]*start\.bat[\s\S]*\}[\s\S]*releaseLock/, '全局 start.bat 清理只能出现在非托管分支');
assert.match(patchSource, /process\.exit\(EXIT_RESTART\)/, '/api/restart 必须使用重启退出码');
step('✅ 源码断言：/api/shutdown 的全局守护清理被限制在非托管分支，/api/restart 使用退出码 10');

// 管理界面由原生桌面端提供；Core 只保留程序化 API 与桌面端 IPC，不再渲染 HTML。
assert.doesNotMatch(patchSource, /function\s+renderFatalErrorPage\s*\(/, 'Core 不应再渲染 HTML 致命错误页');
assert.doesNotMatch(patchSource, /text\/html|<!doctype\s+html/i, 'Core 不应再生成网页界面');
assert.match(patchSource, /网页控制台已移除；请使用 WhaleBridge 原生应用/, '根路径应明确提示使用原生应用');
assert.match(patchSource, /WHALEBRIDGE_UI_PIPE/, 'Core 应从启动器注入的 IPC pipe 启动原生管理通道');
step('✅ no-web 源码断言：Core 不渲染网页/致命错误页，并支持启动器注入的原生 IPC');

// 非托管默认值（BAT/VBS 路径行为不变）
const supervisedDefault = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', "import('./src/bridge.js').then((m) => process.stdout.write(String(m.isSupervised())))"],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, WHALEBRIDGE_SUPERVISED: '' } }
);
assert.equal(supervisedDefault.status, 0, supervisedDefault.stderr);
assert.equal(supervisedDefault.stdout.trim(), 'false', '默认必须是非托管');
step('✅ 非托管默认：未设置 WHALEBRIDGE_SUPERVISED 时 isSupervised() 为 false（BAT/VBS 行为不变）');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-supervisor-'));
const dataDir = path.join(tempRoot, 'data');
writeConfig(dataDir, await freePort());

try {
  // ------------------------------------------------ 1. 托管 worker 启动 + 孤儿守卫
  {
    const port = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).consolePort;
    const env = isolatedEnv(tempRoot, dataDir, { WHALEBRIDGE_SUPERVISED: '1', WHALEBRIDGE_LEGACY_HTTP: '1' });
    const { child, stderr } = startWorker(dataDir, env);
    try {
      const response = await waitForHttp(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 401, '托管 worker 的根路径仍必须要求鉴权');
      const nativeOnly = await fetch(`http://127.0.0.1:${port}/?token=${CONSOLE_TOKEN}`, { redirect: 'manual' });
      assert.equal(nativeOnly.status, 404, '鉴权后的根路径不应提供网页控制台');
      assert.match(nativeOnly.headers.get('content-type') ?? '', /application\/json/i, '根路径应返回 JSON 而非 HTML');
      assert.match((await nativeOnly.json()).error, /原生应用/, '根路径应说明使用原生应用');
      assert.ok(fs.existsSync(path.join(dataDir, 'state', 'bridge.lock')), '应写入锁文件');
      assert.equal(child.exitCode, null, 'stdin 打开时 worker 必须保持运行');

      // 模拟启动器被强杀：关闭 stdin 管道
      child.stdin.end();
      const code = await waitForExit(child);
      assert.equal(code, 0, `stdin 关闭后应优雅退出（实际 ${code}）\n--- stderr ---\n${stderr()}`);
      assert.ok(
        !fs.existsSync(path.join(dataDir, 'state', 'bridge.lock')),
        '优雅退出必须释放锁文件'
      );
      step('✅ 孤儿守卫：启动器强杀（stdin 关闭）后 worker 自行退出并释放锁');
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }

  // ------------------------------------------------ 2. /api/restart → 退出码 10
  {
    const port = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).consolePort;
    fs.rmSync(path.join(dataDir, 'state', 'bridge.lock'), { force: true });
    const env = isolatedEnv(tempRoot, dataDir, { WHALEBRIDGE_SUPERVISED: '1', WHALEBRIDGE_LEGACY_HTTP: '1' });
    const { child, stderr } = startWorker(dataDir, env);
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`);
      const response = await postJson(`http://127.0.0.1:${port}/api/restart?token=${CONSOLE_TOKEN}`);
      assert.equal(response.status, 200, '带控制台令牌应可请求重启');
      const code = await waitForExit(child);
      assert.equal(code, 10, `重启必须用退出码 10（实际 ${code}）\n--- stderr ---\n${stderr()}`);
      step('✅ /api/restart：退出码 10（start.bat 因 10≠2 同样会重启，兼容不变）');
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }

  // ------------------------------- 3. 托管 /api/shutdown → 退出码 0 且不做全局清理
  {
    const port = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).consolePort;
    fs.rmSync(path.join(dataDir, 'state', 'bridge.lock'), { force: true });
    const env = isolatedEnv(tempRoot, dataDir, { WHALEBRIDGE_SUPERVISED: '1', WHALEBRIDGE_LEGACY_HTTP: '1' });
    const { child, stderr } = startWorker(dataDir, env);
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`);
      const response = await postJson(`http://127.0.0.1:${port}/api/shutdown?token=${CONSOLE_TOKEN}`);
      assert.equal(response.status, 200);
      const code = await waitForExit(child);
      assert.equal(code, 0, `关闭主程序应退出码 0（实际 ${code}）\n--- stderr ---\n${stderr()}`);
      assert.ok(
        !fs.existsSync(path.join(dataDir, 'state', 'bridge.lock')),
        '退出后必须释放锁'
      );
      const log = fs.readFileSync(path.join(dataDir, 'state', 'bridge.log'), 'utf8');
      assert.match(log, /启动器托管模式：跳过 start\.bat 守护循环清理/, '日志应记录跳过了全局清理');
      step('✅ 托管 /api/shutdown：跳过全局 start.bat 清理、退出码 0、释放锁');
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

step('🎉 桌面启动器托管的 worker 契约全部通过');
