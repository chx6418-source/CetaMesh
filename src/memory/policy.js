// CetaMesh Memory v1 —— 授权层（阶段 04）。
//
// 铁律：authorize 先于 retrieve。
// authorize 的产物是一份**检索过滤器**（已授权的 scopeKey 列表 + 允许的类型），
// runtime 原样交给 store.scanAuthorized。未授权的 Scope 永远不进入扫描集合，
// 所以产品里不存在"先取全部再过滤"的代码路径。
//
// 默认拒绝（fail-closed）：
// - 未知主体 / 未知动作 / 未知类型 / 未授予的 Scope 一律拒绝；
// - Agent 默认只能读 working + chat，只能写 working（短期）；
// - Agent 写长期记忆（chat/user/task/workspace）在策略层就被拒绝，
//   必须走 Chat 候选 → 用户确认路径，杜绝静默写入长期记忆；
// - confirm / admin 只允许用户主体。

import { assertPrincipal, isLongTermType, isMemoryType, memoryError, normalizeScope, scopeKey } from './types.js';

export const MEMORY_ACTIONS = Object.freeze(['read', 'write', 'delete', 'propose', 'confirm', 'admin']);

export const AGENT_DEFAULT_READ_TYPES = Object.freeze(['working', 'chat']);
export const AGENT_DEFAULT_WRITE_TYPES = Object.freeze(['working']);

function uniqueStrings(values) {
  const out = [];
  for (const raw of values) {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export function createMemoryPolicy({ audit = null } = {}) {
  function decide(principal, action, request) {
    assertPrincipal(principal);
    if (!MEMORY_ACTIONS.includes(action)) {
      throw memoryError('UNKNOWN_ACTION', '未知记忆动作：' + String(action));
    }

    const requestedScopes = Array.isArray(request.scopes) ? request.scopes.map(normalizeScope) : null;
    const requestedTypes = Array.isArray(request.types) ? request.types.slice() : null;
    if (requestedTypes) {
      for (const type of requestedTypes) {
        if (!isMemoryType(type)) throw memoryError('INVALID_MEMORY_TYPE', '未知记忆类型：' + String(type));
      }
    }

    let scopeKeys;
    let types;
    let longTermWrite = false;

    if (principal.kind === 'user') {
      if (requestedScopes?.some(scope => scope.kind === 'user' && scope.id !== principal.id)) {
        throw memoryError('SCOPE_NOT_AUTHORIZED', 'User Memory scope does not match the signed-in identity');
      }
      scopeKeys = requestedScopes ? uniqueStrings(requestedScopes.map(scopeKey)) : ['*'];
      types = requestedTypes && requestedTypes.length ? uniqueStrings(requestedTypes) : null;
      longTermWrite = action === 'write';
    } else {
      const granted = principal.grants && Array.isArray(principal.grants.scopes)
        ? principal.grants.scopes.map(String)
        : [];
      const grantedKeys = uniqueStrings(granted);
      const readOnlyRefs = principal.grants?.readOnlyRefs && typeof principal.grants.readOnlyRefs === 'object'
        ? principal.grants.readOnlyRefs : {};
      if (grantedKeys.length === 0) {
        throw memoryError('SCOPE_NOT_AUTHORIZED', 'Agent 主体未授予任何 Scope');
      }
      if (requestedScopes) {
        const wanted = uniqueStrings(requestedScopes.map(scopeKey));
        const denied = wanted.filter((key) => !grantedKeys.includes(key));
        if (denied.length) {
          throw memoryError('SCOPE_NOT_AUTHORIZED', 'Scope 未授权：' + denied.join(', '));
        }
        scopeKeys = wanted;
      } else {
        scopeKeys = grantedKeys;
      }
      if (action !== 'read' && scopeKeys.some(key => Object.hasOwn(readOnlyRefs, key))) {
        throw memoryError('SCOPE_NOT_AUTHORIZED', 'Referenced Memory scope is read-only');
      }

      if (action === 'confirm' || action === 'admin') {
        throw memoryError('UNAUTHORIZED', '动作 ' + action + ' 只允许用户主体');
      }
      if (action === 'delete') {
        throw memoryError('UNAUTHORIZED', 'Agent 不能删除长期记忆，请由用户操作');
      }

      if (action === 'read') {
        const allowed = principal.grants && Array.isArray(principal.grants.types)
          ? uniqueStrings(principal.grants.types).filter(isMemoryType)
          : [...AGENT_DEFAULT_READ_TYPES];
        types = requestedTypes && requestedTypes.length
          ? requestedTypes.filter((t) => allowed.includes(t))
          : allowed;
        if (types.length === 0) throw memoryError('TYPE_NOT_AUTHORIZED', '请求的记忆类型均未授权');
      } else if (action === 'write') {
        if (requestedTypes && requestedTypes.some(isLongTermType)) {
          throw memoryError(
            'LONG_TERM_REQUIRES_CONFIRMATION',
            'Agent 不能直接写入长期记忆，必须先提出候选并取得用户确认'
          );
        }
        types = [...AGENT_DEFAULT_WRITE_TYPES];
      } else if (action === 'propose') {
        types = requestedTypes && requestedTypes.length ? uniqueStrings(requestedTypes) : null;
      }
    }

    const decision = {
      allowed: true,
      principal: { kind: principal.kind, id: principal.id },
      action,
      scopeKeys,
      types,
      longTermWrite,
      userScopeId: principal.kind === 'user' ? principal.id : null,
      readOnlyRefs: principal.kind === 'agent' ? (principal.grants?.readOnlyRefs ?? {}) : {}
    };
    if (typeof audit === 'function') audit(decision);
    return decision;
  }

  return {
    /** 返回授权决策（含检索过滤器）；用于审计与测试。 */
    authorize(request) {
      return decide(request.principal, request.action, request);
    },
    /** 授权失败即抛错；runtime 只用这个入口，保证不会忘记检查 allowed。 */
    requireAuthorization(request) {
      const decision = decide(request.principal, request.action, request);
      if (!decision.allowed) throw memoryError('UNAUTHORIZED', '记忆操作未授权');
      return decision;
    }
  };
}
