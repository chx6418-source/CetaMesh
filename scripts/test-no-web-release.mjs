#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertNoWebUiBinaryMarkers,
  assertNoWebUiHtmlArtifacts,
  findNoWebUiHtmlArtifacts,
  isNoWebUiHtmlArtifact
} from './no-web-release-policy.mjs';
import { resolveRuntimeSurfacePolicy, describeRuntimeSurfacePolicy, RUNTIME_SURFACES } from '../src/runtime-surface.js';
import { resolveDataPipeName, dataCall, DATA_IPC_METHOD } from '../src/control/data-ipc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(isNoWebUiHtmlArtifact('public/console.html'), true);
assert.equal(isNoWebUiHtmlArtifact('PUBLIC/legacy-settings.HTML'), true);
assert.equal(isNoWebUiHtmlArtifact('resources/public/legacy-settings.HTML'), true);
assert.equal(isNoWebUiHtmlArtifact('ui/installer.html'), true);
assert.equal(isNoWebUiHtmlArtifact('roles/guide.md'), false);
assert.deepEqual(
  findNoWebUiHtmlArtifacts([
    'resources/public/console.html',
    'resources/public/token-login.html',
    'resources/public/dsh-monitor.html',
    'desktop-shell/ui/installer.html',
    'resources/public/product.json'
  ]),
  [
    'resources/public/console.html',
    'resources/public/token-login.html',
    'resources/public/dsh-monitor.html',
    'desktop-shell/ui/installer.html'
  ]
);
assert.throws(() => assertNoWebUiHtmlArtifacts(['resources/public/console.html']), /console\.html/);
assert.throws(() => assertNoWebUiBinaryMarkers(Buffer.from('embedded installer.html')), /installer\.html/);
assert.doesNotThrow(() => assertNoWebUiBinaryMarkers(Buffer.from('native shell without web UI')));

// Exercise the installer-side defense with a disposable payload on every OS. No real build
// output is touched; the invalid HTML fixture must be rejected before the platform tool check.
let tempRoot = null;
try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-no-web-'));
} catch (error) {
  if (error.code !== 'EPERM') throw error;
  process.stdout.write('↷ installer fixture integration skipped: temporary writes are blocked in this environment\n');
}
if (tempRoot) {
  try {
    const outDir = path.join(tempRoot, 'out');
    const payloadDir = path.join(tempRoot, 'payload');
    fs.mkdirSync(path.join(payloadDir, 'resources', 'public'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'WhaleBridge.exe'), Buffer.from([0x4d, 0x5a]));
    fs.writeFileSync(path.join(payloadDir, 'WhaleBridgeCore.exe'), Buffer.from('fixture core'));
    fs.writeFileSync(path.join(payloadDir, 'resources', 'public', 'console.html'), '<html/>');
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'package-installer.mjs'), outDir, payloadDir, '--no-web-ui'
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(result.status, 0, 'no-web installer must reject a payload containing console.html');
    assert.match(`${result.stdout ?? ''}${result.stderr ?? ''}`, /product HTML UI assets.*console\.html/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const buildCoreSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-core.mjs'), 'utf8');
const buildReleaseSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-release.mjs'), 'utf8');
assert.match(buildCoreSource, /noWebUi: true/);
assert.match(buildCoreSource, /isNoWebUiHtmlArtifact\(repoRelative\)/);
assert.match(buildCoreSource, /uiDistribution: options\.noWebUi \? 'native-no-web'/);
assert.match(buildCoreSource, /legacyHttp: false/);
assert.match(buildReleaseSource, /noWebUi: true/);
assert.match(buildReleaseSource, /legacyHttp: false/);
assert.match(buildReleaseSource, /coreRuntimeManifest\.noWebUi !== true/);
assert.match(buildReleaseSource, /assertNoWebUiHtmlArtifacts\(payloadFiles/);

// ── 运行面策略单元断言（D1-001）：判定收拢在 resolveRuntimeSurfacePolicy ──────
{
  const base = { env: {}, packaged: false };
  assert.deepEqual(
    { ...resolveRuntimeSurfacePolicy(base), legacyHttpRequested: undefined },
    { surface: RUNTIME_SURFACES.headlessDev, nativeControl: false, localDataIpc: true, legacyHttp: false, legacyHttpRequested: undefined }
  );
  // legacy HTTP 必须显式 opt-in，且仅源码开发有效
  assert.equal(resolveRuntimeSurfacePolicy({ env: { WHALEBRIDGE_LEGACY_HTTP: '1' }, packaged: false }).legacyHttp, true);
  assert.equal(resolveRuntimeSurfacePolicy({ env: { WHALEBRIDGE_LEGACY_HTTP: '1' }, packaged: false }).surface, RUNTIME_SURFACES.legacyWebDev);
  // 发行构建（SEA）无法开启 legacy HTTP —— 这是「发行版不启动 HTTP」的第一道闸
  const packaged = resolveRuntimeSurfacePolicy({ env: { WHALEBRIDGE_LEGACY_HTTP: '1', WHALEBRIDGE_UI_PIPE: 'x' }, packaged: true });
  assert.equal(packaged.legacyHttp, false);
  assert.equal(packaged.surface, RUNTIME_SURFACES.nativeRelease);
  assert.equal(resolveRuntimeSurfacePolicy({ env: { WHALEBRIDGE_LEGACY_HTTP: 'true' }, packaged: false }).legacyHttp, false);
  assert.equal(resolveRuntimeSurfacePolicy({ env: { WHALEBRIDGE_UI_PIPE: '\\\\.\\pipe\\x' }, packaged: false }).surface, RUNTIME_SURFACES.nativeDev);
  assert.equal(resolveRuntimeSurfacePolicy({ env: { WHALEBRIDGE_UI_PIPE: 'x' }, packaged: true }).surface, RUNTIME_SURFACES.nativeRelease);
  assert.equal(describeRuntimeSurfacePolicy(resolveRuntimeSurfacePolicy(base)).includes('legacy-http:off'), true);
}

// ── 行为断言（D1-006/D1-002/D1-003/D1-004）：
//    不再只检查文件 —— 真实启动 worker，验证 3100 不可连接、Native IPC 可用、
//    MCP 数据面 IPC 完成真实请求、控制面方法在数据面 pipe 上不可达。 ──────────────
const FREE_PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

function isTempRootAvailable() {
  try {
    fs.mkdirSync(path.join(os.tmpdir(), 'whalebridge-probe-'), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

if (!isTempRootAvailable()) {
  process.stdout.write('↷ worker behavior section skipped: temporary writes are blocked in this environment\n');
  process.stdout.write('✓ native/no-web release filtering, artifact audits, installer guard, and surface policy passed\n');
  process.exit(0);
}

function writeWorkerConfig(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      consolePort: FREE_PORT,
      dsh: { baseUrl: 'http://127.0.0.1:9' },
      allow: { private: [], groups: [] },
      deny: { private: [], groups: [] },
      allowAllWhenEmpty: false,
      snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', allowProcessControl: false },
      socialV2: { tools: { getCardMsg: false, clickCardButton: false, fileSend: false, bilibili: false } }
    }, null, 2)
  );
}

function isolatedWorkerEnv(tempRoot, dataDir, extra = {}) {
  const home = path.join(tempRoot, 'home');
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  return {
    ...process.env,
    WHALEBRIDGE_DATA_DIR: dataDir,
    WHALEBRIDGE_RESOURCE_DIR: ROOT,
    WHALEBRIDGE_SUPERVISED: '1',
    ...extra
  };
}

function startWorker(tempRoot, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'core-entry.js'), '--worker'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
    env: isolatedWorkerEnv(tempRoot, dataDir, extraEnv)
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  return { child, stderrText: () => stderr };
}

async function stopWorker(worker) {
  const { child } = worker;
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(); }, 5000))
    ]);
  }
}

/** TCP 探测：期望「不可连接」（ECONNREFUSED）或返回连接结果。 */
function tryTcpConnect(port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (connected, code) => {
      socket.destroy();
      resolve({ connected, code });
    };
    socket.once('connect', () => done(true, null));
    socket.once('error', (error) => done(false, error.code));
    socket.setTimeout(timeoutMs, () => done(false, 'ETIMEDOUT'));
  });
}

/** 经数据面 pipe 等待 worker 就绪并返回 /api/status 结果（同时验证 MCP 数据通道）。 */
async function waitForDataPlane(dataDir, { timeoutMs = 30000, pipeName } = {}) {
  const resolvedPipe = pipeName ?? resolveDataPipeName({ dataRoot: dataDir });
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const token = fs.readFileSync(path.join(dataDir, 'state', 'agent-token'), 'utf8').trim();
      const res = await dataCall({ path: '/api/status', token, timeoutMs: 3000, pipeName: resolvedPipe });
      return { pipeName: resolvedPipe, token, res };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`data plane not ready: ${lastError?.message ?? lastError}`);
}

/** 原始帧调用（用于验证控制面方法在数据面 pipe 上被拒）。 */
function rawPipeCall(pipeName, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('rawPipeCall timeout')), timeoutMs);
    socket.once('connect', () => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const frame = Buffer.allocUnsafe(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);
      socket.write(frame);
    });
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < 4 + length) break;
        const message = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'));
        buffered = buffered.subarray(4 + length);
        if (message.event) continue; // core.ready
        finish(resolve, message);
        return;
      }
    });
    socket.once('error', (error) => finish(reject, error));
  });
}

let behaviorTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-no-http-'));
try {
  // ── 场景 1：native worker（UI pipe + 数据面 pipe），HTTP 不得监听 ──────────
  {
    const dataDir = path.join(behaviorTempRoot, 'native', 'data');
    const uiPipe = `\\\\.\\pipe\\WhaleBridge-Test-UI-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const dataPipeOverride = `\\\\.\\pipe\\WhaleBridge-Test-Data-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    writeWorkerConfig(dataDir);
    const worker = startWorker(path.join(behaviorTempRoot, 'native'), dataDir, {
      WHALEBRIDGE_UI_PIPE: uiPipe,
      WHALEBRIDGE_DATA_PIPE: dataPipeOverride
    });
    try {
      // MCP 数据面 IPC：真实 fixture 请求 /api/status（agent-token 鉴权 + 完整 JSON 响应）
      const { res } = await waitForDataPlane(dataDir, { pipeName: dataPipeOverride });
      assert.equal(res.ok, true, `data IPC /api/status must be ok: ${res.status} ${res.text?.slice(0, 200)}`);
      assert.equal(res.json?.tokenModel, 'dual');
      assert.equal(typeof res.json?.mode, 'string');
      assert.equal(res.json?.agentSurface?.agentAllowedExact?.includes('/api/status'), true);

      // release/native 契约：consolePort 不可连接（server 根本不存在，不是 403）
      const probe = await tryTcpConnect(FREE_PORT);
      assert.equal(probe.connected, false, `native worker must not listen on ${FREE_PORT}`);
      assert.equal(['ECONNREFUSED', 'ETIMEDOUT', 'EACCES'].includes(probe.code), true, `expected refusal, got ${probe.code}`);

      // D1-004：控制面方法在数据面 pipe 上一律 METHOD_NOT_FOUND
      const denied = await rawPipeCall(dataPipeOverride, { version: 1, id: 'ctl-1', method: 'control.execute', params: { method: 'services.get', params: {} } });
      assert.equal(denied.ok, false);
      assert.equal(denied.error?.code, 'METHOD_NOT_FOUND');
      const deniedFamily = await rawPipeCall(dataPipeOverride, { version: 1, id: 'ctl-2', method: 'settings.get', params: {} });
      assert.equal(deniedFamily.ok, false);
      assert.equal(deniedFamily.error?.code, 'METHOD_NOT_FOUND');
      // 数据面白名单仍生效：非白名单 API 路径被拒
      const forbidden = await dataCall({ path: '/api/whitelist', token: fs.readFileSync(path.join(dataDir, 'state', 'agent-token'), 'utf8').trim(), timeoutMs: 5000, pipeName: dataPipeOverride });
      assert.equal(forbidden.ok, false);
      assert.equal(forbidden.status, 403);
    } finally {
      await stopWorker(worker);
    }
  }

  // ── 场景 2：headless dev（无 pipe、无 opt-in）——同样不监听 HTTP，数据面可用 ──
  {
    const dataDir = path.join(behaviorTempRoot, 'headless', 'data');
    writeWorkerConfig(dataDir);
    const worker = startWorker(path.join(behaviorTempRoot, 'headless'), dataDir);
    try {
      const { res } = await waitForDataPlane(dataDir);
      assert.equal(res.ok, true, `headless data plane must work: ${res.status}`);
      const probe = await tryTcpConnect(FREE_PORT);
      assert.equal(probe.connected, false, 'headless worker must not listen on console port');
    } finally {
      await stopWorker(worker);
    }
  }

  // ── 场景 3：legacy dev opt-in —— HTTP 显式开启时才存在，且仍是纯 API 面 ──────
  {
    const dataDir = path.join(behaviorTempRoot, 'legacy', 'data');
    writeWorkerConfig(dataDir);
    const worker = startWorker(path.join(behaviorTempRoot, 'legacy'), dataDir, { WHALEBRIDGE_LEGACY_HTTP: '1' });
    try {
      await waitForDataPlane(dataDir);
      const connected = await (async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const probe = await tryTcpConnect(FREE_PORT, { timeoutMs: 1000 });
          if (probe.connected) return true;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return false;
      })();
      assert.equal(connected, true, 'legacy opt-in must start the loopback HTTP API');
      const token = fs.readFileSync(path.join(dataDir, 'state', 'agent-token'), 'utf8').trim();
      // 匿名请求撞 401 闸门（bridge 自动生成了 console-token）：这是预期安全行为
      const anonymous = await fetch(`http://127.0.0.1:${FREE_PORT}/`, { signal: AbortSignal.timeout(5000) });
      assert.equal(anonymous.status, 401, 'legacy surface must still require a token');
      const consoleToken = fs.readFileSync(path.join(dataDir, 'state', 'console-token'), 'utf8').trim();
      const page = await fetch(`http://127.0.0.1:${FREE_PORT}/`, { headers: { 'x-console-token': consoleToken }, signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 404, 'legacy surface serves no web page');
      const status = await fetch(`http://127.0.0.1:${FREE_PORT}/api/status`, { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(5000) });
      assert.equal(status.ok, true);
    } finally {
      await stopWorker(worker);
    }
  }
} finally {
  fs.rmSync(behaviorTempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

process.stdout.write('✓ native/no-web release filtering, artifact audits, installer guard, surface policy, and no-http worker behavior passed\n');
