// One Settings-backed model configuration. This module owns validation and
// derived adapters; Settings and ProviderSecrets remain the only durable stores.
import { createOpenAiCompatibleModelProvider } from './providers/openai-compatible.js';
import { discoverModels, normalizeModelBaseUrl, safeModelIdentifier } from './model-discovery.js';

export const MODEL_CAPABILITY_RULE_VERSION = '2026-11-07.1';
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILES = new Set(['openai-compatible-v1', 'openai-chat-v1', 'deepseek-chat-v1']);
const EFFORTS = new Set(['off', 'low', 'high', 'max']);
const CAPABILITIES = ['tools', 'vision', 'reasoning', 'streaming', 'contextWindowTokens', 'maxOutputTokens', 'defaultOutputTokens'];
const TOKEN_FIELDS = new Set(CAPABILITIES.filter(key => key.endsWith('Tokens')));
const BUILTIN_BASE_URLS = Object.freeze({ 'deepseek-official': 'https://api.deepseek.com', openai: 'https://api.openai.com/v1' });
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const validId = value => typeof value === 'string' && ID.test(value);
function invalid() { fail('SETTINGS_INVALID', 'Invalid bounded model connection configuration'); }

function manualCapabilities(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !CAPABILITIES.includes(key))) invalid();
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (TOKEN_FIELDS.has(key) ? !Number.isSafeInteger(value) || value <= 0 || value > 100000000 : typeof value !== 'boolean') invalid();
    out[key] = value;
  }
  if (out.defaultOutputTokens && out.maxOutputTokens && out.defaultOutputTokens > out.maxOutputTokens) invalid();
  if (out.maxOutputTokens && out.contextWindowTokens && out.maxOutputTokens >= out.contextWindowTokens) invalid();
  return out;
}

function catalogCapabilities(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !CAPABILITIES.includes(key))) invalid();
  const out = {};
  for (const [key, fact] of Object.entries(raw)) {
    if (!fact || typeof fact !== 'object' || !['protocol-declared', 'rule-inferred'].includes(fact.source)
      || !['declared', 'unknown'].includes(fact.status) || typeof fact.version !== 'string' || fact.version.length > 80
      || !/^[A-Za-z0-9._-]+$/.test(fact.version)
      || (fact.ruleId !== null && (typeof fact.ruleId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(fact.ruleId)))) invalid();
    const value = manualCapabilities({ [key]: fact.value })[key];
    out[key] = { value, source: fact.source, status: fact.status, ruleId: fact.ruleId, version: fact.version };
  }
  return out;
}

// Called by Settings schema too, so malformed direct settings.update cannot
// bypass the model configuration API or place credentials in the Settings file.
export function normalizeModelConnections(raw) {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 32 || Buffer.byteLength(JSON.stringify(raw)) > 512 * 1024) invalid();
  const ids = new Set();
  let totalModels = 0;
  return raw.map(connection => {
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)
      || Object.keys(connection).some(key => !['id', 'label', 'protocolProfile', 'enabled', 'credentialRef', 'models', 'configured'].includes(key))
      || !validId(connection.id) || ids.has(connection.id) || !PROFILES.has(connection.protocolProfile)
      || typeof connection.label !== 'string' || !connection.label.trim() || connection.label.length > 120 || /[\x00-\x1f]/.test(connection.label)
      || typeof connection.enabled !== 'boolean' || !Array.isArray(connection.models) || connection.models.length > 256
      || (connection.credentialRef !== undefined && !validId(connection.credentialRef))) invalid();
    ids.add(connection.id);
    const seen = new Set();
    const models = [];
    for (const entry of connection.models) {
      const modelId = safeModelIdentifier(entry?.id);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['id', 'label', 'enabled', 'manualCapabilities', 'discoveredCapabilities', 'capabilities'].includes(key))
        || !modelId || typeof entry.enabled !== 'boolean') invalid();
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      models.push({ id: modelId, enabled: entry.enabled, manualCapabilities: manualCapabilities(entry.manualCapabilities),
        discoveredCapabilities: catalogCapabilities(entry.discoveredCapabilities) });
    }
    totalModels += models.length;
    if (totalModels > 1024) invalid();
    return { id: connection.id, label: connection.label.trim(), protocolProfile: connection.protocolProfile,
      enabled: connection.enabled, ...(connection.credentialRef ? { credentialRef: connection.credentialRef } : {}), models };
  });
}

export function normalizeModelPreferences(raw) {
  if (!Array.isArray(raw) || raw.length > 1024) invalid();
  const seen = new Set();
  return raw.map(entry => {
    const modelId = safeModelIdentifier(entry?.modelId);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['connectionId', 'modelId', 'reasoningEffort'].includes(key))
      || !validId(entry.connectionId) || !modelId || !EFFORTS.has(entry.reasoningEffort)) invalid();
    const identity = `${entry.connectionId}\0${modelId}`;
    if (seen.has(identity)) invalid();
    seen.add(identity);
    return { connectionId: entry.connectionId, modelId, reasoningEffort: entry.reasoningEffort };
  });
}

function derivedCapabilities(connection, entry) {
  const facts = {};
  for (const key of CAPABILITIES) {
    if (Object.hasOwn(entry.manualCapabilities ?? {}, key)) {
      facts[key] = { value: entry.manualCapabilities[key], source: 'manual', status: 'declared', ruleId: null, version: 'manual-v1' };
    } else if (entry.discoveredCapabilities?.[key]?.source === 'protocol-declared') {
      facts[key] = { ...entry.discoveredCapabilities[key] };
    } else if (key === 'reasoning' && (connection.protocolProfile === 'deepseek-chat-v1'
      || /^(?:o[134](?:-|$)|gpt-5(?:-|$))/i.test(entry.id))) {
      facts[key] = { value: true, source: 'rule-inferred', status: 'declared', ruleId: 'adapter-reasoning-profile', version: MODEL_CAPABILITY_RULE_VERSION };
    } else {
      facts[key] = { value: null, source: 'unknown', status: 'unknown', ruleId: null, version: null };
    }
  }
  return facts;
}

export function createModelConfiguration({ settingsStore, secrets, registry, fetchImpl = fetch } = {}) {
  if (!settingsStore?.get || !settingsStore?.update || !secrets?.list || !secrets?.raw || !registry?.require || !registry?.upsert || !registry?.unregister) {
    throw new Error('Model configuration requires existing Settings, ProviderSecrets and Model Registry');
  }
  const originalProviders = registry.list();
  const originalIds = new Set(originalProviders.map(provider => provider.id));
  const adapterKeys = new Map();
  const managedIds = new Set();
  const credentialRef = connection => connection.credentialRef ?? (originalIds.has(connection.id) ? connection.id : null);
  function secretEntries() { return secrets.list(); }
  const descriptor = ref => secretEntries().find(entry => entry.provider === ref) ?? null;
  function legacyConnections() {
    return originalProviders.map(provider => ({ id: provider.id, label: provider.label,
      protocolProfile: provider.protocolProfile || (provider.id === 'deepseek-official' ? 'deepseek-chat-v1'
        : provider.id === 'openai' ? 'openai-chat-v1' : 'openai-compatible-v1'),
      enabled: true, credentialRef: provider.id,
      models: provider.defaultModel ? [{ id: provider.defaultModel, enabled: true, manualCapabilities: {}, discoveredCapabilities: {} }] : [] }));
  }
  function snapshot() {
    const state = settingsStore.get();
    const models = state.settings.models;
    const derived = models.connections === null || models.connections === undefined;
    if (derived && managedIds.size) {
      // A Settings reset changes the real provider view in this same Registry.
      // Restore only this owner's adapters; unrelated registrations survive.
      for (const original of originalProviders) registry.upsert(original);
      for (const id of managedIds) if (!originalIds.has(id)) registry.unregister(id);
      managedIds.clear();
      adapterKeys.clear();
    }
    return { revision: state.revision, derived, connections: derived ? legacyConnections() : normalizeModelConnections(models.connections),
      defaults: { provider: models.provider, model: safeModelIdentifier(models.defaultModel) ?? models.defaultModel, reasoningEffort: models.reasoningEffort },
      modelPreferences: normalizeModelPreferences(models.modelPreferences ?? []) };
  }
  function validateReferences(connections) {
    const entries = secretEntries();
    for (const connection of connections) {
      if (!connection.credentialRef) continue;
      const entry = entries.find(value => value.provider === connection.credentialRef);
      if (originalIds.has(connection.id) && connection.credentialRef === connection.id) continue;
      if (!entry || entry.modelPreparation?.connectionId !== connection.id) {
        fail('MODEL_CREDENTIAL_BINDING_INVALID', 'Model credential reference does not belong to this connection');
      }
    }
  }
  function get() {
    const state = snapshot();
    const entries = secretEntries();
    const active = new Set(state.connections.map(connection => connection.credentialRef).filter(Boolean));
    const ancestors = new Set();
    for (const ref of active) {
      let cursor = entries.find(entry => entry.provider === ref)?.modelPreparation?.previousCredentialRef;
      while (cursor && !ancestors.has(cursor)) {
        ancestors.add(cursor);
        cursor = entries.find(entry => entry.provider === cursor)?.modelPreparation?.previousCredentialRef;
      }
    }
    return { ...state, connections: state.connections.map(connection => ({ ...connection,
      configured: entries.some(entry => entry.provider === credentialRef(connection)),
      models: connection.models.map(entry => ({ ...entry, label: entry.id, capabilities: derivedCapabilities(connection, entry) })) })),
      recovery: entries.filter(entry => entry.modelPreparation && !active.has(entry.provider) && !ancestors.has(entry.provider))
        .map(entry => ({ credentialRef: entry.provider, state: 'credential-prepared', ...entry.modelPreparation })) };
  }
  function assertRevision(expectedRevision, current = snapshot()) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      fail('SETTINGS_CONFLICT', 'Model configuration changed; refresh before saving');
    }
    return current;
  }
  function update({ expectedRevision, connections, defaults, modelPreferences: preferences } = {}) {
    const current = assertRevision(expectedRevision);
    const clean = normalizeModelConnections(connections === undefined ? current.connections : connections);
    if (clean === null) invalid();
    validateReferences(clean);
    const patch = { connections: clean, modelPreferences: normalizeModelPreferences(preferences ?? current.modelPreferences) };
    if (defaults !== undefined) {
      if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
        || Object.keys(defaults).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) invalid();
      if (defaults.provider !== undefined) {
        if (!validId(defaults.provider) || !clean.some(connection => connection.id === defaults.provider)) invalid();
        patch.provider = defaults.provider;
      }
      if (defaults.model !== undefined) { const model = safeModelIdentifier(defaults.model); if (!model) invalid(); patch.defaultModel = model; }
      if (defaults.reasoningEffort !== undefined) { if (!EFFORTS.has(defaults.reasoningEffort)) invalid(); patch.reasoningEffort = defaults.reasoningEffort; }
    }
    settingsStore.update('models', patch, { expectedRev: expectedRevision });
    return get();
  }
  function listEnabledModels({ connectionId = null } = {}) {
    const current = get();
    return current.connections.filter(connection => connection.enabled && (!connectionId || connection.id === connectionId))
      .flatMap(connection => connection.models.filter(entry => entry.enabled).map(entry => ({ ...entry, connectionId: connection.id,
        providerId: connection.id, configured: connection.configured, connectionRevision: current.revision })));
  }
  function hasKey(id) {
    const state = snapshot();
    const connection = state.connections.find(entry => entry.id === id);
    return !!connection && !!credentialRef(connection) && !!descriptor(credentialRef(connection));
  }
  function defaultProviderId() {
    const state = snapshot();
    const available = state.connections.filter(entry => entry.enabled && entry.models.some(model => model.enabled) && hasKey(entry.id));
    return available.find(entry => entry.id === state.defaults.provider)?.id ?? available[0]?.id ?? null;
  }
  function requireConnection(id) {
    const state = snapshot();
    const selected = id || defaultProviderId();
    if (!selected) fail('MODEL_NO_ENABLED_MODELS', 'No enabled model connection is available; enable a model in Settings');
    const connection = state.connections.find(entry => entry.id === selected);
    if (!connection) fail('MODEL_PROVIDER_UNKNOWN', 'Unknown model connection');
    if (!connection.enabled) fail('MODEL_CONNECTION_DISABLED', 'This model connection is disabled; enable it in Settings');
    if (!connection.models.some(entry => entry.enabled)) fail('MODEL_NO_ENABLED_MODELS', 'This connection has no enabled models; enable a model in Settings');
    if (!hasKey(connection.id)) fail('MODEL_PROVIDER_KEY_MISSING', 'This model connection has no credential; configure it in Settings');
    validateReferences([connection]);
    return { connection, state };
  }
  function provider(id) {
    const { connection, state } = requireConnection(id);
    const ref = connection.credentialRef ?? connection.id;
    const entry = descriptor(ref);
    const cacheKey = JSON.stringify([MODEL_CAPABILITY_RULE_VERSION, state.revision, entry?.revision ?? entry?.updatedAt, connection]);
    if (adapterKeys.get(connection.id) !== cacheKey) {
      const modelProfile = modelId => connection.models.find(entry => entry.id === safeModelIdentifier(modelId)) ?? null;
      const enabled = connection.models.filter(entry => entry.enabled);
      const defaultModel = enabled.find(entry => entry.id === state.defaults.model)?.id ?? enabled[0]?.id ?? null;
      registry.upsert(createOpenAiCompatibleModelProvider({ id: connection.id, label: connection.label,
        protocolProfile: connection.protocolProfile, baseUrl: BUILTIN_BASE_URLS[connection.id] ?? '', defaultModel, secrets: { raw: () => secrets.raw(ref) }, fetchImpl,
        reasoningParam: connection.protocolProfile === 'deepseek-chat-v1' ? null : 'reasoning_effort',
        supportsReasoning: modelId => connection.protocolProfile !== 'openai-compatible-v1'
          || (modelProfile(modelId)?.manualCapabilities?.reasoning ?? settingsStore.get().settings.models.openaiCompatibleReasoningEffort === true),
        supportsTools: modelId => {
          const manual = modelProfile(modelId)?.manualCapabilities?.tools;
          return manual ?? (connection.protocolProfile !== 'openai-compatible-v1' || settingsStore.get().settings.models.openaiCompatibleToolCalling === true);
        },
        supportsStreamOptions: connection.protocolProfile !== 'openai-compatible-v1', modelProfile }));
      adapterKeys.set(connection.id, cacheKey);
      managedIds.add(connection.id);
    }
    return registry.require(connection.id);
  }
  function resolveSelection({ providerId, model, reasoning } = {}) {
    const { connection, state } = requireConnection(providerId);
    const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
    const enabled = connection.models.filter(entry => entry.enabled);
    const selected = requestedModel ?? enabled.find(entry => entry.id === state.defaults.model)?.id ?? enabled[0].id;
    if (!enabled.some(entry => entry.id === selected)) fail('MODEL_DISABLED', 'This model is not enabled for the selected connection; review its Settings');
    const preference = state.modelPreferences.find(entry => entry.connectionId === connection.id && entry.modelId === selected);
    const effort = reasoning ?? preference?.reasoningEffort ?? state.defaults.reasoningEffort;
    if (!EFFORTS.has(effort)) fail('INVALID_PARAMS', 'Unsupported model reasoning effort');
    const ref = credentialRef(connection);
    const secretRevision = descriptor(ref)?.revision ?? null;
    return { provider: provider(connection.id), model: selected, reasoning: effort,
      assertCurrent() {
        if (snapshot().revision !== state.revision || descriptor(ref)?.revision !== secretRevision) {
          fail('MODEL_CONFIGURATION_CHANGED', 'Model configuration changed before dispatch; refresh and start a new request');
        }
      },
      configurationContext: { connectionRevision: state.revision, requested: { model: requestedModel, reasoning: reasoning ?? null },
        source: { model: requestedModel ? 'request' : 'configuration', reasoning: reasoning != null ? 'request' : preference ? 'model-preference' : 'configuration' } } };
  }
  function resolveCandidate({ connectionId, candidate = {}, connection: supplied } = {}) {
    const state = snapshot();
    const connection = supplied ?? state.connections.find(entry => entry.id === connectionId);
    if (!connection) fail('MODEL_PROVIDER_UNKNOWN', 'Unknown model connection');
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).some(key => !['apiKey', 'baseUrl', 'credentialRef'].includes(key))) invalid();
    let saved = null;
    let ref = connection.credentialRef ?? (originalIds.has(connection.id) ? connection.id : null);
    if (candidate.credentialRef) {
      const prepared = descriptor(candidate.credentialRef);
      if (prepared?.modelPreparation?.connectionId !== connection.id || candidate.apiKey !== undefined || candidate.baseUrl !== undefined) {
        fail('MODEL_CREDENTIAL_BINDING_INVALID', 'Prepared credential does not belong to this connection');
      }
      ref = candidate.credentialRef;
    }
    if (ref) {
      validateReferences([{ ...connection, credentialRef: ref }]);
      try { saved = secrets.raw(ref); } catch (error) { if (error?.code !== 'PROVIDER_SECRET_NOT_FOUND') throw error; }
    }
    const fallback = BUILTIN_BASE_URLS[connection.id];
    const baseUrl = normalizeModelBaseUrl(candidate.baseUrl || saved?.baseUrl || fallback || '');
    const apiKey = candidate.apiKey || saved?.apiKey;
    const previousBase = saved?.baseUrl || (saved ? fallback : null);
    if (candidate.baseUrl && !candidate.apiKey && previousBase
      && new URL(baseUrl).origin !== new URL(previousBase).origin) {
      fail('MODEL_CREDENTIAL_ORIGIN_MISMATCH', 'Enter a credential explicitly before testing a different model service origin');
    }
    return { connection, baseUrl, apiKey, ref, secretRevision: ref ? descriptor(ref)?.revision : null };
  }
  async function discover({ connectionId, candidate, signal, ...budget } = {}) {
    const state = snapshot();
    const resolved = resolveCandidate({ connectionId, candidate });
    const result = await discoverModels({ ...budget, baseUrl: resolved.baseUrl, credential: resolved.apiKey, profile: resolved.connection.protocolProfile, signal, fetchImpl });
    if (snapshot().revision !== state.revision || (resolved.ref && descriptor(resolved.ref)?.revision !== resolved.secretRevision)) {
      fail('MODEL_CONFIGURATION_CHANGED', 'Model connection changed during discovery; refresh before using the result');
    }
    return { ...result, connectionId, configurationRevision: state.revision };
  }
  async function testAndCommitConnection({ expectedRevision, connection, candidate, signal } = {}) {
    const before = assertRevision(expectedRevision);
    const clean = normalizeModelConnections([connection])[0];
    const existing = before.connections.find(entry => entry.id === clean.id);
    const priorModels = new Map((existing?.models ?? []).map(entry => [entry.id, entry]));
    for (const entry of clean.models) {
      const submitted = connection.models.find(value => safeModelIdentifier(value.id) === entry.id);
      if (submitted?.manualCapabilities === undefined && priorModels.has(entry.id)) entry.manualCapabilities = { ...priorModels.get(entry.id).manualCapabilities };
    }
    if (!clean.credentialRef && existing?.credentialRef) clean.credentialRef = existing.credentialRef;
    const resolved = resolveCandidate({ connectionId: clean.id, connection: clean, candidate });
    const catalog = await discoverModels({ baseUrl: resolved.baseUrl, credential: resolved.apiKey, profile: clean.protocolProfile, signal, fetchImpl });
    assertRevision(expectedRevision);
    signal?.throwIfAborted();
    if (resolved.ref && descriptor(resolved.ref)?.revision !== resolved.secretRevision) fail('MODEL_CONFIGURATION_CHANGED', 'Model credential changed during testing; refresh and test again');
    const entries = new Map([...priorModels, ...clean.models.map(entry => [entry.id, entry])]);
    for (const found of catalog.models) {
      const previous = entries.get(found.id);
      entries.set(found.id, { id: found.id, enabled: previous?.enabled ?? false, manualCapabilities: previous?.manualCapabilities ?? {}, discoveredCapabilities: found.capabilities });
    }
    clean.models = [...entries.values()];
    const prepared = candidate?.credentialRef ? descriptor(candidate.credentialRef) : secrets.prepareModelConnectionCredential({
      connectionId: clean.id, expectedConfigurationRevision: expectedRevision, previousCredentialRef: existing?.credentialRef ?? null,
      apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
    clean.credentialRef = prepared.provider;
    const next = before.connections.filter(entry => entry.id !== clean.id);
    const index = before.connections.findIndex(entry => entry.id === clean.id);
    next.splice(index < 0 ? next.length : index, 0, clean);
    const intended = { connections: normalizeModelConnections(next), defaults: before.defaults, modelPreferences: before.modelPreferences };
    try { return update({ expectedRevision, connections: next }); }
    catch {
      // Settings may already be durable if an observer failed after its atomic
      // write. Prove the whole intended model state and its new revision; an
      // already-active credential pointer alone cannot prove this commit.
      const observed = get();
      const committed = snapshot();
      if (committed.revision === expectedRevision + 1
        && JSON.stringify({ connections: committed.connections, defaults: committed.defaults, modelPreferences: committed.modelPreferences }) === JSON.stringify(intended)) return observed;
      fail('MODEL_CONFIGURATION_COMMIT_FAILED', 'The requested model configuration was not confirmed. Credentials are retained; refresh current settings and explicitly retry or reconcile the connection.',
        { recovery: { state: 'credential-prepared', credentialRef: prepared.provider, connectionId: clean.id,
          configurationRevision: observed.revision, previousCredentialRef: existing?.credentialRef ?? null } });
    }
  }
  return Object.freeze({ get, update, listEnabledModels, discover, testAndCommitConnection, hasKey, defaultProviderId,
    provider, resolveSelection, isManaged: () => !snapshot().derived });
}
