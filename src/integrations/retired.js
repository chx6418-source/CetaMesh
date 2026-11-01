// Retired identifiers are tombstones, never aliases for a different integration.
// Keep this boundary pure so CLI, registries and control routes can deny before IO.
const RETIRED_IDS = new Set([
  'snowluma', 'snowluma-host', 'cetamesh-snowluma',
  'mcp-snowluma', 'mcp-snowluma-host', 'mcp.snowluma', 'mcp.snowluma-host'
]);

export function isRetiredSnowLumaId(value) {
  const id = String(value ?? '');
  return RETIRED_IDS.has(id) || id.startsWith('mcp__snowluma__')
    || id.startsWith('mcp__snowluma-host__') || id.startsWith('snowluma-mcp.');
}

export function assertNotRetiredSnowLuma(value) {
  if (isRetiredSnowLumaId(value)) {
    throw Object.assign(new Error('[SNOWLUMA_INTEGRATION_RETIRED] SnowLuma 专属集成已下线；如需通用 OneBot，请在设置中重新配置并显式启用。旧标识不会自动映射。'), {
      code: 'SNOWLUMA_INTEGRATION_RETIRED'
    });
  }
}
