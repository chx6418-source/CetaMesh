import net from 'node:net';
import { startIpcProtocol } from '../control/ipc-protocol.js';
import { PRIVILEGE_CONSOLE } from '../bridge-privilege.js';

const ROUTES = [
  ['capability.', (services, system) => [services.capabilityService, 'execute']],
  ['workshop.', (services, system) => [services.workshopService, 'executeOwner']],
  ['chat.', (services, system) => [services.chatService, 'execute']],
  ['memory.', (services, system) => [services.capabilityService, 'executeMemory']],
  ['task.', (services, system) => [services.taskService, 'execute']],
  ['continuity.', (services, system) => [services.continuityService, 'execute']],
  ['providers.', (services, system) => [services.providerSecrets, 'execute']],
  ['modelrt.', (services, system) => [services.modelRuntime, 'execute']],
  ['router.', (services, system) => [services.routerService, 'execute']],
  ['ext.', (services, system) => [services.extensionService, 'execute']],
  ['mesh.', (services, system) => [services.meshService, 'execute']],
  ['channel.', (services, system) => [services.channelService, 'execute']],
  ['agent.', (services, system) => [services.agentService, 'execute']],
  ['workspace.', (services, system) => [services.capabilityService, 'executeWorkspace']],
  ['settings.', (services, system) => [system.settings, 'execute']],
  ['about.', (services, system) => [system.about, 'execute']],
  ['update.', (services, system) => [system.update, 'execute']]
];

export function createDesktopIpcRuntime({
  services = {},
  system = services.systemServices ?? services.system ?? {},
  log = () => {},
  pipeName,
  processRef = process,
  netModule = net
} = {}) {
  let server = null;
  let exitBound = false;

  function dispatch({ method, params } = {}) {
    const name = String(method ?? '');
    const route = ROUTES.find(([prefix]) => name.startsWith(prefix));
    if (route) {
      const [owner, methodName] = route[1](services, system);
      // Every prefixed desktop route is served on the native Owner UI pipe. Bind
      // identity here; never accept an actor claim from IPC parameters.
      const trustedActor = name.startsWith('continuity.') ? { kind: 'owner', id: 'desktop' } : undefined;
      return owner[methodName]({ method: name, params, ...(trustedActor ? { actor: trustedActor } : {}) });
    }
    return services.controlService.execute({
      method: name,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    });
  }

  function stop() {
    if (!server) return false;
    const current = server;
    server = null;
    try { current.close(); } catch (error) { log('Native UI IPC close failed: ' + (error?.message ?? error)); }
    return true;
  }

  function start() {
    if (server) return server;
    const resolvedPipeName = String(pipeName ?? processRef.env?.WHALEBRIDGE_UI_PIPE ?? '').trim();
    if (!resolvedPipeName) return null;

    const nextServer = netModule.createServer(socket => {
      socket.setNoDelay(true);
      const connection = startIpcProtocol({ input: socket, output: socket, dispatch });
      connection.done.catch(error => {
        if (!socket.destroyed) log('Native UI IPC connection failed: ' + (error?.message ?? error));
      });
    });
    nextServer.maxConnections = 16;
    nextServer.on('error', error => {
      log('Native UI IPC server failed: ' + (error?.message ?? error));
      processRef.exit(error?.code === 'EADDRINUSE' ? 2 : 1);
    });
    nextServer.listen(resolvedPipeName, () => log('Native UI IPC server is ready.'));
    server = nextServer;
    if (!exitBound) {
      processRef.once('exit', stop);
      exitBound = true;
    }
    return server;
  }

  return { dispatch, start, stop };
}
