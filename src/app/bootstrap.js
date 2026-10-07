import { createCetaMeshServices } from './service-container.js';
import { createApplicationLifecycle } from './lifecycle.js';

export function bootstrapCetaMesh(options = {}) {
  const services = createCetaMeshServices(options);
  const lifecycle = createApplicationLifecycle({
    processRef: options.processRef ?? process,
    log: options.log ?? (() => {})
  });

  lifecycle.register(() => services.chatService.close());
  lifecycle.register(() => services.managedAgent.close());
  lifecycle.register(() => services.agentService.close());

  return { services, lifecycle };
}
