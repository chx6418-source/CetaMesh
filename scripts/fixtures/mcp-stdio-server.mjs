import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const mode = process.env.MCP_FIXTURE_MODE ?? 'normal';
if (mode === 'malformed') {
  process.stdout.write('not-json\n');
  setTimeout(() => process.exit(0), 50);
} else {
  const server = new McpServer({ name: 'mcp-stdio-fixture', version: '1.0.0' });
  server.tool(
    'qq_status',
    'Local stdio fixture status.',
    { crash: z.boolean().optional() },
    async ({ crash = false } = {}) => {
      const payload = {
        configuredSecretMatches: process.env.MCP_FIXTURE_SECRET === 'mcp-fixture-sentinel-for-redaction',
        args: process.argv.slice(2),
        cwd: process.cwd()
      };
      if (crash === true) setTimeout(() => {
        process.stderr.write('api_key=mcp-fixture-crash-secret\n');
        process.exit(73);
      }, 200);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );
  await server.connect(new StdioServerTransport());
}
