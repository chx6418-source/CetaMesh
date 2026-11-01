// Compatibility tombstone: old SnowLuma MCP entry points never start a server.
import { assertNotRetiredSnowLuma } from './integrations/retired.js';
import { isMainModule, reportEntrypointError } from './entrypoint.js';

export async function runMcpSnowLuma() {
  assertNotRetiredSnowLuma('snowluma');
}

if (isMainModule(import.meta.url)) {
  runMcpSnowLuma().catch(error => reportEntrypointError('mcp-snowluma', error));
}
