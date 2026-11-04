// 会话 2 / TASK-S2-004 + S2-005 + S2-006 + S2-009 + S2-010 验收：
// 自动 Context Monitoring + 自动 Fresh Session Rollover + Checkpoint v2 数据保留。
//
// 覆盖：
//   1. 阈值带：69% → none；70% → checkpoint（不切换）；78-85 → ready；
//      85%+ → rollover（自动开 Fresh Session）；90%+ → forced；92%+ → emergency
//   2. 真实 usage 优先（source:'usage'）；无真实 usage 时字符估算（estimated:true）——
//      估算绝不冒充真实 Token
//   3. 自动 rollover：Session A → Session B（同 Provider），Task ID 不变，
//      monitor 重置（新会话从零计数）
//   4. 数据保留：goal/requirements/progress/completedWork/pendingWork/decisions/
//      acceptance/workspace/artifacts/memoryRefs 全部保留（task + packet 双向断言）
//   5. 防重复：并发 rollover 只成功一次（ROLLOVER_IN_FLIGHT 收敛为 rolledOver:false）
//   6. Safe Point：canRollover=false → ROLLOVER_NOT_SAFE，当前 Session 保留
//   7. 策略开关：autoRollover=false → 只评估不执行
//   8. Cross Provider：A → B，Task ID / workspace / progress 不变，agentHistory 追加
//   9. Checkpoint v2：packet 含 memoryRefs（仅引用）+ workspaceFacts 透传
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskRuntime } from '../src/task/runtime.js';
import { defineAgentProvider, AGENT_PROVIDER_CORE_METHODS } from '../src/agent/agent-provider.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createContinuityService } from '../src/continuity/service.js';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'auto-rollover-test-'));

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

/** 正式契约 fixture Agent Provider（经 Broker 注册）；支持可选 archiveSession。 */
function fixtureProvider(id, { gate = null, failCreate = false } = {}) {
  // The Task fixture is attached to `${id}-s1`; start generated Sessions at s2
  // so rollover exercises a real identity change instead of the provider fixture
  // accidentally returning the old session id again.
  let seq = 1;
  const log = [];
  return {
    provider: defineAgentProvider({
      id,
      label: `Fixture ${id}`,
      capabilityExtras: { workspaceBoundary: 'capability-broker', rolloverStrategy: { preferred: 'fresh-session', note: 'fixture' } },
      methods: {
        async createSession() {
          if (gate?.blocked) await new Promise((resolve) => { gate.release = resolve; });
          if (failCreate) throw Object.assign(new Error('创建失败：Provider 不可用'), { code: 'PROVIDER_UNAVAILABLE' });
          seq += 1;
          const sessionId = `${id}-s${seq}`;
          log.push({ kind: 'create', provider: id, sessionId });
          return { sessionId, provider: id };
        },
        async send({ sessionId, content }) {
          log.push({ kind: 'send', provider: id, sessionId, content });
          return { accepted: true };
        },
        async cancel({ sessionId }) {
          if (gate?.blocked) await new Promise((resolve) => { gate.release = resolve; });
          log.push({ kind: 'cancel', provider: id, sessionId });
          return { cancelled: true };
        },
        async status({ sessionId }) {
          return { sessionId, running: false };
        },
        async contextUsage({ sessionId }) {
          return { sessionId, available: false };
        },
        async resume({ sessionId }) {
          return { resumed: true, sessionId };
        },
        async closeSession({ sessionId }) {
          log.push({ kind: 'close', provider: id, sessionId });
          return { closed: true };
        },
        async selectModel({ sessionId, model }) {
          return { sessionId, selected: { model } };
        },
        async health() {
          return { available: true, provider: id };
        },
        async *follow({ sessionId }) {
          yield { type: 'turn/end', seq: 1, data: { sessionId, reason: { kind: 'completed' } } };
        },
        async archiveSession({ sessionId }) {
          log.push({ kind: 'archive', provider: id, sessionId });
          return { archived: true, sessionId };
        }
      }
    }),
    log,
    sessionsCreated: () => seq
  };
}

function setup({ policy, gate, failCreate, canRollover, providers = ['alpha', 'beta'] } = {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'case-'));
  const taskRuntime = createTaskRuntime({ stateDir: dir });
  const fixtures = providers.map((id) => fixtureProvider(id, { gate, failCreate }));
  const registry = createAgentProviderRegistry({ providers: fixtures.map((f) => f.provider) });
  const broker = createAgentBroker({ registry });
  const service = createContinuityService({
    taskRuntime,
    stateDir: dir,
    agentBroker: broker,
    policy,
    canRollover: canRollover ?? null
  });
  return {
    service,
    runtime: service.runtime,
    broker,
    taskRuntime,
    logs: Object.fromEntries(fixtures.map((f) => [f.provider.id, f.log])),
    rev: (id) => taskRuntime.get({ id }).task.rev,
    dir
  };
}

/** 组一个带完整领域明细的任务（覆盖数据保留断言所需全部字段）。 */
function seedTask(taskRuntime, rev, { provider = 'alpha', sessionId = 'alpha-s1' } = {}) {
  const task = taskRuntime.create({
    goal: '重写导出器',
    requirements: ['保持 CLI 兼容', '输出 JSON'],
    workspaceId: 'ws-exporter',
    currentPhase: '实现阶段',
    acceptanceCriteria: ['全部测试通过', '导出文件可被旧版读取']
  });
  const id = task.id;
  taskRuntime.addWork({ id, expectedRev: rev(id), kind: 'completed', text: '完成 schema 设计' });
  taskRuntime.addWork({ id, expectedRev: rev(id), kind: 'pending', text: '实现 CSV writer' });
  taskRuntime.addDecision({ id, expectedRev: rev(id), decision: '采用流式写入', rationale: '避免大文件驻留内存' });
  taskRuntime.addArtifact({ id, expectedRev: rev(id), kind: 'file', label: 'src/exporter/schema.js' });
  taskRuntime.linkMemory({ id, expectedRev: rev(id), memoryId: 'mem_exporter_style' });
  taskRuntime.setProgress({ id, expectedRev: rev(id), percent: 40 });
  taskRuntime.start({ id, expectedRev: rev(id), provider, sessionId });
  return task;
}

// Request usage includes the whole effective input, not only newly appended tokens.
{
  const { runtime, taskRuntime, rev, logs } = setup();
  const task = seedTask(taskRuntime, rev);
  const receipts = [];
  for (let index = 0; index < 12; index++) {
    receipts.push({ requestId: 'small-' + index, inputTokens: 1000, outputTokens: 100, windowTokens: 10000,
      cacheReadTokens: 800, cacheWriteTokens: 0 });
    const observed = await runtime.observeAgentTurn({ provider: 'alpha', sessionId: 'alpha-s1',
      usage: { requests: receipts, accountingComplete: true } });
    assert.equal(observed.level.usedTokens, 1100, 'cumulative billing receipts must not accumulate context occupancy');
    assert.equal(observed.level.percent, 11); assert.equal(observed.rolledOver, false);
  }
  const repeated = await runtime.observeAgentTurn({ provider: 'alpha', sessionId: 'alpha-s1', usage: { requests: receipts } });
  assert.equal(repeated.level.usedTokens, 1100, 'repeated approval/accounting receipts cannot add occupancy');
  assert.equal(runtime.history({ taskId: task.id }).total, 0); assert.deepEqual(logs.alpha, []);
  assert.equal(runtime.monitor.level('beta:unrelated').usedTokens, null, 'unobserved Session context is unknown');
  const cached = await runtime.observeAgentTurn({ provider: 'beta', sessionId: 'cache',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }, windowTokens: 1000 });
  assert.equal(cached.level.usedTokens, 105, 'exclusive provider cache input is normalized once');
  const capacityUnknown = await runtime.observeAgentTurn({ provider: 'beta', sessionId: 'cache', usage: { inputTokens: 20, outputTokens: 0 } });
  assert.equal(capacityUnknown.level.windowTokens, null, 'prior model capacity cannot establish the current request window');
  assert.equal(capacityUnknown.level.percent, null);
  const unknown = await runtime.observeAgentTurn({ provider: 'alpha', sessionId: 'alpha-s1',
    usage: { requests: [{ requestId: 'unknown', inputTokens: null, outputTokens: null }] }, promptChars: 50000 });
  assert.equal(unknown.level.usedTokens, null, 'last user-message characters cannot stand in for full request context');
  assert.equal(unknown.level.percent, null); assert.equal(unknown.action, 'none');
  const high = await runtime.observeAgentTurn({ provider: 'alpha', sessionId: 'alpha-s1',
    usage: { requests: [{ requestId: 'high', inputTokens: 8500, outputTokens: 100, windowTokens: 10000 }] } });
  assert.equal(high.rolledOver, true, 'a genuinely large current request still triggers a safe rollover');
  ok('current request occupancy is separate from cumulative billing, cache accounting and other Sessions');
}

{
  const { createContextMonitor } = await import('../src/continuity/monitor.js');
  const monitor = createContextMonitor({ initialSessions: { legacy: { inputTokens: 9000, outputTokens: 100, windowTokens: 10000, real: true } } });
  assert.equal(monitor.level('legacy').usedTokens, null, 'legacy cumulative totals are not migrated into current occupancy');
  assert.equal(monitor.level('legacy').percent, null);
  assert.equal(monitor.record('legacy', { inputTokens: 500, outputTokens: 0, windowTokens: 10000 }).percent, 5);
}

// ── 1. 阈值带：69/70/85/91/95 → none/checkpoint/ready/forced/emergency ──────
{
  const { runtime, taskRuntime, rev } = setup();
  const task = seedTask(taskRuntime, rev);
  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 6900, windowTokens: 10000 });
  assert.equal(runtime.evaluate({ taskId: task.id }).action, 'none', '69% → none');

  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 7000, windowTokens: 10000 });
  const at70 = runtime.evaluate({ taskId: task.id });
  assert.equal(at70.level.percent, 70);
  assert.equal(at70.action, 'checkpoint', '70% → 建议 checkpoint，不切换');
  assert.equal(at70.level.source, 'usage', '真实 usage 标记 source=usage');
  assert.equal(at70.strategy.preferred, 'fresh-session', '策略面随评估返回');
  assert.equal(at70.strategy.implemented, 'fresh-session');

  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 7800, windowTokens: 10000 });
  assert.equal(runtime.evaluate({ taskId: task.id }).action, 'ready', '78-85 → ready（寻求安全点）');

  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 8800, windowTokens: 10000 });
  assert.equal(runtime.evaluate({ taskId: task.id }).action, 'rollover', 'current input 8800 = 88%');

  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 9000, windowTokens: 10000 });
  assert.equal(runtime.evaluate({ taskId: task.id }).action, 'forced', 'current input 9000 = 90%');

  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 9200, windowTokens: 10000 });
  assert.equal(runtime.evaluate({ taskId: task.id }).action, 'emergency', 'current input 9200 = 92%');
  ok('阈值带：69 none / 70 checkpoint / 78-85 ready / 85+ rollover / 90+ forced / 92+ emergency（真实 usage）');
}

// ── 2. 估算路径：无真实 usage 时按字符估算，明确标记 estimated ────────────────
{
  const { runtime, taskRuntime, rev } = setup({ policy: { autoRollover: false } });
  const task = seedTask(taskRuntime, rev);
  // promptChars 2800，窗口 10000，charsPerToken=4 → 700 tokens = 7%
  const first = await runtime.observeAgentTurn({ provider: 'alpha', sessionId: 'alpha-s1', promptChars: 2800, windowTokens: 10000 });
  assert.equal(first.source, 'unknown');
  assert.equal(first.level.estimated, true);
  assert.equal(first.level.percent, null, 'latest user text is not the full effective request');
  assert.equal(first.action, 'none');

  // No provider input accounting: a larger user turn still cannot establish context occupancy.
  const second = await runtime.observeAgentTurn({ provider: 'alpha', sessionId: 'alpha-s1', promptChars: 31200, windowTokens: 10000 });
  assert.equal(second.source, 'unknown');
  assert.equal(second.level.percent, null);
  assert.equal(second.action, 'none');
  assert.equal(second.rolledOver, false, 'autoRollover=false 只评估不执行');
  assert.equal(runtime.history({ taskId: task.id }).total, 0);
  ok('turn-only character counts stay unknown rather than fabricating full request occupancy');
}

{
  const { runtime, taskRuntime, rev } = setup({ policy: { autoRollover: false } });
  seedTask(taskRuntime, rev);
  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 100, outputTokens: 20,
    promptChars: 400, outputChars: 80, windowTokens: 1000 });
  const mixed = runtime.monitor.record('alpha:alpha-s1', { promptChars: 400, outputChars: 80 });
  assert.equal(mixed.usedTokens, 120, 'an explicitly supplied full-input estimate replaces the previous request');
  assert.equal(mixed.source, 'estimated');
  assert.equal(mixed.estimated, true);
  const partial = runtime.monitor.record('alpha:alpha-s1', { inputTokens: 50,
    promptChars: 200, outputChars: 400 });
  assert.equal(partial.usedTokens, 150, 'missing output is estimated only for the current request');
  assert.equal(partial.source, 'mixed');
  ok('current full-input estimates and partial usage do not accumulate historical billing');
}

// ── 3. 自动 Fresh Session Rollover（同 Provider）：Session B + Task ID 不变 ──
{
  const { runtime, taskRuntime, logs, rev } = setup();
  const task = seedTask(taskRuntime, rev);
  const before = taskRuntime.get({ id: task.id }).task;

  const observed = await runtime.observeAgentTurn({
    provider: 'alpha', sessionId: 'alpha-s1',
    usage: { inputTokens: 8600, outputTokens: 200 }, windowTokens: 10000
  });
  assert.equal(observed.recorded, true);
  assert.equal(observed.taskAttached, true);
  assert.equal(observed.action, 'rollover');
  assert.equal(observed.rolledOver, true, '达 85%+ 自动执行 Fresh Session Rollover');
  assert.equal(observed.rollover.from.sessionId, 'alpha-s1');
  assert.match(observed.rollover.to.sessionId, /^alpha-s\d+$/, '同 Provider Fresh Session');
  assert.equal(observed.rollover.crossProvider, false);
  assert.equal(observed.rollover.sequence, 1);

  // Task ID 不变 + 状态保持 running + monitor 重置
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.id, task.id, 'Task ID 不变');
  assert.equal(after.status, 'running', 'rollover 不改变任务状态');
  assert.equal(after.currentAgent.provider, 'alpha');
  assert.equal(after.currentAgent.sessionId, observed.rollover.to.sessionId);
  assert.equal(runtime.evaluate({ taskId: task.id }).level.percent, null, 'new Session context is unknown until observed');
  assert.equal(runtime.history({ taskId: task.id }).total, 1);

  // Bootstrap：结构化恢复说明（不复制聊天历史）
  const createCall = logs.alpha.filter((e) => e.kind === 'create').pop();
  const sendCall = logs.alpha.filter((e) => e.kind === 'send').pop();
  assert.equal(sendCall.sessionId, observed.rollover.to.sessionId, 'bootstrap 发给新 Session');
  assert.ok(sendCall.content.includes('[CetaMesh Task 恢复]'));
  assert.ok(sendCall.content.includes('重写导出器'));
  assert.ok(sendCall.content.includes('不要重做'));
  assert.ok(sendCall.content.includes('从这里继续'));
  assert.ok(!sendCall.content.includes('聊天记录'), 'bootstrap 不携带聊天历史');

  // agentHistory：旧 detach、新 attach
  assert.equal(after.agentHistory.length, 2);
  assert.notEqual(after.agentHistory[0].detachedAt, null);
  void before; void createCall;
  ok('自动 rollover：85%+ 回合结束 → 同 Provider Session B → Task ID 不变 → monitor 重置');
}

// ── 4. 数据保留：goal/requirements/progress/completed/pending/decisions/acceptance/workspace/artifacts/memoryRefs ──
{
  const { runtime, taskRuntime, rev } = setup();
  const task = seedTask(taskRuntime, rev);
  await runtime.rollover({ taskId: task.id, reason: 'context-threshold' });
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.goal, '重写导出器');
  assert.deepEqual(after.requirements, ['保持 CLI 兼容', '输出 JSON']);
  assert.equal(after.workspaceId, 'ws-exporter');
  assert.equal(after.progress.percent, 40);
  assert.equal(after.completedWork[0].text, '完成 schema 设计');
  assert.equal(after.pendingWork[0].text, '实现 CSV writer');
  assert.equal(after.decisions[0].decision, '采用流式写入');
  assert.equal(after.artifacts[0].label, 'src/exporter/schema.js');
  assert.equal(after.memoryRefs[0].memoryId, 'mem_exporter_style');
  assert.equal(after.acceptance.filter((a) => a.text === '全部测试通过').length, 1);
  assert.equal(after.currentPhase, '实现阶段');

  const { packet } = runtime.latestPacket({ taskId: task.id });
  assert.equal(packet.taskId, task.id);
  assert.equal(packet.goal, '重写导出器');
  assert.equal(packet.workspace, 'ws-exporter');
  assert.ok(packet.completedWork.includes('完成 schema 设计'));
  assert.ok(packet.pendingWork.includes('实现 CSV writer'));
  assert.ok(packet.decisions[0].includes('采用流式写入'));
  assert.deepEqual(packet.artifacts, ['src/exporter/schema.js']);
  assert.deepEqual(packet.memoryRefs.map((r) => r.memoryId), ['mem_exporter_style'], 'Checkpoint v2：memoryRefs 只存引用');
  assert.equal(packet.memoryRefs[0].memory, undefined, 'Memory 原文绝不复制进 packet');
  assert.ok(packet.acceptanceCriteria.some((a) => a.includes('[ ] 全部测试通过')));
  assert.equal(packet.previousAgent.sessionId, 'alpha-s1');
  assert.equal(packet.reasonForHandoff, 'context-threshold');
  ok('数据保留：领域明细在 Task 与 Checkpoint v2 双向保留；memoryRefs 仅引用不复制原文');
}

// ── 5. 防重复：并发 rollover 只成功一次 ─────────────────────────────────────
{
  const gate = { blocked: true, release: null };
  const { runtime, taskRuntime, rev } = setup({ gate });
  const task = seedTask(taskRuntime, rev);
  runtime.monitor.record('alpha:alpha-s1', { inputTokens: 9000, windowTokens: 10000 });

  const observation = { provider: 'alpha', sessionId: 'alpha-s1', usage: { inputTokens: 9000, outputTokens: 0 }, windowTokens: 10000 };
  const first = runtime.observeAgentTurn(observation);
  await new Promise((resolve) => setTimeout(resolve, 40)); // 等 first 进入 inFlight
  const second = await runtime.observeAgentTurn(observation);
  assert.equal(second.rolledOver, false, '并发第二次 observe 不得触发第二次 rollover');
  assert.equal(second.rolloverBlocked, 'ROLLOVER_IN_FLIGHT');

  gate.blocked = false;
  gate.release();
  const done = await first;
  assert.equal(done.rolledOver, true);
  assert.equal(runtime.history({ taskId: task.id }).total, 1, '并发窗口内只落一次 rollover 历史');
  ok('防重复：并发 rollover 只成功一次（ROLLOVER_IN_FLIGHT 收敛，Task 无重复交接）');
}

// ── 6. Safe Point：未到安全点 → ROLLOVER_NOT_SAFE，当前 Session 保留 ─────────
{
  const { runtime, taskRuntime, rev } = setup({ canRollover: () => false });
  const task = seedTask(taskRuntime, rev);
  const observed = await runtime.observeAgentTurn({
    provider: 'alpha', sessionId: 'alpha-s1',
    usage: { inputTokens: 8700, outputTokens: 100 }, windowTokens: 10000
  });
  assert.equal(observed.action, 'rollover');
  assert.equal(observed.rolledOver, false, '未到安全点不切换');
  assert.equal(observed.rolloverBlocked, 'ROLLOVER_NOT_SAFE');
  assert.equal(observed.escalated, false);
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.currentAgent.sessionId, 'alpha-s1', '当前 Session 保留（绝不硬杀在途会话）');
  assert.equal(runtime.history({ taskId: task.id }).total, 0);
  ok('Safe Point：ROLLOVER_NOT_SAFE → 保留当前 Session，等下一个安全点');
}

// ── 7. forced/emergency 升级 + autoRollover=false 只评估 ────────────────────
{
  const { runtime, taskRuntime, rev } = setup();
  const task = seedTask(taskRuntime, rev, { sessionId: 'alpha-s1' });
  const observed = await runtime.observeAgentTurn({
    provider: 'alpha', sessionId: 'alpha-s1',
    usage: { inputTokens: 9100, outputTokens: 0 }, windowTokens: 10000
  });
  assert.equal(observed.action, 'forced', '90-92% 判定 forced');
  assert.equal(observed.rolledOver, true, 'forced 达安全点仍自动执行');
  assert.equal(observed.escalated, undefined);
  assert.equal(runtime.latestPacket({ taskId: task.id }).packet.reasonForHandoff, 'forced-rollover', 'forced 记录升级原因');

  const noAuto = setup({ policy: { autoRollover: false } });
  const task2 = seedTask(noAuto.taskRuntime, noAuto.rev);
  const verdict = await noAuto.runtime.observeAgentTurn({
    provider: 'alpha', sessionId: 'alpha-s1',
    usage: { inputTokens: 8800, outputTokens: 0 }, windowTokens: 10000
  });
  assert.equal(verdict.action, 'rollover');
  assert.equal(verdict.rolledOver, false, 'autoRollover=false 只评估不执行');
  assert.equal(noAuto.runtime.history({ taskId: task2.id }).total, 0);
  ok('策略：forced 升级执行并记录原因；autoRollover=false 只评估');
}

// ── 8. Cross Provider Handoff：alpha → beta，Task/Workspace/Progress 不变 ────
{
  const { runtime, taskRuntime, logs, rev } = setup();
  const task = seedTask(taskRuntime, rev);
  const result = await runtime.rollover({ taskId: task.id, reason: 'provider-switch', targetProvider: 'beta' });
  assert.equal(result.crossProvider, true);
  assert.equal(result.to.provider, 'beta');
  assert.equal(result.taskId, task.id, 'Task ID 不变');

  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.currentAgent.provider, 'beta');
  assert.equal(after.workspaceId, 'ws-exporter', 'Workspace 不变');
  assert.equal(after.progress.percent, 40, 'Progress 不变');
  assert.equal(after.agentHistory.length, 2, 'agentHistory 追加');
  assert.equal(after.agentHistory[0].provider, 'alpha');
  assert.notEqual(after.agentHistory[0].detachedAt, null);

  const bootstrap = logs.beta.filter((e) => e.kind === 'send').pop();
  assert.ok(bootstrap.content.includes('重写导出器'), '新 Provider 收到同一结构化恢复说明');
  await assert.rejects(
    () => runtime.rollover({ taskId: task.id, targetProvider: 'ghost' }),
    (e) => e.code === 'AGENT_PROVIDER_UNKNOWN',
    '未注册 Provider 结构化拒绝'
  );
  ok('Cross Provider：A→B 结构可用，Task ID/Workspace/Progress 不变，未知 Provider 拒绝');
}

// ── 9. Checkpoint v2：workspaceFacts 透传 + 未绑定工作区如实 null ─────────────
{
  const { runtime, taskRuntime, rev } = setup();
  const task = seedTask(taskRuntime, rev);
  await runtime.rollover({
    taskId: task.id,
    reason: 'owner-request',
    workspaceFacts: { available: true, workspaceId: 'ws-exporter', git: { isRepo: true, branch: 'main', headSha: 'a'.repeat(40), dirty: false } }
  });
  const { packet } = runtime.latestPacket({ taskId: task.id });
  assert.equal(packet.workspaceFacts.available, true, 'Checkpoint v2 保存真实 workspace facts');
  assert.equal(packet.workspaceFacts.git.branch, 'main');
  assert.equal(packet.workspaceFacts.git.headSha, 'a'.repeat(40));

  const plain = setup();
  const task2 = plain.taskRuntime.create({ goal: '无 Workspace facts 任务', workspaceId: 'ws-no-facts' });
  plain.taskRuntime.attachAgent({ id: task2.id, expectedRev: plain.rev(task2.id), provider: 'alpha', sessionId: 'alpha-s1' });
  await plain.runtime.rollover({ taskId: task2.id, reason: 'owner-request' });
  const { packet: packet2 } = plain.runtime.latestPacket({ taskId: task2.id });
  assert.equal(packet2.workspaceFacts, null, '无工作区/未收集 → null（不编造）');
  assert.deepEqual(packet2.relevantFiles, []);
  assert.equal(packet2.coding.branch, null);
  ok('Checkpoint v2：workspaceFacts 透传保存；缺失如实 null/[]，绝不编造');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 自动 Context Rollover 全部通过（${step} 组）`);
