import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-service-container-'));
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
  await fallbackServices.chatService.execute({ method: 'chat.send', params: { id: fallbackSession.id, text: 'use the configured DSH route' } });
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
  const originalCreateAgentSession = fallbackServices.agentBroker.createSession;
  const originalSendAgent = fallbackServices.agentBroker.send;
  let providerSessionIndex = 0;
  fallbackServices.agentBroker.createSession = async (provider) => ({ sessionId: `${provider}-fixture-${++providerSessionIndex}` });
  fallbackServices.agentBroker.send = async () => ({ accepted: true });
  try {
    for (const provider of ['dsh', 'codex']) {
      assert.ok(['capability-broker', 'staged-capability-broker'].includes(
        fallbackServices.agentBroker.capabilities(provider).workspaceBoundary), `${provider} is Task/Workspace-bound`);
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
  } finally {
    fallbackServices.agentBroker.createSession = originalCreateAgentSession;
    fallbackServices.agentBroker.send = originalSendAgent;
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
  assert.ok(workspaceEvents.events.some(event => event.event === 'workspace.updated' && event.data.workspaceId === uiWorkspace.id));
  const uiTask = await ui('ui.task.create', { goal: 'Harbor task DTO', requirements: [], workspaceId: uiWorkspace.id });
  assert.equal((await ui('ui.task.get', { id: uiTask.task.id })).task.id, uiTask.task.id);
  const taskEvents = await ui('ui.events.next', { after: workspaceEvents.cursor, waitMs: 0 });
  assert.ok(taskEvents.events.some(event => event.event === 'task.updated' && event.data.taskId === uiTask.task.id));
  const uiMemory = await ui('ui.memory.create', { type: 'knowledge', scope: 'global', content: 'Harbor memory DTO' });
  const updatedUiMemory = await ui('ui.memory.update', { id: uiMemory.id, expectedRev: uiMemory.rev, content: 'Updated Harbor memory DTO', tags: [], pinned: false });
  assert.equal(updatedUiMemory.content, 'Updated Harbor memory DTO');
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
  assert.equal(linkedContext.memoryReferences.length, 1, 'unresolvable cross-scope Memory references are omitted');
  assert.match(linkedContext.memoryReferences[0].excerpt, /Authorized task memory reference/);
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
  assert.equal(disabledExtensionDescriptor.availability, 'disabled');
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
  assert.equal(removedExtensionDescriptor.availability, 'unavailable');
  assert.equal(removedExtensionContext.capabilities.requestable.includes(extensionCapabilityId), false,
    'removed Extension capability is not advertised as requestable');
  const cetameshProvider = agentContext.agentProviders.find((provider) => provider.id === 'cetamesh');
  assert.equal(cetameshProvider.availability, 'registered');
  assert.equal(cetameshProvider.health, 'unknown', 'context construction does not probe provider health');

  const { createApplicationLifecycle } = await import('../src/app/lifecycle.js');
  const lifecycle = createApplicationLifecycle({
    processRef: {
      once(event, handler) {
        assert.equal(event, 'exit');
        onExit = handler;
      }
    },
    log: () => {}
  });
  const closed = [];
  lifecycle.register(() => closed.push('first'));
  lifecycle.register(() => closed.push('second'));
  lifecycle.bind();
  onExit();
  assert.deepEqual(closed, ['second', 'first'], 'application services close in reverse registration order');
  onExit();
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
