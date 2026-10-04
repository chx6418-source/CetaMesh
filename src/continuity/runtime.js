// CetaMesh Continuity Runtime —— Rollover / Handoff 编排（阶段 09）。
//
// Rollover 序列（用户契约）：
//   完成当前原子操作（由调用方保证回合边界；runtime 提供 canRollover 钩子）
//   → 生成 Handoff Packet（结构化 Task state + Workspace facts，不是聊天历史）
//   → 写 Task Checkpoint
//   → 结束旧 Agent Session（cancel 在途回合 + archive 能力如实报告）
//   → 经 AgentProvider 创建新 Session 并发送 bootstrap（Task 恢复说明）
//   → task.attachAgent 绑定新 Session —— Task ID 不变
//   → 落盘 rollover 历史，防止重复执行。
//
// 防重复执行：同一 task 的 rollover 串行化（内存互斥）+ packet sequence 递增 +
// bootstrap prompt 明确"从 checkpoint.nextAction 继续、不重做 completedWork"。

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONTEXT_POLICY, PACKET_LIMITS, continuityError, normalizePacket, normalizePolicy, normalizeReason } from './types.js';
import { createContextMonitor } from './monitor.js';

function readJsonFile(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw continuityError('STORE_CORRUPT', `Continuity 数据读取失败：${file}（${error?.message ?? error}）`);
  }
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

export function createContinuityRuntime({
  taskRuntime,
  providers,
  stateDir,
  policy,
  now = () => Date.now(),
  canRollover = null
} = {}) {
  if (!taskRuntime?.get) throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 taskRuntime');
  if (!providers?.get) throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 provider 注册表');
  if (!stateDir || typeof stateDir !== 'string') throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 stateDir');

  const activePolicy = normalizePolicy(policy ?? DEFAULT_CONTEXT_POLICY);
  const monitor = createContextMonitor({ policy: activePolicy });
  const dir = path.join(stateDir, 'continuity');
  const historyFile = path.join(dir, 'rollovers.json');
  const packetDir = path.join(dir, 'handoff');
  const inFlight = new Set(); // taskId：rollover 串行互斥

  function readHistory() {
    const store = readJsonFile(historyFile, { schemaVersion: 1, rollovers: [] });
    return Array.isArray(store.rollovers) ? store : { schemaVersion: 1, rollovers: [] };
  }

  function writeHistory(store) {
    if (store.rollovers.length > PACKET_LIMITS.history) {
      store.rollovers = store.rollovers.slice(-PACKET_LIMITS.history);
    }
    atomicWriteJson(historyFile, store);
  }

  function requireTask(id) {
    const task = taskRuntime.get({ id }).task;
    if (!task) throw continuityError('TASK_NOT_FOUND', '任务不存在：' + String(id));
    return task;
  }

  function packetFile(taskId, sequence) {
    return path.join(packetDir, String(taskId), `packet-${String(sequence).padStart(4, '0')}.json`);
  }

  function latestPacketFile(taskId) {
    return path.join(packetDir, String(taskId), 'latest.json');
  }

  /** 从 Task Runtime 组装结构化 Handoff Packet（Workspace/git 事实由调用方提供，缺省如实为空）。 */
  function buildHandoffPacket({ taskId, reason, sequence, coding, relevantFiles, workspaceFacts } = {}) {
    const task = requireTask(taskId);
    const packet = normalizePacket({
      taskId: task.id,
      goal: task.goal,
      requirements: task.requirements,
      currentPhase: task.currentPhase,
      completedWork: task.completedWork.map((item) => item.text ?? item),
      pendingWork: task.pendingWork.map((item) => item.text ?? item),
      decisions: task.decisions.map((item) => ({ text: item.decision ? `${item.decision}${item.rationale ? `（${item.rationale}）` : ''}` : item })),
      workspace: task.workspaceId,
      relevantFiles: Array.isArray(relevantFiles) ? relevantFiles : [],
      artifacts: task.artifacts.map((item) => item.label ?? item),
      checkpoint: {
        summary: task.checkpoint?.summary ?? '',
        nextAction: task.checkpoint?.nextAction ?? ''
      },
      acceptanceCriteria: task.acceptance.map((item) => `${item.met ? '[x]' : '[ ]'} ${item.text}`),
      previousAgent: task.currentAgent ? { provider: task.currentAgent.provider, sessionId: task.currentAgent.sessionId } : null,
      reasonForHandoff: normalizeReason(reason),
      coding: coding ?? null,
      workspaceFacts: workspaceFacts ?? null,
      sequence,
      createdAt: now()
    });
    return packet;
  }

  function savePacket(taskId, packet) {
    atomicWriteJson(packetFile(taskId, packet.sequence), packet);
    atomicWriteJson(latestPacketFile(taskId), packet);
    return packetFile(taskId, packet.sequence);
  }

  /** Bootstrap 提示词：结构化 Task 恢复说明（不复制聊天历史）。 */
  function renderResumePrompt(packet) {
    const lines = [];
    lines.push(`[CetaMesh Task 恢复] 你接手的是一个已存在的任务（Handoff），不是新任务。`);
    lines.push(`taskId: ${packet.taskId}`);
    lines.push(`目标: ${packet.goal || '（见 requirements）'}`);
    if (packet.requirements.length) lines.push(`要求:\n- ${packet.requirements.join('\n- ')}`);
    if (packet.currentPhase) lines.push(`当前阶段: ${packet.currentPhase}`);
    if (packet.completedWork.length) lines.push(`已完成（不要重做）:\n- ${packet.completedWork.join('\n- ')}`);
    if (packet.pendingWork.length) lines.push(`待办:\n- ${packet.pendingWork.join('\n- ')}`);
    if (packet.decisions.length) lines.push(`既有决策:\n- ${packet.decisions.join('\n- ')}`);
    if (packet.workspace) lines.push(`工作区: ${packet.workspace}`);
    if (packet.relevantFiles.length) lines.push(`相关文件:\n- ${packet.relevantFiles.join('\n- ')}`);
    if (packet.artifacts.length) lines.push(`产物:\n- ${packet.artifacts.join('\n- ')}`);
    if (packet.acceptanceCriteria.length) lines.push(`验收标准:\n- ${packet.acceptanceCriteria.join('\n- ')}`);
    if (packet.coding) {
      const coding = packet.coding;
      const codingLines = [
        coding.branch ? `branch: ${coding.branch}` : null,
        coding.headSha ? `HEAD: ${coding.headSha}` : null,
        coding.gitStatus ? `git status 摘要: ${coding.gitStatus}` : null,
        coding.gitDiffSummary ? `diff 摘要: ${coding.gitDiffSummary}` : null,
        coding.testsRun?.length ? `已跑测试: ${coding.testsRun.join('; ')}` : null,
        coding.buildStatus ? `构建状态: ${coding.buildStatus}` : null,
        coding.knownFailures?.length ? `已知失败: ${coding.knownFailures.join('; ')}` : null
      ].filter(Boolean);
      if (codingLines.length) lines.push(`代码任务事实:\n- ${codingLines.join('\n- ')}`);
    }
    lines.push(`检查点摘要: ${packet.checkpoint.summary || '（无）'}`);
    lines.push(`下一步（从这里继续）: ${packet.checkpoint.nextAction || packet.pendingWork[0] || '向所有者确认当前进度'}`);
    lines.push(`交接原因: ${packet.reasonForHandoff}`);
    lines.push(`上下文规则: 先核对以上事实与工作区真实状态再行动；不要重复已完成工作；不要要求重新提供本摘要中的信息。`);
    return lines.join('\n');
  }

  function nextSequence(taskId) {
    const store = readHistory();
    return store.rollovers.filter((entry) => entry.taskId === taskId).length + 1;
  }

  /** 评估当前上下文水位：none / checkpoint / rollover。 */
  function evaluate({ taskId } = {}) {
    const task = requireTask(taskId);
    if (!task.currentAgent) {
      return { taskId, attached: false, action: 'none' };
    }
    const sessionKey = `${task.currentAgent.provider}:${task.currentAgent.sessionId}`;
    const level = monitor.level(sessionKey);
    let action = 'none';
    if (level.percent >= activePolicy.rolloverPercent) action = 'rollover';
    else if (level.percent >= activePolicy.preparePercent) action = 'checkpoint';
    return { taskId, attached: true, sessionKey, level, action, policy: activePolicy };
  }

  /**
   * 执行 rollover。只在回合边界调用（调用方负责完成当前原子操作；
   * 注入 canRollover 回调时可做在途回合检查，返回 false 抛 NOT_SAFE）。
   */
  async function rollover({ taskId, reason, targetProvider, coding, relevantFiles, workspaceFacts, model, reasoningEffort } = {}) {
    const task = requireTask(taskId);
    if (inFlight.has(task.id)) {
      throw continuityError('ROLLOVER_IN_FLIGHT', '该任务已有一次 rollover 正在进行，拒绝重复执行');
    }
    if (typeof canRollover === 'function' && !canRollover({ taskId: task.id })) {
      throw continuityError('ROLLOVER_NOT_SAFE', '当前不是安全 rollover 点（存在在途回合或未完成的原子操作）');
    }
    const previousAgent = task.currentAgent;
    if (!previousAgent) {
      throw continuityError('ROLLOVER_NO_AGENT', '任务没有绑定的 Agent Session，无需 rollover（直接 attachAgent 即可）');
    }
    inFlight.add(task.id);
    try {
      const sequence = nextSequence(task.id);
      const packet = buildHandoffPacket({ taskId: task.id, reason, sequence, coding, relevantFiles, workspaceFacts });
      const packetPath = savePacket(task.id, packet);

      // Task Store 是乐观锁（expectedRev）：每步前取最新 rev，保证与其它写者兼容。
      const currentRev = () => taskRuntime.get({ id: task.id }).task.rev;

      // 1) Task Checkpoint 落库（Task Runtime 持有）
      taskRuntime.setCheckpoint({
        id: task.id,
        expectedRev: currentRev(),
        summary: packet.checkpoint.summary || packet.goal,
        nextAction: packet.checkpoint.nextAction || packet.pendingWork[0] || ''
      });

      // 2) 结束旧 Session（取消在途回合尽力而为 + 归档如实报告）
      const fromProvider = providers.get(previousAgent.provider);
      try {
        await fromProvider.cancel(previousAgent.sessionId);
      } catch { /* 旧会话可能已无在途回合 */ }
      const archive = await fromProvider.archiveSession(previousAgent.sessionId);

      // 3) 解绑旧 Agent（agentHistory 追加，Task id 不变）
      taskRuntime.detachAgent({ id: task.id, expectedRev: currentRev(), note: `rollover #${sequence}（${packet.reasonForHandoff}）` });

      // 4) 创建新 Session 并发送结构化 bootstrap（不是聊天历史）
      const target = targetProvider ? providers.get(targetProvider) : fromProvider;
      const created = await target.createContextSession({
        taskId: task.id,
        bootstrapPrompt: renderResumePrompt(packet),
        model: model ?? target.defaults?.model,
        reasoningEffort: reasoningEffort ?? target.defaults?.reasoningEffort
      });

      // 5) 绑定新 Agent
      const attached = taskRuntime.attachAgent({
        id: task.id,
        expectedRev: currentRev(),
        provider: target.id,
        sessionId: created.sessionId,
        note: `rollover #${sequence} 自 ${previousAgent.provider}:${previousAgent.sessionId}${archive.archived ? '（旧会话已归档）' : ''}`
      });

      // 6) 落盘历史 + 重置 monitor（新 session 从零计数）
      const store = readHistory();
      store.rollovers.push({
        taskId: task.id,
        sequence,
        packetId: path.basename(packetPath, '.json'),
        from: { provider: previousAgent.provider, sessionId: previousAgent.sessionId },
        to: { provider: target.id, sessionId: created.sessionId },
        reason: packet.reasonForHandoff,
        crossProvider: target.id !== previousAgent.provider,
        archiveSupported: archive.supported === true,
        at: now()
      });
      writeHistory(store);
      monitor.reset(`${previousAgent.provider}:${previousAgent.sessionId}`);

      return {
        taskId: task.id,
        sequence,
        packetPath,
        from: previousAgent,
        to: { provider: target.id, sessionId: created.sessionId },
        crossProvider: target.id !== previousAgent.provider,
        task: attached.task
      };
    } finally {
      inFlight.delete(task.id);
    }
  }

  function latestPacket({ taskId } = {}) {
    requireTask(taskId);
    const packet = readJsonFile(latestPacketFile(taskId), null);
    if (!packet) throw continuityError('PACKET_NOT_FOUND', '该任务尚无 Handoff Packet');
    return { packet };
  }

  function history({ taskId } = {}) {
    const store = readHistory();
    const rollovers = taskId
      ? store.rollovers.filter((entry) => entry.taskId === String(taskId))
      : store.rollovers;
    return { rollovers, total: rollovers.length };
  }

  function getPolicy() {
    return { policy: activePolicy, bands: ['normal<70', 'prepare 70-78', 'ready 78-85', 'rollover 85-90', 'forced 90-92', 'emergency 92+'] };
  }

  function setPolicy(next) {
    const patch = next && typeof next === 'object' ? next : {};
    const merged = { ...activePolicy, ...patch };
    // 单字段更新时联动收敛，保证 prepare <= rollover <= forced 顺序不被部分修改破坏。
    if (patch.rolloverPercent !== undefined) {
      merged.preparePercent = Math.min(merged.preparePercent, merged.rolloverPercent);
      merged.forcedPercent = Math.max(merged.forcedPercent, merged.rolloverPercent);
    }
    if (patch.forcedPercent !== undefined) {
      merged.rolloverPercent = Math.min(merged.rolloverPercent, merged.forcedPercent);
      merged.preparePercent = Math.min(merged.preparePercent, merged.rolloverPercent);
    }
    if (patch.preparePercent !== undefined) {
      merged.rolloverPercent = Math.max(merged.rolloverPercent, merged.preparePercent);
      merged.forcedPercent = Math.max(merged.forcedPercent, merged.rolloverPercent);
    }
    Object.assign(activePolicy, normalizePolicy(merged));
    return getPolicy();
  }

  return {
    evaluate,
    rollover,
    buildHandoffPacket,
    renderResumePrompt,
    latestPacket,
    history,
    getPolicy,
    setPolicy,
    monitor,
    _dir: dir
  };
}
