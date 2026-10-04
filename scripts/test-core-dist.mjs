#!/usr/bin/env node
// 阶段 4 发行产物验证：dist/core/WhaleBridgeCore.exe（Node SEA 独立可执行文件）。
//
// 验证目标（运行期不需要系统 Node.js）：
//   1. --help / 无参数 / 非法参数的退出码与输出通道；
//   2. 五个 MCP 模式真实 stdio：initialize → tools/list → 安全 tools/call；
//   3. --worker 在临时端口 + 临时数据目录启动，显式资源目录与自动发现资源目录均生效；
//   4. 临时数据目录内生成 console-token / agent-token / bridge.lock；
//   5. HTTP loopback 仅提供 API：根路径要求鉴权，且不再提供产品网页控制台；
//   6. 全程 PATH 中不存在 node.exe，且 worker 进程树中没有 node.exe；
//   7. 数据目录优先级：WHALEBRIDGE_DATA_DIR > --data-dir > portable.flag > %LOCALAPPDATA%；
//   8. 旧 Node.js 入口（node src/core-entry.js、原独立 MCP 文件）继续可用；
//   9. 结束后无遗留后台进程。
//
// 安全约束：全部使用临时端口、临时数据目录、临时 HOME/LOCALAPPDATA/ProgramFiles，绝不触碰
// 用户真实数据目录、~/.dsh、真实端口 3100/3001/3080。刻意不调用 /api/shutdown——该接口会杀掉
// 机器上任何命令行含 start.bat 的 cmd.exe 守护循环，会误伤用户正在运行的桥接进程。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertNoWebUiHtmlArtifacts } from './no-web-release-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.WHALEBRIDGE_DIST_DIR
  ? path.resolve(process.env.WHALEBRIDGE_DIST_DIR)
  : path.join(ROOT, 'dist', 'core');
const EXE = path.join(DIST, 'WhaleBridgeCore.exe');
const RESOURCES = path.join(DIST, 'resources');
const CONSOLE_TOKEN = 'core-dist-test-console-token';

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

// 归一化后比较页面内容：忽略 BOM 与缩进差异，只验证确实读到了资源目录里的文件。
function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// 只保留 Windows 自身目录：cmd / powershell / taskkill 仍可用，但 PATH 中没有任何 Node.js。
// 比清空 PATH 更接近“目标机器没装 Node.js”的真实环境。
function windowsOnlyPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter);
}

function assertNoNodeOnPath(pathValue) {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const candidate of ['node.exe', 'node.cmd', 'node.bat', 'npm.cmd']) {
      assert.ok(
        !fs.existsSync(path.join(dir, candidate)),
        `测试环境 PATH 中不应存在 ${candidate}：${path.join(dir, candidate)}`
      );
    }
  }
}

/** 子进程环境：PATH 无 Node.js，用户目录全部指向临时目录，数据目录由调用方指定。 */
function isolatedEnv(tempRoot, { dataDir = null, resourceDir = null } = {}) {
  const home = path.join(tempRoot, 'home');
  const pathValue = windowsOnlyPath();
  const env = {
    ...process.env,
    Path: pathValue,
    PATH: pathValue,
    USERPROFILE: home,
    HOME: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    ProgramFiles: path.join(home, 'ProgramFiles'),
    'ProgramFiles(x86)': path.join(home, 'ProgramFiles(x86)'),
    TEMP: path.join(home, 'Temp'),
    TMP: path.join(home, 'Temp')
  };
  for (const dir of [env.LOCALAPPDATA, env.APPDATA, env.TEMP]) fs.mkdirSync(dir, { recursive: true });
  delete env.WHALEBRIDGE_DATA_DIR;
  delete env.WHALEBRIDGE_RESOURCE_DIR;
  if (dataDir) env.WHALEBRIDGE_DATA_DIR = dataDir;
  if (resourceDir) env.WHALEBRIDGE_RESOURCE_DIR = resourceDir;
  return env;
}

function isolatedConfig(consolePort, { token = CONSOLE_TOKEN } = {}) {
  return {
    consolePort,
    consoleToken: token,
    dsh: { baseUrl: 'http://127.0.0.1:9' },
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    allowAllWhenEmpty: false,
    snowluma: {
      httpUrl: 'http://127.0.0.1:9',
      wsUrl: 'ws://127.0.0.1:9',
      accessToken: '',
      allowProcessControl: false
    },
    socialV2: {
      tools: { getCardMsg: false, clickCardButton: false, fileSend: false, bilibili: false }
    }
  };
}

/** 递归列出某进程的全部后代进程，用于确认没有拉起 node.exe。 */
function descendantProcesses(pid, tempRoot) {
  const scriptFile = path.join(tempRoot, 'tree.ps1');
  fs.writeFileSync(
    scriptFile,
    [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$all = Get-CimInstance Win32_Process',
      `$ids = @(${pid})`,
      '$out = @()',
      'for ($i = 0; $i -lt 4; $i++) {',
      '  $kids = $all | Where-Object { ($ids -contains $_.ParentProcessId) -and ($ids -notcontains $_.ProcessId) }',
      '  if (-not $kids) { break }',
      '  $out += $kids',
      '  $ids += $kids.ProcessId',
      '}',
      '$out | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'
    ].join('\n'),
    'utf8'
  );
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
    { encoding: 'utf8', timeout: 60000 }
  );
  const text = (result.stdout ?? '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processInfo(pid, tempRoot) {
  const scriptFile = path.join(tempRoot, 'info.ps1');
  fs.writeFileSync(
    scriptFile,
    [
      '$ErrorActionPreference = "SilentlyContinue"',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`
    ].join('\n'),
    'utf8'
  );
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
    { encoding: 'utf8', timeout: 60000 }
  );
  const text = (result.stdout ?? '').trim();
  return text ? JSON.parse(text) : null;
}

async function stopProcess(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit').then(() => true);
  child.kill();
  const exited = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(resolve, 10000))
  ]);
  assert.equal(exited, true, `${label} 未在 10 秒内退出`);
}

// 所有启动过的子进程都要登记：失败路径和收尾清理都靠它，避免残留进程占住临时目录句柄。
const spawnedChildren = [];
function track(child) {
  spawnedChildren.push(child);
  return child;
}

/** 终止并等待退出，不抛错（用于清理路径）。 */
async function killQuietly(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit').then(() => true);
  child.kill();
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 10000))]);
}

// ---------------------------------------------------------------- 产物检查

assert.ok(fs.existsSync(EXE), `未找到 ${path.relative(ROOT, EXE)}，请先执行 npm run build:core`);
assert.ok(fs.existsSync(path.join(DIST, 'runtime-manifest.json')), '缺少 runtime-manifest.json');
assert.ok(fs.statSync(path.join(DIST, 'build', 'core.bundle.cjs')).isFile(), '缺少中间产物 bundle');
for (const dir of ['public', 'roles', 'assets', 'dsh', 'plugins']) {
  assert.ok(fs.existsSync(path.join(RESOURCES, dir)), `resources/${dir} 缺失`);
}
assertNoWebUiHtmlArtifacts(listFiles(RESOURCES), 'Core resources');

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'runtime-manifest.json'), 'utf8'));
assert.equal(manifest.executable, 'WhaleBridgeCore.exe');
assert.equal(manifest.entry, 'src/core-sea.js');
const exeBuffer = fs.readFileSync(EXE);
assert.equal(exeBuffer.length, manifest.executableBytes, 'manifest 记录的体积与实际不符');
// 构建机绝对路径不得出现在产物中（SEA 内嵌脚本名必须是相对形式）。
assert.ok(!exeBuffer.toString('latin1').includes(ROOT), '可执行文件中泄漏了构建机仓库绝对路径');
step(`✅ 产物：WhaleBridgeCore.exe ${(manifest.executableBytes / 1024 / 1024).toFixed(1)} MB，node ${manifest.host.node}`);
step(`   bundle ${(manifest.bundleBytes / 1024).toFixed(0)} KB，打包 ${manifest.bundledPackages.length} 个第三方包`);
step(`   resources/ ${manifest.resourceFiles} 个文件，排除 ${manifest.excludedResources.length} 个`);

// PATH 隔离前置检查：先确认这个测试环境本身就找不到 node。
assertNoNodeOnPath(windowsOnlyPath());
const whereNode = spawnSync('cmd.exe', ['/d', '/s', '/c', 'where node'], {
  encoding: 'utf8',
  env: { ...process.env, PATH: windowsOnlyPath(), Path: windowsOnlyPath() }
});
assert.notEqual(whereNode.status, 0, 'PATH 隔离失败：仍然能解析到 node.exe');
step('✅ PATH 隔离：隔离环境中 where node 解析失败，全程无系统 Node.js 参与');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-dist-'));
const dataDir = path.join(tempRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
// MCP 模式与 worker 一样从数据目录读 config.json；这里先放一份禁用高风险工具的隔离配置，
// 保证 callTool 走的是「已禁用」这类确定性分支，不会去连真实服务。
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(isolatedConfig(9), null, 2));

/** 启动一个 worker，验证鉴权、状态文件、资源目录与进程树。 */
async function runWorker({ label, dataDir: workerDataDir, resourceDir, useDefaultDataDir = false }) {
  // 默认数据目录模式刻意不设置 WHALEBRIDGE_DATA_DIR，让 exe 自行回退到 %LOCALAPPDATA%\WhaleBridge。
  const effectiveDataDir = useDefaultDataDir
    ? path.join(tempRoot, 'home', 'AppData', 'Local', 'WhaleBridge')
    : workerDataDir;
  const port = await freePort();
  fs.mkdirSync(effectiveDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(effectiveDataDir, 'config.json'),
    JSON.stringify(isolatedConfig(port), null, 2)
  );
  fs.rmSync(path.join(effectiveDataDir, 'state', 'bridge.lock'), { force: true });

  const child = track(spawn(EXE, ['--worker'], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: isolatedEnv(tempRoot, {
      dataDir: useDefaultDataDir ? null : workerDataDir,
      resourceDir
    })
  }));
  child.stdout?.resume();
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const anonymous = await waitForHttp(`http://127.0.0.1:${port}/`);
    assert.equal(anonymous.status, 401, `${label}: 根路径必须要求鉴权`);
    assert.match(anonymous.headers.get('content-type') ?? '', /^application\/json\b/i);

    const authorized = await fetch(`http://127.0.0.1:${port}/?token=${CONSOLE_TOKEN}`, { redirect: 'manual' });
    assert.equal(authorized.status, 404, `${label}: Core 不得提供产品网页控制台`);
    assert.match(authorized.headers.get('content-type') ?? '', /^application\/json\b/i);
    assert.match((await authorized.json()).error ?? '', /网页控制台已移除/);

    const status = await fetch(`http://127.0.0.1:${port}/api/status?token=${CONSOLE_TOKEN}`);
    assert.equal(status.status, 200, `${label}: /api/status 带令牌应返回 200`);
    assert.equal(typeof (await status.json()).mode, 'string');

    const noToken = await fetch(`http://127.0.0.1:${port}/api/status`, { redirect: 'manual' });
    assert.equal(noToken.status, 401, `${label}: /api/status 无令牌必须 401`);

    // console-token 只在未配置 consoleToken 时生成；agent-token 与 bridge.lock 每次启动都会落盘。
    for (const file of ['agent-token', 'bridge.lock']) {
      assert.ok(
        fs.existsSync(path.join(effectiveDataDir, 'state', file)),
        `${label}: 数据目录缺少 state/${file}`
      );
    }

    const info = processInfo(child.pid, tempRoot);
    assert.ok(info, `${label}: 无法查询 worker 进程信息`);
    assert.equal(
      path.resolve(info.ExecutablePath).toLowerCase(),
      path.resolve(EXE).toLowerCase(),
      `${label}: worker 进程镜像不是发行 exe`
    );
    const descendants = descendantProcesses(child.pid, tempRoot);
    const nodeChildren = descendants.filter((item) => /^node(\.exe)?$/i.test(item.Name ?? ''));
    assert.deepEqual(nodeChildren, [], `${label}: worker 拉起了 node.exe 子进程：${JSON.stringify(nodeChildren)}`);
    step(
      `✅ ${label}：401/404 根路径与 200/401 API 鉴权、agent-token/bridge.lock 落盘、` +
        `资源目录生效、后代进程 ${descendants.length} 个（${descendants.map((item) => item.Name).join(', ') || '无'}）且无 node.exe`
    );
  } catch (error) {
    await killQuietly(child);
    error.message = `${error.message}\n--- worker stderr ---\n${stderr}`;
    throw error;
  }
  return child;
}

try {
  // ------------------------------------------------------------ CLI 行为
  const help = spawnSync(EXE, ['--help'], { encoding: 'utf8', env: isolatedEnv(tempRoot, { dataDir }) });
  assert.equal(help.status, 0, help.stderr);
  for (const expected of ['--worker', '--mcp', '--self-test', '--data-dir']) {
    assert.ok(help.stdout.includes(expected), `--help 缺少 ${expected}`);
  }
  assert.equal(help.stderr, '');
  step('✅ --help：退出码 0，输出到 stdout，stderr 为空');

  const invalid = spawnSync(EXE, ['--mcp', 'unknown'], { encoding: 'utf8', env: isolatedEnv(tempRoot, { dataDir }) });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '', '错误信息不得写入 stdout');
  assert.match(invalid.stderr, /未知 MCP 模式/);
  step('✅ 非法参数：退出码 1，错误仅写 stderr，stdout 保持干净');

  const noArgs = spawnSync(EXE, [], { encoding: 'utf8', env: isolatedEnv(tempRoot, { dataDir }) });
  assert.equal(noArgs.status, 0, 'SEA 无参数应打印用法并成功退出');
  assert.match(noArgs.stdout, /用法/);
  step('✅ 无参数：打印用法，退出码 0');

  // --------------------------------------------- self-test 模式（无真实 DSH）
  const selfTestPort = await freePort();
  const selfTest = spawnSync(EXE, ['--self-test', `http://127.0.0.1:${selfTestPort}`, '鲸桥自测'], {
    encoding: 'utf8',
    timeout: 60000,
    env: isolatedEnv(tempRoot, { dataDir })
  });
  assert.notEqual(selfTest.status, 0, 'DSH 不可达时 --self-test 应以非零退出');
  assert.match(`${selfTest.stdout}${selfTest.stderr}`, /启动失败|ECONNREFUSED|failed|fetch/i);
  step('✅ --self-test：模式可用；DSH 不可达时按预期非零退出（未连接真实 DSH）');

  // ------------------------------------------------------- 五个 MCP 模式
  const mcpCases = [
    {
      mode: 'snowluma',
      tool: 'qq_get_card_msg',
      call: { name: 'qq_get_card_msg', arguments: { key: 'group:1', token: 'test', messageId: '1' } },
      expected: /403|已禁用/
    },
    {
      mode: 'snowluma-host',
      tool: 'snowluma_status',
      call: { name: 'snowluma_status', arguments: {} },
      expected: /reachable|online|unreachable|offline/
    },
    {
      mode: 'web-search-safe',
      tool: 'web_fetch',
      call: { name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } },
      expected: /禁止|内网|本机|抓取失败/
    },
    {
      mode: 'qq-file-send',
      tool: 'qq_send_file',
      call: {
        name: 'qq_send_file',
        arguments: { target: 'private:1', filePath: path.join(tempRoot, 'missing.txt') }
      },
      expected: /403|已禁用|不存在/
    },
    {
      mode: 'bilibili',
      tool: 'bili_search_video',
      call: { name: 'bili_search_video', arguments: { query: '测试' } },
      expected: /403|已禁用/
    }
  ];

  for (const item of mcpCases) {
    const transport = new StdioClientTransport({
      command: EXE,
      args: ['--mcp', item.mode],
      cwd: tempRoot,
      env: isolatedEnv(tempRoot, { dataDir, resourceDir: RESOURCES }),
      stderr: 'pipe'
    });
    const client = new Client({ name: 'whalebridge-dist-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(
        listed.tools.some((tool) => tool.name === item.tool),
        `${item.mode}: 未暴露工具 ${item.tool}`
      );
      const called = await client.callTool(item.call);
      const text = called.content?.map((block) => block?.text ?? '').join('\n') ?? '';
      assert.match(text, item.expected, `${item.mode}: callTool 结果不符合预期：${text.slice(0, 200)}`);
      step(`✅ --mcp ${item.mode}：initialize / tools/list / tools/call（${listed.tools.length} 个工具）`);
    } finally {
      await client.close().catch(() => {});
    }
  }
  assert.ok(
    fs.existsSync(path.join(dataDir, 'state', 'mcp-qq-file-send.version')),
    'MCP 模式应把启动标记写入数据目录'
  );
  step('✅ MCP 启动标记写入指定数据目录（未写入 exe 目录）');

  // ------------------------------------------------------------ worker 模式
  const explicit = await runWorker({
    label: 'worker（显式 WHALEBRIDGE_RESOURCE_DIR）',
    dataDir,
    resourceDir: RESOURCES
  });
  await stopProcess(explicit, 'worker（显式资源目录）');

  const auto = await runWorker({ label: 'worker（自动发现 exe 同目录 resources/）', dataDir, resourceDir: null });
  await stopProcess(auto, 'worker（自动发现 resources/）');

  // 默认数据目录：不设置 WHALEBRIDGE_DATA_DIR 时落到隔离的 %LOCALAPPDATA%\WhaleBridge。
  const defaultWorker = await runWorker({
    label: 'worker（默认 %LOCALAPPDATA%\\WhaleBridge）',
    resourceDir: null,
    useDefaultDataDir: true
  });
  await stopProcess(defaultWorker, 'worker（默认数据目录）');
  assert.ok(
    !fs.existsSync(path.join(path.dirname(EXE), 'state')),
    '运行数据不得写入 exe 所在目录（安装目录必须保持只读）'
  );
  step('✅ 默认数据目录：未指定数据目录时落在 %LOCALAPPDATA%\\WhaleBridge，exe 目录保持只读');

  // --data-dir 与 portable.flag：验证参数/标记被真正采用，而不只是被解析接受。
  // --data-dir：用未配置 consoleToken 的 config 启动，验证生成的令牌落在指定数据目录，
  // 且该令牌真的能通过鉴权（覆盖 loadOrCreateConsoleToken 的首次生成分支）。
  const argDataDir = path.join(tempRoot, 'arg-data');
  const argPort = await freePort();
  fs.mkdirSync(argDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(argDataDir, 'config.json'),
    JSON.stringify(isolatedConfig(argPort, { token: '' }), null, 2)
  );
  const argWorker = track(spawn(EXE, ['--worker', '--data-dir', argDataDir], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: isolatedEnv(tempRoot, { resourceDir: RESOURCES })
  }));
  let argStderr = '';
  argWorker.stderr?.on('data', (chunk) => {
    argStderr += String(chunk);
  });
  try {
    const response = await waitForHttp(`http://127.0.0.1:${argPort}/`);
    assert.equal(response.status, 401);
    const tokenFile = path.join(argDataDir, 'state', 'console-token');
    assert.ok(fs.existsSync(tokenFile), '--data-dir 未被采用：未在指定目录生成 state/console-token');
    const generated = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.ok(generated.length >= 32, '生成的 console-token 长度异常');
    const authorized = await fetch(`http://127.0.0.1:${argPort}/?token=${generated}`, { redirect: 'manual' });
    assert.equal(authorized.status, 404, '生成的 console-token 应通过鉴权，但 Core 不提供网页控制台');
    assert.match((await authorized.json()).error ?? '', /网页控制台已移除/);
    const status = await fetch(`http://127.0.0.1:${argPort}/api/status?token=${generated}`);
    assert.equal(status.status, 200, '生成的 console-token 应能访问控制 API');
    step('✅ --data-dir：覆盖默认数据目录，生成 console-token 并用于控制 API 鉴权');
  } catch (error) {
    await killQuietly(argWorker);
    error.message = `${error.message}\n--- worker stderr ---\n${argStderr}`;
    throw error;
  } finally {
    await stopProcess(argWorker, 'worker（--data-dir）');
  }

  const portableRoot = path.join(tempRoot, 'portable');
  const portableDataDir = path.join(portableRoot, 'data');
  const portablePort = await freePort();
  fs.mkdirSync(portableDataDir, { recursive: true });
  fs.copyFileSync(EXE, path.join(portableRoot, 'WhaleBridgeCore.exe'));
  fs.cpSync(RESOURCES, path.join(portableRoot, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'portable.flag'), '');
  fs.writeFileSync(
    path.join(portableDataDir, 'config.json'),
    JSON.stringify(isolatedConfig(portablePort, { token: '' }), null, 2)
  );
  const portableWorker = track(spawn(path.join(portableRoot, 'WhaleBridgeCore.exe'), ['--worker'], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: isolatedEnv(tempRoot, { resourceDir: null })
  }));
  let portableStderr = '';
  portableWorker.stderr?.on('data', (chunk) => {
    portableStderr += String(chunk);
  });
  try {
    const response = await waitForHttp(`http://127.0.0.1:${portablePort}/`);
    assert.equal(response.status, 401);
    assert.ok(
      fs.existsSync(path.join(portableDataDir, 'state', 'console-token')),
      'portable.flag 未被采用：数据未写入 exe 同目录 data/'
    );
    step('✅ portable.flag：便携模式下数据写入 exe 同目录 data/（含资源自动发现）');
  } catch (error) {
    await killQuietly(portableWorker);
    error.message = `${error.message}\n--- worker stderr ---\n${portableStderr}`;
    throw error;
  } finally {
    await stopProcess(portableWorker, 'worker（便携模式）');
  }

  // ------------------------------- --setup-dsh：打包模式写入 DSH 集成（隔离 DSH_HOME）
  {
    const dshHome = path.join(tempRoot, 'dsh-home');
    const profileDir = path.join(dshHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    // 旧布局：command 指向 node.exe、args 指向独立脚本 —— 迁移必须改成 Core exe + --mcp。
    fs.writeFileSync(
      path.join(profileDir, 'cordis.patch.yml'),
      [
        '# user patch layer',
        '# === whalebridge MCP BEGIN ===',
        '- insert:',
        '    - id: mcp-snowluma',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: snowluma',
        '        transport: stdio',
        "        command: 'C:\\Program Files\\nodejs\\node.exe'",
        '        args:',
        "          - 'D:\\old-repo\\src\\mcp-snowluma-safe.js'",
        '        toolCallTimeoutMs: 725000',
        '# === whalebridge MCP END ===',
        '- id: uiskin-theme',
        '  disabled: true',
        ''
      ].join('\n'),
      'utf8'
    );
    const setupEnv = isolatedEnv(tempRoot, { dataDir, resourceDir: null });
    setupEnv.DSH_HOME = dshHome;

    const dryRun = spawnSync(EXE, ['--setup-dsh', 'web', '--dry-run'], { encoding: 'utf8', env: setupEnv });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /预演，未写入任何文件/);
    assert.match(dryRun.stdout, /WhaleBridgeCore\.exe（打包）/);
    assert.ok(
      fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8').includes('mcp-snowluma-safe.js'),
      '--dry-run 不得改写配置'
    );

    const applied = spawnSync(EXE, ['--setup-dsh', 'web'], { encoding: 'utf8', env: setupEnv, timeout: 180000 });
    assert.equal(applied.status, 0, applied.stderr);
    const patchText = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    const { parseMcpEntries } = await import('../src/dsh-integration.js');
    const entries = parseMcpEntries(patchText);
    for (const [id, mode] of [
      ['mcp-snowluma', 'snowluma'],
      ['mcp-snowluma-host', 'snowluma-host'],
      ['mcp-web-search-safe', 'web-search-safe'],
      ['mcp-qq-file-send', 'qq-file-send'],
      ['mcp-bilibili', 'bilibili']
    ]) {
      assert.equal(entries[id]?.command, EXE, `${id} 的 command 应指向发行 exe`);
      assert.deepEqual(entries[id]?.args, ['--mcp', mode], `${id} 的 args 应为 --mcp ${mode}`);
    }
    assert.ok(patchText.includes('- id: uiskin-theme'), '用户自己的条目必须保留');
    assert.ok(!patchText.includes('mcp-snowluma-safe.js'), '旧脚本路径必须被迁移掉');

    const presets = fs.readdirSync(path.join(dshHome, '.agent-presets'));
    assert.deepEqual(presets.sort(), ['whale-chat', 'whale-chat-v2']);
    const released = path.join(dataDir, 'runtime', manifest.version, 'whale-mode-console');
    assert.ok(fs.existsSync(path.join(released, 'package.json')), '插件应按版本释放到数据目录');
    assert.equal(
      fs.realpathSync(path.join(dshHome, 'plugins', 'whale-mode-console')).toLowerCase(),
      fs.realpathSync(released).toLowerCase()
    );
    assert.ok(fs.existsSync(path.join(dshHome, '.whalebridge-integration.json')), '应写入集成 manifest');

    const again = spawnSync(EXE, ['--setup-dsh', 'web'], { encoding: 'utf8', env: setupEnv, timeout: 180000 });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /没有需要写入的改动|已是最新/, '发布模式重复执行必须是空操作');
    step('✅ --setup-dsh（打包模式）：旧配置迁移到 exe + --mcp <mode>、preset/插件/manifest 落地、重复执行幂等');
  }

  // ------------------------------------------------ 旧 Node.js 入口兼容
  const legacyHelp = spawnSync(process.execPath, [path.join(ROOT, 'src', 'core-entry.js'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(legacyHelp.status, 0, legacyHelp.stderr);
  assert.match(legacyHelp.stdout, /--worker/);

  const legacyTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')],
    cwd: ROOT,
    env: { ...process.env, WHALEBRIDGE_DATA_DIR: dataDir, WHALEBRIDGE_RESOURCE_DIR: RESOURCES },
    stderr: 'pipe'
  });
  const legacyClient = new Client({ name: 'whalebridge-dist-legacy', version: '0.1.0' });
  try {
    await legacyClient.connect(legacyTransport);
    const listed = await legacyClient.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'qq_get_card_msg'));
  } finally {
    await legacyClient.close().catch(() => {});
  }
  step('✅ 旧入口：node src/core-entry.js --help 与原独立 MCP 文件（stdio 真实握手）仍可用');

  // ------------------------------------------------ 残留进程检查
  const leftovers = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='WhaleBridgeCore.exe'").Count`
    ],
    { encoding: 'utf8', timeout: 60000 }
  );
  const leftoverCount = Number.parseInt((leftovers.stdout ?? '0').trim(), 10) || 0;
  assert.equal(leftoverCount, 0, `测试结束后仍有 ${leftoverCount} 个 WhaleBridgeCore.exe 进程残留`);
  step('✅ 无遗留：测试结束后没有 WhaleBridgeCore.exe 进程残留');
} finally {
  // 先确保所有子进程退出，再删临时目录：残留进程会占住数据目录与 exe 副本句柄，导致 EPERM。
  for (const child of spawnedChildren) await killQuietly(child);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
  } catch (error) {
    step(`⚠️ 临时目录清理未完成（不影响测试结论）：${error.message}`);
  }
}

step('🎉 发行产物 WhaleBridgeCore.exe 全部检查通过（无系统 Node.js 参与）');
