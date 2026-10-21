import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopUiEventBus } from '../src/desktop/ui-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-service-container-'));
async function waitFor(predicate, label, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const originalDataDir = process.env.WHALEBRIDGE_DATA_DIR;
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
let onExit = null;
let services = null;
let fallbackServices = null;

try {
  process.env.WHALEBRIDGE_DATA_DIR = root;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error('service construction must not fetch');
  };

  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const config = { allow: { private: [], groups: ['7'] } };
  let snowLumaActionCalled = false;
  const desktopLocalServices = () => ({ snowluma: {
    status: 'stopped', installed: true, running: false, ready: false, configured: true,
    version: '1.2.3', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001',
    accessTokenConfigured: true, accessToken: 'never-project-this-value', lastError: ''
  } });
  desktopLocalServices.actions = { snowluma: { detect: async () => {
    snowLumaActionCalled = true;
    return { status: 'stopped', installed: true, running: false, ready: false, configured: true };
  } } };
  services = createCetaMeshServices({ config, localServices: desktopLocalServices });
  assert.equal(services.settingsService.store.file.startsWith(root), true,
    'Desktop DTO imports must not capture runtime paths before isolated environment is set');

  const validateChannelSend = id => services.capabilityService.broker.registry.require('channel.send').validate({
    input: { kind: 'group', id: String(id), text: 'message' }
  });
  assert.doesNotThrow(() => validateChannelSend('7'), 'initial allowlist entry is accepted');
  assert.throws(() => validateChannelSend('8'), { code: 'TARGET_NOT_ALLOWED' });
  config.allow = { private: [], groups: ['8'] };
  assert.throws(() => validateChannelSend('7'), { code: 'TARGET_NOT_ALLOWED' }, 'replaced allowlist removes the old entry');
  assert.doesNotThrow(() => validateChannelSend('8'), 'replaced allowlist adds the new entry');

  for (const name of [
    'modelRuntime',
    'chatService',
    'productContextService',
    'routerService',
    'taskService',
    'memoryService',
    'agentService',
    'workspaceService',
    'capabilityService',
    'continuityService',
    'extensionService',
    'pluginCenterService',
    'workshopService',
    'meshService',
    'channelService',
    'settingsService'
  ]) {
    assert.ok(services[name], name + ' should be constructed');
  }
  const providers = services.agentService.listProviders().map((provider) => provider.id);
  assert.ok(providers.includes('cetamesh'), 'local CetaMesh Agent Provider remains available');
  assert.ok(providers.includes('dsh'), 'DSH provider remains registered without a transport');
  assert.ok(providers.includes('codex'), 'Codex provider remains registered when unavailable');
  assert.ok(providers.includes('zcode'), 'ZCode provider remains registered when unavailable');
  assert.equal(services.modelRegistry.require('deepseek-official').defaultModel, 'deepseek-flash',
    'DeepSeek Runtime default uses the currently supported model id');
  const genericModelProvider = services.modelRegistry.require('openai-compatible');
  assert.equal(genericModelProvider.supportsTools, false, 'generic compatibility does not claim tool support before opt-in');
  assert.equal(services.modelRuntime.listProviders().find(provider => provider.id === 'openai-compatible').toolCalling, false);
  services.settingsService.store.update('models', { openaiCompatibleToolCalling: true, openaiCompatibleReasoningEffort: true });
  assert.equal(genericModelProvider.supportsTools, true, 'the live provider capability follows the explicit user setting');
  assert.equal(services.modelRuntime.listProviders().find(provider => provider.id === 'openai-compatible').toolCalling, true);
  assert.equal(genericModelProvider.supportsReasoning('o3'), true);
  assert.equal(genericModelProvider.supportsReasoning('gpt-4o-mini'), false);
  const dshHealth = await services.agentService.execute({ method: 'agent.health', params: { provider: 'dsh' } });
  assert.equal(dshHealth.available, false);
  assert.equal(dshHealth.reason, 'not_connected');
  assert.equal(networkAttempts, 0, 'constructing Core services does not make network requests');

  const dshCalls = [];
  const fallbackApi = {
    calls: dshCalls,
    async callEndpoint(endpoint, args = {}) {
      dshCalls.push({ endpoint, args });
      if (endpoint === 'session/create') return { sessionId: 'dsh-fallback-fixture' };
      if (endpoint === 'session/selectModel') return {};
      if (endpoint === 'session/prompt') return { accepted: true };
      throw new Error(`unexpected DSH endpoint ${endpoint}`);
    },
    async *openRemoteStream(_endpoint, _args, { signal } = {}) {
      await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
    }
  };
  fallbackServices = createCetaMeshServices({ config, api: fallbackApi,
    stateDir: path.join(root, 'fallback-state'), dataRoot: path.join(root, 'fallback-data'),
    localServices: desktopLocalServices });
  assert.equal(fallbackServices.modelRuntime.defaultProviderId(), null, 'no configured Model key is represented as unavailable');
  const fallbackSession = await fallbackServices.chatService.execute({ method: 'chat.sessions.create', params: {} });
  await fallbackServices.chatService.execute({ method: 'chat.config.set', params: { id: fallbackSession.id, config: { modelProvider: null } } });
  const dshAck = await fallbackServices.chatService.execute({ method: 'chat.send', params: { id: fallbackSession.id, text: 'use the configured DSH route' } });
  assert.match(dshAck.requestId, /^cetamesh-chat-/,
    'production Chat assembly acknowledges the DSH operation with a requestId');
  await waitFor(() => dshCalls.some(call => call.endpoint === 'session/prompt'), 'production Chat DSH prompt');
  assert.ok(dshCalls.some(call => call.endpoint === 'session/prompt'),
    'the production Chat assembly reaches DSH when automatic Model Runtime has no configured key');
  assert.equal(fallbackServices.modelRuntime.listProviders().some(provider => provider.hasKey), false,
    'fallback does not invent or leak a Model Provider credential');
  const fallbackWorkspaceRoot = path.join(root, 'provider-binding-workspace');
  fs.mkdirSync(fallbackWorkspaceRoot);
  const { workspace: fallbackWorkspace } = await fallbackServices.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Provider binding fixture', root: fallbackWorkspaceRoot }
  });
  const brokerSessionTask = fallbackServices.taskService.runtime.create({
    goal: 'Provider-bound session fixture', workspaceId: fallbackWorkspace.id
  });
  const originalExecutionConsent = fallbackServices.agentBroker.assertExecutionConsent;
  const originalCreateAgentSession = fallbackServices.agentBroker.createSession;
  const originalSendAgent = fallbackServices.agentBroker.send;
  const originalAgentStatus = fallbackServices.agentBroker.status;
  const originalCancelAgent = fallbackServices.agentBroker.cancel;
  const originalCloseAgent = fallbackServices.agentBroker.closeSession;
  let providerSessionIndex = 0;
  const sentAgentInstructions = [];
  fallbackServices.agentBroker.createSession = async (provider) => ({ sessionId: `${provider}-fixture-${++providerSessionIndex}` });
  fallbackServices.agentBroker.send = async request => { sentAgentInstructions.push(request); return { accepted: true }; };
  fallbackServices.agentBroker.status = async request => ({ sessionId: request.sessionId, running: false });
  try {
    for (const provider of ['dsh', 'codex']) {
      const boundary = fallbackServices.agentBroker.capabilities(provider).workspaceBoundary;
      if (provider === 'codex') {
        assert.equal(boundary, 'native-staged', 'Codex declares the honest Native Staging boundary');
        const security = fallbackServices.agentBroker.describeExecutionSecurity(provider, fallbackWorkspace.id);
        const expectedRefusal = security.security.nativeSandboxSupported === true
          ? 'AGENT_SECURITY_CONFIRMATION_REQUIRED' : 'AGENT_NATIVE_SANDBOX_UNSUPPORTED';
        const sessionsBeforeRefusal = providerSessionIndex;
        await assert.rejects(() => fallbackServices.capabilityService.broker.execute({
          actor: { kind: 'owner', id: 'desktop' }, taskId: brokerSessionTask.id, workspaceId: fallbackWorkspace.id,
          capability: 'agent.run', input: { agentProvider: provider, content: 'unconfirmed dispatch' }, reason: 'unconfirmed fixture'
        }), error => error.code === expectedRefusal);
        assert.equal(providerSessionIndex, sessionsBeforeRefusal, 'unavailable or unconfirmed native execution must not create a session');
        // This dispatch-only fixture already stubs createSession/send; simulate the approved scope
        // without depending on an installed CLI. Real approval/dispatch is covered by Native suites.
        fallbackServices.agentBroker.assertExecutionConsent = (id, scope) => {
          if (id !== 'codex') return originalExecutionConsent(id, scope);
          assert.equal(scope.workspaceId, fallbackWorkspace.id);
        };
      } else assert.ok(['capability-broker', 'staged-capability-broker'].includes(boundary), provider + ' is Task/Workspace-bound');
      const result = await fallbackServices.capabilityService.broker.execute({
        actor: { kind: 'owner', id: 'desktop' }, taskId: brokerSessionTask.id, workspaceId: fallbackWorkspace.id,
        capability: 'agent.run', input: { agentProvider: provider, content: `run with ${provider}` }, reason: 'session isolation fixture'
      });
      assert.equal(result.status, 'completed', `${provider} session should not be passed to the Managed Agent binder`);
      assert.equal(result.result.provider, provider);
      fallbackServices.taskService.runtime.detachAgent({ id: brokerSessionTask.id,
        expectedRev: fallbackServices.taskService.runtime.get({ id: brokerSessionTask.id }).task.rev,
        note: `Reset fixture after ${provider}` });
    }
    fallbackServices.taskService.runtime.attachAgent({ id: brokerSessionTask.id,
      expectedRev: fallbackServices.taskService.runtime.get({ id: brokerSessionTask.id }).task.rev,
      provider: 'dsh', sessionId: 'existing-dsh-session' });
    const previousSendCount = sentAgentInstructions.length;
    const reused = await fallbackServices.capabilityService.broker.execute({
      actor: { kind: 'owner', id: 'desktop' }, taskId: brokerSessionTask.id, workspaceId: fallbackWorkspace.id,
      capability: 'agent.run', input: { agentProvider: 'dsh', content: 'continue this existing session' }, reason: 'reuse send fixture'
    });
    assert.equal(reused.result.reused, true);
    assert.equal(sentAgentInstructions.length, previousSendCount + 1, 'agent.run sends the new instructions even when Session is reused');
    assert.equal(sentAgentInstructions.at(-1).content, 'continue this existing session');
    fallbackServices.taskService.runtime.detachAgent({ id: brokerSessionTask.id,
      expectedRev: fallbackServices.taskService.runtime.get({ id: brokerSessionTask.id }).task.rev, note: 'reset reuse fixture' });

    fallbackServices.taskService.runtime.attachAgent({ id: brokerSessionTask.id,
      expectedRev: fallbackServices.taskService.runtime.get({ id: brokerSessionTask.id }).task.rev,
      provider: 'dsh', sessionId: 'cancel-failure-session' });
    const cancelSignal = { aborted: false };
    fallbackServices.agentBroker.send = async () => {
      cancelSignal.aborted = true;
      return { accepted: true };
    };
    fallbackServices.agentBroker.cancel = async () => {
      throw Object.assign(new Error('Agent cancellation failed'), { code: 'AGENT_CANCEL_FAILED' });
    };
    const agentRunCapability = fallbackServices.capabilityService.broker.registry.require('agent.run');
    await assert.rejects(() => agentRunCapability.execute({
      requestId: 'cancel-failure-fixture', actor: { kind: 'owner', id: 'desktop' },
      taskId: brokerSessionTask.id, workspaceId: fallbackWorkspace.id,
      input: { agentProvider: 'dsh', content: 'report remote cancellation failure' }, signal: cancelSignal
    }), error => error.code === 'AGENT_CANCEL_FAILED', 'failed cancellation of a reused Agent Session must remain observable');
    fallbackServices.agentBroker.send = originalSendAgent;
    fallbackServices.agentBroker.cancel = originalCancelAgent;
    fallbackServices.taskService.runtime.detachAgent({ id: brokerSessionTask.id,
      expectedRev: fallbackServices.taskService.runtime.get({ id: brokerSessionTask.id }).task.rev,
      note: 'reset cancellation fixture' });

    const rollbackTask = fallbackServices.taskService.runtime.create({ goal: 'rollback on agent failure', workspaceId: fallbackWorkspace.id });
    const originalSend = fallbackServices.agentBroker.send;
    let closedFailedSession = false;
    fallbackServices.agentBroker.send = async () => { throw Object.assign(new Error('send failed'), { code: 'PROVIDER_ERROR' }); };
    fallbackServices.agentBroker.closeSession = async () => { closedFailedSession = true; return { closed: true }; };
    await assert.rejects(() => fallbackServices.capabilityService.broker.execute({
      actor: { kind: 'owner', id: 'desktop' }, taskId: rollbackTask.id, workspaceId: fallbackWorkspace.id,
      capability: 'agent.run', input: { agentProvider: 'dsh', content: 'fail after create' }, reason: 'rollback fixture'
    }), /send failed/);
    const rolledBackTask = fallbackServices.taskService.runtime.get({ id: rollbackTask.id }).task;
    assert.equal(rolledBackTask.currentAgent, null, 'failed Agent initialization detaches its Task assignment');
    assert.equal(rolledBackTask.status, 'failed', 'failed initialization cannot leave a running Task');
    assert.equal(closedFailedSession, true, 'failed Agent initialization closes the new Session/staging');
    fallbackServices.agentBroker.send = originalSend;
  } finally {
    fallbackServices.agentBroker.assertExecutionConsent = originalExecutionConsent;
    fallbackServices.agentBroker.createSession = originalCreateAgentSession;
    fallbackServices.agentBroker.send = originalSendAgent;
    fallbackServices.agentBroker.status = originalAgentStatus;
    fallbackServices.agentBroker.cancel = originalCancelAgent;
    fallbackServices.agentBroker.closeSession = originalCloseAgent;
  }

  const w02TaskRuntime = fallbackServices.taskService.runtime;
  const w02WorkspaceRoot = path.join(root, 'chat-delete-agent-startup-workspace');
  fs.mkdirSync(w02WorkspaceRoot);
  const { workspace: w02Workspace } = await fallbackServices.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Chat delete startup race', root: w02WorkspaceRoot }
  });
  const existingW02Tasks = new Set(w02TaskRuntime.list({ workspaceId: w02Workspace.id }).tasks.map(task => task.id));
  const w02Chat = await fallbackServices.chatService.execute({ method: 'chat.sessions.create', params: {} });
  await fallbackServices.chatService.execute({ method: 'chat.config.set', params: {
    id: w02Chat.id, config: { agentProvider: 'cetamesh', workspaceId: w02Workspace.id }
  } });
  let releaseW02Create;
  let w02CreateStarted = false;
  let w02ClosedSession = null;
  const w02CreateGate = new Promise(resolve => { releaseW02Create = resolve; });
  const originalW02Create = fallbackServices.agentBroker.createSession;
  const originalW02Close = fallbackServices.agentBroker.closeSession;
  fallbackServices.agentBroker.createSession = async () => {
    w02CreateStarted = true;
    await w02CreateGate;
    return { sessionId: 'w02-late-agent-session' };
  };
  fallbackServices.agentBroker.closeSession = async ({ provider, sessionId }) => {
    w02ClosedSession = { provider, sessionId };
    return { closed: true };
  };
  try {
    const ack = await fallbackServices.chatService.execute({ method: 'chat.send', params: {
      id: w02Chat.id, text: 'Create and then cancel a task before its Agent session starts'
    } });
    assert.match(ack.requestId, /^cetamesh-chat-/);
    await waitFor(() => w02CreateStarted, 'W02 delayed Agent session creation');
    assert.equal((await fallbackServices.chatService.execute({ method: 'chat.sessions.delete', params: { id: w02Chat.id } })).deleted, true);
    releaseW02Create();
    await waitFor(() => w02ClosedSession?.sessionId === 'w02-late-agent-session', 'W02 late Agent session cleanup');
    const w02Tasks = w02TaskRuntime.list({ workspaceId: w02Workspace.id }).tasks.filter(task => !existingW02Tasks.has(task.id));
    assert.equal(w02Tasks.length, 1, 'Chat deletion must retain the independently owned Task record');
    assert.equal(w02Tasks[0].status, 'cancelled', 'a Chat-created queued Task is cancelled when Agent startup is aborted');
    assert.equal(w02Tasks[0].currentAgent, null, 'late Agent startup must not leave a Task bound to a dead Session');
    assert.deepEqual(w02ClosedSession, { provider: 'cetamesh', sessionId: 'w02-late-agent-session' });
  } finally {
    releaseW02Create();
    fallbackServices.agentBroker.createSession = originalW02Create;
    fallbackServices.agentBroker.closeSession = originalW02Close;
  }

  const taskRuntimeForLookup = fallbackServices.taskService.runtime;
  const originalTaskGet = taskRuntimeForLookup.get;
  taskRuntimeForLookup.get = () => { throw Object.assign(new Error('Task store read failed'), { code: 'TASK_STORE_IO' }); };
  try {
    await assert.rejects(() => fallbackServices.capabilityService.broker.execute({
      actor: { kind: 'owner', id: 'desktop' }, taskId: brokerSessionTask.id, workspaceId: fallbackWorkspace.id,
      capability: 'agent.run', input: { agentProvider: 'dsh', content: 'surface Task store failure' },
      reason: 'Task resolver error propagation fixture'
    }), error => error.code === 'TASK_STORE_IO', 'Capability policy must preserve Task storage failures');
  } finally {
    taskRuntimeForLookup.get = originalTaskGet;
  }
  const pluginCatalog = await services.pluginCenterService.execute({ method: 'plugin-center.catalog.list', params: {} });
  assert.equal(pluginCatalog.available, false);
  assert.equal(pluginCatalog.reason, 'service_not_configured', 'missing Plugin Service configuration is graceful');

  const ui = (method, params = {}) => services.desktopUiService.execute({ method, params });
  const uiIntegrations = await ui('ui.plugins.integration.list');
  const bionicIntegration = uiIntegrations.integrations.find(item => item.id === 'cetamesh-bionic-chat');
  assert.ok(bionicIntegration, 'Harbor Plugin Center lists the Bionic tool pack as an Integration');
  assert.equal(bionicIntegration.available, true, 'Bionic management remains available even when some backing tools are offline');
  const productPluginCenter = await ui('ui.plugins.status');
  assert.ok(productPluginCenter.integrations.some(item => item.id === 'cetamesh-snowluma'), 'the unified Plugin Center DTO includes built-in integrations');
  assert.ok(productPluginCenter.mcp.some(item => item.id === 'snowluma' && item.source === 'builtin'), 'the unified Plugin Center DTO identifies built-in MCP descriptors');
  // Exercise a real built-in child through the production service composition, UI
  // projection, actual tools/list schema and Brokered call. The invalid scheme is
  // rejected locally, so this fixture cannot contact an external endpoint.
  await services.integrationService.execute({ method: 'mcp.start', params: { id: 'web-search-safe', approved: true } });
  try {
    const runningServer = (await ui('ui.mcp.list')).servers.find(server => server.id === 'web-search-safe');
    assert.equal(runningServer.running, true);
    assert.equal(runningServer.toolCallable, true, 'real discovery makes the running server callable');
    assert.ok(runningServer.discoveredToolCount > 0);
    const discovered = (await ui('ui.mcp.tools', { id: 'web-search-safe' })).tools.find(tool => tool.name === 'web_fetch');
    assert.equal(discovered.discovered, true);
    assert.equal(discovered.callable, true, JSON.stringify({ runningServer, discovered }));
    const deniedScheme = await services.integrationService.execute({ method: 'tools.invoke', params: {
      id: 'mcp__web-search-safe__web_fetch', input: { url: 'file:///phase5-denied' }, approved: true
    } });
    assert.equal(deniedScheme.status, 'completed');
    assert.equal(deniedScheme.result.isError, true, 'the real child must reject non-HTTP requests');
  } finally {
    await services.integrationService.execute({ method: 'mcp.stop', params: { id: 'web-search-safe', approved: true } });
  }
  // UI-02: a running process with no discovered callable tools cannot be shown as Ready.
  const originalIntegrationExecute = services.integrationService.execute;
  services.integrationService.execute = async request => request.method === 'mcp.list'
    ? { servers: [{ id: 'empty-runtime', name: 'Empty Runtime', enabled: true, status: 'running',
      available: false, toolCount: 0, lastError: 'tools/list returned no callable tools' }] }
    : originalIntegrationExecute(request);
  try {
    const emptyRuntime = (await ui('ui.mcp.list')).servers[0];
    assert.equal(emptyRuntime.available, false, 'running alone does not make MCP tools available');
    assert.equal(emptyRuntime.eligible, false, 'running alone does not make MCP tools callable');
    assert.equal(emptyRuntime.reason, 'tools/list returned no callable tools');
  } finally {
    services.integrationService.execute = originalIntegrationExecute;
  }
  const originalAgentExecute = services.agentService.execute;
  services.agentService.execute = async request => request.method === 'agent.list'
    ? { providers: [{ id: 'auth-needed', available: true, health: { installed: true, authenticated: false,
      available: true, reason: 'authentication_required' } }] }
    : originalAgentExecute(request);
  try {
    const authNeeded = (await ui('ui.agent.list')).agents[0];
    assert.equal(authNeeded.available, false, 'an unauthenticated Agent is not available for execution');
    assert.equal(authNeeded.eligible, false);
    assert.equal(authNeeded.taskEligible, false);
    assert.equal(authNeeded.installed, true, 'missing authentication does not mean missing installation');
    assert.equal(authNeeded.status, 'needs-setup');
  } finally {
    services.agentService.execute = originalAgentExecute;
  }
  services.agentService.execute = async request => request.method === 'agent.list'
    ? { providers: [{ id: 'codex', available: true, workspaceBoundary: 'staged-capability-broker',
      health: { installed: true, compatible: true, authenticated: true, available: true,
        sessionCapable: true, sandboxCapable: null } }] }
    : originalAgentExecute(request);
  try {
    const codexPendingFirstRun = (await ui('ui.agent.list')).agents[0];
    assert.equal(codexPendingFirstRun.taskEligible, true,
      'unknown sandbox health permits a first sandboxed run; a confirmed sandbox refusal blocks later runs');
  } finally {
    services.agentService.execute = originalAgentExecute;
  }
  services.agentService.execute = async request => request.method === 'agent.list'
    ? { providers: [{ id: 'incompatible-cli', available: false,
      health: { installed: true, compatible: false, authenticated: true, reason: 'unsupported_cli' } }] }
    : originalAgentExecute(request);
  try {
    const incompatible = (await ui('ui.agent.list')).agents[0];
    assert.equal(incompatible.installed, true);
    assert.equal(incompatible.available, false);
    assert.equal(incompatible.status, 'not-supported', 'version incompatibility must not read as not installed');
  } finally {
    services.agentService.execute = originalAgentExecute;
  }
  const snowLumaSettings = await ui('ui.plugins.integration.settings', { id: 'cetamesh-snowluma' });
  assert.equal(snowLumaSettings.localService.status, 'stopped');
  assert.equal(snowLumaSettings.localService.accessTokenConfigured, true);
  assert.equal(Object.hasOwn(snowLumaSettings.localService, 'accessToken'), false, 'local Integration settings never project the token');
  const bionicSettings = await ui('ui.plugins.integration.settings', { id: 'cetamesh-bionic-chat' });
  assert.ok(bionicSettings.tools.length >= 50, 'Bionic settings project its real individual tool controls');
  assert.ok(bionicSettings.tools.some(tool => tool.id === 'mcp__snowluma__qq_status'));
  const snowLumaAction = await services.integrationService.execute({
    method: 'integrations.action', params: { localService: 'snowluma', action: 'detect', approved: true }
  });
  assert.equal(snowLumaAction.status, 'stopped');
  assert.equal(snowLumaActionCalled, true, 'Desktop routes SnowLuma controls through the existing local service manager');
  const uiSession = await ui('ui.chat.sessions.create', { title: 'Harbor Core contract' });
  const uiHistory = await ui('ui.chat.history', { id: uiSession.id, limit: 100 });
  assert.equal(uiHistory.id, uiSession.id);
  assert.equal(uiHistory.total, 0, 'Harbor Chat history projects the actual local Chat service');
  const uiWorkspaceRoot = path.join(root, 'harbor-ui-workspace');
  fs.mkdirSync(uiWorkspaceRoot);
  const uiWorkspace = await ui('ui.workspace.create', { name: 'Harbor Workspace', root: uiWorkspaceRoot });
  const openedWorkspace = await ui('ui.workspace.open', { id: uiWorkspace.id });
  const activeWorkspace = await ui('ui.workspace.list');
  assert.equal(openedWorkspace.activeId, uiWorkspace.id);
  assert.equal(activeWorkspace.activeId, uiWorkspace.id, 'active Workspace is projected from the Core registry');
  const workspaceEvents = await ui('ui.events.next', { after: 0, waitMs: 0 });
  assert.equal(workspaceEvents.instanceId, services.uiEventBus.instanceId, 'event cursor is scoped to a Core instance');
  assert.ok(workspaceEvents.events.some(event => event.event === 'workspace.updated' && event.data.workspaceId === uiWorkspace.id));
  const restartedBus = createDesktopUiEventBus();
  restartedBus.publish('chat.updated', { sessionId: uiSession.id });
  const firstAfterRestart = await restartedBus.next({ after: 0, waitMs: 0 });
  assert.notEqual(firstAfterRestart.instanceId, workspaceEvents.instanceId);
  assert.equal(firstAfterRestart.events[0].cursor, 1, 'new Core starts a fresh event cursor generation');
  const uiTask = await ui('ui.task.create', { goal: 'Harbor task DTO', requirements: [],
    workspaceId: uiWorkspace.id, agentProvider: 'cetamesh' });
  assert.equal((await ui('ui.task.get', { id: uiTask.task.id })).task.id, uiTask.task.id);
  const taskEvents = await ui('ui.events.next', { after: workspaceEvents.cursor, waitMs: 0 });
  assert.ok(taskEvents.events.some(event => event.event === 'task.updated' && event.data.taskId === uiTask.task.id));
  const uiMemory = await ui('ui.memory.create', { type: 'knowledge', scope: 'global', content: 'Harbor memory DTO' });
  const updatedUiMemory = await ui('ui.memory.update', { id: uiMemory.id, expectedRev: uiMemory.rev, content: 'Updated Harbor memory DTO', tags: [], pinned: false });
  assert.equal(updatedUiMemory.content, 'Updated Harbor memory DTO');
  const settingsSnapshot = await ui('ui.settings.get');
  assert.equal(settingsSnapshot.revision, services.settingsService.store.get().revision);
  const changedSettings = await ui('ui.settings.update', {
    section: 'general', values: { theme: 'dark' }, expectedRevision: settingsSnapshot.revision
  });
  assert.equal(changedSettings.revision, settingsSnapshot.revision + 1);
  await assert.rejects(() => ui('ui.settings.update', {
    section: 'general', values: { theme: 'light' }, expectedRevision: settingsSnapshot.revision
  }), error => error.code === 'SETTINGS_CONFLICT', 'stale revision is rejected through the formal UI route');
  assert.deepEqual((await ui('ui.approvals.list')).approvals, [], 'the live Core approval list has a real empty state');

  const simpleContext = JSON.parse(await services.productContextService.buildForChat({
    record: { id: 'simple-chat', taskId: null, config: { mode: 'chat', workspaceId: null } },
    routing: { class: 'simple', resolvedRoute: 'model' },
    modelProvider: 'openai'
  }));
  assert.equal(simpleContext.task, null);
  assert.equal(simpleContext.workspace, null, 'simple Chat does not attach the active Workspace');
  assert.deepEqual(simpleContext.capabilities.requestable, [], 'Chat has no arbitrary model-callable capability ids');

  const workspaceRoot = path.join(root, 'linked-workspace');
  fs.mkdirSync(workspaceRoot);
  const { workspace } = await services.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Linked Project', root: workspaceRoot }
  });
  const noLinks = JSON.parse(await services.productContextService.buildForChat({
    record: { id: 'unlinked-chat', taskId: null, config: { mode: 'chat', workspaceId: null } },
    routing: null,
    modelProvider: 'openai'
  }));
  assert.equal(noLinks.workspace, null, 'an active Workspace is not substituted for an absent explicit link');

  const task = services.taskService.runtime.create({ goal: 'Use only linked project context', workspaceId: workspace.id, currentPhase: 'inspect' });
  const userPrincipal = { kind: 'user', id: 'desktop' };
  const linkedMemory = services.memoryService.runtime.create({
    principal: userPrincipal, type: 'working', scope: `task:${task.id}`, content: 'Authorized task memory reference'
  });
  const foreignMemory = services.memoryService.runtime.create({
    principal: userPrincipal, type: 'working', scope: 'task:unrelated', content: 'Unrelated task memory must stay hidden'
  });
  let currentTask = services.taskService.runtime.get({ id: task.id }).task;
  currentTask = services.taskService.runtime.linkMemory({ id: task.id, expectedRev: currentTask.rev, memoryId: linkedMemory.id });
  currentTask = services.taskService.runtime.linkMemory({ id: task.id, expectedRev: currentTask.rev, memoryId: foreignMemory.id });

  const linkedContext = JSON.parse(await services.productContextService.buildForChat({
    record: { id: 'linked-chat', taskId: task.id, config: { mode: 'chat', workspaceId: workspace.id } },
    routing: { class: 'project', resolvedRoute: 'model' },
    modelProvider: 'openai'
  }));
  assert.equal(linkedContext.task.id, task.id);
  assert.equal(linkedContext.workspace.name, 'Linked Project');
  assert.equal(linkedContext.workspace.root, undefined);
  assert.equal(linkedContext.memoryReferences.length, 2,
    'authorized linked Task and global Knowledge are present while unresolvable cross-scope links are omitted');
  assert.ok(linkedContext.memoryReferences.some(item => /Authorized task memory reference/.test(item.excerpt)));
  assert.ok(linkedContext.memoryReferences.some(item => /Updated Harbor memory DTO/.test(item.excerpt)));
  assert.equal(JSON.stringify(linkedContext).includes(foreignMemory.id), false);

  const taskOnly = JSON.parse(await services.productContextService.buildForChat({
    record: { id: 'task-only-chat', taskId: task.id, config: { mode: 'chat', workspaceId: null } },
    routing: null,
    modelProvider: 'openai'
  }));
  assert.equal(taskOnly.task.id, task.id);
  assert.equal(taskOnly.workspace, null, 'Task workspace is not substituted for the Chat’s missing explicit Workspace link');

  const staleLinks = JSON.parse(await services.productContextService.buildForChat({
    record: { id: 'stale-chat', taskId: 'missing-task', config: { mode: 'chat', workspaceId: 'missing-workspace' } },
    routing: null,
    modelProvider: 'openai'
  }));
  assert.equal(staleLinks.task, null);
  assert.equal(staleLinks.workspace, null);

  const extensionId = 'cetamesh.hello-tool';
  const extensionCapabilityId = `extension.${extensionId}.hello.greet`;
  const extensionSource = path.resolve(import.meta.dirname, '..', 'extensions', 'cetamesh-hello-tool');
  const extensionReview = await services.extensionService.execute({
    method: 'ext.review', params: { sourceDir: extensionSource }
  });
  await services.extensionService.execute({
    method: 'ext.install',
    params: { sourceDir: extensionSource, approval: { approved: true, token: extensionReview.review.token } }
  });
  await services.extensionService.execute({ method: 'ext.enable', params: { id: extensionId } });
  const extensionCapability = services.capabilityService.broker.list()
    .find(capability => capability.id === extensionCapabilityId);
  assert.ok(extensionCapability, 'enabling an Extension registers its capability in the real Broker');
  assert.equal(extensionCapability.availability, 'available', 'the real registry reports current lifecycle availability');

  const agentPrincipal = services.capabilityService.grantTask(task.id, {
    capabilities: ['filesystem.read', 'web.search', extensionCapabilityId]
  });
  const agentSessionId = `context-agent-${task.id}`;
  services.taskService.runtime.attachAgent({ id: task.id, expectedRev: currentTask.rev, provider: 'cetamesh', sessionId: agentSessionId });
  const agentContext = JSON.parse(await services.productContextService.buildForAgent({
    sessionId: agentSessionId,
    provider: 'cetamesh',
    principal: { taskId: task.id, workspaceId: workspace.id, actor: agentPrincipal },
    modelProvider: 'openai',
    model: 'gpt-4o-mini',
    toolCalling: 'supported'
  }));
  assert.deepEqual(agentContext.capabilities.requestable, [extensionCapabilityId, 'filesystem.read', 'web.search']);
  assert.deepEqual(agentContext.capabilities.mcp, ['web.search']);
  const extensionDescriptor = agentContext.capabilities.manifest.find(item => item.id === extensionCapabilityId);
  assert.ok(extensionDescriptor, 'enabled registered Extension capability is in the model manifest when granted');

  await services.extensionService.execute({ method: 'ext.disable', params: { id: extensionId } });
  const disabledExtensionContext = JSON.parse(await services.productContextService.buildForAgent({
    sessionId: agentSessionId,
    provider: 'cetamesh',
    principal: { taskId: task.id, workspaceId: workspace.id, actor: agentPrincipal },
    modelProvider: 'openai',
    toolCalling: 'supported'
  }));
  const disabledExtensionDescriptor = disabledExtensionContext.capabilities.statusSummary
    .find(item => item.id === extensionCapabilityId);
  assert.equal(disabledExtensionDescriptor, undefined, 'disabled Extension is removed from discoverable capability descriptors');
  assert.equal(services.capabilityService.broker.registry.has(extensionCapabilityId), false,
    'disabled Extension leaves no stale executable descriptor in the Broker');
  assert.equal(disabledExtensionContext.capabilities.manifest.some(item => item.id === extensionCapabilityId), false,
    'disabled Extension is removed from the model capability manifest');
  assert.equal(disabledExtensionContext.capabilities.requestable.includes(extensionCapabilityId), false,
    'disabled Extension capability is not advertised as requestable');

  await services.extensionService.execute({ method: 'ext.enable', params: { id: extensionId } });
  const reenabledExtensionContext = JSON.parse(await services.productContextService.buildForAgent({
    sessionId: agentSessionId,
    provider: 'cetamesh',
    principal: { taskId: task.id, workspaceId: workspace.id, actor: agentPrincipal },
    modelProvider: 'openai',
    toolCalling: 'supported'
  }));
  assert.equal(reenabledExtensionContext.capabilities.requestable.includes(extensionCapabilityId), true,
  're-enabling restores requestability without changing the Task grant');

  const uninstall = await services.extensionService.execute({ method: 'ext.uninstall', params: { id: extensionId } });
  assert.equal(uninstall.removedFiles, true, 'uninstall removes the copied Extension package');
  assert.equal(fs.existsSync(path.join(services.extensionService.store.packagesDir, extensionId)), false,
    'uninstall releases the native Extension package directory before fixture cleanup');
  const removedExtensionContext = JSON.parse(await services.productContextService.buildForAgent({
    sessionId: agentSessionId,
    provider: 'cetamesh',
    principal: { taskId: task.id, workspaceId: workspace.id, actor: agentPrincipal },
    modelProvider: 'openai',
    toolCalling: 'supported'
  }));
  const removedExtensionDescriptor = removedExtensionContext.capabilities.statusSummary
    .find(item => item.id === extensionCapabilityId);
  assert.equal(removedExtensionDescriptor, undefined, 'uninstalled Extension has no discoverable capability descriptor');
  assert.equal(services.capabilityService.broker.registry.has(extensionCapabilityId), false,
    'uninstalled Extension leaves no executable Broker binding');
  assert.equal(removedExtensionContext.capabilities.requestable.includes(extensionCapabilityId), false,
    'removed Extension capability is not advertised as requestable');
  const cetameshProvider = agentContext.agentProviders.find((provider) => provider.id === 'cetamesh');
  assert.equal(cetameshProvider.availability, 'registered');
  assert.equal(cetameshProvider.health, 'unknown', 'context construction does not probe provider health');

  // Exercise the production Managed Agent -> Tool Execution -> Capability Broker
  // identity resolver with a task-scoped workspace read.
  const managedWorkspaceRoot = path.join(root, 'managed-agent-tool-workspace');
  fs.mkdirSync(managedWorkspaceRoot);
  fs.writeFileSync(path.join(managedWorkspaceRoot, 'proof.txt'), 'managed task scoped read');
  const { workspace: managedWorkspace } = await services.workspaceService.execute({
    method: 'workspace.create', params: { name: 'Managed Agent tool fixture', root: managedWorkspaceRoot }
  });
  const managedTask = services.taskService.runtime.create({ goal: 'Read the authorized file', workspaceId: managedWorkspace.id });
  const managedPrincipal = services.capabilityService.grantTask(managedTask.id, { capabilities: ['filesystem.read'] });
  const managedProvider = services.managedAgent.provider;
  const managedSession = await managedProvider.createSession({ cwd: managedWorkspace.root, modelProvider: 'deepseek-official' });
  services.providerSecrets.set({ provider: 'deepseek-official', apiKey: 'phase2-fixture-secret' });
  const currentManagedTask = services.taskService.runtime.get({ id: managedTask.id }).task;
  services.taskService.runtime.attachAgent({ id: managedTask.id, expectedRev: currentManagedTask.rev,
    provider: 'cetamesh', sessionId: managedSession.sessionId });
  services.managedAgent.bindSession(managedSession.sessionId, {
    taskId: managedTask.id, workspaceId: managedWorkspace.id, actor: managedPrincipal
  });
  const originalRuntimeStream = services.modelRuntime.stream;
  let managedStreamCount = 0;
  let managedToolResult = null;
  services.modelRuntime.stream = async function* (request) {
    managedStreamCount += 1;
    if (managedStreamCount === 1) {
      yield { type: 'assistant/tool-calls', data: { toolCalls: [{ id: 'managed-read-1', name: 'cap_filesystem_read',
        capabilityId: 'filesystem.read', arguments: JSON.stringify({ path: 'proof.txt' }) }] } };
    } else {
      const toolMessage = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'managed-read-1');
      managedToolResult = toolMessage ? JSON.parse(toolMessage.content) : null;
      yield { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Read complete.' }] } } };
    }
    yield { type: 'turn/end', data: { reason: { kind: 'completed' } } };
  };
  try {
    const managedEvents = [];
    const managedFollow = (async () => {
      for await (const event of services.agentBroker.follow({ provider: 'cetamesh', sessionId: managedSession.sessionId })) {
        managedEvents.push(event);
        if (event.type === 'turn/end') break;
      }
    })();
    await services.agentBroker.send({ provider: 'cetamesh', sessionId: managedSession.sessionId, content: 'Read proof.txt' });
    await waitFor(() => managedEvents.some(event => event.type === 'turn/end'), 'Managed Agent tool turn');
    await managedFollow;
    assert.equal(managedStreamCount, 2, `the tool result must be returned to the model: ${JSON.stringify({ managedEvents, managedToolResult })}`);
    assert.equal(managedToolResult?.status, 'completed', `production actor resolution must authorize the current Task grant: ${JSON.stringify(managedToolResult)}`);
    assert.match(JSON.stringify(managedToolResult), /managed task scoped read/);
  } finally {
    services.modelRuntime.stream = originalRuntimeStream;
    await managedProvider.closeSession({ sessionId: managedSession.sessionId });
  }
  console.log('PASS production Managed Agent Tool Execution resolves the live Task principal');

  const { createApplicationLifecycle } = await import('../src/app/lifecycle.js');
  let onBeforeExit = null;
  const lifecycle = createApplicationLifecycle({
    processRef: {
      once(event, handler) {
        assert.ok(['beforeExit', 'exit'].includes(event));
        if (event === 'beforeExit') onBeforeExit = handler;
        else onExit = handler;
      }
    },
    log: () => {}
  });
  const closed = [];
  let ownerReleased = false;
  let finishChild;
  let childStarted;
  const childReady = new Promise(resolve => { childStarted = resolve; });
  const childGate = new Promise(resolve => { finishChild = resolve; });
  lifecycle.register(() => { ownerReleased = true; }, { name: 'owner', requireCleanShutdown: true });
  lifecycle.register(() => closed.push('first'));
  lifecycle.register(async () => { childStarted(); await childGate; closed.push('second'); });
  lifecycle.bind();
  assert.equal(typeof onBeforeExit, 'function');
  assert.equal(typeof onExit, 'function');
  const stopping = onBeforeExit();
  await childReady;
  assert.deepEqual(closed, [], 'dependent cleanup cannot overtake the asynchronous child');
  assert.equal(ownerReleased, false, 'owner remains held while resource cleanup is pending');
  finishChild();
  const shutdownReport = await stopping;
  assert.equal(shutdownReport.ok, true);
  assert.deepEqual(closed, ['second', 'first'], 'application services close in reverse registration order');
  assert.equal(ownerReleased, true, 'owner is released only after all resource cleanup completes');
  assert.equal(onExit(), stopping, 'exit fallback reuses the same shutdown Promise');
  await onExit();
  assert.deepEqual(closed, ['second', 'first'], 'exit cleanup is idempotent');

  console.log('PASS Core container registers all Agent Providers without DSH or QQ network requests');
} finally {
  if (fallbackServices) {
    await Promise.all([fallbackServices.chatService.close(), fallbackServices.agentService.close(),
      fallbackServices.pluginCenterService.close(), fallbackServices.extensionService.close()]);
  }
  if (services) {
    await Promise.all([
      services.extensionService.close(),
      services.pluginCenterService.close(),
      services.chatService.close(),
      services.agentService.close()
    ]);
  }
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
}
