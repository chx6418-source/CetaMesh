// 测试安全 Web Search / Fetch MCP server：
// - web_search：查一个网络用语/梗
// - web_fetch：抓取一个公开 URL 并检查是否返回正文
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

function readSuccessfulJson(result, tool) {
  assert.equal(result.isError ?? false, false, `${tool} must not report a tool error`);
  const text = result.content?.find(part => part.type === 'text')?.text;
  assert.ok(typeof text === 'string' && text.trim(), `${tool} must return nonempty text`);
  const payload = JSON.parse(text);
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), `${tool} must return a JSON object`);
  return payload;
}

try {
  await client.connect(transport);
  console.log('✅ Web Search MCP 连接成功');
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const name of ['web_search', 'web_fetch']) assert.ok(names.includes(name), `${name} must be exposed`);
  console.log('工具:', names.join(', '));

  const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
  const searchPayload = readSuccessfulJson(search, 'web_search');
  assert.equal(searchPayload.query, 'DeepSeek娘 萌娘百科', 'search response must belong to the requested query');
  assert.ok(['google', 'sogou'].includes(searchPayload.engine), 'search must identify a supported engine');
  assert.ok(Array.isArray(searchPayload.results) && searchPayload.results.length > 0, 'search must return at least one result');
  for (const result of searchPayload.results) {
    assert.ok(typeof result.title === 'string' && result.title.trim(), 'search result must include a title');
    assert.ok(['http:', 'https:'].includes(new URL(result.url).protocol), 'search result must include an HTTP(S) URL');
  }
  console.log('✅ web_search:', search.content?.[0]?.text?.slice(0, 300));

  const fetch = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://mobile.moegirl.org.cn/DeepSeek%E5%A8%98' }
  });
  const fetched = readSuccessfulJson(fetch, 'web_fetch');
  assert.ok(Number.isInteger(fetched.statusCode) && fetched.statusCode >= 200 && fetched.statusCode < 300, 'fetch must return a successful HTTP status');
  assert.ok(['http:', 'https:'].includes(new URL(fetched.url).protocol), 'fetch must identify its final HTTP(S) URL');
  assert.equal(typeof fetched.truncated, 'boolean', 'fetch must report truncation status');
  assert.ok(typeof fetched.body === 'string' && fetched.body.trim(), 'fetch must return a nonempty document body');
  console.log('✅ web_fetch:', fetched.body.slice(0, 500));

  // 内网地址应被拒绝
  const bad = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  assert.equal(bad.isError, true, 'private-address fetch must be rejected');
  const denial = bad.content?.find(part => part.type === 'text')?.text;
  assert.ok(typeof denial === 'string', 'private-address rejection must explain its reason');
  assert.match(denial, /禁止访问内网\/本机地址|域名解析到内网\/本机地址，已阻止/u, 'private-address denial must not be a timeout or unrelated upstream error');
  console.log('🚫 内网拦截: 被拒绝 ✓', denial.slice(0, 120));
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await client.close();
}
