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

try {
  process.env.WHALEBRIDGE_DATA_DIR = root;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error('service construction must not fetch');
  };

  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const config = { allow: { private: [], groups: ['7'] } };
  services = createCetaMeshServices({ config });

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
    'workshopService',
    'meshService',
    'channelService',
    'settingsService'
  ]) {
    assert.ok(services[name], name + ' should be constructed');
  }
  const providers = services.agentService.listProviders().map((provider) => provider.id);
  assert.ok(providers.includes('cetamesh'), 'local CetaMesh Agent Provider remains available');
  assert.equal(providers.includes('dsh'), false, 'DSH provider is absent when no DSH API is injected');
  assert.equal(networkAttempts, 0, 'constructing Core services does not probe a provider');

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

  console.log('PASS Core service container constructs without DSH, QQ or provider probes');
} finally {
  if (services) {
    await Promise.all([
      services.extensionService.close(),
      services.chatService.close(),
      services.agentService.close()
    ]);
  }
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
}
