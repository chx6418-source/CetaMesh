import crypto from 'node:crypto';
import { LEGACY_RETIRED_TOOLS } from '../integrations/catalog.js';

// Narrow, renderer-safe DTO adapter for the privileged Desktop WebView.
// Business state stays in existing Core services; this module owns no persistent data.

const EVENT_NAMES = Object.freeze([
  'core.status', 'chat.updated', 'chat.streaming', 'task.updated', 'task.deleted',
  'chat.warning', 'agent.updated', 'workspace.updated', 'plugin.updated', 'plugin.downloadProgress', 'approval.pending',
  'approval.resolved', 'model.updated', 'memory.updated', 'update.status', 'device.updated'
]);

const EVENT_DATA_KEYS = Object.freeze([
  'sessionId', 'taskId', 'workspaceId', 'agentId', 'pluginId', 'serverId', 'approvalId', 'requestId', 'retryCount',
  'provider', 'status', 'progress', 'ready', 'needsAttention', 'delta', 'replaceText', 'message', 'reset', 'toolActivity', 'agentActivity'
]);

const SETTING_KEYS = Object.freeze({
  general: ['language', 'theme', 'startMinimized', 'confirmOnExit'],
  models: ['provider', 'defaultModel', 'reasoningEffort', 'openaiCompatibleToolCalling', 'openaiCompatibleReasoningEffort', 'streaming'],
  agents: ['defaultAgentPreset', 'defaultAgentProvider', 'allowBackgroundTurns', 'codexOpenAiEnvironmentAuthorized'],
  memory: ['enabled', 'requireConfirmationForLongTerm', 'defaultScope', 'retrievalLimit'],
  workspace: ['defaultWorkspaceId', 'boundaryEnforcement'],
  devices: ['meshEnabled', 'requireApprovalForRemoteCapabilities', 'presenceTtlMs'],
  extensions: ['allowLocalImport', 'developerMode', 'requireReviewApproval', 'maxInstalled'],
  security: ['redactLogs', 'auditRetention', 'allowedUpdateHosts'],
  updates: ['channel', 'autoCheck', 'manifestUrl', 'fallbackManifestUrl', 'pinnedPublicKey'],
  advanced: ['showEngineeringPages', 'logLevel', 'diagnosticsVerbosity']
});

// Only expose settings whose behavior is implemented in the Desktop runtime. Keep the
// persisted schema intact so an upgrade never discards an existing user's values.
const EDITABLE_SETTING_KEYS = Object.freeze({
  general: ['theme', 'startMinimized', 'confirmOnExit'],
  models: ['provider', 'defaultModel', 'reasoningEffort', 'openaiCompatibleToolCalling', 'openaiCompatibleReasoningEffort'],
  agents: ['defaultAgentProvider', 'codexOpenAiEnvironmentAuthorized'],
  memory: ['enabled', 'retrievalLimit'],
  workspace: [],
  devices: ['meshEnabled', 'presenceTtlMs'],
  extensions: ['developerMode'],
  security: ['allowedUpdateHosts'],
  updates: ['channel', 'manifestUrl', 'fallbackManifestUrl'],
  advanced: []
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
    updatedAt: scalar(row.updatedAt), archived: row.archived === true, taskId: string(row.taskId, 128) || null,
    config: {
      mode: string(config.mode, 40), modelProvider: string(config.modelProvider, 80) || null,
      model: string(config.model, 200), agentProvider: string(config.agentProvider, 80) || null,
      workspaceId: string(config.workspaceId, 128) || null
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
      status: ['pending', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled'].includes(tool.status) ? tool.status : 'failed',
      summary: string(tool.summary, 1000), durationMs: Number.isFinite(tool.durationMs) ? Math.max(0, tool.durationMs) : null
    };
  }) : [];
  const rawAgentActivity = record(row.agentActivity);
  const agentActivity = typeof rawAgentActivity.providerId === 'string' ? {
    providerId: string(rawAgentActivity.providerId, 80), label: string(rawAgentActivity.label, 180),
    status: row.error ? 'failed' : row.cancelled === true ? 'cancelled'
      : ['running', 'completed', 'cancelled', 'failed'].includes(rawAgentActivity.status) ? rawAgentActivity.status : 'running'
  } : null;
  return {
    id: string(row.id, 128), role, text: string(row.text, MAX_TEXT), at: scalar(row.at),
    requestId: string(row.requestId, 200) || null,
    attachments, toolActivity, agentActivity, error: row.error ? string(row.error, 1000) : null,
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
  const agentHistory = Array.isArray(row.agentHistory) ? row.agentHistory.slice(-100).map(item => {
    const agent = record(item);
    return { provider: string(agent.provider, 100), sessionId: string(agent.sessionId, 160),
      attachedAt: scalar(agent.attachedAt), detachedAt: scalar(agent.detachedAt), note: string(agent.note, 1000) };
  }) : [];
  const executionEvidence = Array.isArray(row.executionEvidence) ? row.executionEvidence.slice(-100).map(item => {
    const evidence = record(item);
    return { eventId: string(evidence.eventId, 240), capability: string(evidence.capability, 100),
      status: string(evidence.status, 40), tool: string(evidence.tool, 100) || null,
      exitCode: Number.isSafeInteger(evidence.exitCode) ? evidence.exitCode : null,
      filePath: string(evidence.filePath, 500) || null, taskRev: Number.isSafeInteger(evidence.taskRev) ? evidence.taskRev : null,
      at: scalar(evidence.at) };
  }) : [];
  return {
    id: string(row.id, 128), title: string(row.goal, 500), goal: string(row.goal, 2000),
    status: string(row.status, 40), currentPhase: string(row.currentPhase, 500),
    progress: { percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0, note: string(progress.note, 1000) },
    workspaceId: string(row.workspaceId, 128) || null,
    agent: currentAgent.provider ? string(currentAgent.provider, 100) : null,
    currentAgent: currentAgent.provider ? { provider: string(currentAgent.provider, 100), sessionId: string(currentAgent.sessionId, 160) } : null,
    createdAt: scalar(row.createdAt), updatedAt: scalar(row.updatedAt), rev: Number.isSafeInteger(row.rev) ? row.rev : null,
    checkpoint: checkpoint.summary ? { summary: string(checkpoint.summary, 2000), nextAction: string(checkpoint.nextAction, 500) } : null,
    result: result.summary ? { summary: string(result.summary, 4000) } : null,
    artifacts, agentHistory, executionEvidence,
    failure: row.failure ? { reason: string(record(row.failure).reason, 1000) } : null
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
        status: ['completed', 'skipped', 'current', 'pending'].includes(item.state) ? item.state : 'pending',
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
    title: string(memory.title ?? memory.content, 300), content: typeof memory.content === 'string' ? memory.content : string(memory.summary, 4000),
    summary: string(memory.summary ?? memory.content, 1200), tags: boundedStrings(memory.tags, 30, 100),
    pinned: memory.pinned === true, rev: Number.isSafeInteger(memory.rev) ? memory.rev : null,
    createdAt: scalar(memory.createdAt), updatedAt: scalar(memory.updatedAt)
  };
}

function projectMemoryCandidate(value) {
  const row = record(value);
  return { id: string(row.id, 128), status: string(row.status, 32), type: string(row.type, 80),
    scope: string(row.scope, 120), content: string(row.content, 4000), reason: string(row.reason, 500),
    proposedAt: scalar(row.proposedAt), memoryId: string(row.memoryId, 128) || null };
}

function projectDshPreset(value) {
  if (!value) return null;
  const row = record(value);
  return { purpose: string(row.purpose, 30), id: string(row.id, 100) || null,
    compatible: typeof row.compatible === 'boolean' ? row.compatible : null,
    loaded: typeof row.loaded === 'boolean' ? row.loaded : null,
    loadState: string(row.loadState, 30) || 'unknown', reason: string(row.reason, 160) || null,
    verification: string(row.verification, 80) || null };
}
function projectDshDiagnostic(value) {
  if (!value) return null;
  const row = record(value);
  return { stage: string(row.stage, 80), code: string(row.code, 80) || null,
    retryable: row.retryable === true, checkedAt: string(row.checkedAt, 80) || null };
}
function projectDshConfiguration(value) {
  if (!value) return null;
  const row = record(value);
  const selection = value => { const item = record(value); return { codingPreset: string(item.codingPreset, 100) || null,
    socialPreset: string(item.socialPreset, 100) || null, homeDir: string(item.homeDir, 4096) || null, baseUrl: string(item.baseUrl, 2048) || null }; };
  // This DTO is reachable only through Owner UI IPC, never the service-token data plane.
  return { version: row.version, revision: row.revision, activeRevision: row.activeRevision,
    pendingRevision: row.pendingRevision ?? null, restartRequired: row.restartRequired === true,
    source: string(row.source, 80), loadError: string(row.loadError, 80) || null,
    configFile: string(row.configFile, 4096) || null, pendingConfigFile: string(row.pendingConfigFile, 4096) || null, dataRoot: string(row.dataRoot, 4096) || null,
    homeSource: string(row.homeSource, 80), active: selection(row.active), pending: row.pending ? selection(row.pending) : null };
}

function projectAgent(value) {
  const row = record(value);
  const health = { ...row, ...record(row.health) };
  const desktop = record(row.desktopApp);
  const reason = string(health.reason ?? row.reason, 160);
  const lastError = string(row.lastError ?? health.lastError ?? health.message, 500) || null;
  const healthStatus = string(health.status, 50).toLowerCase();
  const readiness = `${reason} ${healthStatus} ${string(row.status, 50)}`;
  const id = string(row.id ?? row.provider, 80);
  const installed = typeof health.installed === 'boolean' ? health.installed
    : typeof row.installed === 'boolean' ? row.installed
      : id === 'dsh' ? null
      : /not[_-]installed|missing[_-]binary/i.test(readiness) ? false
        : row.available === true || /needs[_-]auth|credential|needs[_-]config/i.test(readiness) ? true : null;
  const authenticated = typeof health.authenticated === 'boolean' ? health.authenticated : null;
  const compatible = typeof health.compatible === 'boolean' ? health.compatible
    : typeof row.compatible === 'boolean' ? row.compatible : null;
  const available = typeof health.available !== 'boolean' && typeof row.available !== 'boolean' ? null
    : (row.available ?? health.available) === true && health.available !== false && installed !== false
    && authenticated !== false && compatible !== false;
  const workspaceBoundary = string(row.workspaceBoundary ?? health.workspaceBoundary, 80) || null;
  const requiresTask = ['capability-broker', 'staged-capability-broker', 'native-staged'].includes(workspaceBoundary);
  const boundaryUnverified = workspaceBoundary === 'unverified';
  const status = installed === false ? 'not-installed'
    : compatible === false || (id === 'codex' && health.sandboxCapable === false) ? 'not-supported'
    : id === 'codex' && health.sandboxCapable === null ? 'not-checked'
    : authenticated === false ? 'needs-setup'
    : boundaryUnverified && available ? 'descriptor-incomplete'
    : /unsupported|not[_-]supported/i.test(readiness) ? 'not-supported'
    : /not[_-]installed|missing[_-]binary/i.test(readiness) ? 'not-installed'
    : /setup|auth|credential|needs[_-]config/i.test(readiness) || (id === 'dsh' && health.ready === false && available) ? 'needs-setup'
        : row.available === false || health.available === false ? 'unavailable'
          : available ? 'ready' : 'not-checked';
  return {
    id, name: string(row.displayName ?? row.label ?? id, 120),
    role: id === 'codex' ? '代码与项目' : id === 'dsh' ? '通用研究与协作' : '开发辅助',
    description: id === 'codex' ? '理解项目、修改代码并检查结果。' : id === 'dsh' ? '处理资料、规划和跨工具工作流。' : '在可用时连接本地开发能力。',
    available, installed, authenticated, compatible, eligible: available === null ? null : available && !requiresTask && !boundaryUnverified,
    taskEligible: available === false ? false : available === null || (id === 'dsh' && typeof health.taskEligible !== 'boolean') ? null : available && installed !== false && authenticated !== false && requiresTask
      && health.taskEligible !== false && health.sessionCapable !== false && (id !== 'codex' || health.sandboxCapable !== false)
      && (id !== 'dsh' || health.taskEligible === true),
    configured: typeof health.configured === 'boolean' ? health.configured : null,
    reachable: typeof health.reachable === 'boolean' ? health.reachable : null,
    ready: typeof health.ready === 'boolean' ? health.ready : null,
    sessionCapable: typeof health.sessionCapable === 'boolean' ? health.sessionCapable : null,
    security: record(row.security ?? health.security ?? record(row.capabilities).security),
    readyForTask: health.readyForTask === true,
    sandboxCapable: typeof health.sandboxCapable === 'boolean' ? health.sandboxCapable : null,
    installKind: string(health.installKind, 40) || null, probePhase: string(health.probePhase, 40) || null,
    probeCode: string(health.probeCode, 80) || null, checkedAt: string(health.checkedAt, 80) || null,
    requiresStandaloneNode: health.requiresStandaloneNode === true,
    preset: projectDshPreset(health.preset),
    diagnostic: projectDshDiagnostic(health.diagnostic),
    configuration: projectDshConfiguration(row.configuration ?? health.configuration),
    reason: reason || (boundaryUnverified ? 'descriptor-incomplete' : available && requiresTask ? 'task-required' : null), lastError, workspaceBoundary, status, version: string(health.version ?? row.version, 80) || null,
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
    available: typeof row.available === 'boolean' ? row.available : Boolean(row.installedEntry || row.installed === true),
    configured: row.configured === true,
    eligible: typeof row.eligible === 'boolean' ? row.eligible : Boolean((row.installedEntry || row.installed === true) && row.enabled !== false),
    reason: string(row.reason ?? row.warning, 500) || null,
    lastError: string(row.lastError, 500) || null,
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
  const enabled = row.enabled === true;
  const running = row.status === 'running';
  const toolCount = Number.isFinite(row.toolCount) ? Math.max(0, row.toolCount) : null;
  const discoveredToolCount = Number.isFinite(row.discoveredToolCount) ? Math.max(0, row.discoveredToolCount) : 0;
  const available = enabled && running && row.callable === true && discoveredToolCount > 0;
  return {
    id: string(row.id ?? row.serverId, 160), name: string(row.name ?? row.displayName ?? row.id, 200),
    status: string(row.status, 60), enabled, running, available, toolCallable: available,
    toolCount, discoveredToolCount,
    transport: string(row.transport, 40),
    source: string(row.source, 40) || 'external',
    configured: record(row.config).hasArgs === true || record(row.config).hasEnvironment === true,
    eligible: available,
    reason: string(row.lastError, 500) || (!enabled ? 'server-disabled' : !running ? 'server-stopped' : !available ? 'no-callable-tools' : null),
    lastError: string(row.lastError, 500) || null
  };
}

function projectIntegration(value) {
  const row = record(value);
  const local = record(row.localService);
  const provider = record(row.provider);
  const integration = record(row.integrationStatus);
  const agent = record(row.agentIntegration);
  const status = string(row.status ?? local.status ?? integration.status ?? agent.status, 60);
  const enabled = row.enabled === true || integration.enabled === true;
  const available = row.available === true || integration.available === true || row.agentAvailable === true;
  const reason = local.status
    ? !local.installed ? 'not-installed' : !local.configured ? 'needs-setup' : local.ready ? null : local.running ? 'start-timeout' : 'stopped'
    : string(row.reason ?? agent.reason ?? provider.lastError ?? integration.lastError, 500) || (enabled && !available ? 'provider-unavailable' : null);
  return {
    id: string(row.id, 120), name: string(row.displayName ?? row.name ?? row.id, 160), status, enabled, available,
    eligible: enabled && available, configured: local.configured === true || provider.configured === true,
    reason, lastError: string(local.lastError ?? provider.lastError ?? integration.lastError, 500) || null
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

function projectWorkshopProposal(value) {
  const row = record(value);
  const plan = record(row.plan);
  const workspace = record(plan.workspace);
  const review = record(row.review);
  const provision = record(row.provision);
  return {
    id: string(row.id, 128), title: string(row.title, 200), description: string(row.description, 2000),
    requirements: boundedStrings(row.requirements, 50, 1000),
    supplements: Array.isArray(row.supplements) ? row.supplements.slice(0, 50).map(item => ({
      id: string(item.id, 128), text: string(item.text, 1000) })) : [],
    submitter: { kind: string(row.submitter?.kind, 30), id: string(row.submitter?.id, 200) },
    status: string(row.status, 40), review: row.review ? { decision: string(review.decision, 30),
      reason: string(review.reason, 2000), at: scalar(review.at) } : null,
    plan: row.plan ? { workspace: { name: string(workspace.name, 100), root: string(workspace.root, 1024) },
      provider: string(plan.provider, 100), capabilities: boundedStrings(plan.capabilities, 30, 100) } : null,
    workspaceId: string(row.workspaceId, 128) || null, taskId: string(row.taskId, 128) || null,
    errorCode: string(provision.error?.code, 100) || null,
    artifacts: Array.isArray(row.artifacts) ? row.artifacts.slice(0, 100).map(item => ({
      id: string(item.id, 128), label: string(item.label, 200), mediaType: string(item.mediaType, 100),
      deliveredAt: scalar(item.deliveredAt) })) : [],
    createdAt: scalar(row.createdAt), updatedAt: scalar(row.updatedAt)
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
  const instanceId = crypto.randomUUID();
  let cursor = 0;
  const events = [];
  const waiters = new Set();

  function after(afterCursor) {
    const rows = events.filter(event => event.cursor > afterCursor);
    if (!rows.length) return { instanceId, events: [], cursor };
    const selectedRows = rows.slice(0, 100);
    return { instanceId, events: selectedRows, cursor: selectedRows[selectedRows.length - 1].cursor };
  }

  function publish(event, data = {}) {
    if (!EVENT_NAMES.includes(event)) return false;
    const input = record(data);
    const safe = {};
    for (const key of EVENT_DATA_KEYS) {
      if (!Object.hasOwn(input, key)) continue;
      const value = input[key];
      if (typeof value === 'string') safe[key] = value.slice(0, key === 'replaceText' ? MAX_TEXT : key === 'delta' ? 32_000 : 200);
      else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === 'boolean') safe[key] = value;
      else if (key === 'toolActivity' && Array.isArray(value)) safe[key] = value.slice(-32).map(activity => {
        const row = record(activity);
        return {
          id: string(row.id, 200), label: string(row.label ?? row.capability, 180),
          status: string(row.status, 50), summary: string(row.summary, 500),
          durationMs: Number.isFinite(row.durationMs) ? Math.max(0, row.durationMs) : null
        };
      });
      else if (key === 'agentActivity' && value === null) safe[key] = null;
      else if (key === 'agentActivity' && value && typeof value === 'object' && !Array.isArray(value)) {
        const row = record(value);
        if (typeof row.providerId === 'string') safe[key] = {
          providerId: string(row.providerId, 80), label: string(row.label, 180),
          status: ['running', 'completed', 'cancelled', 'failed'].includes(row.status) ? row.status : 'running'
        };
      }
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

  return Object.freeze({ instanceId, publish, next, eventNames: EVENT_NAMES });
}

export function createDesktopUiService({ services = {}, system = services.systemServices ?? services.system ?? {}, eventBus } = {}) {
  const owner = Object.freeze({ kind: 'owner', id: 'desktop' });
  const call = async (service, method, params = {}, withActor = false, signal = undefined) => {
    if (!service || typeof service.execute !== 'function') throw uiError('SERVICE_UNAVAILABLE', '此项能力当前不可用');
    return service.execute({ method, params, ...(withActor ? { actor: owner } : {}), ...(signal ? { signal } : {}) });
  };
  const emit = (event, data) => eventBus?.publish(event, data);
  const chat = (method, params, signal) => call(services.chatService, method, params, false, signal);
  const task = (method, params) => call(services.taskService, method, params);
  const workshop = (method, params) => call(services.workshopService, method, params, true);
  const memory = (method, params) => call(services.memoryService, method, params);
  const agent = (method, params) => call(services.agentService, method, params);
  const continuity = (method, params) => call(services.continuityService, method, params, true);
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
  const taskCreateDispatches = new Map();

  async function requireTaskProvider(provider, workspaceId) {
    if (!provider) throw uiError('AGENT_PROVIDER_SELECTION_REQUIRED', '请选择任务执行者');
    if (!services.workspaceService.describeWorkspace(workspaceId)) {
      throw uiError('WORKSPACE_NOT_FOUND', '任务工作区不存在或不可访问');
    }
    const boundary = services.agentBroker.capabilities(provider)?.workspaceBoundary;
    if (!['capability-broker', 'staged-capability-broker', 'native-staged'].includes(boundary)) {
      throw uiError('AGENT_BOUNDARY_UNSUPPORTED', '所选 Agent 没有经过验证的工作区权限边界');
    }
    const health = await services.agentBroker.health(provider);
    if (health?.available !== true || health?.installed === false || health?.authenticated === false
      || health?.sessionCapable === false) {
      throw uiError('PROVIDER_UNAVAILABLE', `所选 Agent ${provider} 未安装、未认证或无法建立会话`);
    }
    if (provider === 'codex' && health.sandboxCapable === false) {
      throw uiError('CODEX_SANDBOX_UNAVAILABLE', 'Codex Windows 工作区沙箱已拒绝执行');
    }
    return provider;
  }

  async function runTask(taskRow, { provider, content, requestId, modelProvider, model } = {}) {
    if (!taskRow.workspaceId) throw uiError('TASK_WORKSPACE_REQUIRED', '任务需要绑定工作区才能启动 Agent');
    if (/approval-pending/i.test(taskRow.progress?.note ?? '')) {
      const approvalPending = services.capabilityService.broker.approvals.list()
        .some(row => row.request?.taskId === taskRow.id);
      if (approvalPending || services.toolExecutionCoordinator?.recoveryForTask(taskRow.id)?.state === 'approval-pending') {
        throw uiError('APPROVAL_RECOVERY_REQUIRED', '请先在审批中心决定或取消重启前的审批');
      }
      taskRow = services.taskService.runtime.setProgress({ id: taskRow.id, expectedRev: taskRow.rev,
        note: 'Task interrupted after Core restart; verify Workspace and checkpoint before resuming' });
    }
    if (/needs-reconciliation|approval-pending/i.test(taskRow.progress?.note ?? '')) {
      throw uiError('NEEDS_RECONCILIATION', '请先核对重启前的工具副作用或审批；不能自动恢复执行');
    }
    if (taskRow.status === 'blocked' && /Owner reviewed interrupted effect/i.test(taskRow.progress?.note ?? '') && !content) {
      throw uiError('TASK_RECOVERY_INSTRUCTION_REQUIRED', '请给出核对后的新指令，不能重放中断前的工作');
    }
    let recoveryFacts = '';
    if (taskRow.status === 'blocked' && /interrupted after Core restart/i.test(taskRow.progress?.note ?? '')) {
      const status = await capability('capability.execute', { capability: 'git.status',
        taskId: taskRow.id, workspaceId: taskRow.workspaceId, input: {}, reason: 'Verify Task Workspace before recovery' });
      if (status.status !== 'completed') {
        throw uiError('TASK_RECOVERY_REVIEW_REQUIRED', '工作区状态无法核验，请检查后再恢复任务');
      }
      if (status.result?.isRepo !== true) {
        throw uiError('TASK_RECOVERY_REVIEW_REQUIRED',
          '非 Git 工作区需要 Owner 核对文件和先前操作，在任务详情填写核对结果及新指令后恢复');
      }
      const diff = await capability('capability.execute', { capability: 'git.diff',
        taskId: taskRow.id, workspaceId: taskRow.workspaceId, input: { statOnly: true }, reason: 'Verify Task diff before recovery' });
      if (diff.status !== 'completed') {
        throw uiError('TASK_RECOVERY_REVIEW_REQUIRED', 'Git 改动无法核验，请检查后再恢复任务');
      }
      recoveryFacts = `\n[Workspace recovery verification]\n${JSON.stringify({ status: status.result, diff: diff.result }).slice(0, 8000)}`;
    }
    const selectedProvider = await requireTaskProvider(provider || taskRow.currentAgent?.provider, taskRow.workspaceId);
    // Work has no model picker. Snapshot Owner defaults only for an unbound
    // Managed Task; explicit/native and persisted per-Task models keep priority.
    if (selectedProvider === 'cetamesh' && !modelProvider && !model
      && !taskRow.modelConfig?.modelProvider && !taskRow.modelConfig?.model) {
      const defaults = services.settingsService?.store.get().settings.models;
      modelProvider = string(defaults?.provider, 80) || undefined;
      model = string(defaults?.defaultModel, 160) || undefined;
    }
    const wasPaused = ['paused', 'waiting', 'blocked'].includes(taskRow.status);
    if (wasPaused) {
      // A resumed Agent can execute tools immediately. Persist the running Task
      // state before dispatch so the Task-bound Capability Broker sees one owner.
      taskRow = (await task('task.resume', { id: taskRow.id, expectedRev: taskRow.rev })).task;
    }
    let current;
    try {
      const result = await capability('capability.execute', { capability: 'agent.run',
        taskId: taskRow.id, workspaceId: taskRow.workspaceId, requestId,
        input: { agentProvider: selectedProvider,
          content: (content || [taskRow.goal, ...(taskRow.requirements ?? []),
            taskRow.checkpoint?.summary ?? '', taskRow.checkpoint?.nextAction ?? ''].filter(Boolean).join('\n')) + recoveryFacts,
          ...(modelProvider ? { modelProvider } : {}), ...(model ? { model } : {}) },
        reason: 'Desktop Owner Task execution' });
      if (result.status !== 'completed' || result.result?.accepted !== true) {
        throw uiError('AGENT_SEND_REJECTED', 'Agent 未接受任务指令');
      }
      current = (await task('task.get', { id: taskRow.id })).task;
    } catch (error) {
      if (wasPaused) {
        try {
          const latest = (await task('task.get', { id: taskRow.id })).task;
          if (latest.status === 'running') {
            const blocked = await task('task.block', { id: latest.id, expectedRev: latest.rev,
              reason: 'needs-reconciliation: Agent dispatch failed during Resume; verify prior effects before retrying' });
            emit('task.updated', { taskId: blocked.task.id, status: blocked.task.status });
          }
        } catch (recoveryError) {
          emit('task.warning', { taskId: taskRow.id, code: recoveryError?.code ?? 'TASK_ROLLBACK_FAILED' });
        }
      }
      throw error;
    }
    emit('task.updated', { taskId: current.id, status: current.status });
    return current;
  }

  async function stopTask(taskRow, { cancelMissingManagedSession = false } = {}) {
    if (services.continuityService?.runtime?.isInFlight(taskRow.id)) {
      throw uiError('TASK_HANDOFF_IN_FLIGHT', '任务正在交接执行者，暂不能暂停或取消');
    }
    if (!taskRow.currentAgent) return;
    try {
      await services.agentBroker.cancel(taskRow.currentAgent);
    } catch (error) {
      // Managed Sessions exist only in this Core's memory. After restart, an explicit
      // Owner cancellation may end the persisted Task even when its old Session is gone.
      // External providers and uncertain transport failures still require a stop proof.
      if (!cancelMissingManagedSession || error?.code !== 'SESSION_NOT_FOUND') throw error;
      if (taskRow.currentAgent.provider === 'cetamesh') return;
      // Missing external Sessions alone are not stop ACKs. The built-in Codex
      // adapter can verify only its persisted, post-process/pre-import failure.
      // All unknown effects, approvals and incomplete Handoffs remain fenced.
      const recovery = services.capabilityService?.recoveryForTask;
      const approvals = services.capabilityService?.broker?.approvals;
      const toolRecovery = services.toolExecutionCoordinator?.recoveryForTask;
      const provider = services.agentBroker.require?.(taskRow.currentAgent.provider);
      if (typeof recovery !== 'function' || typeof approvals?.list !== 'function'
          || typeof toolRecovery !== 'function' || typeof provider?.verifyStoppedTask !== 'function'
          || recovery(taskRow.id) || toolRecovery(taskRow.id)
          || approvals.list().some(row => row.request?.taskId === taskRow.id)) throw error;
      const proof = await provider.verifyStoppedTask({ taskId: taskRow.id,
        workspaceId: taskRow.workspaceId, sessionId: taskRow.currentAgent.sessionId });
      if (proof?.stopped !== true || proof.taskId !== taskRow.id
          || proof.workspaceId !== taskRow.workspaceId || proof.provider !== taskRow.currentAgent.provider
          || proof.sessionId !== taskRow.currentAgent.sessionId) throw error;
    }
  }

  const handlers = {
    'ui.workshop.proposals': async p => {
      const result = await workshop('workshop.proposal.list', { limit: Math.max(1, Math.min(200, Number(p.limit) || 100)) });
      return { proposals: (result.proposals ?? []).map(projectWorkshopProposal), total: Number(result.total) || 0 };
    },
    'ui.workshop.proposal': async p => ({ proposal: projectWorkshopProposal((await workshop('workshop.proposal.get', { id: idParam(p) })).proposal) }),
    'ui.workshop.review': async p => {
      if (typeof p.approve !== 'boolean') throw uiError('INVALID_PARAMS', '需要明确的审查决定');
      const result = await workshop('workshop.proposal.review', { id: idParam(p), approve: p.approve,
        reason: string(p.reason, 2000), ...(p.approve ? { plan: record(p.plan) } : {}) });
      return { proposal: projectWorkshopProposal(result.proposal) };
    },
    'ui.workshop.retry': async p => ({ proposal: projectWorkshopProposal((await workshop('workshop.proposal.retry', { id: idParam(p) })).proposal) }),
    'ui.workshop.task.status': async p => workshop('workshop.task.status', { id: idParam(p) }),
    'ui.workshop.deliver': async p => {
      if (p.approve !== true) throw uiError('INVALID_PARAMS', '交付需要 Owner 明确批准');
      const result = await workshop('workshop.artifact.deliver', { id: idParam(p), approve: true,
        label: boundedText(p.label, 'label', 200), mediaType: boundedText(p.mediaType ?? 'text/plain', 'mediaType', 100),
        content: boundedText(p.content, 'content', 1024 * 1024), requestId: string(p.requestId, 200) });
      return { proposal: projectWorkshopProposal(result.proposal), artifact: { id: string(result.artifact?.id, 128),
        label: string(result.artifact?.label, 200) } };
    },
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
      const result = await chat('chat.history', {
        id: idParam(p), limit: p.limit, beforeMessageId: p.beforeMessageId, afterMessageId: p.afterMessageId
      });
      return {
        id: string(result.id, 128), total: Number(result.total) || 0,
        messages: (result.messages ?? []).map(projectMessage),
        nextBeforeMessageId: string(result.nextBeforeMessageId, 128) || null,
        hasMore: result.hasMore === true
      };
    },
    'ui.chat.status': async p => {
      const result = await chat('chat.status', { id: idParam(p) });
      const turn = record(result.turn);
      return {
        id: string(result.id, 128), taskId: string(result.taskId, 128) || null,
        state: string(turn.state ?? result.lastState, 40),
        requestId: string(turn.requestId, 200) || null,
        followState: string(result.followState, 40) || 'idle', followError: string(result.followError, 100) || null,
        retryCount: Number.isFinite(turn.retryCount) ? Math.max(0, turn.retryCount) : 0,
        statusMessage: string(turn.statusMessage, 300) || null,
        displayText: string(turn.displayText, MAX_TEXT), error: string(turn.error ?? result.lastError, 1000) || null,
        errorCode: string(turn.errorCode ?? result.lastErrorCode, 100) || null,
        agentActivity: turn.agentActivity && typeof turn.agentActivity === 'object' ? {
          providerId: string(turn.agentActivity.providerId, 80), label: string(turn.agentActivity.label, 180),
          status: ['running', 'completed', 'cancelled', 'failed'].includes(turn.agentActivity.status) ? turn.agentActivity.status : 'running'
        } : null,
        toolActivity: (Array.isArray(turn.toolActivity) ? turn.toolActivity : []).slice(-32).map(item => ({
          id: string(item.id, 200), label: string(item.label ?? item.capability, 180),
          status: string(item.status, 50), summary: string(item.summary, 500),
          durationMs: Number.isFinite(item.durationMs) ? Math.max(0, item.durationMs) : null
        })),
        approvalId: string(turn.approvalId, 128) || null, approvalExpiresAt: scalar(turn.approvalExpiresAt),
        routing: selected(turn.routing ?? result.lastRouting, ['modelProvider', 'requestedModel', 'resolvedModel', 'toolCalling', 'taskId', 'blockingTaskId'])
      };
    },
    'ui.chat.send': async (p, { signal } = {}) => {
      const text = boundedText(p.text, 'text', 32_000);
      const attachments = Array.isArray(p.attachments) ? p.attachments.slice(0, 8).map((item, index) => {
        const attachment = record(item);
        if (/\.(?:png|jpe?g|gif|webp|bmp|ico|svg|pdf|mp[34]|wav|ogg|zip)$/i.test(string(attachment.name, 200))
          || (attachment.mimeType && !/^text\/(?:plain|markdown|csv|html|css|javascript|typescript|xml|x-python|x-shellscript)$/i.test(string(attachment.mimeType, 80)))) {
          throw uiError('UNSUPPORTED_ATTACHMENT', '当前仅支持文本和源码附件；图片与富媒体尚不可发送给模型');
        }
        return { name: boundedText(attachment.name, `attachments[${index}].name`, 200), content: boundedText(attachment.content, `attachments[${index}].content`, 256_000), ...(attachment.mimeType ? { mimeType: string(attachment.mimeType, 80) } : {}) };
      }) : [];
      const clientMessageId = p.clientMessageId === undefined ? undefined : boundedText(p.clientMessageId, 'clientMessageId', 128);
      const result = await chat('chat.send', { id: idParam(p), text, attachments, ...(clientMessageId ? { clientMessageId } : {}) }, signal);
      emit('chat.updated', { sessionId: p.id });
      return selected(result, ['userMessageId', 'requestId']);
    },
    'ui.chat.stop': async p => selected(await chat('chat.stop', { id: idParam(p) }), ['stopped', 'state', 'reason']),
    'ui.chat.retry': async p => selected(await chat('chat.retry', { id: idParam(p) }), ['userMessageId', 'requestId']),
    'ui.chat.continue': async p => selected(await chat('chat.continue', { id: idParam(p) }), ['continued', 'requestId']),
    'ui.chat.catalog': async p => {
      const result = await chat('chat.catalog', { refresh: p.refresh === true });
      return {
        models: (result.models ?? []).map(item => selected(item, ['id', 'label', 'provider'])),
        modelProviders: (result.modelProviders ?? []).map(item => ({
          id: string(item.id, 80), label: string(item.label, 120), configured: item.configured === true || item.hasKey === true,
          catalogState: string(item.catalogState, 40) || 'unknown', reachable: typeof item.reachable === 'boolean' ? item.reachable : null,
          authenticated: typeof item.authenticated === 'boolean' ? item.authenticated : null,
          inferencing: typeof item.inferencing === 'boolean' ? item.inferencing : null,
          toolCalling: item.toolCalling === true, error: string(item.error, 300) || null,
          settingsFields: (item.settingsFields ?? []).slice(0, 50).map(field => ({
            key: string(field.key, 80), label: string(field.label, 120), type: string(field.type, 20),
            ...(Array.isArray(field.choices) ? { choices: boundedStrings(field.choices, 50, 120) } : {}),
            ...(Number.isFinite(field.min) ? { min: field.min } : {}),
            ...(Number.isFinite(field.max) ? { max: field.max } : {})
          })),
          models: (item.models ?? []).map(value => selected(value, ['id', 'name', 'label', 'owned_by', 'toolCalling', 'streaming', 'reasoning']))
        })),
        agentProviders: (result.agentProviders ?? []).map(projectAgent),
        modes: boundedStrings(result.modes, 10, 40), defaultModelProvider: string(result.defaultModelProvider, 80) || null,
        available: !result.error, reason: string(result.error, 300) || null
      };
    },
    'ui.chat.config.set': async p => {
      const input = record(p.config);
      const config = {};
      for (const key of ['mode', 'modelProvider', 'model', 'agentProvider', 'reasoning', 'workspaceId']) {
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
      const goal = boundedText(p.goal, 'goal', 2000);
      const workspaceId = string(p.workspaceId, 128) || null;
      const requirements = boundedStrings(p.requirements, 50, 1000);
      const agentProvider = string(p.agentProvider, 80) || null;
      const requestId = string(p.requestId, 160) || null;
      const prior = services.taskService.runtime.findByCreateRequestId({ requestId, goal, requirements,
        workspaceId, requestedAgentProvider: agentProvider });
      if (prior) {
        if (prior.status === 'queued' && !prior.currentAgent) {
          const inFlight = requestId ? taskCreateDispatches.get(requestId) : null;
          if (inFlight) return { task: projectTask(await inFlight) };
          throw uiError('TASK_DISPATCH_INCOMPLETE', 'Task 已保存但 Agent 派发未确认；请在任务详情核对后启动');
        }
        return { task: projectTask(prior) };
      }
      const existing = workspaceId ? services.taskService.runtime.findByGoalWorkspace({ goal, workspaceId }) : null;
      if (existing) {
        if (existing.status === 'queued' && !existing.currentAgent) {
          throw uiError('TASK_DISPATCH_INCOMPLETE', '同目标 Task 尚未确认派发；请核对后显式启动');
        }
        if (requirements.length && JSON.stringify(requirements) !== JSON.stringify(existing.requirements)) {
          throw uiError('TASK_REQUIREMENTS_CONFLICT', 'Matching active Task has different requirements');
        }
        if (['paused', 'blocked', 'waiting'].includes(existing.status)) {
          throw uiError('TASK_RECOVERY_REVIEW_REQUIRED', 'Matching Task requires explicit recovery, not a duplicate creation');
        }
        if (agentProvider && existing.currentAgent && existing.currentAgent.provider !== agentProvider) {
          throw uiError('AGENT_PROVIDER_SWITCH_REQUIRES_CONTINUITY', 'Existing Task must switch Agent through Handoff');
        }
        return { task: projectTask(existing) };
      }
      if (workspaceId && services.taskService.runtime.activeWorkspaceOwner({ workspaceId })) {
        throw uiError('TASK_WORKSPACE_BUSY', 'Another Task owns write execution in this Workspace');
      }
      if (workspaceId) await requireTaskProvider(agentProvider, workspaceId);
      const raced = workspaceId ? services.taskService.runtime.findByGoalWorkspace({ goal, workspaceId }) : null;
      if (raced) {
        if (raced.status === 'queued' && !raced.currentAgent) {
          const inFlight = raced.createRequest?.id ? taskCreateDispatches.get(raced.createRequest.id) : null;
          if (inFlight && requestId === raced.createRequest.id) return { task: projectTask(await inFlight) };
          throw uiError('TASK_DISPATCH_INCOMPLETE', '同目标 Task 尚未确认派发；请核对后显式启动');
        }
        if (requirements.length && JSON.stringify(requirements) !== JSON.stringify(raced.requirements)) {
          throw uiError('TASK_REQUIREMENTS_CONFLICT', 'Matching active Task has different requirements');
        }
        if (['paused', 'blocked', 'waiting'].includes(raced.status)) throw uiError('TASK_RECOVERY_REVIEW_REQUIRED', 'Matching Task requires explicit recovery');
        if (agentProvider && raced.currentAgent && raced.currentAgent.provider !== agentProvider) {
          throw uiError('AGENT_PROVIDER_SWITCH_REQUIRES_CONTINUITY', 'Existing Task must switch Agent through Handoff');
        }
        return { task: projectTask(raced) };
      }
      if (workspaceId && services.taskService.runtime.activeWorkspaceOwner({ workspaceId })) {
        throw uiError('TASK_WORKSPACE_BUSY', 'Another Task owns write execution in this Workspace');
      }
      const created = services.taskService.runtime.create({ goal, requirements, workspaceId,
        note: string(p.note, 1000), requestId, requestedAgentProvider: agentProvider });
      const dispatch = created.workspaceId ? runTask(created, { provider: agentProvider,
        requestId: requestId || undefined, modelProvider: string(p.modelProvider, 80) || undefined,
        model: string(p.model, 160) || undefined }) : Promise.resolve(created);
      if (requestId) taskCreateDispatches.set(requestId, dispatch);
      let current;
      try { current = await dispatch; }
      finally { if (requestId && taskCreateDispatches.get(requestId) === dispatch) taskCreateDispatches.delete(requestId); }
      emit('task.updated', { taskId: current.id, status: current.status });
      return { task: projectTask(current) };
    },
    'ui.task.start': async p => {
      const current = (await task('task.get', { id: idParam(p) })).task;
      if (p.expectedRev !== undefined && current.rev !== p.expectedRev) throw uiError('TASK_CONFLICT', '任务已被其他操作修改');
      if (current.status !== 'queued') throw uiError('TASK_NOT_QUEUED', '只有待启动任务可以启动；请查看当前任务状态');
      return { task: projectTask(await runTask(current, { provider: string(p.agentProvider, 80) || undefined,
        requestId: string(p.requestId, 160) || undefined })) };
    },
    'ui.task.pause': async p => {
      const current = (await task('task.get', { id: idParam(p) })).task;
      if (p.expectedRev !== undefined && current.rev !== p.expectedRev) throw uiError('TASK_CONFLICT', '任务已被其他操作修改');
      await stopTask(current);
      const result = await task('task.pause', { id: current.id, expectedRev: current.rev, reason: string(p.reason, 1000) });
      emit('task.updated', { taskId: result.task?.id, status: result.task?.status });
      return { task: projectTask(result.task) };
    },
    'ui.task.resume': async p => {
      const current = (await task('task.get', { id: idParam(p) })).task;
      if (p.expectedRev !== undefined && current.rev !== p.expectedRev) throw uiError('TASK_CONFLICT', '任务已被其他操作修改');
      if (!['paused', 'waiting', 'blocked'].includes(current.status)) throw uiError('TASK_NOT_RESUMABLE', '任务当前不能恢复');
      return { task: projectTask(await runTask(current, { requestId: string(p.requestId, 160) || undefined })) };
    },
    'ui.task.reconcile': async p => {
      const current = (await task('task.get', { id: idParam(p) })).task;
      if (p.expectedRev !== undefined && current.rev !== p.expectedRev) throw uiError('TASK_CONFLICT', '任务已被其他操作修改');
      if (!/needs-reconciliation|interrupted after Core restart/i.test(current.progress?.note ?? '')) {
        throw uiError('TASK_RECOVERY_NOT_REQUIRED', '任务当前没有待核对的中断副作用');
      }
      if (p.reviewed !== true || !string(p.reviewSummary, 1000).trim()
        || !string(p.nextInstruction, 32_000).trim() || !string(p.requestId, 160).trim()) {
        throw uiError('INVALID_PARAMS', '需要明确核对结果、新指令和唯一请求 ID');
      }
      if (!services.workspaceService.describeWorkspace(current.workspaceId)) {
        throw uiError('WORKSPACE_NOT_FOUND', '任务工作区不存在或不可访问');
      }
      const recoveryProvider = string(p.provider, 80).trim() || current.currentAgent?.provider;
      if (current.currentAgent && recoveryProvider !== current.currentAgent.provider) {
        throw uiError('TASK_HANDOFF_REQUIRED', '仍绑定执行者的任务需要通过正式交接切换 Agent');
      }
      await requireTaskProvider(recoveryProvider, current.workspaceId);
      services.agentBroker.assertExecutionConsent?.(recoveryProvider, { workspaceId: current.workspaceId });
      const status = await capability('capability.execute', { capability: 'git.status',
        taskId: current.id, workspaceId: current.workspaceId, input: {}, reason: 'Owner reconciliation Workspace check' });
      if (status.status !== 'completed') throw uiError('WORKSPACE_RECONCILIATION_REQUIRED', '无法核对工作区状态');
      if (status.result?.isRepo === true) {
        const diff = await capability('capability.execute', { capability: 'git.diff',
          taskId: current.id, workspaceId: current.workspaceId, input: { statOnly: true }, reason: 'Owner reconciliation diff check' });
        if (diff.status !== 'completed') throw uiError('WORKSPACE_RECONCILIATION_REQUIRED', '无法核对工作区改动');
      }
      if (current.currentAgent) {
        try { await services.agentBroker.cancel(current.currentAgent); }
        catch (error) { if (error?.code !== 'SESSION_NOT_FOUND') throw error; }
        try {
          const oldStatus = await services.agentBroker.status(current.currentAgent);
          if (oldStatus?.running !== false) {
            throw uiError('TASK_RECOVERY_REVIEW_REQUIRED', '旧 Agent 未确认停止，不能启动新指令');
          }
        } catch (error) { if (error?.code !== 'SESSION_NOT_FOUND') throw error; }
      }
      services.continuityService?.runtime?.acknowledgeTransactionRecovery?.(current.id);
      services.toolExecutionCoordinator?.acknowledgeTaskRecovery(current.id);
      services.capabilityService.acknowledgeTaskRecovery(current.id);
      const decision = services.taskService.runtime.addDecision({ id: current.id, expectedRev: current.rev,
        decision: 'Owner reviewed interrupted effect', rationale: string(p.reviewSummary, 1000).trim() });
      const reviewed = services.taskService.runtime.setProgress({ id: current.id, expectedRev: decision.rev,
        note: `Owner reviewed interrupted effect: ${string(p.reviewSummary, 1000).trim()}` });
      const resumed = await runTask(reviewed, { provider: recoveryProvider, content: string(p.nextInstruction, 32_000).trim(),
        requestId: string(p.requestId, 160).trim() });
      return { task: projectTask(resumed) };
    },
    'ui.task.cancel': async p => {
      const current = (await task('task.get', { id: idParam(p) })).task;
      if (p.expectedRev !== undefined && current.rev !== p.expectedRev) throw uiError('TASK_CONFLICT', '任务已被其他操作修改');
      await stopTask(current, { cancelMissingManagedSession: true });
      const result = await task('task.cancel', { id: current.id, expectedRev: current.rev, reason: string(p.reason, 1000) });
      emit('task.updated', { taskId: result.task?.id, status: result.task?.status });
      return { task: projectTask(result.task) };
    },
    'ui.task.handoff': async p => {
      const current = (await task('task.get', { id: idParam(p) })).task;
      if (p.expectedRev !== undefined && current.rev !== p.expectedRev) throw uiError('TASK_CONFLICT', '任务已被其他操作修改');
      if (!current.currentAgent) throw uiError('TASK_AGENT_REQUIRED', '任务尚无可交接的执行者');
      const targetProvider = boundedText(p.targetProvider, 'targetProvider', 80).trim();
      if (!targetProvider || targetProvider === current.currentAgent.provider) throw uiError('INVALID_PARAMS', '请选择不同的目标 Agent');
      const result = await continuity('continuity.rollover', { taskId: current.id, targetProvider, reason: 'provider-switch' });
      const updated = (await task('task.get', { id: current.id })).task;
      emit('task.updated', { taskId: updated.id, status: updated.status });
      return { task: projectTask(updated), handoff: { success: Boolean(result.to?.sessionId), from: result.from, to: result.to } };
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
      const result = await memory('memory.overview', { query: string(p.query, 200), scope: string(p.scope, 120) || undefined,
        types: Array.isArray(p.types) ? p.types.slice(0, 8) : undefined,
        offset: Math.max(0, Math.min(20000, Number(p.offset) || 0)),
        limit: Math.max(1, Math.min(200, Number(p.limit) || 100)) });
      return { memories: (result.memories ?? []).map(projectMemory), total: Number(result.meta?.total ?? result.memories?.length) || 0,
        candidates: (result.candidates ?? []).map(projectMemoryCandidate), candidateMeta: result.candidateMeta, recovery: result.recovery };
    },
    'ui.memory.candidates.confirm': async p => {
      const result = await memory('memory.candidates.confirm', { id: idParam(p), decision: string(p.decision, 16),
        ...(p.content === undefined ? {} : { content: boundedText(p.content, 'content', 4000) }) });
      emit('memory.updated', { status: string(p.decision, 16) });
      return { candidate: projectMemoryCandidate(result.candidate), memory: result.memory ? projectMemory(result.memory) : null };
    },
    'ui.memory.candidates.confirmBatch': async p => {
      const result = await memory('memory.candidates.confirmBatch', { ids: boundedStrings(p.ids, 50, 128), decision: string(p.decision, 16) });
      emit('memory.updated', { status: 'batch-decided' });
      return { results: result.results.map(row => ({ id: string(row.id, 128),
        ...(row.error ? { error: { code: string(row.error.code, 80), message: string(row.error.message, 300) } } : {}) })) };
    },
    'ui.memory.get': async p => projectMemory(await memory('memory.get', { id: idParam(p) })),
    'ui.memory.create': async p => {
      const result = await memory('memory.create', {
        type: boundedText(p.type, 'type', 80), scope: boundedText(p.scope, 'scope', 120),
        content: boundedText(p.content, 'content', 4000), tags: boundedStrings(p.tags, 30, 100), pinned: p.pinned === true
      });
      emit('memory.updated', { status: 'created' });
      return projectMemory(result);
    },
    'ui.memory.update': async p => {
      const result = await memory('memory.update', { id: idParam(p), expectedRev: p.expectedRev, content: boundedText(p.content, 'content', 4000), tags: boundedStrings(p.tags, 30, 100), pinned: p.pinned === true });
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
    'ui.agent.security': async p => {
      const workspaceId = string(p.workspaceId, 160);
      if (!services.workspaceService.describeWorkspace(workspaceId)) throw uiError('WORKSPACE_NOT_FOUND', 'Registered Workspace required');
      return services.agentBroker.describeExecutionSecurity(string(p.provider, 80), workspaceId);
    },
    'ui.agent.authorize': async p => {
      const workspaceId = string(p.workspaceId, 160), provider = string(p.provider, 80);
      const scope = services.agentBroker.describeExecutionSecurity(provider, workspaceId);
      if (string(p.fingerprint, 128) !== scope.fingerprint) throw uiError('AGENT_SECURITY_POLICY_CHANGED', 'Agent policy changed; review again');
      const result = await capability('capability.execute', { capability: 'agent.execution.authorize', workspaceId,
        input: { provider, fingerprint: scope.fingerprint }, reason: scope.disclosure.slice(0, 1000) });
      emit('approval.pending', { approvalId: result.approvalId });
      return selected(result, ['status', 'approvalId', 'expiresAt']);
    },
    'ui.agent.list': async () => ({ agents: (await agent('agent.list', {})).providers.map(projectAgent) }),
    'ui.agent.health': async p => projectAgent(await agent('agent.health', { provider: string(p.provider, 80), refresh: p.refresh === true })),
    'ui.agent.presets': async p => {
      if (p.provider !== 'dsh') throw uiError('INVALID_PARAMS', 'Preset discovery is available for DSH only');
      const result = await agent('agent.presets.list', { provider: 'dsh', homeDir: p.homeDir });
      return { state: string(result.state, 30), truncated: result.truncated === true,
        presets: (result.presets ?? []).slice(0, 200).map(row => ({ id: string(row.id, 100), compatible: row.compatible === true, reason: string(row.reason, 100) || null })) };
    },
    'ui.agent.configure': async p => {
      if (string(p.agentId ?? p.provider, 80) !== 'dsh') throw Object.assign(new Error('Unsupported connector'), { code: 'INVALID_PARAMS' });
      if (!p.config || typeof p.config !== 'object' || Array.isArray(p.config)) throw uiError('INVALID_PARAMS', 'DSH configuration must be an object');
      const result = await agent('agent.configure', { provider: 'dsh', settings: p.config });
      return { provider: 'dsh', supported: result.supported === true, applied: false, restartRequired: result.restartRequired === true, configuration: projectDshConfiguration(result.configuration) };
    },
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
      const [result, integrationResult, mcpResult] = await Promise.all([
        plugins('plugin-center.status', {}), integrations('integrations.list', {}), integrations('mcp.list', {})
      ]);
      return { catalogAvailable: result.catalogAvailable === true, configured: result.configured === true, offline: result.offline === true, developerMode: result.developerMode === true,
        plugins: (result.plugins ?? []).map(projectPlugin), installed: (result.installed ?? []).map(projectPlugin),
        integrations: (integrationResult.integrations ?? []).map(projectIntegration), mcp: (mcpResult.servers ?? []).map(projectMcpServer) };
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
    'ui.plugins.stage-local': async p => {
      const result = await plugins('plugin-center.developer.stageLocal', { file: boundedText(p.file, 'file', 4096) });
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
        if (error?.code === 'PLUGIN_NOT_LOCAL_UNVERIFIED') return { id, stageId: '', requiresReview: false, installable: true, permissions: [], summary: [], trust: 'catalog-sha256-only' };
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
    'ui.plugins.integration.list': async () => ({ integrations: ((await integrations('integrations.list', {})).integrations ?? []).map(projectIntegration) }),
    'ui.plugins.integration.settings': async p => {
      const id = idParam(p);
      const result = await integrations('plugins.settings', { id });
      const settingsView = record(result.settings);
      const rawTools = (result.tools ?? []).slice(0, 100);
      const tools = rawTools.map(tool => {
        const item = record(tool);
        const restore = ['restored', 'partial', 'deprecated', 'legacy-unsupported'].includes(item.restore) ? item.restore : 'unknown';
        return {
          id: string(item.id, 160), name: string(item.name ?? item.label ?? item.id, 180),
          enabled: item.enabled === true, available: item.available === true,
          restorable: item.restorable === true && ['restored', 'partial'].includes(restore),
          restore, reason: string(item.reason, 500), risk: string(item.risk, 40), permission: string(item.permission, 100)
        };
      });
      const registeredToolIds = new Set(tools.map(tool => tool.id));
      const isBionicToolPack = id === 'cetamesh-bionic-chat';
      const legacyRetired = isBionicToolPack ? LEGACY_RETIRED_TOOLS.map(tool => {
        const replacementInfo = record(tool.replacement);
        const replacementId = string(replacementInfo.toolId, 160);
        return {
          id: string(tool.id, 160), name: string(tool.name, 120), feature: string(tool.feature, 240),
          restore: tool.restore === 'legacy-unsupported' ? 'legacy-unsupported' : 'deprecated',
          reason: string(tool.reason, 500),
          replacement: replacementId && registeredToolIds.has(replacementId)
            ? { id: replacementId, label: string(replacementInfo.label, 160) }
            : null
        };
      }) : [];
      const inventory = isBionicToolPack ? {
        restored: tools.filter(tool => tool.restore === 'restored').length,
        partial: tools.filter(tool => tool.restore === 'partial').length,
        legacyUnsupported: tools.filter(tool => tool.restore === 'legacy-unsupported').length
      } : null;
      return {
        id: string(result.id ?? id, 120), name: string(result.name, 160),
        enabled: result.enabled === true, available: result.available !== false, tools, inventory, legacyRetired,
        localService: result.localService ? (() => {
          const local = record(result.localService);
          return {
            status: string(local.status, 60) || 'not-checked',
            installed: local.installed === true, running: local.running === true, ready: local.ready === true,
            configured: local.configured === true, version: string(local.version, 100) || null,
            httpUrl: string(local.httpUrl, 500) || null, wsUrl: string(local.wsUrl, 500) || null,
            accessTokenConfigured: local.accessTokenConfigured === true,
            lastError: string(local.lastError, 500) || null,
            actions: boundedStrings(result.actions, 10, 40)
          };
        })() : null,
        settings: Object.fromEntries(Object.entries(settingsView).filter(([key]) => !SECRET_KEY.test(key) && !/(path|directory|root|cwd|folder|file)/i.test(key)).map(([key, value]) => [key.slice(0, 100), scalar(value)]))
      };
    },
    'ui.plugins.integration.action': async p => {
      const service = idParam(p, 'localService');
      const action = ['detect', 'start', 'stop', 'install', 'configure'].find(value => p.action === value);
      if (!/^[a-z0-9._-]{1,80}$/i.test(service) || !action) throw uiError('INVALID_PARAMS', '未知集成本地服务操作');
      const raw = record(p.params);
      const params = action === 'configure' ? {
        httpUrl: boundedText(raw.httpUrl, 'OneBot HTTP 地址', 500),
        wsUrl: boundedText(raw.wsUrl, 'OneBot WebSocket 地址', 500),
        ...(typeof raw.accessToken === 'string' ? { accessToken: raw.accessToken.slice(0, 512) } : {}),
        ...(raw.clearAccessToken === true ? { clearAccessToken: true } : {})
      } : {};
      const result = await integrations('integrations.action', { localService: service, action, params, approved: false });
      emit('plugin.updated', { pluginId: service });
      const local = record(result);
      return selected(local, ['status', 'installed', 'running', 'ready', 'configured', 'version', 'lastError', 'approvalId', 'pending']);
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
    'ui.mcp.tools': async p => ({ serverId: idParam(p), tools: ((await integrations('mcp.tools', { id: p.id })).tools ?? []).slice(0, 200).map(tool => ({ id: string(tool.id, 180), name: string(tool.name ?? tool.id, 180), description: string(tool.description, 500), enabled: tool.enabled === true, discovered: tool.discovered === true, callable: tool.callable === true })) }),
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
        section: string(section.section, 60), label: string(section.label, 120), fields: (section.fields ?? [])
          .filter(field => EDITABLE_SETTING_KEYS[section.section]?.includes(field.key)).map(field => ({
          key: string(field.key, 120), type: string(field.type, 40), default: SECRET_KEY.test(field.key) ? (field.default ? '[configured]' : '') : scalar(field.default),
          locked: field.locked === true, choices: boundedStrings(field.choices, 50, 100), min: scalar(field.min), max: scalar(field.max), description: string(field.description, 500)
        }))
      })) };
    },
    'ui.settings.get': async () => {
      const result = services.settingsService?.store?.get?.();
      if (!result) throw uiError('SERVICE_UNAVAILABLE', '设置服务当前不可用');
      return { settings: projectSettings(result.settings), revision: Number.isSafeInteger(result.revision) ? result.revision : null,
        recoveryRequired: result.recoveryRequired === true, lastError: result.lastError ? string(result.lastError, 500) : null,
        backupPath: result.backupPath ? string(result.backupPath, 1000) : null };
    },
    'ui.settings.update': async p => {
      const section = string(p.section, 60);
      if (!Object.hasOwn(SETTING_KEYS, section)) throw uiError('INVALID_PARAMS', '未知设置分区');
      const values = record(p.values);
      const allowed = new Set(EDITABLE_SETTING_KEYS[section]);
      if (Object.keys(values).some(key => !allowed.has(key))) throw uiError('SETTING_NOT_IMPLEMENTED', '此设置尚无运行时效果');
      const safeValues = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key) && !SECRET_KEY.test(key)));
      const expectedRevision = p.expectedRevision ?? p.expectedRev;
      const result = await settings('settings.update', { section, values: safeValues, expectedRev: expectedRevision });
      emit('model.updated', { provider: section === 'models' ? string(result.settings?.models?.provider, 80) : undefined });
      return { settings: projectSettings(result.settings), revision: Number.isSafeInteger(result.revision) ? result.revision : null };
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
      const result = await onboarding('onboarding.testProvider', { provider: boundedText(input.provider, 'provider', 80), apiKey: boundedText(input.apiKey, 'apiKey', 500), baseUrl: string(input.baseUrl, 500), model: string(input.model, 120) });
      return selected(result, ['ok', 'provider', 'status', 'code', 'phase', 'configured', 'reachable', 'authenticated', 'inferencing', 'message', 'connectionStepCompleted']);
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

