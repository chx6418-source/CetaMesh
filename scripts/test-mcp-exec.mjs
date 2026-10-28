// 验证 CetaMesh 自有安全 MCP 的真实握手与状态工具。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mcpEntry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntry],
  env: { ...process.env }
});

const client = new Client({ name: 'bridge-test', version: '0.1.0' });
try {
  await client.connect(transport);
  console.log('✅ MCP 连接成功');

  const tools = await client.listTools();
  console.log(`✅ tools/list: ${tools.tools.length} 个工具`);
  const names = tools.tools.map((t) => t.name);
  console.log('   ', names.join(', '));
  const hasQuery = names.includes('qq_status');
  assert.ok(hasQuery, 'safe status tool is exposed');
  assert.ok(!names.includes('invoke_action'), 'arbitrary vendor action execution is not exposed');
  console.log('✅ 安全 qq_status 可用；任意动作执行未暴露');

  if (hasQuery) {
    const result = await client.callTool({ name: 'qq_status', arguments: {} });
    assert.equal(result.isError ?? false, false, 'qq_status must not report a tool error');
    const text = result.content?.find(part => part.type === 'text')?.text;
    assert.ok(typeof text === 'string' && text.trim(), 'qq_status must return account status text');
    const status = JSON.parse(text);
    assert.ok(status && typeof status === 'object' && !Array.isArray(status), 'qq_status must return a JSON object');
    assert.match(String(status.user_id ?? ''), /^[1-9]\d*$/, 'qq_status must identify the logged-in account');
    assert.equal(status.online, true, 'qq_status must confirm the account is online');
    assert.equal(status.good, true, 'qq_status must confirm the gateway is healthy');
    console.log('✅ qq_status:', JSON.stringify(result).slice(0, 300));
  }
  
} catch (error) {
  console.error('❌ MCP 测试失败:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await client.close();
}
