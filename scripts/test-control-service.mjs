import assert from 'node:assert/strict';
import {
  CONTROL_METHODS,
  ControlServiceError,
  createControlService
} from '../src/control/control-service.js';
import { PRIVILEGE_AGENT, PRIVILEGE_CONSOLE, agentPrivilegeAllows } from '../src/bridge-privilege.js';

function fixture(
  initialRoleState = { role: 'helper', mode: 'active' },
  securityState = {},
  slangState = {},
  sessionState = {},
  socialTimingConfig = {},
  policyState = {},
  logState = {},
  localServiceState = {},
  modelState = {},
  pendingState = {}
) {
  let state = { ...initialRoleState };
  let persistedSecurity = { ...(securityState.persisted ?? { interceptNotify: true }) };
  let runtimeSecurity = securityState.runtime === null
    ? null
    : { ...(securityState.runtime ?? { interceptNotify: true }) };
  let persistedSlang = { ...(slangState.persisted ?? {}) };
  let runtimeSlang = slangState.runtime === null ? null : { ...(slangState.runtime ?? {}) };
  let persistedPolicy = structuredClone(policyState.persisted ?? {
    mode: 'chat',
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    ownerQQ: null
  });
  let runtimePolicy = policyState.runtime === null
    ? null
    : structuredClone(policyState.runtime ?? persistedPolicy);
  const writes = [];
  const logs = [];
  const roleFiles = [];
  const securityWrites = [];
  const slangInvalidations = [];
  const socialStates = new Map();
  const socialTimers = new Map();
  const socialContexts = new Map();
  const socialCalls = [];
  const socialRandomRanges = [];
  const diagnosticCalls = [];
  const policyWrites = [];
  const policyWriteOptions = [];
  const runtimePolicyWrites = [];
  const activityReads = [];
  const logReads = [];
  const activityLines = [...(logState.activity ?? ['activity-1', 'activity token=secret'])];
  const sourceLines = structuredClone(logState.sources ?? {
    bridge: ['bridge-1', 'bridge token=secret'],
    worker: ['worker-1'],
    desktop: ['desktop-1']
  });
  const availableRoles = ['helper', 'assistant'];
  const localServices = structuredClone(localServiceState.snapshot ?? {
    snowluma: { status: 'stopped', installations: [{ id: 'snow-1', valid: true }], selectedId: '' },
    dsh: { status: 'stopped', installations: [{ id: 'dsh-1', valid: true }], selectedId: '' }
  });
  const serviceCalls = [];
  let modelDefaults = structuredClone(modelState.defaults ?? {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'max'
  });
  let presetBindings = structuredClone(modelState.bindings ?? {
    chat: null,
    closedAgent: 'router-standard',
    social: 'whale-chat-v2',
    workshop: 'router-standard',
    learner: 'whale-chat'
  });
  const modelCatalog = structuredClone(modelState.catalog ?? [
    { provider: 'deepseek-official', model: 'deepseek-flash', image: true },
    { provider: 'deepseek-official', model: 'deepseek-chat', image: false }
  ]);
  const presets = structuredClone(modelState.presets ?? [
    { id: 'router-standard', trust: 'system' },
    { id: 'whale-chat', trust: 'project' },
    { id: 'whale-chat-v2', trust: 'project' }
  ]);
  const modelWrites = [];
  let pendingItems = structuredClone(pendingState.items ?? []);
  const pendingDecisions = [];
  const serviceAction = (name, value) => {
    serviceCalls.push({ name, value });
    if (localServiceState[`${name}Fails`]) throw new Error(`${name} failed`);
    if (name === 'select') {
      localServices[value.service].selectedId = value.id;
      return Promise.resolve(structuredClone(localServices[value.service]));
    }
    if (name === 'start') return Promise.resolve(structuredClone(localServiceState.startResult ?? { ready: value.service === 'snowluma' }));
    if (name === 'connect') return Promise.resolve(structuredClone(localServiceState.connectResult ?? { ok: true }));
    return Promise.resolve();
  };
  const service = createControlService({
    listRoles: () => [...availableRoles],
    roleExists: (name) => availableRoles.includes(name),
    roleFileExists: (name) => roleFiles.some((file) => file.name === name) || name === 'helper',
    createRoleFile: (name, content) => roleFiles.push({ name, content }),
    sanitizeRoleName: (name) => String(name).replace(/[^\w\u4e00-\u9fff-]/g, ''),
    readRoleState: () => ({ ...state }),
    writeRoleState: (role, mode) => {
      state = { role: role ?? null, mode: mode ?? 'active' };
      writes.push({ ...state });
    },
    readRuntimeSecurity: () => runtimeSecurity && { ...runtimeSecurity },
    readPersistedSecurity: () => ({ ...persistedSecurity }),
    writePersistedSecurity: (security) => {
      if (securityState.persistFails) throw new Error('persist failed');
      persistedSecurity = { ...security };
      securityWrites.push({ ...security });
    },
    writeRuntimeSecurity: (security) => {
      runtimeSecurity = { ...security };
      return { ...runtimeSecurity };
    },
    readRuntimePolicy: () => runtimePolicy && structuredClone(runtimePolicy),
    readPersistedPolicy: () => structuredClone(persistedPolicy),
    writePersistedPolicy: (policy, options) => {
      if (policyState.persistFails) throw new Error('policy persist failed');
      persistedPolicy = structuredClone(policy);
      policyWrites.push(structuredClone(policy));
      policyWriteOptions.push(structuredClone(options ?? {}));
    },
    writeRuntimePolicy: (policy) => {
      runtimePolicy = structuredClone(policy);
      runtimePolicyWrites.push(structuredClone(policy));
      return structuredClone(runtimePolicy);
    },
    readRuntimeSlangConfig: () => runtimeSlang && { ...runtimeSlang },
    readPersistedSlangConfig: () => ({ ...persistedSlang }),
    writePersistedSlangConfig: (config) => {
      if (slangState.persistFails) throw new Error('slang persist failed');
      persistedSlang = { ...config };
    },
    writeRuntimeSlangConfig: (config) => {
      runtimeSlang = { ...config };
      return { ...runtimeSlang };
    },
    invalidateSlangLearnerSession: () => slangInvalidations.push('invalidated'),
    readSessions: () => ({ ...sessionState.sessions }),
    readActivityTail: (limit) => {
      activityReads.push(limit);
      return activityLines.slice(-limit);
    },
    readLogTail: (source, limit) => {
      logReads.push({ source, limit });
      return (sourceLines[source] ?? []).slice(-limit);
    },
    redactLogLine: (line) => line.replaceAll('token=secret', 'token=***'),
    readOwnerQQ: () => sessionState.ownerQQ,
    ensureSocialState: (key) => {
      socialCalls.push({ operation: 'ensure', key });
      if (!socialStates.has(key)) {
        socialStates.set(key, {
          phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0,
          activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0,
          lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0
        });
      }
      return socialStates.get(key);
    },
    readSocialTimingConfig: () => ({ ...socialTimingConfig }),
    runDiagnostics: (checks) => {
      diagnosticCalls.push([...checks]);
      return Object.fromEntries(checks.map((check) => [check, { ok: true }]));
    },
    now: () => 1000,
    randInt: (min, max) => {
      socialRandomRanges.push([min, max]);
      return min;
    },
    cancelSocialTimers: (key) => {
      socialCalls.push({ operation: 'cancelTimers', key });
      socialTimers.delete(key);
    },
    deleteSocialState: (key) => {
      socialCalls.push({ operation: 'deleteState', key });
      socialStates.delete(key);
    },
    deleteSilentContext: (key) => {
      socialCalls.push({ operation: 'deleteContext', key });
      socialContexts.delete(key);
    },
    readLocalServices: () => structuredClone(localServices),
    detectLocalServices: (options) => serviceAction('detect', options),
    selectLocalService: (service, id) => serviceAction('select', { service, id }),
    installLocalSnowLuma: () => serviceAction('install'),
    startLocalService: (service) => serviceAction('start', { service }),
    stopLocalService: (service) => serviceAction('stop', { service }),
    connectSnowLuma: () => serviceAction('connect'),
    readModelDefaults: () => structuredClone(modelDefaults),
    readModelCatalog: () => structuredClone(modelCatalog),
    writeModelDefaults: (next) => {
      modelDefaults = structuredClone(next);
      modelWrites.push({ type: 'defaults', value: structuredClone(next) });
      return structuredClone(modelDefaults);
    },
    readPresetList: () => structuredClone(presets),
    readPresetBindings: () => structuredClone(presetBindings),
    writePresetBinding: (target, presetId) => {
      presetBindings[target] = presetId;
      modelWrites.push({ type: 'binding', target, presetId });
      return structuredClone(presetBindings);
    },
    readPending: () => ({ pending: structuredClone(pendingItems) }),
    decidePending: (request) => {
      pendingDecisions.push(structuredClone(request));
      pendingItems = pendingItems.filter((item) => {
        if (request.kind === 'card-approval') return item.id !== request.id;
        return !(item.kind === request.kind && item.key === request.key);
      });
      return { ok: true };
    },
    log: (message) => logs.push(message)
  });
  return {
    service,
    get state() { return state; },
    get persistedSecurity() { return { ...persistedSecurity }; },
    get runtimeSecurity() { return runtimeSecurity && { ...runtimeSecurity }; },
    get persistedSlang() { return { ...persistedSlang }; },
    get runtimeSlang() { return runtimeSlang && { ...runtimeSlang }; },
    get persistedPolicy() { return structuredClone(persistedPolicy); },
    get runtimePolicy() { return runtimePolicy && structuredClone(runtimePolicy); },
    writes,
    logs,
    roleFiles,
    securityWrites,
    slangInvalidations,
    socialStates,
    socialTimers,
    socialContexts,
    socialCalls,
    socialRandomRanges,
    diagnosticCalls,
    policyWrites,
    policyWriteOptions,
    runtimePolicyWrites,
    activityReads,
    logReads,
    serviceCalls,
    localServices,
    get modelDefaults() { return structuredClone(modelDefaults); },
    get presetBindings() { return structuredClone(presetBindings); },
    modelCatalog,
    presets,
    modelWrites,
    get pendingItems() { return structuredClone(pendingItems); },
    pendingDecisions
  };
}

const flushServiceTasks = () => new Promise((resolve) => setImmediate(resolve));

{
  const fx = fixture();
  assert.deepEqual(fx.service.execute({
    method: CONTROL_METHODS.LIST_ACTIVITY,
    params: { limit: 1 },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { entries: ['activity token=***'] });
  assert.deepEqual(fx.activityReads, [1]);
  assert.deepEqual(fx.service.execute({
    method: CONTROL_METHODS.READ_LOGS,
    params: { source: 'bridge', limit: 2 },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { source: 'bridge', lines: ['bridge-1', 'bridge token=***'] });
  assert.deepEqual(fx.logReads, [{ source: 'bridge', limit: 2 }]);
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {}, {}, {}, {}, {
    items: [
      {
        kind: 'question', key: 'private:123', sessionId: 'session-1',
        questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }]
      },
      { kind: 'approval', key: 'group:456', sessionId: 'session-2', toolName: 'web_search', reason: '需要联网', eventId: 'evt-1' },
      { kind: 'card-approval', id: 'card_123', key: 'group:456', status: 'pending', buttonLabel: '打开', riskReasons: ['外部跳转'], expiresAt: 123 }
    ]
  });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.LIST_PENDING,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { pending: fx.pendingItems });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.DECIDE_PENDING,
    params: { kind: 'question', key: 'private:123', answer: '是' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { ok: true });
  assert.deepEqual(fx.pendingDecisions[0], { kind: 'question', key: 'private:123', answer: '是' });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.DECIDE_PENDING,
    params: { kind: 'approval', key: 'group:456', decision: 'reject' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { ok: true });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.DECIDE_PENDING,
    params: { kind: 'card-approval', id: 'card_123', decision: 'approve' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { ok: true });
  for (const [params, code] of [
    [{ kind: 'question', key: 'private:123', answer: '' }, 'INVALID_PENDING'],
    [{ kind: 'approval', key: 'group:456', decision: 'maybe' }, 'INVALID_PENDING_DECISION'],
    [{ kind: 'card-approval', id: 'card_123', decision: 'reject', extra: true }, 'INVALID_PARAMS']
  ]) {
    await assert.rejects(Promise.resolve().then(() => fx.service.execute({
      method: CONTROL_METHODS.DECIDE_PENDING,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    })), (error) => error instanceof ControlServiceError && error.code === code);
  }
}

{
  const fx = fixture();
  const result = fx.service.execute({
    method: CONTROL_METHODS.GET_SERVICES,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { services: fx.localServices });
  assert.deepEqual(fx.service.execute({
    method: CONTROL_METHODS.DETECT_SERVICES,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { services: fx.localServices });
  assert.deepEqual(fx.serviceCalls, [], 'service detection must be queued after the immediate reply');
  await flushServiceTasks();
  assert.deepEqual(fx.serviceCalls, [{ name: 'detect', value: { force: true } }]);
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.GET_SERVICES,
    params: { path: 'C:\\arbitrary' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), (error) => error instanceof ControlServiceError && error.code === 'INVALID_PARAMS');
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.DETECT_SERVICES,
    params: { url: 'https://example.invalid' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), (error) => error instanceof ControlServiceError && error.code === 'INVALID_PARAMS');
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.GET_SERVICES,
    actor: { privilege: PRIVILEGE_AGENT }
  }), (error) => error instanceof ControlServiceError && error.code === 'FORBIDDEN');
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {}, {}, {
    snapshot: {
      snowluma: {
        status: 'failed', installed: true, running: false, ready: false, managed: false,
        version: '1.0', selectedId: 'snow-1', lastError: 'token=secret',
        process: { secret: 'do-not-return' }, launcherPath: 'C:\\private\\launcher.bat',
        logs: [{ text: 'token=secret' }],
        installations: [{
          id: 'snow-1', name: 'SnowLuma', version: '1.0', status: 'stopped', valid: true,
          source: 'configured', launcherPath: 'C:\\private\\launcher.bat', signature: { token: 'no' }
        }]
      },
      dsh: { status: 'not-installed', installations: [], process: { secret: 'do-not-return' }, credentials: 'C:\\private\\credentials' }
    }
  });
  const { services } = fx.service.execute({
    method: CONTROL_METHODS.GET_SERVICES,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(services.snowluma, {
    status: 'failed', installed: true, running: false, ready: false, managed: false,
    version: '1.0', selectedId: 'snow-1', lastError: 'token=***',
    installations: [{ id: 'snow-1', name: 'SnowLuma', version: '1.0', status: 'stopped', valid: true, source: 'configured' }]
  });
  assert.deepEqual(services.dsh, { status: 'not-installed', installations: [] });
}

{
  const fx = fixture();
  const selected = fx.service.execute({
    method: CONTROL_METHODS.SELECT_SERVICE,
    params: { service: 'snowluma', id: 'snow-1' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(selected.service.selectedId, '', 'selection replies immediately with the current public snapshot');
  await flushServiceTasks();
  assert.equal(fx.localServices.snowluma.selectedId, 'snow-1');
  assert.deepEqual(fx.serviceCalls, [{ name: 'select', value: { service: 'snowluma', id: 'snow-1' } }]);
  for (const params of [
    { service: 'unknown', id: 'snow-1' },
    { service: 'snowluma', id: 'not-detected' },
    { service: 'snowluma', id: 'snow-1', path: 'C:\\arbitrary' },
    { service: 'dsh', id: 'dsh-1', command: 'whoami' },
    { service: 'dsh', id: 'dsh-1', url: 'https://example.invalid' }
  ]) {
    assert.throws(() => fx.service.execute({
      method: CONTROL_METHODS.SELECT_SERVICE,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    }), ControlServiceError);
  }
  assert.equal(fx.serviceCalls.length, 1, 'invalid selections must not reach the local service manager');
}

{
  const fx = fixture();
  const install = fx.service.execute({
    method: CONTROL_METHODS.INSTALL_SNOWLUMA,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  const startSnow = fx.service.execute({
    method: CONTROL_METHODS.START_SERVICE,
    params: { service: 'snowluma' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  const startDsh = fx.service.execute({
    method: CONTROL_METHODS.START_SERVICE,
    params: { service: 'dsh' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  const stop = fx.service.execute({
    method: CONTROL_METHODS.STOP_SERVICE,
    params: { service: 'dsh' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(install, { service: fx.localServices.snowluma });
  assert.deepEqual(startSnow, { service: fx.localServices.snowluma });
  assert.deepEqual(startDsh, { service: fx.localServices.dsh });
  assert.deepEqual(stop, { service: fx.localServices.dsh });
  assert.deepEqual(fx.serviceCalls, [], 'long-running install/start/stop work must not delay or precede the reply');
  await flushServiceTasks();
  assert.deepEqual(fx.serviceCalls, [
    { name: 'install', value: undefined },
    { name: 'start', value: { service: 'snowluma' } },
    { name: 'connect', value: undefined },
    { name: 'start', value: { service: 'dsh' } },
    { name: 'stop', value: { service: 'dsh' } }
  ]);

  for (const [method, params] of [
    [CONTROL_METHODS.INSTALL_SNOWLUMA, { path: 'C:\\arbitrary' }],
    [CONTROL_METHODS.START_SERVICE, { service: 'snowluma', command: 'start.bat' }],
    [CONTROL_METHODS.STOP_SERVICE, { service: 'dsh', url: 'https://example.invalid' }],
    [CONTROL_METHODS.START_SERVICE, { service: 'shell' }]
  ]) {
    assert.throws(() => fx.service.execute({
      method, params, actor: { privilege: PRIVILEGE_CONSOLE }
    }), ControlServiceError);
  }
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {}, {}, { installFails: true });
  fx.service.execute({
    method: CONTROL_METHODS.INSTALL_SNOWLUMA,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  await flushServiceTasks();
  assert.deepEqual(fx.logs, ['本地服务SnowLuma 安装失败：install failed']);
}

{
  const fx = fixture();
  for (const [method, params, code] of [
    [CONTROL_METHODS.LIST_ACTIVITY, { path: 'C:\\secret.log' }, 'INVALID_ACTIVITY_FIELD'],
    [CONTROL_METHODS.READ_LOGS, { source: '../worker.log' }, 'INVALID_LOG_SOURCE'],
    [CONTROL_METHODS.READ_LOGS, { source: 'bridge', path: 'C:\\secret.log' }, 'INVALID_LOG_FIELD'],
    [CONTROL_METHODS.READ_LOGS, { source: 'worker.log' }, 'INVALID_LOG_SOURCE'],
    [CONTROL_METHODS.LIST_ACTIVITY, { limit: 0 }, 'INVALID_LOG_LIMIT'],
    [CONTROL_METHODS.READ_LOGS, { source: 'desktop', limit: 501 }, 'INVALID_LOG_LIMIT'],
    [CONTROL_METHODS.READ_LOGS, { source: 'bridge', limit: 1.5 }, 'INVALID_LOG_LIMIT'],
    [CONTROL_METHODS.LIST_ACTIVITY, { limit: '5' }, 'INVALID_LOG_LIMIT']
  ]) {
    assert.throws(() => fx.service.execute({
      method,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    }), (error) => error instanceof ControlServiceError && error.code === code);
  }
  assert.deepEqual(fx.activityReads, []);
  assert.deepEqual(fx.logReads, []);
}

{
  const oversized = fixture(undefined, {}, {}, {}, {}, {}, {
    activity: ['a'.repeat(70000), 'activity-tail'],
    sources: { bridge: ['b'.repeat(70000), 'bridge-tail'], worker: [], desktop: [] }
  });
  const activity = oversized.service.execute({
    method: CONTROL_METHODS.LIST_ACTIVITY,
    params: { limit: 500 },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  const logs = oversized.service.execute({
    method: CONTROL_METHODS.READ_LOGS,
    params: { source: 'bridge', limit: 500 },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.ok(activity.entries.join('\n').length <= 64 * 1024);
  assert.ok(logs.lines.join('\n').length <= 64 * 1024);
  assert.equal(activity.entries.at(-1), 'activity-tail');
  assert.equal(logs.lines.at(-1), 'bridge-tail');
}

{
  const fx = fixture();
  const result = fx.service.execute({
    method: CONTROL_METHODS.RUN_DIAGNOSTICS,
    params: { checks: ['runtime', 'paths', 'runtime'] },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { checks: { runtime: { ok: true }, paths: { ok: true } } });
  assert.deepEqual(fx.diagnosticCalls, [['runtime', 'paths']]);
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.RUN_DIAGNOSTICS,
    params: { checks: ['shell', 'runtime'] },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), (error) => error instanceof ControlServiceError && error.code === 'INVALID_DIAGNOSTIC_CHECK');
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.RUN_DIAGNOSTICS,
    params: { checks: ['runtime'] },
    actor: { privilege: PRIVILEGE_AGENT }
  }), (error) => error instanceof ControlServiceError && error.code === 'FORBIDDEN');
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {
    persisted: {
      mode: 'chat',
      allow: { private: [111, 222], groups: [333] },
      deny: { private: [444], groups: [] },
      ownerQQ: 555
    }
  });
  assert.deepEqual(fx.service.execute({
    method: CONTROL_METHODS.GET_POLICY,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), {
    policy: {
      mode: 'chat',
      allow: { private: [111, 222], groups: [333] },
      deny: { private: [444], groups: [] },
      ownerQQ: 555
    }
  });

  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_POLICY,
    params: {
      mode: 'social',
      allow: { private: ['123', '123', 456], groups: [789] },
      ownerQQ: ' 987654 '
    },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, {
    ok: true,
    policy: {
      mode: 'social',
      allow: { private: [123, 456], groups: [789] },
      deny: { private: [444], groups: [] },
      ownerQQ: 987654
    }
  });
  assert.deepEqual(fx.persistedPolicy, result.policy);
  assert.deepEqual(fx.runtimePolicy, result.policy);
  assert.deepEqual(fx.policyWrites, [result.policy]);
  assert.deepEqual(fx.policyWriteOptions, [{ modeProvided: true }]);
  assert.deepEqual(fx.runtimePolicyWrites, [result.policy]);
  assert.equal(fx.logs.length, 1);
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {
    persisted: {
      mode: 'closed-agent',
      allow: { private: [111], groups: [222] },
      deny: { private: [333], groups: [444] },
      ownerQQ: 555
    }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_POLICY,
    params: { deny: { groups: [] }, ownerQQ: '   ' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result.policy, {
    mode: 'closed-agent',
    allow: { private: [111], groups: [222] },
    deny: { private: [333], groups: [] },
    ownerQQ: null
  });
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {
    persisted: {
      mode: 'chat',
      allow: { private: [111], groups: [] },
      deny: { private: [], groups: [] },
      ownerQQ: 555
    },
    runtime: {
      mode: 'social',
      allow: { private: [111], groups: [] },
      deny: { private: [], groups: [] },
      ownerQQ: 555
    }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_POLICY,
    params: { allow: { groups: [123] } },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(result.policy.mode, 'social', 'omitted mode must preserve effective DSH mode, not stale local mode.json');
  assert.deepEqual(result.policy.allow, { private: [111], groups: [123] });
  assert.equal(fx.runtimePolicy.mode, 'social');
  assert.deepEqual(fx.policyWriteOptions, [{ modeProvided: false }]);
}

// 旧模式迁移：reserved 弃用→chat；reserved2 更名→social。读到旧值必须迁移，写盘用新值。
{
  const fx = fixture(undefined, {}, {}, {}, {}, {
    persisted: {
      mode: 'reserved2',
      allow: { private: [111], groups: [] },
      deny: { private: [], groups: [] },
      ownerQQ: 555
    }
  });
  const migrated = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_POLICY,
    params: { allow: { groups: [222] } },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(migrated.policy.mode, 'social', 'reserved2 must migrate to social');

  const explicit = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_POLICY,
    params: {
      mode: 'reserved',
      allow: { private: [111], groups: [] },
      deny: { private: [], groups: [] },
      ownerQQ: 555
    },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(explicit.policy.mode, 'chat', 'reserved must migrate to chat');
  assert.equal(fx.policyWrites.at(-1).mode, 'chat');
}

{
  const invalidCases = [
    [{ mode: 'typo' }, 'INVALID_MODE'],
    [{ allow: { private: ['1 OR 1=1'] } }, 'INVALID_POLICY_ID'],
    [{ deny: { groups: [Infinity] } }, 'INVALID_POLICY_ID'],
    [{ allow: { private: [Number.MAX_SAFE_INTEGER + 1] } }, 'INVALID_POLICY_ID'],
    [{ ownerQQ: '-1' }, 'INVALID_POLICY_ID'],
    [{ ownerQQ: {} }, 'INVALID_POLICY_ID'],
    [{ allow: { users: [123] } }, 'INVALID_POLICY_LIST'],
    [{ extraConfig: true }, 'INVALID_POLICY_FIELD']
  ];
  for (const [params, code] of invalidCases) {
    const fx = fixture();
    assert.throws(() => fx.service.execute({
      method: CONTROL_METHODS.UPDATE_POLICY,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    }), (error) => error instanceof ControlServiceError && error.code === code);
    assert.deepEqual(fx.policyWrites, []);
    assert.deepEqual(fx.runtimePolicyWrites, []);
    assert.deepEqual(fx.logs, []);
  }
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, { persistFails: true });
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.UPDATE_POLICY,
    params: { mode: 'closed-agent', ownerQQ: '12345' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), /policy persist failed/);
  assert.deepEqual(fx.runtimePolicy, {
    mode: 'chat', allow: { private: [], groups: [] }, deny: { private: [], groups: [] }, ownerQQ: null
  });
  assert.deepEqual(fx.runtimePolicyWrites, []);
  assert.deepEqual(fx.logs, []);
}

{
  const fx = fixture({ role: 'helper', mode: 'active' });
  const result = fx.service.execute({
    method: CONTROL_METHODS.LIST_ROLES,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { roles: ['helper', 'assistant'], current: 'helper' });
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.logs, []);
}

{
  const fx = fixture(undefined, {}, {}, {
    ownerQQ: 12345,
    sessions: {
      'private:12345': 'session-owner',
      'group:98765': 'session-group',
      'private:54321': 'session-other'
    }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.LIST_SESSIONS,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, {
    sessions: [
      { key: 'private:12345', sessionId: 'session-owner', owner: true },
      { key: 'group:98765', sessionId: 'session-group', owner: false },
      { key: 'private:54321', sessionId: 'session-other', owner: false }
    ]
  });
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.logs, []);
}

{
  const fx = fixture(undefined, {}, {}, {
    sessions: { 'private:12345': 'session-owner', 'group:98765': 'session-group' }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.LIST_SESSIONS,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result.sessions.map((entry) => entry.owner), [false, false]);
}

{
  const fx = fixture(undefined, {}, {}, {}, {
    activeCheckMinMs: 20,
    activeCheckMaxMs: 40,
    activeDurationMinMs: 100,
    activeDurationMaxMs: 200,
    activeDurationEnabled: true
  });
  const existing = {
    phase: 'idle', lastCheckAt: 1, nextCheckAt: 2, lastActiveMessageAt: 3,
    activeEnteredAt: 4, activeDeadlineAt: 5, activeExitAt: 6, lastAiReplyAt: 99,
    lastFollowUpAt: 100, probeDeadline: 7, proactiveNextCheckAt: 101, extension: 'keep'
  };
  fx.socialStates.set('group:123', existing);
  const result = fx.service.execute({
    method: CONTROL_METHODS.SET_SOCIAL_PHASE,
    params: { key: ' group:123 ', phase: 'active' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, key: 'group:123', phase: 'active' });
  assert.equal(fx.socialStates.get('group:123'), existing);
  assert.deepEqual(existing, {
    phase: 'active', lastCheckAt: 1000, nextCheckAt: 1020, lastActiveMessageAt: 1000,
    activeEnteredAt: 1000, activeDeadlineAt: 1100, activeExitAt: 0, lastAiReplyAt: 99,
    lastFollowUpAt: 100, probeDeadline: 0, proactiveNextCheckAt: 101, extension: 'keep'
  });
  assert.deepEqual(fx.socialCalls, [{ operation: 'ensure', key: 'group:123' }]);
  assert.deepEqual(fx.socialRandomRanges, [[20, 40], [100, 200]]);
  assert.deepEqual(fx.logs, ['控制台：手动将 group:123 设为活跃']);
}

{
  const fx = fixture(undefined, {}, {}, {}, { activeDurationEnabled: false });
  const result = fx.service.execute({
    method: CONTROL_METHODS.SET_SOCIAL_PHASE,
    params: { key: 'private:456', phase: 'active' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, key: 'private:456', phase: 'active' });
  assert.equal(fx.socialStates.get('private:456').activeDeadlineAt, 0);
  assert.deepEqual(fx.socialRandomRanges, [[20000, 40000]]);
}

{
  const fx = fixture();
  fx.socialStates.set('group:123', { phase: 'active' });
  fx.socialStates.set('group:other', { phase: 'active' });
  fx.socialTimers.set('group:123', new Set(['timer-a', 'timer-b']));
  fx.socialTimers.set('group:other', new Set(['timer-other']));
  fx.socialContexts.set('group:123', ['silent']);
  fx.socialContexts.set('group:other', ['preserve']);
  const result = fx.service.execute({
    method: CONTROL_METHODS.SET_SOCIAL_PHASE,
    params: { key: ' group:123 ', phase: 'idle' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, key: 'group:123', phase: 'idle' });
  assert.deepEqual(fx.socialCalls, [
    { operation: 'cancelTimers', key: 'group:123' },
    { operation: 'deleteState', key: 'group:123' },
    { operation: 'deleteContext', key: 'group:123' }
  ]);
  assert.equal(fx.socialStates.has('group:123'), false);
  assert.equal(fx.socialStates.has('group:other'), true);
  assert.equal(fx.socialTimers.has('group:123'), false);
  assert.equal(fx.socialTimers.has('group:other'), true);
  assert.equal(fx.socialContexts.has('group:123'), false);
  assert.equal(fx.socialContexts.has('group:other'), true);
  assert.deepEqual(fx.logs, ['控制台：手动将 group:123 设为观望']);
}

{
  for (const [params, code] of [
    [{ key: '   ', phase: 'active' }, 'INVALID_SESSION_KEY'],
    [{ key: 'group:123', phase: 'probing' }, 'INVALID_PHASE']
  ]) {
    const fx = fixture();
    assert.throws(
      () => fx.service.execute({
        method: CONTROL_METHODS.SET_SOCIAL_PHASE,
        params,
        actor: { privilege: PRIVILEGE_CONSOLE }
      }),
      (error) => error instanceof ControlServiceError && error.code === code
    );
    assert.deepEqual(fx.socialCalls, []);
    assert.deepEqual(fx.logs, []);
  }
}

{
  const fx = fixture({ role: 'helper', mode: 'silent' });
  const result = fx.service.execute({
    method: CONTROL_METHODS.SET_ROLE,
    params: { role: ' assistant! ' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, role: 'assistant' });
  assert.deepEqual(fx.state, { role: 'assistant', mode: 'silent' });
  assert.deepEqual(fx.logs, ['控制台：角色已设置为 assistant']);
}

{
  for (const params of [{}, { role: null }, { role: '' }, { role: 123 }]) {
    const fx = fixture({ role: 'assistant', mode: 'silent' });
    const result = fx.service.execute({
      method: CONTROL_METHODS.SET_ROLE,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    });
    assert.deepEqual(result, { ok: true, role: null });
    assert.deepEqual(fx.state, { role: null, mode: 'silent' });
    assert.deepEqual(fx.logs, ['控制台：角色已清除']);
  }
}

{
  const fx = fixture();
  assert.throws(
    () => fx.service.execute({
      method: CONTROL_METHODS.SET_ROLE,
      params: { role: 'unknown' },
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_ROLE'
  );
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.logs, []);
}

{
  const fx = fixture({ role: 'helper', mode: 'active' });
  const result = fx.service.execute({
    method: CONTROL_METHODS.SET_ROLE_MODE,
    params: { mode: 'silent' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, roleMode: 'silent' });
  assert.deepEqual(fx.state, { role: 'helper', mode: 'silent' });
  assert.deepEqual(fx.writes, [{ role: 'helper', mode: 'silent' }]);
  assert.deepEqual(fx.logs, ['控制台：静默模式 开启']);
}

{
  const fx = fixture({ role: 'assistant', mode: 'silent' });
  const result = fx.service.execute({
    method: CONTROL_METHODS.SET_ROLE_MODE,
    params: { mode: 'typo' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, roleMode: 'active' });
  assert.deepEqual(fx.state, { role: 'assistant', mode: 'active' });
  assert.deepEqual(fx.logs, ['控制台：静默模式 关闭']);
}

{
  const fx = fixture();
  const result = fx.service.execute({
    method: CONTROL_METHODS.CREATE_ROLE,
    params: { name: ' new role! ', content: '  Line one\nLine two  ' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { ok: true, role: 'newrole' });
  assert.deepEqual(fx.roleFiles, [{ name: 'newrole', content: 'Line one\nLine two\n' }]);
  assert.deepEqual(fx.logs, ['控制台：创建人格「newrole」']);
}

{
  const invalidCases = [
    [{ name: '!!!', content: 'valid body' }, 'INVALID_ROLE_NAME'],
    [{ name: 'new-role', content: '  \n ' }, 'INVALID_ROLE_CONTENT'],
    [{ name: 'README', content: 'valid body' }, 'RESERVED_ROLE_NAME'],
    [{ name: 'helper', content: 'valid body' }, 'ROLE_EXISTS']
  ];
  for (const [params, code] of invalidCases) {
    const fx = fixture();
    assert.throws(
      () => fx.service.execute({
        method: CONTROL_METHODS.CREATE_ROLE,
        params,
        actor: { privilege: PRIVILEGE_CONSOLE }
      }),
      (error) => error instanceof ControlServiceError && error.code === code
    );
    assert.deepEqual(fx.roleFiles, []);
    assert.deepEqual(fx.logs, []);
  }
}

{
  const fx = fixture();
  for (const method of Object.values(CONTROL_METHODS)) {
    assert.throws(
      () => fx.service.execute({ method, params: { role: 'assistant', mode: 'silent' }, actor: { privilege: PRIVILEGE_AGENT } }),
      (error) => error instanceof ControlServiceError && error.code === 'FORBIDDEN'
    );
  }
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.logs, []);
  assert.equal(agentPrivilegeAllows('GET', '/api/roles'), false);
  assert.equal(agentPrivilegeAllows('POST', '/api/role'), false);
  assert.equal(agentPrivilegeAllows('POST', '/api/roles/create'), false);
  assert.equal(agentPrivilegeAllows('POST', '/api/role-mode'), false);
  assert.equal(agentPrivilegeAllows('GET', '/api/security'), false);
  assert.equal(agentPrivilegeAllows('POST', '/api/security'), false);
  assert.equal(agentPrivilegeAllows('POST', '/api/slang/config'), false);
  assert.equal(agentPrivilegeAllows('GET', '/api/sessions'), false);
  assert.equal(agentPrivilegeAllows('POST', '/api/social/state'), false);
  assert.deepEqual(fx.socialCalls, []);
  assert.deepEqual(fx.activityReads, []);
  assert.deepEqual(fx.logReads, []);
}

{
  const fx = fixture(undefined, { runtime: null, persisted: { custom: true } });
  const result = fx.service.execute({
    method: CONTROL_METHODS.GET_SECURITY,
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result, { security: { interceptNotify: true } });

  const configured = fixture(undefined, {
    runtime: { interceptNotify: false, extension: 'preserve' }
  });
  assert.deepEqual(configured.service.execute({
    method: CONTROL_METHODS.GET_SECURITY,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { security: { interceptNotify: false, extension: 'preserve' } });
}

{
  const fx = fixture(undefined, {}, {
    persisted: { savedOnly: 'persisted' },
    runtime: { enabled: true, learnerPreset: 'preset-a', runtimeOnly: 'active' }
  });
  assert.deepEqual(fx.service.execute({
    method: CONTROL_METHODS.GET_SLANG_CONFIG,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { config: { enabled: true, learnerPreset: 'preset-a', runtimeOnly: 'active' } });
  assert.deepEqual(fx.persistedSlang, { savedOnly: 'persisted' });
  assert.deepEqual(fx.logs, []);
  assert.deepEqual(fx.slangInvalidations, []);
}

{
  const fx = fixture(undefined, {
    persisted: { interceptNotify: true, diskOnly: 'preserve', shared: 'disk' },
    runtime: { interceptNotify: true, runtimeOnly: 'preserve', shared: 'runtime' }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SECURITY,
    params: { interceptNotify: 0, shared: 'request', added: 'value' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(fx.persistedSecurity, {
    interceptNotify: false,
    diskOnly: 'preserve',
    shared: 'request',
    added: 'value'
  });
  assert.deepEqual(result, {
    ok: true,
    security: {
      interceptNotify: false,
      runtimeOnly: 'preserve',
      shared: 'request',
      diskOnly: 'preserve',
      added: 'value'
    }
  });
  assert.deepEqual(fx.securityWrites, [fx.persistedSecurity]);
  assert.equal(fx.logs.length, 1);
  assert.ok(fx.logs[0].includes('interceptNotify=false'));
}

{
  const values = [
    [true, true],
    [false, false],
    [null, false],
    [0, false],
    ['', false],
    ['false', true],
    [{}, true]
  ];
  for (const [value, expected] of values) {
    const fx = fixture(undefined, {
      persisted: { interceptNotify: true },
      runtime: { interceptNotify: true }
    });
    const result = fx.service.execute({
      method: CONTROL_METHODS.UPDATE_SECURITY,
      params: { interceptNotify: value },
      actor: { privilege: PRIVILEGE_CONSOLE }
    });
    assert.equal(result.security.interceptNotify, expected);
  }
}

{
  const fx = fixture(undefined, {
    persisted: { interceptNotify: false, keep: 'disk' },
    runtime: { interceptNotify: true }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SECURITY,
    params: { unrelated: 'updated' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(result.security.interceptNotify, false);
  assert.equal(fx.persistedSecurity.interceptNotify, false);
}

{
  const fx = fixture(undefined, {
    persisted: { interceptNotify: false, keep: 'disk' },
    runtime: { interceptNotify: true, keepRuntime: 'memory' },
    persistFails: true
  });
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SECURITY,
    params: { extra: true },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), /persist failed/);
  assert.deepEqual(fx.runtimeSecurity, { interceptNotify: true, keepRuntime: 'memory' });
  assert.deepEqual(fx.logs, []);
  assert.deepEqual(fx.securityWrites, []);
}

{
  const fx = fixture(undefined, {}, {
    persisted: {
      enabled: 'old',
      extractMinMessages: 0,
      extractCooldownMs: -2,
      injectMax: 50,
      autoResearch: 1,
      learnerPreset: 'old-preset',
      workspaceTitle: 'Old title',
      inferenceThresholds: [3],
      persistedOnly: 'keep',
      shared: 'disk'
    },
    runtime: {
      enabled: true,
      learnerPreset: 'old-preset',
      workspaceTitle: 'Old title',
      runtimeOnly: 'keep',
      shared: 'runtime'
    }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SLANG_CONFIG,
    params: {
      enabled: 'true',
      extractMinMessages: '2.6',
      extractCooldownMs: '12.6',
      injectMax: 0,
      autoResearch: 'true',
      learnerPreset: ' new-preset ',
      workspaceTitle: ' New title ',
      inferenceThresholds: [8, 2, 8, 0, 'bad'],
      shared: 'request',
      runtimeAdded: 'new'
    },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(fx.persistedSlang, {
    enabled: false,
    extractMinMessages: 3,
    extractCooldownMs: 13,
    injectMax: 1,
    autoResearch: false,
    learnerPreset: 'new-preset',
    workspaceTitle: 'New title',
    inferenceThresholds: [1, 2, 8],
    persistedOnly: 'keep',
    shared: 'request',
    runtimeAdded: 'new'
  });
  assert.deepEqual(result, {
    ok: true,
    config: {
      enabled: false,
      learnerPreset: 'new-preset',
      workspaceTitle: 'New title',
      runtimeOnly: 'keep',
      shared: 'request',
      extractMinMessages: 3,
      extractCooldownMs: 13,
      injectMax: 1,
      autoResearch: false,
      inferenceThresholds: [1, 2, 8],
      persistedOnly: 'keep',
      runtimeAdded: 'new'
    }
  });
  assert.equal(fx.slangInvalidations.length, 1);
  assert.equal(fx.logs.length, 2);
}

{
  const fx = fixture(undefined, {}, {
    persisted: { injectMax: 10, inferenceThresholds: [5] },
    runtime: { injectMax: 10, inferenceThresholds: [5] }
  });
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SLANG_CONFIG,
    params: { enabled: true, autoResearch: true, injectMax: 99, inferenceThresholds: [] },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.autoResearch, true);
  assert.equal(result.config.injectMax, 30);
  assert.deepEqual(result.config.inferenceThresholds, [2, 4, 8]);
  assert.equal(fx.slangInvalidations.length, 0);
  assert.equal(fx.logs.length, 1);
}

{
  const fx = fixture();
  const result = fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SLANG_CONFIG,
    params: { inferenceThresholds: '8, 2,8,0,bad' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(result.config.inferenceThresholds, [1, 2, 8]);
}

{
  const fx = fixture(undefined, {}, {
    persisted: { learnerPreset: 'same', workspaceTitle: 'Title' },
    runtime: { learnerPreset: 'same', workspaceTitle: 'Title' }
  });
  fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SLANG_CONFIG,
    params: { learnerPreset: ' same ', workspaceTitle: ' Title ' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(fx.slangInvalidations.length, 0);
}

{
  const fx = fixture(undefined, {}, {
    persisted: { workspaceTitle: 'Old title' },
    runtime: { workspaceTitle: 'Old title' }
  });
  fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SLANG_CONFIG,
    params: { workspaceTitle: ' New title ' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(fx.runtimeSlang.workspaceTitle, 'New title');
  assert.equal(fx.slangInvalidations.length, 1);
}

{
  const fx = fixture(undefined, {}, {
    persisted: { learnerPreset: 'old' },
    runtime: { learnerPreset: 'old', workspaceTitle: 'Title' },
    persistFails: true
  });
  assert.throws(() => fx.service.execute({
    method: CONTROL_METHODS.UPDATE_SLANG_CONFIG,
    params: { learnerPreset: 'new' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), /slang persist failed/);
  assert.deepEqual(fx.runtimeSlang, { learnerPreset: 'old', workspaceTitle: 'Title' });
  assert.equal(fx.slangInvalidations.length, 0);
  assert.deepEqual(fx.logs, []);
}

{
  const fx = fixture();
  assert.throws(
    () => fx.service.execute({
      method: 'role.delete',
      params: {},
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'METHOD_NOT_FOUND'
  );
  assert.throws(
    () => fx.service.execute({
      method: CONTROL_METHODS.SET_ROLE_MODE,
      params: [],
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_PARAMS'
  );
  assert.throws(
    () => fx.service.execute(null),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_PARAMS'
  );
  assert.throws(
    () => fx.service.execute({ method: CONTROL_METHODS.SET_ROLE_MODE, params: {}, actor: { privilege: PRIVILEGE_AGENT } }),
    (error) => error instanceof ControlServiceError && error.code === 'FORBIDDEN'
  );
  assert.deepEqual(fx.writes, []);
}

// Native model/preset management is a narrow projection: it must not become a generic DSH RPC.
{
  const fx = fixture(undefined, {}, {}, {}, {}, {}, {}, {}, {
    defaults: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    bindings: { chat: null, closedAgent: 'router-standard', social: 'whale-chat-v2', workshop: 'router-standard', learner: 'whale-chat' }
  });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.GET_MODEL_DEFAULTS,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { defaults: fx.modelDefaults });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.LIST_MODEL_CATALOG,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { models: fx.modelCatalog });
  const updated = await fx.service.execute({
    method: CONTROL_METHODS.UPDATE_MODEL_DEFAULTS,
    params: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.deepEqual(updated, { ok: true, defaults: {
    provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low'
  }});
  assert.deepEqual(fx.modelDefaults, updated.defaults);
  assert.deepEqual(fx.modelWrites[0], { type: 'defaults', value: updated.defaults });
  await assert.rejects(
    fx.service.execute({
      method: CONTROL_METHODS.UPDATE_MODEL_DEFAULTS,
      params: { provider: 'not-in-catalog', model: 'deepseek-chat', reasoningEffort: 'low' },
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_MODEL'
  );
  await assert.rejects(
    fx.service.execute({
      method: CONTROL_METHODS.UPDATE_MODEL_DEFAULTS,
      params: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' },
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_REASONING_EFFORT'
  );
  assert.throws(
    () => fx.service.execute({
      method: CONTROL_METHODS.LIST_MODEL_CATALOG,
      params: { namespace: 'all' },
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_PARAMS'
  );
}

{
  const fx = fixture(undefined, {}, {}, {}, {}, {}, {}, {}, {
    bindings: { chat: null, closedAgent: 'router-standard', social: 'whale-chat-v2', workshop: 'router-standard', learner: 'whale-chat' },
    presets: [{ id: 'router-standard', trust: 'system' }, { id: 'whale-chat', trust: 'project' }]
  });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.LIST_PRESETS,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { presets: fx.presets });
  assert.deepEqual(await fx.service.execute({
    method: CONTROL_METHODS.GET_PRESET_BINDINGS,
    actor: { privilege: PRIVILEGE_CONSOLE }
  }), { bindings: fx.presetBindings });
  const changed = await fx.service.execute({
    method: CONTROL_METHODS.UPDATE_PRESET_BINDINGS,
    params: { target: 'chat', presetId: 'router-standard' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.bindings.chat, 'router-standard');
  assert.deepEqual(fx.modelWrites.at(-1), { type: 'binding', target: 'chat', presetId: 'router-standard' });
  const workshop = await fx.service.execute({
    method: CONTROL_METHODS.UPDATE_PRESET_BINDINGS,
    params: { target: 'workshop', presetId: 'router-standard' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(workshop.bindings.workshop, 'router-standard', 'workshop preset binding must be accepted');
  const reset = await fx.service.execute({
    method: CONTROL_METHODS.UPDATE_PRESET_BINDINGS,
    params: { target: 'chat', presetId: '' },
    actor: { privilege: PRIVILEGE_CONSOLE }
  });
  assert.equal(reset.bindings.chat, null);
  await assert.rejects(
    fx.service.execute({
      method: CONTROL_METHODS.UPDATE_PRESET_BINDINGS,
      params: { target: 'chat', presetId: 'unknown' },
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_PRESET'
  );
  await assert.rejects(
    fx.service.execute({
      method: CONTROL_METHODS.UPDATE_PRESET_BINDINGS,
      params: { target: 'arbitrary', presetId: 'router-standard' },
      actor: { privilege: PRIVILEGE_CONSOLE }
    }),
    (error) => error instanceof ControlServiceError && error.code === 'INVALID_PRESET_TARGET'
  );
}

console.log('PASS: ControlService roles, security, policy, services, activity/log tail, slang config, sessions, social phase, authorization, and parameter validation');
