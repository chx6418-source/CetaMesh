// Exercise the real acceptance scripts against a local SDK stdio server.
// This checks exit-code truthfulness, not public search or account compatibility.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

async function serveFixture(suite, scenario) {
  const server = new McpServer({ name: 'acceptance-assertion-fixture', version: '1.0.0' });
  if (suite === 'status') {
    server.tool('qq_status', 'Synthetic status only.', {}, async () => {
      if (scenario === 'tool-error') return { ...text('查询失败：synthetic gateway unavailable'), isError: true };
      if (scenario === 'empty') return { content: [] };
      if (scenario === 'malformed') return text('not JSON');
      if (scenario === 'missing-identity') return text({ online: true, good: true });
      return text({ user_id: 10001, nickname: 'Synthetic fixture', online: scenario !== 'offline', good: scenario !== 'unhealthy' });
    });
  } else {
    server.tool('web_search', 'Synthetic search only.', { query: z.string() }, async ({ query }) => {
      if (scenario === 'search-error') return { ...text('搜索失败：synthetic upstream unavailable'), isError: true };
      if (scenario === 'search-malformed') return text('not JSON');
      return text({ query, engine: 'google', results: scenario === 'search-empty' ? [] : [{ title: 'Synthetic result', url: 'https://example.com/result' }] });
    });
    server.tool('web_fetch', 'Synthetic fetch only; no network requests.', { url: z.string() }, async ({ url }) => {
      if (url === 'http://127.0.0.1/') {
        if (scenario === 'private-allowed') return text({ url, statusCode: 200, truncated: false, body: 'Synthetic unsafe result' });
        return { ...text(scenario === 'private-timeout' ? '抓取失败：请求超时' : '抓取失败：禁止访问内网/本机地址'), isError: true };
      }
      if (scenario === 'fetch-error') return { ...text('抓取失败：synthetic upstream unavailable'), isError: true };
      if (scenario === 'fetch-malformed') return text('not JSON');
      return text({ url, statusCode: scenario === 'fetch-http-error' ? 503 : 200, truncated: false, body: scenario === 'fetch-empty' ? '  ' : 'Synthetic public document' });
    });
  }
  await server.connect(new StdioServerTransport());
}

function runAcceptance(suite, scenario) {
  const fixture = fileURLToPath(import.meta.url);
  const stdioModule = import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  // Only replace the server entry. The acceptance script, SDK client and MCP
  // framing remain real. Production MCP modules and user configuration never load.
  const replacement = 'data:text/javascript,' + encodeURIComponent(`
    import { StdioClientTransport as Base } from ${JSON.stringify(stdioModule)};
    export class StdioClientTransport extends Base {
      constructor(options) {
        super({ ...options, args: [${JSON.stringify(fixture)}, '--fixture', ${JSON.stringify(suite)}, ${JSON.stringify(scenario)}] });
      }
    }
  `);
  const loader = 'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '@modelcontextprotocol/sdk/client/stdio.js') return { url: ${JSON.stringify(replacement)}, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `);
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { register } from 'node:module';
    register(${JSON.stringify(loader)}, ${JSON.stringify(import.meta.url)});
  `);
  const entry = fileURLToPath(new URL(suite === 'status' ? './test-mcp-exec.mjs' : './test-mcp-web-search.mjs', import.meta.url));
  return spawnSync(process.execPath, ['--import', preload, entry], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true
  });
}

if (process.argv[2] === '--fixture') {
  await serveFixture(process.argv[3], process.argv[4]);
} else {
  const cases = [
    ['status', 'success', 0],
    ['status', 'tool-error', 1],
    ['status', 'empty', 1],
    ['status', 'malformed', 1],
    ['status', 'missing-identity', 1],
    ['status', 'offline', 1],
    ['status', 'unhealthy', 1],
    ['web', 'success', 0],
    ['web', 'search-error', 1],
    ['web', 'search-malformed', 1],
    ['web', 'search-empty', 1],
    ['web', 'fetch-error', 1],
    ['web', 'fetch-malformed', 1],
    ['web', 'fetch-http-error', 1],
    ['web', 'fetch-empty', 1],
    ['web', 'private-allowed', 1],
    ['web', 'private-timeout', 1]
  ];
  const failures = [];
  for (const [suite, scenario, exitCode] of cases) {
    const result = runAcceptance(suite, scenario);
    try {
      assert.ifError(result.error);
      assert.equal(result.signal, null, 'acceptance child must exit normally');
      assert.equal(result.status, exitCode, `${suite}/${scenario} must exit ${exitCode}`);
      if (exitCode !== 0) assert.match(result.stderr, /失败/, 'failure diagnostic is preserved');
      console.log(`PASS fixture ${suite}/${scenario}: acceptance exit ${exitCode}`);
    } catch (error) {
      failures.push(`${suite}/${scenario}: ${error.message}`);
      console.error(`FAIL fixture ${suite}/${scenario}: ${error.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('PASS acceptance-script exit contracts against local MCP fixtures; real gateway and public search NOT_RUN');
}
