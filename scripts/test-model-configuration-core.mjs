import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-model-configuration-core-')));
const calls = [];
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  calls.push({ path: request.url, body: body ? JSON.parse(body) : null });
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixture-a', capabilities: { reasoning: true } }, { id: 'fixture-b' }] }));
  if (request.url === '/v1/chat/completions' && body && JSON.parse(body).stream === true) {
    response.setHeader('content-type', 'text/event-stream');
    return response.end('data: ' + JSON.stringify({ model: 'observed-fixture', choices: [{ delta: { content: 'stream fixture content' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  }
  if (request.url === '/v1/chat/completions') return response.end(JSON.stringify({ model: 'observed-fixture', choices: [{ message: { content: 'local core config reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
  response.statusCode = 404; response.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let services, reviewServices;
try {
  services = createCetaMeshServices({ stateDir: path.join(root, 'state'), dataRoot: path.join(root, 'data'), deferOptionalStart: true });
  const ui = (method, params = {}) => services.desktopUiService.execute({ method, params });
  const baseline = await ui('ui.models.configuration.get');
  assert.equal(baseline.derived, true);
  assert.deepEqual(baseline.connections.map(row => row.id), ['deepseek-official', 'openai', 'openai-compatible']);
  const chat = await ui('ui.chat.sessions.create', { title: 'Configuration recovery' });
  const reconciled = await ui('ui.chat.config.reconcile', { id: chat.id });
  assert.equal(reconciled.id, chat.id);
  assert.equal(reconciled.configuration.state, 'saved');
  assert.equal(reconciled.configuration.durable, true);
  const saved = await ui('ui.models.configuration.commit', { expectedRevision: baseline.revision,
    connection: { id: 'local-fixture', label: 'Local synthetic model', protocolProfile: 'openai-compatible-v1', enabled: true,
      models: [{ id: 'fixture-a', enabled: true, manualCapabilities: { streaming: true, tools: false, reasoning: false } }] },
    candidate: { apiKey: 'SYNTHETIC_MODEL_CONFIGURATION_SECRET', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } });
  assert.ok(saved.revision > baseline.revision);
  assert.equal(saved.connections.find(row => row.id === 'local-fixture').models.find(row => row.id === 'fixture-b').enabled, false);
  assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC_MODEL_CONFIGURATION_SECRET/);
  const result = await services.modelRuntime.chat({ providerId: 'local-fixture', model: 'fixture-a', messages: [{ role: 'user', content: 'only local model' }] });
  assert.equal(result.text, 'local core config reply');
  assert.equal(calls.at(-1).body.model, 'fixture-a', 'the ordinary composed Runtime uses the committed connection');
  const selected = services.modelConfiguration.resolveSelection({ providerId: 'local-fixture', model: 'fixture-a' });
  const delayed = services.modelRuntime.stream({ providerId: 'local-fixture', model: 'fixture-a', messages: [{ role: 'user', content: 'unrelated preference update' }] });
  services.settingsService.store.update('general', { theme: 'dark' });
  assert.doesNotThrow(selected.assertCurrent, 'changing the theme does not invalidate an unchanged model connection');
  const observed = [];
  for await (const event of delayed) observed.push(event);
  assert.match(JSON.stringify(observed), /stream fixture content/, 'the already prepared stream still sends its actual request after an unrelated Settings edit');
  const afterTheme = await ui('ui.models.configuration.get');
  const edited = await ui('ui.models.configuration.edit', { expectedRevision: afterTheme.revision, connectionId: 'local-fixture',
    patch: { label: 'Updated local fixture', modelChanges: [{ id: 'fixture-b', manualCapabilities: { tools: false } }] } });
  const editedConnection = edited.connections.find(row => row.id === 'local-fixture');
  assert.equal(editedConnection.label, 'Updated local fixture');
  assert.equal(editedConnection.models.find(row => row.id === 'fixture-a').enabled, true);
  assert.equal(editedConnection.models.find(row => row.id === 'fixture-b').enabled, false);
  assert.equal(editedConnection.configured, true);
  await ui('ui.onboarding.start');
  for (const stepId of ['welcome', 'provider', 'connection']) await ui('ui.onboarding.completeStep', { stepId });
  await assert.rejects(ui('ui.onboarding.setModel', { provider: 'local-fixture', model: 'fixture-a', expectedRevision: edited.revision - 1 }),
    { code: 'SETTINGS_CONFLICT' }, 'onboarding shares the authoritative model revision instead of overwriting a newer selection');
  await ui('ui.onboarding.setModel', { provider: 'local-fixture', model: 'fixture-a', expectedRevision: edited.revision });
  const configured = await ui('ui.models.configuration.get');
  assert.equal(configured.defaults.provider, 'local-fixture');
  assert.equal(configured.defaults.model, 'fixture-a');
  const requestCount = calls.length;
  const disabled = await ui('ui.models.configuration.update', { expectedRevision: configured.revision,
    connections: configured.connections.map(row => ({ id: row.id, label: row.label, protocolProfile: row.protocolProfile,
      enabled: false, credentialRef: row.credentialRef, models: row.models.map(model => ({ id: model.id, enabled: false, manualCapabilities: model.manualCapabilities })) })) });
  assert.equal(disabled.connections.find(row => row.id === 'local-fixture').configured, true, 'round-tripping the Owner DTO must retain the opaque credential binding');
  await assert.rejects(services.modelRuntime.chat({ providerId: 'local-fixture', model: 'fixture-a', messages: [{ role: 'user', content: 'must not dispatch' }] }), { code: 'MODEL_CONNECTION_DISABLED' });
  assert.equal(calls.length, requestCount);
  assert.equal((await ui('ui.models.configuration.get')).revision, disabled.revision, 'settings remain reachable with all model connections disabled');
  assert.throws(() => services.modelRuntime.defaultProviderId(), { code: 'MODEL_NO_ENABLED_MODELS' });
  const catalog = await ui('ui.chat.catalog', { id: chat.id });
  assert.equal(catalog.defaultModelProvider, null);
  assert.equal(catalog.modelProviders.find(row => row.id === 'local-fixture').enabled, false);
  assert.equal(catalog.modelProviders.find(row => row.id === 'local-fixture').catalogState, 'disabled');
  await assert.rejects(ui('ui.models.configuration.update', { expectedRevision: saved.revision, connections: [] }), { code: 'SETTINGS_CONFLICT' });
  // Independent integration-review regressions: actual ordinary Core, not a
  // probe that passes by asserting the old defect. Keep all four REDs visible.
  reviewServices = createCetaMeshServices({ stateDir: path.join(root, 'review', 'state'), dataRoot: path.join(root, 'review', 'data'), deferOptionalStart: true });
  const reviewUi = (method, params = {}) => reviewServices.desktopUiService.execute({ method, params });
  const reviewFailures = [];
  async function reviewRegression(id, action) {
    try { await action(); console.log(`PASS review regression ${id}`); }
    catch (error) { reviewFailures.push(id); console.log(`FAIL review regression ${id}: ${error.code || error.name || 'Error'} ${error.stack?.split('\n').find(line => line.includes('test-model-configuration-core.mjs'))?.trim() ?? ''}`); }
  }
  const candidate = { apiKey: 'SYNTHETIC_REVIEW_MODEL_KEY', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  await reviewRegression('R11-M1-local-catalog-evidence', async () => {
    reviewServices.providerSecrets.set({ provider: 'openai', ...candidate });
    await reviewUi('ui.models.configuration.edit', { expectedRevision: (await reviewUi('ui.models.configuration.get')).revision, connectionId: 'openai', patch: { label: 'Untested saved connection' } });
    const beforeRequests = calls.length, catalog = await reviewUi('ui.chat.catalog', { refresh: true });
    const connection = catalog.modelProviders.find(row => row.id === 'openai');
    assert.equal(connection.configured, true);
    assert.equal(connection.authenticated, null, 'a local Settings catalog is not authentication evidence');
    assert.equal(connection.reachable, null);
    assert.equal(calls.length, beforeRequests, 'managed catalog projection makes no network request');
    const listing = await reviewServices.modelRuntime.listModels('openai');
    assert.equal(listing.source, 'configuration');
    assert.deepEqual(listing.observation, { authenticated: null, reachable: null });
  });
  const exactModels = [120, 130, 201, 256].map(length => 'namespace/' + 'm'.repeat(length - 10));
  const committedExact = await reviewUi('ui.models.configuration.commit', { expectedRevision: (await reviewUi('ui.models.configuration.get')).revision,
    connection: { id: 'review-exact', label: 'Exact IDs', protocolProfile: 'openai-chat-v1', enabled: true, models: exactModels.map(id => ({ id, enabled: true })) }, candidate });
  await reviewUi('ui.models.configuration.update', { expectedRevision: committedExact.revision, defaults: { provider: 'review-exact', model: exactModels[0] } });
  await reviewRegression('R11-M1-onboarding-exact-ID', async () => {
    for (const model of exactModels) {
      // A completed step is deliberately idempotent. Exercise each ID as the
      // first selection in a fresh owned onboarding progress document.
      reviewServices.onboardingService.reset(); await reviewUi('ui.onboarding.start');
      for (const stepId of ['welcome', 'provider', 'connection']) await reviewUi('ui.onboarding.completeStep', { stepId });
      const current = await reviewUi('ui.models.configuration.get');
      const selected = await reviewUi('ui.onboarding.setModel', { provider: 'review-exact', model, expectedRevision: current.revision });
      assert.equal(selected.model, model); assert.equal(selected.persisted, true);
      assert.equal(reviewServices.settingsService.store.get().settings.models.defaultModel, model);
      assert.equal(reviewServices.onboardingService.store.read().stepData.model.model, model, 'progress retains the same exact identifier');
    }
    const beforeInvalid = await reviewUi('ui.models.configuration.get');
    for (const model of ['x'.repeat(257), 'invalid model']) {
      await assert.rejects(reviewUi('ui.onboarding.setModel', { provider: 'review-exact', model, expectedRevision: beforeInvalid.revision }), error => /INVALID_PARAMS$/.test(error.code));
      await assert.rejects(reviewServices.onboardingService.setModel({ provider: 'review-exact', model, expectedRevision: beforeInvalid.revision }), { code: 'ONBOARDING_INVALID_PARAMS' });
      assert.equal((await reviewUi('ui.models.configuration.get')).revision, beforeInvalid.revision);
    }
  });
  await reviewRegression('R11-M1-mixed-catalog-isolation', async () => {
    const pending = await reviewUi('ui.models.configuration.commit', { expectedRevision: (await reviewUi('ui.models.configuration.get')).revision,
      connection: { id: 'review-pending', label: 'Pending model review', protocolProfile: 'openai-chat-v1', enabled: true }, candidate });
    assert.ok(pending.connections.find(row => row.id === 'review-pending').models.every(row => !row.enabled));
    const catalog = await reviewUi('ui.chat.catalog', { refresh: true });
    assert.ok(catalog.modelProviders.find(row => row.id === 'review-exact').models.some(row => row.id === exactModels[0]));
    assert.equal(catalog.defaultModelProvider, 'review-exact');
    assert.equal(catalog.modelProviders.find(row => row.id === 'review-pending').catalogState, 'needs-review');
    assert.deepEqual((await reviewServices.modelRuntime.listModels('review-pending')).models, []);
    const requestCount = calls.length;
    await assert.rejects(reviewServices.modelRuntime.chat({ providerId: 'review-pending', model: 'fixture-a', messages: [{ role: 'user', content: 'not reviewed' }] }), { code: 'MODEL_NO_ENABLED_MODELS' });
    assert.equal(calls.length, requestCount, 'catalog reads never grant dispatch eligibility');
    await reviewUi('ui.models.configuration.edit', { expectedRevision: pending.revision, connectionId: 'review-pending', patch: { modelChanges: [{ id: 'fixture-a', enabled: true }] } });
    assert.ok((await reviewUi('ui.chat.catalog', { refresh: true })).modelProviders.find(row => row.id === 'review-pending').models.some(row => row.id === 'fixture-a'));
    await reviewUi('ui.models.configuration.edit', { expectedRevision: (await reviewUi('ui.models.configuration.get')).revision, connectionId: 'review-pending', patch: { modelChanges: [{ id: 'fixture-a', enabled: false }] } });
    assert.equal((await reviewUi('ui.chat.catalog', { refresh: true })).modelProviders.find(row => row.id === 'review-pending').catalogState, 'needs-review', 'disabling the last row leaves other catalogs intact');
  });
  await reviewRegression('R11-M1-compatible-reasoning-opt-in', async () => {
    const compatible = await reviewUi('ui.models.configuration.commit', { expectedRevision: (await reviewUi('ui.models.configuration.get')).revision,
      connection: { id: 'review-compatible', label: 'Compatible opt-in', protocolProfile: 'openai-compatible-v1', enabled: true, models: [{ id: 'fixture-a', enabled: true }] }, candidate });
    assert.equal(reviewServices.settingsService.store.get().settings.models.openaiCompatibleReasoningEffort, false);
    await assert.rejects(reviewUi('ui.models.configuration.edit', { expectedRevision: compatible.revision, connectionId: 'review-compatible', patch: { preferences: [{ modelId: 'fixture-a', reasoningEffort: 'high' }] } }), { code: 'SETTINGS_INVALID' });
    assert.equal((await reviewUi('ui.models.configuration.get')).revision, compatible.revision);
    const blocked = compatible.connections.find(row => row.id === 'review-compatible').models.find(row => row.id === 'fixture-a');
    assert.equal(blocked.capabilities.reasoning.value, true, 'protocol declaration remains honest and independent of the effective parameter gate');
    assert.deepEqual(blocked.reasoning.levels, []);
    const optedIn = await reviewUi('ui.models.configuration.edit', { expectedRevision: compatible.revision, connectionId: 'review-compatible', patch: {
      modelChanges: [{ id: 'fixture-a', manualCapabilities: { reasoning: true } }], preferences: [{ modelId: 'fixture-a', reasoningEffort: 'high' }]
    } });
    const effective = optedIn.connections.find(row => row.id === 'review-compatible').models.find(row => row.id === 'fixture-a').reasoning;
    assert.deepEqual(effective, reviewServices.modelRuntime.modelCapabilities('review-compatible', 'fixture-a').reasoning, 'configuration and dispatch expose the same adapter metadata');
    assert.ok(effective.levels.includes('high'));
    await reviewServices.modelRuntime.chat({ providerId: 'review-compatible', model: 'fixture-a', messages: [{ role: 'user', content: 'explicit model opt-in' }] });
    assert.equal(calls.at(-1).body.reasoning_effort, 'high', 'accepted per-model preference reaches the actual wire');
    assert.equal(reviewServices.settingsService.store.get().settings.models.openaiCompatibleReasoningEffort, false, 'a single-model declaration does not turn on a global capability');
  });
  assert.deepEqual(reviewFailures, [], 'independent M1 integration findings remain');
  console.log('PASS actual composed Core Owner model configuration, discovery, request selection and all-disabled recovery');
} finally {
  if (reviewServices) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await reviewServices[name].close();
  if (services) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[name].close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
