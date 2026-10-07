// CetaMesh Continuity Runtime v2 —— Rollover / Handoff 编排（阶段 09；会话 2 重构）。
//
// v2 变更（会话 2 / TASK-S2-003/004/005/006/007/008/009/010）：
//   1) 唯一依赖 Agent Broker：移除本目录自带的窄 AgentProvider 注册表与 DSH 实现；
//      会话创建/发送/取消/归档一律走 broker（DSH 只是第一个真实 Provider）。
//   2) observeAgentTurn：回合机在 Agent 回合结束后调用——真实 usage 优先入
//      Context Monitor，无真实 usage 时用字符估算并明确标记 estimated；
//      绑定了 Task 的会话达到阈值自动执行 Fresh Session Rollover。
//   3) 自动 Rollover 安全点：canRollover 钩子 / 互斥窗口未到安全点时返回
//      ROLLOVER_NOT_SAFE，保留当前 Session（forced/emergency 只升级记录，不硬杀）。
//   4) Checkpoint v2：packet 增加 memoryRefs（仅引用）与 workspaceFacts（真实
//      git/文件事实），旧字段全部保留；缺失如实 null/[]，不编造。
//   5) Workspace Reconciliation：fresh session 绑定后用真实 Workspace 事实核验
//      checkpoint，不一致记录 discrepancy，绝不静默篡改 Task State。
//
// Rollover 序列（用户契约）：
//   完成当前原子操作（调用方保证回合边界；canRollover 钩子兜底）
//   → 生成 Handoff Packet（结构化 Task state + Workspace facts，不是聊天历史）
//   → 写 Task Checkpoint
//   → 结束旧 Agent Session（cancel 在途回合 + archive 能力如实报告）
//   → 经 Broker 创建新 Session 并发送 bootstrap（Task 恢复说明）
//   → task.attachAgent 绑定新 Session —— Task ID 不变
//   → Workspace Reconciliation（核验 checkpoint vs 真实工作区）
//   → 落盘 rollover 历史，防止重复执行。
//
// 核心原则：Tasks belong to CetaMesh, not to agents.
//           Sessions are disposable; progress is persistent.

import path from 'node:path';
import fs from 'node:fs';
import { StorageError, discardFile, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import {
  DEFAULT_CONTEXT_POLICY,
  IMPLEMENTED_ROLLOVER_STRATEGY,
  PACKET_LIMITS,
  continuityError,
  normalizePacket,
  normalizePolicy,
  normalizeReason
} from './types.js';
import { normalizeUsageTokens } from '../agent/agent-provider.js';
import { createContextMonitor } from './monitor.js';

const AUTO_ROLLOVER_ACTIONS = Object.freeze(['rollover', 'forced', 'emergency']);

/** 每个 Task 保留的 handoff packet / reconciliation 文件数上限（更旧的在写入时清理）。 */
const PACKET_FILES_KEEP = 20;

function loadContinuityFile(file, fallback) {
  try {
    return readJsonFile(file, { missing: fallback });
  } catch (error) {
    if (error instanceof StorageError) {
      const detail = error?.cause?.message ?? error.message;
      throw continuityError('STORE_CORRUPT', `Continuity 数据读取失败：${file}（${detail}）`);
    }
    throw error;
  }
}

/** Retention：packet 目录里每个 Task 只保留最近 KEEP 个 packet/reconciliation 文件。 */
export function prunePacketFiles(dir, keep = PACKET_FILES_KEEP) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    // 目录还不存在（从未落过 packet）是正常状态，无需清理。
    return;
  }
  const sequenceOf = (name) => {
    const match = /^(?:packet|reconciliation)-(\d+)\.json$/.exec(name);
    return match ? Number(match[1]) : null;
  };
  const keepNames = new Set(
    names
      .map((name) => ({ name, seq: sequenceOf(name) }))
      .filter((entry) => entry.seq !== null)
      .sort((a, b) => a.seq - b.seq)
      .slice(-keep)
      .map((entry) => entry.name)
  );
  for (const name of names) {
    if (sequenceOf(name) === null || keepNames.has(name)) continue;
    // 清理失败不影响本次落盘：文件带序号命名，下次写入会再次尝试清理。
    discardFile(path.join(dir, name));
  }
}

export function createContinuityRuntime({
  taskRuntime,
  agentBroker,
  stateDir,
  policy,
  now = () => Date.now(),
  canRollover = null,
  reconciler = null,
  listPendingApprovals = null,
  log = () => {}
} = {}) {
  if (!taskRuntime?.get) throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 taskRuntime');
  if (!agentBroker?.require || !agentBroker?.send) {
    throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 Agent Broker（唯一会话通道）');
  }
  if (!stateDir || typeof stateDir !== 'string') throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 stateDir');

  const activePolicy = normalizePolicy(policy ?? DEFAULT_CONTEXT_POLICY);
  const monitor = createContextMonitor({ policy: activePolicy });
  const dir = path.join(stateDir, 'continuity');
  const historyFile = path.join(dir, 'rollovers.json');
  const packetDir = path.join(dir, 'handoff');
  const inFlight = new Set(); // taskId：rollover 串行互斥

  function readHistory() {
    const store = loadContinuityFile(historyFile, { schemaVersion: 2, rollovers: [] });
    return Array.isArray(store.rollovers) ? store : { schemaVersion: 2, rollovers: [] };
  }

  function writeHistory(store) {
    if (store.rollovers.length > PACKET_LIMITS.history) {
      store.rollovers = store.rollovers.slice(-PACKET_LIMITS.history);
    }
    writeJsonAtomic(historyFile, store);
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

  /** Provider 的 rollover 策略声明；无声明回退默认 fresh-session（唯一已实现策略）。 */
  function strategyOf(providerId) {
    let preferred = null;
    let source = 'default';
    try {
      const declared = agentBroker.rolloverStrategy?.(providerId);
      if (declared?.preferred) {
        preferred = String(declared.preferred);
        source = 'provider';
      }
    } catch { /* 未知 Provider：用默认策略 */ }
    return {
      preferred: preferred ?? IMPLEMENTED_ROLLOVER_STRATEGY,
      implemented: IMPLEMENTED_ROLLOVER_STRATEGY,
      source,
      ...(preferred && preferred !== IMPLEMENTED_ROLLOVER_STRATEGY
        ? { note: 'Provider 声明了其他策略；本阶段只实现 fresh-session，执行仍按 fresh-session' }
        : {})
    };
  }

  /** 从 Task Runtime 组装结构化 Handoff Packet（Checkpoint v2）。 */
  function buildHandoffPacket({ taskId, reason, sequence, coding, relevantFiles, workspaceFacts, pendingApprovals } = {}) {
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
      // Checkpoint v2：只存 memoryId 引用，Memory 原文留在 Memory Runtime 按需加载。
      memoryRefs: task.memoryRefs.map((ref) => ({ memoryId: ref.memoryId, note: ref.note ?? null })),
      checkpoint: {
        summary: task.checkpoint?.summary ?? '',
        nextAction: task.checkpoint?.nextAction ?? ''
      },
      acceptanceCriteria: task.acceptance.map((item) => `${item.met ? '[x]' : '[ ]'} ${item.text}`),
      previousAgent: task.currentAgent ? { provider: task.currentAgent.provider, sessionId: task.currentAgent.sessionId } : null,
      reasonForHandoff: normalizeReason(reason),
      coding: coding ?? null,
      workspaceFacts: workspaceFacts ?? null,
      pendingApprovals: Array.isArray(pendingApprovals) ? pendingApprovals : null,
      sequence,
      createdAt: now()
    });
    return packet;
  }

  function savePacket(taskId, packet) {
    writeJsonAtomic(packetFile(taskId, packet.sequence), packet);
    writeJsonAtomic(latestPacketFile(taskId), packet);
    prunePacketFiles(path.join(packetDir, String(taskId)));
    return packetFile(taskId, packet.sequence);
  }

  /** 收集真实 Workspace 事实（reconciler 未注入 / 未绑定工作区 / 收集失败 → null，不编造）。 */
  async function collectWorkspaceFacts({ workspaceId, relevantFiles } = {}) {
    if (!reconciler || !workspaceId) return null;
    try {
      return await reconciler.collectFacts({ workspaceId, relevantFiles });
    } catch (error) {
      log(`Continuity workspace facts 收集失败（${workspaceId}）：${String(error?.message ?? error)}`);
      return null;
    }
  }

  /** Bootstrap 提示词：结构化 Task 恢复说明（不复制聊天历史、不复制 Memory 原文）。 */
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
    if (packet.memoryRefs.length) {
      lines.push(`记忆引用（仅引用；需要原文时向 Memory Runtime 按 memoryId 加载，不要臆测内容）:\n- ${packet.memoryRefs.map((ref) => ref.memoryId).join('\n- ')}`);
    }
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
    if (packet.workspaceFacts?.available) {
      const git = packet.workspaceFacts.git;
      if (git) {
        const gitLines = [
          git.isRepo ? `git 仓库: 是（branch=${git.branch ?? 'unknown'}, dirty=${git.dirty ? '是' : '否'}）` : 'git 仓库: 否',
          git.headSha ? `HEAD: ${git.headSha}` : 'HEAD: unknown（无提交或不可得）',
          git.diffSummary ? `diff 摘要:\n${git.diffSummary}` : null
        ].filter(Boolean);
        if (gitLines.length) lines.push(`工作区核验事实（交接时采集，以此为准）:\n- ${gitLines.join('\n- ')}`);
      }
    }
    lines.push(`检查点摘要: ${packet.checkpoint.summary || '（无）'}`);
    lines.push(`下一步（从这里继续）: ${packet.checkpoint.nextAction || packet.pendingWork[0] || '向所有者确认当前进度'}`);
    lines.push(`交接原因: ${packet.reasonForHandoff}`);
    if (packet.pendingApprovals?.length) {
      const rows = packet.pendingApprovals
        .map((row) => `${row.capability}（审批 ${row.approvalId}${row.expiresAt ? `，到期 ${row.expiresAt}` : ''}）`)
        .join('；');
      lines.push(`待审批能力请求: ${rows}`);
      lines.push(`审批规则: 审批不随 Session 交接继承——仅当同一请求（相同 requestId/指纹）且审批未过期时方可继续；否则重新发起请求等待 Owner 审批。`);
    }
    lines.push(`上下文规则: 这是旧任务续接，不要重做已完成工作；先验证以上事实与工作区真实状态再行动；从"下一步"继续；不要要求重新提供本摘要中的信息。`);
    return lines.join('\n');
  }

  function nextSequence(taskId) {
    const store = readHistory();
    return store.rollovers.filter((entry) => entry.taskId === taskId).length + 1;
  }

  /** 评估当前上下文水位 → 动作建议。band 语义：none/checkpoint/ready/rollover/forced/emergency。 */
  function evaluate({ taskId } = {}) {
    const task = requireTask(taskId);
    if (!task.currentAgent) {
      return { taskId, attached: false, action: 'none', policy: activePolicy };
    }
    const sessionKey = `${task.currentAgent.provider}:${task.currentAgent.sessionId}`;
    const level = monitor.level(sessionKey);
    const strategy = strategyOf(task.currentAgent.provider);
    let action = 'none';
    if (level.band === 'emergency') action = 'emergency';
    else if (level.percent >= activePolicy.forcedPercent || level.band === 'forced') action = 'forced';
    else if (level.percent >= activePolicy.rolloverPercent) action = 'rollover';
    else if (level.band === 'ready') action = 'ready';
    else if (level.percent >= activePolicy.preparePercent || level.band === 'prepare') action = 'checkpoint';
    return { taskId, attached: true, sessionKey, level, action, strategy, policy: activePolicy };
  }

  /**
   * 回合结束入口（TASK-S2-004/005）：回合机上报 usage → Monitor → evaluate →
   * 达阈值且绑定 Task 时自动 Fresh Session Rollover。
   * usage 为 Provider 真实回传（原始形状，内部归一化）；没有真实 usage 时用
   * promptChars/outputChars 估算并标记 estimated。绝不把估算冒充真实 Token。
   */
  async function observeAgentTurn({
    provider, sessionId, usage = null, promptChars = 0, outputChars = 0, windowTokens = null, source = null
  } = {}) {
    const providerId = String(provider ?? '').trim();
    const sid = String(sessionId ?? '').trim();
    if (!providerId || !sid) throw continuityError('INVALID_PARAMS', 'observeAgentTurn 需要 provider 与 sessionId');
    const sessionKey = `${providerId}:${sid}`;

    const realUsage = normalizeUsageTokens(usage);
    if (realUsage) {
      monitor.record(sessionKey, {
        inputTokens: realUsage.inputTokens,
        outputTokens: realUsage.outputTokens,
        windowTokens: realUsage.windowTokens ?? (Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0 ? Number(windowTokens) : null)
      });
    } else if (Number(promptChars) > 0 || Number(outputChars) > 0) {
      monitor.record(sessionKey, {
        promptChars: Number(promptChars),
        outputChars: Number(outputChars),
        windowTokens: Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0 ? Number(windowTokens) : null
      });
    }
    const level = monitor.level(sessionKey);

    const task = taskRuntime.findByAgent?.({ provider: providerId, sessionId: sid }) ?? null;
    if (!task) {
      return { provider: providerId, sessionId: sid, sessionKey, recorded: true, source: level.source, level, taskAttached: false, action: 'none' };
    }

    const verdict = evaluate({ taskId: task.id });
    if (!activePolicy.autoRollover || !AUTO_ROLLOVER_ACTIONS.includes(verdict.action)) {
      return {
        provider: providerId, sessionId: sid, sessionKey,
        recorded: true, source: level.source, level,
        taskAttached: true, taskId: task.id,
        action: verdict.action, rolledOver: false, strategy: verdict.strategy
      };
    }

    const reason = verdict.action === 'rollover' ? 'context-threshold' : 'forced-rollover';
    try {
      const result = await rollover({ taskId: task.id, reason });
      return {
        provider: providerId, sessionId: sid, sessionKey,
        recorded: true, source: level.source, level,
        taskAttached: true, taskId: task.id,
        action: verdict.action, rolledOver: true, strategy: verdict.strategy,
        rollover: {
          sequence: result.sequence,
          from: result.from,
          to: result.to,
          crossProvider: result.crossProvider
        }
      };
    } catch (error) {
      const code = error?.code;
      if (code === 'ROLLOVER_NOT_SAFE' || code === 'ROLLOVER_IN_FLIGHT') {
        // 未到安全点 / 已有 rollover 在途：保留当前 Session，按策略升级记录。
        return {
          provider: providerId, sessionId: sid, sessionKey,
          recorded: true, source: level.source, level,
          taskAttached: true, taskId: task.id,
          action: verdict.action, rolledOver: false,
          rolloverBlocked: code,
          escalated: verdict.action !== 'rollover',
          strategy: verdict.strategy
        };
      }
      throw error;
    }
  }

  /**
   * 执行 rollover。只在回合边界调用（调用方负责完成当前原子操作；
   * 注入 canRollover 回调时可做在途回合检查，返回 false 抛 NOT_SAFE）。
   * targetProvider 缺省 = 同 Provider Fresh Session（TASK-S2-009 第一优先）；
   * 指定其它 Provider 即 Cross Provider Handoff（TASK-S2-010）。
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
    if (agentBroker.capabilities(previousAgent.provider)?.workspaceBoundary === 'capability-broker') {
      const status = await agentBroker.status(previousAgent);
      if (status.running || status.queued > 0 || status.waitingForApproval) {
        throw continuityError('ROLLOVER_NOT_SAFE', 'Managed Agent has active work or an unresolved Owner approval');
      }
      const target = targetProvider ? agentBroker.require(targetProvider) : agentBroker.require(previousAgent.provider);
      if (target.capabilities().workspaceBoundary !== 'capability-broker') {
        throw continuityError('ROLLOVER_NOT_SAFE', 'A managed Task cannot switch to an unrestricted Provider');
      }
    }
    inFlight.add(task.id);
    try {
      const sequence = nextSequence(task.id);
      // Workspace 事实：调用方显式传入的优先；否则在工作区绑定且 reconciler 可用时现场采集。
      let facts = workspaceFacts ?? null;
      if (!facts && task.workspaceId) {
        facts = await collectWorkspaceFacts({ workspaceId: task.workspaceId, relevantFiles });
      }
      // Pending Capability Approval 引用（final security）：checkpoint 只记录引用，
      // 审批不作为可继承权限随 Session 交接（同指纹且未过期才可继续，否则重新请求）。
      const pendingApprovals = typeof listPendingApprovals === 'function'
        ? listPendingApprovals({ taskId: task.id })
        : null;
      const packet = buildHandoffPacket({
        taskId: task.id, reason, sequence, coding, relevantFiles,
        workspaceFacts: facts ?? null,
        pendingApprovals: Array.isArray(pendingApprovals) ? pendingApprovals : null
      });
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

      // 2) 结束旧 Session（取消在途回合尽力而为 + 归档能力如实报告）
      const fromProvider = agentBroker.require(previousAgent.provider);
      try {
        await agentBroker.cancel({ provider: fromProvider.id, sessionId: previousAgent.sessionId });
      } catch { /* 旧会话可能已无在途回合 */ }
      const archive = await agentBroker.archiveSession({ provider: fromProvider.id, sessionId: previousAgent.sessionId });

      // 3) 解绑旧 Agent（agentHistory 追加，Task id 不变）
      taskRuntime.detachAgent({ id: task.id, expectedRev: currentRev(), note: `rollover #${sequence}（${packet.reasonForHandoff}）` });

      // 4) 经 Broker 创建新 Session 并发送结构化 bootstrap（不是聊天历史）
      const target = targetProvider ? agentBroker.require(targetProvider) : fromProvider;
      const created = await agentBroker.createSession(target.id, {
        model: model ?? target.defaults?.model,
        reasoningEffort: reasoningEffort ?? target.defaults?.reasoningEffort
      });
      if (!created?.sessionId) {
        throw continuityError('PROVIDER_ERROR', `Agent Provider「${target.id}」未返回 sessionId`);
      }
      // Bind before bootstrap: broker-only providers resolve authorization from the
      // current Task binding. Sending before attachment left fresh sessions unassigned.
      const attached = taskRuntime.attachAgent({
        id: task.id,
        expectedRev: currentRev(),
        provider: target.id,
        sessionId: created.sessionId,
        note: `rollover #${sequence} 自 ${previousAgent.provider}:${previousAgent.sessionId}${archive.supported === true && archive.archived ? '（旧会话已归档）' : ''}`
      });
      await agentBroker.send({
        provider: target.id,
        sessionId: created.sessionId,
        content: renderResumePrompt(packet)
      });

      // 6) Workspace Reconciliation：用真实工作区核验 checkpoint（TASK-S2-007）。
      //    不一致只记录 discrepancy，绝不静默改写 Task State。
      let reconciliation = null;
      if (reconciler && task.workspaceId) {
        const freshFacts = facts ?? await collectWorkspaceFacts({ workspaceId: task.workspaceId, relevantFiles });
        if (freshFacts) {
          reconciliation = reconciler.reconcile({ packet, facts: freshFacts });
          packet.reconciliation = reconciliation;
          writeJsonAtomic(path.join(packetDir, String(task.id), `reconciliation-${String(sequence).padStart(4, '0')}.json`), {
            taskId: task.id, sequence, reconciliation, facts: freshFacts
          });
          prunePacketFiles(path.join(packetDir, String(task.id)));
          if (reconciliation.consistent === false) {
            log(`Continuity reconciliation：任务 ${task.id} 发现 ${reconciliation.discrepancies.length} 处 checkpoint/工作区不一致（已记录）`);
          }
        }
      }

      // 7) 落盘历史 + 重置 monitor（新 session 从零计数）
      const store = readHistory();
      store.rollovers.push({
        taskId: task.id,
        sequence,
        packetId: path.basename(packetPath, '.json'),
        from: { provider: previousAgent.provider, sessionId: previousAgent.sessionId },
        to: { provider: target.id, sessionId: created.sessionId },
        reason: packet.reasonForHandoff,
        crossProvider: target.id !== previousAgent.provider,
        strategy: strategyOf(target.id).preferred,
        archiveSupported: archive.supported === true,
        workspaceReconciled: reconciliation ? reconciliation.consistent : null,
        reconciliation: reconciliation ?? null,
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
        reconciliation,
        task: attached.task
      };
    } finally {
      inFlight.delete(task.id);
    }
  }

  /** 按需核验：对任务最近一次 Handoff Packet 重新收集工作区事实并比对。 */
  async function reconcile({ taskId } = {}) {
    const task = requireTask(taskId);
    const packet = loadContinuityFile(latestPacketFile(task.id), null);
    if (!packet) throw continuityError('PACKET_NOT_FOUND', '该任务尚无 Handoff Packet');
    if (!reconciler) throw continuityError('INVALID_PARAMS', '未注入 Workspace Reconciler，无法核验');
    if (!task.workspaceId) {
      return { taskId: task.id, reconciliation: { checkedAt: now(), consistent: null, discrepancies: [], note: '任务未绑定工作区，无可核验事实' } };
    }
    const facts = await collectWorkspaceFacts({ workspaceId: task.workspaceId, relevantFiles: packet.relevantFiles });
    if (!facts) {
      return { taskId: task.id, reconciliation: { checkedAt: now(), consistent: null, discrepancies: [], note: 'workspace facts 不可得' } };
    }
    const reconciliation = reconciler.reconcile({ packet, facts });
    return { taskId: task.id, packetSequence: packet.sequence, facts, reconciliation };
  }

  function latestPacket({ taskId } = {}) {
    requireTask(taskId);
    const packet = loadContinuityFile(latestPacketFile(taskId), null);
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
    return {
      policy: activePolicy,
      bands: ['normal<70', 'prepare 70-78', 'ready 78-85', 'rollover 85-90', 'forced 90-92', 'emergency 92+'],
      strategy: { implemented: IMPLEMENTED_ROLLOVER_STRATEGY, note: 'Provider 可经 capabilityExtras.rolloverStrategy 声明偏好；本阶段只实现 fresh-session' }
    };
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
    observeAgentTurn,
    rollover,
    reconcile,
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
