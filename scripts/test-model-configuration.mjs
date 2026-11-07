// Real isolated Settings + Secrets + Runtime and owned loopback HTTP requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as model from '../src/model/index.js';
import { createSettingsStore } from '../src/settings/store.js';
import { createProviderSecrets } from '../src/providers/secrets.js';

assert.equal(typeof model.createModelConfiguration, 'function', 'Model Runtime exports its Settings-backed configuration owner');
const tempBase = path.resolve(process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir());
fs.mkdirSync(tempBase, { recursive: true });
const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(tempBase, 'model-configuration-')));
const oldKey = 'sk-fixture-existing-private-12345';
const newKey = 'sk-fixture-candidate-private-67890';
const requests = [];
let status = 200;
let responseModel = 'peer-reported-model';
let catalogHook = null;
let responseFault = null;
const server = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  requests.push({ path: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : null });
  if (req.url.endsWith('/models')) {
    if (catalogHook) { catalogHook(req, res); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { data: [{ id: 'gpt-5-fixture', capabilities: { tools: true, reasoning: true } }, { id: 'other' }] } : { error: newKey }));
  } else if (req.url.endsWith('/chat/completions')) {
    const body = JSON.parse(text);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (responseFault === 'malformed-stream') {
        res.end(`data: ${JSON.stringify({ ...(responseModel ? { model: responseModel } : {}), choices: [{ delta: { content: 'fixture reply' } }] })}\n\ndata: {invalid-json\n\n`);
        return;
      }
      res.end(`data: ${JSON.stringify({ ...(responseModel ? { model: responseModel } : {}), choices: [{ delta: { content: 'fixture reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...(responseModel ? { model: responseModel } : {}), choices: [{ message: { content: responseFault === 'tool-protocol' ? '<||DSML||function_call>' : 'fixture reply' }, finish_reason: 'stop' }] }));
    }
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function fixture(dir, { officialDefaults = false, fetchImpl = fetch } = {}) {
  const settingsStore = createSettingsStore({ stateDir: path.join(dir, 'state') });
  const secrets = createProviderSecrets({ root: dir });
  const registry = model.createModelProviderRegistry({ providers: [
    model.createOpenAiCompatibleModelProvider({ id: 'deepseek-official', label: 'DeepSeek', baseUrl: officialDefaults ? 'https://api.deepseek.com' : base, defaultModel: 'deepseek-flash', secrets, fetchImpl }),
    model.createOpenAiCompatibleModelProvider({ id: 'openai', label: 'OpenAI', baseUrl: officialDefaults ? 'https://api.openai.com/v1' : base, defaultModel: 'gpt-4o-mini', secrets, fetchImpl, reasoningParam: 'reasoning_effort', supportsTools: true }),
    model.createOpenAiCompatibleModelProvider({ id: 'openai-compatible', label: 'Compatible', baseUrl: '', secrets, fetchImpl })
  ] });
  const configuration = model.createModelConfiguration({ settingsStore, secrets, registry, fetchImpl });
  const runtime = model.createModelRuntimeService({ registry, secrets, configuration });
  return { settingsStore, secrets, registry, configuration, runtime };
}
let checks = 0;
const ok = label => console.log(`PASS ${++checks}: ${label}`);
try {
  const partial = fixture(path.join(temp, 'partial-edit'));
  assert.equal(typeof partial.configuration.editConnection, 'function', 'Model Configuration exposes an authoritative incremental connection edit');
  let partialView = await partial.configuration.testAndCommitConnection({ expectedRevision: 0,
    connection: { id: 'partial-a', label: 'Partial A', protocolProfile: 'openai-chat-v1', enabled: true },
    candidate: { apiKey: oldKey, baseUrl: `${base}/partial` } });
  const catalogFact = { value: true, source: 'protocol-declared', status: 'declared', ruleId: null, version: 'model-catalog-v1' };
  partialView = partial.configuration.update({ expectedRevision: partialView.revision,
    connections: partialView.connections.map(entry => entry.id === 'partial-a' ? { ...entry, models: Array.from({ length: 160 }, (_, index) => ({
      id: `review-${index}`, enabled: index === 159, manualCapabilities: { reasoning: true, vision: false }, discoveredCapabilities: { tools: catalogFact, ...(index === 139 ? { reasoning: { ...catalogFact, value: false } } : {}) }
    })) } : entry),
    modelPreferences: Array.from({ length: 140 }, (_, index) => ({ connectionId: 'partial-a', modelId: `review-${index}`, reasoningEffort: 'low' })) });
  const partialBefore = structuredClone(partialView), secretBytes = fs.readFileSync(partial.secrets.filePath, 'utf8');
  partialView = partial.configuration.editConnection({ expectedRevision: partialView.revision, connectionId: 'partial-a', patch: {
    label: 'Reviewed A', modelChanges: [{ id: 'review-0', enabled: true }, { id: 'exact-manual', enabled: false, manualCapabilities: { reasoning: true, tools: false } }],
    preferences: [{ modelId: 'review-0', reasoningEffort: 'high' }]
  } });
  const editedA = partialView.connections.find(entry => entry.id === 'partial-a'), beforeA = partialBefore.connections.find(entry => entry.id === 'partial-a');
  assert.equal(partialView.revision, partialBefore.revision + 1);
  assert.equal(editedA.models.length, 161);
  assert.deepEqual(editedA.models.find(entry => entry.id === 'review-159'), beforeA.models.find(entry => entry.id === 'review-159'), 'unloaded rows retain all metadata');
  assert.deepEqual(editedA.models[0].manualCapabilities, beforeA.models[0].manualCapabilities, 'an enabled-only patch preserves manual declarations');
  assert.deepEqual(editedA.models[0].discoveredCapabilities, beforeA.models[0].discoveredCapabilities, 'catalog provenance survives a row edit');
  assert.equal(editedA.credentialRef, beforeA.credentialRef);
  assert.deepEqual(partialView.connections.filter(entry => entry.id !== 'partial-a'), partialBefore.connections.filter(entry => entry.id !== 'partial-a'));
  assert.deepEqual(partialView.defaults, partialBefore.defaults);
  assert.deepEqual(partialView.modelPreferences.slice(1), partialBefore.modelPreferences.slice(1), 'preferences outside the public page survive');
  assert.equal(partialView.modelPreferences[0].reasoningEffort, 'high');
  assert.equal(fs.readFileSync(partial.secrets.filePath, 'utf8'), secretBytes, 'incremental edits cannot rotate or rebind credentials');
  ok('incremental edits preserve hidden models, provenance, other connections, credentials and unloaded preferences');
  const invalidPatches = [
    { credentialRef: 'openai' }, { protocolProfile: 'deepseek-chat-v1' }, { enabled: 'true' },
    { modelChanges: [{ id: 'review-0', enabled: false }, { id: ' review-0 ', enabled: true }] },
    { modelChanges: [{ id: 'review-0', discoveredCapabilities: {} }] },
    { modelChanges: [{ id: 'review-0', manualCapabilities: { maxOutputTokens: 200, contextWindowTokens: 100 } }] },
    { modelChanges: [{ id: 'review-0', remove: true, enabled: true }] },
    { preferences: [{ modelId: 'review-0', reasoningEffort: 'high' }, { modelId: ' review-0 ', reasoningEffort: 'low' }] },
    { preferences: [{ modelId: 'not-in-catalog', reasoningEffort: 'high' }] },
    { preferences: [{ modelId: 'review-139', reasoningEffort: 'high' }] },
    { modelChanges: [{ id: 'no-reasoning', manualCapabilities: { reasoning: false } }], preferences: [{ modelId: 'no-reasoning', reasoningEffort: 'high' }] }
  ];
  for (const patch of invalidPatches) {
    assert.throws(() => partial.configuration.editConnection({ expectedRevision: partialView.revision, connectionId: 'partial-a', patch }), error => error.code === 'SETTINGS_INVALID');
    assert.equal(partial.configuration.get().revision, partialView.revision, 'invalid row edits do not write');
  }
  assert.throws(() => partial.configuration.editConnection({ expectedRevision: partialView.revision - 1, connectionId: 'partial-a', patch: { enabled: false } }), error => error.code === 'SETTINGS_CONFLICT');
  assert.throws(() => partial.configuration.editConnection({ expectedRevision: partialView.revision, connectionId: 'missing', patch: { enabled: false } }), error => error.code === 'MODEL_PROVIDER_UNKNOWN');
  partialView = partial.configuration.editConnection({ expectedRevision: partialView.revision, connectionId: 'partial-a', patch: { enabled: false } });
  partialView = partial.configuration.editConnection({ expectedRevision: partialView.revision, connectionId: 'partial-a', patch: { enabled: true, modelChanges: [{ id: 'review-1', enabled: true }] } });
  assert.ok(partial.configuration.listEnabledModels({ connectionId: 'partial-a' }).some(entry => entry.id === 'review-1'));
  ok('partial edits reject stale/duplicate/credential/capability errors and allow explicit disabled-connection recovery');
  const first = fixture(temp);
  first.secrets.set({ provider: 'openai', apiKey: oldKey, baseUrl: base });
  const legacy = first.configuration.get();
  assert.equal(legacy.derived, true);
  assert.deepEqual(legacy.connections.map(connection => connection.id), ['deepseek-official', 'openai', 'openai-compatible']);
  assert.equal(fs.existsSync(first.settingsStore.file), false, 'reading derived configuration never migrates production settings');
  await first.runtime.chat({ providerId: 'openai', model: 'legacy-arbitrary-model', messages: [{ role: 'user', content: 'legacy' }] });
  assert.equal(requests.at(-1).body.model, 'legacy-arbitrary-model');
  ok('legacy IDs and arbitrary existing model choices work without writing a migration');

  const originFixture = fixture(path.join(temp, 'origin'));
  originFixture.secrets.set({ provider: 'openai', apiKey: oldKey });
  const beforeOriginTest = requests.length;
  await assert.rejects(originFixture.configuration.discover({ connectionId: 'openai', candidate: { baseUrl: base } }), error => error.code === 'MODEL_CREDENTIAL_ORIGIN_MISMATCH');
  assert.equal(requests.length, beforeOriginTest, 'saved official credentials cannot silently follow a candidate origin');
  ok('credential fallback is limited to the previous service origin, including built-in default URLs');

  const connection = { id: 'fixture-a', label: 'Fixture A', protocolProfile: 'openai-chat-v1', enabled: true,
    models: [{ id: 'gpt-5-fixture', enabled: true, manualCapabilities: { tools: false, reasoning: true } }] };
  const saved = await first.configuration.testAndCommitConnection({ expectedRevision: legacy.revision, connection, candidate: { apiKey: newKey, baseUrl: `${base}/a` } });
  assert.equal(saved.derived, false);
  assert.equal(saved.connections.find(entry => entry.id === 'fixture-a').models.find(entry => entry.id === 'other').enabled, false);
  assert.equal(JSON.stringify(saved).includes(newKey) || JSON.stringify(saved).includes(base), false);
  const observations = [];
  const reply = await first.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-fixture', reasoning: 'max', messages: [{ role: 'user', content: 'private prompt' }], onConfiguration: value => observations.push(value) });
  assert.equal(reply.text, 'fixture reply');
  assert.equal(requests.at(-1).path, '/a/chat/completions');
  assert.equal(requests.at(-1).body.model, 'gpt-5-fixture');
  assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  assert.equal(requests.at(-1).authorization, `Bearer ${newKey}`);
  assert.equal(reply.configurationObservation.requested.reasoning, 'max');
  assert.equal(reply.configurationObservation.effective.reasoning, 'high');
  assert.equal(reply.configurationObservation.response.model, 'peer-reported-model');
  assert.equal(reply.configurationObservation.application, 'current-request');
  assert.equal(reply.configurationObservation.connectionRevision, saved.revision);
  assert.equal(observations.at(-1).response.model, 'peer-reported-model');
  assert.equal(JSON.stringify(observations).includes(newKey) || JSON.stringify(observations).includes('private prompt') || JSON.stringify(observations).includes(base), false);
  assert.equal(first.runtime.supportsToolCalling('fixture-a', 'gpt-5-fixture'), false);
  ok('new connection is used by ordinary Runtime with exact model/effort projection and private-free observations');

  const loaded = fixture(temp);
  assert.equal(loaded.configuration.get().revision, saved.revision);
  const reloadedHealth = await loaded.runtime.health('fixture-a');
  assert.equal(reloadedHealth.configured, true, 'health resolves a configured connection before any chat/list call');
  const implicitReply = await loaded.runtime.chat({ providerId: 'fixture-a', messages: [{ role: 'user', content: 'reloaded' }] });
  assert.equal(implicitReply.requestedModel, 'provider-default', 'configuration defaults are effective choices, not explicit requests');
  assert.equal(implicitReply.configurationObservation.requested.model, null);
  assert.equal(requests.at(-1).path, '/a/chat/completions');
  const secondConnection = { ...connection, id: 'fixture-b', label: 'Fixture B' };
  const second = await loaded.configuration.testAndCommitConnection({ expectedRevision: loaded.configuration.get().revision, connection: secondConnection, candidate: { apiKey: oldKey, baseUrl: `${base}/b` } });
  assert.deepEqual(loaded.configuration.listEnabledModels().filter(entry => entry.id === 'gpt-5-fixture').map(entry => entry.connectionId), ['fixture-a', 'fixture-b']);
  await loaded.runtime.chat({ providerId: 'fixture-b', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'endpoint b' }] });
  assert.equal(requests.at(-1).path, '/b/chat/completions');
  assert.equal(requests.at(-1).authorization, `Bearer ${oldKey}`);
  const view = loaded.configuration.get();
  const manual = view.connections.find(entry => entry.id === 'fixture-a').models.find(entry => entry.id === 'gpt-5-fixture');
  assert.equal(manual.capabilities.tools.source, 'manual');
  assert.equal(manual.capabilities.tools.value, false);
  await loaded.configuration.discover({ connectionId: 'fixture-a' });
  assert.equal(loaded.configuration.get().connections.find(entry => entry.id === 'fixture-a').models.find(entry => entry.id === 'gpt-5-fixture').manualCapabilities.tools, false);
  ok('reload, same-name models on independent endpoints and manual provenance remain stable');

  const beforeSharedChange = loaded.configuration.get();
  const existingA = beforeSharedChange.connections.find(entry => entry.id === 'fixture-a');
  const rotated = await loaded.configuration.testAndCommitConnection({ expectedRevision: beforeSharedChange.revision,
    connection: { ...existingA, models: [{ id: 'gpt-5-fixture', enabled: true }, { id: 'other', enabled: true }] },
    candidate: { apiKey: newKey, baseUrl: `${base}/a-updated` } });
  const refreshedA = rotated.connections.find(entry => entry.id === 'fixture-a');
  assert.equal(refreshedA.models.find(entry => entry.id === 'gpt-5-fixture').manualCapabilities.tools, false, 'a catalog refresh cannot erase a previously manual field omitted from the request');
  for (const chosen of ['gpt-5-fixture', 'other']) {
    await loaded.runtime.chat({ providerId: 'fixture-a', model: chosen, messages: [{ role: 'user', content: 'shared endpoint update' }] });
    assert.equal(requests.at(-1).path, '/a-updated/chat/completions');
    assert.equal(requests.at(-1).body.model, chosen);
  }
  assert.equal(loaded.runtime.supportsToolCalling('fixture-a', 'gpt-5-fixture'), false);
  assert.equal(loaded.runtime.modelCapabilities('fixture-a', 'gpt-5-fixture').tools.status, 'unsupported');
  assert.equal(loaded.configuration.get().recovery.length, 0, 'a superseded credential is retained without being mislabeled as a failed preparation');
  ok('shared endpoint changes reach every referenced model and preserve omitted manual overrides');

  const compatibleSaved = await loaded.configuration.testAndCommitConnection({ expectedRevision: loaded.configuration.get().revision,
    connection: { id: 'fixture-compatible', label: 'Compatible control', protocolProfile: 'openai-compatible-v1', enabled: true,
      models: [{ id: 'gpt-5-fixture', enabled: true, manualCapabilities: {} }] }, candidate: { apiKey: newKey, baseUrl: `${base}/compatible` } });
  await loaded.runtime.chat({ providerId: 'fixture-compatible', model: 'gpt-5-fixture', reasoning: 'max', messages: [{ role: 'user', content: 'preserve compatible default' }] });
  assert.equal(Object.hasOwn(requests.at(-1).body, 'reasoning_effort'), false, 'compatible reasoning remains opt-in under the old setting');
  loaded.configuration.update({ expectedRevision: compatibleSaved.revision, connections: compatibleSaved.connections.map(entry => entry.id === 'fixture-compatible' ? { ...entry,
    models: entry.models.map(value => ({ ...value, manualCapabilities: { ...value.manualCapabilities, reasoning: true } })) } : entry) });
  await loaded.runtime.chat({ providerId: 'fixture-compatible', model: 'gpt-5-fixture', reasoning: 'max', messages: [{ role: 'user', content: 'manual compatible override' }] });
  assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  ok('compatible protocol preserves its legacy opt-in while a model-specific manual declaration controls the real wire');

  loaded.secrets.set({ provider: 'plugin-unrelated-account', apiKey: 'sk-unrelated-account-private-12345', baseUrl: base });
  const safeBefore = loaded.configuration.get();
  loaded.configuration.update({ expectedRevision: safeBefore.revision, connections: [...safeBefore.connections,
    { id: 'plugin-unrelated-account', label: 'Unbound new connection', enabled: true, protocolProfile: 'openai-chat-v1',
      models: [{ id: 'gpt-5-fixture', enabled: true, manualCapabilities: {} }] }] });
  assert.equal(loaded.configuration.get().connections.find(entry => entry.id === 'plugin-unrelated-account').configured, false);
  const beforeUnbound = requests.length;
  await assert.rejects(loaded.runtime.chat({ providerId: 'plugin-unrelated-account', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'refuse unrelated key' }] }), error => error.code === 'MODEL_PROVIDER_KEY_MISSING');
  assert.equal(requests.length, beforeUnbound);
  loaded.configuration.update({ expectedRevision: loaded.configuration.get().revision, connections: safeBefore.connections });
  ok('new connection IDs cannot borrow unrelated credentials by coinciding with a SecretStore ID');

  const beforeFailure = loaded.configuration.get();
  const secretsBefore = fs.readFileSync(path.join(temp, 'state', 'provider-keys.json'), 'utf8');
  status = 401;
  await assert.rejects(loaded.configuration.testAndCommitConnection({ expectedRevision: beforeFailure.revision, connection, candidate: { apiKey: 'sk-candidate-bad-key-1234', baseUrl: `${base}/rejected` } }), error => error.code === 'MODEL_DISCOVERY_HTTP_ERROR');
  assert.equal(loaded.configuration.get().revision, beforeFailure.revision);
  assert.equal(fs.readFileSync(path.join(temp, 'state', 'provider-keys.json'), 'utf8'), secretsBefore);
  status = 200;
  const disabled = beforeFailure.connections.map(entry => ({ ...entry, enabled: false }));
  const allOff = loaded.configuration.update({ expectedRevision: beforeFailure.revision, connections: disabled });
  assert.throws(() => loaded.runtime.defaultProviderId(), error => error.code === 'MODEL_NO_ENABLED_MODELS', 'legacy consumers cannot interpret all-disabled as permission to fall back to DSH');
  assert.throws(() => loaded.runtime.resolveProvider(null), error => error.code === 'MODEL_NO_ENABLED_MODELS');
  const requestCount = requests.length;
  await assert.rejects(loaded.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'blocked' }] }), error => error.code === 'MODEL_CONNECTION_DISABLED');
  assert.equal(requests.length, requestCount);
  assert.throws(() => loaded.configuration.update({ expectedRevision: beforeFailure.revision, connections: disabled }), error => error.code === 'SETTINGS_CONFLICT');
  ok('failed candidate preserves old bytes and all-disabled Runtime cannot fall through to legacy keys');

  loaded.configuration.update({ expectedRevision: allOff.revision, connections: beforeFailure.connections });
  responseModel = null;
  const streamEvents = [];
  for await (const event of loaded.runtime.stream({ providerId: 'fixture-a', model: 'gpt-5-fixture', reasoning: 'low', messages: [{ role: 'user', content: 'stream' }] })) streamEvents.push(event);
  assert.equal(requests.at(-1).body.reasoning_effort, 'low');
  const ended = streamEvents.find(event => event.type === 'turn/end');
  assert.equal(ended.data.configurationObservation.response.model, null, 'missing response model is unknown');
  assert.equal(ended.data.configurationObservation.effective.model, 'gpt-5-fixture');
  ok('stream uses the same configuration and does not fill unknown response facts from the request');

  const beforeStreamingOff = loaded.configuration.get();
  const streamingOff = beforeStreamingOff.connections.map(entry => entry.id !== 'fixture-a' ? entry : ({ ...entry,
    models: entry.models.map(value => ({ ...value, manualCapabilities: { ...value.manualCapabilities, streaming: false } })) }));
  loaded.configuration.update({ expectedRevision: beforeStreamingOff.revision, connections: streamingOff });
  const beforeBlockedStream = requests.length;
  await assert.rejects(async () => { for await (const _event of loaded.runtime.stream({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'disabled stream' }] })) {} }, error => error.code === 'MODEL_STREAMING_UNSUPPORTED');
  assert.equal(requests.length, beforeBlockedStream);
  loaded.configuration.update({ expectedRevision: loaded.configuration.get().revision, connections: beforeStreamingOff.connections });
  ok('per-model streaming refusal occurs before an outbound request');

  const delayedStreamView = loaded.configuration.get();
  const delayedStream = loaded.runtime.stream({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'deferred consumer' }] });
  loaded.configuration.update({ expectedRevision: delayedStreamView.revision, connections: delayedStreamView.connections.map(entry => entry.id === 'fixture-a' ? { ...entry, enabled: false } : entry) });
  const beforeDeferred = requests.length;
  await assert.rejects(async () => { for await (const _event of delayedStream) {} }, error => error.code === 'MODEL_CONFIGURATION_CHANGED');
  assert.equal(requests.length, beforeDeferred, 'a stream created before disablement cannot dispatch after it');
  loaded.configuration.update({ expectedRevision: loaded.configuration.get().revision, connections: delayedStreamView.connections });
  ok('deferred stream consumption revalidates the exact configuration immediately before dispatch');

  const race = fixture(path.join(temp, 'race'));
  race.secrets.set({ provider: 'openai', apiKey: oldKey, baseUrl: base });
  const raceConnection = { ...connection, id: 'openai' };
  const beforeCancellation = fs.readFileSync(race.secrets.filePath, 'utf8');
  catalogHook = (_req, res) => { res.writeHead(200); res.write('['); };
  const abort = new AbortController();
  const pendingCancelled = race.configuration.testAndCommitConnection({ expectedRevision: 0, connection: raceConnection,
    candidate: { apiKey: newKey, baseUrl: base }, signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pendingCancelled, error => error.code === 'ABORTED');
  assert.equal(fs.readFileSync(race.secrets.filePath, 'utf8'), beforeCancellation);
  assert.equal(fs.existsSync(race.settingsStore.file), false);
  let reached;
  let finishCatalog;
  const waiting = new Promise(resolve => { reached = resolve; });
  catalogHook = (_req, res) => { finishCatalog = () => { res.writeHead(200); res.end(JSON.stringify(['gpt-5-fixture'])); }; reached(); };
  const pendingRevision = race.configuration.testAndCommitConnection({ expectedRevision: 0, connection: raceConnection,
    candidate: { apiKey: newKey, baseUrl: base } });
  await waiting;
  race.settingsStore.update('general', { language: 'en-US' }, { expectedRev: 0 });
  finishCatalog();
  await assert.rejects(pendingRevision, error => error.code === 'SETTINGS_CONFLICT');
  assert.equal(fs.readFileSync(race.secrets.filePath, 'utf8'), beforeCancellation, 'late successful network test cannot prepare credentials for an obsolete configuration');

  let reachedSecret;
  const waitingSecret = new Promise(resolve => { reachedSecret = resolve; });
  catalogHook = (_req, res) => { finishCatalog = () => { res.writeHead(200); res.end(JSON.stringify(['gpt-5-fixture'])); }; reachedSecret(); };
  const pendingSecret = race.configuration.testAndCommitConnection({ expectedRevision: race.configuration.get().revision, connection: raceConnection,
    candidate: { apiKey: newKey, baseUrl: base } });
  await waitingSecret;
  race.secrets.set({ provider: 'openai', apiKey: 'sk-owner-rotation-private-112233', baseUrl: base });
  finishCatalog();
  await assert.rejects(pendingSecret, error => error.code === 'MODEL_CONFIGURATION_CHANGED');
  assert.equal(race.secrets.list().some(entry => entry.provider.startsWith('mc-')), false);
  catalogHook = null;
  ok('cancellation and late configuration/credential changes retain old state without activating prepared keys');

  const durable = fixture(path.join(temp, 'partial'));
  const durableSnapshot = durable.configuration.get();
  fs.mkdirSync(path.dirname(durable.settingsStore.file), { recursive: true });
  fs.mkdirSync(durable.settingsStore.file); // A real filesystem failure at atomic replacement.
  let recovery;
  await assert.rejects(durable.configuration.testAndCommitConnection({ expectedRevision: durableSnapshot.revision, connection, candidate: { apiKey: newKey, baseUrl: `${base}/prepared` } }), error => {
    assert.equal(error.code, 'MODEL_CONFIGURATION_COMMIT_FAILED');
    recovery = error.recovery;
    assert.equal(recovery.state, 'credential-prepared');
    assert.equal(JSON.stringify(error).includes(newKey), false);
    return true;
  });
  assert.equal(durable.configuration.get().derived, true);
  const prepared = durable.secrets.list().find(entry => entry.provider === recovery.credentialRef);
  assert.equal(prepared.modelPreparation.connectionId, 'fixture-a');
  fs.rmdirSync(durable.settingsStore.file);
  const reconstructed = fixture(path.join(temp, 'partial'));
  assert.equal(reconstructed.configuration.get().recovery[0].credentialRef, recovery.credentialRef);
  const recovered = await reconstructed.configuration.testAndCommitConnection({ expectedRevision: reconstructed.configuration.get().revision, connection, candidate: { credentialRef: recovery.credentialRef } });
  assert.equal(recovered.connections.find(entry => entry.id === 'fixture-a').credentialRef, recovery.credentialRef);
  assert.throws(() => reconstructed.secrets.set({ provider: recovery.credentialRef, apiKey: oldKey, baseUrl: base }), error => error.code === 'PROVIDER_SECRET_IMMUTABLE', 'prepared references cannot be silently rebound by generic secret updates');
  await reconstructed.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'recovered' }] });
  assert.equal(requests.at(-1).path, '/prepared/chat/completions');
  ok('cross-file partial success retains recoverable preparation metadata across reload and explicit retry');

  // Consolidated reviewer regression wave. Each independent finding runs even
  // when an earlier one fails, so the RED run identifies all six actual breaks.
  responseModel = 'organization/review-reported-model';
  const reviewFailures = [];
  async function reviewRegression(id, operation) {
    try { await operation(); ok(`${id} reviewed backend regression`); }
    catch (error) { console.error(`REVIEW_RED ${id}: ${error.message}`); reviewFailures.push({ id, error }); }
  }
  await reviewRegression('R11-B01', async () => {
    const endpoints = [];
    const loopbackTransport = (url, init) => { endpoints.push(String(url)); return fetch(`${base}${new URL(url).pathname}`, init); };
    const root = path.join(temp, 'review-defaults');
    const initial = fixture(root, { officialDefaults: true, fetchImpl: loopbackTransport });
    for (const provider of ['deepseek-official', 'openai']) initial.secrets.set({ provider, apiKey: oldKey });
    for (const providerId of ['deepseek-official', 'openai']) await initial.runtime.chat({ providerId, messages: [{ role: 'user', content: 'before materialization' }] });
    assert.deepEqual(endpoints, ['https://api.deepseek.com/chat/completions', 'https://api.openai.com/v1/chat/completions']);
    initial.configuration.update({ expectedRevision: 0, modelPreferences: [{ connectionId: 'openai', modelId: 'gpt-4o-mini', reasoningEffort: 'high' }] });
    for (const owner of [initial, fixture(root, { officialDefaults: true, fetchImpl: loopbackTransport })]) {
      for (const providerId of ['deepseek-official', 'openai']) await owner.runtime.chat({ providerId, messages: [{ role: 'user', content: 'after materialization' }] });
    }
    assert.deepEqual(endpoints.slice(-4), ['https://api.deepseek.com/chat/completions', 'https://api.openai.com/v1/chat/completions',
      'https://api.deepseek.com/chat/completions', 'https://api.openai.com/v1/chat/completions']);
    assert.ok(initial.secrets.list().every(entry => entry.baseUrl === ''), 'preserving fixed adapter defaults never migrates old key records');
  });
  await reviewRegression('R11-B02', async () => {
    for (const reset of ['null', 'section', 'all']) {
      const root = path.join(temp, `review-reset-${reset}`);
      const resetFixture = fixture(root);
      resetFixture.secrets.set({ provider: 'openai', apiKey: oldKey, baseUrl: `${base}/original` });
      const managed = { ...connection, id: 'openai', label: 'Managed label' };
      await resetFixture.configuration.testAndCommitConnection({ expectedRevision: 0, connection: managed, candidate: { apiKey: newKey, baseUrl: `${base}/managed` } });
      await resetFixture.runtime.chat({ providerId: 'openai', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'managed before reset' }] });
      assert.equal(requests.at(-1).path, '/managed/chat/completions');
      await resetFixture.configuration.testAndCommitConnection({ expectedRevision: resetFixture.configuration.get().revision,
        connection: { ...connection, id: 'managed-only' }, candidate: { apiKey: newKey, baseUrl: `${base}/managed-only` } });
      await resetFixture.runtime.chat({ providerId: 'managed-only', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'register managed-only' }] });
      const credentialsBeforeReset = fs.readFileSync(resetFixture.secrets.filePath, 'utf8');
      if (reset === 'null') resetFixture.settingsStore.update('models', { connections: null });
      else if (reset === 'section') resetFixture.settingsStore.reset('models');
      else resetFixture.settingsStore.resetAll();
      assert.equal(resetFixture.configuration.get().derived, true);
      await resetFixture.runtime.chat({ providerId: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'legacy after reset' }] });
      assert.equal(requests.at(-1).path, '/original/chat/completions', `${reset} restores the direct legacy destination`);
      assert.equal(requests.at(-1).authorization, `Bearer ${oldKey}`);
      assert.deepEqual(resetFixture.runtime.listProviders().map(entry => entry.id), ['deepseek-official', 'openai', 'openai-compatible']);
      assert.equal(resetFixture.registry.require('openai').label, 'OpenAI');
      assert.equal(resetFixture.runtime.isRegistered('managed-only'), false);
      assert.equal(fs.readFileSync(resetFixture.secrets.filePath, 'utf8'), credentialsBeforeReset);
      const reload = fixture(root);
      await reload.runtime.chat({ providerId: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'reload equivalence' }] });
      assert.equal(requests.at(-1).path, '/original/chat/completions');
      assert.equal(requests.at(-1).authorization, `Bearer ${oldKey}`);
    }
  });
  await reviewRegression('R11-B03', async () => {
    const control = fixture(path.join(temp, 'review-manual-reasoning'));
    let view = await control.configuration.testAndCommitConnection({ expectedRevision: 0,
      connection: { ...connection, protocolProfile: 'openai-compatible-v1', models: [{ id: 'custom-reasoner', enabled: true, manualCapabilities: { reasoning: true } }] },
      candidate: { apiKey: newKey, baseUrl: `${base}/manual-reasoning` } });
    for (const [manual, expected] of [[true, 'high'], [false, undefined], [null, undefined]]) {
      view = control.configuration.update({ expectedRevision: view.revision, connections: view.connections.map(entry => entry.id === 'fixture-a' ? { ...entry,
        models: entry.models.map(value => value.id === 'custom-reasoner' ? { ...value, manualCapabilities: manual === null ? {} : { reasoning: manual } } : value) } : entry) });
      await control.runtime.chat({ providerId: 'fixture-a', model: 'custom-reasoner', reasoning: 'high', messages: [{ role: 'user', content: 'arbitrary manual reasoning' }] });
      assert.equal(requests.at(-1).body.reasoning_effort, expected, `manual ${manual} reaches the fixed compatible wire profile`);
    }
    view = control.configuration.update({ expectedRevision: view.revision, connections: view.connections.map(entry => entry.id === 'fixture-a' ? { ...entry,
      models: entry.models.map(value => value.id === 'custom-reasoner' ? { ...value, manualCapabilities: { reasoning: true }, discoveredCapabilities: {
        reasoning: { value: false, source: 'protocol-declared', status: 'declared', ruleId: null, version: 'model-catalog-v1' }
      } } : value) } : entry) });
    await control.runtime.chat({ providerId: 'fixture-a', model: 'custom-reasoner', reasoning: 'high', messages: [{ role: 'user', content: 'negative protocol evidence' }] });
    assert.equal(Object.hasOwn(requests.at(-1).body, 'reasoning_effort'), false);
    assert.equal(control.runtime.modelCapabilities('fixture-a', 'custom-reasoner').reasoning.status, 'unsupported');
  });
  await reviewRegression('R11-B04', async () => {
    const canonical = fixture(path.join(temp, 'review-canonical-models'));
    let view = await canonical.configuration.testAndCommitConnection({ expectedRevision: 0,
      connection: { ...connection, models: [
        { id: ' gpt-5-space ', enabled: true, manualCapabilities: { tools: false, streaming: false, reasoning: false } },
        { id: 'gpt-5-space', enabled: true, manualCapabilities: { tools: true, streaming: true, reasoning: true } },
        { id: ' gpt-5-pref ', enabled: true, manualCapabilities: { reasoning: true } }
      ] }, candidate: { apiKey: newKey, baseUrl: `${base}/canonical` } });
    assert.deepEqual(view.connections.find(entry => entry.id === 'fixture-a').models.filter(entry => entry.enabled).map(entry => entry.id), ['gpt-5-space', 'gpt-5-pref']);
    view = canonical.configuration.update({ expectedRevision: view.revision, defaults: { model: ' gpt-5-space ' },
      modelPreferences: [{ connectionId: 'fixture-a', modelId: ' gpt-5-pref ', reasoningEffort: 'low' }] });
    assert.equal(view.defaults.model, 'gpt-5-space');
    assert.equal(view.modelPreferences[0].modelId, 'gpt-5-pref');
    await canonical.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-space', reasoning: 'high', messages: [{ role: 'user', content: 'canonical explicit' }] });
    assert.equal(requests.at(-1).body.model, 'gpt-5-space');
    assert.equal(Object.hasOwn(requests.at(-1).body, 'reasoning_effort'), false);
    const count = requests.length;
    await assert.rejects(async () => { for await (const _event of canonical.runtime.stream({ providerId: 'fixture-a', messages: [{ role: 'user', content: 'canonical implicit stream' }] })) {} }, error => error.code === 'MODEL_STREAMING_UNSUPPORTED');
    await assert.rejects(canonical.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-space', messages: [{ role: 'user', content: 'canonical tools' }],
      tools: [{ id: 'fixture.read', description: 'Read synthetic data', inputSchema: { type: 'object', properties: {} } }] }), error => error.code === 'MODEL_TOOL_CALLING_UNSUPPORTED');
    assert.equal(requests.length, count);
    await canonical.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-pref', messages: [{ role: 'user', content: 'canonical model preference' }] });
    assert.equal(requests.at(-1).body.reasoning_effort, 'low');
    assert.throws(() => canonical.configuration.update({ expectedRevision: canonical.configuration.get().revision, modelPreferences: [
      { connectionId: 'fixture-a', modelId: ' gpt-5-pref ', reasoningEffort: 'low' },
      { connectionId: 'fixture-a', modelId: 'gpt-5-pref', reasoningEffort: 'high' }
    ] }), error => error.code === 'SETTINGS_INVALID');
  });
  await reviewRegression('R11-B05', async () => {
    const privacy = fixture(path.join(temp, 'review-observation-models'));
    await privacy.configuration.testAndCommitConnection({ expectedRevision: 0, connection: { ...connection,
      models: [{ id: 'gpt-5-fixture', enabled: true, manualCapabilities: { tools: true } }] }, candidate: { apiKey: newKey, baseUrl: `${base}/private-observation` } });
    for (const [reported, expected] of [
      ['https://internal.invalid/private-observation-path', null], ['file:///C:/private/model', null],
      ['C:\\private\\model', null], ['/home/private/model', null], ['\\\\private-host\\model', null],
      [newKey, null], [`organization/${newKey}`, null], ['organization/namespaced-model:variant', 'organization/namespaced-model:variant'],
      [null, null]
    ]) {
      responseModel = reported;
      const observations = [];
      const reply = await privacy.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'response projection' }], onConfiguration: entry => observations.push(entry) });
      assert.equal(reply.configurationObservation.response.model, expected);
      assert.equal(observations.at(-1).response.model, expected);
      const streamObservations = [];
      const events = [];
      for await (const event of privacy.runtime.stream({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'stream projection' }], onConfiguration: entry => streamObservations.push(entry) })) events.push(event);
      assert.equal(events.at(-1).data.configurationObservation.response.model, expected);
      assert.equal(streamObservations.at(-1).response.model, expected);
    }
    for (const [reported, expected] of [['https://private.invalid/error-model', null], [newKey, null], ['organization/error-model', 'organization/error-model']]) {
      responseModel = reported;
      const chatErrors = [];
      responseFault = 'tool-protocol';
      await assert.rejects(privacy.runtime.chat({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'error observation' }],
        tools: [{ id: 'fixture.read', description: 'Read synthetic data', inputSchema: { type: 'object', properties: {} } }], onConfiguration: value => chatErrors.push(value) }), error => {
        assert.equal(error.code, 'MODEL_TOOL_PROTOCOL_MISMATCH');
        assert.equal(error.configurationObservation.response.model, expected);
        assert.equal(error.resolvedModel, expected);
        return true;
      });
      assert.equal(chatErrors.at(-1).response.model, expected);
      responseFault = 'malformed-stream';
      const streamErrors = [];
      await assert.rejects(async () => { for await (const _event of privacy.runtime.stream({ providerId: 'fixture-a', model: 'gpt-5-fixture', messages: [{ role: 'user', content: 'error stream' }],
        onConfiguration: value => streamErrors.push(value) })) {} }, error => {
        assert.equal(error.configurationObservation.response.model, expected);
        assert.equal(error.resolvedModel, expected);
        return true;
      });
      assert.equal(streamErrors.at(-1).response.model, expected);
    }
    responseFault = null;
    responseModel = 'organization/review-reported-model';
    const urlModel = 'https://private.invalid/requested-model';
    const previous = privacy.configuration.get();
    privacy.configuration.update({ expectedRevision: previous.revision, connections: previous.connections.map(entry => entry.id === 'fixture-a' ? { ...entry,
      models: [...entry.models, { id: urlModel, enabled: true, manualCapabilities: {} }] } : entry) });
    const urlReply = await privacy.runtime.chat({ providerId: 'fixture-a', model: urlModel, messages: [{ role: 'user', content: 'unsafe observation identifier' }] });
    assert.equal(urlReply.configurationObservation.requested.model, null);
    assert.equal(urlReply.configurationObservation.effective.model, null);
    assert.equal(JSON.stringify(urlReply.configurationObservation).includes(urlModel), false);
  });
  await reviewRegression('R11-B06', async () => {
    const active = fixture(path.join(temp, 'review-active-ref'));
    const before = await active.configuration.testAndCommitConnection({ expectedRevision: 0, connection, candidate: { apiKey: newKey, baseUrl: `${base}/active-ref` } });
    const activeConnection = before.connections.find(entry => entry.id === 'fixture-a');
    const ref = activeConnection.credentialRef;
    for (const change of [{ label: 'Requested changed label' }, { protocolProfile: 'openai-compatible-v1' }, { enabled: false },
      { models: [{ id: 'requested-new-model', enabled: true, manualCapabilities: {} }] }]) {
      const originalBytes = fs.readFileSync(active.settingsStore.file, 'utf8');
      const savedFile = `${active.settingsStore.file}.review-preserved`;
      fs.renameSync(active.settingsStore.file, savedFile);
      fs.mkdirSync(active.settingsStore.file);
      try {
        await assert.rejects(active.configuration.testAndCommitConnection({ expectedRevision: before.revision,
          connection: { ...activeConnection, ...change }, candidate: { credentialRef: ref } }), error => error.code === 'MODEL_CONFIGURATION_COMMIT_FAILED');
        assert.equal(active.configuration.get().revision, before.revision);
        assert.equal(active.configuration.get().connections.find(entry => entry.id === 'fixture-a').label, activeConnection.label);
      } finally {
        fs.rmdirSync(active.settingsStore.file);
        fs.renameSync(savedFile, active.settingsStore.file);
      }
      assert.equal(fs.readFileSync(active.settingsStore.file, 'utf8'), originalBytes);
    }
    const stop = active.settingsStore.onChange(() => { throw new Error('synthetic observer failure after the real atomic write'); });
    const committed = await active.configuration.testAndCommitConnection({ expectedRevision: before.revision,
      connection: { ...activeConnection, label: 'Persisted despite observer failure' }, candidate: { credentialRef: ref } });
    stop();
    assert.equal(committed.revision, before.revision + 1);
    assert.equal(committed.connections.find(entry => entry.id === 'fixture-a').label, 'Persisted despite observer failure');
    assert.equal(fixture(path.join(temp, 'review-active-ref')).configuration.get().connections.find(entry => entry.id === 'fixture-a').label, 'Persisted despite observer failure');
    let unsubscribe;
    unsubscribe = active.settingsStore.onChange(() => {
      unsubscribe();
      active.settingsStore.update('models', { reasoningEffort: 'low' });
      throw new Error('synthetic observer changed defaults after the first atomic commit');
    });
    await assert.rejects(active.configuration.testAndCommitConnection({ expectedRevision: committed.revision,
      connection: { ...activeConnection, label: 'Committed connection but divergent defaults' }, candidate: { credentialRef: ref } }), error => {
      assert.equal(error.code, 'MODEL_CONFIGURATION_COMMIT_FAILED');
      assert.equal(error.recovery.configurationRevision, committed.revision + 2);
      return true;
    });
    assert.equal(active.configuration.get().defaults.reasoningEffort, 'low', 'divergent persisted facts are retained without fake rollback');
  });
  assert.equal(reviewFailures.length, 0, `Reviewer regressions remain: ${reviewFailures.map(entry => entry.id).join(', ')}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`Model configuration: ${checks} checks passed (isolated stores and owned loopback only).`);
