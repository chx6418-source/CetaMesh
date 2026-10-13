import { redactText } from '../logging/redact.js';

const AVAILABILITY_STATES = new Set(['available', 'registered', 'disabled', 'unavailable', 'unknown']);
const OPTIONAL_FIELDS = ['risk', 'source', 'grantState', 'category'];

function safeText(value, maxLength = 240) {
  if (typeof value !== 'string') return undefined;
  const cleaned = redactText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function idSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
}

function compareIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validSchema(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.type === 'object';
}

/**
 * Pure projection of a runtime capability snapshot into callable tool descriptors and
 * non-callable status facts. It performs no probes and never grants authority.
 */
export function buildCapabilityContext({
  registered = [],
  grantedIds = [],
  requestableIds = [],
  executionPath = 'chat',
  actorKind = 'owner',
  mode = 'chat',
  workspaceAvailable = true,
  taskAvailable = false,
  workspaceReconciliationRequired = false,
  toolCalling = 'supported',
  allowTools = true,
  maxCapabilities = 128
} = {}) {
  const granted = idSet(grantedIds);
  const explicitRequestable = idSet(requestableIds);
  const restrictedToRequestable = explicitRequestable.size > 0 || executionPath === 'managed-agent';
  const canCall = allowTools === true
    && toolCalling === 'supported'
    && !workspaceReconciliationRequired
    && ['chat', 'smart', 'task-agent', 'managed-agent'].includes(mode)
    && ['chat', 'managed-agent'].includes(executionPath);
  const byId = new Map();

  for (const item of Array.isArray(registered) ? registered : []) {
    if (!item || typeof item !== 'object') continue;
    const id = safeText(item.id, 160);
    if (!id || byId.has(id)) continue;

    const availabilityValue = safeText(item.availability, 40)?.toLowerCase();
    const availability = AVAILABILITY_STATES.has(availabilityValue)
      ? availabilityValue
      : item.available === false ? 'unavailable' : 'available';
    const description = safeText(item.description, 240);
    const inputSchema = validSchema(item.inputSchema) ? structuredClone(item.inputSchema) : null;
    const isGranted = actorKind === 'owner' ? true : granted.has(id);
    const explicitlyRequestable = !restrictedToRequestable || explicitRequestable.has(id);
    const scopeAllowed = (item.workspace !== true || workspaceAvailable === true)
      && (item.requiresTask !== true || taskAvailable === true);
    const callable = canCall
      && item.modelCallable !== false
      && item.available !== false
      && availability === 'available'
      && Boolean(description)
      && Boolean(inputSchema)
      && isGranted
      && explicitlyRequestable
      && scopeAllowed;
    const risk = safeText(item.risk, 40)?.toLowerCase();
    const descriptor = {
      id,
      available: callable,
      availability,
      granted: isGranted,
      requestable: callable
    };
    if (callable) {
      descriptor.description = description;
      descriptor.inputSchema = inputSchema;
      descriptor.requiresApproval = item.requiresApproval === true || ['high', 'critical'].includes(risk);
      for (const key of OPTIONAL_FIELDS) {
        const value = key === 'source'
          ? safeText(item.source ?? item.provider, 100)
          : safeText(item[key], key === 'category' ? 80 : 60);
        if (value) descriptor[key] = value;
      }
      if (actorKind !== 'owner') descriptor.grantState = 'granted';
      else descriptor.grantState = 'owner';
    } else {
      const reason = item.modelCallable === false ? 'not-model-callable'
        : item.requiresTask === true && taskAvailable !== true ? 'task-required'
        : item.workspace === true && workspaceAvailable !== true ? 'scope-unavailable'
        : workspaceReconciliationRequired ? 'workspace-reconciliation-required'
          : toolCalling !== 'supported' ? 'tool-calling-unsupported'
            : !description || !inputSchema ? 'descriptor-incomplete'
              : undefined;
      if (reason) descriptor.reason = reason;
    }
    byId.set(id, descriptor);
  }

  const rows = [...byId.values()].sort(compareIds);
  const maximum = Number.isSafeInteger(maxCapabilities) ? Math.max(0, Math.min(maxCapabilities, 128)) : 128;
  const manifest = rows.filter((item) => item.requestable).slice(0, maximum);
  const manifestIds = new Set(manifest.map((item) => item.id));
  const statusSummary = rows
    .filter((item) => !manifestIds.has(item.id))
    .map((item) => ({
      id: item.id,
      availability: item.availability,
      ...(item.reason ? { reason: item.reason } : {})
    }));
  const mcp = manifest
    .filter((item) => /^(?:mcp(?:[-:/.]|$)|mcp-adapter$)/i.test(item.source ?? ''))
    .map((item) => item.id);

  return {
    executionPath: safeText(executionPath, 80) ?? 'unknown',
    mode: safeText(mode, 80) ?? 'unknown',
    toolCalling: toolCalling === 'supported' ? 'supported' : 'unsupported',
    manifest,
    statusSummary,
    requestable: manifest.map((item) => item.id),
    mcp
  };
}
