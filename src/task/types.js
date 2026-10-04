// CetaMesh Persistent Task v1 —— 任务领域契约（阶段 07）。
//
// 核心原则：Task 属于 CetaMesh，不属于任何 Agent Session。
//   Task  ├ Agent Provider A / Session A
//         ├ Agent Provider B / Session B
//         └ ...
// 更换 Provider 只追加 agentHistory，绝不新建 Task。
//
// 本文件是纯契约层：状态词表、合法迁移表、字段归一化。不做 IO，不依赖 DSH / UI。

export const TASK_STATUSES = Object.freeze([
  'queued', 'running', 'waiting', 'blocked', 'paused', 'completed', 'failed', 'cancelled'
]);

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

// 需要人介入的状态（Tasks UI 的 Needs Attention）。
export const ATTENTION_STATUSES = Object.freeze(['blocked', 'waiting', 'failed']);

// 合法状态迁移表。终态不可再迁移。
export const TASK_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'paused', 'cancelled', 'failed']),
  running: Object.freeze(['waiting', 'blocked', 'paused', 'completed', 'failed', 'cancelled']),
  waiting: Object.freeze(['running', 'blocked', 'paused', 'cancelled', 'failed']),
  blocked: Object.freeze(['running', 'waiting', 'paused', 'cancelled', 'failed']),
  paused: Object.freeze(['running', 'cancelled', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});

export const TASK_LIMITS = Object.freeze({
  goalChars: 2000,
  requirementChars: 1000,
  requirements: 50,
  listItems: 100,
  noteChars: 2000,
  checkpointChars: 8000,
  phaseChars: 120,
  idChars: 128,
  artifacts: 200,
  decisions: 200,
  memoryRefs: 200,
  acceptance: 50,
  agentHistory: 100
});

export function taskError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isTerminalStatus(value) {
  return TERMINAL_STATUSES.includes(value);
}

export function normalizeStatus(value) {
  if (!isTaskStatus(value)) {
    throw taskError('INVALID_STATUS', '未知任务状态：' + String(value));
  }
  return value;
}

export function canTransition(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertTransition(from, to) {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw taskError('TASK_INVALID_TRANSITION', '任务状态不允许从 ' + from + ' 迁移到 ' + to);
  }
}

export function normalizeText(value, label, maxChars, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw taskError('INVALID_PARAMS', label + '不能为空');
    return '';
  }
  if (typeof value !== 'string') throw taskError('INVALID_PARAMS', label + '必须是字符串');
  const text = value.trim();
  if (required && !text) throw taskError('INVALID_PARAMS', label + '不能为空');
  if (text.length > maxChars) throw taskError('INVALID_PARAMS', label + '超过 ' + maxChars + ' 字符');
  return text;
}

export function normalizeStringList(value, label, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw taskError('INVALID_PARAMS', label + '必须是数组');
  const out = [];
  for (const raw of value) {
    const text = typeof raw === 'string' ? raw.trim() : String(raw === null || raw === undefined ? '' : raw).trim();
    if (!text) continue;
    if (text.length > TASK_LIMITS.requirementChars) {
      throw taskError('INVALID_PARAMS', label + '条目过长：' + text.slice(0, 20));
    }
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > maxItems) throw taskError('INVALID_PARAMS', label + '最多 ' + maxItems + ' 条');
  return out;
}

/** Workspace 关联：空值表示尚未绑定工作区（不是默认工作区）。 */
export function normalizeWorkspaceId(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(text)) {
    throw taskError('INVALID_WORKSPACE', '非法 Workspace ID：' + text.slice(0, 40));
  }
  return text;
}

export function normalizeProvider(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(text)) {
    throw taskError('INVALID_PROVIDER', '非法 Agent Provider：' + text.slice(0, 40));
  }
  return text;
}

export function normalizePercent(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw taskError('INVALID_PROGRESS', 'progress.percent 必须是 0..100');
  }
  return Math.round(n);
}

/** 验收标准：接受字符串数组或 { text, met } 数组。 */
export function normalizeAcceptance(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw taskError('INVALID_PARAMS', 'acceptanceCriteria 必须是数组');
  const out = [];
  for (const raw of value) {
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (text) out.push({ id: null, text: text.slice(0, TASK_LIMITS.requirementChars), met: false, metAt: null });
      continue;
    }
    if (raw && typeof raw === 'object') {
      const text = String(raw.text === null || raw.text === undefined ? '' : raw.text).trim();
      if (!text) continue;
      out.push({
        id: raw.id ? String(raw.id) : null,
        text: text.slice(0, TASK_LIMITS.requirementChars),
        met: raw.met === true,
        metAt: raw.met === true ? Number(raw.metAt) || null : null
      });
    }
  }
  if (out.length > TASK_LIMITS.acceptance) {
    throw taskError('INVALID_PARAMS', '验收标准最多 ' + TASK_LIMITS.acceptance + ' 条');
  }
  return out;
}

export function needsAttention(task) {
  return ATTENTION_STATUSES.includes(task.status);
}
