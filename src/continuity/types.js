// CetaMesh Continuity Runtime —— 领域契约（阶段 09）。
//
// 职责：Context 阈值词表（对齐 docs/architecture/CETAMESH_CONTINUITY_RUNTIME_v1.0.md 第 5 节）、
// Handoff Packet 的字段归一化与校验、限制常量。纯契约层，不做 IO，不依赖 DSH / UI。
//
// 核心原则：Task 属于 CetaMesh；Agent Session 可换，Task ID 不变；
// rollover 传递的是结构化 Task state / Workspace truth / Checkpoint，而不是聊天历史。

import { taskError } from '../task/types.js';

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
  charsPerToken: 4
});

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
    charsPerToken: Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CONTEXT_POLICY.charsPerToken
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
 * Handoff Packet 归一化。核心字段与用户契约一致：
 *   taskId/goal/requirements/currentPhase/completedWork/pendingWork/decisions/
 *   workspace/relevantFiles/artifacts/checkpoint/acceptanceCriteria/
 *   previousAgent/reasonForHandoff（+ coding 扩展段）。
 * 缺失字段如实为空值——不伪造任何 workspace / git 事实。
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
  const stringList = (value, maxItems) => {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item ?? '').slice(0, PACKET_LIMITS.idChars)).filter((item) => item.trim()).slice(0, maxItems);
  };
  return {
    taskId: text(packet.taskId, PACKET_LIMITS.idChars),
    goal: text(packet.goal, PACKET_LIMITS.summaryChars),
    requirements: stringList(packet.requirements, PACKET_LIMITS.listItems),
    currentPhase: text(packet.currentPhase, 120),
    completedWork: list(packet.completedWork, PACKET_LIMITS.listItems),
    pendingWork: list(packet.pendingWork, PACKET_LIMITS.listItems),
    decisions: list(packet.decisions, PACKET_LIMITS.listItems),
    workspace: text(packet.workspace, PACKET_LIMITS.idChars) || null,
    relevantFiles: stringList(packet.relevantFiles, PACKET_LIMITS.listItems),
    artifacts: stringList(packet.artifacts, PACKET_LIMITS.listItems),
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
    sequence: Number.isSafeInteger(packet.sequence) && packet.sequence > 0 ? packet.sequence : 1,
    createdAt: Number.isFinite(packet.createdAt) ? packet.createdAt : null
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
