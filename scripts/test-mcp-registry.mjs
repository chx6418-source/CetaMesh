// 产品化任务 B：MCP Registry / Runtime 验收（enable/disable、discovery、crashed、restart、未知工具拒绝）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntegrationService } from '../src/integrations/service.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-mcp-runtime-'));
let step = 0;
const ok = label => { step += 1; console.log('✅ [' + step + '] ' + label); };

function makeTransportFactory({ fail = false } = {}) {
  const connections = [];
  const factory = server => {
    if (fail) throw new Error('spawn ENOENT: ' + server.entry);
    const connection = {
      pid: 4242,
      onClose(handler) { connection.closeHandler = handler; },
      async listTools() {
        return [{ name: server.tools[0].name, description: 'discovered', inputSchema: { type: 'object' } }];
      },
      async callTool(name, args) {
        return { content: [{ type: 'text', text: JSON.stringify({ server: server.id, name, args }) }] };
      },
      async close() { connection.closeHandler?.(null); }
    };
    connections.push(connection);
    return connection;
  };
  return { factory, connections };
}

try {
  const { factory, connections } = makeTransportFactory();
  const service = createIntegrationService({ stateDir: tmp, transportFactory: factory });

  // ── 1. 注册表：server id/name/transport/status/tools/permissions/source/last error ──
  const list = await service.execute({ method: 'mcp.list' });
  assert.equal(list.servers.length, 5, '注册表覆盖 5 个 MCP Server');
  for (const server of list.servers) {
    for (const key of ['id', 'name', 'transport', 'status', 'tools', 'permissions', 'source', 'lastError', 'enabled']) {
      assert.ok(Object.hasOwn(server, key), 'server 缺少 ' + key);
    }
    assert.equal(server.status, 'stopped');
    assert.equal(server.enabled, true);
    assert.ok(server.toolCount > 0);
  }
  const snow = await service.execute({ method: 'mcp.get', params: { id: 'snowluma' } });
  assert.equal(snow.transport, 'stdio');
  assert.equal(snow.namespace, 'mcp__snowluma__');
  assert.equal(snow.tools.length, 39, 'snowluma 39 个工具');
  ok('MCP Registry：' + list.servers.length + ' 个 server，字段齐全（snowluma ' + snow.tools.length + ' 工具）');

  // ── 2. 配置读取/更新（含非法配置拒绝） ────────────────────────────────────
  const before = await service.execute({ method: 'mcp.config.get', params: { id: 'bilibili' } });
  assert.deepEqual(before.config, {});
  const updated = await service.execute({
    method: 'mcp.config.update', params: { id: 'bilibili', config: { timeoutMs: 8000, env: { BILI_OFF: '1' }, note: '仅搜索' }, approved: true }
  });
  assert.equal(updated.config.timeoutMs, 8000);
  await assert.rejects(() => service.execute({ method: 'mcp.config.update', params: { id: 'bilibili', config: { entry: 'evil.js' }, approved: true } }),
    error => error.code === 'INVALID_PARAMS', '不允许改 entry');
  await assert.rejects(() => service.execute({ method: 'mcp.config.update', params: { id: 'bilibili', config: { timeoutMs: -1 }, approved: true } }),
    error => error.code === 'INVALID_PARAMS');
  ok('MCP 配置：读取/更新可用，未知键与非法类型一律 INVALID_PARAMS');

  // ── 3. 启停需要 Owner 显式确认（高风险能力） ──────────────────────────────
  const pending = await service.execute({ method: 'mcp.start', params: { id: 'snowluma' } });
  assert.equal(pending.status, 'pending', 'integration.mcp.manage = high → 未确认时进入审批');
  assert.ok(pending.approvalId, '携带审批编号');
  const started = await service.execute({ method: 'mcp.start', params: { id: 'snowluma', approved: true } });
  assert.equal(started.status, 'running');
  assert.equal(started.pid, 4242);
  assert.equal(started.tools.length, 1, '工具发现来自真实 listTools');
  assert.equal(started.tools[0].discovered, true);
  ok('MCP start：未确认 → pending 审批；approved=true → running + PID + 工具发现');

  // ── 4. 工具发现：运行中给真实结果，未运行回退目录声明 ─────────────────────
  const runningTools = await service.execute({ method: 'mcp.tools', params: { id: 'snowluma' } });
  assert.equal(runningTools.tools[0].discovered, true);
  const stoppedTools = await service.execute({ method: 'mcp.tools', params: { id: 'web-search-safe' } });
  assert.equal(stoppedTools.tools.length, 2);
  assert.ok(stoppedTools.tools.every(tool => tool.discovered === false));
  ok('MCP tool discovery：running 用真实 listTools，stopped 用目录声明（discovered=false）');

  // ── 5. 经工具面调用 MCP 工具：走 Capability Broker ────────────────────────
  const invoked = await service.execute({ method: 'tools.invoke', params: { id: 'mcp__snowluma__qq_status', input: { ping: 1 } } });
  assert.equal(invoked.status, 'completed');
  const payload = JSON.parse(invoked.result.content[0].text);
  assert.equal(payload.server, 'snowluma');
  assert.equal(payload.name, 'qq_status');
  assert.deepEqual(payload.args, { ping: 1 });
  assert.equal(connections.length, 1);
  ok('tools.invoke → MCP Server 真实 callTool（经 integration.tool.read 能力）');

  // ── 6. 未知 MCP 工具一律拒绝 ──────────────────────────────────────────────
  await assert.rejects(() => service.execute({ method: 'mcp.invoke', params: { serverId: 'snowluma', tool: 'qq_not_real', approved: true } }),
    error => error.code === 'UNKNOWN_MCP_TOOL');
  await assert.rejects(() => service.execute({ method: 'mcp.invoke', params: { serverId: 'not-a-server', tool: 'x' } }),
    error => error.code === 'UNKNOWN_MCP_SERVER');
  ok('未知 MCP 工具/未知 Server：UNKNOWN_MCP_TOOL / UNKNOWN_MCP_SERVER（不猜测、不转发）');

  // ── 7. 禁用后不可启动；禁用时运行中的 server 会被停止 ─────────────────────
  const disabled = await service.execute({ method: 'mcp.disable', params: { id: 'snowluma', approved: true } });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'disabled');
  await assert.rejects(() => service.execute({ method: 'mcp.start', params: { id: 'snowluma', approved: true } }),
    error => error.code === 'MCP_DISABLED');
  await assert.rejects(() => service.execute({ method: 'mcp.restart', params: { id: 'snowluma', approved: true } }),
    error => error.code === 'MCP_DISABLED');
  const reenabled = await service.execute({ method: 'mcp.enable', params: { id: 'snowluma', approved: true } });
  assert.equal(reenabled.enabled, true);
  ok('MCP enable/disable：禁用同时停止进程，禁用状态下 start/restart 被 MCP_DISABLED 拒绝');

  // ── 8. 崩溃状态：连接意外关闭 → crashed + lastError ───────────────────────
  await service.execute({ method: 'mcp.start', params: { id: 'snowluma', approved: true } });
  connections.at(-1).closeHandler(new Error('snowluma gateway lost'));
  const crashed = await service.execute({ method: 'mcp.get', params: { id: 'snowluma' } });
  assert.equal(crashed.status, 'crashed');
  assert.equal(crashed.lastError, 'snowluma gateway lost');
  assert.equal(crashed.crashes, 1);
  const unavailable = await service.execute({ method: 'tools.list', params: { serverId: 'snowluma', available: true } });
  assert.equal(unavailable.tools.length, 0, '崩溃后工具必须如实不可用');
  ok('MCP crashed：连接异常关闭 → status=crashed + lastError + crashes=1，工具立即不可用');

  // ── 9. restart：停止后重新拉起并计数 ──────────────────────────────────────
  const restarted = await service.execute({ method: 'mcp.restart', params: { id: 'snowluma', approved: true } });
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.restarts, 1);
  const stopped = await service.execute({ method: 'mcp.stop', params: { id: 'snowluma', approved: true } });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  ok('MCP restart/stop：重启计数 + 干净停止（pid 清空）');

  // ── 10. 启动失败：如实 crashed + MCP_START_FAILED（不伪造 running） ────────
  const broken = createIntegrationService({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-mcp-broken-')), transportFactory: makeTransportFactory({ fail: true }).factory });
  await assert.rejects(() => broken.execute({ method: 'mcp.start', params: { id: 'bilibili', approved: true } }),
    error => error.code === 'MCP_START_FAILED');
  const brokenStatus = await broken.execute({ method: 'mcp.get', params: { id: 'bilibili' } });
  assert.equal(brokenStatus.status, 'crashed');
  assert.match(brokenStatus.lastError, /ENOENT/);
  await broken.close();
  ok('MCP start 失败：MCP_START_FAILED + status=crashed + lastError，绝不假装 running');

  await service.close();
  console.log('\nPASS CetaMesh MCP Registry/Runtime（' + step + ' 组断言）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
