// CetaMesh Tool / MCP / Plugin / Integration 概念层（产品化任务 B）。
//
// 四个概念在**底层**保持分离，在**产品层**统一收进顶层 Plugins：
//   - Tool        ：一次可调用的原子动作（有 schema / risk / 所属 source）。
//   - MCP Server  ：提供若干 Tool 的独立进程（stdio 传输），可 start/stop/restart。
//   - Plugin      ：安装/配置/状态/开关的统一挂载单位（parent toggle）。
//   - Integration ：把**已有底层 Provider**（SnowLuma=Channel Provider，DSH=Agent Provider）
//                   以 Plugin 卡片形式暴露给用户；不改变底层架构。
//
// 本文件只放常量与纯函数，不引入运行时依赖。

/** 产品层顶层 Plugins 下的分类（普通用户只看这一层）。 */
export const PLUGIN_CATEGORIES = Object.freeze(['installed', 'tools', 'mcp', 'integrations']);

/** Tool 的来源。产品层用它决定"谁提供、怎么启停、失败归谁"。 */
export const TOOL_SOURCES = Object.freeze(['builtin', 'mcp', 'extension', 'agent', 'channel']);

/** 插件形态。决定二级设置页渲染什么，以及生命周期委托给谁。 */
export const PLUGIN_KINDS = Object.freeze(['tool-pack', 'mcp-server', 'channel-integration', 'agent-integration', 'extension']);

/**
 * 历史工具处置结论。restored 才允许启用；legacy-unsupported 在 UI 上必须显示为
 * Disabled / Legacy Unsupported，且**不允许**通过任何开关打开。
 */
export const RESTORE_STATUSES = Object.freeze(['restored', 'partial', 'deprecated', 'legacy-unsupported']);

export const MCP_STATUSES = Object.freeze(['stopped', 'starting', 'running', 'stopping', 'crashed', 'disabled', 'unsupported']);

export const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

/** 按风险分档的能力 id（单一能力面，避免为每个工具注册一个能力）。 */
export const TOOL_CAPABILITIES = Object.freeze({
  read: 'integration.tool.read',
  write: 'integration.tool.write',
  admin: 'integration.tool.admin',
  mcpManage: 'integration.mcp.manage',
  pluginManage: 'integration.plugin.manage'
});

export const TOOL_CAPABILITY_PERMISSION = Object.freeze({
  'integration.tool.read': 'extension.invoke',
  'integration.tool.write': 'extension.invoke',
  'integration.tool.admin': 'extension.invoke',
  'integration.mcp.manage': 'extension.invoke',
  'integration.plugin.manage': 'storage'
});

export const TOOL_CAPABILITY_RISK = Object.freeze({
  'integration.tool.read': 'low',
  'integration.tool.write': 'medium',
  'integration.tool.admin': 'high',
  // MCP 进程启停 = high（Owner 必须显式确认）；插件/开关是本地可逆配置 = medium。
  'integration.mcp.manage': 'high',
  'integration.plugin.manage': 'medium'
});

export function capabilityForRisk(risk) {
  const rank = RISK_RANK[String(risk)] ?? 0;
  if (rank >= RISK_RANK.high) return TOOL_CAPABILITIES.admin;
  if (rank >= RISK_RANK.medium) return TOOL_CAPABILITIES.write;
  return TOOL_CAPABILITIES.read;
}

export function integrationError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 可开启 = restored（默认开）或 partial（默认关，需 Owner 逐项显式开启）。 */
export function isRestorable(status) {
  return status === 'restored' || status === 'partial';
}

/** 完全恢复 = 默认即开、无额外前置条件。 */
export function isFullyRestored(status) {
  return status === 'restored';
}

export function normalizeEnabled(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}
