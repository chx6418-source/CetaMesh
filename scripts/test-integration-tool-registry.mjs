// 产品化任务 B：Tools Registry / 目录完整性 / 开关语义验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolCatalog, LEGACY_RETIRED_TOOLS } from '../src/integrations/catalog.js';
import { createIntegrationStore } from '../src/integrations/store.js';
import { createIntegrationRegistry } from '../src/integrations/registry.js';
import { TOOL_SOURCES, RESTORE_STATUSES, MCP_STATUSES } from '../src/integrations/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-integration-registry-'));
let step = 0;
const ok = label => { step += 1; console.log('✅ [' + step + '] ' + label); };

try {
  const store = createIntegrationStore({ stateDir: tmp });
  const tools = buildToolCatalog();

  // ── 1. 目录完整性：每个工具字段齐全、来源合法、id 唯一 ──────────────────────
  assert.ok(tools.length >= 50, '历史审计口径：QQ 仿生聊天工具 >= 50，实际 ' + tools.length);
  for (const tool of tools) {
    for (const key of ['id', 'name', 'description', 'source', 'schema', 'risk', 'restore']) {
      assert.ok(tool[key] !== undefined && tool[key] !== null && tool[key] !== '', tool.id + ' 缺少 ' + key);
    }
    assert.ok(TOOL_SOURCES.includes(tool.source), tool.id + ' source 非法：' + tool.source);
    assert.ok(RESTORE_STATUSES.includes(tool.restore), tool.id + ' restore 非法');
    assert.ok(['low', 'medium', 'high', 'critical'].includes(tool.risk), tool.id + ' risk 非法');
    assert.equal(tool.schema.type, 'object');
  }
  assert.equal(new Set(tools.map(tool => tool.id)).size, tools.length, '工具 id 必须唯一');
  assert.ok(tools.some(tool => tool.source === 'mcp'), '存在 MCP 来源工具');
  assert.ok(tools.some(tool => tool.source === 'agent'), '存在 Agent Provider 来源工具');
  ok('目录完整性：' + tools.length + ' 个工具字段齐全、id 唯一、source/restore/risk 合法');

  const running = new Set();
  const registry = createIntegrationRegistry({
    store,
    mcpStatus: id => (running.has(id) ? { status: 'running' } : { status: 'stopped' }),
    integrationStatus: () => ({ enabled: true, available: true, status: 'ready' })
  });

  // ── 2. 统一输出形状（tool id/name/description/source/schema/risk/enabled/available/lastError） ──
  const sample = registry.listTools({ source: 'mcp' })[0];
  for (const key of ['id', 'name', 'description', 'source', 'schema', 'risk', 'enabled', 'available', 'lastError']) {
    assert.ok(Object.hasOwn(sample, key), 'tools 输出缺少 ' + key);
  }
  assert.equal(sample.available, false, 'MCP Server 未运行时工具必须如实不可用');
  assert.equal(sample.enabled, true, '默认开启的工具 enabled=true');
  ok('Tools Registry 统一输出：' + Object.keys(sample).length + ' 个字段，含 enabled/available/lastError');

  // ── 3. 未知工具一律拒绝 ────────────────────────────────────────────────────
  assert.throws(() => registry.resolveTool('mcp__nope__nope'), error => error.code === 'UNKNOWN_TOOL');
  assert.throws(() => registry.invokeGuard('agent__nope'), error => error.code === 'UNKNOWN_TOOL');
  ok('未知工具：resolveTool / invokeGuard 均 UNKNOWN_TOOL');

  // ── 4. 不可恢复工具：永远 Disabled，且不允许被打开 ─────────────────────────
  const legacy = registry.listTools().filter(tool => tool.restore === 'legacy-unsupported');
  assert.ok(legacy.length >= 2, '进程控制类工具被明确标记 legacy-unsupported');
  assert.ok(legacy.some(tool => tool.id.includes('start_snowluma')), 'start_snowluma 不可恢复');
  for (const tool of legacy) {
    assert.equal(tool.enabled, false, tool.id + ' 不可恢复工具必须 Disabled');
    assert.equal(tool.restorable, false);
    assert.ok(tool.reason && tool.reason.length > 8, tool.id + ' 必须给出不可恢复原因');
  }
  assert.throws(() => registry.setToolEnabled('cetamesh-bionic-chat', legacy[0].id, true),
    error => error.code === 'LEGACY_UNSUPPORTED');

  // partial = 有实现但有前置条件/安全红线：默认 Disabled，可由 Owner 逐项显式开启。
  const partial = registry.listTools().filter(tool => tool.restore === 'partial');
  assert.ok(partial.length >= 4, 'partial 工具（安全红线/未确认提供方）数量异常：' + partial.length);
  for (const tool of partial) assert.equal(tool.enabled, false, tool.id + ' partial 必须默认关闭');
  const partialOn = registry.setToolEnabled('cetamesh-bionic-chat', partial[0].id, true);
  assert.equal(partialOn.enabled, true, 'partial 允许 Owner 逐项显式开启');
  registry.setToolEnabled('cetamesh-bionic-chat', partial[0].id, false);
  ok('不可恢复工具 ' + legacy.length + ' 个 + partial ' + partial.length + ' 个：前者不可开启，后者默认关闭可逐项开启');

  // ── 5. 逐工具开关 + 可用性由来源决定 ───────────────────────────────────────
  const tool = registry.listTools({ source: 'mcp' }).find(row => row.restore === 'restored' && row.risk === 'low');
  assert.ok(tool, '存在可恢复的低风险 MCP 工具');
  const off = registry.setToolEnabled('cetamesh-bionic-chat', tool.id, false);
  assert.equal(off.enabled, false);
  assert.throws(() => registry.invokeGuard(tool.id), error => error.code === 'TOOL_DISABLED');
  registry.setToolEnabled('cetamesh-bionic-chat', tool.id, true);
  assert.throws(() => registry.invokeGuard(tool.id), error => error.code === 'TOOL_UNAVAILABLE');
  running.add(tool.serverId);
  const stateOn = registry.toolState(registry.resolveTool(tool.id));
  assert.equal(stateOn.available, true, 'Server running 后工具可用');
  assert.equal(registry.invokeGuard(tool.id).tool.id, tool.id);
  ok('逐工具开关：关闭 → TOOL_DISABLED；开启但 Server 未运行 → TOOL_UNAVAILABLE；运行后可用');

  // ── 6. 父开关（总开关）级联 ────────────────────────────────────────────────
  registry.setPluginEnabled('cetamesh-bionic-chat', false);
  assert.equal(registry.pluginEnabled('cetamesh-bionic-chat'), false);
  assert.throws(() => registry.invokeGuard(tool.id), error => error.code === 'TOOL_DISABLED');
  const parentOff = registry.listTools({ pluginId: 'cetamesh-bionic-chat' });
  assert.ok(parentOff.every(row => row.enabled === false), '总开关关闭后所有工具均不可用');
  registry.setPluginEnabled('cetamesh-bionic-chat', true);
  assert.equal(registry.toolState(registry.resolveTool(tool.id)).enabled, true);
  ok('插件总开关：关闭即级联关闭全部工具，重新开启后恢复');

  // ── 7. MCP Server 卡片不提供逐工具开关（避免两套开关互相打架） ─────────────
  assert.throws(() => registry.setToolEnabled('mcp.snowluma', tool.id, false),
    error => error.code === 'TOOL_TOGGLE_UNSUPPORTED');
  ok('MCP Server 卡片：工具列表只读，逐工具开关 TOOL_TOGGLE_UNSUPPORTED');

  // ── 8. 持久化：新进程读同一份状态，开关不丢 ────────────────────────────────
  const reopened = createIntegrationRegistry({
    store: createIntegrationStore({ stateDir: tmp }),
    mcpStatus: () => ({ status: 'running' }),
    integrationStatus: () => ({ enabled: true, available: true })
  });
  reopened.setToolEnabled('cetamesh-bionic-chat', tool.id, false);
  const third = createIntegrationRegistry({
    store: createIntegrationStore({ stateDir: tmp }),
    mcpStatus: () => ({ status: 'running' }),
    integrationStatus: () => ({ enabled: true, available: true })
  });
  assert.equal(third.toolState(third.resolveTool(tool.id)).enabled, false, '开关必须落盘并可重读');
  third.setToolEnabled('cetamesh-bionic-chat', tool.id, true);
  assert.equal(third.toolState(third.resolveTool(tool.id)).enabled, true);
  ok('持久化：逐工具开关经 storage/json-file 落盘，重建 Registry 后仍生效');

  // ── 9. agent 白名单：只含被允许的工具，且不含不可恢复工具 ──────────────────
  const allowlist = registry.agentAllowlist();
  assert.ok(allowlist.tools.length > 0);
  assert.ok(allowlist.tools.every(id => id.startsWith('mcp__') || id.startsWith('agent__')));
  for (const row of legacy) assert.ok(!allowlist.tools.includes(row.id), '不可恢复工具不得进入白名单');
  assert.ok(MCP_STATUSES.includes('crashed'));
  ok('agent 白名单：' + allowlist.tools.length + ' 个工具，排除全部不可恢复项');

  // ── 10. 历史下线条目：有取证、但不进 Registry（不为凑数恢复不存在的工具） ──
  assert.ok(LEGACY_RETIRED_TOOLS.length >= 8, '历史下线条目见 LEGACY_TOOL_INVENTORY.md：' + LEGACY_RETIRED_TOOLS.length);
  for (const row of LEGACY_RETIRED_TOOLS) {
    assert.ok(row.evidence && row.path && row.reason, row.id + ' 必须带取证与理由');
    assert.ok(['deprecated', 'legacy-unsupported'].includes(row.restore), row.id + ' restore 非法');
    assert.equal(row.present, false, row.id + ' 在 HEAD 无实现');
    assert.equal(registry.toolById.has(row.id), false, row.id + ' 不得混入活动 Tools Registry');
    assert.equal(buildToolCatalog().some(tool => tool.id === row.id), false, row.id + ' 不得出现在工具目录');
  }
  ok('历史下线条目 ' + LEGACY_RETIRED_TOOLS.length + ' 个：带 commit/路径取证，且不混入活动 Registry');

  console.log('\nPASS CetaMesh Plugins/Tools Registry（' + step + ' 组断言）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
