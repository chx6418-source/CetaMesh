import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

const DEFAULT_ENDPOINTS = Object.freeze({
  gemini: 'https://generativelanguage.googleapis.com',
  opencode: 'https://api.openai.com/v1',
  qwen: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com'
});
const PUBLIC_FIELDS = ['enabled', 'runtimePath', 'nodePath', 'model', 'baseUrl', 'executionMode'];
const INPUT_FIELDS = new Set([...PUBLIC_FIELDS, 'apiKey']);
const STORED_FIELDS = new Set([...PUBLIC_FIELDS, 'revision']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = message => fail('AGENT_RUNTIME_CONFIG_INVALID', message);

// This service owns explicit Agent settings only. It never searches a user's CLI profiles,
// environment credentials or desktop-client state, and it never installs a runtime.
export function createAgentRuntimeConfiguration({ stateDir, providerSecrets, allowLoopbackHttpForTests = false } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) invalid('Agent runtime state directory must be absolute');
  const file = path.join(stateDir, 'agent-runtimes.json');
  const providerId = value => {
    if (typeof value !== 'string' || !Object.hasOwn(DEFAULT_ENDPOINTS, value)) invalid('Unsupported Agent runtime provider');
    return value;
  };
  const secretRef = provider => 'agent-' + provider;
  const defaults = provider => ({ enabled: true, runtimePath: '', nodePath: '', model: '', baseUrl: DEFAULT_ENDPOINTS[provider], executionMode: 'native-permissions', revision: 0 });
  function text(value, name, max) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid('Invalid Agent runtime ' + name);
    return value.trim();
  }
  function endpoint(value, provider) {
    const source = text(value, 'baseUrl', 2048);
    if (!source) return DEFAULT_ENDPOINTS[provider];
    let url;
    try { url = new URL(source); } catch { invalid('Agent endpoint must be a valid HTTPS URL'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(allowLoopbackHttpForTests && url.protocol === 'http:' && loopback))) {
      invalid('Agent endpoint requires HTTPS without credentials, query or fragment');
    }
    return url.href.replace(/\/+$/, '');
  }
  function selection(provider, input, previous) {
    if (!isRecord(input) || Object.keys(input).some(key => !INPUT_FIELDS.has(key))) invalid('Unsupported Agent runtime configuration fields');
    const next = { ...previous };
    for (const field of ['runtimePath', 'nodePath']) if (Object.hasOwn(input, field)) {
      const value = text(input[field], field, 4096);
      if (value && !(path.isAbsolute(value) || path.win32.isAbsolute(value))) invalid('Agent runtime paths must be absolute');
      next[field] = value;
    }
    if (Object.hasOwn(input, 'enabled')) {
      if (typeof input.enabled !== 'boolean') invalid('Agent enabled must be a boolean');
      next.enabled = input.enabled;
    }
    if (Object.hasOwn(input, 'model')) next.model = text(input.model, 'model', 256);
    if (Object.hasOwn(input, 'baseUrl')) next.baseUrl = endpoint(input.baseUrl, provider);
    if (Object.hasOwn(input, 'executionMode') && input.executionMode !== 'native-permissions') invalid('Agent execution mode must be native-permissions');
    if (Object.hasOwn(input, 'apiKey')) {
      const key = text(input.apiKey, 'apiKey', 512);
      if (key && key.length < 8) invalid('Agent API Key must contain at least 8 characters');
    }
    return next;
  }
  function read() {
    try {
      const document = readJsonFile(file, { missing: { version: 1, providers: {} }, maxBytes: 65536 });
      if (!isRecord(document) || document.version !== 1 || !isRecord(document.providers) || Object.keys(document).some(key => !['version', 'providers'].includes(key))) throw new Error('Invalid document');
      for (const [provider, entry] of Object.entries(document.providers)) {
        providerId(provider);
        if (!isRecord(entry) || Object.keys(entry).some(key => !STORED_FIELDS.has(key)) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || PUBLIC_FIELDS.some(key => !Object.hasOwn(entry, key))) throw new Error('Invalid entry');
        const { revision, ...config } = entry;
        const normalized = selection(provider, config, defaults(provider));
        if (PUBLIC_FIELDS.some(key => normalized[key] !== config[key])) throw new Error('Noncanonical entry');
      }
      return document;
    } catch { fail('AGENT_RUNTIME_CONFIG_CORRUPT', 'Agent runtime configuration is unreadable or malformed; existing data was preserved'); }
  }
  function metadata(provider) {
    const entry = providerSecrets?.list?.().find(item => item.provider === secretRef(provider));
    return entry ? { configured: entry.configured === true, baseUrl: entry.baseUrl ?? '', updatedAt: entry.updatedAt ?? null, hint: entry.hint ?? '' } : { configured: false };
  }
  function get(provider) {
    providerId(provider);
    const entry = read().providers[provider] ?? defaults(provider);
    return { provider, enabled: entry.enabled, runtimePath: entry.runtimePath, nodePath: entry.nodePath, model: entry.model,
      baseUrl: entry.baseUrl, credentialConfigured: metadata(provider).configured, executionMode: 'native-permissions', revision: entry.revision };
  }
  function configure(provider, input) {
    providerId(provider);
    const document = read();
    const previous = document.providers[provider] ?? defaults(provider);
    const next = selection(provider, input, previous);
    if (previous.revision >= Number.MAX_SAFE_INTEGER) invalid('Agent runtime revision limit reached');
    next.revision = previous.revision + 1;
    const key = Object.hasOwn(input, 'apiKey') ? input.apiKey.trim() : '';
    const existing = metadata(provider);
    if (key || (existing.configured && next.baseUrl !== previous.baseUrl)) {
      if (typeof providerSecrets?.set !== 'function' || (!key && typeof providerSecrets?.raw !== 'function')) fail('CONFIGURATION_UNSUPPORTED', 'Agent credential storage is unavailable');
      // Empty API Key preserves the owned Agent credential. Endpoint changes are explicit
      // Owner configuration, and update its scope without reading any external CLI profile.
      providerSecrets.set({ provider: secretRef(provider), apiKey: key || providerSecrets.raw(secretRef(provider)).apiKey, baseUrl: next.baseUrl });
    }
    document.providers[provider] = next;
    try { writeJsonAtomic(file, document); }
    catch { fail('AGENT_RUNTIME_CONFIG_WRITE_FAILED', 'Agent runtime configuration could not be saved'); }
    return { provider, supported: true, applied: true, configuration: get(provider) };
  }
  function resolveCredential(provider) {
    const configuration = get(provider);
    if (!configuration.credentialConfigured) return null;
    if (typeof providerSecrets?.raw !== 'function') fail('CONFIGURATION_UNSUPPORTED', 'Agent credential storage is unavailable');
    const credential = providerSecrets.raw(secretRef(provider));
    if (credential.baseUrl !== configuration.baseUrl) fail('AGENT_RUNTIME_CREDENTIAL_SCOPE_MISMATCH', 'Agent credential endpoint changed; review and save its API Key again');
    return { apiKey: credential.apiKey, baseUrl: configuration.baseUrl };
  }
  function identity(provider) {
    const configuration = get(provider);
    return crypto.createHash('sha256').update(JSON.stringify({ configuration, credential: metadata(provider) })).digest('hex');
  }
  return Object.freeze({ get, configure, resolveCredential, identity });
}
