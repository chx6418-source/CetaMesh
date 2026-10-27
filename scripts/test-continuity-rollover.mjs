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
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';

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
  const turnEnds = new Map();
  return defineAgentProvider({
    id,
    label: `Mock ${id}`,
    capabilityExtras: { workspaceBoundary: 'capability-broker' },
    methods: {
      async createSession(sessionOptions = {}) {
        if (options.gate?.blocked) {
          await new Promise((resolve) => { options.gate.release = resolve; });
        }
        seq += 1;
        log.push({ kind: 'create', provider: id, seq, options: sessionOptions });
        return { sessionId: `${id}-s${seq}`, providerId: id };
      },
      async send({ sessionId, content }) {
        log.push({ kind: 'prompt', sessionId, text: content });
        if (options.failSend) throw Object.assign(new Error('fixture bootstrap rejected'), { code: 'PROVIDER_ERROR' });
        const requestId = `bootstrap-${sessionId}`;
        turnEnds.set(sessionId, (async () => {
          if (options.bootstrapGate?.blocked) {
            await new Promise(resolve => { options.bootstrapGate.release = resolve; });
          }
          return { type: 'turn/end', seq: 1, data: { requestId, reason: { kind: 'completed' } } };
        })());
        return { accepted: true, requestId };
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
      async *follow({ sessionId }) {
        const end = turnEnds.get(sessionId);
        if (end) yield await end;
      }
    }
  });
}

/** 每组独立 stateDir；task 写操作统一带最新 rev（store 乐观锁）。 */
function setup({ policy, gate, failSendProvider, alphaStatusError, reconciler, betaBootstrapGate, onHandoffComplete, readOperations } = {}) {
  const log = [];
  const dir = fs.mkdtempSync(path.join(stateRoot, 'case-'));
  const taskRuntime = createTaskRuntime({ stateDir: dir });
  const rev = (id) => taskRuntime.get({ id }).task.rev;
  const registry = createAgentProviderRegistry();
  const alpha = mockProvider('alpha', log, { gate, failSend: failSendProvider === 'alpha', statusError: alphaStatusError });
  const beta = mockProvider('beta', log, { failSend: failSendProvider === 'beta', bootstrapGate: betaBootstrapGate });
  registry.register(alpha);
  registry.register(beta);
  const broker = createAgentBroker({ registry });
  const service = createContinuityService({ taskRuntime, stateDir: dir, agentBroker: broker, policy, reconciler, onHandoffComplete, readOperations });
  return { service, runtime: service.runtime, broker, taskRuntime, log, rev, dir };
}

// ── 4a. Core restart: only SESSION_NOT_FOUND triggers a safe fresh-session handoff ──
{
  const {runtime,taskRuntime,rev,log,dir}=setup({policy:{maxAutomaticNoProgress:1,maxAutomaticSwitches:2}});
  const task=taskRuntime.create({goal:'Bound automatic no-progress switches',workspaceId:'ws-switch-budget'});
  taskRuntime.attachAgent({id:task.id,expectedRev:rev(task.id),provider:'alpha',sessionId:'alpha-budget'});
  await runtime.rollover({taskId:task.id,targetProvider:'beta',automatic:true});
  const creates=log.filter(row=>row.kind==='create').length;
  taskRuntime.addWork({id:task.id,expectedRev:rev(task.id),kind:'completed',text:'model claims progress without evidence'});
  await assert.rejects(runtime.rollover({taskId:task.id,targetProvider:'alpha',automatic:true}),{code:'HANDOFF_NO_PROGRESS'});
  assert.equal(log.filter(row=>row.kind==='create').length,creates,'automatic loops stop before creating another executor');
  await runtime.rollover({taskId:task.id,targetProvider:'alpha',reason:'owner-request'});
  assert.equal(taskRuntime.get({id:task.id}).task.id,task.id,'explicit Owner handoff remains available after automatic budget exhaustion');
  runtime.setPolicy({maxAutomaticSwitches:1,maxAutomaticNoProgress:100});
  const historyFile=path.join(dir,'continuity','rollovers.json');
  const history=readJsonFile(historyFile);
  writeJsonAtomic(historyFile,{...history,rollovers:Array.from({length:200},(_,index)=>({taskId:'another-task-'+index,sequence:1}))});
  await assert.rejects(runtime.rollover({taskId:task.id,targetProvider:'beta',automatic:true}),{code:'HANDOFF_BUDGET_EXHAUSTED'});
  ok('automatic no-progress handoff budget cannot be reset by model-authored progress');
}

{
  const operations=[{operationId:'stable-file-operation',capability:'filesystem.write',status:'completed',attemptId:'attempt-before-switch',requestId:'original-dispatch',at:1,
    input:{secret:'DO_NOT_EXPORT_OPERATION_INPUT'},retainedResult:{secret:'DO_NOT_EXPORT_OPERATION_RESULT'}}];
  const {runtime,taskRuntime,rev,log}=setup({readOperations:()=>operations});
  const task=taskRuntime.create({goal:'Continue remaining operations',workspaceId:'operation-workspace'});
  taskRuntime.attachAgent({id:task.id,expectedRev:rev(task.id),provider:'alpha',sessionId:'alpha-old'});
  const result=await runtime.rollover({taskId:task.id,targetProvider:'beta'});
  const packet=runtime.buildHandoffPacket({taskId:task.id});
  assert.equal(result.task.id,task.id);assert.equal(packet.operations[0].operationId,'stable-file-operation');
  assert.equal(packet.operations[0].attemptId,'attempt-before-switch');
  assert.equal(packet.operations[0].continuationState,'completed-needs-verification');
  operations.push({operationId:'planned-next',capability:'filesystem.write',status:'prepared'});
  assert.equal(runtime.buildHandoffPacket({taskId:task.id}).operations[1].continuationState,'not-started');
  assert.ok(log.some(row=>row.kind==='prompt'&&row.text.includes('operation.continue')));
  assert.doesNotMatch(JSON.stringify(packet),/DO_NOT_EXPORT_OPERATION/);
  assert.ok(log.some(row=>row.kind==='prompt'&&row.text.includes('operation.read(operationRef)')));
  operations.push({operationId:'unknown-effect',capability:'integration.tool.write',status:'outcome-unknown'});
  const beforeCreate=log.filter(row=>row.kind==='create').length;
  await assert.rejects(runtime.rollover({taskId:task.id,targetProvider:'alpha'}),{code:'ROLLOVER_NOT_SAFE'});
  assert.equal(log.filter(row=>row.kind==='create').length,beforeCreate,'unknown effects block before creating another executor');
  ok('handoff retains stable operation references without payloads and refuses unknown effects');
}

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
  assert.equal(runtime.latestPacket({ taskId: task.id }).packet.reasonForHandoff, 'provider-switch');
  assert.equal(runtime.history({ taskId: task.id }).rollovers[0].reason, 'provider-switch');
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
  assert.equal(rolledBack.status, 'blocked', 'a stopped old Agent cannot be restored as an active writer');
  assert.equal(rolledBack.currentAgent, null, 'failed bootstrap leaves the Task awaiting recovery');
  assert.deepEqual(rolledBack.checkpoint, previousCheckpoint,
    'failed bootstrap restores the exact prior checkpoint, including null');
  assert.ok(log.some(entry => entry.kind === 'archive' && entry.sessionId === 'beta-s2'),
    'failed target Session is closed and staged resources are cleaned');
  assert.equal(runtime.history({ taskId: task.id }).total, 0, 'failed rollover is not recorded as completed');
  assert.throws(() => runtime.latestPacket({ taskId: task.id }),
    error => error.code === 'PACKET_NOT_FOUND', 'failed handoff cannot replace the authoritative latest packet');
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
  const legacySwitch = normalizePacket({ taskId: 't1', goal: 'g', reasonForHandoff: 'agent-provider-switch', previousAgent: { provider: 'dsh', sessionId: 's' } });
  assert.equal(legacySwitch.reasonForHandoff, 'provider-switch', 'legacy provider switch retains its audit reason');
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

// Phase 3 regressions: a failed old-session stop cannot declare a successful handoff.
{
  const { runtime, taskRuntime, broker, rev } = setup();
  const task = taskRuntime.create({ goal: 'Do not allow two writers', workspaceId: 'ws-stop-failure' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  broker.cancel = async () => { throw Object.assign(new Error('old process did not stop'), { code: 'PROVIDER_ERROR' }); };
  await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
    error => error.code === 'PROVIDER_ERROR' || error.code === 'ROLLOVER_NOT_SAFE');
  assert.deepEqual(taskRuntime.get({ id: task.id }).task.currentAgent, { provider: 'alpha', sessionId: 'alpha-old' });
  assert.equal(runtime.history({ taskId: task.id }).total, 0);
  ok('old Agent stop failure keeps the original Task owner and records no successful handoff');
}

// Managed Agent represents no pending approval as null, not false.
{
  const { runtime, taskRuntime, broker, rev } = setup();
  const task = taskRuntime.create({ goal: 'Preserve the Managed Agent idle contract', workspaceId: 'ws-null-approval' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  broker.status = async () => ({ running: false, queued: 0, waitingForApproval: null });
  const result = await runtime.rollover({ taskId: task.id, targetProvider: 'beta' });
  assert.equal(result.to.provider, 'beta');
  ok('explicit idle status with no pending approval supports handoff');
}

// Unknown source state must be rejected before transfer.
for (const status of [{}, { running: false, state: 'unknown' },
  { running: false, lastRunStatus: 'unknown' }, { running: false, runtimeValid: false }]) {
  const { runtime, taskRuntime, broker, log, rev } = setup();
  const task = taskRuntime.create({ goal: 'Unknown execution state cannot transfer authority', workspaceId: 'ws-unknown-state' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  broker.status = async () => status;
  await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
    error => error.code === 'ROLLOVER_NOT_SAFE');
  assert.equal(log.some(row => row.kind === 'create'), false, 'unknown source status must stop before target creation');
  assert.deepEqual(taskRuntime.get({ id: task.id }).task.currentAgent, { provider: 'alpha', sessionId: 'alpha-old' });
  assert.equal(runtime.history({ taskId: task.id }).total, 0);
}
ok('missing or explicitly unknown source status cannot be treated as an idle execution');

{
  const { runtime, taskRuntime, broker, log, rev } = setup();
  const task = taskRuntime.create({ goal: 'Cancellation acknowledgement is not proof of quiescence', workspaceId: 'ws-post-stop-unknown' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  let statusReads = 0;
  broker.status = async () => ++statusReads === 1 ? { running: false } : { running: false, lastRunStatus: 'unknown' };
  await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
    error => error.code === 'ROLLOVER_NOT_SAFE');
  assert.equal(log.some(row => row.kind === 'prompt'), false, 'no bootstrap may start when post-cancel status is unknown');
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.status, 'blocked');
  assert.equal(after.currentAgent, null);
  assert.equal(runtime.history({ taskId: task.id }).total, 0);
  ok('unknown state after cancellation blocks handoff and preserves the Task for reconciliation');
}

// The in-flight lock covers asynchronous status inspection.
{
  const { runtime, taskRuntime, broker, rev } = setup();
  const task = taskRuntime.create({ goal: 'Single handoff at a time', workspaceId: 'ws-lock' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  const status = broker.status.bind(broker);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  broker.status = async params => { if (++calls === 1) await gate; return status(params); };
  const first = runtime.rollover({ taskId: task.id, targetProvider: 'beta' });
  try {
    await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
      error => error.code === 'ROLLOVER_IN_FLIGHT');
  } finally { release(); await Promise.allSettled([first]); }
  ok('handoff lock is acquired before the first asynchronous Provider status read');
}

// Phase 3 regressions: bounded history must not reset the durable sequence.
{
  const { runtime, taskRuntime, rev, dir } = setup();
  const task = taskRuntime.create({ goal: 'Monotonic handoff history', workspaceId: 'ws-sequence' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  writeJsonAtomic(path.join(dir, 'continuity', 'rollovers.json'), { schemaVersion: 2,
    rollovers: Array.from({ length: 200 }, (_, index) => ({ taskId: task.id, sequence: index + 37 })) });
  const next = await runtime.rollover({ taskId: task.id, targetProvider: 'beta' });
  assert.equal(next.sequence, 237, 'sequence advances from the largest durable value, even after history retention');
  ok('handoff sequence remains monotonic after retained history reaches its limit');
}

assert.equal(normalizePacket({ taskId: 't', requirements: ['字'.repeat(600)] }).requirements[0].length, 600,
  'Handoff Packet must preserve the Task requirement rather than silently cut it to an ID length');
ok('Handoff Packet retains complete Task requirements');

{
  let reads = 0;
  const reconciler = {
    async collectFacts({ workspaceId }) { return { available: true, workspaceId, git: {
      isRepo: true, headSha: ++reads <= 2 ? 'a'.repeat(40) : 'b'.repeat(40), branch: 'main', dirty: false,
      diffSummary: null }, files: [] }; },
    reconcile({ packet, facts }) { return { consistent: packet.workspaceFacts?.git?.headSha === facts.git.headSha,
      discrepancies: [{ kind: 'headSha' }] }; }
  };
  const { runtime, taskRuntime, rev } = setup({ reconciler });
  const task = taskRuntime.create({ goal: 'Verify actual Workspace before transfer', workspaceId: 'ws-moving' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
    error => error.code === 'WORKSPACE_CHANGED');
  assert.equal(reads, 3, 'Collect baseline and preflight, then recollect facts after target initialization');
  assert.equal(taskRuntime.get({ id: task.id }).task.status, 'blocked');
  assert.equal(taskRuntime.get({ id: task.id }).task.currentAgent, null);
  ok('Workspace change during handoff blocks recovery after stopping the prior Agent');
}

{
  const { runtime, taskRuntime, broker, log, rev } = setup();
  const task = taskRuntime.create({ goal: 'Keep model selection', workspaceId: 'ws-model' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  broker.status = async () => ({ running: false, modelProvider: 'fixture-model-provider', model: 'selected-model', reasoningEffort: 'high' });
  await runtime.rollover({ taskId: task.id, targetProvider: 'alpha' });
  const creation = log.find(item => item.kind === 'create' && item.provider === 'alpha');
  assert.equal(creation.options.modelProvider, 'fixture-model-provider');
  assert.equal(creation.options.model, 'selected-model');
  assert.equal(creation.options.reasoningEffort, 'high');
  ok('same-Provider fresh Session retains explicit model Provider, model, and reasoning effort');
}

{
  const bootstrapGate = { blocked: true, release: null };
  const { runtime, taskRuntime, rev } = setup({ betaBootstrapGate: bootstrapGate });
  const task = taskRuntime.create({ goal: 'Wait for recovery turn', workspaceId: 'ws-bootstrap' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  let settled = false;
  const handoff = runtime.rollover({ taskId: task.id, targetProvider: 'beta' }).finally(() => { settled = true; });
  try {
    const deadline = Date.now() + 1000;
    while (!bootstrapGate.release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof bootstrapGate.release, 'function');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'bootstrap ACK alone cannot complete handoff');
    assert.equal(runtime.history({ taskId: task.id }).total, 0);
  } finally { bootstrapGate.release?.(); await Promise.allSettled([handoff]); }
  assert.equal(settled, true);
  assert.equal(runtime.history({ taskId: task.id }).total, 1);
  ok('handoff records success only after the target bootstrap turn actually completes');
}

{
  const { runtime, taskRuntime, broker, rev } = setup({ failSendProvider: 'beta' });
  const task = taskRuntime.create({ goal: 'Do not reauthorize old Agent if target cleanup fails', workspaceId: 'ws-cleanup' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  taskRuntime.start({ id: task.id, expectedRev: rev(task.id) });
  broker.closeSession = async () => { throw Object.assign(new Error('target still active'), { code: 'PROVIDER_ERROR' }); };
  await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
    error => error.code === 'PROVIDER_ERROR');
  const after = taskRuntime.get({ id: task.id }).task;
  assert.equal(after.status, 'failed', 'uncertain target cleanup must revoke further Task writes');
  assert.equal(after.currentAgent, null);
  ok('failed target cleanup terminates Task authority rather than restoring an old writer');
}

{
  const { runtime, taskRuntime, broker, dir } = setup();
  const task = taskRuntime.create({ goal: 'Persist context state', workspaceId: 'ws-context' });
  runtime.setPolicy({ rolloverPercent: 61 });
  runtime.monitor.record('alpha:context-session', { inputTokens: 3000, windowTokens: 10000 });
  const restarted = createContinuityService({ taskRuntime, stateDir: dir, agentBroker: broker });
  assert.equal(restarted.runtime.getPolicy().policy.rolloverPercent, 61);
  assert.equal(restarted.runtime.monitor.level('alpha:context-session').percent, 30);
  assert.equal(restarted.runtime.monitor.level('alpha:context-session').source, 'usage');
  assert.equal(taskRuntime.get({ id: task.id }).task.id, task.id);
  ok('Context Monitor usage and policy survive a Core service restart');
}

{
  const followed = [];
  const { runtime, taskRuntime, rev } = setup({ onHandoffComplete: assignment => followed.push(assignment) });
  const task = taskRuntime.create({ goal: 'Follow the target Agent', workspaceId: 'ws-follow' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  const result = await runtime.rollover({ taskId: task.id, targetProvider: 'beta' });
  assert.equal(followed.length, 1, 'committed handoff registers a single Task event follower');
  const [{ sinceSequence, bootstrapRequestId, bootstrapTurnId, ...assignment }] = followed;
  assert.deepEqual(assignment, { taskId: task.id, provider: result.to.provider, sessionId: result.to.sessionId },
    'successful transfer must register the target Session for Task event follow');
  assert.equal(bootstrapRequestId, 'bootstrap-beta-s2', 'Task follow must know the bootstrap request identity');
  assert.equal(bootstrapTurnId, null, 'fixture without native Turn ID cannot fabricate one');
  assert.ok(Number.isSafeInteger(sinceSequence) && sinceSequence >= 0, 'handoff passes a valid resume cursor');
  ok('target Agent Session is registered for Task follow only after successful handoff');
}

{
  const { runtime, taskRuntime, rev, log, dir } = setup();
  const task = taskRuntime.create({ goal: 'Preserve selected model', workspaceId: 'ws-model' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  taskRuntime.setModelConfig({ id: task.id, expectedRev: rev(task.id),
    modelProvider: 'custom-compatible', model: 'selected-model', reasoningEffort: 'high' });
  const result = await runtime.rollover({ taskId: task.id, targetProvider: 'beta' });
  const options = log.findLast(entry => entry.kind === 'create' && entry.provider === 'beta')?.options;
  assert.deepEqual({ modelProvider: options.modelProvider, model: options.model, reasoningEffort: options.reasoningEffort },
    { modelProvider: 'custom-compatible', model: 'selected-model', reasoningEffort: 'high' });
  assert.equal(result.task.modelConfig.modelProvider, 'custom-compatible');
  assert.equal(createTaskRuntime({ stateDir: dir }).get({ id: task.id }).task.modelConfig.model, 'selected-model');
  ok('cross-Provider Handoff retains and persists the Task-selected model configuration');
}

{
  const { runtime, taskRuntime, broker, rev, dir, log } = setup();
  const task = taskRuntime.create({ goal: 'History failure must revoke target authority', workspaceId: 'ws-history-failure' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  taskRuntime.start({ id: task.id, expectedRev: rev(task.id) });
  const historyFile = path.join(dir, 'continuity', 'rollovers.json');
  const backupFile = path.join(dir, 'continuity', 'rollovers.before-failure.json');
  const originalArchive = broker.archiveSession.bind(broker);
  broker.archiveSession = async request => {
    const result = await originalArchive(request);
    fs.renameSync(historyFile, backupFile);
    fs.mkdirSync(historyFile);
    return result;
  };
  await assert.rejects(runtime.rollover({ taskId: task.id, targetProvider: 'beta' }),
    error => error.code === 'HANDOFF_COMMIT_FAILED');
  const blocked = taskRuntime.get({ id: task.id }).task;
  assert.equal(blocked.status, 'blocked', 'history failure must block the Task');
  assert.equal(blocked.currentAgent, null, 'history failure must revoke the uncommitted target');
  assert.match(blocked.progress.note, /needs-reconciliation/);
  assert.ok(log.some(entry => entry.kind === 'cancel' && entry.sessionId === 'beta-s2'),
    'uncommitted target Session must be stopped');
  const journalFile = path.join(dir, 'continuity', 'transactions', `${task.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'prepared');
  fs.rmdirSync(historyFile);
  fs.renameSync(backupFile, historyFile);
  const restarted = createContinuityService({ taskRuntime, stateDir: dir, agentBroker: broker });
  assert.equal(restarted.runtime.isInFlight(task.id), true,
    'Core restart must continue to block a prepared but uncommitted Handoff');
  assert.deepEqual(restarted.runtime.history({ taskId: task.id }).rollovers, []);
  assert.equal(restarted.runtime.acknowledgeTransactionRecovery(task.id).acknowledged, true);
  assert.equal(restarted.runtime.isInFlight(task.id), false);
  ok('Handoff history failure leaves a durable review journal and no active target writer');
}

{
  const { runtime, taskRuntime, broker, rev, dir } = setup();
  const task = taskRuntime.create({ goal: 'Latest packet cache may fail independently', workspaceId: 'ws-latest-cache' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-old' });
  const latestFile = path.join(dir, 'continuity', 'handoff', task.id, 'latest.json');
  const originalArchive = broker.archiveSession.bind(broker);
  broker.archiveSession = async request => {
    const result = await originalArchive(request);
    fs.mkdirSync(latestFile);
    broker.archiveSession = originalArchive;
    return result;
  };
  const first = await runtime.rollover({ taskId: task.id, targetProvider: 'beta' });
  assert.equal(first.sequence, 1);
  assert.equal(runtime.history({ taskId: task.id }).total, 1);
  assert.equal(runtime.latestPacket({ taskId: task.id }).packet.sequence, 1,
    'committed packet must be read from history when derived latest cache write fails');
  const restarted = createContinuityService({ taskRuntime, stateDir: dir, agentBroker: broker });
  const second = await restarted.runtime.rollover({ taskId: task.id, targetProvider: 'alpha' });
  assert.equal(second.sequence, 2, 'failed latest cache cannot prevent monotonic later handoff');
  ok('derived latest cache write failure does not corrupt committed Handoff history or sequence');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 阶段 09 Continuity 全部通过（${step} 组）`);
