// 统一 Registry：Plugins（产品层）/ Tools / MCP Servers 三张表由同一份目录 + 持久开关推导。
//
// 设计要点：
//   1. 目录（catalog）是静态事实；开关（store）是用户决定；运行态（mcpStatus/integrationStatus）是运行时事实。
//      三者从不互相伪造：Server 没跑就说 available=false + lastError，不假装工具可用。
//   2. 只有 tool-pack 插件持有"逐工具开关"；MCP Server 卡片的工具列表是只读视图。
//   3. legacy-unsupported 工具永远不可启用（setToolEnabled 直接拒绝），UI 只能显示 Disabled。

import { allPluginDescriptors, buildToolCatalog, MCP_SERVER_CATALOG } from './catalog.js';
import { integrationError, isRestorable } from './types.js';

const MCP_CONFIG_KEYS = Object.freeze({
  args: 'string-array',
  env: 'string-map',
  cwd: 'string',
  timeoutMs: 'positive-int',
  note: 'string'
});

function assertMcpConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw integrationError('INVALID_PARAMS', 'MCP 配置必须是对象');
  }
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(MCP_CONFIG_KEYS, key)) {
      throw integrationError('INVALID_PARAMS', '不支持的 MCP 配置项：' + key);
    }
    const kind = MCP_CONFIG_KEYS[key];
    if (kind === 'string-array') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw integrationError('INVALID_PARAMS', key + ' 必须是字符串数组');
      clean[key] = [...value];
    } else if (kind === 'string-map') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw integrationError('INVALID_PARAMS', key + ' 必须是字符串映射');
      clean[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => {
        if (typeof v !== 'string') throw integrationError('INVALID_PARAMS', key + '.' + k + ' 必须是字符串');
        return [k, v];
      }));
    } else if (kind === 'positive-int') {
      if (!Number.isInteger(value) || value <= 0 || value > 600000) throw integrationError('INVALID_PARAMS', key + ' 必须是 1..600000 的整数');
      clean[key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 500) throw integrationError('INVALID_PARAMS', key + ' 必须是不超过 500 字符的字符串');
      clean[key] = value;
    }
  }
  return clean;
}

function projectMcpConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length === 0) return {};
  return {
    hasArgs: Array.isArray(config.args) && config.args.length > 0,
    hasEnvironment: Boolean(config.env && typeof config.env === 'object' && Object.keys(config.env).length > 0),
    timeoutMs: Number.isSafeInteger(config.timeoutMs) ? config.timeoutMs : null,
    note: typeof config.note === 'string' ? config.note : ''
  };
}

export function createIntegrationRegistry({
  store,
  plugins = allPluginDescriptors(),
  tools = buildToolCatalog(),
  servers = MCP_SERVER_CATALOG,
  mcpStatus = () => ({}),
  integrationStatus = () => ({}),
  now = () => Date.now()
} = {}) {
  if (!store) throw new Error('createIntegrationRegistry 需要 store');

  const pluginById = new Map(plugins.map(plugin => [plugin.id, plugin]));
  const toolById = new Map(tools.map(tool => [tool.id, tool]));
  const serverById = new Map(servers.map(server => [server.id, server]));

  const packOwning = toolId => plugins.find(plugin => plugin.kind === 'tool-pack' && (plugin.toolIds ?? []).includes(toolId)) ?? null;
  const serverByIdForTool = tool => serverById.get(tool.serverId) ?? null;
  const integrationIdForTool = tool => (tool.serverId === 'agent' ? 'cetamesh-dsh' : null);

  function requirePlugin(id) {
    const plugin = pluginById.get(String(id));
    if (!plugin) throw integrationError('UNKNOWN_PLUGIN', '未知插件：' + id);
    return plugin;
  }
  function requireServer(id) {
    const server = serverById.get(String(id));
    if (!server) throw integrationError('UNKNOWN_MCP_SERVER', '未知 MCP Server：' + id);
    return server;
  }

  const pluginRecord = id => store.read().plugins[id] ?? {};
  const mcpRecord = id => store.read().mcp[id] ?? {};

  function pluginEnabled(id) {
    const plugin = requirePlugin(id);
    const record = pluginRecord(id);
    if (typeof record.enabled === 'boolean') return record.enabled;
    if (plugin.kind === 'mcp-server') return serverEnabled(plugin.mcpServerId);
    return plugin.defaultEnabled !== false;
  }

  function serverEnabled(id) {
    const server = requireServer(id);
    const record = mcpRecord(id);
    return typeof record.enabled === 'boolean' ? record.enabled : server.defaultEnabled !== false;
  }

  function serverState(id) {
    const server = requireServer(id);
    const enabled = serverEnabled(id);
    const runtime = mcpStatus(id) ?? {};
    const status = enabled ? (runtime.status ?? 'stopped') : 'disabled';
    return {
      id: server.id, name: server.name, enabled,
      transport: server.transport, entry: server.entry, managedBy: server.managedBy,
      namespace: server.namespace, source: server.source, permissions: [...(server.permissions ?? [])],
      description: server.description, status,
      lastError: runtime.lastError ?? null,
      pid: runtime.pid ?? null,
      startedAt: runtime.startedAt ?? null,
      restarts: runtime.restarts ?? 0,
      crashes: runtime.crashes ?? 0,
      tools: server.tools.map(tool => tool.id ?? (server.namespace + tool.name)),
      toolCount: server.tools.length,
      config: projectMcpConfig(mcpRecord(id).config)
    };
  }

  /** 工具"是否被允许调用 / 是否真的可用"的唯一推导点。 */
  function toolState(tool, { pluginId = null } = {}) {
    const pack = pluginId ? requirePlugin(pluginId) : packOwning(tool.id);
    const parentEnabled = pack ? pluginEnabled(pack.id) : true;
    const record = pack ? pluginRecord(pack.id) : {};
    const toggle = (record.tools ?? {})[tool.id];
    const toggled = typeof toggle === 'boolean' ? toggle : tool.enabledByDefault !== false;
    const restorable = isRestorable(tool.restore);
    const enabled = restorable && parentEnabled && toggled;

    let sourceStatus = 'ready';
    let lastError = null;
    let available = enabled;
    const integrationId = integrationIdForTool(tool);
    if (integrationId) {
      const integration = integrationStatus(integrationId) ?? {};
      const active = integration.enabled !== false;
      sourceStatus = active ? (integration.status ?? 'ready') : 'disabled';
      available = enabled && active && integration.available !== false;
      lastError = integration.lastError ?? null;
    } else if (serverByIdForTool(tool)) {
      const server = serverState(tool.serverId);
      sourceStatus = server.status;
      available = enabled && server.status === 'running';
      lastError = server.lastError;
    }
    return {
      id: tool.id, enabled, available, restorable,
      restore: tool.restore, reason: tool.reason ?? null,
      pluginId: pack?.id ?? null, sourceStatus, lastError
    };
  }

  function toolView(tool, options = {}) {
    return {
      id: tool.id, name: tool.name, label: tool.label, description: tool.description,
      source: tool.source, origin: tool.origin, serverId: tool.serverId, group: tool.group, schema: tool.schema,
      risk: tool.risk, capability: tool.capability, permissions: [...tool.permissions],
      restore: tool.restore, reason: tool.reason,
      ...toolState(tool, options)
    };
  }

  function resolveTool(id) {
    const tool = toolById.get(String(id));
    if (!tool) throw integrationError('UNKNOWN_TOOL', '未知工具：' + id);
    return tool;
  }

  /** 调用前的统一闸门：未知 / 未恢复 / 未开启 / 来源不可用 一律拒绝。 */
  function invokeGuard(id, options = {}) {
    const tool = resolveTool(id);
    if (!isRestorable(tool.restore)) {
      throw integrationError('LEGACY_UNSUPPORTED', '工具 ' + tool.id + ' 不可恢复：' + (tool.reason ?? tool.restore));
    }
    const state = toolState(tool, options);
    if (!state.enabled) throw integrationError('TOOL_DISABLED', '工具 ' + tool.id + ' 已被关闭');
    if (!state.available) {
      throw integrationError('TOOL_UNAVAILABLE', '工具 ' + tool.id + ' 当前不可用（' + state.sourceStatus + '）'
        + (state.lastError ? '：' + state.lastError : ''));
    }
    return { tool, state };
  }

  function listPlugins({ category = null, enabled = null } = {}) {
    return plugins
      .map(plugin => pluginView(plugin))
      .filter(row => (category && category !== 'installed' ? row.category === category : true))
      .filter(row => (typeof enabled === 'boolean' ? row.enabled === enabled : true));
  }

  function pluginView(plugin) {
    const record = pluginRecord(plugin.id);
    const isMcp = plugin.kind === 'mcp-server';
    const enabled = pluginEnabled(plugin.id);
    const toolIds = plugin.toolIds ?? [];
    const toolRows = toolIds.map(id => {
      const tool = toolById.get(id);
      return tool ? toolView(tool, { pluginId: plugin.kind === 'tool-pack' ? plugin.id : null }) : null;
    }).filter(Boolean);
    return {
      id: plugin.id, name: plugin.name, kind: plugin.kind, version: plugin.version,
      summary: plugin.summary, category: plugin.category,
      permissions: [...(plugin.permissions ?? [])],
      advanced: plugin.advanced ?? {},
      provider: plugin.provider ?? null,
      localService: plugin.localService ?? null,
      icon: plugin.icon ?? null,
      settingsRoute: plugin.settingsRoute ?? null,
      mcpServerId: plugin.mcpServerId ?? null,
      enabled,
      status: isMcp ? serverState(plugin.mcpServerId) : { enabled, provider: plugin.provider ?? null, status: enabled ? 'enabled' : 'disabled' },
      toggleableTools: plugin.kind === 'tool-pack',
      toolCount: toolRows.length,
      enabledToolCount: toolRows.filter(row => row.enabled).length,
      availableToolCount: toolRows.filter(row => row.available).length,
      tools: toolRows,
      settings: {
        parentToggle: { key: 'enabled', value: enabled },
        tools: toolRows.map(row => ({ id: row.id, name: row.label ?? row.name, group: row.group, enabled: row.enabled, available: row.available, restore: row.restore, risk: row.risk })),
        advanced: { ...(plugin.advanced ?? {}), overrides: record }
      }
    };
  }

  function setPluginEnabled(id, enabled) {
    const plugin = requirePlugin(id);
    if (typeof enabled !== 'boolean') throw integrationError('INVALID_PARAMS', 'enabled 必须是布尔值');
    store.update(current => {
      const next = structuredClone(current);
      if (plugin.kind === 'mcp-server') {
        next.mcp[plugin.mcpServerId] = { ...(next.mcp[plugin.mcpServerId] ?? {}), enabled };
      }
      next.plugins[id] = { ...(next.plugins[id] ?? {}), enabled };
      return next;
    });
    return pluginView(plugin);
  }

  function setToolEnabled(pluginId, toolId, enabled) {
    const plugin = requirePlugin(pluginId);
    if (plugin.kind !== 'tool-pack') {
      throw integrationError('TOOL_TOGGLE_UNSUPPORTED', '插件 ' + plugin.id + ' 不支持逐工具开关');
    }
    if (!(plugin.toolIds ?? []).includes(toolId)) throw integrationError('UNKNOWN_TOOL', '插件 ' + plugin.id + ' 不包含工具 ' + toolId);
    const tool = resolveTool(toolId);
    if (typeof enabled !== 'boolean') throw integrationError('INVALID_PARAMS', 'enabled 必须是布尔值');
    if (enabled && !isRestorable(tool.restore)) {
      throw integrationError('LEGACY_UNSUPPORTED', '工具 ' + tool.id + ' 已标记为不可恢复（' + tool.restore + '），不允许开启');
    }
    store.update(current => {
      const next = structuredClone(current);
      const record = next.plugins[pluginId] ?? {};
      record.tools = { ...(record.tools ?? {}), [toolId]: enabled };
      next.plugins[pluginId] = record;
      return next;
    });
    return toolView(tool, { pluginId });
  }

  function listTools({ source = null, pluginId = null, enabled = null, available = null, serverId = null } = {}) {
    return tools
      .filter(tool => (source ? tool.source === source : true))
      .filter(tool => (serverId ? tool.serverId === serverId : true))
      .filter(tool => (pluginId ? (requirePlugin(pluginId).toolIds ?? []).includes(tool.id) : true))
      .map(tool => toolView(tool, { pluginId: pluginId && pluginById.get(pluginId)?.kind === 'tool-pack' ? pluginId : null }))
      .filter(row => (typeof enabled === 'boolean' ? row.enabled === enabled : true))
      .filter(row => (typeof available === 'boolean' ? row.available === available : true));
  }

  function setMcpEnabled(id, enabled) {
    requireServer(id);
    if (typeof enabled !== 'boolean') throw integrationError('INVALID_PARAMS', 'enabled 必须是布尔值');
    store.update(current => {
      const next = structuredClone(current);
      next.mcp[id] = { ...(next.mcp[id] ?? {}), enabled };
      next.plugins['mcp.' + id] = { ...(next.plugins['mcp.' + id] ?? {}), enabled };
      return next;
    });
    return serverState(id);
  }

  function updateMcpConfig(id, patch) {
    requireServer(id);
    const clean = assertMcpConfigPatch(patch);
    store.update(current => {
      const next = structuredClone(current);
      next.mcp[id] = { ...(next.mcp[id] ?? {}), config: { ...(next.mcp[id]?.config ?? {}), ...clean } };
      return next;
    });
    return { id, config: projectMcpConfig(mcpRecord(id).config) };
  }

  /** Internal launch-only access; config values must not cross the service DTO boundary. */
  function mcpRuntimeConfig(id) {
    requireServer(id);
    return structuredClone(mcpRecord(id).config ?? {});
  }

  function mcpConfig(id) {
    requireServer(id);
    return { id, config: projectMcpConfig(mcpRecord(id).config), enabled: serverEnabled(id) };
  }

  /** 供 DSH preset / agent 侧白名单消费：当前被允许调用的工具全名。 */
  function agentAllowlist() {
    const names = listTools({ enabled: true }).map(row => row.id);
    return { generatedAt: now(), tools: names, bySource: { mcp: names.filter(name => name.startsWith('mcp__')), agent: names.filter(name => name.startsWith('agent__')) } };
  }

  return {
    plugins,
    tools,
    servers,
    requirePlugin,
    requireServer,
    resolveTool,
    pluginEnabled,
    serverEnabled,
    serverState,
    toolState,
    toolView,
    invokeGuard,
    listPlugins,
    pluginView,
    setPluginEnabled,
    setToolEnabled,
    listTools,
    listMcpServers: () => servers.map(server => serverState(server.id)),
    getMcpServer: id => serverState(requireServer(id).id),
    setMcpEnabled,
    mcpConfig,
    mcpRuntimeConfig,
    updateMcpConfig,
    agentAllowlist,
    toolById,
    pluginById,
    serverById
  };
}
