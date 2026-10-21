#!/usr/bin/env node
// Exercise the production stdio MCP host with a test-owned local process.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpRuntime, createStdioMcpConnection, resolveMcpLaunch } from '../src/integrations/mcp-runtime.js';

const fixtureEntry = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));
const packagedExe = path.join('C:', 'Program Files', 'CetaMesh Installed', 'WhaleBridgeCore.exe');
const packagedLaunch = resolveMcpLaunch({ id: 'snowluma', entry: 'src/mcp-snowluma-safe.js' }, {}, {
  packaged: true, execPath: packagedExe, sourceRoot: path.dirname(fixtureEntry)
});
assert.equal(packagedLaunch.command, packagedExe);
assert.deepEqual(packagedLaunch.args, ['--mcp', 'snowluma']);
assert.equal(packagedLaunch.cwd, path.dirname(packagedExe), 'installed Core child uses its current install directory as cwd');
assert.equal(JSON.stringify(packagedLaunch).includes(path.dirname(fixtureEntry)), false, 'installed MCP launch does not depend on the source checkout');
const sourceRoot = path.dirname(path.dirname(path.dirname(fixtureEntry)));
const sourceLaunch = resolveMcpLaunch({ id: 'local-fixture', entry: 'src/mcp-fixture.js' }, {}, {
  packaged: false, execPath: process.execPath, sourceRoot
});
assert.equal(sourceLaunch.args[0], path.join(sourceRoot, 'src', 'mcp-fixture.js'));
console.log('PASS MCP launcher resolves SEA modes from install location and source entries from source root');
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

const diagnostics = [];
const fixtureRuntime = createMcpRuntime({
  servers: [{ id: 'local-fixture', entry: fixtureEntry, namespace: 'fixture.', tools: [{ name: 'qq_status' }] }],
  log: line => diagnostics.push(line)
});
const running = await fixtureRuntime.start('local-fixture');
assert.equal(running.status, 'running', 'runtime marks fixture running after initialize and tools/list');
await fixtureRuntime.call('local-fixture', 'qq_status', { crash: true });
for (let attempt = 0; attempt < 40 && fixtureRuntime.status('local-fixture').status !== 'crashed'; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 25));
}
const crashed = fixtureRuntime.status('local-fixture');
assert.equal(crashed.status, 'crashed', 'unexpected child exit is observed by the common supervisor');
assert.equal(crashed.lastError.includes('mcp-fixture-crash-secret'), false, 'raw stderr secrets never reach UI status');
const diagnosticText = diagnostics.join('\n');
assert.match(diagnosticText, /"phase":"child-exit"/);
assert.match(diagnosticText, /"exitCode":73/);
assert.match(diagnosticText, /api_key=\[REDACTED:apiKey\]/);
assert.equal(diagnosticText.includes('mcp-fixture-crash-secret'), false, 'stderr tail is retained only after redaction');
console.log('PASS MCP child lifecycle diagnostics capture phase/exit/stderr and keep UI status generic');
await fixtureRuntime.closeAll();
