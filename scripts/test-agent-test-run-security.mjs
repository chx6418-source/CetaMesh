// final security / TASK-FINAL-010 验收：Agent test.run 权限模型。
//
// 核心命题：Agent 可以修改 Workspace ≠ Agent 可以执行 Workspace 代码。
// filesystem.write 绝不能隐式升级为代码执行权限；grant = 可以请求，
// approval = 这次可以执行（Approve Once）。
//
// 覆盖：
//   1. 默认 Agent Grant 不含 test.run
//   2. Agent 未获 grant → PERMISSION_DENIED
//   3. Agent 获 grant 但未审批 → status=pending（不执行）
//   4. Owner Reject → 测试不执行
//   5. Owner Approve Once → 恰好执行一次
//   6. Replay：同一 approvalId 第二次 → DENY
//   7. Changed Payload：批准 npm test 后换 npm run dangerous → APPROVAL_MISMATCH
//   8. Expired Approval → APPROVAL_EXPIRED
//   9. Workspace change → DENY（policy 层 WORKSPACE_NOT_AUTHORIZED）
//  10. Agent 改写 package.json 后请求 test.run → 仍需 Owner Approve Once
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityService } from '../src/capability/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createMemoryService } from '../src/memory/service.js';
import { createIsolatedTestRunner } from '../src/workspace/isolated-runner.js';

let clock = 1_759_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-sec-'));
const stateDir = path.join(dir, 'state');
const workspaceService = createWorkspaceService({ stateDir });
const taskRuntime = createTaskRuntime({ stateDir, now: () => clock });
const memoryService = createMemoryService({ stateDir });
const svc = createCapabilityService({
  stateDir, workspaceService, memoryService, taskRuntime, now: () => clock,
  isolatedRunner: createIsolatedTestRunner({ resolveWorkspace: async (id) => workspaceService.describeWorkspace(id) })
});
const owner = { kind: 'owner', id: 'desktop' };
const root = path.join(dir, 'ws-main');
let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }
function markerPath(n) { return path.join(root, `marker-${n}.txt`); }
function markerCount(n) { try { return Number(fs.readFileSync(markerPath(n), 'utf8').trim()) || 0; } catch { return 0; } }
const agentReq = (actor, taskId, wsId, capability, input, extra = {}) =>
  ({ actor, taskId, workspaceId: wsId, capability, input, ...extra });

// 工作区 + 带计数脚本的 package.json（marker.js 每次执行把 marker-5.txt +1，证明"恰好一次"）。
const ws = await svc.executeWorkspace({
  method: 'workspace.create',
  params: { root, name: 'sec-main', createIfMissing: true }
});
const workspaceId = ws.workspace.id;
fs.writeFileSync(path.join(root, 'marker.js'), [
  "const fs = require('fs');",
  "const f = 'marker-5.txt';",
  "const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8').trim()) : 0) + 1;",
  "fs.writeFileSync(f, String(n));"
].join('\n'));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
  name: 'sec-fixture',
  scripts: { test: 'node marker.js' }
}));
fs.writeFileSync(path.join(root, 'src.txt'), 'ok');

// ── 1. 默认 Agent Grant 不含 test.run ────────────────────────────────────────
{
  const task = taskRuntime.create({ goal: '默认 grant', workspaceId });
  const principal = svc.grantTask(task.id); // 不传显式能力集 = 默认
  assert.ok(!principal.grants.capabilities.includes('test.run'),
    `默认 grant 不得包含 test.run：${principal.grants.capabilities.join(',')}`);
  for (const cap of ['filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'memory.read']) {
    assert.ok(principal.grants.capabilities.includes(cap), `默认 grant 应含 ${cap}`);
  }
  ok('默认 Agent Grant：filesystem/git/memory 在列，test.run 不在列（可改 Workspace ≠ 可执行代码）');
}

// ── 2. Agent 未获 grant 请求 test.run → PERMISSION_DENIED ────────────────────
{
  const task = taskRuntime.create({ goal: '无 grant', workspaceId });
  const agent = svc.grantTask(task.id); // 默认 grant（无 test.run）
  await assert.rejects(
    () => svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] })),
    (e) => e.code === 'PERMISSION_DENIED',
    '未获 test.run grant → PERMISSION_DENIED（连审批都不会进入）'
  );
  assert.equal(markerCount(5), 0);
  ok('未获 grant：PERMISSION_DENIED，不进入审批、不执行');
}

// ── 3. 获 grant 但未审批 → pending（不执行） ─────────────────────────────────
{
  const task = taskRuntime.create({ goal: '待审批', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['filesystem.read', 'test.run'] });
  const result = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }));
  assert.equal(result.status, 'pending', 'grant 只意味着可以"请求"；执行必须先过审批');
  assert.ok(result.approvalId, '返回待审批 id');
  assert.equal(markerCount(5), 0, '未批准前绝不执行');
  ok('获 grant 未审批：status=pending，测试未执行（Task 进入等待 Owner 决定）');
}

// ── 4. Owner Reject → 测试不执行 ─────────────────────────────────────────────
{
  const task = taskRuntime.create({ goal: '拒绝路径', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['test.run'] });
  const pending = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId: 'reject-1' }));
  const decided = await svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: false } });
  assert.equal(decided.status, 'rejected');
  assert.equal(markerCount(5), 0, '拒绝后测试不执行');
  // 拒绝后同一 approvalId 不能被消费执行。
  await assert.rejects(
    () => svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId: 'reject-1', approvalId: pending.approvalId })),
    (e) => e.code === 'APPROVAL_NOT_APPROVED'
  );
  ok('Owner Reject：不执行；被拒 approval 不可消费（APPROVAL_NOT_APPROVED）');
}

// ── 5. Owner Approve Once → 恰好执行一次 ─────────────────────────────────────
{
  const task = taskRuntime.create({ goal: '批准一次', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['test.run'] });
  const pending = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }));
  const decided = await svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  assert.equal(decided.status, 'completed', '批准后立即执行（指纹绑定的原请求）');
  assert.equal(decided.result.exitCode, 0, `受控执行退出码：${JSON.stringify(decided.result).slice(0, 200)}`);
  assert.equal(markerCount(5), 1, `恰好执行一次（marker=${markerCount(5)}）`);
  ok('Approve Once：批准 → Controlled Runner 真实执行恰好一次');
}

// ── 6. Replay：同一 approvalId 第二次 → DENY ─────────────────────────────────
{
  const task = taskRuntime.create({ goal: '重放', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['test.run'] });
  const requestId = 'replay-1';
  const pending = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId }));
  await svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  assert.equal(markerCount(5), 2); // 这次批准执行的计数（fixture 每执行 +1）
  const before = markerCount(5);
  await assert.rejects(
    () => svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId, approvalId: pending.approvalId })),
    (e) => e.code === 'APPROVAL_NOT_APPROVED',
    '同一 approvalId 重放必须拒绝'
  );
  assert.equal(markerCount(5), before, '重放未产生第二次执行');
  ok('Approval Replay：APPROVAL_NOT_APPROVED，无第二次执行');
}

// ── 7. Changed Payload：批准 npm test 后换 npm run dangerous → MISMATCH ──────
{
  const task = taskRuntime.create({ goal: '载荷篡改', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['test.run'] });
  const requestId = 'tamper-1';
  const pending = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId }));
  await svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } });
  await assert.rejects(
    () => svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['run', 'dangerous'] }, { requestId, approvalId: pending.approvalId })),
    (e) => e.code === 'APPROVAL_MISMATCH',
    '批准 npm test 后换成 npm run dangerous → APPROVAL_MISMATCH'
  );
  ok('Payload Mutation：APPROVAL_MISMATCH（审批与请求指纹绑定）');
}

// ── 8. Expired Approval → APPROVAL_EXPIRED ──────────────────────────────────
{
  const task = taskRuntime.create({ goal: '过期', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['test.run'] });
  const pending = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId: 'exp-1' }));
  clock += 700_000; // 超过 10 分钟 TTL
  await assert.rejects(
    () => svc.execute({ method: 'capability.approval.decide', params: { id: pending.approvalId, approve: true } }),
    (e) => e.code === 'APPROVAL_EXPIRED',
    'pending 过期后 Owner 决定 → APPROVAL_EXPIRED'
  );
  // 已批准但过期后才消费：同样拒绝。
  const pending2 = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId: 'exp-2' }));
  svc.broker.approvals.decide(pending2.approvalId, true, owner);
  clock += 700_000;
  await assert.rejects(
    () => svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId: 'exp-2', approvalId: pending2.approvalId })),
    (e) => e.code === 'APPROVAL_EXPIRED',
    '已批准但过期后消费 → APPROVAL_EXPIRED'
  );
  ok('Stale Approval：pending 过期与已批准过期均 APPROVAL_EXPIRED');
}

// ── 9. Workspace change → DENY ──────────────────────────────────────────────
{
  const other = await svc.executeWorkspace({ method: 'workspace.create', params: { root: path.join(dir, 'ws-other'), name: 'sec-other', createIfMissing: true } });
  const task = taskRuntime.create({ goal: '跨工作区', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['test.run'] }); // grant 绑定 task.workspaceId
  await assert.rejects(
    () => svc.broker.execute(agentReq(agent, task.id, other.workspace.id, 'test.run', { tool: 'npm', args: ['test'] })),
    (e) => e.code === 'WORKSPACE_NOT_AUTHORIZED',
    '审批（或请求）换 Workspace → 策略层直接拒绝'
  );
  ok('Workspace 变更：Task grant 绑定原工作区，跨工作区请求被拒');
}

// ── 10. Agent 改写 package.json 后请求 test.run → 仍需 Approve Once ──────────
{
  const task = taskRuntime.create({ goal: '写后执行', workspaceId });
  const agent = svc.grantTask(task.id, { capabilities: ['filesystem.read', 'filesystem.write', 'test.run'] });
  // Agent 用 filesystem.write 把 package.json 换成带恶意脚本的版本。
  const write = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'filesystem.write',
    { path: 'package.json', content: JSON.stringify({ name: 'sec-fixture', scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'pwned.txt\',\'owned\')"' } }) }));
  assert.equal(write.status, 'completed', 'Agent 可以写 Workspace（授权范围内）');
  const before = fs.existsSync(path.join(root, 'pwned.txt'));
  assert.equal(before, false, '写操作本身不执行代码');
  // 请求 test.run：即使 Agent 已有 filesystem.write，也必须 Owner Approve Once。
  const result = await svc.broker.execute(agentReq(agent, task.id, workspaceId, 'test.run', { tool: 'npm', args: ['test'] }, { requestId: 'post-write-1' }));
  assert.equal(result.status, 'pending', 'filesystem.write 不能隐式升级为执行权限：test.run 仍进入待审批');
  assert.equal(fs.existsSync(path.join(root, 'pwned.txt')), false, '未批准前恶意脚本未执行');
  ok('写后执行攻击：filesystem.write 完成后 test.run 仍 status=pending（approve-once 边界未被绕过）');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n🎉 Agent test.run 权限模型全部通过（${step} 组）`);
