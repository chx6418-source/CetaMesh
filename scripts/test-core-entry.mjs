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
import { MCP_MODES, parseCoreArgs } from '../src/core-entry.js';
import { resolveDataPipeName, dataCall } from '../src/control/data-ipc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'core-entry.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDataIpc(dataRoot, { timeoutMs = 15000 } = {}) {
  // D1：worker 不监听 loopback HTTP，就绪与数据面健康走数据面 IPC。
  const pipeName = resolveDataPipeName({ dataRoot });
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const token = fs.readFileSync(path.join(dataRoot, 'state', 'agent-token'), 'utf8').trim();
      const res = await dataCall({ path: '/api/status', token, timeoutMs: 2000, pipeName });
      return res;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError ?? new Error(`timeout waiting for data IPC ${pipeName}`);
}

assert.deepEqual(parseCoreArgs(['--worker']), { mode: 'worker' });
assert.deepEqual(parseCoreArgs(['--mcp', 'snowluma']), { mode: 'mcp', mcp: 'snowluma' });
assert.deepEqual(parseCoreArgs(['--mcp=mcp-bilibili']), { mode: 'mcp', mcp: 'bilibili' });
assert.deepEqual(parseCoreArgs(['--self-test', 'http://127.0.0.1:3080', '测试']), {
  mode: 'self-test', baseUrl: 'http://127.0.0.1:3080', promptText: '测试'
});
assert.throws(() => parseCoreArgs(['--mcp', 'unknown']), /未知 MCP 模式/);
assert.throws(() => parseCoreArgs(['--worker', 'extra']), /不接受额外参数/);
assert.deepEqual(Object.keys(MCP_MODES), ['snowluma', 'snowluma-host', 'web-search-safe', 'qq-file-send', 'bilibili']);

const help = spawnSync(process.execPath, [ENTRY, '--help'], { cwd: ROOT, encoding: 'utf8' });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--worker/);
assert.match(help.stdout, /--mcp/);

const invalid = spawnSync(process.execPath, [ENTRY, '--mcp', 'unknown'], { cwd: ROOT, encoding: 'utf8' });
assert.equal(invalid.status, 1);
assert.match(invalid.stderr, /未知 MCP 模式/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-core-'));
try {
  const isolatedConfig = {
    consolePort: 9,
    consoleToken: 'core-test-console-token',
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
      tools: {
        getCardMsg: false,
        clickCardButton: false,
        fileSend: false,
        bilibili: false
      }
    }
  };
  fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify(isolatedConfig, null, 2));

  const cases = [
    {
      mode: 'snowluma',
      expectedTool: 'qq_get_card_msg',
      call: { name: 'qq_get_card_msg', arguments: { key: 'group:1', token: 'test', messageId: '1' } },
      result: /403|已禁用/
    },
    {
      mode: 'snowluma-host',
      expectedTool: 'snowluma_status',
      call: { name: 'snowluma_status', arguments: {} },
      result: /reachable|online/
    },
    {
      mode: 'web-search-safe',
      expectedTool: 'web_fetch',
      call: { name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } },
      result: /禁止|内网|本机|抓取失败/
    },
    {
      mode: 'qq-file-send',
      expectedTool: 'qq_send_file',
      call: { name: 'qq_send_file', arguments: { target: 'private:1', filePath: path.join(tempRoot, 'missing.txt') } },
      result: /403|已禁用/
    },
    {
      mode: 'bilibili',
      expectedTool: 'bili_search_video',
      call: { name: 'bili_search_video', arguments: { query: '测试' } },
      result: /403|已禁用/
    }
  ];

  for (const item of cases) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, '--mcp', item.mode],
      cwd: ROOT,
      env: { ...process.env, WHALEBRIDGE_DATA_DIR: tempRoot },
      stderr: 'pipe'
    });
    const client = new Client({ name: 'whalebridge-core-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === item.expectedTool), `${item.mode}: missing ${item.expectedTool}`);
      const called = await client.callTool(item.call);
      const text = called.content?.map((block) => block?.text ?? '').join('\n') ?? '';
      assert.match(text, item.result, `${item.mode}: unexpected callTool result`);
      console.log(`✅ ${item.mode}: initialize / listTools / callTool`);
    } finally {
      await client.close().catch(() => {});
    }
  }

  const legacyEntries = {
    snowluma: 'mcp-snowluma-safe.js',
    'snowluma-host': 'mcp-host-server.js',
    'web-search-safe': 'mcp-web-search-safe.js',
    'qq-file-send': 'mcp-qq-file-send.js',
    bilibili: 'mcp-bilibili.js'
  };
  for (const item of cases) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'src', legacyEntries[item.mode])],
      cwd: ROOT,
      env: { ...process.env, WHALEBRIDGE_DATA_DIR: tempRoot },
      stderr: 'pipe'
    });
    const client = new Client({ name: 'whalebridge-legacy-entry-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === item.expectedTool));
      console.log(`✅ ${item.mode}: 原独立入口兼容`);
    } finally {
      await client.close().catch(() => {});
    }
  }

  const marker = path.join(tempRoot, 'state', 'mcp-qq-file-send.version');
  assert.ok(fs.existsSync(marker), 'qq-file-send unified mode should write its startup marker to dataRoot');

  const workerPort = await freePort();
  isolatedConfig.consolePort = workerPort;
  isolatedConfig.dsh = { baseUrl: 'http://127.0.0.1:9' };
  fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify(isolatedConfig, null, 2));
  const isolatedDiscoveryRoot = path.join(tempRoot, 'discovery');
  fs.mkdirSync(isolatedDiscoveryRoot, { recursive: true });
  const worker = spawn(process.execPath, [ENTRY, '--worker'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      WHALEBRIDGE_DATA_DIR: tempRoot,
      WHALEBRIDGE_RESOURCE_DIR: ROOT,
      PATH: isolatedDiscoveryRoot,
      USERPROFILE: isolatedDiscoveryRoot,
      LOCALAPPDATA: isolatedDiscoveryRoot,
      APPDATA: isolatedDiscoveryRoot,
      ProgramFiles: isolatedDiscoveryRoot,
      'ProgramFiles(x86)': isolatedDiscoveryRoot
    }
  });
  try {
    // D1 契约：隔离 worker 不监听 consolePort；就绪 = 数据面 IPC 可用。
    const status = await waitForDataIpc(tempRoot);
    assert.equal(status.ok, true, `数据面 IPC /api/status 应可用（status ${status.status}）`);
    assert.ok(fs.existsSync(path.join(tempRoot, 'state', 'agent-token')));
    assert.ok(fs.existsSync(path.join(tempRoot, 'state', 'bridge.lock')));
    console.log('✅ worker: 隔离数据目录启动成功（数据面 IPC 健康，无 HTTP listener）');
  } finally {
    if (worker.exitCode === null) worker.kill();
    const exited = await Promise.race([
      once(worker, 'exit').then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000))
    ]);
    assert.equal(exited, true, 'isolated worker did not exit within 5 seconds');
  }

  // 阶段 5 起，MCP 配置的生成逻辑在 src/dsh-integration.js；setup-dsh.mjs 只是它的命令行外壳。
  const setupSource = fs.readFileSync(path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'utf8');
  assert.match(setupSource, /dsh-integration\.js/, 'setup-dsh 应复用统一集成模块');
  const { buildMcpBlock, resolveCoreLaunch, LEGACY, MCP_SERVERS } = await import('../src/dsh-integration.js');
  for (const mode of Object.keys(MCP_MODES)) {
    assert.ok(MCP_SERVERS.some((server) => server.mode === mode), `dsh-integration missing ${mode}`);
  }
  const generatedBlock = buildMcpBlock(
    resolveCoreLaunch({ packaged: true, execPath: 'X:\\WhaleBridge\\WhaleBridgeCore.exe' })
  );
  assert.match(generatedBlock, /--mcp/, '生成的 MCP 配置应使用统一入口');
  assert.ok(
    !LEGACY.scriptNames.some((name) => generatedBlock.includes(name)),
    '新生成的 MCP 配置不应再指向独立脚本'
  );
  await import('../src/dsh-integration.js');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('🎉 统一 Core 入口与五个 MCP 模式全部通过');
