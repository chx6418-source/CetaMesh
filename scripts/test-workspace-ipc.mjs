// CetaMesh Workspace v1 —— IPC 级端到端验证（阶段 05）。
//
// 与 test-workspace-runtime.mjs（服务层验收）互补：本脚本启动真实 Core worker
// （node src/core-entry.js --worker + 命名管道），证明 bridge.js 的
// startUiIpcServer 接线把 workspace.* 方法族路由到 src/workspace/service.js，
// 且边界裁决在真实 IPC 往返中生效（escape 输入返回 BOUNDARY_ESCAPE 错误帧）。
//
// 运行：node scripts/test-workspace-ipc.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'core-entry.js');

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readUInt32LE(offset);
    assert.ok(size <= buffer.length - offset - 4, 'output must contain complete frames');
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString('utf8')));
    offset += 4 + size;
  }
  return messages;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ws-ipc-'));
// 与 Rust supervisor 一致：WHALEBRIDGE_UI_PIPE 传完整管道路径（\\.\pipe\<name>）。
const pipePath = `\\\\.\\pipe\\cetamesh-ws-ipc-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
let worker = null;
let client = null;
let pass = 0;
let failCount = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      failCount += 1;
      console.log(`FAIL ${name} — ${error?.message ?? error}`);
    });
}

async function main() {
  const consolePort = await freePort();
  const isolatedConfig = {
    consolePort,
    consoleToken: 'ws-ipc-test-token',
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    allowAllWhenEmpty: false,
    snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', accessToken: '', allowProcessControl: false }
  };
  fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify(isolatedConfig, null, 2));

  worker = spawn(process.execPath, [ENTRY, '--worker'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      WHALEBRIDGE_DATA_DIR: tempRoot,
      WHALEBRIDGE_RESOURCE_DIR: ROOT,
      WHALEBRIDGE_UI_PIPE: pipePath
    }
  });
  let workerStderr = '';
  worker.stderr.on('data', (chunk) => {
    workerStderr += String(chunk);
  });

  // 连接命名管道（重试等待 worker 就绪）。
  const deadline = Date.now() + 30_000;
  client = await (async () => {
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await new Promise((resolve, reject) => {
          const socket = net.connect(pipePath);
          socket.once('connect', () => resolve(socket));
          socket.once('error', reject);
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`无法连接 Core IPC 管道（${pipePath}）：${lastError?.message ?? 'timeout'}\n${workerStderr.slice(0, 2000)}`);
  })();

  const inbox = [];
  let inboxBuffer = Buffer.alloc(0);
  client.on('data', (chunk) => {
    inboxBuffer = Buffer.concat([inboxBuffer, chunk]);
    while (inboxBuffer.length >= 4) {
      const size = inboxBuffer.readUInt32LE(0);
      if (inboxBuffer.length < 4 + size) break;
      inbox.push(JSON.parse(inboxBuffer.subarray(4, 4 + size).toString('utf8')));
      inboxBuffer = inboxBuffer.subarray(4 + size);
    }
  });

  let nextId = 1;
  async function call(method, params) {
    const id = `t${nextId++}`;
    client.write(encodeFrame({ version: 1, id, method, ...(params === undefined ? {} : { params }) }));
    const callDeadline = Date.now() + 20_000;
    for (;;) {
      const index = inbox.findIndex((message) => message.id === id);
      if (index >= 0) return inbox.splice(index, 1)[0];
      if (Date.now() > callDeadline) throw new Error(`IPC 调用超时：${method}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  console.log(`IPC 端到端：pipe=${pipePath} data=${tempRoot}`);

  await check('core.ping 存活', async () => {
    const message = await call('core.ping');
    assert.equal(message.ok, true);
    assert.equal(message.result.status, 'pong');
  });

  await check('workspace.list 初始为空清单', async () => {
    const message = await call('workspace.list');
    assert.equal(message.ok, true, JSON.stringify(message.error ?? {}));
    assert.deepEqual(message.result.workspaces, []);
  });

  let workspaceId = null;
  await check('workspace.create 经 IPC 登记工作区', async () => {
    const message = await call('workspace.create', {
      name: 'IPC Demo',
      root: path.join(tempRoot, 'ws-ipc'),
      createIfMissing: true
    });
    assert.equal(message.ok, true, JSON.stringify(message.error ?? {}));
    workspaceId = message.result.workspace.id;
    assert.ok(workspaceId.startsWith('ws-'));
    assert.equal(message.result.workspace.git.isRepo, false);
  });

  await check('workspace.write 写入经边界裁决', async () => {
    const message = await call('workspace.write', {
      id: workspaceId,
      path: 'notes/hello.txt',
      content: 'hello-ipc-boundary'
    });
    assert.equal(message.ok, true, JSON.stringify(message.error ?? {}));
    assert.ok(message.result.size > 0);
    // 文件确实落在工作区 root 内。
    const onDisk = fs.readFileSync(path.join(tempRoot, 'ws-ipc', 'notes', 'hello.txt'), 'utf8');
    assert.equal(onDisk, 'hello-ipc-boundary');
  });

  await check('workspace.read 读取成功', async () => {
    const message = await call('workspace.read', { id: workspaceId, path: 'notes/hello.txt' });
    assert.equal(message.ok, true);
    assert.equal(message.result.content, 'hello-ipc-boundary');
  });

  // 语义：越界一律拒绝（deny-by-default）。错误码经 Capability Broker 归一化为
  // PATH_OUTSIDE_WORKSPACE（src/capability/service.js 把 BOUNDARY_ESCAPE/TRAVERSAL 等
  // 边界错误统一映射，不向调用方泄漏具体边界实现）——此测试曾因孤儿漂移指向旧码。
  await check('IPC escape：../ 穿越被拒绝（归一化 PATH_OUTSIDE_WORKSPACE）', async () => {
    const message = await call('workspace.read', { id: workspaceId, path: '../../../secret.txt' });
    assert.equal(message.ok, false);
    assert.equal(message.error.code, 'PATH_OUTSIDE_WORKSPACE');
  });

  await check('IPC escape：绝对路径越界被拒绝（归一化 PATH_OUTSIDE_WORKSPACE）', async () => {
    const message = await call('workspace.read', { id: workspaceId, path: 'C:\\Windows\\win.ini' });
    assert.equal(message.ok, false);
    assert.equal(message.error.code, 'PATH_OUTSIDE_WORKSPACE');
  });

  await check('workspace.file.search 经 IPC 返回结果', async () => {
    const message = await call('workspace.file.search', { id: workspaceId, query: 'hello' });
    assert.equal(message.ok, true, JSON.stringify(message.error ?? {}));
    assert.ok(message.result.results.some((item) => item.path === 'notes/hello.txt'));
  });

  await check('workspace.info 聚合（pending/activity/recentFiles）', async () => {
    const message = await call('workspace.info', { id: workspaceId });
    assert.equal(message.ok, true);
    assert.ok(Array.isArray(message.result.recentFiles));
    assert.ok(message.result.recentFiles.some((item) => item.path === 'notes/hello.txt'));
    assert.ok(Array.isArray(message.result.pending));
    assert.equal(message.result.taskRelation.enabled, false);
  });

  await check('未知 workspace 方法返回 METHOD_NOT_FOUND', async () => {
    const message = await call('workspace.shell', {});
    assert.equal(message.ok, false);
    assert.equal(message.error.code, 'METHOD_NOT_FOUND');
  });

  await check('registry 持久化在 data-dir/state/workspaces.json', async () => {
    const file = path.join(tempRoot, 'state', 'workspaces.json');
    assert.ok(fs.existsSync(file), '清单文件应存在于隔离数据目录');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(saved.workspaces.some((item) => item.id === workspaceId));
  });
}

try {
  await main();
} catch (error) {
  failCount += 1;
  console.log(`FAIL 初始化 — ${error?.message ?? error}`);
} finally {
  try {
    client?.destroy();
  } catch {}
  if (worker && worker.exitCode === null) {
    worker.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
}

console.log(`\n通过 ${pass} 项，失败 ${failCount} 项`);
if (failCount > 0) process.exitCode = 1;
else console.log('Workspace IPC 端到端验证全部通过（阶段 05）');
