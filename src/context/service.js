import { DESKTOP_USER_PRINCIPAL } from '../memory/service.js';
import { buildCapabilityContext } from './capability-context.js';
import { buildProductContext } from './product-context.js';

const OMIT_MEMORY_ERRORS = new Set([
  'CROSS_SCOPE_LINK_REQUIRED',
  'MEMORY_NOT_FOUND',
  'SCOPE_NOT_AUTHORIZED',
  'TYPE_NOT_AUTHORIZED',
  'INVALID_REFERENCE'
]);

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

function resolveMemoryReferences(memoryService, task, principal) {
  if (!task || !Array.isArray(task.memoryRefs) || !memoryService?.runtime?.resolveReferences) return [];
  const sourceScope = `task:${task.id}`;
  const resolved = [];
  for (const reference of task.memoryRefs.slice(0, 8)) {
    const memoryId = typeof reference?.memoryId === 'string' ? reference.memoryId : '';
    if (!memoryId) continue;
    try {
      const result = memoryService.runtime.resolveReferences({
        principal,
        sourceScope,
        refs: [{ kind: 'memory', id: memoryId, scope: sourceScope }]
      });
      for (const item of result?.references ?? []) {
        if (item.status !== 'resolved') continue;
        resolved.push({
          memoryId: item.reference?.id ?? memoryId,
          title: reference.note || item.type || 'Task Memory reference',
          excerpt: item.summary ?? ''
        });
      }
    } catch (error) {
      if (OMIT_MEMORY_ERRORS.has(error?.code)) continue;
      throw error;
    }
  }
  return resolved;
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
  registered,
  grantedIds = [],
  requestableIds = [],
  extensionService,
  agentBroker
}) {
  const capabilities = buildCapabilityContext({
    registered,
    grantedIds,
    requestableIds,
    executionPath
  });
  return buildProductContext({
    mode,
    executionPath,
    session: { id: record?.id, modelProvider, model },
    routing,
    task,
    workspace,
    memoryReferences,
    capabilities,
    extensions: extensionSummaries(extensionService),
    agentProviders: agentProviderSummaries(agentBroker)
  });
}

/** Resolves only explicitly linked runtime facts for Chat and a live Task Agent session. */
export function createProductContextService({
  taskRuntime,
  workspaceService,
  memoryService,
  capabilityService,
  extensionService,
  agentBroker
} = {}) {
  async function buildForChat({ record, routing, modelProvider } = {}) {
    const source = record && typeof record === 'object' ? record : {};
    const task = taskFromRuntime(taskRuntime, source.taskId);
    const workspaceId = source.config?.workspaceId;
    const workspace = typeof workspaceId === 'string' && workspaceId.trim()
      ? workspaceService?.describeWorkspace(workspaceId) ?? null
      : null;
    const memoryReferences = task
      ? resolveMemoryReferences(memoryService, task, DESKTOP_USER_PRINCIPAL)
      : [];

    return serializeContext({
      mode: source.config?.mode ?? 'chat',
      executionPath: 'chat',
      record: source,
      routing,
      task,
      workspace,
      memoryReferences,
      modelProvider,
      model: source.config?.model,
      registered: registeredCapabilities(capabilityService),
      extensionService,
      agentBroker
    });
  }

  async function buildForAgent({ sessionId, provider = 'cetamesh', principal, modelProvider, model } = {}) {
    const task = taskRuntime?.findByAgent?.({ provider, sessionId }) ?? null;
    const liveActor = task ? capabilityService?.principalForTask?.(task.id) : null;
    if (!task || !liveActor || !principal
      || principal.taskId !== task.id
      || principal.workspaceId !== task.workspaceId
      || principal.actor?.id !== liveActor.id) {
      throw Object.assign(new Error('Managed Agent Task binding is no longer valid'), { code: 'AGENT_ASSIGNMENT_REQUIRED' });
    }

    const workspace = workspaceService?.describeWorkspace(task.workspaceId) ?? null;
    const memoryPrincipal = capabilityService.memoryPrincipal(liveActor);
    const memoryReferences = resolveMemoryReferences(memoryService, task, memoryPrincipal);
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
      registered: registeredCapabilities(capabilityService),
      grantedIds,
      requestableIds: grantedIds,
      extensionService,
      agentBroker
    });
  }

  return { buildForChat, buildForAgent };
}
