import assert from 'node:assert/strict';
import { createDesktopIpcRuntime } from '../src/app/ipc-runtime.js';

const calls = [];
const makeService = name => new Proxy({}, {
  get(_target, method) {
    return command => {
      calls.push({ service: name, method, command });
      return { service: name, method, command };
    };
  }
});
const services = {
  capabilityService: makeService('capability'),
  workshopService: makeService('workshop'),
  chatService: makeService('chat'),
  taskService: makeService('task'),
  continuityService: makeService('continuity'),
  providerSecrets: makeService('providers'),
  modelRuntime: makeService('modelrt'),
  routerService: makeService('router'),
  extensionService: makeService('ext'),
  pluginCenterService: makeService('plugin-center'),
  meshService: makeService('mesh'),
  channelService: makeService('channel'),
  agentService: makeService('agent'),
  controlService: makeService('control')
};
const system = {
  settings: makeService('settings'),
  about: makeService('about'),
  update: makeService('update')
};
const runtime = createDesktopIpcRuntime({ services, system, log: () => {}, pipeName: '' });
const params = { requestId: 'ipc-test' };
const routeCases = [
  ['chat.send', 'chat', 'execute'],
  ['task.list', 'task', 'execute'],
  ['memory.search', 'capability', 'executeMemory'],
  ['continuity.status', 'continuity', 'execute'],
  ['capability.list', 'capability', 'execute'],
  ['workshop.list', 'workshop', 'executeOwner'],
  ['modelrt.catalog', 'modelrt', 'execute'],
  ['router.classify', 'router', 'execute'],
  ['ext.list', 'ext', 'execute'],
  ['plugin-center.catalog.list', 'plugin-center', 'execute'],
  ['mesh.status', 'mesh', 'execute'],
  ['channel.list', 'channel', 'execute'],
  ['agent.list', 'agent', 'execute'],
  ['workspace.list', 'capability', 'executeWorkspace'],
  ['providers.list', 'providers', 'execute'],
  ['settings.get', 'settings', 'execute'],
  ['about.info', 'about', 'execute'],
  ['update.check', 'update', 'execute']
];

for (const [method, service, dispatchMethod] of routeCases) {
  const result = await runtime.dispatch({ method, params });
  assert.equal(result.service, service, method);
  assert.equal(result.method, dispatchMethod, method);
  assert.equal(result.command.method, method, method);
  assert.equal(result.command.params, params, method);
}
const contextService = { marker: 'preserved-this', execute() { return this.marker; } };
services.chatService = contextService;
assert.equal(await runtime.dispatch({ method: 'chat.context', params }), 'preserved-this', 'dispatch preserves service receiver');
const fallback = await runtime.dispatch({ method: 'legacy.unknown', params });
assert.equal(fallback.service, 'control');
assert.equal(calls.at(-1).command.actor.privilege, 'console');
assert.equal(calls.length, routeCases.length + 1);

console.log('PASS desktop IPC dispatch preserves all method families and fallback');
