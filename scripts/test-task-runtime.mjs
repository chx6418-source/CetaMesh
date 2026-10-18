// CetaMesh Desktop — Persistent Task v1 验收测试（阶段 07）。
// 用法：node scripts/test-task-runtime.mjs
//
// 覆盖验收项：新建 / 修改 / 执行 / 暂停 / 恢复 / 重启恢复 / 更换 Agent Provider /
//             失败 / 取消 / 完成，外加状态机合法性、rev 冲突、幂等、领域字段完整性与 IPC 往返。
//
// 只使用隔离临时目录，不触碰真实 state/、不访问网络 / DSH。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createTaskRuntime, createTaskService, TASK_STATUSES, TASK_TRANSITIONS } from '../src/task/index.js';
import { startIpcProtocol, IPC_PROTOCOL_VERSION } from '../src/control/ipc-protocol.js';

let passed = 0;
let failed = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    passed += 1;
    console.log('PASS ' + name + (extra ? ' — ' + extra : ''));
  } else {
    failed += 1;
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
};
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : 'got ' + a + ' want ' + b);
};
const capture = (fn) => {
  try { return { threw: false, value: fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};
const asyncCapture = async (fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};

let clock = 1700000000000;
const now = () => clock;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-task-test-'));

try {
  const runtime = createTaskRuntime({ stateDir: root, now });

  // ── 1. 新建 ────────────────────────────────────────────────────────────
  const task = runtime.create({
    goal: '交付 CetaMesh Desktop v1',
    requirements: ['Chat', 'Tasks', 'Memory', 'Workspace'],
    workspaceId: 'ws-cetamesh',
    currentPhase: 'foundation',
    acceptanceCriteria: ['Fresh Windows 可安装', 'Tasks 可持久化']
  });
  check('新建返回 Task ID', typeof task.id === 'string' && task.id.length > 0, task.id);
  equal('新建默认状态 queued', task.status, 'queued');
  equal('新建 rev = 1', task.rev, 1);
  equal('Goal 落库', task.goal, '交付 CetaMesh Desktop v1');
  equal('Requirements 落库', task.requirements, ['Chat', 'Tasks', 'Memory', 'Workspace']);
  equal('Workspace 关联落库', task.workspaceId, 'ws-cetamesh');
  equal('Current Phase 落库', task.currentPhase, 'foundation');
  equal('Progress 初始为 0', task.progress.percent, 0);
  equal('Acceptance Criteria 归一化', task.acceptance.map((a) => a.text), ['Fresh Windows 可安装', 'Tasks 可持久化']);
  check('Acceptance 带 id 且未达成', task.acceptance.every((a) => a.id && a.met === false));

  const domainFields = ['id', 'goal', 'requirements', 'status', 'currentPhase', 'progress', 'completedWork',
    'pendingWork', 'workspaceId', 'artifacts', 'decisions', 'memoryRefs', 'checkpoint', 'acceptance',
    'agentHistory', 'createdAt', 'updatedAt'];
  const missing = domainFields.filter((field) => !(field in task));
  check('Task Domain 全部字段齐备', missing.length === 0, missing.length ? 'missing ' + missing.join(',') : '17/17');

  const noGoal = capture(() => runtime.create({}));
  check('Goal 为空被拒绝', noGoal.threw && noGoal.code === 'INVALID_PARAMS', String(noGoal.code));

  // ── 2. 修改 ────────────────────────────────────────────────────────────
  clock += 1000;
  const updated = runtime.update({
    id: task.id, expectedRev: task.rev, goal: '交付 CetaMesh Desktop v1（已细化）',
    requirements: ['Chat', 'Tasks', 'Memory', 'Workspace', 'Installer']
  });
  equal('修改递增 rev', updated.rev, 2);
  equal('修改生效', updated.goal, '交付 CetaMesh Desktop v1（已细化）');
  equal('Requirements 更新', updated.requirements.length, 5);

  const stale = capture(() => runtime.update({ id: task.id, expectedRev: 1, goal: '基于旧版本' }));
  check('过期 rev 修改冲突', stale.threw && stale.code === 'TASK_CONFLICT', String(stale.code));
  const noRev = capture(() => runtime.update({ id: task.id, goal: '没有 rev' }));
  check('缺 expectedRev 被拒绝', noRev.threw && noRev.code === 'REVISION_REQUIRED', String(noRev.code));
  equal('冲突后数据未被破坏', runtime.get({ id: task.id }).task.goal, '交付 CetaMesh Desktop v1（已细化）');

  // ── 3. 执行 ────────────────────────────────────────────────────────────
  clock += 1000;
  const started = runtime.start({ id: task.id, expectedRev: 2, provider: 'dsh', sessionId: 'sess-A', note: '开始 foundation' });
  equal('执行后状态 running', started.task.status, 'running');
  equal('执行绑定 Agent Provider', started.task.currentAgent, { provider: 'dsh', sessionId: 'sess-A' });
  equal('Agent History 记录一次', started.task.agentHistory.length, 1);
  equal('Agent History 项带 provider/session', [started.task.agentHistory[0].provider, started.task.agentHistory[0].sessionId], ['dsh', 'sess-A']);
  check('Agent History 项已附加时间', started.task.agentHistory[0].attachedAt > 0);

  const idempotent = runtime.start({ id: task.id, expectedRev: started.task.rev });
  equal('重复执行是幂等 no-op', idempotent.changed, false);
  equal('幂等不递增 rev', idempotent.task.rev, started.task.rev);

  // ── 4. 暂停 / 5. 恢复 ──────────────────────────────────────────────────
  clock += 1000;
  const paused = runtime.pause({ id: task.id, expectedRev: started.task.rev, reason: '等待所有者确认' });
  equal('暂停后状态 paused', paused.task.status, 'paused');

  clock += 1000;
  const resumed = runtime.resume({ id: task.id, expectedRev: paused.task.rev });
  equal('恢复后状态 running', resumed.task.status, 'running');
  equal('恢复不新建 Task（id 不变）', resumed.task.id, task.id);

  // ── 6. 更换 Agent Provider ─────────────────────────────────────────────
  clock += 1000;
  const switched = runtime.attachAgent({ id: task.id, expectedRev: resumed.task.rev, provider: 'codex', sessionId: 'sess-B', note: '换 Provider 继续' });
  equal('更换 Provider 后 task id 不变', switched.task.id, task.id);
  equal('更换 Provider 后 currentAgent 更新', switched.task.currentAgent, { provider: 'codex', sessionId: 'sess-B' });
  equal('Agent History 追加为 2 条', switched.task.agentHistory.length, 2);
  equal('Agent History 保留原 Provider', switched.task.agentHistory[0].provider, 'dsh');
  check('上一个 Session 被标记 detached', switched.task.agentHistory[0].detachedAt > 0);
  equal('Task 总数仍为 1（未新建）', runtime.countAll(), 1);

  const third = runtime.attachAgent({ id: task.id, expectedRev: switched.task.rev, provider: 'claude-code', sessionId: 'sess-C' });
  equal('第三次 Provider 切换仍不新建 Task', third.task.agentHistory.length, 3);
  equal('切换后任务数不变', runtime.countAll(), 1);

  // ── 7. Checkpoint / 工作项 / 产物 / 决策 / 记忆引用 / 验收 ──────────────
  clock += 1000;
  const withCheckpoint = runtime.setCheckpoint({
    id: task.id, expectedRev: third.task.rev,
    summary: 'Config/Memory 已完成，Task 运行时刚落地', nextAction: '接入 Tasks UI'
  });
  equal('Checkpoint summary 落库', withCheckpoint.checkpoint.summary, 'Config/Memory 已完成，Task 运行时刚落地');
  equal('Checkpoint nextAction 落库', withCheckpoint.checkpoint.nextAction, '接入 Tasks UI');

  const withWork = runtime.addWork({ id: task.id, expectedRev: withCheckpoint.rev, kind: 'completed', text: '统一配置服务' });
  const withWork2 = runtime.addWork({ id: task.id, expectedRev: withWork.rev, kind: 'pending', text: '真机视觉验收' });
  equal('Completed Work 落库', withWork2.completedWork.map((w) => w.text), ['统一配置服务']);
  equal('Pending Work 落库', withWork2.pendingWork.map((w) => w.text), ['真机视觉验收']);

  const withArtifact = runtime.addArtifact({ id: task.id, expectedRev: withWork2.rev, kind: 'test', label: 'test-task-runtime.mjs', ref: 'scripts/test-task-runtime.mjs' });
  equal('Artifacts 落库', withArtifact.artifacts.map((a) => a.label), ['test-task-runtime.mjs']);

  const withDecision = runtime.addDecision({ id: task.id, expectedRev: withArtifact.rev, decision: 'Task 不绑定 Agent Session', rationale: 'Task 要能比 Session 活得久' });
  equal('Decisions 落库', withDecision.decisions.map((d) => d.decision), ['Task 不绑定 Agent Session']);

  const withMemory = runtime.linkMemory({ id: task.id, expectedRev: withDecision.rev, memoryId: 'mem_abc', note: '相关长期记忆' });
  equal('Memory References 落库', withMemory.memoryRefs.map((m) => m.memoryId), ['mem_abc']);

  const accId = withMemory.acceptance[0].id;
  const met = runtime.setAcceptance({ id: task.id, expectedRev: withMemory.rev, acceptanceId: accId, met: true });
  check('验收标准可标记达成', met.acceptance[0].met === true && met.acceptance[0].metAt > 0);

  const progressed = runtime.setProgress({ id: task.id, expectedRev: met.rev, percent: 60, note: '过半' });
  equal('Progress 落库', progressed.progress.percent, 60);

  // ── 8. 重启恢复 ────────────────────────────────────────────────────────
  const beforeRestart = runtime.get({ id: task.id }).task;
  const restarted = createTaskRuntime({ stateDir: root, now });
  const afterRestart = restarted.get({ id: task.id }).task;
  equal('重启后 Task 仍在', afterRestart.id, beforeRestart.id);
  equal('重启后 Goal 保留', afterRestart.goal, beforeRestart.goal);
  equal('重启后 Status 保留', afterRestart.status, beforeRestart.status);
  equal('重启后 Progress 保留', afterRestart.progress.percent, 60);
  equal('重启后 Checkpoint 保留', afterRestart.checkpoint.nextAction, '接入 Tasks UI');
  equal('重启后 Agent History 保留', afterRestart.agentHistory.length, 3);
  equal('重启后 Agent Provider 序列保留', afterRestart.agentHistory.map((h) => h.provider), ['dsh', 'codex', 'claude-code']);
  equal('重启后 Workspace 关联保留', afterRestart.workspaceId, 'ws-cetamesh');
  equal('重启后 rev 保留', afterRestart.rev, beforeRestart.rev);
  equal('重启后 Completed Work 保留', afterRestart.completedWork.length, 1);
  equal('重启后 Artifacts 保留', afterRestart.artifacts.length, 1);
  equal('重启后 Decisions 保留', afterRestart.decisions.length, 1);
  equal('重启后 Memory References 保留', afterRestart.memoryRefs.length, 1);
  check('任务文件已落盘', fs.existsSync(path.join(root, 'tasks', 'tasks.json')));
  const fileData = JSON.parse(fs.readFileSync(path.join(root, 'tasks', 'tasks.json'), 'utf8'));
  check('落盘文件带 schemaVersion 与 revision', fileData.schemaVersion === 1 && fileData.revision > 0, 'revision=' + fileData.revision);

  // ── 9. 失败 / 10. 取消 / 11. 完成 ──────────────────────────────────────
  const failing = runtime.create({ goal: '会失败的任务', workspaceId: 'ws-x' });
  const failingRun = runtime.start({ id: failing.id, expectedRev: failing.rev, provider: 'dsh', sessionId: 's1' });
  clock += 1000;
  const failedTask = runtime.fail({ id: failing.id, expectedRev: failingRun.task.rev, reason: 'DSH 连接失败' });
  equal('失败后状态 failed', failedTask.task.status, 'failed');
  equal('失败原因落库', failedTask.task.failure.reason, 'DSH 连接失败');
  equal('失败后解绑当前 Agent', failedTask.task.currentAgent, null);
  check('failed 是终态', TASK_TRANSITIONS.failed.length === 0);

  const cancelling = runtime.create({ goal: '会被取消的任务' });
  const cancellingRun = runtime.start({ id: cancelling.id, expectedRev: cancelling.rev });
  const cancelled = runtime.cancel({ id: cancelling.id, expectedRev: cancellingRun.task.rev, reason: '所有者取消' });
  equal('取消后状态 cancelled', cancelled.task.status, 'cancelled');
  equal('取消原因落库', cancelled.task.failure.reason, '所有者取消');
  check('cancelled 是终态', TASK_TRANSITIONS.cancelled.length === 0);

  const completing = runtime.create({ goal: '会完成的任务', acceptanceCriteria: ['测试通过'] });
  const completingRun = runtime.start({ id: completing.id, expectedRev: completing.rev });
  clock += 1000;
  const completed = runtime.complete({ id: completing.id, expectedRev: completingRun.task.rev, summary: '全部验收通过' });
  equal('完成后状态 completed', completed.task.status, 'completed');
  equal('完成后 Progress 置 100', completed.task.progress.percent, 100);
  equal('完成摘要落库', completed.task.result.summary, '全部验收通过');
  check('completed 是终态', TASK_TRANSITIONS.completed.length === 0);

  // ── 12. 非法状态迁移 ───────────────────────────────────────────────────
  const reopened = capture(() => runtime.start({ id: completing.id, expectedRev: completed.task.rev }));
  check('终态不可回到 running', reopened.threw && reopened.code === 'TASK_INVALID_TRANSITION', String(reopened.code));
  const unqueue = capture(() => runtime.pause({ id: failing.id, expectedRev: failedTask.task.rev }));
  check('failed 不可暂停', unqueue.threw && unqueue.code === 'TASK_INVALID_TRANSITION', String(unqueue.code));
  check('状态词表完整', TASK_STATUSES.length === 8 && TASK_STATUSES.includes('waiting') && TASK_STATUSES.includes('blocked'));

  // ── 13. 列表 / Needs Attention / overview ──────────────────────────────
  const runningList = runtime.list({ status: 'running' });
  check('按状态过滤生效', runningList.tasks.every((t) => t.status === 'running'));
  const attention = runtime.list({ onlyNeedsAttention: true });
  check('Needs Attention 含 failed', attention.tasks.some((t) => t.id === failing.id));
  const byWorkspace = runtime.list({ workspaceId: 'ws-cetamesh' });
  equal('按 Workspace 过滤生效', byWorkspace.tasks.length, 1);

  // blocked / waiting 进入 Needs Attention
  const blockable = runtime.create({ goal: '会被阻塞的任务' });
  const blockRun = runtime.start({ id: blockable.id, expectedRev: blockable.rev });
  const blocked = runtime.block({ id: blockable.id, expectedRev: blockRun.task.rev, reason: '等待外部依赖' });
  equal('阻塞后状态 blocked', blocked.task.status, 'blocked');
  const attention2 = runtime.list({ onlyNeedsAttention: true });
  check('blocked 进入 Needs Attention', attention2.tasks.some((t) => t.id === blockable.id));
  const waited = runtime.wait({ id: blockable.id, expectedRev: blocked.task.rev, reason: '等待回复' });
  equal('blocked 可转 waiting', waited.task.status, 'waiting');

  const overview = runtime.overview({});
  check('overview 返回计数', overview.counts && overview.counts.completed === 1 && overview.counts.failed === 1);
  equal('overview 返回需要关注的任务', overview.needsAttention.includes(failing.id), true);

  // ── 14. Service + IPC 往返 ─────────────────────────────────────────────
  const svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-task-svc-'));
  const service = createTaskService({ stateDir: svcDir, now });
  const created = await service.execute({ method: 'task.create', params: { goal: '服务层任务', workspaceId: 'ws-svc' } });
  check('service task.create 可用', Boolean(created.id));
  const svcStarted = await service.execute({ method: 'task.start', params: { id: created.id, expectedRev: created.rev, provider: 'dsh', sessionId: 'svc-1' } });
  equal('service task.start 可用', svcStarted.task.status, 'running');
  const svcPaused = await service.execute({ method: 'task.pause', params: { id: created.id, expectedRev: svcStarted.task.rev } });
  equal('service task.pause 可用', svcPaused.task.status, 'paused');
  const svcOverview = await service.execute({ method: 'task.overview', params: {} });
  check('service task.overview 可用', Array.isArray(svcOverview.tasks) && typeof svcOverview.counts === 'object');
  const uncertainRuntime = createTaskRuntime({ stateDir: path.join(root, 'uncertain-writer'), now });
  const uncertainTask = uncertainRuntime.create({ goal: '未核对的旧写入', workspaceId: 'ws-uncertain' });
  const uncertainStarted = uncertainRuntime.start({ id: uncertainTask.id, expectedRev: uncertainTask.rev,
    provider: 'codex', sessionId: 'lost-session' });
  const uncertainWaiting = uncertainRuntime.wait({ id: uncertainTask.id, expectedRev: uncertainStarted.task.rev,
    reason: 'approval-pending: write outcome unknown' });
  equal('等待审批的 Task 仍占用 Workspace 写入权',
    uncertainRuntime.activeWorkspaceOwner({ workspaceId: 'ws-uncertain' })?.id, uncertainTask.id);
  uncertainRuntime.block({ id: uncertainTask.id, expectedRev: uncertainWaiting.task.rev,
    reason: 'needs-reconciliation: interrupted effect' });
  equal('失联 Blocked Task 在人工核验前仍占用 Workspace 写入权',
    uncertainRuntime.activeWorkspaceOwner({ workspaceId: 'ws-uncertain' })?.id, uncertainTask.id);
  const unknown = await asyncCapture(() => service.execute({ method: 'task.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknown.threw && unknown.code === 'METHOD_NOT_FOUND', String(unknown.code));

  // IPC 端到端（memory 的同一命名管道协议）
  const ipcService = createTaskService({ stateDir: svcDir, now });
  const dispatch = ({ method, params }) => {
    if (method.startsWith('task.')) return ipcService.execute({ method, params });
    throw new Error('unexpected method ' + method);
  };
  const input = new PassThrough({ autoDestroy: false });
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const ipc = startIpcProtocol({ input, output, dispatch });
  const encode = (payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    return frame;
  };
  const req = (id, method, params) => ({ version: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params }) });
  input.write(encode(req('t1', 'task.get', { id: created.id })));
  input.write(encode(req('t2', 'task.overview', {})));
  input.end();
  await ipc.done;
  const frames = [];
  {
    const buffer = Buffer.concat(chunks);
    let offset = 0;
    while (offset + 4 <= buffer.length) {
      const size = buffer.readUInt32LE(offset);
      frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString('utf8')));
      offset += 4 + size;
    }
  }
  const getFrame = frames.find((f) => f.id === 't1');
  const ovFrame = frames.find((f) => f.id === 't2');
  check('IPC task.get 往返成功', Boolean(getFrame && getFrame.ok === true), JSON.stringify(getFrame));
  check('IPC task.get 返回同一任务', Boolean(getFrame && getFrame.ok && getFrame.result && getFrame.result.task && getFrame.result.task.id === created.id), JSON.stringify(getFrame && getFrame.error));
  check('IPC task.overview 往返成功', Boolean(ovFrame && ovFrame.ok === true), JSON.stringify(ovFrame && ovFrame.error));
  fs.rmSync(svcDir, { recursive: true, force: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('Persistent Task v1 验收全部通过（阶段 07）');
