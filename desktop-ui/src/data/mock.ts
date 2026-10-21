import type { AgentView, ChatSessionView, MemoryView, ModelView, PluginView, TaskView, UpdateView } from '../types/views';

export const sessions: ChatSessionView[] = [
  { id: 'launch', title: '修复项目启动失败', preview: '已定位到启动脚本中的路径问题', updatedAt: '刚刚', unread: true },
  { id: 'notes', title: '整理研究资料', preview: '按主题汇总了 12 条资料', updatedAt: '昨天' },
  { id: 'plan', title: '下周产品计划', preview: '列出优先级与待确认事项', updatedAt: '周四' },
  { id: 'ideas', title: '插件中心想法', preview: '如何让能力更容易被发现', updatedAt: '周二' }
];

export const tasks: TaskView[] = [
  { id: 'startup', title: '修复项目启动失败', status: 'waiting', progress: 72, agent: 'Codex', workspace: 'CetaMesh Desktop', lastActivity: '2 分钟前' },
  { id: 'research', title: '整理智能体工作流资料', status: 'working', progress: 46, agent: 'DSH', workspace: '研究资料', lastActivity: '8 分钟前' },
  { id: 'plugin', title: '检查插件权限说明', status: 'completed', progress: 100, agent: 'Codex', workspace: 'CetaMesh Desktop', lastActivity: '昨天' },
  { id: 'notes', title: '汇总会议纪要', status: 'paused', progress: 31, agent: null, workspace: '个人工作区', lastActivity: '周四' }
];

export const agents: AgentView[] = [
  { id: 'dsh', name: 'DSH', role: '通用研究与协作', description: '处理资料、规划和跨工具工作流。', status: 'ready', initials: 'DS' },
  { id: 'codex', name: 'Codex', role: '代码与项目', description: '理解项目、修改代码并检查结果。', status: 'ready', initials: 'Cx' },
  { id: 'zcode', name: 'ZCode', role: '开发辅助', description: '在可用时连接本地开发能力。', status: 'needs-setup', initials: 'Zc' }
];

export const plugins: PluginView[] = [
  { id: 'bionic', name: 'CetaMesh 仿生聊天', summary: '让聊天更自然，按需开启表情、黑话、音乐与卡片能力。', developer: 'CetaMesh', version: '1.0', status: 'installed', category: '创作', kind: 'extension', icon: 'sparkles', permissions: ['聊天工具调用', '按次审批的发送操作'], changelog: '新增工具分组与逐项控制。' },
  { id: 'dsh', name: 'DeepSeek Harness', summary: '连接 DSH 智能体，继续处理复杂任务。', developer: 'DeepSeek', version: '0.2', status: 'installed', category: '连接', kind: 'integration', icon: 'bot', permissions: ['智能体状态', '任务协作'], changelog: '改进桌面状态识别。' },
  { id: 'snowluma', name: 'SnowLuma', summary: '将 CetaMesh 连接到已配置的 QQ 渠道。', developer: 'SnowLuma', version: '1.14', status: 'installed', category: '连接', kind: 'integration', icon: 'plug', permissions: ['渠道连接', '消息收发'], changelog: '适配当前渠道版本。' },
  { id: 'web', name: '网页资料', summary: '从公开网页收集和整理信息。', developer: 'CetaMesh', version: '1.1', status: 'available', category: '效率', kind: 'extension', icon: 'globe', permissions: ['只读网络访问'], changelog: '新增来源预览。' },
  { id: 'studio', name: '创作工作台', summary: '协助整理灵感、草稿和视觉素材。', developer: 'CetaMesh', version: '0.9', status: 'update', category: '创作', kind: 'extension', icon: 'image', permissions: ['工作区文件读取'], changelog: '优化素材卡片。' },
  { id: 'code', name: '项目工具', summary: '在授权的工作区内分析项目结构。', developer: 'CetaMesh', version: '1.0', status: 'available', category: '开发', kind: 'extension', icon: 'code', permissions: ['工作区读取', '按次审批的测试运行'], changelog: '首次发布。' },
  { id: 'music', name: '音乐收藏', summary: '在聊天中整理歌曲和播放列表。', developer: 'CetaMesh', version: '0.7', status: 'available', category: '创作', kind: 'extension', icon: 'music', permissions: ['用户选择的音乐列表'], changelog: '改进列表浏览。' },
  { id: 'mcp', name: 'MCP 连接', summary: '集中查看 MCP 服务器、工具和运行状态。', developer: 'CetaMesh', version: '1.0', status: 'installed', category: '连接', kind: 'integration', icon: 'layers', permissions: ['服务器管理'], changelog: '新增状态与重启入口。' }
];

export const models: ModelView[] = [
  { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'DeepSeek', configured: true },
  { id: 'default', name: '默认模型', provider: 'CetaMesh', configured: false }
];

export const memories: MemoryView[] = [
  { id: 'voice', title: '偏好简洁的说明', summary: '先给结论，再说明关键依据。', category: '偏好', updatedAt: '今天' },
  { id: 'project', title: 'CetaMesh 项目约定', summary: '任务与智能体会话分别管理。', category: '项目', updatedAt: '昨天' },
  { id: 'research', title: '研究资料索引', summary: '整理了近期关注的产品资料。', category: '知识', updatedAt: '周三' }
];

export const update: UpdateView = { currentVersion: '1.0.0-rc.2', latestVersion: null, status: 'unknown' };
