// Compatibility tombstone: retired host tools never inspect or control user processes.
import { assertNotRetiredSnowLuma } from './integrations/retired.js';
import { isMainModule, reportEntrypointError } from './entrypoint.js';

export async function runMcpSnowLumaHost() {
  assertNotRetiredSnowLuma('snowluma-host');
}

if (isMainModule(import.meta.url)) {
  runMcpSnowLumaHost().catch(error => reportEntrypointError('mcp-snowluma-host', error));
}
