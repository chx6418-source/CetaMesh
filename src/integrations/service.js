// Plugins / Tools / MCP 统一服务面（IPC 只经这里，不进 UI 逻辑）。
//
// 安全约束（任务 B 第十节）：
//   - 所有工具调用与所有管理动作都经 **Capability Broker**；不绕过、不短路。
//   - 未知工具、未恢复工具、被关闭的工具、来源不可用的工具一律拒绝（fail-closed）。
//   - 需要进程/高风险动作的能力（integration.mcp.manage = high）必须 Owner 显式确认。
//
// 本会话不设计最终 UI，只提供稳定的 IPC/service 契约。

import {
  PLUGIN_CATEGORIES, TOOL_CAPABILITIES, TOOL_CAPABILITY_PERMISSION, TOOL_CAPABILITY_RISK,
  integrationError
} from './types.js';
import { createIntegrationStore } from './store.js';
import { createIntegrationRegistry } from './registry.js';
import { createMcpRuntime } from './mcp-runtime.js';
import { createCapabilityBroker } from '../capability/broker.js';
import { OWNER_ACTOR } from '../capability/types.js';

export function createIntegrationService({
  stateDir = null,
  capabilityBroker = null,
  store = null,
  registry = null,
  mcpRuntime = null,
  transportFactory = undefined,
  localServices = null,
  providerSnapshot = null,
  agentHealth = null,
  dshDesktop = null,
  settingsSnapshot = null,
  now = () => Date.now(),
  agentToolExecutor = null,
  toolExecutor = null,
  log = () => {}
} = {}) {
  if (!store && !registry && !stateDir) throw new Error('createIntegrationService 需要 stateDir / store / registry 之一');

  const broker = capabilityBroker ?? createCapabilityBroker({ audit: event => log('Integration capability ' + event.capability + ' ' + event.status) });
  const resolvedStore = store ?? createIntegrationStore({ stateDir });
  const runtime = mcpRuntime ?? createMcpRuntime({ transportFactory: transportFactory ?? undefined, log });
  let dshHealthCache = null;
  let dshHealthCheckedAt = 0;
  let dshHealthInFlight = null;

  async function currentDshHealth({ refresh = false } = {}) {
    if (typeof agentHealth !== 'function') return null;
    if (!refresh && dshHealthCache && now() - dshHealthCheckedAt < 30_000) return structuredClone(dshHealthCache);
    if (dshHealthInFlight) return dshHealthInFlight;
    dshHealthInFlight = Promise.resolve().then(() => agentHealth()).then(value => {
      dshHealthCache = value && typeof value === 'object' ? value : { available: false, reason: 'health_invalid' };
      dshHealthCheckedAt = now();
      return structuredClone(dshHealthCache);
    }).catch(error => {
      // Integration status remains readable when the optional DSH Agent transport is offline.
      dshHealthCache = { available: false, reason: error?.code ?? 'health_failed' };
      dshHealthCheckedAt = now();
      return structuredClone(dshHealthCache);
    }).finally(() => { dshHealthInFlight = null; });
    return dshHealthInFlight;
  }

  async function currentDshDesktop({ refresh = false } = {}) {
    const fallback = {
      id: 'dsh-desktop', displayName: 'DeepSeek Harness', status: 'unavailable',
      installed: false, available: false, version: null, running: false,
      lastCheckedAt: null, lastError: null,
      diagnostics: { reason: 'integration_unavailable', executablePath: null },
      cli: { available: false, executablePath: null, version: null }
    };
    if (!dshDesktop) return fallback;
    try {
      const read = refresh ? dshDesktop.refresh : dshDesktop.status;
      if (typeof read !== 'function') return fallback;
      return { ...fallback, ...(await read.call(dshDesktop, refresh ? undefined : { refresh: false })) };
    } catch (error) {
      // A desktop detection failure must not break Plugin Center or the Agent Provider.
      return { ...fallback, diagnostics: { ...fallback.diagnostics, lastError: String(error?.message ?? error) } };
    }
  }

  function providerStatus(provider) {
    if (!provider) return { available: false, lastError: '未声明底层 Provider' };
    let snapshot = {};
    try { snapshot = providerSnapshot?.() ?? {}; } catch (error) {
      return { available: false, lastError: String(error?.message ?? error) };
    }
    const ids = provider.kind === 'channel' ? snapshot.channel : provider.kind === 'agent' ? snapshot.agent : null;
    const available = Array.isArray(ids) && ids.map(String).includes(String(provider.id));
    return {
      kind: provider.kind, id: provider.id, available,
      lastError: available ? null : provider.kind + ' provider ' + provider.id + ' 未接入'
    };
  }

  const resolvedRegistry = registry ?? createIntegrationRegistry({
    store: resolvedStore,
    mcpStatus: id => runtime.status(id),
    integrationStatus: id => integrationStatus(id)
  });

  function integrationStatus(id) {
    const plugin = resolvedRegistry.pluginById.get(id);
    if (!plugin) return { enabled: false, available: false, status: 'unknown', lastError: '未知集成：' + id };
    if (plugin.kind === 'tool-pack') {
      const view = resolvedRegistry.pluginView(plugin);
      return { id, enabled: view.enabled, available: true, status: view.enabled ? 'enabled' : 'disabled', toolCount: view.toolCount, lastError: null, provider: null };
    }
    const enabled = resolvedRegistry.pluginEnabled(id);
    const local = (localServices?.() ?? {})[plugin.localService] ?? null;
    const provider = providerStatus(plugin.provider ?? null);
    const status = !enabled ? 'disabled' : (local?.status ?? (provider.available ? 'ready' : 'unavailable'));
    const available = enabled && (local ? (local.running === true || local.status === 'ready') : provider.available);
    return { id, enabled, available, status, lastError: local?.lastError ?? provider.lastError ?? null, provider };
  }

  // ── 工具执行适配（真正"恢复"的落点） ────────────────────────────────────────
  async function runTool(toolId, input) {
    // 在能力执行点**重新**校验一次：审批期间开关可能已变化（TOCTOU）。
    const { tool } = resolvedRegistry.invokeGuard(toolId);
    if (tool.source === 'mcp') return runtime.call(tool.serverId, tool.name, input ?? {});
    if (tool.source === 'agent') {
      if (!agentToolExecutor) throw integrationError('PROVIDER_UNAVAILABLE', 'Agent Provider 工具执行器未绑定：' + tool.id);
      return agentToolExecutor({ tool: tool.id, input: input ?? {} });
    }
    if (!toolExecutor) throw integrationError('PROVIDER_UNAVAILABLE', '工具执行器未绑定：' + tool.id);
    return toolExecutor({ tool: tool.id, input: input ?? {} });
  }

  async function applyManagement(command) {
    switch (command.action) {
      case 'plugin.enable': return resolvedRegistry.setPluginEnabled(command.pluginId, true);
      case 'plugin.disable': return resolvedRegistry.setPluginEnabled(command.pluginId, false);
      case 'tool.toggle': return resolvedRegistry.setToolEnabled(command.pluginId, command.toolId, command.enabled === true);
      case 'tool.toggleAll': {
        const plugin = resolvedRegistry.requirePlugin(command.pluginId);
        for (const toolId of plugin.toolIds ?? []) {
          const tool = resolvedRegistry.toolById.get(toolId);
          if (!tool) continue;
          // 一键全开 = 恢复"安全默认"：partial（默认关闭，需 Owner 评估）不参与批量开启，
          // 必须逐项显式打开；一键全关则覆盖全部可切换工具。
          if (command.enabled === true && tool.restore !== 'restored') continue;
          try {
            resolvedRegistry.setToolEnabled(command.pluginId, toolId, command.enabled === true);
          } catch (error) {
            // legacy-unsupported 工具保持 Disabled：整批开关不因它失败。
            if (error?.code !== 'LEGACY_UNSUPPORTED') throw error;
          }
        }
        return resolvedRegistry.pluginView(plugin);
      }
      case 'mcp.enable': return resolvedRegistry.setMcpEnabled(command.serverId, true);
      case 'mcp.disable': {
        const current = resolvedRegistry.serverState(command.serverId);
        if (current.status === 'running' || current.status === 'starting') await runtime.stop(command.serverId);
        return resolvedRegistry.setMcpEnabled(command.serverId, false);
      }
      case 'mcp.start': {
        if (!resolvedRegistry.serverEnabled(command.serverId)) {
          throw integrationError('MCP_DISABLED', 'MCP Server ' + command.serverId + ' 已被禁用，先启用再启动');
        }
        return runtime.start(command.serverId, resolvedRegistry.mcpRuntimeConfig?.(command.serverId) ?? {});
      }
      case 'mcp.stop': return runtime.stop(command.serverId);
      case 'mcp.restart': {
        if (!resolvedRegistry.serverEnabled(command.serverId)) {
          throw integrationError('MCP_DISABLED', 'MCP Server ' + command.serverId + ' 已被禁用，先启用再重启');
        }
        return runtime.restart(command.serverId, resolvedRegistry.mcpRuntimeConfig?.(command.serverId) ?? {});
      }
      case 'mcp.config.update': return resolvedRegistry.updateMcpConfig(command.serverId, command.config ?? {});
      case 'integration.action': {
        const binding = localServices?.()?.actions?.[command.localService]?.[command.integrationAction];
        if (typeof binding !== 'function') {
          throw integrationError('UNSUPPORTED_ACTION',
            '本机未绑定 ' + command.localService + '.' + command.integrationAction + '（需控制台本地服务入口）');
        }
        return binding(command.params ?? {});
      }
      case 'dshDesktop.open': {
        if (typeof dshDesktop?.open !== 'function') {
          return { opened: false, action: 'unavailable', status: 'unavailable', message: '无法启动 DeepSeek Harness，请确认应用安装完整。' };
        }
        return dshDesktop.open();
      }
      default:
        throw integrationError('UNSUPPORTED_ACTION', '未知管理动作：' + command.action);
    }
  }

  function registerCapabilities() {
    for (const [id, permission] of Object.entries(TOOL_CAPABILITY_PERMISSION)) {
      if (broker.registry.has(id)) continue; // 幂等：容器共享同一 broker 时不重复注册
      broker.register({
        id,
        permission,
        provider: 'integration',
        risk: TOOL_CAPABILITY_RISK[id],
        validate(request) {
          const action = request.input?.action;
          if (id === TOOL_CAPABILITIES.mcpManage && action === undefined) {
            throw integrationError('INVALID_PARAMS', 'MCP 管理需要 action');
          }
          if (action === undefined && !String(request.input?.toolId ?? '').trim()) {
            throw integrationError('INVALID_PARAMS', '工具调用需要 toolId');
          }
        },
        execute: request => {
          const input = request.input ?? {};
          if (input.action !== undefined) return applyManagement(input);
          return runTool(input.toolId, input.input);
        }
      });
    }
  }
  registerCapabilities();

  async function manage(command, capability) {
    const result = await broker.execute({
      capability,
      actor: OWNER_ACTOR,
      input: command,
      approved: command.approved === true,
      reason: command.reason ?? 'Desktop Plugins 管理动作'
    });
    return result.status === 'completed' ? result.result : result;
  }

  const managePlugin = command => manage(command, TOOL_CAPABILITIES.pluginManage);
  const manageMcp = command => manage(command, TOOL_CAPABILITIES.mcpManage);

  async function invokeTool(params) {
    const tool = resolvedRegistry.resolveTool(params.id);
    const result = await broker.execute({
      capability: tool.capability,
      actor: OWNER_ACTOR,
      input: { toolId: tool.id, input: params.input ?? {} },
      approved: params.approved === true,
      ...(params.approvalId ? { approvalId: params.approvalId } : {}),
      reason: params.reason ?? 'Desktop Plugins 工具调用'
    });
    return result.status === 'completed' ? { toolId: tool.id, status: 'completed', result: result.result } : result;
  }

  function settingsPage(id) {
    const plugin = resolvedRegistry.requirePlugin(id);
    const view = resolvedRegistry.pluginView(plugin);
    return {
      ...view,
      // 普通用户只看：总开关 + 每个工具（名称/用途/权限/状态/单独开关）；
      // 其余（transport/entry/覆盖项/失败细节）折叠在 Advanced。
      settings: {
        ...view.settings,
        advanced: { ...view.settings.advanced, collapsed: true }
      }
    };
  }

  async function dshIntegrationData(plugin, { refresh = false } = {}) {
    const status = integrationStatus(plugin.id);
    const desktopApp = await currentDshDesktop({ refresh });
    const health = await currentDshHealth({ refresh });
    let providerMetadata = null;
    try {
      providerMetadata = (providerSnapshot?.()?.agentProviders ?? []).find(provider => provider.id === 'dsh') ?? null;
    } catch (error) {
      // Optional provider metadata cannot make the built-in integration unavailable.
      log('DSH Agent metadata unavailable: ' + String(error?.message ?? error));
    }
    const providerAvailable = typeof health?.available === 'boolean'
      ? health.available
      : (providerMetadata?.available === true || status.provider?.available === true);
    const rawHealthReason = String(health?.reason ?? status.provider?.lastError ?? '').toLowerCase();
    const healthReason = providerAvailable ? null : (/(?:needs[_ -]?auth|api[_ -]?key|credential)/.test(rawHealthReason) ? 'needs_setup' : 'unavailable');
    const workspaceBoundary = health?.capabilities?.workspaceBoundary
      ?? health?.workspaceBoundary
      ?? providerMetadata?.workspaceBoundary
      ?? 'unverified';
    const agentIntegration = {
      id: 'dsh',
      displayName: 'DSH Agent Provider',
      enabled: status.enabled,
      available: providerAvailable,
      status: providerAvailable ? 'ready' : (healthReason === 'needs_auth' || healthReason === 'needs_setup' ? 'needs_setup' : 'unavailable'),
      reason: healthReason,
      version: health?.version ?? providerMetadata?.version ?? status.provider?.version ?? null,
      workspaceBoundary,
      supportsFreshSession: health?.supportsFreshSession ?? providerMetadata?.supportsFreshSession ?? true,
      supportsResume: health?.supportsResume ?? providerMetadata?.supportsResume ?? true,
      continuity: { enabled: true, runtime: 'CetaMesh Continuity Runtime' }
    };
    const integrationDescriptor = {
      id: 'dsh',
      name: 'DeepSeek Harness',
      category: 'agent',
      icon: 'deepseek-harness',
      description: plugin.summary,
      installed: desktopApp.installed === true,
      version: desktopApp.version ?? null,
      desktopAvailable: desktopApp.available === true,
      agentAvailable: providerAvailable,
      status: agentIntegration.status,
      settingsRoute: 'agents.dsh',
      actions: ['open', 'refresh', 'settings']
    };
    return { desktopApp, agentIntegration, integrationDescriptor };
  }

  async function integrationView(id, { refresh = false } = {}) {
    const plugin = resolvedRegistry.requirePlugin(id);
    const view = resolvedRegistry.pluginView(plugin);
    const status = integrationStatus(id);
    const local = (localServices?.() ?? {})[plugin.localService] ?? null;
    const dshData = plugin.id === 'cetamesh-dsh' ? await dshIntegrationData(plugin, { refresh }) : {};
    return {
      ...view,
      bottomLayer: plugin.kind === 'channel-integration' ? 'channel-provider' : plugin.kind === 'agent-integration' ? 'agent-provider' : 'capability-tool-pack',
      integrationStatus: status,
      localService: local,
      provider: status.provider ?? null,
      actions: plugin.localService ? ['detect', 'start', 'stop', 'install', 'connect'] : [],
      ...dshData,
      ...(plugin.id === 'cetamesh-dsh' ? { settingsRoute: 'agents.dsh' } : {})
    };
  }

  async function pluginViewWithDsh(plugin) {
    const view = resolvedRegistry.pluginView(plugin);
    if (plugin.id !== 'cetamesh-dsh') return view;
    const dshData = await dshIntegrationData(plugin);
    return { ...view, ...dshData, settingsRoute: 'agents.dsh' };
  }

  async function dshSettings() {
    const plugin = resolvedRegistry.requirePlugin('cetamesh-dsh');
    const data = await dshIntegrationData(plugin);
    const providerSettings = settingsSnapshot?.()?.agents ?? {};
    const health = await currentDshHealth();
    const capabilities = health?.capabilities ?? {};
    const workspaceBoundary = capabilities.workspaceBoundary ?? health?.workspaceBoundary ?? 'unverified';
    const settings = typeof dshDesktop?.settings === 'function'
      ? await dshDesktop.settings({
          agentEnabled: resolvedRegistry.pluginEnabled(plugin.id),
          agentHealth: health ? { ...health, reason: data.agentIntegration.reason } : null,
          workspaceBoundary,
          defaultAgentProvider: providerSettings.defaultAgentProvider ?? 'auto'
        })
      : null;
    return {
      ...data,
      settingsRoute: 'agents.dsh',
      settings: settings ?? {
        id: 'dsh', displayName: 'DeepSeek Harness',
        desktop: { installed: data.desktopApp.installed, running: data.desktopApp.running, version: data.desktopApp.version },
        agent: data.agentIntegration,
        workspaceMode: workspaceBoundary,
        continuity: data.agentIntegration.continuity,
        defaultAgentProvider: providerSettings.defaultAgentProvider ?? 'auto',
        advanced: { diagnostics: data.desktopApp.diagnostics, cli: data.desktopApp.cli }
      }
    };
  }

  const handlers = {
    'plugins.overview': () => ({
      categories: [...PLUGIN_CATEGORIES],
      plugins: resolvedRegistry.listPlugins(),
      tools: { total: resolvedRegistry.tools.length, enabled: resolvedRegistry.listTools({ enabled: true }).length },
      mcp: { total: resolvedRegistry.servers.length, running: resolvedRegistry.listMcpServers().filter(server => server.status === 'running').length },
      integrations: resolvedRegistry.plugins.filter(plugin => ['channel-integration', 'agent-integration', 'tool-pack'].includes(plugin.kind)).map(plugin => integrationStatus(plugin.id))
    }),
    'plugins.list': async params => ({
      plugins: await Promise.all(resolvedRegistry.listPlugins({
        category: params.category ?? null,
        enabled: typeof params.enabled === 'boolean' ? params.enabled : null
      }).map(plugin => pluginViewWithDsh(resolvedRegistry.requirePlugin(plugin.id))))
    }),
    'plugins.get': params => pluginViewWithDsh(resolvedRegistry.requirePlugin(params.id ?? params.pluginId)),
    'plugins.settings': async params => {
      const id = params.id ?? params.pluginId;
      if (id === 'cetamesh-dsh') return dshSettings();
      return settingsPage(id);
    },
    'plugins.enable': params => managePlugin({ action: 'plugin.enable', pluginId: params.id ?? params.pluginId, approved: params.approved === true }),
    'plugins.disable': params => managePlugin({ action: 'plugin.disable', pluginId: params.id ?? params.pluginId, approved: params.approved === true }),
    'plugins.tool.toggle': params => managePlugin({
      action: 'tool.toggle', pluginId: params.pluginId, toolId: params.toolId,
      enabled: params.enabled === true, approved: params.approved === true
    }),
    'plugins.tool.toggleAll': params => managePlugin({
      action: 'tool.toggleAll', pluginId: params.pluginId,
      enabled: params.enabled === true, approved: params.approved === true
    }),
    'plugins.allowlist': () => resolvedRegistry.agentAllowlist(),
    'tools.list': params => ({
      tools: resolvedRegistry.listTools({
        source: params.source ?? null,
        pluginId: params.pluginId ?? null,
        serverId: params.serverId ?? null,
        enabled: typeof params.enabled === 'boolean' ? params.enabled : null,
        available: typeof params.available === 'boolean' ? params.available : null
      })
    }),
    'tools.get': params => resolvedRegistry.toolView(resolvedRegistry.resolveTool(params.id), { pluginId: params.pluginId ?? null }),
    'tools.invoke': params => invokeTool(params),
    'mcp.list': () => ({ servers: resolvedRegistry.listMcpServers() }),
    'mcp.get': params => resolvedRegistry.getMcpServer(params.id ?? params.serverId),
    'mcp.tools': params => {
      const id = params.id ?? params.serverId;
      resolvedRegistry.requireServer(id);
      return { serverId: id, tools: runtime.discover(id) };
    },
    'mcp.enable': params => manageMcp({ action: 'mcp.enable', serverId: params.id ?? params.serverId, approved: params.approved === true }),
    'mcp.disable': params => manageMcp({ action: 'mcp.disable', serverId: params.id ?? params.serverId, approved: params.approved === true }),
    'mcp.start': params => manageMcp({ action: 'mcp.start', serverId: params.id ?? params.serverId, approved: params.approved === true }),
    'mcp.stop': params => manageMcp({ action: 'mcp.stop', serverId: params.id ?? params.serverId, approved: params.approved === true }),
    'mcp.restart': params => manageMcp({ action: 'mcp.restart', serverId: params.id ?? params.serverId, approved: params.approved === true }),
    'mcp.config.get': params => resolvedRegistry.mcpConfig(params.id ?? params.serverId),
    'mcp.config.update': params => manageMcp({
      action: 'mcp.config.update', serverId: params.id ?? params.serverId,
      config: params.config ?? {}, approved: params.approved === true
    }),
    'mcp.invoke': async params => {
      const serverId = params.serverId ?? params.id;
      const server = resolvedRegistry.requireServer(serverId);
      const toolName = String(params.tool ?? '');
      const toolId = server.namespace + toolName;
      if (!resolvedRegistry.toolById.has(toolId)) {
        // 未知 MCP 工具：不猜测、不转发，直接拒绝。
        throw integrationError('UNKNOWN_MCP_TOOL', '未知 MCP 工具：' + toolId);
      }
      return invokeTool({ id: toolId, input: params.input, approved: params.approved, approvalId: params.approvalId, reason: params.reason });
    },
    'integrations.list': async () => ({
      integrations: await Promise.all(resolvedRegistry.plugins
        .filter(plugin => ['channel-integration', 'agent-integration', 'tool-pack'].includes(plugin.kind))
        .map(async plugin => plugin.kind === 'tool-pack'
          ? { id: plugin.id, displayName: plugin.name, ...integrationStatus(plugin.id) }
          : integrationView(plugin.id)))
    }),
    'integrations.get': params => integrationView(params.id ?? params.pluginId),
    'integrations.dshDesktop.status': () => currentDshDesktop(),
    'integrations.dshDesktop.refresh': () => currentDshDesktop({ refresh: true }),
    'integrations.dshDesktop.open': params => manageMcp({ action: 'dshDesktop.open', approved: params.approved === true }),
    'integrations.dshDesktop.settings': () => dshSettings(),
    'integrations.action': params => manageMcp({
      action: 'integration.action',
      localService: String(params.localService ?? ''),
      integrationAction: String(params.action ?? ''),
      params: params.params ?? {},
      approved: params.approved === true
    })
  };

  async function execute({ method, params = {} } = {}) {
    const handler = handlers[method];
    if (!handler) throw integrationError('METHOD_NOT_FOUND', '未知 Plugins/Tools/MCP 方法：' + String(method));
    return handler(params ?? {});
  }

  return {
    execute,
    store: resolvedStore,
    registry: resolvedRegistry,
    runtime,
    broker,
    integrationStatus,
    close: () => runtime.closeAll()
  };
}
