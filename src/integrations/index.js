// CetaMesh Plugins / Tools / MCP / Integrations（产品化任务 B）公共入口。
export { createIntegrationService } from './service.js';
export { createIntegrationRegistry } from './registry.js';
export { createIntegrationStore, INTEGRATION_STORE_VERSION } from './store.js';
export { createMcpRuntime, createStdioMcpConnection } from './mcp-runtime.js';
export {
  MCP_SERVER_CATALOG,
  AGENT_TOOL_CATALOG,
  LEGACY_RETIRED_TOOLS,
  buildToolCatalog,
  allPluginDescriptors,
  pluginDescriptors,
  mcpServerPlugins,
  toolIdFor
} from './catalog.js';
export {
  PLUGIN_CATEGORIES,
  TOOL_SOURCES,
  PLUGIN_KINDS,
  RESTORE_STATUSES,
  MCP_STATUSES,
  RISK_RANK,
  TOOL_CAPABILITIES,
  TOOL_CAPABILITY_PERMISSION,
  TOOL_CAPABILITY_RISK,
  capabilityForRisk,
  integrationError,
  isRestorable,
  isFullyRestored
} from './types.js';
