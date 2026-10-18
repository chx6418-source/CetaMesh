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
    log: options.log ?? (() => {})
  });
  lifecycle.register(() => owner.release());

  // Shutdown runs in reverse registration order: stop Chat consumers before their
  // Agent provider, then release the Agent Broker after provider cleanup.
  lifecycle.register(() => services.agentService.close());
  lifecycle.register(() => services.capabilityService.close());
  lifecycle.register(() => services.pluginCenterService.close());
  lifecycle.register(() => services.extensionService.close());
  lifecycle.register(() => services.managedAgent.close());
  lifecycle.register(() => services.chatService.close());
  lifecycle.register(() => services.integrationService.close());
  lifecycle.register(() => services.channelService.close());
  lifecycle.register(() => services.bionicService.close());

  return { services, lifecycle };
}
