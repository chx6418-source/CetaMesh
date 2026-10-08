// v2 hardening / Phase F 验收：ProcessExtensionHost 契约。
//
// 立场：本轮只交付契约 + 注入 transport（fixture）；真实进程沙箱有意不实现。
// createExtensionHost 仍 = VmExtensionHost（活动宿主不变）。
//
// 覆盖：invoke 往返 / 能力白名单（未声明不出帧）/ 权限未授予 / 帧大小上限 /
// 帧模式校验（坏帧丢弃）/ 超时 / cancel + 迟到结果丢弃 / shutdown / health /
// 与 VmExtensionHost 接口形状一致（start 无需显式、invoke/cancel/shutdown/health）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProcessExtensionHost, createInProcessTransportPair } from '../src/extension/process-host.js';
import { buildExtensionWorkerEnv, createProcessTransport, resolveExtensionWorkerLaunch } from '../src/extension/process-transport.js';
import { sanitizeExtensionWorkerEnv } from '../src/extension/worker-env.js';
import { createVmExtensionHost, createExtensionHost } from '../src/extension/host.js';
import { assertManifest, manifestFingerprint } from '../src/extension/manifest.js';

const manifest = {
  id: 'fixture-ext',
  entry: 'index.js',
  permissions: ['network'],
  capabilities: [{ id: 'greet', requires: [] }, { id: 'fetch', requires: ['network'] }]
};

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

function makeHost({ latencyMs = 0, childBehavior } = {}) {
  const pair = createInProcessTransportPair({ latencyMs });
  // 模拟"进程端"扩展：响应 invoke（按 childBehavior 可覆盖）。
  pair.child.onMessage((raw) => {
    const frame = JSON.parse(raw);
    if (frame.kind !== 'invoke') return;
    const reply = childBehavior
      ? childBehavior(frame)
      : { v: 1, id: frame.id, kind: 'result', capability: frame.capability, result: { echoed: frame.input } };
    if (reply) pair.child.send(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  const host = createProcessExtensionHost({ manifest, transport: pair.host, timeoutMs: 2000 });
  return { host, pair };
}

function makeInstalledPackage({ id = 'fixture-ext', version = '1.0.0', source, permissions = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-process-package-'));
  const storeRoot = path.join(root, 'packages');
  const packageRoot = path.join(storeRoot, id, version);
  const manifest = assertManifest({
    id, name: 'Fixture Extension', version, entry: 'index.js', type: 'tool', permissions,
    capabilities: [
      { id: 'echo', kind: 'tool', title: 'Echo', requires: [] },
      { id: 'never', kind: 'tool', title: 'Never', requires: [] }
    ]
  });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'extension.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(packageRoot, 'index.js'), source ?? [
    'module.exports.handlers = {',
    '  echo: input => input,',
    '  never: () => new Promise(() => {})',
    '};'
  ].join('\n'));
  return { root, storeRoot, packageRoot, manifest, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Extension-private synchronous storage remains scoped and uses the shared JSON Storage Primitive.
{
  const fixture = makeInstalledPackage({ permissions: ['storage'], source: [
    'module.exports.handlers = {',
    '  echo: (input, ctx) => { if (input.read) return ctx.storage.get("saved"); ctx.storage.set("saved", input.value); return input.value; },',
    '  never: () => new Promise(() => {})',
    '};'
  ].join('\n') });
  const storageFile = path.join(fixture.root, 'private-data', 'fixture-ext.json');
  const host = createProcessExtensionHost({
    manifest: fixture.manifest, packageRoot: fixture.packageRoot, storeRoot: fixture.storeRoot,
    extensionId: fixture.manifest.id, version: fixture.manifest.version, packaged: false,
    storageFile, timeoutMs: 5000
  });
  try {
    assert.deepEqual((await host.invoke('echo', { value: 'private value' })).result, 'private value');
    assert.deepEqual((await host.invoke('echo', { read: true })).result, 'private value');
    assert.equal(fs.existsSync(storageFile), true);
    ok('real Worker retains scoped private storage without exposing unrestricted fs');
  } finally {
    await host.shutdown();
    fixture.cleanup();
  }
}

// Worker launch policy must be explicit and start from a blank environment.
{
  const parentEnv = {
    PATH: 'C:\\Windows\\System32;C:\\Users\\owner\\bin', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'provider-secret', WHALEBRIDGE_CONSOLE_TOKEN: 'console-secret',
    WHALEBRIDGE_AGENT_TOKEN: 'agent-secret', GIT_ASKPASS: 'git-secret', AWS_ACCESS_KEY_ID: 'aws-secret',
    NODE_OPTIONS: '--require=evil.js', NODE_PATH: 'evil-modules', HOME: 'C:\\Users\\owner'
  };
  const env = buildExtensionWorkerEnv({
    parentEnv,
    metadata: { extensionId: 'fixture-ext', version: '1.0.0', fingerprint: 'sha256:fixture' }
  });
  assert.deepEqual(env, {
    PATH: 'C:\\Windows\\System32', TEMP: parentEnv.TEMP, TMP: parentEnv.TMP, SystemRoot: parentEnv.SystemRoot,
    CETAMESH_EXTENSION_ID: 'fixture-ext', CETAMESH_EXTENSION_VERSION: '1.0.0',
    CETAMESH_EXTENSION_FINGERPRINT: 'sha256:fixture'
  });
  assert.deepEqual(resolveExtensionWorkerLaunch({ packaged: false, execPath: 'node.exe', workerEntry: 'worker.js' }), {
    executable: 'node.exe', args: ['worker.js']
  });
  assert.deepEqual(resolveExtensionWorkerLaunch({ packaged: true, execPath: 'WhaleBridgeCore.exe', workerEntry: 'worker.js' }), {
    executable: 'WhaleBridgeCore.exe', args: ['--extension-worker']
  });
  const simulatedPlatformEnv = {
    PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Temp',
    CETAMESH_EXTENSION_ID: 'fixture-ext', CETAMESH_EXTENSION_VERSION: '1.0.0',
    CETAMESH_EXTENSION_FINGERPRINT: 'sha256:fixture', USERPROFILE: 'C:\\Users\\owner',
    HOMEDRIVE: 'C:', LOGONSERVER: '\\\\domain-controller', AWS_ACCESS_KEY_ID: 'injected-secret'
  };
  sanitizeExtensionWorkerEnv(simulatedPlatformEnv);
  assert.deepEqual(Object.keys(simulatedPlatformEnv).sort(), [
    'CETAMESH_EXTENSION_FINGERPRINT', 'CETAMESH_EXTENSION_ID', 'CETAMESH_EXTENSION_VERSION',
    'PATH', 'SYSTEMROOT', 'TEMP'
  ]);
  ok('worker env 采用空白 allowlist；source 与 SEA 使用不同参数');
}

// Production ProcessExtensionHost must spawn a real Worker and support parallel calls.
{
  const fixture = makeInstalledPackage();
  const host = createProcessExtensionHost({
    manifest: fixture.manifest, packageRoot: fixture.packageRoot, storeRoot: fixture.storeRoot,
    extensionId: fixture.manifest.id, version: fixture.manifest.version, packaged: false, timeoutMs: 5000
  });
  try {
    const results = await Promise.all([
      host.invoke('echo', { sequence: 1 }),
      host.invoke('echo', { sequence: 2 })
    ]);
    assert.deepEqual(results.map((item) => item.result), [{ sequence: 1 }, { sequence: 2 }]);
    assert.equal(await host.ping({ timeoutMs: 2000 }), true, 'real Worker answers heartbeat ping');
    ok('ProcessExtensionHost 真实 spawn 支持并行 invoke');
  } finally {
    await host.shutdown();
    fixture.cleanup();
  }
}

// Real child processes exercise deadline cancellation, explicit cancel, and bounded host-to-worker frames.
{
  const fixture = makeInstalledPackage();
  const host = createProcessExtensionHost({
    manifest: fixture.manifest, packageRoot: fixture.packageRoot, storeRoot: fixture.storeRoot,
    extensionId: fixture.manifest.id, version: fixture.manifest.version, packaged: false,
    timeoutMs: 300, maxMessageBytes: 1024
  });
  try {
    assert.equal(host.health().provider, 'process-child');
    assert.equal(await host.ping({ timeoutMs: 2000 }), true, 'Worker is a live spawned child before fault probes');
    await assert.rejects(host.invoke('never', {}), (error) => error.code === 'INVOKE_TIMEOUT');
    assert.equal(host.available(), true, 'timeout cancels the call without crashing the Worker');

    const pending = host.invoke('never', { cancel: true });
    const [invokeId] = host._inflight();
    assert.ok(invokeId);
    assert.equal(host.cancel(invokeId).cancelled, true);
    await assert.rejects(pending, (error) => error.code === 'INVOKE_CANCELLED');
    assert.equal(await host.ping({ timeoutMs: 2000 }), true, 'Worker responds after explicit cancel');

    await assert.rejects(host.invoke('echo', { blob: 'x'.repeat(2048) }), (error) => error.code === 'MESSAGE_TOO_LARGE');
    assert.equal(host.available(), true, 'oversized input is rejected before transport and leaves Worker healthy');
    await host.shutdown();
    assert.equal(host.health().state, 'stopped');
    ok('real Worker enforces timeout, cancellation, bounded input, and shutdown');
  } finally {
    await host.shutdown();
    fixture.cleanup();
  }
}

// Real malformed and oversized Worker output is treated as a protocol violation and contained to the child.
{
  const fixture = makeInstalledPackage();
  const sanitizerUrl = new URL('../src/extension/worker-env.js', import.meta.url).href;
  for (const [name, workerBody] of [
    ['malformed', "process.stdout.write('not-json\\n');"],
    ['oversized', "process.stdout.write(JSON.stringify({v:1,id:'too-large',kind:'pong',padding:'x'.repeat(4096)})+'\\n');"]
  ]) {
    const workerEntry = path.join(fixture.packageRoot, `${name}-worker.mjs`);
    fs.writeFileSync(workerEntry, [
      `import { sanitizeExtensionWorkerEnv } from '${sanitizerUrl}';`,
      'sanitizeExtensionWorkerEnv();',
      workerBody
    ].join('\n'));
    let crashedResolve;
    const crashed = new Promise((resolve) => { crashedResolve = resolve; });
    const host = createProcessExtensionHost({
      manifest: fixture.manifest, packageRoot: fixture.packageRoot, storeRoot: fixture.storeRoot,
      extensionId: fixture.manifest.id, version: fixture.manifest.version, packaged: false,
      workerEntry, maxMessageBytes: 1024, onCrash: crashedResolve
    });
    try {
      const failure = await Promise.race([
        crashed,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} Worker did not fail`)), 5000))
      ]);
      assert.equal(failure.code, 'PROTOCOL_VIOLATION');
      assert.equal(host.health().state, 'crashed');
      assert.equal(host.available(), false);
      await host.shutdown();
    } finally {
      await host.shutdown();
    }
  }
  ok('real malformed and oversized output crashes only the Worker host');
  fixture.cleanup();
}

// A real nonzero child exit is reported as a contained host crash.
{
  const fixture = makeInstalledPackage();
  const sanitizerUrl = new URL('../src/extension/worker-env.js', import.meta.url).href;
  const workerEntry = path.join(fixture.packageRoot, 'crash-worker.mjs');
  fs.writeFileSync(workerEntry, [
    `import { sanitizeExtensionWorkerEnv } from '${sanitizerUrl}';`,
    'sanitizeExtensionWorkerEnv();',
    'setTimeout(() => process.exit(23), 20);'
  ].join('\n'));
  let crashedResolve;
  const crashed = new Promise((resolve) => { crashedResolve = resolve; });
  const host = createProcessExtensionHost({
    manifest: fixture.manifest, packageRoot: fixture.packageRoot, storeRoot: fixture.storeRoot,
    extensionId: fixture.manifest.id, version: fixture.manifest.version, packaged: false,
    workerEntry, onCrash: crashedResolve
  });
  try {
    const failure = await Promise.race([
      crashed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('crashing Worker did not exit')), 5000))
    ]);
    assert.equal(failure.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(host.health().state, 'crashed');
    await assert.rejects(host.invoke('echo', {}), (error) => error.code === 'PROVIDER_UNAVAILABLE');
    ok('real nonzero Worker exit is contained and reported to the host');
  } finally {
    await host.shutdown();
    fixture.cleanup();
  }
}

// The transport must launch with only allowlisted env vars, the versioned package cwd, and kill descendants.
{
  const fixture = makeInstalledPackage();
  const probeEntry = path.join(fixture.packageRoot, 'tree-probe.mjs');
  fs.writeFileSync(probeEntry, [
    "import { spawn } from 'node:child_process';",
    `import { sanitizeExtensionWorkerEnv } from '${new URL('../src/extension/worker-env.js', import.meta.url).href}';`,
    'sanitizeExtensionWorkerEnv();',
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    'let data = "";',
    "process.stdin.on('data', chunk => { data += chunk.toString(); let i; while ((i = data.indexOf('\\n')) >= 0) { const frame = JSON.parse(data.slice(0, i)); data = data.slice(i + 1); if (frame.kind === 'ping') process.stdout.write(JSON.stringify({ v: 1, id: frame.id, kind: 'pong', result: { cwd: process.cwd(), env: process.env, childPid: child.pid } }) + '\\n'); } });"
  ].join('\n'));
  const parentEnv = {
    PATH: process.env.PATH, TEMP: os.tmpdir(), TMP: os.tmpdir(), SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    OPENAI_API_KEY: 'provider-secret', WHALEBRIDGE_CONSOLE_TOKEN: 'console-secret',
    WHALEBRIDGE_AGENT_TOKEN: 'agent-secret', GIT_ASKPASS: 'git-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require=evil.js', NODE_PATH: 'evil-modules', HOME: 'C:\\Users\\owner'
  };
  let transport;
  try {
    transport = createProcessTransport({
      packageRoot: fixture.packageRoot, storeRoot: fixture.storeRoot, extensionId: fixture.manifest.id,
      version: fixture.manifest.version,
      launch: resolveExtensionWorkerLaunch({ packaged: false, execPath: process.execPath, workerEntry: probeEntry }),
      parentEnv, metadata: { extensionId: fixture.manifest.id, version: fixture.manifest.version, fingerprint: 'sha256:fixture' }
    });
    assert.equal(transport.cwd, path.resolve(fixture.packageRoot));
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe timeout')), 5000);
      transport.onMessage((raw) => {
        const frame = JSON.parse(raw);
        if (frame.id === 'probe-cwd-env') { clearTimeout(timer); resolve(frame); }
      });
    });
    transport.send(JSON.stringify({ v: 1, id: 'probe-cwd-env', kind: 'ping' }));
    const frame = await received;
    assert.equal(frame.kind, 'pong');
    assert.equal(path.resolve(frame.result.cwd), path.resolve(fixture.packageRoot));
    const envKeys = Object.keys(frame.result.env).map((key) => key.toUpperCase());
    const allowlistedKeys = ['PATH', 'TEMP', 'TMP', 'SYSTEMROOT', 'CETAMESH_EXTENSION_ID', 'CETAMESH_EXTENSION_VERSION', 'CETAMESH_EXTENSION_FINGERPRINT'];
    assert.ok(envKeys.every((key) => allowlistedKeys.includes(key)), 'unexpected Worker env key(s): ' + envKeys.join(', '));
    assert.equal(frame.result.env.OPENAI_API_KEY, undefined);
    assert.equal(frame.result.env.WHALEBRIDGE_CONSOLE_TOKEN, undefined);
    assert.equal(frame.result.env.AWS_SECRET_ACCESS_KEY, undefined);
    const descendantPid = frame.result.childPid;
    assert.ok(Number.isInteger(descendantPid));
    await transport.close({ graceMs: 100 });
    const deadline = Date.now() + 3000;
    while (pidIsAlive(descendantPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pidIsAlive(descendantPid), false, 'shutdown kills the descendant process tree');
    ok('real transport uses fixed package cwd, minimal child env, and whole-tree shutdown');
  } finally {
    if (transport) await transport.killTree();
    fixture.cleanup();
  }
}

// A reverse Worker invoke reaches only the Host capability executor; frame-supplied identity is ignored.
{
  const pair = createInProcessTransportPair();
  const requests = [];
  const host = createProcessExtensionHost({
    manifest, transport: pair.host,
    capabilityExecutor: async (capability, input) => {
      requests.push({ capability, input });
      return { brokered: true };
    }
  });
  const response = new Promise((resolve) => {
    pair.child.onMessage((raw) => {
      const frame = JSON.parse(raw);
      if (frame.id === 'reverse-capability') resolve(frame);
    });
  });
  pair.child.send(JSON.stringify({
    v: 1, id: 'reverse-capability', kind: 'invoke', capability: 'network',
    input: { url: 'https://example.com/' }, extensionId: 'spoofed-extension',
    actor: { kind: 'owner', id: 'desktop' }, grants: ['*']
  }));
  const frame = await response;
  assert.deepEqual(requests, [{ capability: 'network', input: { url: 'https://example.com/' } }]);
  assert.equal(frame.kind, 'result');
  assert.deepEqual(frame.result, { brokered: true });
  await host.shutdown();
  ok('reverse Worker capability frames pass through Host executor; frame identity fields are ignored');
}

// Worker process smoke test: the bootstrap must speak only the existing frame protocol.
{
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-worker-bootstrap-'));
  const workerEntry = fileURLToPath(new URL('../src/extension/process-worker.js', import.meta.url));
  try {
    const workerManifest = assertManifest({
      id: 'fixture-ext', name: 'Fixture Extension', version: '1.0.0', entry: 'index.js', type: 'tool', permissions: [],
      capabilities: [{ id: 'greet', requires: [] }]
    });
    fs.writeFileSync(path.join(packageRoot, 'extension.json'), JSON.stringify(workerManifest));
    fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports.handlers = { greet: () => ({ hello: "worker" }) };');
    const input = [
      { v: 1, id: 'probe-1', kind: 'ping' },
      { v: 1, id: 'stop-1', kind: 'shutdown' }
    ].map((frame) => JSON.stringify(frame)).join('\n') + '\n';
    const child = spawnSync(process.execPath, [workerEntry], {
      cwd: packageRoot,
      env: buildExtensionWorkerEnv({ parentEnv: process.env, metadata: {
        extensionId: workerManifest.id, version: workerManifest.version, fingerprint: manifestFingerprint(workerManifest)
      } }),
      input, encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    assert.equal(child.error, undefined, `worker spawn failed: ${child.error?.message}`);
    assert.equal(child.status, 0, `worker exit: ${child.status}; stderr=${child.stderr}`);
    const frames = child.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(frames, [{ v: 1, id: 'probe-1', kind: 'pong' }]);
    ok('Worker subprocess handles existing ping/pong/shutdown frames');
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
}

// ── 1. invoke 往返 ───────────────────────────────────────────────────────────
{
  const { host } = makeHost();
  const result = await host.invoke('greet', { name: 'CetaMesh' });
  assert.equal(result.capability, 'greet');
  assert.deepEqual(result.result, { echoed: { name: 'CetaMesh' } });
  assert.equal(host.available(), true);
  ok('invoke 往返：帧协议 result 回填');
}

// ── 2. 能力白名单：未声明/未授权不出帧 ───────────────────────────────────────
{
  const sent = [];
  const pair = createInProcessTransportPair();
  pair.host.send = (frame) => { sent.push(frame); };
  const host = createProcessExtensionHost({ manifest, transport: pair.host });
  await assert.rejects(() => host.invoke('undeclared', {}), (e) => e.code === 'CAPABILITY_NOT_DECLARED');
  assert.deepEqual(sent, [], '未声明能力的 invoke 不得出帧');

  const restrictedManifest = { ...manifest, permissions: [] };
  const host2 = createProcessExtensionHost({ manifest: restrictedManifest, transport: pair.host });
  await assert.rejects(() => host2.invoke('fetch', {}), (e) => e.code === 'PERMISSION_DENIED');
  assert.deepEqual(sent, [], '未授予权限的 invoke 不得出帧');
  ok('能力白名单：未声明 / 未授予权限 → 不出帧直接拒绝（与 Vm 宿主同语义）');
}

// ── 3. 帧大小上限 ────────────────────────────────────────────────────────────
{
  const sent = [];
  const pair = createInProcessTransportPair();
  pair.host.send = (frame) => { sent.push(frame); };
  const host = createProcessExtensionHost({ manifest, transport: pair.host, maxMessageBytes: 1024 });
  await assert.rejects(() => host.invoke('greet', { blob: 'x'.repeat(4096) }), (e) => e.code === 'MESSAGE_TOO_LARGE');
  assert.deepEqual(sent, [], '超限帧不得发出');
  ok('帧大小上限：发送前拦截，不进入 transport');
}

// ── 4. 帧模式校验：坏帧丢弃，宿主不炸 ────────────────────────────────────────
{
  const { host, pair } = makeHost();
  let killed = false;
  pair.host.killTree = () => { killed = true; };
  pair.child.send('not-json{');
  assert.equal(host.available(), false, 'malformed frame marks ProcessHost unavailable');
  assert.equal(killed, true, 'malformed frame terminates the Worker process tree');
  await assert.rejects(() => host.invoke('greet', {}), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  ok('malformed frame fails closed and terminates its Worker');
}

// ── 5. 超时 ──────────────────────────────────────────────────────────────────
{
  const { host } = makeHost({ childBehavior: () => null }); // 进程端不应答
  await assert.rejects(() => host.invoke('greet', {}), (e) => e.code === 'INVOKE_TIMEOUT');
  assert.equal(host._inflight().length, 0, '超时后在途集合清空');
  ok('超时：无应答 → INVOKE_TIMEOUT，在途清空');
}

// ── 6. cancel + 迟到结果丢弃 ─────────────────────────────────────────────────
{
  const { host, pair } = makeHost({ latencyMs: 50 });
  const pendingInvoke = host.invoke('greet', { slow: true });
  const id = host._inflight()[0];
  const cancelled = host.cancel(id);
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(() => pendingInvoke, (e) => e.code === 'INVOKE_CANCELLED');
  pair.child.onMessage && null; // 迟到的 result 到达：
  await new Promise((resolve) => setTimeout(resolve, 120)); // 等 latency 后的迟到帧
  assert.equal(host._inflight().length, 0);
  const again = await host.invoke('greet', { after: 'cancel' }); // 迟到帧没有污染后续调用
  assert.ok(again.result);
  ok('cancel：在途立即裁决；迟到结果丢弃不串话');
}

// ── 7. shutdown + health ─────────────────────────────────────────────────────
{
  const { host } = makeHost();
  host.shutdown();
  assert.equal(host.available(), false);
  assert.equal(host.health().closed, true);
  await assert.rejects(() => host.invoke('greet', {}), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  ok('shutdown：拒绝后续 invoke，health 如实');
}

// ── 8. 与 VmExtensionHost 的接口形状一致 ─────────────────────────────────────
{
  const vmShape = ['manifest', 'logs', 'capabilities', 'loadError', 'available', 'invoke'];
  const processShape = ['manifest', 'logs', 'capabilities', 'loadError', 'available', 'invoke', 'cancel', 'shutdown', 'health'];
  const { host } = makeHost();
  for (const key of vmShape) assert.ok(key in host, `ProcessExtensionHost 应具备 Vm 宿主同名成员：${key}`);
  for (const key of processShape) assert.ok(typeof host[key] === 'function' || key in host, `契约成员缺失：${key}`);
  assert.equal(createExtensionHost, createVmExtensionHost, '活动宿主仍为 VmExtensionHost（真实进程沙箱不在本轮）');
  ok('契约一致性：Vm 宿主成员全覆盖 + cancel/shutdown/health 扩展；活动宿主未切换');
}

console.log(`\n🎉 ProcessExtensionHost 契约全部通过（${step} 组）`);
