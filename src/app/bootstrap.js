import { createCetaMeshServices } from './service-container.js';
import { createApplicationLifecycle } from './lifecycle.js';
import { APP_PATHS } from '../app-paths.js';
import { acquireStateOwner } from './state-owner.js';

export function bootstrapCetaMesh(options = {}) {
  const owner = options.owner ?? acquireStateOwner(options.stateDir ?? APP_PATHS.stateDir);
  let services;
  try { services = createCetaMeshServices(options); }
  catch (error) { owner.release(); throw error; }
  const lifecycle = createApplicationLifecycle({
    processRef: options.processRef ?? process,
    log: options.log ?? (() => {}),
    handlerTimeoutMs: options.handlerTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs
  });
  lifecycle.register(() => owner.release(), { name: 'StateDir owner', requireCleanShutdown: true });

  // Shutdown runs in reverse registration order: stop Chat consumers before their
  // Agent provider, then release the Agent Broker after provider cleanup.
  lifecycle.register(() => services.agentService.close(), { name: 'Agent provider' });
  lifecycle.register(() => services.capabilityService.close(), { name: 'Capability consumers' });
  lifecycle.register(() => services.pluginCenterService.close(), { name: 'Plugin Center' });
  lifecycle.register(() => services.extensionService.close(), { name: 'Extensions' });
  lifecycle.register(() => services.managedAgent.close(), { name: 'Managed Agent' });
  lifecycle.register(() => services.chatService.close(), { name: 'Chat' });
  lifecycle.register(() => services.integrationService.close(), { name: 'Integrations' });
  lifecycle.register(() => services.meshService.close(), { name: 'Mesh' });
  lifecycle.register(() => services.channelService.close(), { name: 'Channels' });
  lifecycle.register(() => services.bionicService.close(), { name: 'Bionic child' });

  return { services, lifecycle };
}
