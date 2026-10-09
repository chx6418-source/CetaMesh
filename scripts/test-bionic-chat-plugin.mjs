// 产品化任务 B：CetaMesh 仿生聊天插件（总开关 / 逐工具开关 / Capability 强制）验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntegrationService } from '../src/integrations/service.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-chat-'));
let step = 0;
const ok = label => { step += 1; console.log('✅ [' + step + '] ' + label); };

function makeTransportFactory() {
  return () => ({
    pid: 777,
    onClose(handler) { this.closeHandler = handler; },
    async listTools() {
      return [{ name: 'qq_send_group_message', description: 'x', inputSchema: { type: 'object' } }];
    },
    async callTool(name, args) { return { content: [{ type: 'text', text: 'sent:' + name }] }; },
    async close() {}
  });
}

try {
  const service = createIntegrationService({ stateDir: tmp, transportFactory: makeTransportFactory() });
  const PACK = 'cetamesh-bionic-chat';

  // ── 1. 产品层分类：Plugins 下 Installed / Tools / MCP / Integrations ──────
  const overview = await service.execute({ method: 'plugins.overview' });
  assert.deepEqual(overview.categories, ['installed', 'tools', 'mcp', 'integrations']);
  assert.ok(overview.plugins.length >= 8, '插件卡片：1 工具包 + 2 集成 + 5 MCP');
  assert.equal(overview.tools.total, 53);
  assert.equal(overview.mcp.total, 5);
  const toolsCategory = await service.execute({ method: 'plugins.list', params: { category: 'tools' } });
  assert.deepEqual(toolsCategory.plugins.map(plugin => plugin.id), [PACK]);
  const integrationsCategory = await service.execute({ method: 'plugins.list', params: { category: 'integrations' } });
  assert.deepEqual(integrationsCategory.plugins.map(plugin => plugin.id).sort(), ['cetamesh-dsh', 'cetamesh-snowluma']);
  const mcpCategory = await service.execute({ method: 'plugins.list', params: { category: 'mcp' } });
  assert.equal(mcpCategory.plugins.length, 5);
  ok('Plugins 顶层：installed/tools/mcp/integrations 四类；工具包 1 + 集成 2 + MCP 5');

  // ── 2. 插件卡片字段 + 二级设置页（总开关 + 每个工具的名称/用途/权限/状态/开关） ──
  const page = await service.execute({ method: 'plugins.settings', params: { id: PACK } });
  for (const key of ['id', 'name', 'summary', 'version', 'permissions', 'enabled', 'settings', 'toolCount']) {
    assert.ok(Object.hasOwn(page, key), '插件卡片缺少 ' + key);
  }
  assert.equal(page.settings.parentToggle.value, true);
  const toolRow = page.settings.tools.find(row => row.id === 'mcp__snowluma__qq_status');
  for (const key of ['id', 'name', 'group', 'enabled', 'available', 'restore', 'risk']) {
    assert.ok(Object.hasOwn(toolRow, key), '二级设置页工具缺少 ' + key);
  }
  assert.equal(page.settings.advanced.collapsed, true, 'Advanced 默认折叠');
  assert.ok(page.toolCount >= 50);
  ok('插件卡片 + 二级设置页：总开关、' + page.toolCount + ' 个工具逐项开关、Advanced 折叠');

  // ── 3. 父开关级联 + 逐工具开关 + 一键全开/全关 ────────────────────────────
  await service.execute({ method: 'plugins.disable', params: { id: PACK } });
  let list = await service.execute({ method: 'tools.list', params: { pluginId: PACK, enabled: true } });
  assert.equal(list.tools.length, 0, '总开关关闭后没有 enabled 工具');
  await service.execute({ method: 'plugins.enable', params: { id: PACK } });
  list = await service.execute({ method: 'tools.list', params: { pluginId: PACK, enabled: true } });
  assert.ok(list.tools.length > 45);
  const toggled = await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__snowluma__qq_list_stickers', enabled: false } });
  assert.equal(toggled.enabled, false);
  const allOff = await service.execute({ method: 'plugins.tool.toggleAll', params: { pluginId: PACK, enabled: false } });
  assert.equal(allOff.enabledToolCount, 0);
  const allOn = await service.execute({ method: 'plugins.tool.toggleAll', params: { pluginId: PACK, enabled: true } });
  const rows = await service.execute({ method: 'tools.list', params: { pluginId: PACK } });
  const restoredCount = rows.tools.filter(row => row.restore === 'restored').length;
  assert.equal(allOn.enabledToolCount, restoredCount, '一键全开只恢复 restored（安全默认）');
  assert.ok(allOn.tools.filter(row => row.restore !== 'restored').every(row => row.enabled === false),
    'partial / legacy-unsupported 不参与批量开启，必须逐项显式打开');
  assert.ok(restoredCount > 40, '安全默认可恢复工具数量异常：' + restoredCount);
  ok('总开关/逐工具开关/一键全开：级联正确，partial 与 legacy-unsupported 不参与批量开启');

  // ── 4. Capability 强制：关闭的工具、不可用来源、未知工具、外部调用者 ──────
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__snowluma__qq_status', enabled: false } });
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'mcp__snowluma__qq_status' } }),
    error => error.code === 'TOOL_DISABLED');
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__snowluma__qq_status', enabled: true } });
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'mcp__snowluma__qq_status' } }),
    error => error.code === 'TOOL_UNAVAILABLE', 'MCP Server 未运行 → 不假装可调用');
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'mcp__snowluma__qq_nope' } }),
    error => error.code === 'UNKNOWN_TOOL');

  const agentActor = { kind: 'agent', id: 'task:t-1', grants: { capabilities: [], taskIds: [] } };
  await assert.rejects(() => service.broker.execute({
    actor: agentActor, capability: 'integration.tool.read', input: { toolId: 'mcp__snowluma__qq_status' }, reason: 'agent attempt'
  }), error => error.code === 'PERMISSION_DENIED', 'agent 未授权时不得调用工具能力');
  await assert.rejects(() => service.broker.execute({
    actor: { kind: 'external', id: 'stranger' }, capability: 'integration.tool.read', input: { toolId: 'mcp__snowluma__qq_status' }, reason: 'external'
  }), error => error.code === 'PERMISSION_DENIED', 'external 调用者一律拒绝');
  ok('Capability 强制：关闭/不可用/未知工具 + agent 未授权 + external 全部拒绝');

  // ── 5. 高风险工具必须 Owner 逐次审批（发送类） ────────────────────────────
  await service.execute({ method: 'mcp.start', params: { id: 'snowluma', approved: true } });
  const pending = await service.execute({ method: 'tools.invoke', params: { id: 'mcp__snowluma__qq_send_group_message', input: { group_id: 1, text: 'hi' } } });
  assert.equal(pending.status, 'pending', 'high 风险工具未确认 → 进入审批');
  const approvals = service.broker.approvals.list();
  assert.equal(approvals.length, 1);
  const decided = await service.broker.decide({ id: pending.approvalId, approve: true, actor: OWNER_ACTOR });
  assert.equal(decided.status, 'completed');
  assert.match(decided.result.content[0].text, /qq_send_group_message/);
  const approvedInvoke = await service.execute({
    method: 'tools.invoke',
    params: { id: 'mcp__snowluma__qq_send_group_message', input: { group_id: 1, text: 'hi' }, approved: true }
  });
  assert.equal(approvedInvoke.status, 'completed');
  ok('高风险工具：未确认 → pending 审批；审批通过/显式确认后才真正调用（不绕过 Broker）');

  // ── 6. 不可恢复工具不允许开启；MCP 卡片不提供逐工具开关 ───────────────────
  await assert.rejects(() => service.execute({
    method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__snowluma-host__stop_snowluma', enabled: true }
  }), error => error.code === 'LEGACY_UNSUPPORTED');
  await assert.rejects(() => service.execute({
    method: 'plugins.tool.toggle', params: { pluginId: 'mcp.snowluma', toolId: 'mcp__snowluma__qq_status', enabled: false }
  }), error => error.code === 'TOOL_TOGGLE_UNSUPPORTED');
  ok('不可恢复工具禁止开启（LEGACY_UNSUPPORTED）；MCP 卡片逐工具开关不支持');

  // ── 7. 开关落盘并跨实例生效 ──────────────────────────────────────────────
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__snowluma__qq_wait_for_messages', enabled: false } });
  const reopened = createIntegrationService({ stateDir: tmp, transportFactory: makeTransportFactory() });
  const reopenedTool = await reopened.execute({ method: 'tools.get', params: { id: 'mcp__snowluma__qq_wait_for_messages' } });
  assert.equal(reopenedTool.enabled, false, '逐工具开关必须持久化');
  const allowlist = await reopened.execute({ method: 'plugins.allowlist' });
  assert.ok(!allowlist.tools.includes('mcp__snowluma__qq_wait_for_messages'));
  assert.ok(!allowlist.tools.includes('mcp__qq-file-send__qq_send_file'));
  await reopened.close();
  ok('开关持久化：新实例读同一状态目录，逐工具开关与白名单一致');

  await service.close();
  console.log('\nPASS CetaMesh Bionic Chat 插件 + Capability 强制（' + step + ' 组断言）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
