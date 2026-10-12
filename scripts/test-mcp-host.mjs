#!/usr/bin/env node
// Exercise the production stdio MCP host with a test-owned local process.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStdioMcpConnection } from '../src/integrations/mcp-runtime.js';

const fixtureEntry = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));
let connection = null;
try {
  connection = await createStdioMcpConnection({ id: 'local-fixture', entry: fixtureEntry });
  assert.ok(Number.isInteger(connection.pid), 'stdio fixture must be an owned child process');
  const tools = await connection.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['qq_status']);
  const response = await connection.callTool('qq_status', {});
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.configuredSecretMatches, false);
  assert.deepEqual(payload.args, []);
  console.log('PASS official MCP stdio initialize/listTools/callTool against local fixture');
} finally {
  await connection?.close();
}

await assert.rejects(() => createStdioMcpConnection(
  { id: 'malformed-fixture', entry: fixtureEntry },
  { env: { MCP_FIXTURE_MODE: 'malformed' } }
));
console.log('PASS malformed local MCP protocol data fails closed');
