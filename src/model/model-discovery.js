// Bounded, same-origin Model Provider catalog discovery. Provider payloads and
// transport errors are untrusted: only normalized model facts leave this module.
export const MODEL_CATALOG_VERSION = 'model-catalog-v1';
const PROFILES = new Set(['openai-compatible-v1', 'openai-chat-v1', 'deepseek-chat-v1']);
export function modelDiscoveryError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function normalizeModelBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw modelDiscoveryError('MODEL_DISCOVERY_INVALID', 'Model connection requires a valid service address'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw modelDiscoveryError('MODEL_DISCOVERY_INVALID', 'Model service address must use HTTPS or local loopback HTTP without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

export function safeModelIdentifier(value, credential = '') {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 256
    && !/[\x00-\x20\x7f]/.test(value.trim()) && !(credential && value.includes(credential)) ? value.trim() : null;
}

// Observations have a narrower contract than provider wire identifiers. Keep
// namespaced model names, while private routes, absolute paths and credentials
// remain unknown rather than becoming telemetry/history values.
export function safeObservationModelIdentifier(value, credential = '') {
  const id = safeModelIdentifier(value, credential);
  if (!id || /:\/\//.test(id) || /^(?:https?|file|ftp|ssh|data|mailto|wss?):/i.test(id)
    || /^(?:[A-Za-z]:|[\\/]|~[\\/])/.test(id) || /[\\?#]/.test(id)
    || (credential && id.includes(encodeURIComponent(credential)))) return null;
  return id;
}

function pathsFor(base, paths) {
  const url = new URL(base);
  const candidates = paths ?? [`${url.pathname.replace(/\/$/, '')}/models`, '/v1/models', '/models'];
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) {
    throw modelDiscoveryError('MODEL_DISCOVERY_INVALID', 'Model discovery accepts at most three reviewed endpoint paths');
  }
  return [...new Set(candidates.map(value => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
      || value.length > 512 || /[\x00-\x20\\?#]/.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) {
      throw modelDiscoveryError('MODEL_DISCOVERY_INVALID', 'Model discovery endpoint must be a same-origin path');
    }
    const candidate = new URL(value, url.origin);
    if (candidate.origin !== url.origin || !candidate.pathname.endsWith('/models')) {
      throw modelDiscoveryError('MODEL_DISCOVERY_INVALID', 'Model discovery endpoint must be a same-origin models path');
    }
    return candidate.href;
  }))];
}

async function readCatalog(response, signal, maxResponseBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw modelDiscoveryError('MODEL_DISCOVERY_LIMIT', 'Model catalog exceeds the response budget');
  }
  if (!response.body) throw modelDiscoveryError('MODEL_DISCOVERY_INVALID_RESPONSE', 'Model catalog is empty');
  const reader = response.body.getReader();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(modelDiscoveryError('ABORTED', 'Model discovery was cancelled'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  let bytes = 0;
  const chunks = [];
  let completed = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) throw modelDiscoveryError('MODEL_DISCOVERY_LIMIT', 'Model catalog exceeds the response budget');
      chunks.push(next.value);
    }
    completed = true;
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw modelDiscoveryError('MODEL_DISCOVERY_INVALID_RESPONSE', 'Model catalog is not valid JSON'); }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalizeCatalog(payload, credential, maxModels) {
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models : null;
  if (!entries) throw modelDiscoveryError('MODEL_DISCOVERY_INVALID_RESPONSE', 'Model catalog requires a model list');
  const byId = new Map();
  for (const entry of entries) {
    const id = safeModelIdentifier(typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? entry?.model, credential);
    if (!id || byId.has(id)) continue;
    const capabilities = {};
    for (const key of ['tools', 'reasoning', 'vision', 'streaming']) {
      const value = entry?.capabilities?.[key] ?? entry?.[`supports_${key}`];
      if (typeof value === 'boolean') capabilities[key] = { value, source: 'protocol-declared', status: 'declared', ruleId: null, version: MODEL_CATALOG_VERSION };
    }
    byId.set(id, { id, label: id, enabled: false, capabilities });
  }
  const models = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { models: models.slice(0, maxModels), truncated: models.length > maxModels };
}

export async function discoverModels({ baseUrl, credential, signal, profile = 'openai-compatible-v1', paths,
  timeoutMs = 10000, maxResponseBytes = 512 * 1024, maxModels = 256, fetchImpl = fetch } = {}) {
  const base = normalizeModelBaseUrl(baseUrl);
  if (!PROFILES.has(profile) || typeof credential !== 'string' || credential.length < 8 || credential.length > 512
    || /[\x00-\x1f]/.test(credential) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 64 || maxResponseBytes > 1024 * 1024
    || !Number.isSafeInteger(maxModels) || maxModels < 1 || maxModels > 512) {
    throw modelDiscoveryError('MODEL_DISCOVERY_INVALID', 'Invalid model discovery credentials, profile or budget');
  }
  const candidates = pathsFor(base, paths);
  const deadline = AbortSignal.timeout(timeoutMs);
  const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const attemptCodes = [];
  try {
    for (const [index, candidate] of candidates.entries()) {
      effectiveSignal.throwIfAborted();
      const response = await fetchImpl(candidate, { redirect: 'manual', headers: { authorization: `Bearer ${credential}`, accept: 'application/json' }, signal: effectiveSignal });
      const attempt = { index, status: response.status, code: `HTTP_${response.status}` };
      attemptCodes.push(attempt);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw modelDiscoveryError('MODEL_DISCOVERY_REDIRECT', 'Model discovery does not forward credentials through redirects', { attemptCodes });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404 && index < candidates.length - 1) continue;
        throw modelDiscoveryError('MODEL_DISCOVERY_HTTP_ERROR', `Model discovery failed (HTTP ${response.status})`, { status: response.status, attemptCodes });
      }
      const result = normalizeCatalog(await readCatalog(response, effectiveSignal, maxResponseBytes), credential, maxModels);
      return { ...result, attemptCodes, source: 'protocol-declared', version: MODEL_CATALOG_VERSION };
    }
  } catch (error) {
    if (signal?.aborted) throw modelDiscoveryError('ABORTED', 'Model discovery was cancelled', { attemptCodes });
    if (deadline.aborted) throw modelDiscoveryError('MODEL_DISCOVERY_TIMEOUT', 'Model discovery timed out', { attemptCodes });
    if (typeof error?.code === 'string' && error.code.startsWith('MODEL_DISCOVERY_')) throw error;
    throw modelDiscoveryError('MODEL_DISCOVERY_UNAVAILABLE', 'Model service is unavailable', { attemptCodes });
  }
}
