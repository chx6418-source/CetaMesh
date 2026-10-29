import { DESKTOP_USER_PRINCIPAL } from '../memory/service.js';
import { buildCapabilityContext } from './capability-context.js';
import { projectProductContext } from './product-context.js';

function taskFromRuntime(taskRuntime, taskId) {
  if (typeof taskId !== 'string' || !taskId.trim()) return null;
  try {
    return taskRuntime?.get({ id: taskId }).task ?? null;
  } catch (error) {
    // A stale explicit Chat-to-Task link is simply unavailable; never widen to another Task.
    if (error?.code === 'TASK_NOT_FOUND') return null;
    throw error;
  }
}

function resolveMemoryReferences(memoryService, task, principal, onMemoryError = null) {
  if (!task || !Array.isArray(task.memoryRefs) || !memoryService?.runtime?.get) return [];
  const sourceScope = `task:${task.id}`;
  const resolved = [];
  for (const reference of task.memoryRefs.slice(0, 200)) {
    const memoryId = typeof reference?.memoryId === 'string' ? reference.memoryId : '';
    if (!memoryId) continue;
    try {
      const item = memoryService.runtime.get({ principal, id: memoryId }).memory;
      const expectedScope = reference.scope || sourceScope;
      if (item.scope !== expectedScope) continue;
      if (expectedScope !== sourceScope && reference.authorizedBy !== 'user:desktop') continue;
      if (memoryService.runtime.assess && memoryService.runtime.assess({principal,id:memoryId}).status !== 'current') continue;
      resolved.push({ memoryId, title: reference.note || item.type || 'Task Memory reference', excerpt: item.content, ...memoryReferenceMetadata(item) });
    } catch (error) {
      onMemoryError?.(error);
      continue;
    }
  }
  return resolved;
}

function automaticMemoryReferences(memoryService, settings, principal, scopes, query = '', onMemoryError = null) {
  if (settings?.enabled === false || !memoryService?.runtime) return [];
  const limit = Math.max(1, Math.min(200, Number(settings?.retrievalLimit) || 50));
  const rows = [];
  for (const scope of scopes) {
    try {
      const page = memoryService.runtime.retrieve({ principal, scope, query: String(query).slice(0, 200), limit });
      if(page.meta?.conflicted)onMemoryError?.({code:'MEMORY_FACT_REVIEW_REQUIRED',message:'Authorized memory contains conflicting fact identities'});
      rows.push(...page.memories);
    } catch (error) {
      // A denied or unavailable partition is omitted, never replaced by a wider scope.
      onMemoryError?.(error);
      continue;
    }
  }
  const needle = String(query).slice(0, 200).trim().toLowerCase();
  const grams = [...new Set((needle.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word => {
    const chars = Array.from(word);
    return chars.length > 2 ? [...chars.slice(1).map((_, index) => chars.slice(index, index + 2).join('')), word] : [word];
  }))];
  // Each partition ranks its own results. Re-rank the authorized union before
  // applying the shared limit, or an irrelevant User row can hide global Knowledge.
  const ranked = rows.map(row => ({ row, score: grams.reduce((sum, gram) =>
    sum + ((row.content + ' ' + (row.tags ?? []).join(' ')).toLowerCase().includes(gram) ? gram.length : 0), 0) }))
    .filter(({ score }) => grams.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || Number(b.row.pinned) - Number(a.row.pinned)
      || b.row.updatedAt - a.row.updatedAt || a.row.id.localeCompare(b.row.id));
  const output = [];
  // Charge one token per UTF-8 byte plus record overhead: a conservative bound without
  // depending on the selected provider's tokenizer.
  let remaining = 1200;
  for (const { row } of ranked) {
    const title = row.type + ' · ' + row.scope;
    const overhead = Buffer.byteLength(title, 'utf8') + 16;
    if (output.length >= limit || remaining <= overhead) break;
    let excerpt = '';
    let cost = 0;
    for (const char of row.content) {
      const bytes = Buffer.byteLength(char, 'utf8');
      if (excerpt.length + char.length > 500 || cost + bytes + overhead > remaining) break;
      excerpt += char;
      cost += bytes;
    }
    if (!excerpt) continue;
    remaining -= cost + overhead;
    output.push({ memoryId: row.id, title, excerpt, truncated: excerpt.length < row.content.length, ...memoryReferenceMetadata(row) });
  }
  return output;
}

function memoryReferenceMetadata(row) {
  return { scope: row.scope, revision: row.rev, source: row.source,
    provenance: row.provenance, createdAt: row.createdAt, updatedAt: row.updatedAt,
    sourceRefs: (row.sourceRefs ?? []).slice(0, 4) };
}

function boundMemoryReferences(references, settings) {
  const limit = Math.max(1, Math.min(200, Number(settings?.retrievalLimit) || 50));
  let remaining = 1200;
  const result = [];
  const seen = new Set();
  for (const item of references) {
    if (seen.has(item.memoryId)) continue;
    seen.add(item.memoryId);
    if (result.length >= limit) break;
    const title = String(item.title ?? 'Memory');
    const overhead = Buffer.byteLength(JSON.stringify({ ...item, excerpt: '' }), 'utf8') + 16;
    if (remaining <= overhead) break;
    let excerpt = '';
    for (const char of String(item.excerpt ?? '')) {
      const bytes = Buffer.byteLength(char, 'utf8');
      if (Buffer.byteLength(excerpt, 'utf8') + bytes + overhead > remaining) break;
      excerpt += char;
    }
    remaining -= Buffer.byteLength(excerpt, 'utf8') + overhead;
    result.push({ ...item, excerpt, truncated: item.truncated === true || excerpt.length < String(item.excerpt ?? '').length });
  }
  return result;
}

function extensionSummaries(extensionService) {
  const overview = extensionService?.runtime?.overview?.();
  return Array.isArray(overview?.extensions) ? overview.extensions : [];
}

function agentProviderSummaries(agentBroker) {
  const providers = agentBroker?.listProviders?.();
  if (!Array.isArray(providers)) return [];
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    availability: 'registered',
    health: 'unknown'
  }));
}

function registeredCapabilities(capabilityService) {
  return capabilityService?.broker?.list?.() ?? [];
}

function capabilityAvailabilityFromExtensions(extensions) {
  const availabilityByCapability = new Map();
  if (!Array.isArray(extensions)) return availabilityByCapability;

  for (const extension of extensions) {
    if (!extension || typeof extension.id !== 'string' || !Array.isArray(extension.capabilities)) continue;
    const runtimeState = typeof extension.runtimeState === 'string' ? extension.runtimeState : '';
    let availability;
    if (extension.status === 'enabled') {
      availability = ['crashed', 'unresponsive'].includes(runtimeState) || extension.health?.crashed === true
        ? 'unavailable'
        : extension.loaded === true && ['starting', 'running', 'healthy'].includes(runtimeState)
          ? 'available'
          : 'registered';
    } else if (extension.status === 'disabled' || extension.status === 'installed') {
      availability = 'disabled';
    } else {
      availability = 'unavailable';
    }

    for (const capability of extension.capabilities) {
      if (typeof capability !== 'string' || !capability) continue;
      availabilityByCapability.set(`extension.${extension.id}.${capability}`, availability);
    }
  }
  return availabilityByCapability;
}

function applyExtensionAvailability(registered, extensions) {
  const availabilityByCapability = capabilityAvailabilityFromExtensions(extensions);
  return (Array.isArray(registered) ? registered : []).map((capability) => {
    if (capability?.provider !== 'extension') return capability;
    return {
      ...capability,
      availability: availabilityByCapability.get(capability.id) ?? 'unavailable'
    };
  });
}

function serializeContext({
  mode,
  executionPath,
  record,
  routing,
  task,
  workspace,
  memoryReferences,
  modelProvider,
  model,
  requestedModel,
  resolvedModel,
  registered,
  grantedIds = [],
  requestableIds = [],
  extensionService,
  agentBroker,
  actorKind = 'owner',
  taskAvailable = Boolean(task),
  workspaceReconciliation = null,
  toolCalling = 'supported'
}) {
  const extensions = extensionSummaries(extensionService);
  const capabilities = buildCapabilityContext({
    registered: applyExtensionAvailability(registered, extensions),
    grantedIds,
    requestableIds,
    executionPath,
    actorKind,
    mode,
    taskAvailable,
    workspaceAvailable: Boolean(workspace),
    workspaceReconciliationRequired: workspaceReconciliation?.required === true,
    toolCalling
  });
  const projection = projectProductContext({
    mode,
    executionPath,
    session: { id: record?.id, modelProvider, model,
      requestedModel: requestedModel ?? (model ?? 'provider-default'),
      ...(typeof resolvedModel === 'string' && resolvedModel ? { resolvedModel } : {}) },
    routing,
    task,
    workspace,
    memoryReferences,
    capabilities,
    extensions,
    agentProviders: agentProviderSummaries(agentBroker),
    workspaceReconciliation,
    toolCalling
  });
  return {
    context: projection.serialized,
    serialized: projection.serialized,
    manifest: projection.manifest,
    truncated: projection.truncated,
    workspaceReconciliation,
    scope: { taskId: task?.id ?? null, workspaceId: workspace?.id ?? null }
  };
}

/** Resolves only explicitly linked runtime facts for Chat and a live Task Agent session. */
export function createProductContextService({
  taskRuntime,
  workspaceService,
  memoryService,
  capabilityService,
  extensionService,
  agentBroker,
  modelRuntime = null,
  memorySettings = () => ({ enabled: true, retrievalLimit: 50 }),
  onMemoryError = null
} = {}) {
  async function buildForChatTurn({ record, routing, modelProvider, model, requestedModel, resolvedModel, toolCalling, memoryQuery } = {}) {
    const source = record && typeof record === 'object' ? record : {};
    const task = taskFromRuntime(taskRuntime, source.taskId);
    const workspaceId = source.config?.workspaceId;
    const workspace = typeof workspaceId === 'string' && workspaceId.trim()
      ? workspaceService?.describeWorkspace(workspaceId) ?? null
      : null;
    const expectedWorkspaceId = task?.workspaceId ?? null;
    const observedWorkspaceId = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId : null;
    const workspaceReconciliation = task && expectedWorkspaceId !== observedWorkspaceId
      ? { required: true, status: 'required', expectedWorkspaceId, observedWorkspaceId,
        code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
      : task ? { required: false, status: 'resolved', expectedWorkspaceId, observedWorkspaceId }
        : null;
    const settings = memorySettings();
    const memoryReferences = settings.enabled === false ? [] : boundMemoryReferences([
      ...(task ? resolveMemoryReferences(memoryService, task, DESKTOP_USER_PRINCIPAL, onMemoryError) : []),
      ...automaticMemoryReferences(memoryService, settings, DESKTOP_USER_PRINCIPAL,
        ['user:desktop', 'global'], memoryQuery, onMemoryError)
    ], settings);

    return serializeContext({
      mode: source.config?.mode ?? 'chat',
      executionPath: 'chat',
      record: source,
      routing,
      task,
      workspace,
      memoryReferences,
      modelProvider,
      model,
      requestedModel,
      resolvedModel,
      registered: registeredCapabilities(capabilityService),
      extensionService,
      agentBroker,
      taskAvailable: Boolean(task),
      workspaceReconciliation,
      toolCalling: toolCalling ?? 'unsupported'
    });
  }

  async function buildForChat(request = {}) {
    return (await buildForChatTurn(request)).context;
  }

  async function buildForAgentTurn({ sessionId, provider = 'cetamesh', principal, modelProvider, model, requestedModel, resolvedModel, toolCalling } = {}) {
    const task = taskRuntime?.findByAgent?.({ provider, sessionId }) ?? null;
    const liveActor = task ? capabilityService?.principalForTask?.(task.id) : null;
    if (!task || !liveActor || !principal
      || principal.taskId !== task.id
      || (principal.expectedWorkspaceId ?? task.workspaceId) !== task.workspaceId
      || principal.actor?.id !== liveActor.id) {
      throw Object.assign(new Error('Managed Agent Task binding is no longer valid'), { code: 'AGENT_ASSIGNMENT_REQUIRED' });
    }

    const observedWorkspaceId = principal.workspaceId ?? null;
    const workspace = observedWorkspaceId ? workspaceService?.describeWorkspace(observedWorkspaceId) ?? null : null;
    const workspaceReconciliation = task.workspaceId !== observedWorkspaceId
      ? { required: true, status: 'required', expectedWorkspaceId: task.workspaceId, observedWorkspaceId,
        code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
      : { required: false, status: 'resolved', expectedWorkspaceId: task.workspaceId, observedWorkspaceId };
    const memoryPrincipal = capabilityService.memoryPrincipal(liveActor);
    const settings = memorySettings();
    const readOnlyChild = Boolean(task.parentTaskId && task.childContract?.mode === 'read-only');
    const agentMemoryScopes = readOnlyChild ? [`task:${task.id}`]
      : [`task:${task.id}`, `workspace:${task.workspaceId}`];
    // A Task may link individual global records. The Memory policy still limits
    // this partition to those exact Owner-authorized IDs; no default global grant.
    if (memoryPrincipal.grants?.scopes?.includes('global')) agentMemoryScopes.push('global');
    const memoryReferences = settings.enabled === false ? [] : boundMemoryReferences([
      ...resolveMemoryReferences(memoryService, task, memoryPrincipal, onMemoryError),
       ...(readOnlyChild ? [] : automaticMemoryReferences(memoryService, settings, memoryPrincipal,
         agentMemoryScopes, task.goal, onMemoryError))
    ], settings);
    const grantedIds = Array.isArray(liveActor.grants?.capabilities) ? liveActor.grants.capabilities : [];
    return serializeContext({
      mode: 'managed-agent',
      executionPath: 'managed-agent',
      record: { id: sessionId },
      task,
      workspace,
      memoryReferences,
      modelProvider,
      model,
      requestedModel,
      resolvedModel,
      registered: registeredCapabilities(capabilityService),
      grantedIds,
      requestableIds: grantedIds,
      extensionService,
      agentBroker,
      actorKind: 'agent',
      taskAvailable: true,
      workspaceReconciliation,
      toolCalling: toolCalling ?? 'unsupported'
    });
  }

  async function buildForAgent(request = {}) {
    return (await buildForAgentTurn(request)).context;
  }

  return { buildForChat, buildForChatTurn, buildForAgent, buildForAgentTurn };
}
