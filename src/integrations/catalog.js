// CetaMesh Tool / MCP 目录（产品化任务 B）。
//
// 事实来源（本仓库 HEAD，禁止凭空创造工具）：
//   - src/mcp-snowluma-safe.js（39 个 qq_* 工具）
//   - src/mcp-qq-file-send.js（5 个文件/音乐工具）
//   - src/mcp-web-search-safe.js（web_search / web_fetch）
//   - src/mcp-bilibili.js（bili_search_video / bili_hot_videos）
//   - src/mcp-host-server.js（snowluma_status / start_snowluma / stop_snowluma）
//   - dsh/agent-presets/whale-chat-v2/qq-tool-restrict.mjs（agent 侧白名单与视觉工具）
//
// restore 结论口径见 TOOLS_MCP_PLUGIN_RESTORATION_REPORT.md。

import { TOOL_CAPABILITIES, capabilityForRisk } from './types.js';

const T = (name, label, risk, description, permissions = [], extra = {}) => ({
  name, label, risk, description, permissions,
  capability: extra.capability ?? capabilityForRisk(risk),
  restore: extra.restore ?? 'restored',
  group: extra.group ?? '其他',
  enabledByDefault: extra.enabledByDefault ?? true,
  ...(extra.reason ? { reason: extra.reason } : {}),
  ...(extra.requiresIntegration ? { requiresIntegration: extra.requiresIntegration } : {})
});

const SEND = ['message.send'];
const NET = ['network'];

export const MCP_SERVER_CATALOG = Object.freeze([
  {
    id: 'snowluma',
    name: 'SnowLuma QQ 网关',
    namespace: 'mcp__snowluma__',
    transport: 'stdio',
    entry: 'src/mcp-snowluma-safe.js',
    source: 'builtin',
    managedBy: 'dsh-preset',
    defaultEnabled: true,
    description: 'QQ 消息读写、发送、表情贴纸、黑话、卡片与社交记忆的安全封装（OneBot/桥接双重白名单）。',
    permissions: [...SEND, 'storage'],
    tools: [
      T('qq_status', '网关状态', 'low', '查询 SnowLuma 网关与 QQ 账号在线状态。', [], { group: '状态' }),
      T('qq_list_groups', '群列表', 'low', '列出机器人已加入的群。', [], { group: '消息读取' }),
      T('qq_get_group_members', '群成员', 'low', '读取指定群成员列表。', [], { group: '消息读取' }),
      T('qq_get_group_history', '群历史', 'low', '读取群历史消息。', [], { group: '消息读取' }),
      T('qq_get_active_members', '活跃成员', 'low', '统计近期活跃成员。', [], { group: '消息读取' }),
      T('qq_get_prompt', '当前提示', 'low', '读取桥接为当前会话注入的提示词。', [], { group: '状态' }),
      T('qq_get_unread_messages', '未读消息', 'low', '拉取当前会话未读消息。', [], { group: '消息读取' }),
      T('qq_get_recent_messages', '最近消息', 'low', '读取当前会话最近消息窗口。', [], { group: '消息读取' }),
      T('qq_get_my_recent_messages', '我的最近发言', 'low', '读取机器人自己最近的发言（用于防止重复）。', [], { group: '消息读取' }),
      T('qq_get_message_detail', '消息详情', 'low', '按消息 id 读取详情与引用链。', [], { group: '消息读取' }),
      T('qq_get_forward_msg', '合并转发', 'low', '解析合并转发消息内容。', [], { group: '消息读取' }),
      T('qq_get_message_images', '消息图片', 'medium', '取出消息中的图片（只读，含本地读盘）。', [], { group: '消息读取' }),
      T('qq_get_self_image', '自画像', 'low', '读取机器人头像等自身图片。', [], { group: '表情贴纸' }),
      T('qq_social_state', '社交状态', 'low', '读取二代社交状态机（观望/活跃/潜水等）。', [], { group: '状态' }),
      T('qq_mark_read', '标记已读', 'medium', '推进会话已读游标。', ['storage'], { group: '消息读取' }),
      T('qq_set_wake_config', '唤醒配置', 'medium', '设置唤醒/潜水参数。', ['storage'], { group: '状态' }),
      T('qq_report_feedback', '反馈上报', 'medium', '上报一条桥接反馈记录。', ['storage'], { group: '状态' }),
      T('qq_slang_query', '黑话查询', 'low', '查询已确认的群聊黑话词条。', [], { group: '黑话' }),
      T('qq_slang_submit', '黑话提交', 'medium', '提交疑似黑话候选（需管理员确认才生效）。', ['storage'], { group: '黑话' }),
      T('qq_memory_append', '记忆写入', 'medium', '向 QQ 社交记忆追加一条记录。', ['storage'], { group: '记忆' }),
      T('qq_memory_query', '记忆查询', 'low', '检索 QQ 社交记忆。', [], { group: '记忆' }),
      T('qq_memory_remove', '记忆删除', 'high', '删除指定社交记忆记录。', ['storage'], { group: '记忆' }),
      T('qq_memory_clear', '记忆清空', 'high', '清空当前会话社交记忆。', ['storage'], { group: '记忆' }),
      T('qq_list_stickers', '贴纸列表', 'low', '列出可用贴纸。', [], { group: '表情贴纸' }),
      T('qq_get_sticker_image', '贴纸图片', 'low', '读取贴纸图片数据。', [], { group: '表情贴纸' }),
      T('qq_sticker_note', '贴纸备注', 'medium', '为贴纸写入用途备注。', ['storage'], { group: '表情贴纸' }),
      T('qq_set_sticker_remark', '贴纸标注', 'high', '改 QQ 官方表情备注（写外部账号）。', ['storage'], {
        group: '表情贴纸', restore: 'partial', enabledByDefault: false,
        reason: '配置安全红线：socialV2.tools.setStickerRemark 默认 false，服务端启动期就不注册；需 Owner 先在服务端显式开启。'
      }),
      T('qq_collect_sticker', '收藏贴纸', 'medium', '收藏一张贴纸。', ['storage'], { group: '表情贴纸' }),
      T('qq_send_sticker', '发送贴纸', 'high', '在群/私聊发送贴纸。', SEND, { group: '消息发送' }),
      T('qq_get_card_msg', '卡片读取', 'low', '读取当前会话的官方机器人卡片（只读，按会话隔离）。', [], { group: '卡片' }),
      T('qq_get_card_button_approval', '卡片审批状态', 'low', '查询与自身会话绑定的脱敏审批状态。', [], { group: '卡片' }),
      T('qq_send_group_message', '群发消息', 'high', '向白名单群发送文本消息。', SEND, { group: '消息发送' }),
      T('qq_reply', '引用回复', 'high', '引用某条消息回复。', SEND, { group: '消息发送' }),
      T('qq_send_private_message', '私聊发送', 'high', '向白名单私聊发送消息。', SEND, { group: '消息发送' }),
      T('qq_send_message', '统一发送', 'high', '按目标类型统一发送消息。', SEND, { group: '消息发送' }),
      T('qq_send_burst', '连发消息', 'high', '一次发送多条消息（分条节流）。', SEND, { group: '消息发送' }),
      T('qq_send_poke', '戳一戳', 'high', '发送戳一戳。', SEND, { group: '消息发送' }),
      T('qq_wait_for_messages', '等待消息', 'low', '长轮询等待新消息（等价 v2-wait）。', [], { group: '消息读取' }),
      T('qq_click_card_button', '卡片按钮', 'critical', '点击官方机器人 Markdown 卡片按钮；高风险写操作，须管理员逐次审批。', SEND, {
        group: '卡片', restore: 'partial', enabledByDefault: false,
        reason: 'RULES 4.2/4.3：服务端默认 clickCardButton=false → 403；开启后仍需逐次审批与指纹校验，故默认关闭。'
      })
    ]
  },
  {
    id: 'qq-file-send',
    name: 'QQ 文件与音乐',
    namespace: 'mcp__qq-file-send__',
    transport: 'stdio',
    entry: 'src/mcp-qq-file-send.js',
    source: 'builtin',
    managedBy: 'dsh-preset',
    defaultEnabled: true,
    description: '本地音乐检索、语音发送与文件发送（含 ffmpeg 增益处理）。',
    permissions: [...SEND, 'filesystem.read', 'filesystem.search'],
    tools: [
      T('qq_send_file', '发送文件', 'critical', '把本地文件发送到群/私聊（读取本地绝对路径并上传）。', ['filesystem.read', ...SEND], {
        group: '文件与音乐', restore: 'partial', enabledByDefault: false,
        reason: '读本地任意路径 + 外发：默认 Disabled，仅 Owner 显式开启后走 integration.tool.admin（high）逐次审批。'
      }),
      T('qq_search_audio', '音乐搜索', 'medium', '联网搜索歌曲（酷狗）。', ['network'], { group: '文件与音乐' }),
      T('qq_send_audio_from_url', '发送网络音频', 'high', '下载并作为语音发送网络音频。', ['network', ...SEND], { group: '文件与音乐' }),
      T('qq_search_local_audio', '本地音频搜索', 'high', '在已配置目录内搜索本地音频。', ['filesystem.search'], { group: '文件与音乐' }),
      T('qq_read_local_audio', '读取本地音频', 'high', '读取本地音频文件（供发送）。', ['filesystem.read'], { group: '文件与音乐' })
    ]
  },
  {
    id: 'web-search-safe',
    name: '安全联网搜索',
    namespace: 'mcp__web-search-safe__',
    transport: 'stdio',
    entry: 'src/mcp-web-search-safe.js',
    source: 'builtin',
    managedBy: 'dsh-preset',
    defaultEnabled: true,
    description: 'SSRF 加固的只读联网搜索与抓取（禁内网/凭据/非 http(s)）。',
    permissions: [...NET, 'web.search'],
    tools: [
      T('web_search', '联网搜索', 'medium', '只读网页搜索，返回标题/摘要/链接。', ['web.search'], { group: '联网' }),
      T('web_fetch', '网页抓取', 'high', '抓取单个 URL 正文（SSRF 加固、限量读取）。', NET, { group: '联网' })
    ]
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    namespace: 'mcp__bilibili__',
    transport: 'stdio',
    entry: 'src/mcp-bilibili.js',
    source: 'builtin',
    managedBy: 'dsh-preset',
    defaultEnabled: true,
    description: 'B 站视频搜索与热门列表（只读，可经 config 关闭）。',
    permissions: [...NET, 'web.search'],
    tools: [
      T('bili_search_video', '视频搜索', 'medium', '搜索 B 站视频。', ['web.search'], { group: '视频' }),
      T('bili_hot_videos', '热门视频', 'low', '读取 B 站热门视频列表。', ['web.search'], { group: '视频' })
    ]
  },
  {
    id: 'snowluma-host',
    name: 'SnowLuma 进程控制',
    namespace: 'mcp__snowluma-host__',
    transport: 'stdio',
    entry: 'src/mcp-host-server.js',
    source: 'builtin',
    managedBy: 'dsh-preset',
    defaultEnabled: true,
    description: 'SnowLuma 网关探活与（受配置限制的）进程启停。',
    permissions: ['process'],
    tools: [
      T('snowluma_status', '网关探活', 'low', 'HTTP 探活 SnowLuma 网关并返回在线状态。', [], { group: '状态' }),
      T('start_snowluma', '启动网关', 'critical', '启动 SnowLuma（launcher.bat）并等待就绪。', ['process'], {
        group: '状态', restore: 'legacy-unsupported', enabledByDefault: false,
        reason: 'process 在 Capability 词表中属于 forbidden；进程控制只能由 Owner 经控制台本地服务入口执行，不作为可开启工具恢复。'
      }),
      T('stop_snowluma', '停止网关', 'critical', '按安装目录匹配进程并结束 SnowLuma。', ['process'], {
        group: '状态', restore: 'legacy-unsupported', enabledByDefault: false,
        reason: '同上：进程控制在能力面之外，防止被 agent/群友诱导触发。'
      })
    ]
  }
]);

/** 由 Agent Provider（DSH）侧提供的内置只读工具：不进 MCP，但属于仿生聊天工具包。 */
export const AGENT_TOOL_CATALOG = Object.freeze([
  {
    id: 'agent',
    name: 'DSH 只读视觉',
    namespace: 'agent__',
    source: 'agent',
    managedBy: 'agent-provider',
    defaultEnabled: true,
    description: 'DSH Agent Provider 提供的只读看图/OCR 工具（无文件系统与命令副作用）。',
    permissions: [],
    tools: [
      T('read_image', '看图', 'low', '只读读取图片内容。', [], {
        group: '视觉', restore: 'partial', enabledByDefault: false,
        reason: '审计结论：仅存在于 qq-tool-restrict 白名单，仓库内无实现、preset 未挂载 provider；确认提供方前不得当作可用工具。'
      }),
      T('describe_image', '描述图片', 'low', '对图片做只读描述/OCR。', [], {
        group: '视觉', restore: 'partial', enabledByDefault: false,
        reason: '同 read_image：白名单死项，需先确认 DSH 侧视觉 provider 是否真实挂载。'
      })
    ]
  }
]);

/**
 * 历史已下线 / 未合并 / 外部包工具（取证见 LEGACY_TOOL_INVENTORY.md）。
 *
 * 这些条目**不进入** Tools Registry（不占 enabled/available，也不会被调用），
 * 只用于产品页的 "Legacy Unsupported / Deprecated" 说明与审计对账——
 * 目的是避免为了"工具数量"凭空恢复仓库里并不存在的工具。
 */
export const LEGACY_RETIRED_TOOLS = Object.freeze([
  {
    id: 'snowluma-mcp.query_action', name: 'query_action', origin: '@snowluma/mcp（外部 npm 包，从未进入 MCP_SERVERS）',
    path: 'scripts/test-mcp-exec.mjs', evidence: '906f919 起（仅测试脚本与 package.json 留痕）',
    feature: '按名字查询 OneBot 动作（通用只读动作）', present: false, restore: 'deprecated',
    reason: '通用 OneBot 动作查询面已退役；不再暴露动态动作名查询入口。',
    replacement: { toolId: 'mcp__snowluma__qq_status', label: 'SnowLuma 安全工具集' }
  },
  {
    id: 'snowluma-mcp.invoke_action', name: 'invoke_action', origin: '@snowluma/mcp（外部 npm 包）',
    path: 'scripts/test-mcp-exec.mjs', evidence: '906f919 起',
    feature: '按名字执行任意 OneBot 写动作', present: false, restore: 'legacy-unsupported',
    reason: '可执行任意 OneBot 动作（含群管理与文件），绕过白名单/只读子集/审批边界，安全原因不可恢复。'
  },
  {
    id: 'cetamesh-task.workspace_list', name: 'cetamesh_task_workspace_list', origin: '侧分支 codex/d1-unified-config-service@9391bb8',
    path: 'dsh/agent-presets/cetamesh-task/task-tools-contract.json', evidence: 'git merge-base --is-ancestor 9391bb8 HEAD = 1',
    feature: '列 Task Workspace 目录', present: false, restore: 'deprecated',
    reason: '未合并进 HEAD；如需恢复应评审后按 workspace.read 能力面重新接线。'
  },
  {
    id: 'cetamesh-task.workspace_read', name: 'cetamesh_task_workspace_read', origin: '侧分支 9391bb8',
    path: 'dsh/agent-presets/cetamesh-task/task-tools-contract.json', evidence: '同上',
    feature: '有界读取 Workspace 内 UTF-8 文件', present: false, restore: 'deprecated',
    reason: '未合并；恢复须绑定 workspace.read + 现有边界检查。'
  },
  {
    id: 'cetamesh-task.workspace_write', name: 'cetamesh_task_workspace_write', origin: '侧分支 9391bb8',
    path: 'dsh/agent-presets/cetamesh-task/task-tools-contract.json', evidence: '同上',
    feature: '审批后创建/覆盖 Workspace 文件', present: false, restore: 'deprecated',
    reason: '未合并；恢复必须保留 Owner 审批（workspace.write = high）。'
  },
  {
    id: 'cetamesh-task.git_status', name: 'cetamesh_task_git_status', origin: '侧分支 9391bb8',
    path: 'dsh/agent-presets/cetamesh-task/task-tools-contract.json', evidence: '同上',
    feature: 'Workspace git status（只读）', present: false, restore: 'deprecated',
    reason: '未合并；该历史工具不属于当前工具包目录。'
  },
  {
    id: 'cetamesh-task.git_diff', name: 'cetamesh_task_git_diff', origin: '侧分支 9391bb8',
    path: 'dsh/agent-presets/cetamesh-task/task-tools-contract.json', evidence: '同上',
    feature: 'Workspace git diff（只读）', present: false, restore: 'deprecated',
    reason: '未合并；恢复须沿用敏感路径抑制。'
  },
  {
    id: 'cetamesh-task.process_run', name: 'cetamesh_task_process_run', origin: '侧分支 9391bb8',
    path: 'dsh/agent-presets/cetamesh-task/task-tools-contract.json', evidence: '同上',
    feature: '在 Workspace 执行进程（历史设计为显式审批）', present: false, restore: 'legacy-unsupported',
    reason: 'process 在 src/capability/types.js 属 FORBIDDEN_PERMISSIONS；与现有能力面冲突，不可按旧设计恢复。'
  }
]);

export function toolIdFor(namespace, name) {
  return namespace + name;
}

/** 全部 MCP/Agent 工具（含来源与 id），供 Tools Registry 使用。 */
export function buildToolCatalog() {
  const rows = [];
  for (const server of [...MCP_SERVER_CATALOG, ...AGENT_TOOL_CATALOG]) {
    for (const tool of server.tools) {
      rows.push(Object.freeze({
        id: toolIdFor(server.namespace, tool.name),
        name: tool.name,
        label: tool.label,
        description: tool.description,
        // Tool Source 语义：mcp = 由 MCP Server 提供；agent = 由 Agent Provider 提供。
        // origin 记录"随产品内置"还是"外部安装"，与 source 分离。
        source: server.source === 'agent' ? 'agent' : 'mcp',
        origin: server.source,
        serverId: server.id,
        namespace: server.namespace,
        group: tool.group,
        schema: { type: 'object' },
        risk: tool.risk,
        capability: tool.capability,
        permissions: Object.freeze([...(tool.permissions ?? [])]),
        restore: tool.restore,
        reason: tool.reason ?? null,
        enabledByDefault: tool.enabledByDefault,
        requiresIntegration: tool.requiresIntegration ?? null
      }));
    }
  }
  return Object.freeze(rows);
}

export function pluginDescriptors() {
  const bionicToolIds = buildToolCatalog().map(tool => tool.id);
  return [
    {
      id: 'cetamesh-bionic-chat',
      name: 'CetaMesh 仿生聊天',
      kind: 'tool-pack',
      category: 'tools',
      version: '1.0.0',
      summary: '把 QQ 仿生聊天用过、且现在仍然存在的 MCP/内置工具收进一个可总开关、可逐项开关的工具包。',
      permissions: ['message.send', 'filesystem.read', 'network', 'storage'],
      defaultEnabled: true,
      toolIds: bionicToolIds,
      advanced: {
        note: '单个工具开关只影响"是否允许调用"；是否真的可用还取决于对应 MCP Server 是否运行。',
        groups: [...new Set(buildToolCatalog().map(tool => tool.group))]
      }
    },
    {
      id: 'cetamesh-snowluma',
      name: 'SnowLuma 集成',
      kind: 'channel-integration',
      category: 'integrations',
      version: '1.0.0',
      summary: 'QQ 通道提供方（Channel Provider）。插件页只做安装/配置/启动/状态/说明的统一入口，底层仍是 Channel Provider。',
      permissions: ['message.send'],
      defaultEnabled: true,
      provider: { kind: 'channel', id: 'qq' },
      localService: 'snowluma',
      toolIds: [],
      advanced: {
        note: '不把 QQ SDK / 协议实现搬进插件；插件启停不改变 Channel Provider 架构。',
        providerKind: 'channel-provider'
      }
    },
    {
      id: 'cetamesh-dsh',
      name: 'DeepSeek Harness',
      kind: 'agent-integration',
      category: 'integrations',
      version: '0.1.1-rc.2',
      summary: 'Desktop App 与 Agent Provider 分别检测；插件页负责状态、启动与设置入口，Agent Provider 继续由 Agent Broker 调度。',
      permissions: ['agent.run'],
      defaultEnabled: true,
      provider: { kind: 'agent', id: 'dsh' },
      localService: 'dsh',
      icon: 'deepseek-harness',
      settingsRoute: 'agents.dsh',
      toolIds: AGENT_TOOL_CATALOG.flatMap(server => server.tools.map(tool => toolIdFor(server.namespace, tool.name))),
      advanced: {
        note: 'DSH 仍是 Agent Provider；插件层只是入口，模型/会话/工具链仍由 Agent Broker 管理。',
        providerKind: 'agent-provider'
      }
    }
  ];
}

export function mcpServerPlugins() {
  return MCP_SERVER_CATALOG.map(server => ({
    id: 'mcp.' + server.id,
    name: server.name,
    kind: 'mcp-server',
    category: 'mcp',
    version: '1.0.0',
    summary: server.description,
    permissions: [...(server.permissions ?? [])],
    defaultEnabled: server.defaultEnabled !== false,
    mcpServerId: server.id,
    toolIds: server.tools.map(tool => toolIdFor(server.namespace, tool.name)),
    advanced: {
      transport: server.transport,
      entry: server.entry,
      managedBy: server.managedBy,
      namespace: server.namespace
    }
  }));
}

export function allPluginDescriptors() {
  return [...pluginDescriptors(), ...mcpServerPlugins()];
}

export { TOOL_CAPABILITIES };
