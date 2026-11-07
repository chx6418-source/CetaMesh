import crypto from 'node:crypto';

// Local observations of the exact serialized request, not provider cache keys.
// No headers, credentials, message bodies, URLs or schema text leave this module.
export const MAX_REQUEST_DIAGNOSTICS = 64;
const HASH_FIELDS = ['requestHash', 'bodyHash', 'inputHash', 'providerHash', 'endpointHash', 'protocolHash', 'modelHash', 'responseModelHash', 'toolsHash', 'systemHash', 'historyHash', 'parametersHash'];
const COUNT_FIELDS = ['bodyBytes', 'messageCount', 'systemMessageCount', 'toolCount', 'imagePartCount'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const requestValueHash = value => hash(JSON.stringify(value));

export function safeRequestDiagnostics(value) {
  if (value?.version !== 1) return null;
  const result = { version: 1 };
  for (const field of HASH_FIELDS) {
    if (field === 'responseModelHash' && value[field] === null) { result[field] = null; continue; }
    if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field])) return null;
    result[field] = value[field];
  }
  for (const field of COUNT_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
    result[field] = value[field];
  }
  return result;
}

export function createRequestDiagnostics({ serializedBody, endpoint, providerId, protocol }) {
  const body = JSON.parse(serializedBody);
  // Userinfo is credential material. Query/path routing remains bound only by an
  // opaque digest; it is never copied into a receipt or user-facing projection.
  const route = new URL(endpoint);
  route.username = '';
  route.password = '';
  route.hash = '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systems = messages.filter(message => ['system', 'developer'].includes(message.role));
  const history = messages.filter(message => !['system', 'developer'].includes(message.role));
  const { model, messages: _messages, tools, tool_choice, ...parameters } = body;
  const bodyHash = hash(serializedBody);
  const providerHash = requestValueHash(providerId);
  const endpointHash = requestValueHash(route.href);
  const protocolHash = requestValueHash(protocol);
  return { version: 1,
    requestHash: requestValueHash({ providerHash, endpointHash, protocolHash, bodyHash }),
    bodyHash, inputHash: requestValueHash({ messages, tools, tool_choice }),
    providerHash, endpointHash, protocolHash, modelHash: requestValueHash(model), responseModelHash: null,
    toolsHash: requestValueHash(tools ?? []), systemHash: requestValueHash(systems), historyHash: requestValueHash(history),
    parametersHash: requestValueHash(parameters), bodyBytes: Buffer.byteLength(serializedBody, 'utf8'),
    messageCount: messages.length, systemMessageCount: systems.length,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    imagePartCount: messages.reduce((sum, message) => sum + (Array.isArray(message.content) ? message.content.filter(part => part?.type === 'image_url').length : 0), 0) };
}

// Bound only optional observations. All usage receipts and their attribution
// remain in the original ledger; an omission marker explains the retained scope.
export function boundRequestDiagnostics(receipts) {
  let retained = 0;
  for (let i = receipts.length - 1; i >= 0; i--) {
    if (!receipts[i].requestDiagnostics) continue;
    if (++retained > MAX_REQUEST_DIAGNOSTICS) {
      receipts[i] = { ...receipts[i], requestDiagnosticsOmitted: true };
      delete receipts[i].requestDiagnostics;
    }
  }
}

export function summarizeRequestDiagnostics(receipts) {
  const observed = receipts.map((receipt, index) => ({ receipt, index, diagnostics: safeRequestDiagnostics(receipt?.requestDiagnostics) }))
    .filter(item => item.diagnostics);
  const last = observed.at(-1);
  const latest = last?.index === receipts.length - 1 ? { ...last.diagnostics, requestId: last.receipt.requestId } : null;
  const prior = observed.at(-2);
  let changes = ['unknown'];
  if (latest) {
    if (receipts.length === 1) changes = ['first-request'];
    else if (prior && prior.index === last.index - 1) {
      const components = { providerHash: 'provider-changed', endpointHash: 'endpoint-changed', protocolHash: 'protocol-changed',
        modelHash: 'model-changed', responseModelHash: 'response-model-changed', toolsHash: 'tools-changed', systemHash: 'system-changed',
        historyHash: 'history-changed', parametersHash: 'parameters-changed' };
      changes = Object.entries(components).filter(([field]) => latest[field] !== prior.diagnostics[field]).map(([, code]) => code);
      if (!changes.length) changes = [latest.requestHash === prior.diagnostics.requestHash ? 'unchanged' : 'projection-changed'];
    }
  }
  const omittedRequests = receipts.filter(receipt => receipt.requestDiagnosticsOmitted === true && !safeRequestDiagnostics(receipt.requestDiagnostics)).length;
  return { totalRequests: receipts.length, retainedRequests: observed.length, omittedRequests,
    unreportedRequests: receipts.length - observed.length - omittedRequests,
    latest, comparedRequestId: latest && prior?.index === last.index - 1 ? prior.receipt.requestId : null, changes };
}
