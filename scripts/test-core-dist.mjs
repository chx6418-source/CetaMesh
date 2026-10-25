#!/usr/bin/env node
// 阶段 4 发行产物验证：dist/core/WhaleBridgeCore.exe（Node SEA 独立可执行文件）。
//
// 验证目标（运行期不需要系统 Node.js）：
//   1. --help / 无参数 / 非法参数的退出码与输出通道；
//   2. 五个 MCP 模式真实 stdio：initialize → tools/list → 安全 tools/call；
//   3. --worker 在临时端口 + 临时数据目录启动，显式资源目录与自动发现资源目录均生效；
//   4. 临时数据目录内生成 agent-token / .core-owner.lock；
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStdioMcpConnection } from '../src/integrations/mcp-runtime.js';
import { assertNoWebUiHtmlArtifacts } from './no-web-release-policy.mjs';
import { resolveDataPipeName, dataCall } from '../src/control/data-ipc.js';
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from '../src/storage/json-file.js';
import { probeProcessIdentity } from '../src/app/process-identity.js';

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

// D1 行为契约：发行 worker 不监听 loopback HTTP，就绪探测与数据请求都走数据面 IPC。
async function waitForDataIpc(dataRoot, { timeoutMs = 30000 } = {}) {
  const pipeName = resolveDataPipeName({ dataRoot });
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const token = fs.readFileSync(path.join(dataRoot, 'state', 'agent-token'), 'utf8').trim();
      if (!token) throw new Error('Data IPC credential is not initialized yet');
      const res = await dataCall({ path: '/api/status', token, timeoutMs: 3000, pipeName });
      if (!res.ok) throw new Error(`Data IPC is not authenticated/ready (status ${res.status})`);
      return { pipeName, token, res };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError ?? new Error(`数据面 IPC 等待超时：${pipeName}`);
}

/** 反复探测 consolePort：发行 worker 必须始终拒绝连接（不是 401/403 —— 是没有 server）。 */
async function assertTcpAlwaysRefused(port, label, { attempts = 5, intervalMs = 400 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const outcome = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve({ connected: true, code: null }); });
      socket.once('error', (error) => { socket.destroy(); resolve({ connected: false, code: error.code }); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve({ connected: false, code: 'ETIMEDOUT' }); });
    });
    assert.equal(
      outcome.connected, false,
      `${label}: worker 在 consolePort ${port} 上监听了 HTTP（第 ${i + 1} 次探测连上了）——发行版禁止启动 HTTP 面`
    );
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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

function directoryContents(dir) {
  return listFiles(dir).map((relative) => [
    relative,
    fs.readFileSync(path.join(dir, relative)).toString('base64')
  ]);
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
  if (child.stdin?.writable) child.stdin.end();
  else child.kill();
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
assert.equal(listFiles(RESOURCES).some(file => file.endsWith('send-test-group.mjs')), false,
  'development-only QQ direct-send diagnostic must never enter SEA resources');
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
async function runWorker({ label, dataDir: workerDataDir, resourceDir, useDefaultDataDir = false, supervised = false }) {
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

  const child = track(spawn(EXE, ['--worker'], {
    cwd: tempRoot,
    windowsHide: true,
    stdio: [supervised ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv(tempRoot, {
        dataDir: useDefaultDataDir ? null : workerDataDir,
        resourceDir
      }),
      ...(supervised ? { WHALEBRIDGE_SUPERVISED: '1' } : {})
    }
  }));
  child.stdout?.resume();
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    // D1 契约：发行 worker 不监听 consolePort。就绪与数据请求全部走数据面 IPC。
    const { res } = await waitForDataIpc(effectiveDataDir);
    assert.equal(res.ok, true, `${label}: 数据面 IPC /api/status 应可用`);
    assert.equal(typeof res.json?.mode, 'string', `${label}: /api/status 应返回运行模式`);
    assert.equal(res.json?.tokenModel, 'service-only', `${label}: Core 数据面仅持有服务令牌`);

    await assertTcpAlwaysRefused(port, label);

    // Core 不生成 Legacy console-token；只创建自身的服务令牌与所有权锁。
    for (const file of ['agent-token', '.core-owner.lock']) {
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
      `✅ ${label}：数据面 IPC /api/status 200、consolePort 拒连（无 HTTP server）、agent-token/.core-owner.lock 落盘、` +
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
  const officialLinks = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'release-config.json'), 'utf8')).productLinks;
  assert.equal(officialLinks.officialUrls.website, 'https://cetamesh.com', 'release resources carry the canonical official website');
  assert.equal(officialLinks.paths.docs, null, 'unconfirmed official pages stay centrally unconfigured');
  step('✅ release-config.json 随 Core resources 分发并保留唯一官网根地址');

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
      entry: 'src/mcp-snowluma-safe.js',
      tool: 'qq_get_card_msg',
      call: { name: 'qq_get_card_msg', arguments: { key: 'group:1', token: 'test', messageId: '1' } },
      expected: /403|已禁用|TOOL_DISABLED|已被关闭/
    },
    {
      mode: 'snowluma-host',
      entry: 'src/mcp-host-server.js',
      tool: 'snowluma_status',
      call: { name: 'snowluma_status', arguments: {} },
      expected: /reachable|online|unreachable|offline/
    },
    {
      mode: 'web-search-safe',
      entry: 'src/mcp-web-search-safe.js',
      tool: 'web_fetch',
      call: { name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } },
      expected: /禁止|内网|本机|抓取失败/
    },
    {
      mode: 'qq-file-send',
      entry: 'src/mcp-qq-file-send.js',
      tool: 'qq_send_file',
      call: {
        name: 'qq_send_file',
        arguments: { target: 'private:1', filePath: path.join(tempRoot, 'missing.txt') }
      },
      expected: /403|已禁用|不存在|TOOL_DISABLED|已被关闭/
    },
    {
      mode: 'bilibili',
      entry: 'src/mcp-bilibili.js',
      tool: 'bili_search_video',
      call: { name: 'bili_search_video', arguments: { query: '测试' } },
      expected: /403|已禁用|TOOL_DISABLED|已被关闭/
    }
  ];

  const installedRoot = path.join(tempRoot, 'CetaMesh Installed');
  const installedResources = path.join(installedRoot, 'resources');
  const installedExe = path.join(installedRoot, 'WhaleBridgeCore.exe');
  fs.mkdirSync(installedRoot, { recursive: true });
  fs.copyFileSync(EXE, installedExe);
  fs.cpSync(RESOURCES, installedResources, { recursive: true });
  for (const item of mcpCases) {
    const isolated = isolatedEnv(tempRoot, { dataDir, resourceDir: installedResources });
    const diagnostics = [];
    const connection = await createStdioMcpConnection({ id: item.mode, entry: item.entry },
      { cwd: installedRoot, env: isolated },
      { packaged: true, execPath: installedExe, sourceRoot: ROOT, env: isolated, log: line => diagnostics.push(line) });
    try {
      const listed = await connection.listTools();
      assert.ok(listed.some(tool => tool.name === item.tool), `${item.mode}: 未暴露工具 ${item.tool}`);
      const called = await connection.callTool(item.call.name, item.call.arguments);
      const text = called.content?.map(block => block?.text ?? '').join('\n') ?? '';
      assert.match(text, item.expected, `${item.mode}: callTool 结果不符合预期：${text.slice(0, 200)}`);
      assert.ok(diagnostics.some(line => line.includes('"phase":"initialized"')));
      assert.ok(diagnostics.some(line => line.includes('"phase":"tools/list"')));
      step(`✅ 安装目录下 --mcp ${item.mode}：Host initialize / tools/list / tools/call（${listed.length} 个工具）`);
    } finally {
      await connection.close();
    }
  }
  assert.ok(
    fs.existsSync(path.join(dataDir, 'state', 'mcp-qq-file-send.version')),
    'MCP 模式应把启动标记写入数据目录'
  );
  step('✅ MCP 启动标记写入指定数据目录（未写入 exe 目录）');

  // ------------------------------------------------------------ worker 模式
  // The stale lease names this still-alive test process, so a PID-only SEA
  // would reject startup. Its bound birth differs by one exact Windows tick.
  const testBirth = probeProcessIdentity(process.pid);
  assert.equal(testBirth.state, 'alive', 'PID-reuse fixture requires a verifiable alive test process');
  assert.equal(testBirth.identity?.kind, 'windows-start-time-utc');
  const staleBirth = { ...testBirth.identity, value: (BigInt(testBirth.identity.value) - 1n).toString() };
  assert.notEqual(staleBirth.value, testBirth.identity.value);
  const ownerFile = path.join(dataDir, 'state', '.core-owner.lock');
  const identityFile = path.join(dataDir, 'state', '.core-owner.identity.json');
  const staleLease = `${process.pid}:${'a'.repeat(32)}`;
  writeTextAtomic(ownerFile, staleLease);
  writeJsonAtomic(identityFile, {
    version: 1,
    pid: process.pid,
    lockHash: crypto.createHash('sha256').update(staleLease).digest('hex'),
    processIdentity: staleBirth
  });
  const explicit = await runWorker({
    label: 'worker（显式 WHALEBRIDGE_RESOURCE_DIR / PID复用恢复）',
    dataDir,
    resourceDir: RESOURCES,
    supervised: true
  });
  const acquiredLease = fs.readFileSync(ownerFile, 'utf8');
  const acquiredMetadata = fs.readFileSync(identityFile, 'utf8');
  const acquiredIdentity = readJsonFile(identityFile);
  assert.match(acquiredLease, new RegExp(`^${explicit.pid}:[a-f0-9]{32}$`), 'SEA must replace the stale PID lease with its own legacy-compatible lock');
  assert.notEqual(acquiredLease, staleLease);
  assert.equal(acquiredIdentity.version, 1);
  assert.equal(acquiredIdentity.pid, explicit.pid);
  assert.equal(acquiredIdentity.lockHash, crypto.createHash('sha256').update(acquiredLease).digest('hex'));
  const workerBirth = probeProcessIdentity(explicit.pid);
  assert.equal(workerBirth.state, 'alive', 'the recovered SEA worker must still be alive');
  assert.deepEqual(acquiredIdentity.processIdentity, workerBirth.identity, 'SEA must publish its own exact OS birth identity');
  assert.equal(fs.existsSync(ownerFile + '.reclaim'), false, 'SEA recovery must release its recovery guard');
  const duplicate = spawnSync(EXE, ['--worker'], {
    cwd: tempRoot, windowsHide: true, encoding: 'utf8', timeout: 15000,
    env: isolatedEnv(tempRoot, { dataDir, resourceDir: RESOURCES })
  });
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.status, 2, 'a second SEA worker must reject the active owner');
  assert.match(duplicate.stderr, /Another Core owns this StateDir|STATE_DIR_BUSY/);
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), acquiredLease, 'rejected duplicate must preserve the live lease');
  assert.equal(fs.readFileSync(identityFile, 'utf8'), acquiredMetadata, 'rejected duplicate must preserve live identity metadata');
  assert.equal((await waitForDataIpc(dataDir)).res.ok, true, 'the first SEA worker must retain authenticated IPC');
  step('✅ SEA PID复用：回收出生身份不符的活PID旧锁、发布自身绑定身份，重复实例拒绝且原IPC保持可用');
  // Only the disposable test's token file is changed. The running worker keeps
  // its original token; readiness must wait for the reader's credential to settle.
  const fixtureTokenFile = path.join(dataDir, 'state', 'agent-token');
  const fixtureToken = fs.readFileSync(fixtureTokenFile, 'utf8');
  for (const transient of ['', 'fixture-wrong-service-token']) {
    writeTextAtomic(fixtureTokenFile, transient);
    const restored = new Promise(resolve => setTimeout(() => { writeTextAtomic(fixtureTokenFile, fixtureToken); resolve(); }, 100));
    try {
      const { res } = await waitForDataIpc(dataDir);
      assert.equal(res.ok, true, `readiness must await authenticated success, not HTTP ${res.status}`);
    } finally { await restored; }
  }
  writeTextAtomic(fixtureTokenFile, 'fixture-persistently-wrong-token');
  try {
    await assert.rejects(waitForDataIpc(dataDir, { timeoutMs: 500 }), /not authenticated\/ready/,
      'persistent authentication failure must still fail readiness within its bound');
  } finally { writeTextAtomic(fixtureTokenFile, fixtureToken); }
  step('✅ 数据面就绪等待：空令牌/暂时401不能误作ready，成功后仍须通过原鉴权断言');
  await stopProcess(explicit, 'worker（显式资源目录）');
  assert.equal(explicit.exitCode, 0, 'supervisor EOF must stop the recovered SEA worker cleanly');
  for (const file of [ownerFile, identityFile, ownerFile + '.reclaim']) {
    assert.equal(fs.existsSync(file), false, 'controlled SEA shutdown must remove its owned lease and identity metadata');
  }
  step('✅ SEA受控退出：supervisor stdin EOF 后正常退出，所有权锁、身份元数据和恢复锁均无遗留');

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
    // 就绪与鉴权验证都走数据面 IPC（发行 worker 没有 HTTP 面可探测）。
    await waitForDataIpc(argDataDir);
    const tokenFile = path.join(argDataDir, 'state', 'agent-token');
    assert.ok(fs.existsSync(tokenFile), '--data-dir 未被采用：未在指定目录生成 state/agent-token');
    const generated = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.ok(generated.length >= 32, '生成的 agent-token 长度异常');
    const status = await dataCall({ path: '/api/status', token: generated, timeoutMs: 5000, pipeName: resolveDataPipeName({ dataRoot: argDataDir }) });
    assert.equal(status.ok, true, '生成的 agent-token 应能访问 Core 健康接口');
    await assertTcpAlwaysRefused(argPort, 'worker（--data-dir）');
    step('✅ --data-dir：覆盖默认数据目录，生成 agent-token 并经数据面 IPC 通过鉴权');
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
    await waitForDataIpc(portableDataDir);
    assert.ok(
      fs.existsSync(path.join(portableDataDir, 'state', 'agent-token')),
      'portable.flag 未被采用：数据未写入 exe 同目录 data/'
    );
    await assertTcpAlwaysRefused(portablePort, 'worker（便携模式）');
    step('✅ portable.flag：便携模式下数据写入 exe 同目录 data/（含资源自动发现），且不监听 consolePort');
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
    const pluginPath = path.join(dshHome, 'plugins', 'whale-mode-console');
    const pluginStat = fs.lstatSync(pluginPath);
    const dshManifest = JSON.parse(fs.readFileSync(path.join(dshHome, '.whalebridge-integration.json'), 'utf8'));
    const resolvedPluginPath = fs.realpathSync(pluginPath).toLowerCase();
    const resolvedReleasePath = fs.realpathSync(released).toLowerCase();
    assert.equal(path.resolve(dshManifest.plugin.link).toLowerCase(), path.resolve(pluginPath).toLowerCase());
    assert.equal(path.resolve(dshManifest.plugin.target).toLowerCase(), path.resolve(released).toLowerCase(),
      'manifest continues to identify the versioned data-directory distribution target');
    if (pluginStat.isSymbolicLink() || resolvedPluginPath === resolvedReleasePath) {
      assert.equal(resolvedPluginPath, resolvedReleasePath,
        'a DSH junction must resolve to the versioned plugin directory');
    } else {
      // The shipped integration deliberately supports a copy fallback when Windows cannot create the junction.
      // Manifest identity plus byte-for-byte equality is the distribution contract for that path.
      assert.equal(pluginStat.isDirectory(), true, 'link fallback must materialize a plugin directory');
      assert.deepEqual(directoryContents(pluginPath), directoryContents(released),
        'the documented copy fallback must match the versioned plugin distribution byte-for-byte');
    }
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
  // 只统计本测试产物的残留（临时目录副本）；用户已安装的
  // %LOCALAPPDATA%\Programs\WhaleBridge 实例属于宿主环境条件，不是本测试的残留。
  const leftovers = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='WhaleBridgeCore.exe'" | Where-Object { $_.ExecutablePath -like '*${tempRoot.replace(/'/g, "''")}*' }).Count`
    ],
    { encoding: 'utf8', timeout: 60000 }
  );
  const leftoverCount = Number.parseInt((leftovers.stdout ?? '0').trim(), 10) || 0;
  assert.equal(leftoverCount, 0, `测试结束后仍有 ${leftoverCount} 个本测试 WhaleBridgeCore.exe 进程残留`);
  step('✅ 无遗留：测试结束后没有本次测试产物的 WhaleBridgeCore.exe 进程残留');
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
