// CetaMesh Continuity Runtime —— 领域契约（阶段 09）。
//
// 职责：Context 阈值词表（对齐 docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md 第 5 节）、
// Handoff Packet 的字段归一化与校验、限制常量。纯契约层，不做 IO，不依赖 DSH / UI。
//
// 核心原则：Task 属于 CetaMesh；Agent Session 可换，Task ID 不变；
// rollover 传递的是结构化 Task state / Workspace truth / Checkpoint，而不是聊天历史。

import { TASK_LIMITS, taskError } from '../task/types.js';

export const continuityError = taskError;

// 上下文使用率阈值带（percent = used / window * 100）。
// 触发语义：>= preparePercent 建议生成 checkpoint；>= rolloverPercent 应执行 rollover；
// >= forcedPercent 无条件 rollover（不允许再等"安全点"以外的原子操作）。
export const CONTEXT_BANDS = Object.freeze([
  { band: 'normal', upTo: 70 },
  { band: 'prepare', upTo: 78 },
  { band: 'ready', upTo: 85 },
  { band: 'rollover', upTo: 90 },
  { band: 'forced', upTo: 92 },
  { band: 'emergency', upTo: Number.POSITIVE_INFINITY }
]);

export const DEFAULT_CONTEXT_POLICY = Object.freeze({
  preparePercent: 70,
  rolloverPercent: 85,
  forcedPercent: 90,
  // 未知 window 时的估算窗口（tokens）。估算规则见 monitor.js——不伪造真实 usage。
  defaultWindowTokens: 128000,
  charsPerToken: 4,
  // 达到 rollover/forced/emergency 阈值时是否自动执行 Fresh Session rollover
  //（false = 只评估上报，由人工/调用方显式触发）。
  autoRollover: true
});

/**
 * Provider 可声明的 rollover 策略词表（capabilityExtras.rolloverStrategy.preferred）。
 * 第一版只实现 fresh-session：其他声明值照实透传给评估结果，但执行时仍走
 * fresh-session（本阶段不建立复杂自动学习，也不假装实现了压缩续接）。
 */
export const ROLLOVER_STRATEGIES = Object.freeze(['fresh-session', 'compact-continue']);
export const IMPLEMENTED_ROLLOVER_STRATEGY = 'fresh-session';

export function bandFor(percent) {
  // 左闭右开：normal [0,70)、prepare [70,78)、ready [78,85)、rollover [85,90)、forced [90,92)、emergency [92,∞)。
  for (const entry of CONTEXT_BANDS) {
    if (percent < entry.upTo) return entry.band;
  }
  return 'emergency';
}

/** 阈值策略归一化：0 < prepare <= rollover <= forced <= 100。 */
export function normalizePolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const merged = { ...DEFAULT_CONTEXT_POLICY, ...source };
  const numbers = {};
  for (const key of ['preparePercent', 'rolloverPercent', 'forcedPercent']) {
    const n = Number(merged[key]);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      throw continuityError('INVALID_PARAMS', `policy.${key} 必须在 (0,100] 内`);
    }
    numbers[key] = n;
  }
  if (!(numbers.preparePercent <= numbers.rolloverPercent && numbers.rolloverPercent <= numbers.forcedPercent)) {
    throw continuityError('INVALID_PARAMS', 'policy 阈值必须满足 prepare <= rollover <= forced');
  }
  const window = Number(merged.defaultWindowTokens);
  const charsPerToken = Number(merged.charsPerToken);
  return {
    ...numbers,
    defaultWindowTokens: Number.isFinite(window) && window > 0 ? Math.round(window) : DEFAULT_CONTEXT_POLICY.defaultWindowTokens,
    charsPerToken: Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CONTEXT_POLICY.charsPerToken,
    autoRollover: merged.autoRollover !== false
  };
}

export const PACKET_LIMITS = Object.freeze({
  summaryChars: 8000,
  nextActionChars: 2000,
  textChars: 2000,
  idChars: 128,
  listItems: 100,
  history: 200,
  reasons: 20
});

export const HANDOFF_REASONS = Object.freeze([
  'context-threshold',
  'forced-rollover',
  'provider-switch',
  'owner-request',
  'session-lost',
  'other'
]);

/** rollover 原因归一化：未知原因按 'other' 收敛，不抛错（记录原始值）。 */
export function normalizeReason(value) {
  const text = String(value ?? '').trim();
  return HANDOFF_REASONS.includes(text) ? text : 'other';
}

/**
 * Handoff Packet 归一化（Checkpoint v2，会话 2）。核心字段与用户契约一致：
 *   taskId/goal/requirements/currentPhase/completedWork/pendingWork/decisions/
 *   workspace/relevantFiles/artifacts/memoryRefs/checkpoint/acceptanceCriteria/
 *   previousAgent/reasonForHandoff/workspaceFacts（+ coding 扩展段 + reconciliation）。
 * 缺失字段如实为空值——不伪造任何 workspace / git / memory 事实。
 * memoryRefs 只存引用 id（Memory 原文留在 Memory Runtime，按需加载，不复制进 packet）。
 */
export function normalizePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw continuityError('INVALID_PACKET', 'Handoff Packet 必须是对象');
  }
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const list = (value, maxItems) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (typeof item === 'string') return text(item, PACKET_LIMITS.textChars);
        if (item && typeof item === 'object') {
          const rendered = item.text ?? item.decision ?? item.summary ?? item.label;
          return rendered === undefined ? '' : text(rendered, PACKET_LIMITS.textChars);
        }
        return '';
      })
      .filter((item) => item.trim())
      .slice(0, maxItems);
  };
  const stringList = (value, maxItems, maxChars = PACKET_LIMITS.idChars) => {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item ?? '').slice(0, maxChars)).filter((item) => item.trim()).slice(0, maxItems);
  };
  return {
    taskId: text(packet.taskId, PACKET_LIMITS.idChars),
    goal: text(packet.goal, PACKET_LIMITS.summaryChars),
    requirements: stringList(packet.requirements, PACKET_LIMITS.listItems, TASK_LIMITS.requirementChars),
    currentPhase: text(packet.currentPhase, 120),
    completedWork: list(packet.completedWork, PACKET_LIMITS.listItems),
    pendingWork: list(packet.pendingWork, PACKET_LIMITS.listItems),
    decisions: list(packet.decisions, PACKET_LIMITS.listItems),
    workspace: text(packet.workspace, PACKET_LIMITS.idChars) || null,
    relevantFiles: stringList(packet.relevantFiles, PACKET_LIMITS.listItems),
    artifacts: stringList(packet.artifacts, PACKET_LIMITS.listItems),
    // Memory 引用：只保留 memoryId（+可选 note），不携带 Memory 原文。
    memoryRefs: (() => {
      const refs = [];
      const source = Array.isArray(packet.memoryRefs) ? packet.memoryRefs : [];
      for (const ref of source) {
        const id = typeof ref === 'string' ? ref.trim() : String(ref?.memoryId ?? '').trim();
        if (!id) continue;
        refs.push({ memoryId: id.slice(0, PACKET_LIMITS.idChars),
          scope: text(ref?.scope, 160) || null, type: text(ref?.type, 40) || null,
          authorizedBy: text(ref?.authorizedBy, 160) || null, note: text(ref?.note, 200) || null });
        if (refs.length >= PACKET_LIMITS.listItems) break;
      }
      return refs;
    })(),
    checkpoint: {
      summary: text(packet.checkpoint?.summary, PACKET_LIMITS.summaryChars),
      nextAction: text(packet.checkpoint?.nextAction, PACKET_LIMITS.nextActionChars)
    },
    acceptanceCriteria: list(packet.acceptanceCriteria, PACKET_LIMITS.listItems),
    previousAgent: packet.previousAgent && typeof packet.previousAgent === 'object'
      ? {
          provider: text(packet.previousAgent.provider, 64) || null,
          sessionId: text(packet.previousAgent.sessionId, PACKET_LIMITS.idChars) || null
        }
      : { provider: null, sessionId: null },
    reasonForHandoff: normalizeReason(packet.reasonForHandoff),
    // Coding 任务扩展段：由调用方提供真实事实；没有就是 null/空数组，绝不编造。
    coding: normalizeCodingFacts(packet.coding),
    // Workspace 事实段（Checkpoint v2）：调用方收集的真实 git/文件事实，结构透传；
    // 没有收集到就是 null。这里只做形状收窄，不补充内容。
    workspaceFacts: normalizeWorkspaceFacts(packet.workspaceFacts),
    // Workspace Reconciliation 结果（fresh session 核验后回填；构建时为 null）。
    reconciliation: packet.reconciliation && typeof packet.reconciliation === 'object' && !Array.isArray(packet.reconciliation)
      ? {
          checkedAt: Number.isFinite(packet.reconciliation.checkedAt) ? packet.reconciliation.checkedAt : null,
          consistent: packet.reconciliation.consistent === true
            ? true
            : packet.reconciliation.consistent === false ? false : null,
          discrepancies: Array.isArray(packet.reconciliation.discrepancies)
            ? packet.reconciliation.discrepancies.slice(0, PACKET_LIMITS.listItems)
            : [],
          note: text(packet.reconciliation.note, 2000) || null
        }
      : null,
    // Pending Capability Approval 引用（会话 2 final security）：rollover 时任务
    // 仍在等待 Owner 审批的能力请求。Checkpoint 只保存**引用**（approvalId /
    // capability / expiresAt）——审批本身不作为可继承权限随 Session 交接：
    // 新 Session 若要继续，必须在审批仍有效时严格按同一 request fingerprint
    // 复用，否则重新请求审批。
    pendingApprovals: (() => {
      const rows = Array.isArray(packet.pendingApprovals) ? packet.pendingApprovals : [];
      return rows.slice(0, 20).map((row) => ({
        approvalId: text(row?.approvalId, 128) || null,
        capability: text(row?.capability, 200) || null,
        expiresAt: Number.isFinite(row?.expiresAt) ? row.expiresAt : null
      })).filter((row) => row.approvalId && row.capability);
    })(),
    sequence: Number.isSafeInteger(packet.sequence) && packet.sequence > 0 ? packet.sequence : 1,
    createdAt: Number.isFinite(packet.createdAt) ? packet.createdAt : null
  };
}

function normalizeWorkspaceFacts(facts) {
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
  if (facts.available !== true) {
    return { available: false, reason: typeof facts.reason === 'string' ? facts.reason.slice(0, 200) : 'unknown', workspaceId: text(facts.workspaceId, PACKET_LIMITS.idChars) || null };
  }
  const git = facts.git && typeof facts.git === 'object' ? {
    isRepo: facts.git.isRepo === true,
    branch: text(facts.git.branch, 200),
    headSha: text(facts.git.headSha, 64),
    dirty: facts.git.dirty === true,
    diffSummary: text(facts.git.diffSummary, 4000) || null,
    ...(typeof facts.git.statusError === 'string' ? { statusError: facts.git.statusError.slice(0, 200) } : {}),
    ...(typeof facts.git.headError === 'string' ? { headError: facts.git.headError.slice(0, 200) } : {})
  } : null;
  return {
    available: true,
    workspaceId: text(facts.workspaceId, PACKET_LIMITS.idChars) || null,
    workspaceName: text(facts.workspaceName, 200) || null,
    git,
    files: Array.isArray(facts.files)
      ? facts.files.slice(0, PACKET_LIMITS.listItems).map((file) => ({
          path: text(file?.path, PACKET_LIMITS.idChars),
          exists: file?.exists === true
        })).filter((file) => file.path)
      : [],
    collectedAt: Number.isFinite(facts.collectedAt) ? facts.collectedAt : null
  };
}

function normalizeCodingFacts(coding) {
  if (!coding || typeof coding !== 'object' || Array.isArray(coding)) {
    return { branch: null, headSha: null, gitStatus: null, gitDiffSummary: null, testsRun: [], buildStatus: null, knownFailures: [] };
  }
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.slice(0, max) : null);
  const stringList = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item ?? '').slice(0, 500)).filter((item) => item.trim()).slice(0, PACKET_LIMITS.listItems);
  };
  return {
    branch: text(coding.branch, 200),
    headSha: text(coding.headSha, 64),
    gitStatus: text(coding.gitStatus, 4000),
    gitDiffSummary: text(coding.gitDiffSummary, 4000),
    testsRun: stringList(coding.testsRun),
    buildStatus: text(coding.buildStatus, 500),
    knownFailures: stringList(coding.knownFailures)
  };
}
