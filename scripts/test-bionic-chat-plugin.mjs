// 产品化任务 B：CetaMesh 仿生聊天插件（总开关 / 逐工具开关 / Capability 强制）验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntegrationService } from '../src/integrations/service.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
import { buildToolCatalog, LEGACY_RETIRED_TOOLS } from '../src/integrations/catalog.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { isBionicChatEnabled, isQqConnectorEnabled } from '../src/integrations/tool-policy.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bionic-chat-'));
let step = 0;
const ok = label => { step += 1; console.log('✅ [' + step + '] ' + label); };

function makeTransportFactory() {
  return () => ({
    pid: 777,
    onClose(handler) { this.closeHandler = handler; },
    async listTools() {
      return [{ name: 'qq_send_group_message', description: 'x', inputSchema: {
        type: 'object', properties: {group_id:{type:'integer',minimum:1},text:{type:'string',minLength:1,maxLength:4000}},
        required:['group_id','text'],additionalProperties:false
      } }];
    },
    async callTool(name, args) { return { content: [{ type: 'text', text: 'sent:' + name }] }; },
    async close() {}
  });
}

try {
  const service = createIntegrationService({ stateDir: tmp, transportFactory: makeTransportFactory() });
  const PACK = 'cetamesh-bionic-chat';
  assert.equal(isBionicChatEnabled({ stateDir: tmp }), false, 'fresh Bionic starts disabled');
  assert.equal(isQqConnectorEnabled({ stateDir: tmp }), false, 'fresh OneBot starts disabled');
  assert.equal(service.registry.serverEnabled('onebot'), false);
  await service.execute({ method: 'plugins.enable', params: { id: PACK } });
  await service.execute({ method: 'plugins.enable', params: { id: 'cetamesh-onebot' } });
  await service.execute({ method: 'mcp.enable', params: { id: 'onebot', approved: true } });
  await service.execute({ method: 'plugins.disable', params: { id: PACK } });
  assert.equal(isBionicChatEnabled({ stateDir: tmp }), false, 'disabled Bionic must not receive QQ events');
  await service.execute({ method: 'plugins.enable', params: { id: PACK } });
  assert.equal(isQqConnectorEnabled({ stateDir: tmp }), true);
  await service.execute({ method: 'plugins.disable', params: { id: 'cetamesh-onebot' } });
  assert.equal(isQqConnectorEnabled({ stateDir: tmp }), false, 'QQ disabled while Bionic remains configured');
  assert.equal(isBionicChatEnabled({ stateDir: tmp }), true, 'Bionic toggle remains independent of QQ transport');
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: {
    id: 'mcp__onebot__qq_send_group_message', input: { group_id: 1, text: 'blocked' }
  } }), { code: 'QQ_DISABLED' });
  await service.execute({ method: 'plugins.enable', params: { id: 'cetamesh-onebot' } });
  const sourceTools = buildToolCatalog();
  const expectedByNamespace = {
    mcp__onebot__: [
      'qq_status', 'qq_list_groups', 'qq_get_group_members', 'qq_get_group_history', 'qq_get_active_members',
      'qq_get_prompt', 'qq_get_unread_messages', 'qq_get_recent_messages', 'qq_get_my_recent_messages',
      'qq_get_message_detail', 'qq_get_forward_msg', 'qq_get_message_images', 'qq_get_self_image', 'qq_social_state',
      'qq_mark_read', 'qq_set_wake_config', 'qq_report_feedback', 'qq_slang_query', 'qq_slang_submit',
      'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear', 'qq_list_stickers',
      'qq_get_sticker_image', 'qq_sticker_note', 'qq_set_sticker_remark', 'qq_collect_sticker', 'qq_send_sticker',
      'qq_get_card_msg', 'qq_get_card_button_approval', 'qq_send_group_message', 'qq_reply', 'qq_send_private_message',
      'qq_send_message', 'qq_send_burst', 'qq_send_poke', 'qq_wait_for_messages', 'qq_click_card_button'
    ],
    'mcp__qq-file-send__': ['qq_send_file', 'qq_search_audio', 'qq_send_audio_from_url', 'qq_search_local_audio', 'qq_read_local_audio'],
    'mcp__web-search-safe__': ['web_search', 'web_fetch'],
    mcp__bilibili__: ['bili_search_video', 'bili_hot_videos'],
    agent__: ['read_image', 'describe_image']
  };
  const expectedToolIds = Object.entries(expectedByNamespace).flatMap(([namespace, names]) => names.map(name => namespace + name));
  assert.deepEqual(sourceTools.map(tool => tool.id).sort(), expectedToolIds.sort(), 'exact 50-tool neutral inventory excludes all retired host tools');
  assert.equal(sourceTools.filter(tool => tool.restore === 'restored').length, 45);
  assert.equal(sourceTools.filter(tool => tool.restore === 'partial').length, 5);
  assert.equal(sourceTools.filter(tool => tool.restore === 'legacy-unsupported').length, 0);
  assert.equal(LEGACY_RETIRED_TOOLS.filter(tool => tool.restore === 'deprecated').length, 6);
  assert.equal(LEGACY_RETIRED_TOOLS.filter(tool => tool.restore === 'legacy-unsupported').length, 2);

  // ── 1. 产品层分类：Plugins 下 Installed / Tools / MCP / Integrations ──────
  const overview = await service.execute({ method: 'plugins.overview' });
  assert.deepEqual(overview.categories, ['installed', 'tools', 'mcp', 'integrations']);
  assert.deepEqual(overview.plugins.map(plugin => plugin.id).sort(),
    ['cetamesh-bionic-chat', 'cetamesh-dsh', 'cetamesh-onebot', 'mcp.bilibili', 'mcp.onebot', 'mcp.qq-file-send', 'mcp.remote', 'mcp.web-search-safe']);
  assert.equal(overview.tools.total, 50);
  assert.equal(overview.mcp.total, 5, 'Four built-in stdio servers plus one disabled remote slot');
  const toolsCategory = await service.execute({ method: 'plugins.list', params: { category: 'tools' } });
  assert.deepEqual(toolsCategory.plugins.map(plugin => plugin.id), [PACK]);
  const integrationsCategory = await service.execute({ method: 'plugins.list', params: { category: 'integrations' } });
  assert.deepEqual(integrationsCategory.plugins.map(plugin => plugin.id).sort(), ['cetamesh-dsh', 'cetamesh-onebot']);
  const mcpCategory = await service.execute({ method: 'plugins.list', params: { category: 'mcp' } });
  assert.equal(mcpCategory.plugins.filter(plugin=>plugin.advanced.transport==='stdio').length, 4);
  const remote=mcpCategory.plugins.find(plugin=>plugin.id==='mcp.remote');assert.equal(remote.enabled,false);assert.equal(remote.status.callable,false);assert.equal(remote.advanced.transport,'streamable-http');
  ok('Plugins 顶层：installed/tools/mcp/integrations 四类；工具包 1 + 集成 2 + MCP 4 stdio + disabled remote');

  // ── 2. 插件卡片字段 + 二级设置页（总开关 + 每个工具的名称/用途/权限/状态/开关） ──
  const page = await service.execute({ method: 'plugins.settings', params: { id: PACK } });
  for (const key of ['id', 'name', 'summary', 'version', 'permissions', 'enabled', 'settings', 'toolCount']) {
    assert.ok(Object.hasOwn(page, key), '插件卡片缺少 ' + key);
  }
  assert.equal(page.settings.parentToggle.value, true);
  const toolRow = page.settings.tools.find(row => row.id === 'mcp__onebot__qq_status');
  for (const key of ['id', 'name', 'group', 'enabled', 'available', 'restore', 'risk']) {
    assert.ok(Object.hasOwn(toolRow, key), '二级设置页工具缺少 ' + key);
  }
  assert.equal(page.settings.advanced.collapsed, true, 'Advanced 默认折叠');
  assert.equal(page.toolCount, 50);
  ok('插件卡片 + 二级设置页：总开关、' + page.toolCount + ' 个工具逐项开关、Advanced 折叠');
  const harborUi = createDesktopUiService({ services: { integrationService: service } });
  const harborSettings = await harborUi.execute({ method: 'ui.plugins.integration.settings', params: { id: PACK } });
  assert.deepEqual(harborSettings.inventory, { restored: 45, partial: 5, legacyUnsupported: 0 });
  const harborPartial = harborSettings.tools.find(tool => tool.id === 'mcp__onebot__qq_click_card_button');
  assert.equal(harborPartial.restore, 'partial');
  assert.equal(harborPartial.restorable, true, 'partial tools remain explicitly toggleable');
  assert.equal(harborPartial.available, false, 'MCP availability is distinct from toggle eligibility');
  assert.equal(harborSettings.tools.some(tool => tool.id.startsWith('mcp__snowluma-host__')), false,
    'retired host tools are excluded from active inventory');
  assert.equal(harborSettings.legacyRetired.length, 8);
  assert.equal(harborSettings.legacyRetired.filter(tool => tool.restore === 'deprecated').length, 6);
  const retiredQuery = harborSettings.legacyRetired.find(tool => tool.id === 'snowluma-mcp.query_action');
  assert.equal(retiredQuery.restore, 'deprecated');
  assert.equal(retiredQuery.replacement, null, 'retired SnowLuma IDs never map implicitly to new OneBot tools');
  assert.ok(harborSettings.legacyRetired.every(tool => !tool.replacement
    || harborSettings.tools.some(current => current.id === tool.replacement.id)),
    'any displayed replacement must resolve to an active registered tool');
  const enabledPartial = await harborUi.execute({ method: 'ui.plugins.integration.tool.toggle', params: {
    pluginId: PACK, toolId: harborPartial.id, enabled: true
  } });
  assert.equal(enabledPartial.enabled, true);
  const refreshedPartial = (await harborUi.execute({ method: 'ui.plugins.integration.settings', params: { id: PACK } })).tools
    .find(tool => tool.id === harborPartial.id);
  assert.equal(refreshedPartial.enabled, true);
  assert.equal(refreshedPartial.available, false, 'enabling a partial tool does not claim its source is ready');
  await harborUi.execute({ method: 'ui.plugins.integration.tool.toggle', params: {
    pluginId: PACK, toolId: harborPartial.id, enabled: false
  } });

  // ── 3. 父开关级联 + 逐工具开关 + 一键全开/全关 ────────────────────────────
  await service.execute({ method: 'plugins.disable', params: { id: PACK } });
  let list = await service.execute({ method: 'tools.list', params: { pluginId: PACK, enabled: true } });
  assert.equal(list.tools.length, 0, '总开关关闭后没有 enabled 工具');
  await service.execute({ method: 'plugins.enable', params: { id: PACK } });
  list = await service.execute({ method: 'tools.list', params: { pluginId: PACK, enabled: true } });
  assert.equal(list.tools.length, 45);
  const toggled = await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__onebot__qq_list_stickers', enabled: false } });
  assert.equal(toggled.enabled, false);
  const allOff = await service.execute({ method: 'plugins.tool.toggleAll', params: { pluginId: PACK, enabled: false } });
  assert.equal(allOff.enabledToolCount, 0);
  const allOn = await service.execute({ method: 'plugins.tool.toggleAll', params: { pluginId: PACK, enabled: true } });
  const rows = await service.execute({ method: 'tools.list', params: { pluginId: PACK } });
  const restoredCount = rows.tools.filter(row => row.restore === 'restored').length;
  assert.equal(allOn.enabledToolCount, restoredCount, '一键全开只恢复 restored（安全默认）');
  assert.ok(allOn.tools.filter(row => row.restore !== 'restored').every(row => row.enabled === false),
    'partial / legacy-unsupported 不参与批量开启，必须逐项显式打开');
  assert.equal(restoredCount, 45);
  assert.equal(rows.tools.filter(row => row.restore === 'partial').length, 5);
  assert.equal(rows.tools.filter(row => row.restore === 'legacy-unsupported').length, 0);
  ok('总开关/逐工具开关/一键全开：级联正确，partial 与 legacy-unsupported 不参与批量开启');

  // ── 4. Capability 强制：关闭的工具、不可用来源、未知工具、外部调用者 ──────
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__onebot__qq_status', enabled: false } });
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'mcp__onebot__qq_status' } }),
    error => error.code === 'TOOL_DISABLED');
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__onebot__qq_status', enabled: true } });
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'mcp__onebot__qq_status' } }),
    error => error.code === 'TOOL_UNAVAILABLE', 'MCP Server 未运行 → 不假装可调用');
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'mcp__onebot__qq_nope' } }),
    error => error.code === 'UNKNOWN_TOOL');

  const agentActor = { kind: 'agent', id: 'task:t-1', grants: { capabilities: [], taskIds: [] } };
  await assert.rejects(() => service.broker.execute({
    actor: agentActor, capability: 'integration.tool.read', input: { toolId: 'mcp__onebot__qq_status' }, reason: 'agent attempt'
  }), error => error.code === 'PERMISSION_DENIED', 'agent 未授权时不得调用工具能力');
  await assert.rejects(() => service.broker.execute({
    actor: { kind: 'external', id: 'stranger' }, capability: 'integration.tool.read', input: { toolId: 'mcp__onebot__qq_status' }, reason: 'external'
  }), error => error.code === 'PERMISSION_DENIED', 'external 调用者一律拒绝');
  ok('Capability 强制：关闭/不可用/未知工具 + agent 未授权 + external 全部拒绝');

  // ── 5. 高风险工具必须 Owner 逐次审批（发送类） ────────────────────────────
  await service.execute({ method: 'mcp.start', params: { id: 'onebot', approved: true } });
  await assert.rejects(service.execute({method:'tools.invoke',params:{id:'mcp__onebot__qq_send_group_message',
    input:{group_id:1,text:'hi',unknown:true}}}),{code:'TOOL_ARGUMENTS_INVALID'});
  assert.equal(service.broker.approvals.list().length,0,'invalid target input creates no approval');
  const pending = await service.execute({ method: 'tools.invoke', params: { id: 'mcp__onebot__qq_send_group_message', input: { group_id: 1, text: 'hi' } } });
  assert.equal(pending.status, 'pending', 'high 风险工具未确认 → 进入审批');
  const approvals = service.broker.approvals.list();
  assert.equal(approvals.length, 1);
  const decided = await service.broker.decide({ id: pending.approvalId, approve: true, actor: OWNER_ACTOR });
  assert.equal(decided.status, 'completed');
  assert.match(decided.result.content[0].text, /qq_send_group_message/);
  const approvedInvoke = await service.execute({
    method: 'tools.invoke',
    params: { id: 'mcp__onebot__qq_send_group_message', input: { group_id: 1, text: 'hi' }, approved: true }
  });
  assert.equal(approvedInvoke.status, 'completed');
  ok('高风险工具：未确认 → pending 审批；审批通过/显式确认后才真正调用（不绕过 Broker）');

  // ── 6. 不可恢复工具不允许开启；MCP 卡片不提供逐工具开关 ───────────────────
  await assert.rejects(() => service.execute({
    method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__snowluma-host__stop_snowluma', enabled: true }
  }), error => error.code === 'SNOWLUMA_INTEGRATION_RETIRED');
  await assert.rejects(() => service.execute({
    method: 'plugins.tool.toggle', params: { pluginId: 'mcp.onebot', toolId: 'mcp__onebot__qq_status', enabled: false }
  }), error => error.code === 'TOOL_TOGGLE_UNSUPPORTED');
  ok('退役host工具禁止开启（SNOWLUMA_INTEGRATION_RETIRED）；MCP 卡片逐工具开关不支持');

  // ── 7. 开关落盘并跨实例生效 ──────────────────────────────────────────────
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: PACK, toolId: 'mcp__onebot__qq_wait_for_messages', enabled: false } });
  const reopened = createIntegrationService({ stateDir: tmp, transportFactory: makeTransportFactory() });
  const reopenedTool = await reopened.execute({ method: 'tools.get', params: { id: 'mcp__onebot__qq_wait_for_messages' } });
  assert.equal(reopenedTool.enabled, false, '逐工具开关必须持久化');
  const allowlist = await reopened.execute({ method: 'plugins.allowlist' });
  assert.ok(!allowlist.tools.includes('mcp__onebot__qq_wait_for_messages'));
  assert.ok(!allowlist.tools.includes('mcp__qq-file-send__qq_send_file'));
  await reopened.close();
  ok('开关持久化：新实例读同一状态目录，逐工具开关与白名单一致');

  await service.close();
  console.log('\nPASS CetaMesh Bionic Chat 插件 + Capability 强制（' + step + ' 组断言）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
