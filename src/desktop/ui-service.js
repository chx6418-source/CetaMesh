// Narrow, renderer-safe DTO adapter for the privileged Desktop WebView.
// Business state stays in existing Core services; this module owns no persistent data.

const EVENT_NAMES = Object.freeze([
  'core.status', 'chat.updated', 'chat.streaming', 'task.updated', 'task.deleted',
  'agent.updated', 'workspace.updated', 'plugin.updated', 'plugin.downloadProgress', 'approval.pending',
  'approval.resolved', 'model.updated', 'memory.updated', 'update.status', 'device.updated'
]);

const EVENT_DATA_KEYS = Object.freeze([
  'sessionId', 'taskId', 'workspaceId', 'agentId', 'pluginId', 'serverId', 'approvalId',
  'provider', 'status', 'progress', 'ready', 'needsAttention'
]);

const SETTING_KEYS = Object.freeze({
  general: ['language', 'theme', 'startMinimized', 'confirmOnExit'],
  models: ['provider', 'defaultModel', 'reasoningEffort', 'streaming'],
  agents: ['defaultAgentPreset', 'defaultAgentProvider', 'allowBackgroundTurns'],
  memory: ['enabled', 'requireConfirmationForLongTerm', 'defaultScope', 'retrievalLimit'],
  workspace: ['defaultWorkspaceId', 'boundaryEnforcement'],
  devices: ['meshEnabled', 'requireApprovalForRemoteCapabilities', 'presenceTtlMs'],
  extensions: ['allowLocalImport', 'developerMode', 'requireReviewApproval', 'maxInstalled'],
  security: ['redactLogs', 'auditRetention', 'allowedUpdateHosts'],
  updates: ['channel', 'autoCheck', 'manifestUrl', 'fallbackManifestUrl', 'pinnedPublicKey'],
  advanced: ['showEngineeringPages', 'logLevel', 'diagnosticsVerbosity']
});

const SECRET_KEY = /(api.?key|secret|token|password|credential|private.?key|pinnedPublicKey)/i;
const MAX_TEXT = 256_000;

function uiError(code, message) {
  return Object.assign(new Error(message), { code });
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function string(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
    ? value : null;
}

function selected(source, fields) {
  const input = record(source);
  const output = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field) || SECRET_KEY.test(field)) continue;
    const value = input[field];
    if (typeof value === 'string') output[field] = value.slice(0, field === 'text' || field === 'content' ? MAX_TEXT : 4000);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[field] = value;
  }
  return output;
}

function boundedStrings(value, limit = 50, max = 300) {
  return Array.isArray(value)
    ? value.slice(0, limit).filter(item => typeof item === 'string').map(item => item.slice(0, max))
    : [];
}

function projectSession(value) {
  const row = record(value);
  const config = record(row.config);
  return {
    id: string(row.id, 128), title: string(row.title, 200), createdAt: scalar(row.createdAt),
    updatedAt: scalar(row.updatedAt), archived: row.archived === true,
    config: {
      mode: string(config.mode, 40), modelProvider: string(config.modelProvider, 80) || null,
      model: string(config.model, 200), agentProvider: string(config.agentProvider, 80) || null
    }
  };
}

function projectMessage(value) {
  const row = record(value);
  const role = ['user', 'assistant', 'system'].includes(row.role) ? row.role : 'assistant';
  const attachments = boundedStrings(row.attachments, 8, 200);
  const toolActivity = Array.isArray(row.toolActivity) ? row.toolActivity.slice(0, 50).map(item => {
    const tool = record(item);
    return {
      id: string(tool.id, 128), label: string(tool.label ?? tool.name, 200),
      status: ['pending', 'running', 'completed', 'failed'].includes(tool.status) ? tool.status : 'completed',
      summary: string(tool.summary, 1000), durationMs: Number.isFinite(tool.durationMs) ? Math.max(0, tool.durationMs) : null
    };
  }) : [];
  return {
    id: string(row.id, 128), role, text: string(row.text, MAX_TEXT), at: scalar(row.at),
    attachments, toolActivity, error: row.error ? string(row.error, 1000) : null,
    cancelled: row.cancelled === true
  };
}

function projectTask(value) {
  const row = record(value);
  const progress = record(row.progress);
  const currentAgent = record(row.currentAgent);
  const checkpoint = record(row.checkpoint);
  const result = record(row.result);
  const artifacts = Array.isArray(row.artifacts) ? row.artifacts.slice(0, 100).map(item => {
    const artifact = record(item);
    return { id: string(artifact.id, 128), kind: string(artifact.kind, 80), label: string(artifact.label, 300), createdAt: scalar(artifact.createdAt) };
  }) : [];
  return {
    id: string(row.id, 128), title: string(row.goal, 500), goal: string(row.goal, 4000),
    status: string(row.status, 40), currentPhase: string(row.currentPhase, 500),
    progress: { percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0, note: string(progress.note, 1000) },
    workspaceId: string(row.workspaceId, 128) || null,
    agent: currentAgent.provider ? string(currentAgent.provider, 100) : null,
    createdAt: scalar(row.createdAt), updatedAt: scalar(row.updatedAt), rev: Number.isSafeInteger(row.rev) ? row.rev : null,
    checkpoint: checkpoint.summary ? { summary: string(checkpoint.summary, 2000), nextAction: string(checkpoint.nextAction, 500) } : null,
    result: result.summary ? { summary: string(result.summary, 4000) } : null,
    artifacts
  };
}

function projectWorkspace(value) {
  const row = record(value);
  return {
    id: string(row.id, 128), name: string(row.name ?? row.label, 200),
    status: string(row.status, 40), lastActivity: scalar(row.updatedAt ?? row.lastActivity)
  };
}

function projectOnboarding(value) {
  const row = record(value);
  const currentStep = string(row.currentStepId, 100) || null;
  return {
    complete: row.status === 'completed', currentStep,
    steps: (Array.isArray(row.steps) ? row.steps : []).slice(0, 20).map(step => {
      const item = record(step);
      return {
        id: string(item.id, 100), title: string(item.label ?? item.title, 160),
        description: string(item.description, 500),
        status: item.completed === true ? 'completed' : item.skipped === true ? 'skipped' : item.id === currentStep ? 'current' : 'pending',
        optional: item.optional === true
      };
    })
  };
}

function projectMemory(value) {
  const row = record(value);
  const memory = record(row.memory ?? row);
  return {
    id: string(memory.id, 128), type: string(memory.type, 80), scope: string(memory.scope, 120),
    title: string(memory.title ?? memory.content, 300), content: string(memory.content ?? memory.summary, 8000),
    summary: string(memory.summary ?? memory.content, 1200), tags: boundedStrings(memory.tags, 30, 100),
    pinned: memory.pinned === true, rev: Number.isSafeInteger(memory.rev) ? memory.rev : null,
    createdAt: scalar(memory.createdAt), updatedAt: scalar(memory.updatedAt)
  };
}

function projectAgent(value) {
  const row = record(value);
  const health = record(row.health);
  const desktop = record(row.desktopApp);
  const reason = string(row.reason ?? health.reason ?? row.status, 100);
  const healthStatus = string(health.status, 50).toLowerCase();
  const readiness = `${reason} ${healthStatus}`;
  const id = string(row.id ?? row.provider, 80);
  const available = row.available === true && health.available !== false;
  const status = /unsupported|not[_-]supported/i.test(readiness) ? 'not-supported'
    : /not[_-]installed|missing[_-]binary/i.test(readiness) ? 'not-installed'
      : /setup|auth|credential|needs[_-]config/i.test(readiness) ? 'needs-setup'
        : row.available === false || health.available === false ? 'unavailable'
          : available ? 'ready' : 'not-checked';
  return {
    id, name: string(row.displayName ?? row.label ?? id, 120),
    role: id === 'codex' ? '代码与项目' : id === 'dsh' ? '通用研究与协作' : '开发辅助',
    description: id === 'codex' ? '理解项目、修改代码并检查结果。' : id === 'dsh' ? '处理资料、规划和跨工具工作流。' : '在可用时连接本地开发能力。',
    available, status, version: string(row.version, 80) || null,
    desktopApp: id === 'dsh' ? {
      installed: desktop.installed === true, running: desktop.running === true,
      status: string(desktop.status, 50) || 'unknown', version: string(desktop.version, 80) || null
    } : null
  };
}

function projectExtensionSettingsValues(value, fields) {
  const row = record(value);
  const source = record(row.values);
  const values = {};
  for (const field of fields) {
    if (field.type === 'secretRef') {
      values[field.key] = { configured: record(source[field.key]).configured === true };
    } else {
      values[field.key] = scalar(source[field.key]);
    }
  }
  return { id: string(row.id, 160), values };
}
function projectPlugin(value) {
  const row = record(value);
  const extension = record(row.installedEntry);
  const permissions = Array.isArray(row.permissions) ? row.permissions : record(row.review).permissions;
  const screenshotCount = Array.isArray(row.screenshots) ? Math.min(row.screenshots.length, 8) : 0;
  const status = string(row.status, 60);
  return {
    id: string(row.id, 160), name: string(row.name, 200), summary: string(row.summary, 500),
    description: string(row.description, 8000), developer: string(row.publisher ?? row.developer ?? 'CetaMesh', 160),
    version: string(row.version ?? extension.version, 80), status: status === 'Update Available' ? 'update' : status,
    category: string(row.category, 80), kind: string(row.kind ?? row.type, 60),
    featured: row.featured === true, installed: Boolean(row.installedEntry || row.installed === true),
    enabled: extension.status === 'enabled' || row.enabled === true,
    icon: ['sparkles', 'plug', 'music', 'code', 'globe', 'image', 'bot', 'layers'].includes(row.icon) ? row.icon : 'layers',
    permissions: boundedStrings(permissions, 40, 250), changelog: boundedStrings(row.changelog, 30, 500),
    compatibility: { minimum: string(row.minCetaMeshVersion, 80) || null, maximum: string(row.maxCetaMeshVersion, 80) || null },
    screenshotCount, warning: string(row.warning, 500) || null
  };
}

function projectMcpServer(value) {
  const row = record(value);
  return {
    id: string(row.id ?? row.serverId, 160), name: string(row.name ?? row.displayName ?? row.id, 200),
    status: string(row.status, 60), enabled: row.enabled === true, available: row.available === true,
    toolCount: Number.isFinite(row.toolCount) ? Math.max(0, row.toolCount) : null,
    transport: string(row.transport, 40), reason: null
  };
}

function projectSettings(settings) {
  const input = record(settings);
  const result = {};
  for (const [section, keys] of Object.entries(SETTING_KEYS)) {
    const values = record(input[section]);
    result[section] = {};
    for (const key of keys) {
      if (!Object.hasOwn(values, key)) continue;
      if (key === 'pinnedPublicKey') {
        result[section].pinnedPublicKey = values[key] ? '[configured]' : '';
      } else if (!SECRET_KEY.test(key)) {
        result[section][key] = scalar(values[key]);
      }
    }
  }
  return result;
}

function projectAbout(value) {
  const row = record(value.about ?? value);
  const links = record(row.links);
  const developer = record(row.developer);
  const build = record(row.build);
  return {
    productName: 'CetaMesh Desktop', version: string(row.version, 80) || null,
    buildNumber: scalar(row.buildNumber), buildId: string(build.buildId ?? row.buildId, 100) || null,
    channel: string(row.channel ?? row.releaseChannel, 40) || null,
    commit: string(row.commit, 80) || null, platform: string(row.platform, 40) || null,
    developer: string(developer.name ?? row.developerName, 160) || null,
    website: string(links.website ?? row.website, 500) || null,
    gitcode: string(links.gitcode ?? row.gitcode, 500) || null,
    github: string(links.github ?? row.github, 500) || null
  };
}

function projectApproval(value) {
  const row = record(value);
  const request = record(row.request);
  const capability = string(row.capability ?? request.capability, 120);
  const title = capability === 'test.run' ? '运行项目测试'
    : capability.includes('filesystem.write') ? '修改工作区文件'
      : capability.includes('message.send') ? '发送消息' : '敏感操作需要确认';
  return {
    id: string(row.id, 128), title, capability,
    status: string(row.status, 40), createdAt: scalar(row.createdAt), expiresAt: scalar(row.expiresAt),
    summary: string(request.reason ?? row.reason, 1000) || '此操作需要你的逐次批准。',
    risk: string(row.risk ?? request.risk, 30) || 'high', taskId: string(request.taskId, 128) || null
  };
}

function objectParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw uiError('INVALID_PARAMS', 'UI 参数必须是对象');
  return value;
}

function boundedText(value, name, max) {
  if (typeof value !== 'string' || value.length > max) throw uiError('INVALID_PARAMS', `${name} 必须是长度不超过 ${max} 的文本`);
  return value;
}

function idParam(params, key = 'id') {
  const id = boundedText(params[key], key, 200).trim();
  if (!id) throw uiError('INVALID_PARAMS', `${key} 不能为空`);
  return id;
}

export function createDesktopUiEventBus({ now = () => Date.now(), maxEvents = 500 } = {}) {
  let cursor = 0;
  const events = [];
  const waiters = new Set();

  function after(afterCursor) {
    const rows = events.filter(event => event.cursor > afterCursor);
    if (!rows.length) return { events: [], cursor };
    const selectedRows = rows.slice(0, 100);
    return { events: selectedRows, cursor: selectedRows[selectedRows.length - 1].cursor };
  }

  function publish(event, data = {}) {
    if (!EVENT_NAMES.includes(event)) return false;
    const input = record(data);
    const safe = {};
    for (const key of EVENT_DATA_KEYS) {
      if (!Object.hasOwn(input, key)) continue;
      const value = input[key];
      if (typeof value === 'string') safe[key] = value.slice(0, 200);
      else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === 'boolean') safe[key] = value;
    }
    const item = { cursor: ++cursor, event, data: safe, at: now() };
    events.push(item);
    while (events.length > maxEvents) events.shift();
    for (const wake of [...waiters]) wake();
    return true;
  }

  function next({ after: afterCursor = 0, waitMs = 20_000, signal } = {}) {
    const normalizedCursor = Number.isSafeInteger(afterCursor) && afterCursor >= 0 ? afterCursor : 0;
    const current = after(normalizedCursor);
    if (current.events.length || waitMs <= 0) return Promise.resolve(current);
    const boundedWait = Math.max(1, Math.min(Number(waitMs) || 20_000, 25_000));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        signal?.removeEventListener?.('abort', abort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const wake = () => {
        const result = after(normalizedCursor);
        if (result.events.length) finish(resolve, result);
      };
      const abort = () => finish(reject, signal.reason ?? uiError('ABORTED', '事件订阅已结束'));
      waiters.add(wake);
      timer = setTimeout(() => finish(resolve, after(normalizedCursor)), boundedWait);
      if (signal?.aborted) abort();
      else signal?.addEventListener?.('abort', abort, { once: true });
      // Close the publish/read race between the first snapshot and waiter registration.
      wake();
    });
  }

  return Object.freeze({ publish, next, eventNames: EVENT_NAMES });
}

export function createDesktopUiService({ services = {}, system = services.systemServices ?? services.system ?? {}, eventBus } = {}) {
  const owner = Object.freeze({ kind: 'owner', id: 'desktop' });
  const call = async (service, method, params = {}, withActor = false) => {
    if (!service || typeof service.execute !== 'function') throw uiError('SERVICE_UNAVAILABLE', '此项能力当前不可用');
    return service.execute({ method, params, ...(withActor ? { actor: owner } : {}) });
  };
  const emit = (event, data) => eventBus?.publish(event, data);
  const chat = (method, params) => call(services.chatService, method, params);
  const task = (method, params) => call(services.taskService, method, params);
  const memory = (method, params) => call(services.memoryService, method, params);
  const agent = (method, params) => call(services.agentService, method, params);
  const plugins = (method, params) => call(services.pluginCenterService, method, params);
  const extensions = (method, params) => call(services.extensionService, method, params);
  const integrations = (method, params) => call(services.integrationService, method, params);
  const settings = (method, params) => call(system.settings, method, params);
  const about = (method, params) => call(system.about, method, params);
  const update = (method, params) => call(system.update, method, params);
  const onboarding = (method, params) => call(system.onboarding, method, params);
  const capability = (method, params) => call(services.capabilityService, method, params, true);
  const workspace = (method, params) => call(services.workspaceService, method, params);
  const enableReviewTokens = new Map();

  const handlers = {
    'ui.events.next': async (p, context) => eventBus?.next({ after: p.after, waitMs: p.waitMs, signal: context?.signal }) ?? { events: [], cursor: 0 },
    'ui.chat.sessions.list': async p => {
      const result = await chat('chat.sessions.list', { includeArchived: p.includeArchived === true });
      return { sessions: (result.sessions ?? []).map(projectSession) };
    },
    'ui.chat.sessions.create': async p => projectSession(await chat('chat.sessions.create', { title: boundedText(p.title ?? '', 'title', 200) })),
    'ui.chat.sessions.rename': async p => projectSession(await chat('chat.sessions.rename', { id: idParam(p), title: boundedText(p.title, 'title', 200) })),
    'ui.chat.sessions.archive': async p => projectSession(await chat('chat.sessions.archive', { id: idParam(p), archived: p.archived !== false })),
    'ui.chat.sessions.delete': async p => selected(await chat('chat.sessions.delete', { id: idParam(p) }), ['id', 'deleted']),
    'ui.chat.history': async p => {
      const result = await chat('chat.history', { id: idParam(p), limit: Math.max(1, Math.min(200, Number(p.limit) || 100)) });
      return { id: string(result.id, 128), total: Number(result.total) || 0, messages: (result.messages ?? []).map(projectMessage) };
    },
    'ui.chat.status': async p => {
      const result = await chat('chat.status', { id: idParam(p) });
      const turn = record(result.turn);
      return {
        id: string(result.id, 128), state: string(turn.state ?? result.lastState, 40),
        displayText: string(turn.displayText, MAX_TEXT), error: string(turn.error ?? result.lastError, 1000) || null,
        approvalId: string(turn.approvalId, 128) || null, approvalExpiresAt: scalar(turn.approvalExpiresAt),
        routing: selected(turn.routing, ['modelProvider', 'requestedModel', 'resolvedModel', 'toolCalling', 'taskId'])
      };
    },
    'ui.chat.send': async p => {
      const text = boundedText(p.text, 'text', 32_000);
      const attachments = Array.isArray(p.attachments) ? p.attachments.slice(0, 8).map((item, index) => {
        const attachment = record(item);
        return { name: boundedText(attachment.name, `attachments[${index}].name`, 200), content: boundedText(attachment.content, `attachments[${index}].content`, 256_000), ...(attachment.mimeType ? { mimeType: string(attachment.mimeType, 80) } : {}) };
      }) : [];
      const result = await chat('chat.send', { id: idParam(p), text, attachments });
      emit('chat.updated', { sessionId: p.id });
      return selected(result, ['userMessageId']);
    },
    'ui.chat.stop': async p => selected(await chat('chat.stop', { id: idParam(p) }), ['stopped', 'state', 'reason']),
    'ui.chat.retry': async p => selected(await chat('chat.retry', { id: idParam(p) }), ['userMessageId']),
    'ui.chat.continue': async p => selected(await chat('chat.continue', { id: idParam(p) }), ['continued']),
    'ui.chat.catalog': async () => {
      const result = await chat('chat.catalog', {});
      return {
        models: (result.models ?? []).map(item => selected(item, ['id', 'label', 'provider'])),
        modelProviders: (result.modelProviders ?? []).map(item => ({
          id: string(item.id, 80), label: string(item.label, 120), configured: item.hasKey === true,
          models: (item.models ?? []).map(value => selected(value, ['id', 'name', 'label', 'owned_by']))
        })),
        agentProviders: (result.agentProviders ?? []).map(projectAgent),
        modes: boundedStrings(result.modes, 10, 40), defaultModelProvider: string(result.defaultModelProvider, 80) || null,
        available: !result.error, reason: string(result.error, 300) || null
      };
    },
    'ui.chat.config.set': async p => {
      const input = record(p.config);
      const config = {};
      for (const key of ['mode', 'modelProvider', 'model', 'agentProvider', 'reasoning']) {
        if (Object.hasOwn(input, key)) config[key] = input[key];
      }
      const result = await chat('chat.config.set', { id: idParam(p), config });
      return projectSession(result);
    },
    'ui.task.overview': async p => {
      const result = await task('task.overview', { query: string(p.query, 200), status: string(p.status, 40) || undefined, limit: Math.max(1, Math.min(200, Number(p.limit) || 100)) });
      return { tasks: (result.tasks ?? []).map(projectTask), total: Number(result.total) || 0, counts: record(result.counts), needsAttention: boundedStrings(result.needsAttention, 200, 128) };
    },
    'ui.task.get': async p => ({ task: projectTask((await task('task.get', { id: idParam(p) })).task) }),
    'ui.task.create': async p => {
      const created = await task('task.create', { goal: boundedText(p.goal, 'goal', 4000), requirements: boundedStrings(p.requirements, 50, 1000), workspaceId: string(p.workspaceId, 128) || null, note: string(p.note, 1000) });
      emit('task.updated', { taskId: created?.id, status: created?.status });
      return { task: projectTask(created) };
    },
    'ui.task.pause': async p => {
      const result = await task('task.pause', { id: idParam(p), expectedRev: p.expectedRev, reason: string(p.reason, 1000) });
      emit('task.updated', { taskId: result.task?.id, status: result.task?.status });
      return { task: projectTask(result.task) };
    },
    'ui.task.resume': async p => {
      const result = await task('task.resume', { id: idParam(p), expectedRev: p.expectedRev, provider: string(p.provider, 80), sessionId: string(p.sessionId, 160) });
      emit('task.updated', { taskId: result.task?.id, status: result.task?.status });
      return { task: projectTask(result.task) };
    },
    'ui.task.cancel': async p => {
      const result = await task('task.cancel', { id: idParam(p), expectedRev: p.expectedRev, reason: string(p.reason, 1000) });
      emit('task.updated', { taskId: result.task?.id, status: result.task?.status });
      return { task: projectTask(result.task) };
    },
    'ui.workspace.list': async () => {
      const result = await workspace('workspace.list', {});
      return { workspaces: (result.workspaces ?? []).map(projectWorkspace), activeId: string(result.activeId, 128) || null };
    },
    'ui.workspace.open': async p => {
      const result = await workspace('workspace.open', { id: idParam(p) });
      const activeId = string(result.workspace?.id ?? p.id, 128) || null;
      emit('workspace.updated', { status: 'opened', workspaceId: activeId });
      return { activeId, workspace: projectWorkspace(result.workspace) };
    },
    'ui.workspace.create': async p => {
      const result = await workspace('workspace.create', {
        name: boundedText(p.name, 'name', 120), root: boundedText(p.root, 'root', 2048), createIfMissing: false
      });
      const view = projectWorkspace(result.workspace);
      emit('workspace.updated', { status: 'created' });
      return view;
    },
    'ui.memory.overview': async p => {
      const result = await memory('memory.overview', { query: string(p.query, 500), scope: string(p.scope, 120) || undefined, limit: Math.max(1, Math.min(200, Number(p.limit) || 100)) });
      return { memories: (result.memories ?? []).map(projectMemory), total: Number(result.meta?.total ?? result.memories?.length) || 0, candidates: (result.candidates ?? []).map(projectMemory) };
    },
    'ui.memory.get': async p => projectMemory(await memory('memory.get', { id: idParam(p) })),
    'ui.memory.create': async p => {
      const result = await memory('memory.create', {
        type: boundedText(p.type, 'type', 80), scope: boundedText(p.scope, 'scope', 120),
        content: boundedText(p.content, 'content', 8000), tags: boundedStrings(p.tags, 30, 100), pinned: p.pinned === true
      });
      emit('memory.updated', { status: 'created' });
      return projectMemory(result);
    },
    'ui.memory.update': async p => {
      const result = await memory('memory.update', { id: idParam(p), expectedRev: p.expectedRev, content: boundedText(p.content, 'content', 8000), tags: boundedStrings(p.tags, 30, 100), pinned: p.pinned === true });
      emit('memory.updated', { status: 'updated' });
      return projectMemory(result);
    },
    'ui.memory.pin': async p => {
      const result = await memory('memory.pin', { id: idParam(p), expectedRev: p.expectedRev, pinned: p.pinned === true });
      emit('memory.updated', { status: 'updated' });
      return projectMemory(result);
    },
    'ui.memory.delete': async p => {
      const result = await memory('memory.delete', { id: idParam(p), expectedRev: p.expectedRev });
      emit('memory.updated', { status: 'deleted' });
      return selected(result, ['id', 'deleted']);
    },
    'ui.agent.list': async () => ({ agents: (await agent('agent.list', {})).providers.map(projectAgent) }),
    'ui.agent.health': async p => projectAgent(await agent('agent.health', { provider: string(p.provider, 80) })),
    'ui.extensions.settings.describe': async p => {
      const result = record(await extensions('ext.settings.describe', { id: idParam(p) }));
      const fields = (Array.isArray(result.fields) ? result.fields : []).slice(0, 32).map(field => {
        const item = record(field);
        const type = ['boolean', 'string', 'number', 'enum', 'secretRef'].includes(item.type) ? item.type : 'string';
        return {
          key: string(item.key, 64), label: string(item.label, 100), type, required: item.required === true,
          ...(type === 'secretRef' ? {} : { default: scalar(item.default) }),
          options: boundedStrings(item.options, 50, 120),
          min: typeof item.min === 'number' && Number.isFinite(item.min) ? item.min : null,
          max: typeof item.max === 'number' && Number.isFinite(item.max) ? item.max : null,
          maxLength: Number.isSafeInteger(item.maxLength) ? item.maxLength : null
        };
      }).filter(field => field.key && field.label);
      return { id: string(result.id, 160), name: string(result.name, 160), available: fields.length > 0, fields };
    },
    'ui.extensions.settings.get': async p => {
      const id = idParam(p);
      const description = record(await extensions('ext.settings.describe', { id }));
      const fields = (Array.isArray(description.fields) ? description.fields : []).slice(0, 32);
      const result = await extensions('ext.settings.get', { id });
      return projectExtensionSettingsValues(result, fields);
    },
    'ui.extensions.settings.update': async p => {
      const id = idParam(p);
      const values = objectParams(p.values);
      await extensions('ext.settings.update', { id, values });
      emit('plugin.updated', { pluginId: id });
      const description = record(await extensions('ext.settings.describe', { id }));
      const fields = (Array.isArray(description.fields) ? description.fields : []).slice(0, 32);
      const result = await extensions('ext.settings.get', { id });
      return projectExtensionSettingsValues(result, fields);
    },
    'ui.plugins.catalog': async p => {
      const result = await plugins('plugin-center.catalog.list', { query: string(p.query, 200), category: string(p.category, 80), view: ['all', 'installed', 'recommended', 'update-available'].includes(p.view) ? p.view : 'all' });
      return { available: result.available === true, configured: result.configured === true, offline: result.offline === true, reason: string(result.reason ?? result.error, 300) || null, plugins: (result.plugins ?? []).map(projectPlugin) };
    },
    'ui.plugins.status': async () => {
      const result = await plugins('plugin-center.status', {});
      return { catalogAvailable: result.catalogAvailable === true, configured: result.configured === true, offline: result.offline === true, plugins: (result.plugins ?? []).map(projectPlugin), installed: (result.installed ?? []).map(projectPlugin) };
    },
    'ui.plugins.detail': async p => {
      const result = await plugins('plugin-center.catalog.detail', { id: idParam(p) });
      return { available: result.available === true, offline: result.offline === true, plugin: result.plugin ? projectPlugin(result.plugin) : null };
    },
    'ui.plugins.refresh': async () => {
      const result = await plugins('plugin-center.catalog.refresh', {});
      emit('plugin.updated', {});
      return selected(result, ['available', 'configured', 'offline', 'cachedAt', 'generatedAt', 'error']);
    },
    'ui.plugins.stage': async p => {
      const result = await plugins('plugin-center.package.stage', { id: idParam(p) });
      return { stageId: string(result.stageId, 128), plugin: projectPlugin(result.entry), requiresReview: result.requiresReview === true,
        installable: record(result.review?.review).installable === true,
        permissions: boundedStrings(result.review?.permissions ?? result.review?.review?.permissions, 40, 250),
        summary: boundedStrings(result.review?.summary, 30, 400), trust: string(result.trust?.level, 60) };
    },
    'ui.plugins.install': async p => {
      if (p.reviewed !== true) throw uiError('PERMISSION_REVIEW_REQUIRED', '安装前必须确认权限清单');
      const result = await plugins('plugin-center.package.install', { stageId: idParam(p, 'stageId'), reviewed: true });
      emit('plugin.updated', { pluginId: string(result.entry?.id, 160) });
      return { installed: true, plugin: projectPlugin(result.entry) };
    },
    'ui.plugins.disable': async p => {
      const result = await plugins('plugin-center.plugin.disable', { id: idParam(p) });
      emit('plugin.updated', { pluginId: p.id });
      return selected(result, ['id', 'status', 'disabled']);
    },
    'ui.plugins.enable.review': async p => {
      const id = idParam(p);
      try {
        const result = await plugins('plugin-center.plugin.enable.review', { id });
        const review = record(result.review);
        const details = record(review.review);
        const stageId = string(result.stageId, 128);
        if (stageId) enableReviewTokens.set(stageId, { id, token: string(details.token, 300) });
        return {
          id, stageId, requiresReview: result.requiresReview === true,
          installable: details.installable === true,
          permissions: boundedStrings(details.permissions, 40, 250),
          summary: boundedStrings(review.summary, 30, 400), trust: string(result.trust, 60)
        };
      } catch (error) {
        if (error?.code === 'PLUGIN_NOT_LOCAL_UNVERIFIED') return { id, stageId: '', requiresReview: false, installable: true, permissions: [], summary: [], trust: 'catalog-verified' };
        throw error;
      }
    },
    'ui.plugins.enable': async p => {
      const id = idParam(p);
      if (p.reviewed !== true) throw uiError('PERMISSION_REVIEW_REQUIRED', '启用前请完成权限复核');
      const stageId = string(p.stageId, 128);
      const review = enableReviewTokens.get(stageId);
      if (stageId && (!review || review.id !== id)) throw uiError('REVIEW_MISMATCH', '权限复核已失效，请重新查看权限清单');
      const result = await plugins('plugin-center.plugin.enable', {
        id, ...(stageId ? { stageId, reviewToken: review.token } : {}), reviewed: true
      });
      if (stageId) enableReviewTokens.delete(stageId);
      emit('plugin.updated', { pluginId: id });
      return selected(result, ['id', 'status', 'enabled']);
    },
    'ui.plugins.uninstall': async p => {
      const result = await plugins('plugin-center.plugin.uninstall', { id: idParam(p), keepFiles: p.keepFiles === true });
      emit('plugin.updated', { pluginId: p.id });
      return selected(result, ['id', 'status', 'uninstalled']);
    },
    'ui.plugins.integration.list': async () => ({ integrations: (await integrations('integrations.list', {})).integrations.map(row => ({ id: string(row.id, 120), name: string(row.displayName ?? row.name ?? row.id, 160), status: string(row.status, 60), enabled: row.enabled === true, available: row.available === true })) }),
    'ui.plugins.integration.settings': async p => {
      const result = await integrations('plugins.settings', { id: idParam(p) });
      const settingsView = record(result.settings);
      return {
        id: string(result.id ?? p.id, 120), name: string(result.name, 160),
        enabled: result.enabled === true, available: result.available !== false,
        tools: (result.tools ?? []).slice(0, 100).map(tool => ({ id: string(tool.id, 160), name: string(tool.name ?? tool.label ?? tool.id, 180), enabled: tool.enabled === true, available: tool.available !== false, permission: string(tool.permission, 100) })),
        settings: Object.fromEntries(Object.entries(settingsView).filter(([key]) => !SECRET_KEY.test(key) && !/(path|directory|root|cwd|folder|file)/i.test(key)).map(([key, value]) => [key.slice(0, 100), scalar(value)]))
      };
    },
    'ui.plugins.integration.manage': async p => {
      const id = idParam(p);
      const action = p.action === 'enable' ? 'enable' : p.action === 'disable' ? 'disable' : null;
      if (!action) throw uiError('INVALID_PARAMS', '未知集成操作');
      const result = await integrations(`plugins.${action}`, { id, approved: false });
      emit('plugin.updated', { pluginId: id });
      return selected(result, ['id', 'pluginId', 'status', 'enabled', 'approvalId', 'pending']);
    },
    'ui.plugins.integration.tool.toggle': async p => {
      const result = await integrations('plugins.tool.toggle', { pluginId: idParam(p, 'pluginId'), toolId: idParam(p, 'toolId'), enabled: p.enabled === true });
      emit('plugin.updated', { pluginId: p.pluginId });
      return selected(result, ['pluginId', 'toolId', 'enabled', 'status', 'approvalId']);
    },
    'ui.mcp.list': async () => ({ servers: (await integrations('mcp.list', {})).servers.map(projectMcpServer) }),
    'ui.mcp.tools': async p => ({ serverId: idParam(p), tools: ((await integrations('mcp.tools', { id: p.id })).tools ?? []).slice(0, 200).map(tool => ({ id: string(tool.id, 180), name: string(tool.name ?? tool.id, 180), description: string(tool.description, 500), enabled: tool.enabled === true })) }),
    'ui.mcp.manage': async p => {
      const action = ['enable', 'disable', 'start', 'stop', 'restart'].find(value => p.action === value);
      if (!action) throw uiError('INVALID_PARAMS', '未知 MCP 操作');
      const result = await integrations(`mcp.${action}`, { id: idParam(p, 'serverId') });
      emit('plugin.updated', { serverId: p.serverId });
      return selected(result, ['id', 'serverId', 'status', 'enabled', 'approvalId', 'pending']);
    },
    'ui.mcp.config.get': async p => {
      const result = await integrations('mcp.config.get', { serverId: idParam(p, 'serverId') });
      const config = record(result.config);
      return {
        id: string(result.id, 160), enabled: result.enabled === true,
        hasArgs: config.hasArgs === true,
        hasEnvironment: config.hasEnvironment === true,
        timeoutMs: Number.isSafeInteger(config.timeoutMs) ? config.timeoutMs : null,
        note: string(config.note, 500)
      };
    },
    'ui.mcp.config.update': async p => {
      const config = record(p.config);
      const safe = {};
      if (Object.hasOwn(config, 'timeoutMs')) {
        if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 300_000) throw uiError('INVALID_PARAMS', 'timeoutMs 必须在 100 到 300000 之间');
        safe.timeoutMs = config.timeoutMs;
      }
      if (Object.hasOwn(config, 'note')) safe.note = boundedText(config.note, 'note', 500);
      const result = await integrations('mcp.config.update', { serverId: idParam(p, 'serverId'), config: safe, approved: false });
      emit('plugin.updated', { serverId: p.serverId });
      return { id: string(result.id, 160), updatedKeys: Object.keys(safe) };
    },
    'ui.settings.describe': async () => {
      const result = await settings('settings.describe', {});
      return { sections: (result.sections ?? []).map(item => selected(item, ['section', 'label'])), fields: (result.fields ?? []).map(section => ({
        section: string(section.section, 60), label: string(section.label, 120), fields: (section.fields ?? []).map(field => ({
          key: string(field.key, 120), type: string(field.type, 40), default: SECRET_KEY.test(field.key) ? (field.default ? '[configured]' : '') : scalar(field.default),
          locked: field.locked === true, choices: boundedStrings(field.choices, 50, 100), min: scalar(field.min), max: scalar(field.max), description: string(field.description, 500)
        }))
      })) };
    },
    'ui.settings.get': async () => {
      const result = services.settingsService?.store?.get?.();
      if (!result) throw uiError('SERVICE_UNAVAILABLE', '设置服务当前不可用');
      return { settings: projectSettings(result.settings), revision: Number.isSafeInteger(result.rev) ? result.rev : null };
    },
    'ui.settings.update': async p => {
      const section = string(p.section, 60);
      if (!Object.hasOwn(SETTING_KEYS, section)) throw uiError('INVALID_PARAMS', '未知设置分区');
      const values = record(p.values);
      const allowed = new Set(SETTING_KEYS[section]);
      const safeValues = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key) && !SECRET_KEY.test(key)));
      const result = await settings('settings.update', { section, values: safeValues, expectedRev: p.expectedRev });
      emit('model.updated', { provider: section === 'models' ? string(result.settings?.models?.provider, 80) : undefined });
      return { settings: projectSettings(result.settings), revision: Number.isSafeInteger(result.rev) ? result.rev : null };
    },
    'ui.about.info': async () => projectAbout(await about('about.info', {})),
    'ui.feedback.links': async () => {
      const result = record(await call(system.product, 'product.feedbackLinks', {}));
      const links = record(result.links);
      return {
        configured: links.configured === true,
        entries: (Array.isArray(links.entries) ? links.entries : []).slice(0, 4).map(entry => {
          const item = record(entry);
          const url = string(item.url, 2048);
          return {
            id: string(item.id, 40), label: string(item.label, 120), description: string(item.description, 300),
            kind: item.kind === 'security' ? 'security' : 'feedback',
            url: url.startsWith('https://') ? url : null
          };
        }),
        securityNotice: string(links.securityNotice, 500),
        message: string(record(links.messages).notConfigured, 300)
      };
    },
    'ui.about.update': async () => {
      const result = await about('about.update', {});
      const view = record(result.update);
      return { currentVersion: string(view.currentVersion, 80) || null, latestVersion: string(view.latest?.version ?? view.latest, 80) || null,
        status: string(view.status, 40) || 'unknown', checkedAt: string(view.checkedAt, 80) || null,
        announcement: view.announcement ? { title: string(view.announcement.title, 300), notes: boundedStrings(view.announcement.notes, 80, 1000), publishedAt: string(view.announcement.publishedAt, 80) || null } : null,
        sources: (view.sources ?? []).slice(0, 4).map(item => selected(item, ['id', 'label', 'url', 'priority'])) };
    },
    'ui.update.capabilities': async () => selected(await update('update.capabilities', {}), ['canCheck', 'canDownloadVerifiedArtifact', 'canExecuteInstaller', 'sourcePriority', 'canShowAnnouncementOffline']),
    'ui.update.check': async () => {
      const result = await update('update.check', {});
      const status = string(result.status, 40) || (result.ok !== true ? 'error'
        : result.updateAvailable === true ? 'update_available'
          : result.reason === 'UP_TO_DATE' ? 'up_to_date' : 'checked');
      emit('update.status', { status });
      return { ...selected(result, ['ok', 'updateAvailable', 'currentVersion', 'latest', 'reason', 'code', 'message', 'source', 'publishedAt', 'notes']), status };
    },
    'ui.update.notes': async () => {
      const result = await update('update.notes', {});
      return { available: result.available === true, lastError: string(result.lastError, 300) || null,
        record: result.record ? { latest: string(result.record.latest, 80) || null, status: string(result.record.status, 40), checkedAt: string(result.record.checkedAt, 80) || null, announcement: result.record.announcement ? { title: string(result.record.announcement.title, 300), notes: boundedStrings(result.record.announcement.notes, 80, 1000) } : null } : null };
    },
    'ui.onboarding.status': async () => projectOnboarding(await onboarding('onboarding.status', {})),
    'ui.onboarding.start': async () => projectOnboarding(await onboarding('onboarding.start', {})),
    'ui.onboarding.completeStep': async p => projectOnboarding(await onboarding('onboarding.completeStep', { stepId: idParam(p, 'stepId'), data: record(p.data) })),
    'ui.onboarding.skipStep': async p => projectOnboarding(await onboarding('onboarding.skipStep', { stepId: idParam(p, 'stepId'), data: record(p.data) })),
    'ui.onboarding.finish': async () => projectOnboarding(await onboarding('onboarding.finish', {})),
    'ui.onboarding.testProvider': async p => {
      const input = record(p);
      const result = await onboarding('onboarding.testProvider', { provider: boundedText(input.provider, 'provider', 80), apiKey: boundedText(input.apiKey, 'apiKey', 500), baseUrl: string(input.baseUrl, 500) });
      return selected(result, ['ok', 'provider', 'status', 'code', 'message', 'connectionStepCompleted']);
    },
    'ui.onboarding.setModel': async p => selected(await onboarding('onboarding.setModel', { provider: boundedText(p.provider, 'provider', 80), model: boundedText(p.model, 'model', 200) }), ['provider', 'model', 'persisted']),
    'ui.approvals.list': async () => ({ approvals: ((await capability('capability.approval.list', {})).approvals ?? []).map(projectApproval) }),
    'ui.approvals.decide': async p => {
      const result = await capability('capability.approval.decide', { id: idParam(p), approve: p.approve === true });
      emit('approval.resolved', { approvalId: p.id, status: p.approve === true ? 'approved' : 'rejected' });
      return selected(result, ['status', 'approvalId', 'requestId', 'turnResumed', 'resumePending', 'resumeError', 'taskResumed']);
    },
    'ui.search': async p => {
      const query = boundedText(p.query, 'query', 200).trim();
      if (!query) return { sessions: [], tasks: [], plugins: [] };
      const [sessionRows, taskRows, pluginRows] = await Promise.all([
        chat('chat.sessions.list', {}), task('task.list', { query, limit: 20 }), plugins('plugin-center.catalog.list', { query, view: 'all' })
      ]);
      return {
        sessions: (sessionRows.sessions ?? []).filter(row => `${row.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 10).map(projectSession),
        tasks: (taskRows.tasks ?? []).slice(0, 10).map(projectTask),
        plugins: (pluginRows.plugins ?? []).slice(0, 10).map(projectPlugin)
      };
    }
  };

  return Object.freeze({
    eventNames: EVENT_NAMES,
    execute({ method, params, signal } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(uiError('METHOD_NOT_FOUND', '未知 Desktop UI 方法'));
      try { return Promise.resolve(handler(objectParams(params ?? {}), { signal })); }
      catch (error) { return Promise.reject(error); }
    }
  });
}
