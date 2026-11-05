// CetaMesh Continuity Runtime v2 —— Rollover / Handoff 编排（阶段 09；会话 2 重构）。
//
// v2 变更（会话 2 / TASK-S2-003/004/005/006/007/008/009/010）：
//   1) 唯一依赖 Agent Broker：移除本目录自带的窄 AgentProvider 注册表与 DSH 实现；
//      会话创建/发送/取消/归档一律走 broker（DSH 只是第一个真实 Provider）。
//   2) observeAgentTurn：回合机在 Agent 回合结束后调用——最新请求 usage 入
//      Context Monitor；只知用户消息字符数时保持 unknown，不冒充完整上下文；
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

import { taskModelForAgent } from '../agent/task-model-selection.js';
import { inspectTaskSession } from '../agent/session-recovery.js';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { normalizeModelUsage } from '../model/usage.js';
import { createContextMonitor } from './monitor.js';

const AUTO_ROLLOVER_ACTIONS = Object.freeze(['rollover', 'forced', 'emergency']);

/** 每个 Task 保留的 handoff packet / reconciliation 文件数上限（更旧的在写入时清理）。 */
const PACKET_FILES_KEEP = 20;

function assertHandoffIdle(status) {
  const uncertain = new Set(['unknown', 'outcome-unknown', 'reconciliation-required']);
  if (status?.running !== false || status.runtimeValid === false
    || uncertain.has(status.state) || uncertain.has(status.lastRunStatus)
    || status.effectStatus === 'unknown'
    || (status.queued !== undefined && status.queued !== 0)
    || (status.waitingForApproval != null && status.waitingForApproval !== false)) {
    throw continuityError('ROLLOVER_NOT_SAFE', 'Agent execution is active or unverified; reconcile its state before transferring Task authority');
  }
}

function workspacePreflightMessage(preflight, facts, onlyMissingGit) {
  const observed = new Set(facts?.observationErrors ?? []);
  const discrepancies = new Set((preflight.discrepancies ?? []).map(item => item.kind));
  let reason;
  if (onlyMissingGit) reason = '非 Git 工作区无法自动核验交接，请先核对文件和先前操作';
  else if (facts?.reason === 'workspace-not-found') reason = '任务工作区已不可用，请检查项目文件夹和工作区登记状态';
  else if (observed.has('WORKSPACE_CONTENT_NESTED_REPOSITORY')) reason = '工作区包含嵌套 Git 仓库或工作树，当前无法核验其内容范围；请先核对这些目录的归属与先前操作，不能直接重试交接';
  else if (observed.has('GIT_STATUS_OBSERVATION_FAILED')) reason = '无法读取 Git 工作区状态，请检查仓库和文件访问权限';
  else if (observed.has('GIT_HEAD_OBSERVATION_FAILED')) reason = '无法读取 Git HEAD，请检查仓库状态和 Git 可用性';
  else if (observed.has('GIT_DIFF_OBSERVATION_FAILED')) reason = '无法读取 Git 差异，请检查仓库状态和 Git 可用性';
  else if (observed.has('FILE_OBSERVATION_FAILED')) reason = '无法读取交接相关文件，请检查文件访问权限';
  else if (observed.has('WORKSPACE_CONTENT_UNVERIFIED')) reason = '工作区文件或 Git 索引的内容摘要无法核验，请检查文件类型、访问权限与并发修改';
  else if (discrepancies.has('missing-file')) reason = '交接记录中的相关文件已不存在，请先核对任务文件和先前操作';
  else if (preflight.consistent === false) reason = '工作区与交接记录不一致，请先核对分支、提交和文件修改';
  else reason = '工作区交接证据不完整，请先核对项目和先前操作';
  return `${reason}。未切换执行者，原任务绑定保持不变。`;
}

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
  readOperations = null,
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
    if (!Array.isArray(store.rollovers)) throw continuityError('STORE_CORRUPT','Invalid Continuity history');
    if (store.automaticBudgets === undefined) {
      store.automaticBudgets = {};
      for (const row of store.rollovers.filter(row=>row.automatic===true)) {
        const budget = store.automaticBudgets[row.taskId] ??= { count: 0, recent: [] };
        budget.count++;if(typeof row.progressFingerprint==='string')budget.recent.push(row.progressFingerprint);
        budget.recent=budget.recent.slice(-100);
      }
    }
    if (!store.automaticBudgets || typeof store.automaticBudgets!=='object' || Array.isArray(store.automaticBudgets)
      || Object.values(store.automaticBudgets).some(row=>!Number.isSafeInteger(row?.count)||row.count<0
        ||!Array.isArray(row.recent)||row.recent.length>100||row.recent.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))) {
      throw continuityError('STORE_CORRUPT','Invalid automatic handoff budget');
    }
    return store;
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
    const operations = typeof readOperations === 'function' ? readOperations({ taskId: task.id, workspaceId: task.workspaceId }) : [];
    if (operations.length > 100) throw continuityError('HANDOFF_OPERATION_CONTEXT_REVIEW_REQUIRED', 'Operation context exceeds the handoff budget; review it before switching');
    const packet = normalizePacket({
      taskId: task.id,
      attemptId: task.attempts?.at(-1)?.id ?? null,
      versionContext: task.currentAgent?.versionContext ?? null,
      operations,
      goal: task.goal,
      ownerContext: task.ownerContext ?? null,
      workingMemory: typeof readWorkingMemory === 'function' ? readWorkingMemory(task.id) : [],
      requirements: task.requirements,
      currentPhase: task.currentPhase,
      completedWork: task.completedWork.map((item) => item.text ?? item),
      pendingWork: task.pendingWork.map((item) => item.text ?? item),
      decisions: task.decisions.map((item) => ({ text: item.decision ? `${item.decision}${item.rationale ? `（${item.rationale}）` : ''}` : item })),
      workspace: task.workspaceId,
      relevantFiles,
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
    if (packet.attemptId) lines.push(`previousAttemptId: ${packet.attemptId}`);
    if (packet.operations?.length) {
      lines.push('既有操作记录（Core 派发事实，不是新的执行授权）:\n' + packet.operations.map(row =>
        `${row.operationId}${row.logicalStepId ? ` (step: ${row.logicalStepId})` : ``}: ${row.capability} / ${row.status} / ${row.continuationState}${row.continuationInput?' / saved safe verification input: '+JSON.stringify(row.continuationInput):''}`).join('\n'));
      lines.push('已完成操作先用 operation.read(operationRef) 核验原结果，仍有效则跳过；未知或已人工核对的操作不得重新派发。新的执行者必须重新通过当前权限检查。');
      lines.push('已登记操作使用 operation.continue({operationRef,input}) 或 operation.continue({logicalStepId,input}) 续接；logicalStepId 必须来自 Owner 登记的步骤，input 必须符合原始参数指纹；该入口仍检查源工具权限和审批。交接后的新副作用缺少可信操作引用时必须核验，不能猜测匹配或重新执行整项任务。');
    }
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
    if(packet.versionContext)lines.push('[Executor version reference; historical snapshot, verify current Workspace before using]\n'+JSON.stringify(packet.versionContext));
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
   * usage 为 Provider 真实回传（内部复用模型用量归一化）；累计账本只取最后一次
   * 请求。promptChars/outputChars 仅为回合文本长度，不能证明当前完整上下文。
   */
  async function observeAgentTurn({
    provider, sessionId, usage = null, promptChars = 0, outputChars = 0, windowTokens = null, source = null
  } = {}) {
    const providerId = String(provider ?? '').trim();
    const sid = String(sessionId ?? '').trim();
    if (!providerId || !sid) throw continuityError('INVALID_PARAMS', 'observeAgentTurn 需要 provider 与 sessionId');
    const sessionKey = `${providerId}:${sid}`;

    // Tool-loop and approval continuations carry cumulative billing receipts.
    // Only the latest effective request describes current context occupancy.
    const receipt = Array.isArray(usage?.requests) ? usage.requests.at(-1) : usage;
    const currentUsage = normalizeModelUsage(receipt);
    monitor.record(sessionKey, {
      requestId: receipt?.requestId,
      inputTokens: currentUsage.inputTokens,
      outputTokens: currentUsage.outputTokens,
      accountingComplete: usage?.accountingComplete !== false && currentUsage.inputTokens !== null && currentUsage.outputTokens !== null,
      windowTokens: currentUsage.windowTokens ?? (Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0 ? Number(windowTokens) : null)
    });
    const level = monitor.level(sessionKey);

    const task = taskRuntime.findByAgent?.({ provider: providerId, sessionId: sid }) ?? null;
    if (!task) {
      return { provider: providerId, sessionId: sid, sessionKey, recorded: true, source: level.source, level, taskAttached: false, action: 'none' };
    }

    const verdict = evaluate({ taskId: task.id });
    if(['proposed','dispatching','awaiting-result','returning','verifying','unknown'].includes(task.delegationProposal?.state)) {
      return {provider:providerId,sessionId:sid,sessionKey,recorded:true,source:level.source,level,taskAttached:true,taskId:task.id,
        action:verdict.action,rolledOver:false,rolloverBlocked:'TASK_DELEGATION_BOUNDARY',strategy:verdict.strategy};
    }
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
      const result = await rollover({ taskId: task.id, reason, automatic: true });
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
  async function rollover({ taskId, reason, targetProvider, coding, relevantFiles, workspaceFacts, modelProvider, model, reasoningEffort, automatic = false, requireNativeReadiness = false, authorizationGuard = null } = {}) {
    const task = requireTask(taskId);
    let missingSourceProof = null;
    async function requireMissingSourceStopped(snapshot) {
      // The source was proven stopped before target creation. Re-running a
      // Task-wide quiescence check afterwards would include that new target.
      // The Handoff fence prevents source dispatch; reuse only this invocation's
      // exact source proof, never a historical Task summary or another binding.
      const matching = missingSourceProof?.provider === snapshot.currentAgent?.provider
        && missingSourceProof?.sessionId === snapshot.currentAgent?.sessionId
        && missingSourceProof?.workspaceId === snapshot.workspaceId;
      const proof = matching ? missingSourceProof : await inspectTaskSession(agentBroker, snapshot);
      const current = requireTask(snapshot.id);
      if (current.rev !== snapshot.rev || current.workspaceId !== snapshot.workspaceId
        || current.currentAgent?.provider !== snapshot.currentAgent?.provider
        || current.currentAgent?.sessionId !== snapshot.currentAgent?.sessionId) {
        throw continuityError('TASK_CONFLICT', 'Task changed while verifying the previous execution owner');
      }
      if (proof.stopped !== true) throw continuityError('SESSION_EXECUTION_UNCONFIRMED',
        '旧会话不可见不代表执行已停止。请在任务详情核对原执行者停止凭据和工作区结果后恢复。');
      missingSourceProof = proof;
    }
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
    if (typeof readOperations === 'function' && readOperations({ taskId: task.id, workspaceId: task.workspaceId })
      .some(row => ['started', 'outcome-unknown'].includes(row.status))) {
      throw continuityError('ROLLOVER_NOT_SAFE', 'Prior Task operations need reconciliation before transferring execution');
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
        if (error?.code === 'SESSION_TRANSPORT_UNKNOWN') throw continuityError(error.code,
          '旧会话的执行连接无法确认，当前不能转交。请在任务详情查看恢复证据，并核对旧执行者进程和工作区的实际结果；确认状态前不会启动新执行。');
        if (error?.code !== 'SESSION_NOT_FOUND') throw error;
        // Only Core-owned Managed sessions disappear with Core. Native/external
        // absence needs the same exact stopped proof as explicit recovery.
        await requireMissingSourceStopped(task);
        status = { running: false, queued: 0, waitingForApproval: false, stale: true };
      }
      assertHandoffIdle(status);
      previousStatus = status;
      const target = targetProvider ? agentBroker.require(targetProvider) : agentBroker.require(previousAgent.provider);
      if (!taskBoundaries.has(target.capabilities().workspaceBoundary)) {
        throw continuityError('ROLLOVER_NOT_SAFE', 'A Task cannot switch to a Provider without an enforced Workspace boundary');
      }
      if (requireNativeReadiness && target.capabilities().supportsReadinessCheck !== true) {
        throw continuityError('AGENT_READINESS_UNSUPPORTED', 'This adapter cannot prove native tool readiness');
      }
      agentBroker.assertExecutionConsent?.(target.id, { workspaceId: task.workspaceId });
    }
      const sequence = nextSequence(task.id);
      // Workspace 事实：调用方显式传入的优先；否则在工作区绑定且 reconciler 可用时现场采集。
      let facts = workspaceFacts ?? null;
      if (!facts && task.workspaceId) {
        facts = await collectWorkspaceFacts({ workspaceId: task.workspaceId, relevantFiles });
      }
      const progressFingerprint = crypto.createHash('sha256').update(JSON.stringify({
        goal: task.goal, requirements: task.requirements,
        operations: typeof readOperations === 'function' ? readOperations({taskId:task.id,workspaceId:task.workspaceId})
          .filter(row=>row.status==='completed').map(row=>row.operationId).sort() : [],
        evidence: (task.executionEvidence??[]).filter(row=>row.status==='completed'
          && (row.source==='core-import'||['filesystem.write','test.run'].includes(row.capability)))
          .map(row=>[row.eventId,row.resultSha256,row.exitCode]),
        head: facts?.git?.headSha??null,
        contentProof: facts?.contentProof??null,
        files: (facts?.files??[]).map(row=>[row.path,row.sha256]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))
      })).digest('hex');
      if (automatic === true) {
        const budget = readHistory().automaticBudgets[task.id] ?? {count:0,recent:[]};
        if (budget.count >= activePolicy.maxAutomaticSwitches) throw continuityError('HANDOFF_BUDGET_EXHAUSTED','Automatic handoff limit reached; review the Task before choosing another executor');
        const recent = budget.recent.slice(-activePolicy.maxAutomaticNoProgress);
        if (recent.length === activePolicy.maxAutomaticNoProgress && recent.every(value=>value===progressFingerprint)) {
          throw continuityError('HANDOFF_NO_PROGRESS','Automatic handoffs made no verified progress; review the blocked work');
        }
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
            workspacePreflightMessage(preflight, currentFacts, onlyMissingGit));
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
      const beforeCheckpoint = requireTask(task.id);
      const previousCheckpoint = beforeCheckpoint.checkpoint ?? null;
      const writtenCheckpoint = taskRuntime.setCheckpoint({
        id: task.id,
        expectedRev: beforeCheckpoint.rev,
        summary: packet.checkpoint.summary || packet.goal,
        nextAction: packet.checkpoint.nextAction || packet.pendingWork[0] || ''
      }).checkpoint;
      function restoreOwnedCheckpoint() {
        const current = requireTask(task.id);
        // A rollback owns only its exact checkpoint projection. Other actors may
        // update this Task while Provider calls are awaited; their later facts win.
        if (current.workspaceId !== task.workspaceId
          || JSON.stringify(current.checkpoint) !== JSON.stringify(writtenCheckpoint)) return;
        taskRuntime.restoreCheckpoint({ id: task.id, expectedRev: current.rev, checkpoint: previousCheckpoint });
      }
      function blockForRecovery(reason) {
        const current = requireTask(task.id);
        // Binding records the execution we must inspect; blocked revokes new
        // dispatch. Keep terminal Tasks terminal and preserve every source/target
        // identity until the existing Owner recovery flow retires it explicitly.
        if (['queued', 'running', 'waiting'].includes(current.status)) {
          taskRuntime.block({ id: task.id, expectedRev: current.rev, reason });
        } else if (current.status === 'paused') {
          // Paused already forbids execution and has no transition to blocked.
          taskRuntime.setProgress({ id: task.id, expectedRev: current.rev, note: reason });
        }
      }
      const fromProvider = agentBroker.require(previousAgent.provider);
      const target = targetProvider ? agentBroker.require(targetProvider) : fromProvider;
      const targetBoundary = target.capabilities().workspaceBoundary;
      if (!taskBoundaries.has(targetBoundary)) {
        throw continuityError('ROLLOVER_NOT_SAFE', 'A Task cannot switch to a Provider without an enforced Workspace boundary');
      }
      let created = null;
      let creationEntered = false;
      let attached = null;
      let reconciliation = null;
      let oldStopped = false;
      let bootstrapBoundary = {};
      const nativeReadinessToken=requireNativeReadiness ? 'CM_READY_'+crypto.randomBytes(16).toString('hex') : null;
      const inheritedModel = taskModelForAgent(task, target.id);
      const confirmedModel = target.id === previousAgent.provider
        && previousStatus?.modelControl?.status === 'available'
        && previousStatus.modelControl.application === 'runtime-confirmed'
        ? previousStatus.modelControl.selection : null;
      const selectedModelConfig = {
        modelProvider: modelProvider ?? (confirmedModel ? confirmedModel.modelProvider ?? undefined
          : inheritedModel.modelProvider ?? (target.id === previousAgent.provider ? previousStatus?.modelProvider : null) ?? target.defaults?.modelProvider),
        model: model ?? confirmedModel?.model ?? inheritedModel.model ?? (target.id === previousAgent.provider ? previousStatus?.model : null) ?? target.defaults?.model,
        reasoningEffort: reasoningEffort ?? (confirmedModel ? confirmedModel.reasoningEffort ?? undefined
          : inheritedModel.reasoningEffort ?? (target.id === previousAgent.provider ? previousStatus?.reasoningEffort : null) ?? target.defaults?.reasoningEffort)
      };
      try {
        authorizationGuard?.({provider:target.id});
        creationEntered = true;
        created = await agentBroker.createSession(target.id, {
          taskId: task.id,
          workspaceId: task.workspaceId,
          ...selectedModelConfig
        });
        if (!created?.sessionId) {
          throw continuityError('PROVIDER_ERROR', `Agent Provider「${target.id}」未返回 sessionId`);
        }
        if (created.modelControl || confirmedModel) {
          const control = created.modelControl;
          const requested = Object.entries(selectedModelConfig).filter(([,value])=>value!==undefined&&value!==null&&value!=='');
          if (requested.length && (control?.status!=='available' || control.application!=='runtime-confirmed'
            || requested.some(([key,value])=>control.selection?.[key]!==value))) {
            throw continuityError('MODEL_ACK_MISMATCH','目标 Agent 尚未确认模型配置；原执行者保持绑定，请核验目标运行时');
          }
          if (control?.status==='available' && control.application==='runtime-confirmed' && control.selection?.model) {
            selectedModelConfig.model=control.selection.model;
            selectedModelConfig.modelProvider=control.selection.modelProvider??null;
            selectedModelConfig.reasoningEffort=control.selection.reasoningEffort??null;
          }
        }
        authorizationGuard?.({provider:target.id,sessionId:created.sessionId});
        transaction.to = { provider: target.id, sessionId: created.sessionId };
        writeTransaction(transaction);
        const beforeStop = requireTask(task.id);
        try {
          await agentBroker.cancel({ provider: fromProvider.id, sessionId: previousAgent.sessionId });
          oldStopped = true;
        } catch (stopError) {
          if (!['SESSION_NOT_FOUND', 'TURN_NOT_RUNNING'].includes(stopError?.code)) throw stopError;
          if (stopError?.code === 'SESSION_NOT_FOUND') await requireMissingSourceStopped(beforeStop);
          oldStopped = true;
        }
        const beforeStopStatus = requireTask(task.id);
        try {
          const afterStop = await agentBroker.status(previousAgent);
          assertHandoffIdle(afterStop);
        } catch (statusError) {
          if (statusError?.code !== 'SESSION_NOT_FOUND') throw statusError;
          await requireMissingSourceStopped(beforeStopStatus);
        }
        // Bind before bootstrap: broker-only providers resolve authorization from the
        // current Task binding. If bootstrap fails, the old binding is restored below.
        authorizationGuard?.({provider:target.id,sessionId:created.sessionId});
        attached = taskRuntime.attachAgent({
          id: task.id,
          expectedRev: currentRev(),
          provider: target.id,
          sessionId: created.sessionId,
          versionContext: created.versionContext,
          note: `rollover #${sequence} 自 ${previousAgent.provider}:${previousAgent.sessionId}`
        });
        const bootstrap = await agentBroker.send({ provider: target.id, sessionId: created.sessionId, content: nativeReadinessToken
          ? 'Core native readiness check ONLY: use your native command tool once to print the exact token '+nativeReadinessToken+'. Do not read or modify project or host files, execute project code, use network, or perform the Task. Return after the successful command. This bootstrap is not permission for task work.'
          : renderResumePrompt(packet),...(nativeReadinessToken?{nativeReadinessToken}:{}),
          phase: 'bootstrap', authorizationGuard:()=>authorizationGuard?.({provider:target.id,sessionId:created.sessionId}), runId: `handoff:${task.id}:${sequence}` });
        if (bootstrap?.accepted !== true) {
          throw continuityError('BOOTSTRAP_REJECTED', 'Target Agent did not accept its recovery turn');
        }
        const bootstrapEnd = await awaitBootstrapTurn({ provider: target.id, sessionId: created.sessionId,
          requestId: bootstrap.requestId, turnId: bootstrap.turnId });
        if(nativeReadinessToken){const proof=await agentBroker.status({provider:target.id,sessionId:created.sessionId});
          if(proof.readiness?.verified!==true||proof.readiness.runId!=='handoff:'+task.id+':'+sequence||proof.readiness.tokenSha256!==crypto.createHash('sha256').update(nativeReadinessToken).digest('hex'))
            throw continuityError('AGENT_READINESS_UNVERIFIED','No current native tool proof was returned');
        }
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
        // ACP preserves a supervised session when startup cleanup is unknown.
        // This is a trusted adapter error contract, not an arbitrary error hint.
        if (creationEntered && !created?.sessionId && error?.code === 'ACP_CLOSE_UNKNOWN'
          && error.provider === target.id && typeof error.sessionId === 'string'
          && error.sessionId.length > 0 && error.sessionId.length <= 240 && !/[\r\n\0]/.test(error.sessionId)) {
          created = { provider: target.id, sessionId: error.sessionId };
          transaction.to = { provider: target.id, sessionId: created.sessionId };
          try { writeTransaction(transaction); }
          catch (journalError) { log(`Continuity retained startup identity write failed: ${journalError?.code ?? 'WRITE_FAILED'}`); }
        }
        // A rejected create can already own an external process. Without an ID,
        // only its exact Task-wide proof can close that uncertainty; Managed
        // execution belongs to this Core and has not received a dispatch here.
        let targetStopped = !creationEntered || target.id === 'cetamesh';
        if (creationEntered && !created?.sessionId && target.id !== 'cetamesh'
          && typeof target.verifyTaskQuiescence === 'function') {
          const snapshot = requireTask(task.id);
          try {
            const proof = await target.verifyTaskQuiescence({ taskId: task.id, workspaceId: task.workspaceId });
            const latest = requireTask(task.id);
            targetStopped = proof?.stopped === true && latest.rev === snapshot.rev && latest.workspaceId === task.workspaceId;
          } catch (proofError) { log(`Continuity startup stop proof unavailable: ${proofError?.code ?? 'SESSION_EXECUTION_UNCONFIRMED'}`); }
        }
        if (created?.sessionId) {
          try { await agentBroker.cancel({ provider: target.id, sessionId: created.sessionId }); }
          catch (cancelError) {
            if (cancelError?.code !== 'SESSION_NOT_FOUND' && cancelError?.code !== 'TURN_NOT_RUNNING') {
              log(`Continuity target Session cancel failed: ${cancelError?.code ?? 'PROVIDER_ERROR'}`);
            }
          }
          targetStopped = false;
          try {
            const closed = await agentBroker.closeSession({ provider: target.id, sessionId: created.sessionId });
            targetStopped = closed?.closed === true;
          }
          catch (cleanupError) {
            if (cleanupError?.code === 'SESSION_NOT_FOUND') {
              const snapshot = requireTask(task.id);
              const proof = await inspectTaskSession(agentBroker, snapshot, { provider: target.id, sessionId: created.sessionId });
              // Missing Managed state is Core-owned; native absence still needs
              // exact lifecycle proof. Never clear a transaction after a raced review.
              targetStopped = proof.stopped === true && requireTask(task.id).rev === snapshot.rev;
            }
            log(`Continuity target Session cleanup failed: ${cleanupError?.code ?? 'SESSION_CLEANUP_FAILED'}`);
          }
        }
        const current = taskRuntime.get({ id: task.id }).task;
        const targetAttached = Boolean(created?.sessionId && current.currentAgent?.provider === target.id
          && current.currentAgent?.sessionId === created.sessionId);
        if (!targetStopped) {
          restoreOwnedCheckpoint();
          blockForRecovery('needs-reconciliation: Handoff target could not be stopped; verify both execution owners before recovery');
          throw error;
        }
        if (oldStopped) {
          // Retain the exact stopped/unknown assignment as recovery evidence.
          // Only formal Owner recovery retires it; blocked forbids new execution.
          restoreOwnedCheckpoint();
          blockForRecovery(`needs-reconciliation: Handoff failed after old Agent stopped (${error?.code ?? 'PROVIDER_ERROR'}); verify Workspace before recovery`);
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
          try { restoreOwnedCheckpoint(); }
          catch (rollbackError) {
            log(`Continuity checkpoint rollback failed: ${rollbackError?.code ?? 'CHECKPOINT_ROLLBACK_FAILED'}`);
          }
        }
        if (!oldStopped && targetStopped) {
          try { writeTransaction({ ...transaction, state: 'rolled-back', resolvedAt: now() }); }
          catch (journalError) {
            log(`Continuity rollback journal failed: ${journalError?.code ?? 'WRITE_FAILED'}`);
            blockForRecovery('needs-reconciliation: Handoff rollback journal was not saved');
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

      // 6) 落盘历史 + 清除旧会话占用快照（新会话等待自己的真实观测）
      try {
        const store = readHistory();
        if (automatic === true) {
          const budget=store.automaticBudgets[task.id]??={count:0,recent:[]};
          budget.count++;budget.recent=[...budget.recent,progressFingerprint].slice(-100);
        }
        store.rollovers.push({
        taskId: task.id,
        sequence,
        packetId: path.basename(packetPath, '.json'),
        from: { provider: previousAgent.provider, sessionId: previousAgent.sessionId },
        to: { provider: target.id, sessionId: created.sessionId },
        reason: packet.reasonForHandoff,
        crossProvider: target.id !== previousAgent.provider,
        automatic: automatic === true,
        progressFingerprint,
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
        blockForRecovery('needs-reconciliation: Handoff history or commit journal could not be saved');
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
        ...(created.modelControl ? {modelControl:created.modelControl} : {}),
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
    transactionReviewState(taskId) {
      const id = String(taskId ?? '');
      if (inFlight.has(id)) throw continuityError('ROLLOVER_IN_FLIGHT', 'Handoff has not settled');
      if (!pendingTransactions.has(id)) return null;
      requireTask(id);
      const record = loadContinuityFile(transactionFile(id), null);
      if (!record || record.state !== 'prepared' || record.taskId !== id
        || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
        throw continuityError('STORE_CORRUPT', 'Pending Handoff journal identity is invalid');
      }
      // packetPath is historical display metadata, not a path-read authority.
      const packet = loadContinuityFile(packetFile(id, record.sequence), null);
      if (!packet || packet.taskId !== id || packet.sequence !== record.sequence
        || typeof packet.workspace !== 'string' || !packet.workspace.trim()) {
        throw continuityError('STORE_CORRUPT', 'Pending Handoff Packet identity is invalid');
      }
      return { ...record, workspaceId: packet.workspace };
    },
    acknowledgeTransactionRecovery(taskId) {
      const id = String(taskId ?? '');
      if (inFlight.has(id)) throw continuityError('ROLLOVER_IN_FLIGHT', 'Handoff has not settled');
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

