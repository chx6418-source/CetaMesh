import net from 'node:net';
import { startIpcProtocol } from '../control/ipc-protocol.js';
import { PRIVILEGE_CONSOLE } from '../bridge-privilege.js';

const ROUTES = [
  ['ui.', (services) => [services.desktopUiService, 'execute']],
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
  ['plugin-center.', (services, system) => [services.pluginCenterService, 'execute']],
  ['plugins.', (services, system) => [services.integrationService, 'execute']],
  ['tools.', (services, system) => [services.integrationService, 'execute']],
  ['mcp.', (services, system) => [services.integrationService, 'execute']],
  ['integrations.', (services, system) => [services.integrationService, 'execute']],
  ['mesh.', (services, system) => [services.meshService, 'execute']],
  ['channel.', (services, system) => [services.channelService, 'execute']],
  ['agent.', (services, system) => [services.agentService, 'execute']],
  ['workspace.', (services, system) => [services.capabilityService, 'executeWorkspace']],
  ['settings.', (services, system) => [system.settings, 'execute']],
  ['about.', (services, system) => [system.about, 'execute']],
  ['update.', (services, system) => [system.update, 'execute']],
  // 产品化任务 D：首次运行引导 / 产品文案与反馈入口（同一份 UI 契约，见 src/onboarding、src/product）。
  ['onboarding.', (services, system) => [system.onboarding, 'execute']],
  ['product.', (services, system) => [system.product, 'execute']]
];

export function createDesktopIpcRuntime({
  services = {},
  system = services.systemServices ?? services.system ?? {},
  // 最近错误码环：只记错误码（不记消息），供 About/Feedback 的诊断信息使用。
  errorRegistry = services.errorRegistry ?? null,
  log = () => {},
  pipeName,
  processRef = process,
  netModule = net
} = {}) {
  let server = null;
  let exitBound = false;

  /** 调用 + 记录错误码：失败仍然原样抛给 IPC 协议层（错误语义不变）。 */
  function invoke(invokeFn, method) {
    const source = String(method ?? '').split('.')[0] || null;
    try {
      const result = invokeFn();
      if (!errorRegistry || !result || typeof result.catch !== 'function') return result;
      return result.catch((error) => {
        errorRegistry.recordError(error, { source });
        throw error;
      });
    } catch (error) {
      if (errorRegistry) errorRegistry.recordError(error, { source });
      throw error;
    }
  }

  function dispatch({ method, params } = {}, context = {}) {
    const name = String(method ?? '');
    const route = ROUTES.find(([prefix]) => name.startsWith(prefix));
    if (route) {
      const [owner, methodName] = route[1](services, system);
      // Every prefixed desktop route is served on the native Owner UI pipe. Bind
      // identity here; never accept an actor claim from IPC parameters.
      const trustedActor = name.startsWith('continuity.') ? { kind: 'owner', id: 'desktop' } : undefined;
      return invoke(() => owner[methodName]({ method: name, params, ...(trustedActor ? { actor: trustedActor } : {}), ...(name.startsWith('ui.') ? { signal: context.signal } : {}) }), name);
    }
    return invoke(() => services.controlService.execute({
      method: name,
      params,
      actor: { privilege: PRIVILEGE_CONSOLE }
    }), name);
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
