// v2 hardening / Phase 17 验收：攻击性 negative 测试补齐（新增向量）。
//
// 已由既有套件覆盖的向量不在此重复（见文件末尾"已覆盖"清单）；本脚本补齐：
//   1. Agent 持有 Task A 的 grant，却以 Task B / 其它 Workspace 越权 → 拒绝；
//   2. 无 grant 的 agent → PERMISSION_DENIED；
//   3. Agent 的 capability input 不能携带 actor/grants/taskId/approved 提权字段（被策略忽略）；
//   4. 无效审批重放：同一 approvalId 二次消费 → 拒绝；
//   5. 过期审批：pending 过期后 decide → APPROVAL_EXPIRED；已批准但过期后消费 → APPROVAL_EXPIRED；
//   6. Agent 经 Broker 的 test.run：非 allowlist 命令（bash/node）→ TEST_COMMAND_NOT_ALLOWED；
//   7. Agent 经 Broker 的 test.run 指向未授权 Workspace → WORKSPACE_NOT_AUTHORIZED；
//   8. Extension 未声明 host 的网络请求 → NETWORK_SCOPE_DENIED（Broker 网络能力面复核）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityService } from '../src/capability/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createIsolatedTestRunner } from '../src/workspace/isolated-runner.js';

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-neg-'));
const stateDir = path.join(dir, 'state');
let clock = 1_759_000_000_000;
const workspaceService = createWorkspaceService({ stateDir });
const taskRuntime = createTaskRuntime({ stateDir, now: () => clock });
const svc = createCapabilityService({
  stateDir, workspaceService, taskRuntime, now: () => clock,
  isolatedRunner: createIsolatedTestRunner({ resolveWorkspace: async (id) => workspaceService.describeWorkspace(id) })
});
const owner = { kind: 'owner', id: 'desktop' };
const deny = (p, code) => assert.rejects(p, (e) => e.code === code, `期望 ${code}`);
const approve = async (capability, input = {}, extra = {}) => {
  const pending = await svc.broker.execute({ actor: owner, capability, input, ...extra });
  assert.equal(pending.status, 'pending', `${capability} 应进入待审批`);
  const done = await svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  return { pending, done };
};

try {
  // 准备：两个工作区 + 两个任务（A 有 grant，B 没有）。
  const wsA = (await approve('workspace.create', { root: path.join(dir, 'ws-a'), createIfMissing: true, name: 'a' })).done.result.workspace.id;
  const wsB = (await approve('workspace.create', { root: path.join(dir, 'ws-b'), createIfMissing: true, name: 'b' })).done.result.workspace.id;
  fs.writeFileSync(path.join(dir, 'ws-b', 'secret.txt'), 'B-SECRET');
  const taskA = taskRuntime.create({ goal: 'task A', workspaceId: wsA });
  const taskB = taskRuntime.create({ goal: 'task B', workspaceId: wsB });
  svc.grantTask(taskA.id, { capabilities: ['filesystem.read', 'filesystem.write', 'test.run'], workspaceIds: [wsA] });
  const agentA = svc.principalForTask(taskA.id);

  // ── 1. 跨任务越权：Task A 的 grant 指向 Task B ────────────────────────────
  await deny(svc.broker.execute({ actor: agentA, taskId: taskB.id, workspaceId: wsB, capability: 'filesystem.read', input: { path: 'secret.txt' } }), 'TASK_NOT_AUTHORIZED');
  await deny(svc.broker.execute({ actor: agentA, taskId: taskA.id, workspaceId: wsB, capability: 'filesystem.read', input: { path: 'secret.txt' } }), 'WORKSPACE_NOT_AUTHORIZED');
  ok('跨任务/跨工作区越权：Task A 的 grant 无法读取 Task B / 工作区 B（TASK_NOT_AUTHORIZED + WORKSPACE_NOT_AUTHORIZED）');

  // ── 2. 无 grant 的 agent ─────────────────────────────────────────────────
  const naked = { kind: 'agent', id: 'task:ghost', grants: { capabilities: [], workspaceIds: [], taskIds: [] } };
  await deny(svc.broker.execute({ actor: naked, taskId: taskB.id, workspaceId: wsB, capability: 'filesystem.read', input: { path: 'secret.txt' } }), 'PERMISSION_DENIED');
  ok('无 grant 的 agent：PERMISSION_DENIED（能力集为空一律拒绝）');

  // ── 3. capability input 提权字段被忽略（身份来自服务端绑定） ───────────────
  fs.writeFileSync(path.join(dir, 'ws-a', 'a.txt'), 'A-OK');
  const spoof = await svc.broker.execute({
    actor: agentA, taskId: taskA.id, workspaceId: wsA, capability: 'filesystem.read',
    input: { path: 'a.txt', actor: { kind: 'owner', id: 'desktop' }, grants: { capabilities: ['*'] }, taskId: taskB.id, workspaceId: wsB, approved: true }
  });
  assert.equal(spoof.status, 'completed');
  assert.equal(spoof.result.content, 'A-OK', 'input 中的路径作用域仍为服务端绑定的 ws-a');
  ok('input 提权字段：actor/grants/taskId/workspaceId/approved 在 input 中一律无效（作用域来自服务端）');

  // ── 4. 审批重放：同一 approvalId 二次消费（同 requestId = 完全重放） ───────
  svc.broker.register({ id: 'publish.artifact', permission: 'publish', risk: 'high', execute: () => ({ sent: true }) });
  const first = await svc.broker.execute({ actor: owner, capability: 'publish.artifact', input: {}, requestId: 'neg-1' });
  assert.equal(first.status, 'pending');
  const consumed = await svc.execute({ method: 'capability.approval.decide', params: { id: first.approvalId, approve: true } });
  assert.equal(consumed.status, 'completed');
  await deny(svc.broker.execute({ actor: owner, capability: 'publish.artifact', input: {}, requestId: 'neg-1', approvalId: first.approvalId }), 'APPROVAL_NOT_APPROVED');
  await deny(svc.broker.execute({ actor: owner, capability: 'publish.artifact', input: { changed: true }, requestId: 'neg-2', approvalId: first.approvalId }), 'APPROVAL_MISMATCH');
  ok('审批重放：已消费 approvalId 完全重放 → APPROVAL_NOT_APPROVED；换载荷重放 → APPROVAL_MISMATCH');

  // ── 5. 过期审批：pending 过期后 decide / approved 过期后 consume ──────────
  const stale = await svc.broker.execute({ actor: owner, capability: 'publish.artifact', input: {}, requestId: 'neg-3' });
  clock += 700_000; // 超过 10 分钟 TTL
  await deny(svc.execute({ method: 'capability.approval.decide', params: { id: stale.approvalId, approve: true } }), 'APPROVAL_EXPIRED');
  const approvedRow = await svc.broker.execute({ actor: owner, capability: 'publish.artifact', input: {}, requestId: 'neg-4' });
  svc.broker.approvals.decide(approvedRow.approvalId, true, owner); // 直接批准（不立即消费）
  clock += 700_000;
  // 同 requestId（指纹一致）→ 过期检查命中 APPROVAL_EXPIRED（而非 MISMATCH）。
  await deny(svc.broker.execute({ actor: owner, capability: 'publish.artifact', input: {}, requestId: 'neg-4', approvalId: approvedRow.approvalId }), 'APPROVAL_EXPIRED');
  ok('过期审批：pending 过期后 decide → APPROVAL_EXPIRED；已批准但过期后消费同样 APPROVAL_EXPIRED');

  // ── 6. Agent test.run 经 Broker：非 allowlist 命令 ────────────────────────
  await deny(svc.broker.execute({ actor: agentA, taskId: taskA.id, workspaceId: wsA, capability: 'test.run', input: { tool: 'bash', args: ['-c', 'rm -rf /'] } }), 'TEST_COMMAND_NOT_ALLOWED');
  await deny(svc.broker.execute({ actor: agentA, taskId: taskA.id, workspaceId: wsA, capability: 'test.run', input: { tool: 'npm', args: ['install', 'malicious'] } }), 'TEST_COMMAND_NOT_ALLOWED');
  ok('Agent test.run：非 allowlist 命令经 Broker 仍被拒（bash / npm install → TEST_COMMAND_NOT_ALLOWED）');

  // ── 7. Agent test.run 指向未授权 Workspace ───────────────────────────────
  await deny(svc.broker.execute({ actor: agentA, taskId: taskA.id, workspaceId: wsB, capability: 'test.run', input: { tool: 'npm', args: ['test'] } }), 'WORKSPACE_NOT_AUTHORIZED');
  ok('Agent test.run：跨工作区（未授权）→ WORKSPACE_NOT_AUTHORIZED');

  // ── 8. Extension 未声明 host 的网络请求（Broker 网络能力面复核） ──────────
  const ext = { kind: 'extension', id: 'fixture-ext', grants: { capabilities: ['network'], workspaceIds: [], hosts: ['api.allowed.example'] } };
  await deny(svc.broker.execute({ actor: ext, capability: 'network', input: { url: 'https://evil.example/steal' } }), 'NETWORK_SCOPE_DENIED');
  await deny(svc.broker.execute({ actor: ext, capability: 'network', input: { url: 'http://user:pass@api.allowed.example/x' } }), 'NETWORK_SCOPE_DENIED');
  ok('Extension 网络：未声明 host 与带凭据 URL 一律 NETWORK_SCOPE_DENIED');

  console.log('\n已由既有套件覆盖（不重复）：');
  console.log('  ../ 穿越 / 绝对路径 / junction 逃逸 → test-workspace-runtime + test-capability-broker');
  console.log('  未知 capability / 未知 permission / external actor → test-capability-broker');
  console.log('  Workshop 提交者直读 Workspace → test-workshop-runtime');
  console.log('  Memory 跨作用域 / Memory Pack 指令升级 → test-memory-link');
  console.log('  Extension 未声明路径 → test-capability-broker + test-extension-capability');
  console.log('  审批指纹篡改（APPROVAL_MISMATCH）→ test-capability-broker');
  console.log(`\n🎉 攻击性 negative 补齐全部通过（${step} 组）`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
