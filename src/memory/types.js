// CetaMesh Memory v1 —— 记忆类型 / Scope / 来源的统一词表与纯校验函数（阶段 04）。
//
// 分层位置：Domain Contract。只定义契约与纯函数：不做 IO，不依赖 QQ / DSH / 原生 UI，
// 供 runtime、adapter、service 与测试共用。
//
// Fail-closed 原则：未知类型 / 未知 Scope / 非法主体一律拒绝，绝不"猜一个默认值"。

export const MEMORY_TYPES = Object.freeze(['working', 'chat', 'user', 'task', 'workspace', 'social', 'knowledge', 'skill']);

// 长期记忆：Agent / Chat 候选 / 导入写入这些类型前必须先取得用户确认。
// working 是短期工作记忆，允许 Agent 在授权范围内直接写入（仍然受 Scope 与授权约束）。
export const LONG_TERM_TYPES = Object.freeze(['chat', 'user', 'task', 'workspace', 'social', 'knowledge', 'skill']);

export const MEMORY_SOURCES = Object.freeze(['user', 'chat-candidate', 'qq-adapter', 'system']);

export const SCOPE_KINDS = Object.freeze(['global', 'workspace', 'task', 'chat', 'user']);

export const MEMORY_LIMITS = Object.freeze({
  contentChars: 4000,
  tags: 16,
  tagChars: 40,
  queryChars: 200,
  listLimit: 200
});

export function memoryError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function normalizeFactMetadata({ factKey, validUntil } = {}, principal) {
  if (factKey === undefined && validUntil === undefined) return {};
  if (principal?.kind !== 'user') throw memoryError('FACT_METADATA_REQUIRES_USER', 'Only a user may assign semantic fact identity or validity');
  if (factKey !== undefined && factKey !== null && (typeof factKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(factKey)))
    throw memoryError('INVALID_FACT_METADATA', 'factKey must be a bounded explicit identifier');
  if (validUntil !== undefined && validUntil !== null && (!Number.isSafeInteger(validUntil) || validUntil <= 0))
    throw memoryError('INVALID_FACT_METADATA', 'validUntil must be a positive timestamp or null');
  return { ...(factKey !== undefined ? { factKey } : {}), ...(validUntil !== undefined ? { validUntil } : {}) };
}

export function isMemoryType(value) {
  return MEMORY_TYPES.includes(value);
}

export function isLongTermType(value) {
  return LONG_TERM_TYPES.includes(value);
}

const SCOPE_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

/** 接受 'global' | 'workspace:<id>' | { kind, id }，归一化为冻结的 { kind, id }。 */
export function normalizeScope(input) {
  let kind;
  let id = null;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw memoryError('INVALID_SCOPE', 'Scope 不能为空');
    const sep = text.indexOf(':');
    if (sep < 0) {
      kind = text;
    } else {
      kind = text.slice(0, sep);
      id = text.slice(sep + 1);
    }
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    kind = input.kind;
    id = input.id === undefined ? null : input.id;
  } else {
    throw memoryError('INVALID_SCOPE', 'Scope 必须是字符串或 { kind, id }');
  }

  if (typeof kind !== 'string' || !SCOPE_KINDS.includes(kind)) {
    throw memoryError('INVALID_SCOPE', '未知 Scope 类型：' + String(kind));
  }
  if (kind === 'global') {
    const explicit = id === null || id === undefined ? '' : String(id);
    if (explicit !== '' && explicit !== 'global') {
      throw memoryError('INVALID_SCOPE', 'global Scope 不接受 id');
    }
    return Object.freeze({ kind: 'global', id: null });
  }
  const textId = String(id === null || id === undefined ? '' : id).trim();
  if (!SCOPE_ID_RE.test(textId)) {
    throw memoryError('INVALID_SCOPE', kind + ' Scope 需要合法 id');
  }
  return Object.freeze({ kind, id: textId });
}

export function scopeKey(scope) {
  return scope.kind === 'global' ? 'global' : scope.kind + ':' + scope.id;
}

export function normalizeMemoryType(value) {
  if (!isMemoryType(value)) {
    throw memoryError('INVALID_MEMORY_TYPE', '未知记忆类型：' + String(value));
  }
  return value;
}

export function normalizeContent(value) {
  if (typeof value !== 'string') throw memoryError('INVALID_CONTENT', '记忆内容必须是字符串');
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) throw memoryError('INVALID_CONTENT', '记忆内容不能为空');
  if (text.length > MEMORY_LIMITS.contentChars) {
    throw memoryError('INVALID_CONTENT', '记忆内容超过 ' + MEMORY_LIMITS.contentChars + ' 字符');
  }
  return text;
}

export function normalizeTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw memoryError('INVALID_TAGS', 'tags 必须是数组');
  const out = [];
  for (const raw of value) {
    const tag = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!tag) continue;
    if (tag.length > MEMORY_LIMITS.tagChars) {
      throw memoryError('INVALID_TAGS', '标签过长：' + tag.slice(0, 20));
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MEMORY_LIMITS.tags) {
    throw memoryError('INVALID_TAGS', '标签最多 ' + MEMORY_LIMITS.tags + ' 个');
  }
  return out;
}

export function normalizeSource(value) {
  if (value === undefined || value === null) return 'user';
  if (!MEMORY_SOURCES.includes(value)) {
    throw memoryError('INVALID_SOURCE', '未知来源：' + String(value));
  }
  return value;
}

export function normalizeQuery(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw memoryError('INVALID_QUERY', 'query 必须是字符串');
  const text = value.trim();
  if (text.length > MEMORY_LIMITS.queryChars) {
    throw memoryError('INVALID_QUERY', 'query 超过 ' + MEMORY_LIMITS.queryChars + ' 字符');
  }
  return text;
}

export function normalizeLimit(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw memoryError('INVALID_LIMIT', 'limit 必须是正整数');
  return Math.min(n, MEMORY_LIMITS.listLimit);
}

export function assertPrincipal(principal) {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
    throw memoryError('UNAUTHORIZED', '缺少操作主体（principal）');
  }
  if (principal.kind !== 'user' && principal.kind !== 'agent') {
    throw memoryError('UNAUTHORIZED', '未知主体类型：' + String(principal.kind));
  }
  const id = String(principal.id === null || principal.id === undefined ? '' : principal.id).trim();
  if (!id) throw memoryError('UNAUTHORIZED', '主体缺少 id');
  return { kind: principal.kind, id, grants: principal.grants || null };
}
