import { createCetaMeshServices } from './service-container.js';
import { createApplicationLifecycle } from './lifecycle.js';

export function bootstrapCetaMesh(options = {}) {
  const services = createCetaMeshServices(options);
  const lifecycle = createApplicationLifecycle({
    processRef: options.processRef ?? process,
    log: options.log ?? (() => {})
  });

  // Shutdown runs in reverse registration order: stop Chat consumers before their
  // Agent provider, then release the Agent Broker after provider cleanup.
  lifecycle.register(() => services.agentService.close());
  lifecycle.register(() => services.managedAgent.close());
  lifecycle.register(() => services.chatService.close());

  return { services, lifecycle };
}
