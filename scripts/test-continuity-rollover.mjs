// 阶段 09 验收（会话 2 移植到 Agent Broker）：Context Rollover 与 Agent Handoff。
// fixture AgentProvider（正式契约，经 Broker）+ 隔离 stateDir + 真实 TaskRuntime。
// 验证：模拟低阈值强制 rollover；Task/Workspace/Progress 不丢；新 Session 可继续；
// 无重复执行；跨 Provider Handoff；Bootstrap 结构化恢复（不复制聊天历史）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskRuntime } from '../src/task/runtime.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createContinuityService } from '../src/continuity/service.js';
import { bandFor, normalizePacket } from '../src/continuity/types.js';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'continuity-test-'));
const stateRoot = path.join(temp, 'state');
fs.mkdirSync(stateRoot, { recursive: true });

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

function mockProvider(id, log, options = {}) {
  // The rollover fixture begins from `${id}-s1`; generate a distinct target id.
  let seq = 1;
  return defineAgentProvider({
    id,
    label: `Mock ${id}`,
    capabilityExtras: { workspaceBoundary: 'capability-broker' },
    methods: {
      async createSession() {
        if (options.gate?.blocked) {
          await new Promise((resolve) => { options.gate.release = resolve; });
        }
        seq += 1;
        log.push({ kind: 'create', provider: id, seq });
        return { sessionId: `${id}-s${seq}`, providerId: id };
      },
      async send({ sessionId, content }) {
        log.push({ kind: 'prompt', sessionId, text: content });
        if (options.failSend) throw Object.assign(new Error('fixture bootstrap rejected'), { code: 'PROVIDER_ERROR' });
        return { accepted: true };
      },
      async cancel(sessionId) {
        log.push({ kind: 'cancel', sessionId: sessionId?.sessionId ?? sessionId });
        return { cancelled: true };
      },
      async status() {
        if (options.statusError) throw Object.assign(new Error('fixture session is missing'), { code: options.statusError });
        return { running: false };
      },
      async contextUsage() {
        return { available: false };
      },
      async resume({ sessionId }) {
        return { resumed: true, sessionId };
      },
      async closeSession({ sessionId }) {
        log.push({ kind: 'archive', sessionId });
        return { archived: true, supported: true, sessionId };
      },
      async selectModel({ sessionId, model }) {
        return { sessionId, selected: { model } };
      },
      async health() {
        return { available: true, provider: id };
      },
      follow() {
        throw Object.assign(new Error('mock 无事件流'), { code: 'AGENT_UNSUPPORTED' });
      }
    }
  });
}

/** 每组独立 stateDir；task 写操作统一带最新 rev（store 乐观锁）。 */
function setup({ policy, gate, failSendProvider, alphaStatusError } = {}) {
  const log = [];
  const dir = fs.mkdtempSync(path.join(stateRoot, 'case-'));
  const taskRuntime = createTaskRuntime({ stateDir: dir });
  const rev = (id) => taskRuntime.get({ id }).task.rev;
  const registry = createAgentProviderRegistry();
  const alpha = mockProvider('alpha', log, { gate, failSend: failSendProvider === 'alpha', statusError: alphaStatusError });
  const beta = mockProvider('beta', log, { failSend: failSendProvider === 'beta' });
  registry.register(alpha);
  registry.register(beta);
  const broker = createAgentBroker({ registry });
  const service = createContinuityService({ taskRuntime, stateDir: dir, agentBroker: broker, policy });
  return { service, runtime: service.runtime, broker, taskRuntime, log, rev, dir };
}

// ── 4a. Core restart: only SESSION_NOT_FOUND triggers a safe fresh-session handoff ──
{
  const { runtime, taskRuntime, rev, log } = setup({ alphaStatusError: 'SESSION_NOT_FOUND' });
  const task = taskRuntime.create({ goal: 'Core restart after Agent session loss', workspaceId: 'ws-restart-recovery' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old-after-restart' });
  taskRuntime.setProgress({ id: task.id, expectedRev: rev(task.id), percent: 37, note: 'checkpoint survives restart' });
  const before = taskRuntime.get({ id: task.id }).task;
  const result = await runtime.rollover({ taskId: task.id, reason: 'provider-switch', targetProvider: 'beta' });
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(result.from.sessionId, 'alpha-old-after-restart');
  assert.equal(after.id, before.id);
  assert.equal(after.workspaceId, before.workspaceId);
  assert.equal(after.progress.note, before.progress.note);
  assert.deepEqual(after.currentAgent, { provider: 'beta', sessionId: 'beta-s2' });
  assert.ok(log.some(entry => entry.kind === 'prompt' && entry.sessionId === 'beta-s2'), 'new Provider accepts the structured resume prompt');
  ok('Core restart stale Session: SESSION_NOT_FOUND rolls over safely while preserving Task, Workspace, and progress');
}

// ── 1. 阈值带与 evaluate：70% 只建议 checkpoint 不切换（workplan D6-014 要求） ──
{
  const { runtime, taskRuntime, rev } = setup();
  const task = taskRuntime.create({ goal: '重写导出器', requirements: ['保持 CLI 兼容'] });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s0' });
  runtime.monitor.record('alpha:alpha-s0', { inputTokens: 7000, windowTokens: 10000 });
  const at70 = runtime.evaluate({ taskId: task.id });
  assert.equal(at70.level.percent, 70);
  assert.equal(at70.level.band, 'prepare');
  assert.equal(at70.action, 'checkpoint', '70% 只生成 checkpoint，不切换');

  const fresh = setup();
  const task2 = fresh.taskRuntime.create({ goal: '轻任务' });
  fresh.taskRuntime.attachAgent({ id: task2.id, expectedRev: fresh.rev(task2.id), provider: 'alpha', sessionId: 'fresh-s0' });
  fresh.runtime.monitor.record('alpha:fresh-s0', { inputTokens: 5000, windowTokens: 10000 });
  const at50 = fresh.runtime.evaluate({ taskId: task2.id });
  assert.equal(at50.action, 'none');
  assert.equal(bandFor(50), 'normal');
  assert.equal(bandFor(91), 'forced');
  assert.equal(bandFor(95), 'emergency');
  ok('阈值带：50% none / 70% checkpoint（不切换）/ 95% forced');
}

// ── 2. 模拟低阈值强制 rollover：Task/Workspace/Progress 不丢 + 新 Session 继续 ──
{
  const { runtime, taskRuntime, log, rev } = setup();
  const task = taskRuntime.create({
    goal: '重写导出器',
    requirements: ['保持 CLI 兼容', '输出 JSON'],
    workspaceId: 'ws-exporter',
    currentPhase: '实现阶段'
  });
  taskRuntime.addWork({ id: task.id, expectedRev: rev(task.id), kind: 'completed', text: '完成 schema 设计' });
  taskRuntime.addWork({ id: task.id, expectedRev: rev(task.id), kind: 'pending', text: '实现 CSV writer' });
  taskRuntime.addDecision({ id: task.id, expectedRev: rev(task.id), decision: '采用流式写入', rationale: '避免大文件驻留内存' });
  taskRuntime.addArtifact({ id: task.id, expectedRev: rev(task.id), kind: 'file', label: 'src/exporter/schema.js' });
  taskRuntime.setProgress({ id: task.id, expectedRev: rev(task.id), percent: 40 });
  taskRuntime.start({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s1' });

  // 模拟低阈值：rolloverPercent 压到 5%，少量使用即强制触发
  runtime.setPolicy({ rolloverPercent: 5, forcedPercent: 8, preparePercent: 3 });
  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 1000, windowTokens: 10000 });
  const verdict = runtime.evaluate({ taskId: task.id });
  assert.ok(['rollover', 'forced'].includes(verdict.action), '低阈值下必须判定自动 rollover（10% ≥ forced 8% → forced）');

  const result = await runtime.rollover({ taskId: task.id, reason: 'context-threshold' });
  assert.equal(result.from.sessionId, 'alpha-s1');
  assert.equal(result.to.provider, 'alpha');
  assert.match(result.to.sessionId, /^alpha-s\d+$/);
  assert.equal(result.crossProvider, false);

  // 四不丢：Task id / workspace / progress / 领域明细全部保留
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.id, task.id, 'Task ID 不变');
  assert.equal(after.workspaceId, 'ws-exporter', 'Workspace 不丢');
  assert.equal(after.progress.percent, 40, 'Progress 不丢');
  assert.equal(after.completedWork[0].text, '完成 schema 设计', 'completedWork 不丢');
  assert.equal(after.pendingWork[0].text, '实现 CSV writer', 'pendingWork 不丢');
  assert.equal(after.decisions[0].decision, '采用流式写入', 'decisions 不丢');
  assert.equal(after.artifacts[0].label, 'src/exporter/schema.js', 'artifacts 不丢');
  assert.equal(after.status, 'running', 'rollover 不改变任务状态');
  assert.equal(after.checkpoint.nextAction, '实现 CSV writer', 'checkpoint.nextAction 指向待办');

  // 新 Session 能继续：bootstrap 是结构化恢复说明（经 Broker send），含目标/待办/决策
  const bootstrap = log.filter((entry) => entry.kind === 'prompt').pop();
  assert.ok(bootstrap.text.includes('[CetaMesh Task 恢复]'));
  assert.ok(bootstrap.text.includes('重写导出器'));
  assert.ok(bootstrap.text.includes('实现 CSV writer'));
  assert.ok(bootstrap.text.includes('不要重做'));
  assert.ok(bootstrap.text.includes('采用流式写入'));
  assert.ok(bootstrap.text.includes('从这里继续'));

  // agentHistory：旧记录 detach、新记录 attach（Task 视角的一次交接）
  assert.equal(after.agentHistory.length, 2);
  assert.equal(after.agentHistory[0].sessionId, 'alpha-s1');
  assert.notEqual(after.agentHistory[0].detachedAt, null);
  assert.equal(after.agentHistory[1].sessionId, result.to.sessionId);
  assert.equal(after.currentAgent.sessionId, result.to.sessionId);

  // packet 落盘可取回
  const latest = runtime.latestPacket({ taskId: task.id }).packet;
  assert.equal(latest.taskId, task.id);
  assert.equal(latest.previousAgent.sessionId, 'alpha-s1');
  assert.equal(latest.reasonForHandoff, 'context-threshold');
  assert.equal(runtime.history({ taskId: task.id }).total, 1);
  ok('模拟低阈值强制 rollover：Task/Workspace/Progress 不丢、新 Session 携结构化恢复、packet 可追溯');
}

// ── 3. 无重复执行：并发互斥（in-flight）+ 串行二次 rollover 幂等语义 ──────────
{
  const gate = { blocked: true, release: null };
  const { runtime, taskRuntime, rev } = setup({ gate });
  const task = taskRuntime.create({ goal: '长任务', workspaceId: 'ws-long' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s1' });
  runtime.setPolicy({ rolloverPercent: 5 });
  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 999, windowTokens: 10000 });

  // 第一次 rollover 卡在 createSession（gate.blocked）→ 互斥窗口
  const first = runtime.rollover({ taskId: task.id, reason: 'context-threshold' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(
    runtime.rollover({ taskId: task.id, reason: 'context-threshold' }),
    (error) => error.code === 'ROLLOVER_IN_FLIGHT',
    '进行中的 rollover 必须互斥，防止重复执行'
  );
  gate.blocked = false;
  gate.release();
  const done = await first;
  assert.equal(runtime.history({ taskId: task.id }).total, 1);

  // 串行再次 rollover：合法的新一轮交接，sequence 递增、currentAgent 单一指向
  const second = await runtime.rollover({ taskId: task.id, reason: 'owner-request' });
  assert.equal(second.sequence, 2);
  assert.equal(runtime.history({ taskId: task.id }).total, 2);
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.currentAgent.sessionId, second.to.sessionId);
  assert.equal(after.agentHistory.length, 3, '两次 rollover = 三条 agentHistory');
  ok('无重复执行：并发互斥 + sequence 递增 + agentHistory 完整');
}

// ── 4. 跨 Provider Handoff：alpha → beta（同一 Broker 内寻址） ────────────────
{
  const { runtime, broker, taskRuntime, log, rev } = setup();
  const task = taskRuntime.create({ goal: '跨 provider 迁移', workspaceId: 'ws-cross-provider' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s9' });
  const result = await runtime.rollover({ taskId: task.id, reason: 'provider-switch', targetProvider: 'beta' });
  assert.equal(result.crossProvider, true);
  assert.equal(result.to.provider, 'beta');
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.currentAgent.provider, 'beta', 'Task 挂到新 Provider，ID 不变');
  assert.equal(after.agentHistory[0].provider, 'alpha');
  const bootstrap = log.filter((entry) => entry.kind === 'prompt').pop();
  assert.ok(bootstrap.text.includes('跨 provider 迁移'), '新 Provider 收到同一结构化恢复说明');
  await assert.rejects(
    runtime.rollover({ taskId: task.id, targetProvider: 'ghost' }),
    (error) => error.code === 'AGENT_PROVIDER_UNKNOWN'
  );
  void broker;
  ok('跨 Provider Handoff：同 packet、Task ID 不变、未注册 Provider 明确拒绝');
}

// ── 5. Provider 初始化失败：恢复旧 Agent 与原始 Checkpoint 并清理目标 Session ──
{
  const { runtime, taskRuntime, log, rev } = setup({ failSendProvider: 'beta' });
  const task = taskRuntime.create({ goal: '初始化失败后回滚', workspaceId: 'ws-rollback' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s1' });
  const previousCheckpoint = taskRuntime.get({ id: task.id }).task.checkpoint;

  await assert.rejects(
    runtime.rollover({ taskId: task.id, reason: 'provider-switch', targetProvider: 'beta' }),
    error => error.code === 'PROVIDER_ERROR' && /fixture bootstrap rejected/.test(error.message)
  );

  const rolledBack = taskRuntime.get({ id: task.id }).task;
  assert.deepEqual(rolledBack.currentAgent, { provider: 'alpha', sessionId: 'alpha-s1' },
    'failed bootstrap restores the previous Task Agent binding');
  assert.deepEqual(rolledBack.checkpoint, previousCheckpoint,
    'failed bootstrap restores the exact prior checkpoint, including null');
  assert.ok(log.some(entry => entry.kind === 'archive' && entry.sessionId === 'beta-s2'),
    'failed target Session is closed and staged resources are cleaned');
  assert.equal(runtime.history({ taskId: task.id }).total, 0, 'failed rollover is not recorded as completed');
  ok('Provider bootstrap failure rolls back Task binding and Checkpoint and closes target Session');
}

// ── 6. 无 Agent / 不安全点 / packet 校验 ─────────────────────────────────────
{
  const { runtime, taskRuntime, rev } = setup();
  const task = taskRuntime.create({ goal: '未绑定会话', workspaceId: 'ws-no-session' });
  await assert.rejects(
    runtime.rollover({ taskId: task.id }),
    (error) => error.code === 'ROLLOVER_NO_AGENT'
  );
  // canRollover 钩子拒绝（回合未到安全点）
  const guardedLog = [];
  const guarded = createContinuityService({
    taskRuntime,
    stateDir: path.join(stateRoot, 'guarded'),
    agentBroker: (() => {
      const r = createAgentProviderRegistry();
      r.register(mockProvider('alpha', guardedLog));
      return createAgentBroker({ registry: r });
    })(),
    canRollover: () => false
  });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s1' });
  await assert.rejects(
    guarded.runtime.rollover({ taskId: task.id }),
    (error) => error.code === 'ROLLOVER_NOT_SAFE'
  );
  // packet 归一化：未知原因收敛 other、coding 缺省为空、不伪造
  const packet = normalizePacket({ taskId: 't1', goal: 'g', reasonForHandoff: 'mystery', previousAgent: { provider: 'dsh', sessionId: 's' } });
  assert.equal(packet.reasonForHandoff, 'other');
  assert.equal(packet.coding.branch, null);
  assert.deepEqual(packet.relevantFiles, []);
  assert.equal(packet.workspace, null);
  assert.deepEqual(packet.memoryRefs, [], 'Checkpoint v2：无 memoryRefs 时如实空数组');
  ok('无 Agent / 不安全点拒绝 / packet 校验收敛');
}

// ── 7. IPC 服务白名单与默认阈值 ──────────────────────────────────────────────
{
  const { taskRuntime, rev } = setup();
  const service = createContinuityService({
    taskRuntime,
    stateDir: path.join(stateRoot, 'ipc'),
    agentBroker: (() => {
      const r = createAgentProviderRegistry();
      r.register(mockProvider('alpha', []));
      return createAgentBroker({ registry: r });
    })()
  });
  const policy = await service.execute({ method: 'continuity.policy.get' });
  assert.equal(policy.policy.rolloverPercent, 85, '默认阈值对齐 spec（85 = preferred rollover）');
  assert.equal(policy.policy.preparePercent, 70);
  assert.equal(policy.policy.autoRollover, true, '默认自动 rollover 开启');
  await service.execute({ method: 'continuity.policy.set', params: { policy: { rolloverPercent: 60 } } });
  const updated = await service.execute({ method: 'continuity.policy.get' });
  assert.equal(updated.policy.rolloverPercent, 60);
  const task = taskRuntime.create({ goal: 'IPC 路径', workspaceId: 'ws-ipc' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s1' });
  const recorded = await service.execute({
    method: 'continuity.context.record',
    params: { sessionKey: 'alpha:alpha-s1', inputTokens: 3000, windowTokens: 10000 }
  });
  assert.equal(recorded.percent, 30);
  assert.equal(recorded.source, 'usage', '真实 usage 记录标记 source=usage');
  // 独立 session 验证估算路径（真实 usage 一旦记录即优先，不降级为估算）
  const estimated = await service.execute({
    method: 'continuity.context.record',
    params: { sessionKey: 'alpha:estimate-only', promptChars: 800 }
  });
  assert.equal(estimated.estimated, true, '字符估算标记 estimated=true，不冒充真实 usage');
  const evaluated = await service.execute({ method: 'continuity.evaluate', params: { taskId: task.id } });
  assert.equal(evaluated.action, 'none');
  const providers = await service.execute({ method: 'continuity.providers' });
  assert.deepEqual(providers.providers, ['alpha']);
  await assert.rejects(
    service.execute({ method: 'continuity.nonsense' }),
    (error) => error.code === 'METHOD_NOT_FOUND'
  );
  ok('IPC 服务：policy/record（usage 与估算区分）/evaluate/providers 白名单');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 阶段 09 Continuity 全部通过（${step} 组）`);
