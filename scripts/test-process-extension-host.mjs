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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProcessExtensionHost, createInProcessTransportPair } from '../src/extension/process-host.js';
import { createVmExtensionHost, createExtensionHost } from '../src/extension/host.js';

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

// Worker process smoke test: the bootstrap must speak only the existing frame protocol.
{
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-worker-bootstrap-'));
  const workerEntry = fileURLToPath(new URL('../src/extension/process-worker.js', import.meta.url));
  try {
    fs.writeFileSync(path.join(packageRoot, 'extension.json'), JSON.stringify({
      id: 'fixture-ext', name: 'Fixture Extension', version: '1.0.0', entry: 'index.js', type: 'tool', permissions: [],
      capabilities: [{ id: 'greet', requires: [] }]
    }));
    fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports.handlers = { greet: () => ({ hello: "worker" }) };');
    const input = [
      { v: 1, id: 'probe-1', kind: 'ping' },
      { v: 1, id: 'stop-1', kind: 'shutdown' }
    ].map((frame) => JSON.stringify(frame)).join('\n') + '\n';
    const child = spawnSync(process.execPath, [workerEntry], {
      cwd: packageRoot, env: process.env, input, encoding: 'utf8', timeout: 5000, windowsHide: true
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
  for (const bad of ['not-json{', JSON.stringify({ v: 2, id: 'x', kind: 'result' }),
    JSON.stringify({ v: 1, id: '', kind: 'result' }), JSON.stringify({ v: 1, id: 'x', kind: 'explode' }),
    JSON.stringify({ v: 1, id: 'x', kind: 'result', capability: 42 }), 42, null]) {
    pair.host.onMessage && pair.child.send(typeof bad === 'string' ? bad : JSON.stringify(bad));
  }
  const result = await host.invoke('greet', { still: 'alive' });
  assert.deepEqual(result.result, { echoed: { still: 'alive' } }, '坏帧全部丢弃，正常调用不受影响');
  ok('帧模式校验：非 JSON / 错版本 / 坏 id / 未知 kind / 坏形状 / 非 Object 全部丢弃');
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
