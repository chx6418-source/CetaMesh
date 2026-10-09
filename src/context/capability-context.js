import { redactText } from '../logging/redact.js';

const AVAILABILITY_STATES = new Set([
  'registered',
  'available',
  'disabled',
  'unavailable',
  'unknown'
]);

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

function isMcpProvider(provider) {
  return typeof provider === 'string' && /^mcp(?:[-:/.]|$)/i.test(provider);
}

function compareIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Projects registry data into bounded, descriptive capability facts.
 * Requestability is only advertised for the managed-agent execution path and
 * requires both a live grant and an explicit requestable id.
 */
export function buildCapabilityContext({
  registered = [],
  grantedIds = [],
  requestableIds = [],
  executionPath = 'chat'
} = {}) {
  const granted = idSet(grantedIds);
  const allowedRequestable = idSet(requestableIds);
  const canRequest = executionPath === 'managed-agent';
  const byId = new Map();

  for (const item of Array.isArray(registered) ? registered : []) {
    if (!item || typeof item !== 'object') continue;
    const id = safeText(item.id, 160);
    if (!id || byId.has(id)) continue;

    const provider = safeText(item.provider, 100);
    const availabilityValue = safeText(item.availability, 40)?.toLowerCase();
    const availability = AVAILABILITY_STATES.has(availabilityValue)
      ? availabilityValue
      : 'unknown';
    const isGranted = granted.has(id);
    const requestable = canRequest
      && isGranted
      && allowedRequestable.has(id)
      && availability !== 'disabled'
      && availability !== 'unavailable';

    const descriptor = {
      id,
      granted: isGranted,
      requestable,
      availability
    };
    const permission = safeText(item.permission, 120);
    const risk = safeText(item.risk, 40);
    if (permission) descriptor.permission = permission;
    if (risk) descriptor.risk = risk;
    if (provider) descriptor.provider = provider;
    if (typeof item.workspace === 'boolean') descriptor.workspace = item.workspace;
    const label = safeText(item.label ?? item.name, 160);
    if (label) descriptor.label = label;

    byId.set(id, descriptor);
  }

  const descriptors = [...byId.values()].sort(compareIds);
  const requestableIdsOut = descriptors.filter((item) => item.requestable).map((item) => item.id);
  const mcp = descriptors.filter((item) => isMcpProvider(item.provider)).map((item) => item.id);

  return {
    executionPath: safeText(executionPath, 80) ?? 'unknown',
    registered: descriptors,
    mcp,
    requestable: requestableIdsOut
  };
}
