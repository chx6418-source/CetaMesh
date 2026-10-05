import { PRIVILEGE_CONSOLE } from '../bridge-privilege.js';

export const CONTROL_METHODS = Object.freeze({
  LIST_ROLES: 'role.list',
  SET_ROLE: 'role.set',
  CREATE_ROLE: 'role.create',
  SET_ROLE_MODE: 'role.setMode',
  GET_SECURITY: 'security.get',
  UPDATE_SECURITY: 'security.update',
  GET_POLICY: 'policy.get',
  UPDATE_POLICY: 'policy.update',
  GET_SLANG_CONFIG: 'slang.getConfig',
  UPDATE_SLANG_CONFIG: 'slang.updateConfig',
  LIST_SESSIONS: 'session.list',
  LIST_ACTIVITY: 'activity.list',
  READ_LOGS: 'logs.read',
  SET_SOCIAL_PHASE: 'social.setPhase',
  RUN_DIAGNOSTICS: 'diagnostics.run',
  GET_SERVICES: 'services.get',
  DETECT_SERVICES: 'services.detect',
  SELECT_SERVICE: 'services.select',
  INSTALL_SNOWLUMA: 'services.installSnowLuma',
  START_SERVICE: 'services.start',
  STOP_SERVICE: 'services.stop',
  GET_MODEL_DEFAULTS: 'model.defaults.get',
  UPDATE_MODEL_DEFAULTS: 'model.defaults.update',
  LIST_MODEL_CATALOG: 'model.catalog.list',
  LIST_PRESETS: 'preset.list',
  GET_PRESET_BINDINGS: 'preset.bindings.get',
  UPDATE_PRESET_BINDINGS: 'preset.bindings.update',
  LIST_PENDING: 'pending.list',
  DECIDE_PENDING: 'pending.decide'
});

export const DIAGNOSTIC_CHECKS = Object.freeze(['runtime', 'config', 'paths', 'services']);
export const CONTROL_MODES = Object.freeze(['chat', 'closed-agent', 'social', 'workshop']);
export const CONTROL_LOG_SOURCES = Object.freeze(['bridge', 'worker', 'desktop']);
export const CONTROL_SERVICES = Object.freeze(['snowluma', 'dsh']);
export const CONTROL_REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
export const PRESET_BINDING_TARGETS = Object.freeze(['chat', 'closedAgent', 'social', 'workshop', 'learner']);
// reserved 已弃用（→ chat），reserved2 更名为 social。读取旧值时在内存迁移，写入时用新值。
const LEGACY_MODE_MIGRATIONS = Object.freeze({ reserved: 'chat', reserved2: 'social' });
const MODE_LIST_TEXT = 'chat / closed-agent / social / workshop';
export function migrateLegacyMode(value) {
  const text = String(value ?? '').trim();
  return LEGACY_MODE_MIGRATIONS[text] ?? text;
}
const CONTROL_LOG_MAX_RETURN_CHARS = 64 * 1024;
const DSH_CATALOG_ID_MAX_CHARS = 128;

function mapMaybe(value, mapper) {
  return Promise.resolve(value).then(mapper);
}

function normalizeBoundedText(value, field) {
  if (typeof value !== 'string') {
    throw new ControlServiceError('INVALID_PARAMS', `${field} must be a string`);
  }
  const text = value.trim();
  if (!text || text.length > DSH_CATALOG_ID_MAX_CHARS) {
    throw new ControlServiceError('INVALID_PARAMS', `${field} must be 1-${DSH_CATALOG_ID_MAX_CHARS} characters`);
  }
  return text;
}

function normalizeModelDefaults(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlServiceError('INVALID_MODEL_DEFAULTS', 'model defaults must be an object');
  }
  const provider = normalizeBoundedText(value.provider, 'provider');
  const model = normalizeBoundedText(value.model, 'model');
  const reasoningEffort = normalizeBoundedText(value.reasoningEffort, 'reasoningEffort');
  if (!CONTROL_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new ControlServiceError('INVALID_REASONING_EFFORT', 'reasoningEffort must be off, low, high, or max');
  }
  return { provider, model, reasoningEffort };
}

function normalizeModelCatalog(value = []) {
  const source = Array.isArray(value) ? value : value?.models;
  if (!Array.isArray(source)) {
    throw new ControlServiceError('INVALID_MODEL_CATALOG', 'model catalog is unavailable');
  }
  const seen = new Set();
  const models = [];
  for (const item of source.slice(0, 500)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let provider;
    let model;
    try {
      provider = normalizeBoundedText(item.provider, 'provider');
      model = normalizeBoundedText(item.model ?? item.id, 'model');
    } catch {
      continue;
    }
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, model, image: item.image === true });
  }
  return models;
}

function normalizePresetList(value = []) {
  const source = Array.isArray(value) ? value : value?.presets;
  if (!Array.isArray(source)) {
    throw new ControlServiceError('INVALID_PRESET_LIST', 'preset list is unavailable');
  }
  const seen = new Set();
  const presets = [];
  for (const item of source.slice(0, 500)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let id;
    try { id = normalizeBoundedText(item.id, 'preset id'); } catch { continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const trust = typeof item.trust === 'string' || typeof item.trust === 'number' || typeof item.trust === 'boolean'
      ? item.trust
      : 'unknown';
    presets.push({ id, trust });
  }
  return presets;
}

function normalizePresetBindings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlServiceError('INVALID_PRESET_BINDINGS', 'preset bindings are unavailable');
  }
  const source = value.bindings && typeof value.bindings === 'object' && !Array.isArray(value.bindings)
    ? value.bindings
    : value;
  const bindings = {};
  for (const target of PRESET_BINDING_TARGETS) {
    const raw = source[target];
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
      bindings[target] = null;
      continue;
    }
    bindings[target] = normalizeBoundedText(raw, `${target} presetId`);
  }
  return bindings;
}

function normalizePendingText(value, field, max = 2000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ControlServiceError('INVALID_PENDING', `${field} must be text`);
  }
  const text = String(value).trim();
  if (text.length > max) {
    throw new ControlServiceError('INVALID_PENDING', `${field} is too long`);
  }
  return text;
}

function normalizePending(value = []) {
  const source = Array.isArray(value) ? value : value?.pending;
  if (!Array.isArray(source)) {
    throw new ControlServiceError('INVALID_PENDING', 'pending list is unavailable');
  }
  const pending = [];
  for (const item of source.slice(0, 100)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = item.kind;
    if (!['question', 'approval', 'card-approval'].includes(kind)) continue;
    const projected = { kind };
    if (item.key !== undefined) projected.key = normalizePendingText(item.key, 'key', 256);
    if (item.id !== undefined) projected.id = normalizePendingText(item.id, 'id', 128);
    if (item.sessionId !== undefined) projected.sessionId = normalizePendingText(item.sessionId, 'sessionId', 256);
    if (kind === 'approval') {
      projected.toolName = normalizePendingText(item.toolName, 'toolName', 256);
      projected.reason = normalizePendingText(item.reason, 'reason', 2000);
      projected.eventId = normalizePendingText(item.eventId, 'eventId', 256);
    } else if (kind === 'question') {
      const questions = Array.isArray(item.questions) ? item.questions.slice(0, 20) : [];
      projected.questions = [];
      for (const question of questions) {
        if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
        try {
          const result = {
            id: normalizePendingText(question.id, 'question.id', 128),
            question: normalizePendingText(question.question, 'question.question', 2000)
          };
          if (Array.isArray(question.options)) {
            result.options = question.options.slice(0, 20).map((option) => {
              try {
                return { label: normalizePendingText(option?.label, 'question.option.label', 256) };
              } catch {
                return null;
              }
            }).filter((option) => option?.label);
          }
          projected.questions.push(result);
        } catch {
          // One malformed DSH question must not hide the rest of the safe pending list.
        }
      }
    } else {
      for (const field of ['status', 'cardTitle', 'buttonLabel', 'action', 'riskLevel', 'decisionSource', 'error']) {
        if (item[field] !== undefined) projected[field] = normalizePendingText(item[field], field, 2000);
      }
      if (Array.isArray(item.riskReasons)) {
        projected.riskReasons = item.riskReasons.slice(0, 6).map((reason) => {
          try { return normalizePendingText(reason, 'riskReasons', 256); } catch { return ''; }
        }).filter(Boolean);
      }
      for (const field of ['createdAt', 'expiresAt', 'resolvedAt']) {
        if (Number.isFinite(Number(item[field]))) projected[field] = Number(item[field]);
      }
    }
    pending.push(projected);
  }
  return pending;
}

function rejectUnknownFields(body, accepted, method) {
  const unknown = Object.keys(body).filter((key) => !accepted.includes(key));
  if (unknown.length) {
    throw new ControlServiceError('INVALID_PARAMS', `${method} 包含不支持的字段`);
  }
}

function normalizeServiceName(value) {
  if (!CONTROL_SERVICES.includes(value)) {
    throw new ControlServiceError('INVALID_SERVICE', 'service 必须是 snowluma 或 dsh');
  }
  return value;
}

function normalizeTailLimit(value) {
  const limit = value === undefined ? 100 : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ControlServiceError('INVALID_LOG_LIMIT', 'limit 必须是 1 到 500 之间的整数');
  }
  return limit;
}

function normalizeLogLines(value, limit, redactLogLine) {
  if (!Array.isArray(value)) return [];
  let remaining = CONTROL_LOG_MAX_RETURN_CHARS;
  const tail = [];
  for (const line of value.slice(-limit).reverse()) {
    let safeLine = String(redactLogLine(String(line)) ?? '');
    if (!safeLine) continue;
    if (tail.length) remaining -= 1; // Account for the newline between returned lines.
    if (remaining <= 0) break;
    if (safeLine.length > remaining) {
      let start = safeLine.length - remaining;
      // Keep valid UTF-16 when the cutoff falls between a surrogate pair.
      const code = safeLine.charCodeAt(start);
      if (code >= 0xDC00 && code <= 0xDFFF) start += 1;
      safeLine = safeLine.slice(start);
    }
    if (safeLine) {
      tail.push(safeLine);
      remaining -= safeLine.length;
    }
  }
  return tail.reverse();
}

function normalizePolicyId(value, field) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ControlServiceError('INVALID_POLICY_ID', `${field} 必须是正整数 QQ 号`);
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new ControlServiceError('INVALID_POLICY_ID', `${field} 必须是正整数 QQ 号`);
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ControlServiceError('INVALID_POLICY_ID', `${field} 必须是有效的正整数 QQ 号`);
  }
  return id;
}

function normalizePolicyIdList(value, field) {
  if (!Array.isArray(value)) {
    throw new ControlServiceError('INVALID_POLICY_LIST', `${field} 必须是 QQ 号数组`);
  }
  return [...new Set(value.map((id, index) => normalizePolicyId(id, `${field}[${index}]`)))];
}

function normalizePolicyListPatch(value, field, current) {
  if (value === undefined) return current;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlServiceError('INVALID_POLICY_LIST', `${field} 必须是 { private, groups } 对象`);
  }
  const unknown = Object.keys(value).filter((key) => !['private', 'groups'].includes(key));
  if (unknown.length) {
    throw new ControlServiceError('INVALID_POLICY_LIST', `${field} 包含不支持的字段`);
  }
  return {
    private: value.private === undefined
      ? [...(current?.private ?? [])]
      : normalizePolicyIdList(value.private, `${field}.private`),
    groups: value.groups === undefined
      ? [...(current?.groups ?? [])]
      : normalizePolicyIdList(value.groups, `${field}.groups`)
  };
}

function normalizePolicySnapshot(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (source.mode !== undefined) source.mode = migrateLegacyMode(source.mode);
  if (source.mode !== undefined && !CONTROL_MODES.includes(source.mode)) {
    throw new ControlServiceError('INVALID_MODE', `mode 必须是 ${MODE_LIST_TEXT}（旧值 reserved→chat、reserved2→social 自动迁移）`);
  }
  const normalizeList = (list, field) => {
    if (list === undefined) return [];
    return normalizePolicyIdList(list, field);
  };
  const normalizeKinds = (kind, field) => {
    if (kind === undefined) return { private: [], groups: [] };
    if (!kind || typeof kind !== 'object' || Array.isArray(kind)) {
      throw new ControlServiceError('INVALID_POLICY_LIST', `${field} 必须是 { private, groups } 对象`);
    }
    return {
      private: normalizeList(kind.private, `${field}.private`),
      groups: normalizeList(kind.groups, `${field}.groups`)
    };
  };
  return {
    mode: source.mode ?? 'chat',
    allow: normalizeKinds(source.allow, 'allow'),
    deny: normalizeKinds(source.deny, 'deny'),
    ownerQQ: source.ownerQQ === undefined || source.ownerQQ === null || (typeof source.ownerQQ === 'string' && !source.ownerQQ.trim())
      ? null
      : normalizePolicyId(source.ownerQQ, 'ownerQQ')
  };
}

/** A transport-neutral control failure. Adapters map the stable code to HTTP/IPC responses. */
export class ControlServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlServiceError';
    this.code = code;
  }
}

/**
 * Build business operations from narrow ports. Request parsing, transport status codes, and
 * credential resolution stay in their adapters; `actor` must be created from trusted auth data.
 */
export function createControlService({
  listRoles,
  roleExists,
  roleFileExists,
  createRoleFile,
  sanitizeRoleName,
  readRoleState,
  writeRoleState,
  readRuntimeSecurity,
  readPersistedSecurity,
  writePersistedSecurity,
  writeRuntimeSecurity,
  readRuntimePolicy,
  readPersistedPolicy,
  writePersistedPolicy,
  writeRuntimePolicy,
  readRuntimeSlangConfig,
  readPersistedSlangConfig,
  writePersistedSlangConfig,
  writeRuntimeSlangConfig,
  invalidateSlangLearnerSession,
  readSessions,
  readActivityTail,
  readLogTail,
  redactLogLine,
  readOwnerQQ,
  ensureSocialState,
  readSocialTimingConfig,
  runDiagnostics,
  now,
  randInt,
  cancelSocialTimers,
  deleteSocialState,
  deleteSilentContext,
  readLocalServices,
  detectLocalServices,
  selectLocalService,
  installLocalSnowLuma,
  startLocalService,
  stopLocalService,
  connectSnowLuma,
  log,
  readModelDefaults = () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }),
  readModelCatalog = () => [],
  writeModelDefaults = () => { throw new ControlServiceError('MODEL_UNAVAILABLE', 'model defaults are unavailable'); },
  readPresetList = () => [],
  readPresetBindings = () => ({ chat: null, closedAgent: null, social: null, workshop: null, learner: null }),
  writePresetBinding = () => { throw new ControlServiceError('PRESET_UNAVAILABLE', 'preset bindings are unavailable'); },
  readPending = () => [],
  decidePending = () => { throw new ControlServiceError('PENDING_UNAVAILABLE', 'pending approvals are unavailable'); }
}) {
  if (typeof listRoles !== 'function') throw new TypeError('listRoles must be a function');
  if (typeof roleExists !== 'function') throw new TypeError('roleExists must be a function');
  if (typeof roleFileExists !== 'function') throw new TypeError('roleFileExists must be a function');
  if (typeof createRoleFile !== 'function') throw new TypeError('createRoleFile must be a function');
  if (typeof sanitizeRoleName !== 'function') throw new TypeError('sanitizeRoleName must be a function');
  if (typeof readRoleState !== 'function') throw new TypeError('readRoleState must be a function');
  if (typeof writeRoleState !== 'function') throw new TypeError('writeRoleState must be a function');
  if (typeof readRuntimeSecurity !== 'function') throw new TypeError('readRuntimeSecurity must be a function');
  if (typeof readPersistedSecurity !== 'function') throw new TypeError('readPersistedSecurity must be a function');
  if (typeof writePersistedSecurity !== 'function') throw new TypeError('writePersistedSecurity must be a function');
  if (typeof writeRuntimeSecurity !== 'function') throw new TypeError('writeRuntimeSecurity must be a function');
  if (typeof readRuntimePolicy !== 'function') throw new TypeError('readRuntimePolicy must be a function');
  if (typeof readPersistedPolicy !== 'function') throw new TypeError('readPersistedPolicy must be a function');
  if (typeof writePersistedPolicy !== 'function') throw new TypeError('writePersistedPolicy must be a function');
  if (typeof writeRuntimePolicy !== 'function') throw new TypeError('writeRuntimePolicy must be a function');
  if (typeof readRuntimeSlangConfig !== 'function') throw new TypeError('readRuntimeSlangConfig must be a function');
  if (typeof readPersistedSlangConfig !== 'function') throw new TypeError('readPersistedSlangConfig must be a function');
  if (typeof writePersistedSlangConfig !== 'function') throw new TypeError('writePersistedSlangConfig must be a function');
  if (typeof writeRuntimeSlangConfig !== 'function') throw new TypeError('writeRuntimeSlangConfig must be a function');
  if (typeof invalidateSlangLearnerSession !== 'function') throw new TypeError('invalidateSlangLearnerSession must be a function');
  if (typeof readSessions !== 'function') throw new TypeError('readSessions must be a function');
  if (typeof readActivityTail !== 'function') throw new TypeError('readActivityTail must be a function');
  if (typeof readLogTail !== 'function') throw new TypeError('readLogTail must be a function');
  if (typeof redactLogLine !== 'function') throw new TypeError('redactLogLine must be a function');
  if (typeof readOwnerQQ !== 'function') throw new TypeError('readOwnerQQ must be a function');
  if (typeof ensureSocialState !== 'function') throw new TypeError('ensureSocialState must be a function');
  if (typeof readSocialTimingConfig !== 'function') throw new TypeError('readSocialTimingConfig must be a function');
  if (typeof runDiagnostics !== 'function') throw new TypeError('runDiagnostics must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof randInt !== 'function') throw new TypeError('randInt must be a function');
  if (typeof cancelSocialTimers !== 'function') throw new TypeError('cancelSocialTimers must be a function');
  if (typeof deleteSocialState !== 'function') throw new TypeError('deleteSocialState must be a function');
  if (typeof deleteSilentContext !== 'function') throw new TypeError('deleteSilentContext must be a function');
  if (typeof readLocalServices !== 'function') throw new TypeError('readLocalServices must be a function');
  if (typeof detectLocalServices !== 'function') throw new TypeError('detectLocalServices must be a function');
  if (typeof selectLocalService !== 'function') throw new TypeError('selectLocalService must be a function');
  if (typeof installLocalSnowLuma !== 'function') throw new TypeError('installLocalSnowLuma must be a function');
  if (typeof startLocalService !== 'function') throw new TypeError('startLocalService must be a function');
  if (typeof stopLocalService !== 'function') throw new TypeError('stopLocalService must be a function');
  if (typeof connectSnowLuma !== 'function') throw new TypeError('connectSnowLuma must be a function');
  if (typeof log !== 'function') throw new TypeError('log must be a function');
  if (typeof readModelDefaults !== 'function') throw new TypeError('readModelDefaults must be a function');
  if (typeof readModelCatalog !== 'function') throw new TypeError('readModelCatalog must be a function');
  if (typeof writeModelDefaults !== 'function') throw new TypeError('writeModelDefaults must be a function');
  if (typeof readPresetList !== 'function') throw new TypeError('readPresetList must be a function');
  if (typeof readPresetBindings !== 'function') throw new TypeError('readPresetBindings must be a function');
  if (typeof writePresetBinding !== 'function') throw new TypeError('writePresetBinding must be a function');
  if (typeof readPending !== 'function') throw new TypeError('readPending must be a function');
  if (typeof decidePending !== 'function') throw new TypeError('decidePending must be a function');

  function scheduleServiceTask(label, task) {
    setImmediate(() => {
      Promise.resolve()
        .then(task)
        .catch((error) => log(`本地服务${label}失败：${error?.message ?? error}`));
    });
  }

  function readServiceSnapshot(service) {
    const services = readLocalServices() ?? {};
    const project = (snapshot) => {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
      const result = {};
      for (const key of ['status', 'installed', 'running', 'ready', 'managed', 'version', 'selectedId']) {
        if (snapshot[key] !== undefined) result[key] = snapshot[key];
      }
      if (snapshot.lastError !== undefined) {
        result.lastError = String(redactLogLine(String(snapshot.lastError)) ?? '');
      }
      if (Array.isArray(snapshot.installations)) {
        result.installations = snapshot.installations.slice(0, 100).map((installation) => {
          const safe = {};
          if (!installation || typeof installation !== 'object' || Array.isArray(installation)) return safe;
          for (const key of ['id', 'name', 'version', 'status', 'valid', 'source']) {
            if (installation[key] !== undefined) safe[key] = installation[key];
          }
          return safe;
        });
      }
      return result;
    };
    if (service !== undefined) return project(services[service]);
    return {
      snowluma: project(services.snowluma),
      dsh: project(services.dsh)
    };
  }

  return Object.freeze({
    execute(request = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new ControlServiceError('INVALID_PARAMS', '控制命令请求必须是 JSON 对象');
      }
      const { method, params, actor } = request;
      // This dispatcher is the privileged management surface. Agent/MCP data capabilities
      // will use a separate adapter/service rather than being routed through here.
      if (actor?.privilege !== PRIVILEGE_CONSOLE) {
        throw new ControlServiceError('FORBIDDEN', '该操作仅控制台管理权限可用');
      }
      if (!Object.values(CONTROL_METHODS).includes(method)) {
        throw new ControlServiceError('METHOD_NOT_FOUND', `未知控制命令：${String(method ?? '')}`);
      }
      const body = params ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new ControlServiceError('INVALID_PARAMS', '参数必须是 JSON 对象');
      }

      if (method === CONTROL_METHODS.LIST_ROLES) {
        const current = readRoleState() ?? {};
        return { roles: listRoles(), current: current.role ?? null };
      }
      if (method === CONTROL_METHODS.LIST_SESSIONS) {
        const ownerKey = `private:${String(readOwnerQQ() ?? '')}`;
        const sessions = [];
        for (const [key, sessionId] of Object.entries(readSessions())) {
          sessions.push({ key, sessionId, owner: key === ownerKey });
        }
        return { sessions };
      }
      if (method === CONTROL_METHODS.LIST_ACTIVITY) {
        const unknown = Object.keys(body).filter((key) => key !== 'limit');
        if (unknown.length) {
          throw new ControlServiceError('INVALID_ACTIVITY_FIELD', 'activity.list 只接受 limit 参数');
        }
        const limit = normalizeTailLimit(body.limit);
        return { entries: normalizeLogLines(readActivityTail(limit), limit, redactLogLine) };
      }
      if (method === CONTROL_METHODS.READ_LOGS) {
        const unknown = Object.keys(body).filter((key) => !['source', 'limit'].includes(key));
        if (unknown.length) {
          throw new ControlServiceError('INVALID_LOG_FIELD', 'logs.read 只接受 source 与 limit 参数');
        }
        const source = body.source;
        if (!CONTROL_LOG_SOURCES.includes(source)) {
          throw new ControlServiceError('INVALID_LOG_SOURCE', 'source 必须是 bridge / worker / desktop');
        }
        const limit = normalizeTailLimit(body.limit);
        return { source, lines: normalizeLogLines(readLogTail(source, limit), limit, redactLogLine) };
      }
      if (method === CONTROL_METHODS.GET_SERVICES) {
        rejectUnknownFields(body, [], method);
        return { services: readServiceSnapshot() };
      }
      if (method === CONTROL_METHODS.DETECT_SERVICES) {
        rejectUnknownFields(body, [], method);
        scheduleServiceTask('强制检测', () => detectLocalServices({ force: true }));
        return { services: readServiceSnapshot() };
      }
      if (method === CONTROL_METHODS.SELECT_SERVICE) {
        rejectUnknownFields(body, ['service', 'id'], method);
        const service = normalizeServiceName(body.service);
        if (typeof body.id !== 'string' || !body.id.trim() || body.id.length > 128) {
          throw new ControlServiceError('INVALID_INSTALLATION_ID', 'id 必须是有效的已检测安装 ID');
        }
        const installation = readServiceSnapshot(service)?.installations?.find((item) => item?.id === body.id && item.valid === true);
        if (!installation) {
          throw new ControlServiceError('INVALID_INSTALLATION_ID', '只能选择已检测且有效的安装版本');
        }
        scheduleServiceTask(`${service} 版本选择`, () => selectLocalService(service, body.id));
        return { service: readServiceSnapshot(service) };
      }
      if (method === CONTROL_METHODS.INSTALL_SNOWLUMA) {
        rejectUnknownFields(body, [], method);
        scheduleServiceTask('SnowLuma 安装', () => installLocalSnowLuma());
        return { service: readServiceSnapshot('snowluma') };
      }
      if (method === CONTROL_METHODS.START_SERVICE || method === CONTROL_METHODS.STOP_SERVICE) {
        rejectUnknownFields(body, ['service'], method);
        const service = normalizeServiceName(body.service);
        if (method === CONTROL_METHODS.START_SERVICE) {
          scheduleServiceTask(`${service} 启动`, async () => {
            const snapshot = await startLocalService(service);
            if (service === 'snowluma' && snapshot?.ready) {
              const connected = await connectSnowLuma();
              if (!connected?.ok) {
                log(`SnowLuma 已就绪，但 WhaleBridge 连接未完成：${connected?.error ?? '未知错误'}`);
              }
            }
          });
        } else {
          scheduleServiceTask(`${service} 停止`, () => stopLocalService(service));
        }
        return { service: readServiceSnapshot(service) };
      }
      if (method === CONTROL_METHODS.GET_MODEL_DEFAULTS) {
        rejectUnknownFields(body, [], method);
        return mapMaybe(readModelDefaults(), (value) => ({ defaults: normalizeModelDefaults(value) }));
      }
      if (method === CONTROL_METHODS.LIST_MODEL_CATALOG) {
        rejectUnknownFields(body, [], method);
        return mapMaybe(readModelCatalog(), (value) => ({ models: normalizeModelCatalog(value) }));
      }
      if (method === CONTROL_METHODS.UPDATE_MODEL_DEFAULTS) {
        rejectUnknownFields(body, ['provider', 'model', 'reasoningEffort'], method);
        return Promise.resolve().then(() => {
          const next = normalizeModelDefaults(body);
          return mapMaybe(readModelCatalog(), (catalogValue) => {
            const catalog = normalizeModelCatalog(catalogValue);
            if (!catalog.some((entry) => entry.provider === next.provider && entry.model === next.model)) {
              throw new ControlServiceError('INVALID_MODEL', 'provider/model must be present in the DSH model catalog');
            }
            return mapMaybe(writeModelDefaults(next), (written) => ({
              ok: true,
              defaults: normalizeModelDefaults(written ?? next)
            }));
          });
        });
      }
      if (method === CONTROL_METHODS.LIST_PRESETS) {
        rejectUnknownFields(body, [], method);
        return mapMaybe(readPresetList(), (value) => ({ presets: normalizePresetList(value) }));
      }
      if (method === CONTROL_METHODS.GET_PRESET_BINDINGS) {
        rejectUnknownFields(body, [], method);
        return mapMaybe(readPresetBindings(), (value) => ({ bindings: normalizePresetBindings(value) }));
      }
      if (method === CONTROL_METHODS.UPDATE_PRESET_BINDINGS) {
        rejectUnknownFields(body, ['target', 'presetId'], method);
        return Promise.resolve().then(() => {
          if (typeof body.target !== 'string' || !PRESET_BINDING_TARGETS.includes(body.target)) {
            throw new ControlServiceError('INVALID_PRESET_TARGET', 'target must be chat, closedAgent, social, workshop, or learner');
          }
          if (body.presetId !== null && body.presetId !== undefined && typeof body.presetId !== 'string') {
            throw new ControlServiceError('INVALID_PRESET', 'presetId must be a string or empty');
          }
          const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : '';
          if (presetId.length > DSH_CATALOG_ID_MAX_CHARS) {
            throw new ControlServiceError('INVALID_PRESET', `presetId must be at most ${DSH_CATALOG_ID_MAX_CHARS} characters`);
          }
          const save = (id, presetsValue) => {
            const presets = normalizePresetList(presetsValue);
            if (id && !presets.some((preset) => preset.id === id)) {
              throw new ControlServiceError('INVALID_PRESET', 'presetId must be present in the DSH preset catalog');
            }
            return mapMaybe(writePresetBinding(body.target, id || null), (written) => {
              const next = written === undefined ? readPresetBindings() : written;
              return mapMaybe(next, (value) => ({
                ok: true,
                bindings: normalizePresetBindings(value)
              }));
            });
          };
          return presetId
            ? mapMaybe(readPresetList(), (value) => save(presetId, value))
            : save('', []);
        });
      }
      if (method === CONTROL_METHODS.LIST_PENDING) {
        rejectUnknownFields(body, [], method);
        return mapMaybe(readPending(), (value) => ({ pending: normalizePending(value) }));
      }
      if (method === CONTROL_METHODS.DECIDE_PENDING) {
        rejectUnknownFields(body, ['kind', 'key', 'id', 'decision', 'answer'], method);
        return Promise.resolve().then(() => {
          const kind = body.kind;
          if (!['question', 'approval', 'card-approval'].includes(kind)) {
            throw new ControlServiceError('INVALID_PENDING', 'kind must be question, approval, or card-approval');
          }
          const request = { kind };
          if (body.key !== undefined) request.key = normalizePendingText(body.key, 'key', 256);
          if (body.id !== undefined) request.id = normalizePendingText(body.id, 'id', 128);
          if (kind === 'question') {
            request.answer = normalizePendingText(body.answer, 'answer', 2000);
            if (!request.answer) throw new ControlServiceError('INVALID_PENDING', 'answer must not be empty');
          } else {
            if (!['approve', 'reject'].includes(body.decision)) {
              throw new ControlServiceError('INVALID_PENDING_DECISION', 'decision must be approve or reject');
            }
            request.decision = body.decision;
          }
          if (kind === 'card-approval' && !request.id) {
            throw new ControlServiceError('INVALID_PENDING', 'card-approval requires id');
          }
          if (kind !== 'card-approval' && !request.key) {
            throw new ControlServiceError('INVALID_PENDING', 'question/approval requires key');
          }
          return mapMaybe(decidePending(request), (result) => {
            if (result && typeof result === 'object' && result.ok === false) {
              throw new ControlServiceError('PENDING_DECISION_FAILED', String(result.error ?? 'pending decision failed'));
            }
            return { ok: true };
          });
        });
      }
      if (method === CONTROL_METHODS.SET_SOCIAL_PHASE) {
        const key = String(body.key ?? '').trim();
        if (!key) throw new ControlServiceError('INVALID_SESSION_KEY', 'key 不能为空');
        const phase = body.phase;
        if (phase !== 'active' && phase !== 'idle') {
          throw new ControlServiceError('INVALID_PHASE', 'phase 必须是 active 或 idle');
        }

        if (phase === 'active') {
          const currentTime = now();
          const state = ensureSocialState(key);
          const config = readSocialTimingConfig() ?? {};
          state.phase = 'active';
          state.lastCheckAt = currentTime;
          state.nextCheckAt = currentTime + randInt(
            Number(config.activeCheckMinMs ?? 20000),
            Number(config.activeCheckMaxMs ?? 40000)
          );
          state.lastActiveMessageAt = currentTime;
          state.activeEnteredAt = currentTime;
          state.probeDeadline = 0;
          if (key.startsWith('group:') && config.activeDurationEnabled !== false) {
            state.activeDeadlineAt = currentTime + randInt(
              Number(config.activeDurationMinMs ?? 15 * 60 * 1000),
              Number(config.activeDurationMaxMs ?? 30 * 60 * 1000)
            );
          } else {
            state.activeDeadlineAt = 0;
          }
          state.activeExitAt = 0;
          log(`控制台：手动将 ${key} 设为活跃`);
        } else {
          cancelSocialTimers(key);
          deleteSocialState(key);
          deleteSilentContext(key);
          log(`控制台：手动将 ${key} 设为观望`);
        }
        return { ok: true, key, phase };
      }
      if (method === CONTROL_METHODS.RUN_DIAGNOSTICS) {
        const requested = body.checks ?? DIAGNOSTIC_CHECKS;
        if (!Array.isArray(requested) || requested.some((check) => !DIAGNOSTIC_CHECKS.includes(check))) {
          throw new ControlServiceError('INVALID_DIAGNOSTIC_CHECK', 'diagnostics.run 只接受白名单诊断项');
        }
        return { checks: runDiagnostics([...new Set(requested)]) };
      }
      if (method === CONTROL_METHODS.GET_SECURITY) {
        return { security: readRuntimeSecurity() ?? { interceptNotify: true } };
      }
      if (method === CONTROL_METHODS.GET_POLICY) {
        return { policy: normalizePolicySnapshot(readRuntimePolicy() ?? readPersistedPolicy() ?? {}) };
      }
      if (method === CONTROL_METHODS.UPDATE_POLICY) {
        const unknown = Object.keys(body).filter((key) => !['mode', 'allow', 'deny', 'ownerQQ'].includes(key));
        if (unknown.length) {
          throw new ControlServiceError('INVALID_POLICY_FIELD', 'policy.update 包含不支持的字段');
        }

        const persisted = normalizePolicySnapshot(readPersistedPolicy() ?? {});
        const runtime = normalizePolicySnapshot(readRuntimePolicy() ?? persisted);
        const next = {
          // A whitelist-only patch must keep the effective mode; DSH may have changed it
          // without a matching local mode.json update.
          mode: body.mode === undefined ? runtime.mode : migrateLegacyMode(body.mode),
          allow: normalizePolicyListPatch(body.allow, 'allow', persisted.allow),
          deny: normalizePolicyListPatch(body.deny, 'deny', persisted.deny),
          ownerQQ: body.ownerQQ === undefined
            ? persisted.ownerQQ
            : (body.ownerQQ === null || (typeof body.ownerQQ === 'string' && !body.ownerQQ.trim())
              ? null
              : normalizePolicyId(body.ownerQQ, 'ownerQQ'))
        };
        if (!CONTROL_MODES.includes(next.mode)) {
          throw new ControlServiceError('INVALID_MODE', `mode 必须是 ${MODE_LIST_TEXT}（旧值 reserved→chat、reserved2→social 自动迁移）`);
        }

        // The adapter owns persistence/runtime application details (including mode-transition
        // side effects). Durable state is written first so failed persistence never changes the live policy.
        writePersistedPolicy(next, { modeProvided: body.mode !== undefined });
        const effective = writeRuntimePolicy({ ...runtime, ...next }) ?? next;
        const policy = normalizePolicySnapshot(effective);
        log(`控制台：全局策略已更新（mode=${policy.mode}，群白名单=${policy.allow.groups.length}，私聊白名单=${policy.allow.private.length}，管理员=${policy.ownerQQ ?? '未设置'}）`);
        return { ok: true, policy };
      }
      if (method === CONTROL_METHODS.GET_SLANG_CONFIG) {
        return { config: readRuntimeSlangConfig() ?? {} };
      }
      if (method === CONTROL_METHODS.UPDATE_SECURITY) {
        const persisted = readPersistedSecurity() ?? {};
        const next = { ...persisted, ...body };
        if (typeof next.interceptNotify !== 'boolean' && next.interceptNotify !== undefined) {
          next.interceptNotify = Boolean(next.interceptNotify);
        }
        // Keep the original order: durable config first, then current-process behavior/logging.
        writePersistedSecurity(next);
        const runtime = {
          ...(readRuntimeSecurity() ?? {}),
          ...next
        };
        const security = writeRuntimeSecurity(runtime) ?? runtime;
        log(`控制台：安全拦截通知已更新（interceptNotify=${security.interceptNotify}）`);
        return { ok: true, security };
      }
      if (method === CONTROL_METHODS.UPDATE_SLANG_CONFIG) {
        const oldRuntime = readRuntimeSlangConfig() ?? {};
        const oldPreset = oldRuntime.learnerPreset;
        const oldWorkspaceTitle = oldRuntime.workspaceTitle;
        const persisted = readPersistedSlangConfig() ?? {};
        const merged = { ...persisted, ...body };
        if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
        else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
        if (merged.extractMinMessages !== undefined) {
          merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
        }
        if (merged.extractCooldownMs !== undefined) {
          merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
        }
        if (merged.injectMax !== undefined) {
          merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
        }
        if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
        if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
        if (merged.workspaceTitle !== undefined) {
          merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
        }
        if (body.inferenceThresholds !== undefined) {
          const raw = Array.isArray(body.inferenceThresholds)
            ? body.inferenceThresholds
            : String(body.inferenceThresholds).split(/[,，\s]+/);
          merged.inferenceThresholds = [...new Set(
            raw.map((n) => Math.max(1, Math.round(Number(n) || 1)))
          )].sort((a, b) => a - b);
          if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
        }

        // Persist first, then update runtime config and invalidate at most one learner session.
        writePersistedSlangConfig(merged);
        const runtime = {
          ...(readRuntimeSlangConfig() ?? {}),
          ...merged
        };
        const config = writeRuntimeSlangConfig(runtime) ?? runtime;
        if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
          invalidateSlangLearnerSession();
          log('黑话学习 preset 已变更，已重置学习会话');
        } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
          invalidateSlangLearnerSession();
          log('黑话学习标题已变更，已重置学习会话');
        }
        log('控制台：黑话系统配置已更新');
        return { ok: true, config };
      }
      if (method === CONTROL_METHODS.SET_ROLE) {
        const current = readRoleState() ?? {};
        if (body.role && typeof body.role === 'string') {
          const name = sanitizeRoleName(body.role);
          if (!roleExists(name)) {
            throw new ControlServiceError('INVALID_ROLE', `角色「${name}」不存在（roles/${name}.md）`);
          }
          writeRoleState(name, current.mode);
          log(`控制台：角色已设置为 ${name}`);
          return { ok: true, role: name };
        }
        writeRoleState(null, current.mode);
        log('控制台：角色已清除');
        return { ok: true, role: null };
      }
      if (method === CONTROL_METHODS.CREATE_ROLE) {
        const name = sanitizeRoleName(body.name);
        const content = String(body.content ?? '').trim();
        if (!name) {
          throw new ControlServiceError('INVALID_ROLE_NAME', '角色名不能为空（仅限中文/字母/数字/横线）');
        }
        if (!content) {
          throw new ControlServiceError('INVALID_ROLE_CONTENT', '角色内容不能为空');
        }
        if (name === 'README') {
          throw new ControlServiceError('RESERVED_ROLE_NAME', '该名称被保留');
        }
        if (roleFileExists(name)) {
          throw new ControlServiceError('ROLE_EXISTS', `角色「${name}」已存在`);
        }
        createRoleFile(name, content + (content.endsWith('\n') ? '' : '\n'));
        log(`控制台：创建人格「${name}」`);
        return { ok: true, role: name };
      }
      if (method !== CONTROL_METHODS.SET_ROLE_MODE) {
        throw new ControlServiceError('METHOD_NOT_FOUND', `未知控制命令：${String(method ?? '')}`);
      }

      // Preserve the accepted /api/role-mode behavior: only the exact value "silent"
      // enables silent mode; any other or missing value selects "active".
      const current = readRoleState() ?? {};
      const mode = body.mode === 'silent' ? 'silent' : 'active';
      writeRoleState(current.role, mode);
      log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
      return { ok: true, roleMode: mode };
    }
  });
}
