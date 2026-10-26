import path from 'node:path';
import { runtimeServicePresets, presetForEndpoint, OPENCODE_LOGIN_SELECTIONS } from './runtime-service-presets.js';
import crypto from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

const DEFAULT_ENDPOINTS = Object.freeze({
  gemini: 'https://generativelanguage.googleapis.com',
  opencode: 'https://api.openai.com/v1',
  qwen: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com'
});
const LEGACY_FIELDS = ['enabled', 'runtimePath', 'nodePath', 'model', 'baseUrl', 'executionMode'];
const PUBLIC_FIELDS = [...LEGACY_FIELDS, 'authMode', 'servicePreset', 'providerId', 'methodId'];
const INPUT_FIELDS = new Set([...PUBLIC_FIELDS, 'apiKey']);
const STORED_FIELDS = new Set([...PUBLIC_FIELDS, 'revision']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = message => fail('AGENT_RUNTIME_CONFIG_INVALID', message);

// This service owns explicit Agent settings only. It never searches a user's CLI profiles,
// environment credentials or desktop-client state, and it never installs a runtime.
export function createAgentRuntimeConfiguration({ stateDir, providerSecrets, allowLoopbackHttpForTests = false, connectionLeases, authProfileIdentity } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) invalid('Agent runtime state directory must be absolute');
  const file = path.join(stateDir, 'agent-runtimes.json');
  const providerId = value => {
    if (typeof value !== 'string' || !Object.hasOwn(DEFAULT_ENDPOINTS, value)) invalid('Unsupported Agent runtime provider');
    return value;
  };
  const secretRef = provider => 'agent-' + provider;
  const defaults = provider => ({ enabled: true, runtimePath: '', nodePath: '', model: '', baseUrl: DEFAULT_ENDPOINTS[provider], executionMode: 'native-permissions', authMode:'api-key',servicePreset:presetForEndpoint(provider,DEFAULT_ENDPOINTS[provider]),providerId:null,methodId:null,revision: 0 });
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
    if (Object.hasOwn(input, 'authMode')) {
      if (!['api-key','provider-login'].includes(input.authMode) || (provider === 'qwen' && input.authMode !== 'api-key')) invalid('Unsupported Agent authentication mode');
      next.authMode=input.authMode;
    }
    if (Object.hasOwn(input,'servicePreset')) {
      const preset=runtimeServicePresets(provider).find(row=>row.id===input.servicePreset);
      if(!preset) invalid('Unsupported Agent service preset');
      next.servicePreset=preset.id;
      if(preset.baseUrl) {
        if(Object.hasOwn(input,'baseUrl') && next.baseUrl!==preset.baseUrl) invalid('Agent service preset endpoint does not match');
        next.baseUrl=preset.baseUrl;
      }
    } else if(Object.hasOwn(input,'baseUrl')) next.servicePreset=presetForEndpoint(provider,next.baseUrl);
    for(const field of ['providerId','methodId']) if(Object.hasOwn(input,field)) next[field]=input[field];
    if((provider==='opencode' && next.authMode==='provider-login') || next.providerId!==null || next.methodId!==null) {
      if(provider!=='opencode' || next.authMode!=='provider-login' || !OPENCODE_LOGIN_SELECTIONS.some(row=>row.providerId===next.providerId && row.methodId===next.methodId)) invalid('Native provider login selection is not verified');
    }
    if (Object.hasOwn(input, 'executionMode') && input.executionMode !== 'native-permissions') invalid('Agent execution mode must be native-permissions');
    if (Object.hasOwn(input, 'apiKey')) {
      const key = text(input.apiKey, 'apiKey', 512);
      if (key && key.length < 8) invalid('Agent API Key must contain at least 8 characters');
    }
    return next;
  }
  function read() {
    try {
      const document = readJsonFile(file, { missing: { version: 2, providers: {} }, maxBytes: 65536 });
      if (!isRecord(document) || ![1,2].includes(document.version) || !isRecord(document.providers) || Object.keys(document).some(key => !['version', 'providers'].includes(key))) throw new Error('Invalid document');
      const fields=document.version===1 ? LEGACY_FIELDS : PUBLIC_FIELDS;
      for (const [provider, entry] of Object.entries(document.providers)) {
        providerId(provider);
        if (!isRecord(entry) || Object.keys(entry).some(key => !(document.version===1 ? [...LEGACY_FIELDS,'revision'].includes(key) : STORED_FIELDS.has(key))) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || fields.some(key => !Object.hasOwn(entry, key))) throw new Error('Invalid entry');
        const { revision, ...config } = entry;
        const normalized = selection(provider, config, defaults(provider));
        if (fields.some(key => normalized[key] !== config[key])) throw new Error('Noncanonical entry');
      }
      return {version:2,providers:Object.fromEntries(Object.entries(document.providers).map(([provider,entry])=>[provider,{...defaults(provider),...entry,servicePreset:entry.servicePreset ?? presetForEndpoint(provider,entry.baseUrl)}]))};
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
      baseUrl: entry.baseUrl, credentialConfigured: metadata(provider).configured, executionMode: 'native-permissions', revision: entry.revision,authMode:entry.authMode,servicePreset:entry.servicePreset,providerId:entry.providerId,methodId:entry.methodId,authorizationEpoch:connectionLeases?.epoch(provider) ?? entry.revision };
  }
  function configure(provider, input) {
    providerId(provider);
    const lease=connectionLeases?.reserve({provider,kind:'configure',expectedEpoch:connectionLeases.epoch(provider)});
    try {
    const document = read();
    const previous = document.providers[provider] ?? defaults(provider);
    const next = selection(provider, input, previous);
    if (previous.revision >= Number.MAX_SAFE_INTEGER) invalid('Agent runtime revision limit reached');
    next.revision = previous.revision + 1;
    const key = Object.hasOwn(input, 'apiKey') ? input.apiKey.trim() : '';
    const existing = metadata(provider);
    if(existing.configured && (next.baseUrl!==previous.baseUrl || next.servicePreset!==previous.servicePreset) && !key)
      fail('AGENT_RUNTIME_CREDENTIAL_SCOPE_MISMATCH','Agent service changed; review and re-enter its API Key');
    if(key && next.authMode!=='api-key') invalid('API credentials cannot be saved in provider login mode');
    lease?.assertCurrent();
    if (key) {
      if (typeof providerSecrets?.set !== 'function') fail('CONFIGURATION_UNSUPPORTED', 'Agent credential storage is unavailable');
      providerSecrets.set({provider:secretRef(provider),apiKey:key,baseUrl:next.baseUrl});
    }
    document.providers[provider] = next;
    try { writeJsonAtomic(file, document); }
    catch { fail('AGENT_RUNTIME_CONFIG_WRITE_FAILED', 'Agent runtime configuration could not be saved'); }
    lease?.advance();
    return { provider, supported: true, applied: true, configuration: get(provider) };
    } finally {lease?.release({exitConfirmed:true});}
  }
  function resolveCredential(provider) {
    const configuration = get(provider);
    if (configuration.authMode !== 'api-key' || !configuration.credentialConfigured) return null;
    if (typeof providerSecrets?.raw !== 'function') fail('CONFIGURATION_UNSUPPORTED', 'Agent credential storage is unavailable');
    const credential = providerSecrets.raw(secretRef(provider));
    if (credential.baseUrl !== configuration.baseUrl) fail('AGENT_RUNTIME_CREDENTIAL_SCOPE_MISMATCH', 'Agent credential endpoint changed; review and save its API Key again');
    return { apiKey: credential.apiKey, baseUrl: configuration.baseUrl };
  }
  function identity(provider) {
    const configuration = get(provider);
    return crypto.createHash('sha256').update(JSON.stringify({ configuration, credential: metadata(provider), accountGeneration: configuration.authMode === 'provider-login' ? authProfileIdentity?.(provider) ?? null : null })).digest('hex');
  }
  return Object.freeze({ get, configure, resolveCredential, identity });
}
