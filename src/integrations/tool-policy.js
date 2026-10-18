// External DSH-owned stdio children share the persisted user switches with the Desktop.
// Read on every execution: a long-running child must observe toggles without a restart.
// Runtime availability belongs to the process supervisor, not this policy gate.
import { APP_PATHS } from '../app-paths.js';
import { MCP_SERVER_CATALOG } from './catalog.js';
import { createIntegrationStore } from './store.js';
import { createIntegrationRegistry } from './registry.js';
import { integrationError } from './types.js';

export function assertIntegrationToolEnabled(toolId, { stateDir = APP_PATHS.stateDir } = {}) {
  try {
    const registry = createIntegrationRegistry({ store: createIntegrationStore({ stateDir }) });
    const { tool, state } = registry.assertToolEnabled(toolId);
    return { id: tool.id, enabled: state.enabled };
  } catch (error) {
    if (['TOOL_DISABLED', 'LEGACY_UNSUPPORTED', 'UNKNOWN_TOOL'].includes(error?.code)) throw error;
    // Store errors can contain local paths. Expose a stable denial without their raw message.
    throw integrationError('INTEGRATION_POLICY_UNAVAILABLE', '工具开关无法读取，已拒绝执行。');
  }
}

export function assertMcpToolEnabled(serverId, toolName, options = {}) {
  const server = MCP_SERVER_CATALOG.find(item => item.id === serverId);
  if (!server) throw integrationError('UNKNOWN_MCP_SERVER', '未知 MCP Server。');
  if (['snowluma', 'qq-file-send'].includes(serverId) && !isQqConnectorEnabled(options)) {
    throw integrationError('QQ_DISABLED', 'QQ Connector 已禁用。');
  }
  return assertIntegrationToolEnabled(server.namespace + toolName, options);
}

export function isIntegrationToolEnabled(toolId, options = {}) {
  try { assertIntegrationToolEnabled(toolId, options); return true; }
  catch (error) { void error; return false; /* Every policy lookup failure denies execution. */ }
}

function isPluginEnabled(id, { stateDir = APP_PATHS.stateDir } = {}) {
  try {
    const registry = createIntegrationRegistry({ store: createIntegrationStore({ stateDir }) });
    return registry.pluginEnabled(id);
  } catch (error) {
    void error; // A damaged plugin policy fails closed for Bionic behavior.
    return false;
  }
}

export function isBionicChatEnabled(options = {}) {
  return isPluginEnabled('cetamesh-bionic-chat', options);
}

export function isQqConnectorEnabled(options = {}) {
  return isPluginEnabled('cetamesh-snowluma', options);
}

/** Convert a denied execution gate into the MCP protocol's structured tool error. */
export function mcpToolPolicyDenial(serverId, toolName, options = {}) {
  try { assertMcpToolEnabled(serverId, toolName, options); return null; }
  catch (error) {
    return { isError: true, content: [{ type: 'text', text: '[' + error.code + '] ' + error.message }] };
  }
}
