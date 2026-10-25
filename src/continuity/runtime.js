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
import { renderOwnerContext } from '../task/owner-context.js';
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
  } catch (error) {
    // 目录还不存在（从未落过 packet）是正常状态，无需清理。
    if (error?.code === 'ENOENT') return;
    throw error;
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
  onHandoffComplete = null,
  prepareHandoff = null,
  readWorkingMemory = null,
  log = () => {}
} = {}) {
  if (!taskRuntime?.get) throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 taskRuntime');
  if (!agentBroker?.require || !agentBroker?.send) {
    throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 Agent Broker（唯一会话通道）');
  }
  if (!stateDir || typeof stateDir !== 'string') throw continuityError('INVALID_PARAMS', 'createContinuityRuntime 需要 stateDir');

  const dir = path.join(stateDir, 'continuity');
  const policyFile = path.join(dir, 'policy.json');
  const monitorFile = path.join(dir, 'monitor.json');
  const activePolicy = normalizePolicy(loadContinuityFile(policyFile, policy ?? DEFAULT_CONTEXT_POLICY));
  const savedMonitor = loadContinuityFile(monitorFile, { sessions: {} });
  const monitor = createContextMonitor({ policy: activePolicy, initialSessions: savedMonitor.sessions,
    onChange: sessions => writeJsonAtomic(monitorFile, { sessions }) });
  const historyFile = path.join(dir, 'rollovers.json');
  const packetDir = path.join(dir, 'handoff');
  const transactionDir = path.join(dir, 'transactions');
  const inFlight = new Set(); // taskId：rollover 串行互斥
  const pendingTransactions = new Set();

  function transactionFile(taskId) {
    return path.join(transactionDir, `${String(taskId)}.json`);
  }

  function writeTransaction(record) {
    writeJsonAtomic(transactionFile(record.taskId), record);
    if (record.state === 'prepared') pendingTransactions.add(record.taskId);
    else pendingTransactions.delete(record.taskId);
  }

  // A crash after the old Agent stops can leave a durable Task assignment that
  // cannot be called committed. Keep it blocked until Owner reconciliation.
  if (fs.existsSync(transactionDir)) {
    for (const name of fs.readdirSync(transactionDir)) {
      if (!name.endsWith('.json')) continue;
      const record = loadContinuityFile(path.join(transactionDir, name), null);
      if (!record || record.state !== 'prepared' || typeof record.taskId !== 'string') continue;
      if (readHistory().rollovers.some(row => row.taskId === record.taskId && row.sequence === record.sequence)) {
        // History plus the sequence packet are the committed source of truth;
        // a crash before changing the journal marker does not undo that commit.
        const committedPacketFile = packetFile(record.taskId, record.sequence);
        if (!loadContinuityFile(committedPacketFile, null)) {
          throw continuityError('STORE_CORRUPT', 'Committed Handoff Packet is missing');
        }
        try { writeTransaction({ ...record, state: 'committed', committedAt: now() }); }
        catch (error) { log(`Continuity committed journal marker repair failed: ${error?.code ?? 'WRITE_FAILED'}`); }
        continue;
      }
      pendingTransactions.add(record.taskId);
      try {
        const task = taskRuntime.get({ id: record.taskId }).task;
        if (['queued', 'running', 'paused', 'waiting'].includes(task.status)) {
          taskRuntime.block({ id: task.id, expectedRev: task.rev,
            reason: 'needs-reconciliation: interrupted Handoff transaction; verify Workspace and execution owner' });
        }
      } catch (error) {
        if (error?.code !== 'TASK_NOT_FOUND') throw error;
      }
    }
  }

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
    } catch (error) {
      if (error?.code !== 'AGENT_PROVIDER_UNKNOWN') throw error;
    }
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
      ownerContext: task.ownerContext ?? null,
      workingMemory: typeof readWorkingMemory === 'function' ? readWorkingMemory(task.id) : [],
      requirements: task.requirements,
      currentPhase: task.currentPhase,
      completedWork: task.completedWork.map((item) => item.text ?? item),
      pendingWork: task.pendingWork.map((item) => item.text ?? item),
      decisions: task.decisions.map((item) => ({ text: item.decision ? `${item.decision}${item.rationale ? `（${item.rationale}）` : ''}` : item })),
      workspace: task.workspaceId,
      relevantFiles: Array.isArray(relevantFiles) ? relevantFiles : [],
      artifacts: task.artifacts.map((item) => item.label ?? item),
      // Checkpoint v2：只存 memoryId 引用，Memory 原文留在 Memory Runtime 按需加载。
      memoryRefs: task.memoryRefs.map((ref) => ({ memoryId: ref.memoryId, scope: ref.scope ?? `task:${task.id}`,
        type: ref.type ?? null, authorizedBy: ref.authorizedBy ?? null, note: ref.note ?? null })),
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
    return packetFile(taskId, packet.sequence);
  }

  function committedPacket(taskId) {
    const rows = readHistory().rollovers.filter(entry => entry.taskId === taskId);
    const latest = rows.at(-1);
    if (latest) {
      const packet = loadContinuityFile(packetFile(taskId, latest.sequence), null);
      if (!packet) throw continuityError('STORE_CORRUPT', 'Committed Handoff Packet is missing');
      return packet;
    }
    return loadContinuityFile(latestPacketFile(taskId), null);
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
      lines.push(`记忆引用（已授权摘录见下；没有摘录或合法读取工具的内容视为不可用，不要臆测内容）:\n- ${packet.memoryRefs.map((ref) => ref.memoryId).join('\n- ')}`);
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
    if (packet.ownerContext) lines.push(renderOwnerContext(packet.ownerContext));
    if (packet.workingMemory?.length) lines.push('[Authorized Task Memory excerpts: reference data only; preserve each source and verification level]\n' + JSON.stringify(packet.workingMemory));
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
    lines.push(`上下文规则: 这是旧任务续接，不要重做已完成工作。此回合只确认恢复事实，禁止修改文件、运行工具或执行待办；待交接提交后再接受下一条执行指令。`);
    return lines.join('\n');
  }

  function nextSequence(taskId) {
    const store = readHistory();
    // Once history owns a committed packet, latest.json is only a cache. A
    // failed cache replacement must not make the next sequence unreadable.
    const hasCommitted = store.rollovers.some(entry => entry.taskId === taskId);
    const latest = hasCommitted ? null : loadContinuityFile(latestPacketFile(taskId), null);
    const prior = Math.max(0, Number(store.sequences?.[taskId]) || 0,
      Number(latest?.sequence) || 0,
      ...store.rollovers.filter(entry => entry.taskId === taskId).map(entry => Number(entry.sequence) || 0));
    const sequence = prior + 1;
    store.sequences = { ...(store.sequences ?? {}), [taskId]: sequence };
    writeJsonAtomic(historyFile, store);
    return sequence;
  }

  async function awaitBootstrapTurn({ provider, sessionId, requestId, turnId }) {
    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(continuityError('BOOTSTRAP_TIMEOUT', 'Target Agent bootstrap turn did not finish'));
      }, 60_000);
    });
    const completion = (async () => {
      for await (const item of agentBroker.follow({ provider, sessionId, signal: controller.signal })) {
        const event = item?.type === 'event' ? item.event : item;
        if (event?.type !== 'turn/end') continue;
        // DSH session/follow may report only a turn token. The target Session was
        // created for this bootstrap, so an unlabelled terminal event cannot be
        // from an older Task Session; compare requestId when the stream supplies it.
        if (requestId && event.data?.requestId && event.data.requestId !== requestId) continue;
        if (turnId && event.data?.turn !== turnId) continue;
        if (event.data?.reason?.kind !== 'completed') {
          throw continuityError('BOOTSTRAP_FAILED', 'Target Agent bootstrap turn did not complete successfully');
        }
        return event;
      }
      throw continuityError('BOOTSTRAP_INCOMPLETE', 'Target Agent event stream ended before bootstrap completion');
    })();
    try { return await Promise.race([completion, timeout]); }
    finally { clearTimeout(timeoutId); controller.abort(); }
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
    if (Array.isArray(usage?.requests)) {
      for (const receipt of usage.requests) {
        if (!receipt || typeof receipt.requestId !== 'string' || !receipt.requestId) continue;
        monitor.record(sessionKey, {
          requestId: receipt.requestId,
          accountingComplete: usage.accountingComplete !== false && typeof receipt.inputTokens === 'number' && typeof receipt.outputTokens === 'number',
          inputTokens: receipt.inputTokens,
          outputTokens: receipt.outputTokens,
          windowTokens: Number.isFinite(receipt.windowTokens) && receipt.windowTokens > 0 ? receipt.windowTokens
            : Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0 ? Number(windowTokens) : null
        });
      }
    } else if (realUsage) {
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
  async function rollover({ taskId, reason, targetProvider, coding, relevantFiles, workspaceFacts, modelProvider, model, reasoningEffort } = {}) {
    const task = requireTask(taskId);
    if (task.parentTaskId && task.childContract?.mode === 'read-only'
      && targetProvider && targetProvider !== 'cetamesh') {
      throw continuityError('AGENT_READ_ONLY_BOUNDARY_UNVERIFIED', 'Child Task cannot hand off to an external native Agent without a verified read-only boundary');
    }
    if ((!task.parentTaskId && taskRuntime.activeWorkspaceReaders({ workspaceId: task.workspaceId }).length)
      || (task.parentTaskId && taskRuntime.activeWorkspaceOwner({ workspaceId: task.workspaceId,
        exceptTaskId: task.id, forReadOnlyTaskId: task.id }))) {
      throw continuityError('ROLLOVER_NOT_SAFE', 'Workspace execution owner conflicts with Task handoff');
    }
    if (!task.workspaceId) throw continuityError('WORKSPACE_REQUIRED', 'Continuity requires a Task-bound Workspace');
    if (inFlight.has(task.id)) {
      throw continuityError('ROLLOVER_IN_FLIGHT', '该任务已有一次 rollover 正在进行，拒绝重复执行');
    }
    if (pendingTransactions.has(task.id)) {
      throw continuityError('HANDOFF_RECOVERY_REQUIRED', 'Prior Handoff transaction needs Owner reconciliation');
    }
    if (typeof canRollover === 'function' && !canRollover({ taskId: task.id })) {
      throw continuityError('ROLLOVER_NOT_SAFE', '当前不是安全 rollover 点（存在在途回合或未完成的原子操作）');
    }
    inFlight.add(task.id);
    try {
    const previousAgent = task.currentAgent;
    if (!previousAgent) {
      throw continuityError('ROLLOVER_NO_AGENT', '任务没有绑定的 Agent Session，无需 rollover（直接 attachAgent 即可）');
    }
    const previousCapabilities = agentBroker.capabilities(previousAgent.provider);
    let previousStatus = null;
    const previousBoundary = previousCapabilities?.workspaceBoundary;
    const taskBoundaries = new Set(['capability-broker', 'staged-capability-broker', 'native-staged']);
    if (!taskBoundaries.has(previousBoundary)) {
      throw continuityError('ROLLOVER_NOT_SAFE', previousBoundary === 'unverified'
        ? 'The current Provider has no verified Task Workspace boundary'
        : 'The current Provider has an unsupported Workspace boundary');
    }
    if (taskBoundaries.has(previousBoundary)) {
      let status;
      try {
        status = await agentBroker.status(previousAgent);
      } catch (error) {
        if (error?.code !== 'SESSION_NOT_FOUND') throw error;
        // Core restart can leave a durable Task pointing at a Provider's lost
        // in-memory session. Treat only that precise stale-reference result as
        // inactive; all other status/auth/transport failures still fail closed.
        status = { running: false, queued: 0, waitingForApproval: false, stale: true };
      }
      if (status.running || status.queued > 0 || status.waitingForApproval) {
        throw continuityError('ROLLOVER_NOT_SAFE', 'Agent has active work or an unresolved Owner approval');
      }
      previousStatus = status;
      const target = targetProvider ? agentBroker.require(targetProvider) : agentBroker.require(previousAgent.provider);
      if (!taskBoundaries.has(target.capabilities().workspaceBoundary)) {
        throw continuityError('ROLLOVER_NOT_SAFE', 'A Task cannot switch to a Provider without an enforced Workspace boundary');
      }
      agentBroker.assertExecutionConsent?.(target.id, { workspaceId: task.workspaceId });
    }
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

      let packet = buildHandoffPacket({
        taskId: task.id, reason, sequence, coding, relevantFiles,
        workspaceFacts: facts ?? null,
        pendingApprovals: Array.isArray(pendingApprovals) ? pendingApprovals : null
      });
      // Verify before creating a target, stopping the old Agent, or persisting a
      // handoff transaction. Caller-supplied facts are a checkpoint, not proof of
      // current Workspace state. Keep the post-bootstrap check for later races.
      if (reconciler && task.workspaceId) {
        const currentFacts = await collectWorkspaceFacts({ workspaceId: task.workspaceId, relevantFiles });
        const preflight = reconciler.reconcile({ packet, facts: currentFacts });
        if (preflight.consistent !== true) {
          const onlyMissingGit = preflight.discrepancies?.length > 0
            && preflight.discrepancies.every(item => item.kind === 'no-git-repo');
          throw continuityError(preflight.consistent === null || onlyMissingGit ? 'WORKSPACE_UNVERIFIED' : 'WORKSPACE_CHANGED',
            onlyMissingGit
              ? '非 Git 工作区无法自动核验交接；原执行者尚未停止，请先核对文件和先前操作。'
              : '工作区交接预检未通过；原执行者尚未停止，请核对工作区后重试。');
        }
      }
      if (typeof prepareHandoff === 'function') await prepareHandoff({ taskId: task.id });
      // Preparation refreshes Owner constraints and authorized Working Memory.
      // Persist and bootstrap the refreshed packet, not the preflight snapshot.
      packet = buildHandoffPacket({
        taskId: task.id, reason, sequence, coding, relevantFiles,
        workspaceFacts: facts ?? null,
        pendingApprovals: Array.isArray(pendingApprovals) ? pendingApprovals : null
      });
      const packetPath = savePacket(task.id, packet);
      const transaction = { taskId: task.id, sequence, state: 'prepared',
        from: previousAgent, to: { provider: targetProvider ?? previousAgent.provider, sessionId: null },
        packetPath, preparedAt: now() };
      writeTransaction(transaction);

      // Task Store 是乐观锁（expectedRev）：每步前取最新 rev，保证与其它写者兼容。
      const currentRev = () => taskRuntime.get({ id: task.id }).task.rev;

      // Keep the live binding and old Session intact until the target is created,
      // attached, and has accepted its bootstrap prompt.
      const previousCheckpoint = task.checkpoint ?? null;
      taskRuntime.setCheckpoint({
        id: task.id,
        expectedRev: currentRev(),
        summary: packet.checkpoint.summary || packet.goal,
        nextAction: packet.checkpoint.nextAction || packet.pendingWork[0] || ''
      });
      const fromProvider = agentBroker.require(previousAgent.provider);
      const target = targetProvider ? agentBroker.require(targetProvider) : fromProvider;
      const targetBoundary = target.capabilities().workspaceBoundary;
      if (!taskBoundaries.has(targetBoundary)) {
        throw continuityError('ROLLOVER_NOT_SAFE', 'A Task cannot switch to a Provider without an enforced Workspace boundary');
      }
      let created = null;
      let attached = null;
      let reconciliation = null;
      let oldStopped = false;
      let bootstrapBoundary = {};
      const selectedModelConfig = {
        modelProvider: modelProvider ?? task.modelConfig?.modelProvider ?? (target.id === previousAgent.provider ? previousStatus?.modelProvider : null) ?? target.defaults?.modelProvider,
        model: model ?? task.modelConfig?.model ?? (target.id === previousAgent.provider ? previousStatus?.model : null) ?? target.defaults?.model,
        reasoningEffort: reasoningEffort ?? task.modelConfig?.reasoningEffort ?? (target.id === previousAgent.provider ? previousStatus?.reasoningEffort : null) ?? target.defaults?.reasoningEffort
      };
      try {
        created = await agentBroker.createSession(target.id, {
          taskId: task.id,
          workspaceId: task.workspaceId,
          ...selectedModelConfig
        });
        if (!created?.sessionId) {
          throw continuityError('PROVIDER_ERROR', `Agent Provider「${target.id}」未返回 sessionId`);
        }
        writeTransaction({ ...transaction, to: { provider: target.id, sessionId: created.sessionId } });
        try {
          await agentBroker.cancel({ provider: fromProvider.id, sessionId: previousAgent.sessionId });
          oldStopped = true;
        } catch (stopError) {
          if (!['SESSION_NOT_FOUND', 'TURN_NOT_RUNNING'].includes(stopError?.code)) throw stopError;
          oldStopped = true;
        }
        try {
          const afterStop = await agentBroker.status(previousAgent);
          if (afterStop.running || afterStop.queued > 0 || afterStop.waitingForApproval) {
            throw continuityError('ROLLOVER_NOT_SAFE', '旧 Agent 仍有活跃执行，拒绝转移 Task 执行权');
          }
        } catch (statusError) {
          if (statusError?.code !== 'SESSION_NOT_FOUND') throw statusError;
        }
        // Bind before bootstrap: broker-only providers resolve authorization from the
        // current Task binding. If bootstrap fails, the old binding is restored below.
        attached = taskRuntime.attachAgent({
          id: task.id,
          expectedRev: currentRev(),
          provider: target.id,
          sessionId: created.sessionId,
          note: `rollover #${sequence} 自 ${previousAgent.provider}:${previousAgent.sessionId}`
        });
        const bootstrap = await agentBroker.send({ provider: target.id, sessionId: created.sessionId, content: renderResumePrompt(packet),
          phase: 'bootstrap', runId: `handoff:${task.id}:${sequence}` });
        if (bootstrap?.accepted !== true) {
          throw continuityError('BOOTSTRAP_REJECTED', 'Target Agent did not accept its recovery turn');
        }
        const bootstrapEnd = await awaitBootstrapTurn({ provider: target.id, sessionId: created.sessionId,
          requestId: bootstrap.requestId, turnId: bootstrap.turnId });
        bootstrapBoundary = { sinceSequence: Number.isSafeInteger(bootstrapEnd?.seq) ? bootstrapEnd.seq : 0,
          bootstrapRequestId: bootstrap.requestId ?? null, bootstrapTurnId: bootstrap.turnId ?? bootstrapEnd?.data?.turn ?? null };

        if (reconciler && task.workspaceId) {
          const freshFacts = await collectWorkspaceFacts({ workspaceId: task.workspaceId, relevantFiles });
          if (freshFacts) {
            reconciliation = reconciler.reconcile({ packet, facts: freshFacts });
            packet.reconciliation = reconciliation;
            writeJsonAtomic(path.join(packetDir, String(task.id), `reconciliation-${String(sequence).padStart(4, '0')}.json`), {
              taskId: task.id, sequence, reconciliation, facts: freshFacts
            });
            prunePacketFiles(path.join(packetDir, String(task.id)));
            if (reconciliation.consistent !== true) {
              throw continuityError(reconciliation.consistent === false ? 'WORKSPACE_CHANGED' : 'WORKSPACE_UNVERIFIED',
                'Workspace changed or cannot be verified during Agent handoff');
            }
          } else {
            throw continuityError('WORKSPACE_UNVERIFIED', 'Workspace facts could not be collected during Agent handoff');
          }
        }
        if (Object.values(selectedModelConfig).some(value => value !== null && value !== undefined && value !== '')) {
          taskRuntime.setModelConfig({ id: task.id, expectedRev: currentRev(), ...selectedModelConfig });
        }
      } catch (error) {
        let targetStopped = true;
        if (created?.sessionId) {
          try { await agentBroker.cancel({ provider: target.id, sessionId: created.sessionId }); }
          catch (cancelError) {
            if (cancelError?.code !== 'SESSION_NOT_FOUND' && cancelError?.code !== 'TURN_NOT_RUNNING') {
              log(`Continuity target Session cancel failed: ${cancelError?.code ?? 'PROVIDER_ERROR'}`);
            }
          }
          try { await agentBroker.closeSession({ provider: target.id, sessionId: created.sessionId }); }
          catch (cleanupError) {
            targetStopped = cleanupError?.code === 'SESSION_NOT_FOUND';
            log(`Continuity target Session cleanup failed: ${cleanupError?.code ?? 'SESSION_CLEANUP_FAILED'}`);
          }
        }
        const current = taskRuntime.get({ id: task.id }).task;
        const targetAttached = Boolean(created?.sessionId && current.currentAgent?.provider === target.id
          && current.currentAgent?.sessionId === created.sessionId);
        if (targetAttached && !targetStopped) {
          taskRuntime.fail({ id: task.id, expectedRev: current.rev,
            reason: 'Handoff target could not be stopped; Task authority revoked for recovery review' });
          throw error;
        }
        if (oldStopped) {
          // A cancelled old Session is no longer a valid execution owner. Retain
          // the Task and checkpoint, but require explicit Workspace recovery.
          if (current.currentAgent) taskRuntime.detachAgent({ id: task.id, expectedRev: current.rev,
            note: `rollover #${sequence} failed after old Agent stopped` });
          taskRuntime.restoreCheckpoint({ id: task.id, expectedRev: currentRev(), checkpoint: previousCheckpoint });
          taskRuntime.block({ id: task.id, expectedRev: currentRev(),
            reason: `needs-reconciliation: Handoff failed after old Agent stopped (${error?.code ?? 'PROVIDER_ERROR'}); verify Workspace before recovery` });
        } else if (targetAttached) {
          try {
            taskRuntime.detachAgent({ id: task.id, expectedRev: current.rev, note: `rollover #${sequence} failed; restore prior Agent` });
            taskRuntime.attachAgent({ id: task.id, expectedRev: currentRev(), provider: previousAgent.provider,
              sessionId: previousAgent.sessionId, note: `rollover #${sequence} rolled back` });
          } catch (rollbackError) {
            log(`Continuity Task binding rollback failed: ${rollbackError?.code ?? 'TASK_ROLLBACK_FAILED'}`);
          }
        }
        if (!oldStopped) {
          try { await taskRuntime.restoreCheckpoint({ id: task.id, expectedRev: currentRev(), checkpoint: previousCheckpoint }); }
          catch (rollbackError) {
            log(`Continuity checkpoint rollback failed: ${rollbackError?.code ?? 'CHECKPOINT_ROLLBACK_FAILED'}`);
          }
        }
        if (!oldStopped && targetStopped) {
          try { writeTransaction({ ...transaction, state: 'rolled-back', resolvedAt: now() }); }
          catch (journalError) {
            log(`Continuity rollback journal failed: ${journalError?.code ?? 'WRITE_FAILED'}`);
            const latest = taskRuntime.get({ id: task.id }).task;
            if (['running', 'paused', 'waiting'].includes(latest.status)) {
              taskRuntime.block({ id: latest.id, expectedRev: latest.rev,
                reason: 'needs-reconciliation: Handoff rollback journal was not saved' });
            }
          }
        }
        throw error;
      }

      // The old execution was stopped before target binding; archive is cleanup only.
      let archive = { supported: false, archived: false };
      try { archive = await agentBroker.archiveSession({ provider: fromProvider.id, sessionId: previousAgent.sessionId }); }
      catch (error) { log(`Continuity old Session archive failed: ${error?.code ?? 'PROVIDER_ERROR'}`); }

      if (previousBoundary === 'staged-capability-broker' || previousCapabilities?.requiresSessionCleanup === true) {
        try { await agentBroker.closeSession({ provider: fromProvider.id, sessionId: previousAgent.sessionId }); }
        catch (error) {
          if (error?.code !== 'SESSION_NOT_FOUND') log(`Continuity staging cleanup failed: ${error?.code ?? 'PROVIDER_ERROR'}`);
        }
      }

      // 6) 落盘历史 + 重置 monitor（新 session 从零计数）
      try {
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
      } catch (error) {
        // The old Session is already stopped and the target is bound. Never
        // report a failed Handoff while leaving that target as an active writer.
        try { await agentBroker.cancel({ provider: target.id, sessionId: created.sessionId }); }
        catch (stopError) { log(`Continuity uncommitted target cancel failed: ${stopError?.code ?? 'PROVIDER_ERROR'}`); }
        try { await agentBroker.closeSession({ provider: target.id, sessionId: created.sessionId }); }
        catch (stopError) { log(`Continuity uncommitted target close failed: ${stopError?.code ?? 'PROVIDER_ERROR'}`); }
        const latest = taskRuntime.get({ id: task.id }).task;
        if (latest.currentAgent?.sessionId === created.sessionId) {
          taskRuntime.detachAgent({ id: task.id, expectedRev: latest.rev,
            note: 'Handoff commit failed; target authority revoked' });
        }
        const blocked = taskRuntime.get({ id: task.id }).task;
        if (['running', 'paused', 'waiting'].includes(blocked.status)) {
          taskRuntime.block({ id: task.id, expectedRev: blocked.rev,
            reason: 'needs-reconciliation: Handoff history or commit journal could not be saved' });
        }
        throw continuityError('HANDOFF_COMMIT_FAILED', 'Handoff commit was not durable; Owner must reconcile before retrying');
      }
      try { writeTransaction({ ...transaction, state: 'committed', committedAt: now() }); }
      catch (error) {
        // The history and packet are already durable. Do not falsely report a
        // failed Handoff; startup repairs this derived journal marker.
        pendingTransactions.delete(task.id);
        log(`Continuity committed journal marker update failed: ${error?.code ?? 'WRITE_FAILED'}`);
      }
      try { writeJsonAtomic(latestPacketFile(task.id), packet); }
      catch (error) { log(`Continuity latest Packet cache update failed: ${error?.code ?? 'WRITE_FAILED'}`); }
      prunePacketFiles(path.join(packetDir, String(task.id)));
      monitor.reset(`${previousAgent.provider}:${previousAgent.sessionId}`);
      const projectionWarnings = [];
      if (typeof onHandoffComplete === 'function') {
        try { await onHandoffComplete({ taskId: task.id, provider: target.id, sessionId: created.sessionId, ...bootstrapBoundary }); }
        catch (error) {
          projectionWarnings.push(error?.code ?? 'ASSIGNMENT_PROJECTION_FAILED');
          log(`Committed Handoff projection failed: ${error?.code ?? 'ASSIGNMENT_PROJECTION_FAILED'}`);
        }
      }

      return {
        taskId: task.id,
        sequence,
        packetPath,
        projectionWarnings,
        from: previousAgent,
        to: { provider: target.id, sessionId: created.sessionId },
        crossProvider: target.id !== previousAgent.provider,
        reconciliation,
        task: taskRuntime.get({ id: task.id }).task
      };
    } finally {
      inFlight.delete(task.id);
    }
  }

  /** 按需核验：对任务最近一次 Handoff Packet 重新收集工作区事实并比对。 */
  async function reconcile({ taskId } = {}) {
    const task = requireTask(taskId);
    const packet = committedPacket(task.id);
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
    const packet = committedPacket(taskId);
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
    writeJsonAtomic(policyFile, activePolicy);
    return getPolicy();
  }

  return {
    isInFlight(taskId) { return inFlight.has(String(taskId ?? '')) || pendingTransactions.has(String(taskId ?? '')); },
    acknowledgeTransactionRecovery(taskId) {
      const id = String(taskId ?? '');
      if (!pendingTransactions.has(id)) return { acknowledged: false };
      const record = loadContinuityFile(transactionFile(id), null);
      if (!record || record.state !== 'prepared') throw continuityError('STORE_CORRUPT', 'Pending Handoff journal is missing');
      writeTransaction({ ...record, state: 'reconciled', reconciledAt: now() });
      return { acknowledged: true, sequence: record.sequence };
    },
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

