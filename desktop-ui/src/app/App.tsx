import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { bridge, openExternal } from '../bridge/client';
import { Icon } from '../components/icons';
import { Button, IconButton, Input, SearchInput, Tabs } from '../components/primitives/inputs';
import { Sheet } from '../components/primitives/overlays';
import { Badge, Banner, Card, Divider, Surface } from '../components/primitives/surfaces';
import { AgentCard, ArtifactCard, MemoryReference, PluginCard, TaskCard, UpdateCard } from '../components/product/cards';
import { AgentActivity, ApprovalCard, ChatComposer, ChatMessage, ToolCallCard } from '../components/product/chat';
import { agents, memories, plugins, sessions, tasks, update } from '../data/mock';
import type { AboutView, PluginView } from '../types/views';
import { useUi } from '../stores/ui';
import './app.css';

const directions = [
  { id: 'harbor', name: 'Harbor', subtitle: '熟悉的多栏工作台', intent: '把会话、任务和上下文放在一处，适合日常连续工作。', signal: '平衡 / 稳定 / 清晰' },
  { id: 'orbit', name: 'Orbit', subtitle: '轻量空间导航', intent: '减少常驻界面，把关注点留给当前任务。', signal: '轻盈 / 安静 / 专注' },
  { id: 'command', name: 'Command', subtitle: '键盘效率中心', intent: '把搜索、快捷操作和运行状态放到工作流前面。', signal: '快捷 / 紧凑 / 可控' },
  { id: 'canvas', name: 'Canvas', subtitle: '开放式创作画布', intent: '使用柔和画布与浮层，让内容和思考拥有更多空间。', signal: '开放 / 温和 / 编辑感' },
  { id: 'flow', name: 'Flow', subtitle: '任务运行驾驶舱', intent: '以正在运行的任务、Agent 和审批状态组织信息。', signal: '状态 / 协作 / 可追踪' }
] as const;

const navigation = [
  { id: 'chat', label: 'Chat', icon: 'chat', hint: '会话与工具执行' },
  { id: 'work', label: 'Work', icon: 'work', hint: '任务与工作区' },
  { id: 'agents', label: 'Agents', icon: 'agents', hint: 'Agent 状态与能力' },
  { id: 'plugins', label: 'Plugins', icon: 'plugins', hint: '插件与集成' },
  { id: 'settings', label: 'Settings', icon: 'settings', hint: '外观与偏好' },
  { id: 'about', label: 'About', icon: 'help', hint: '版本与项目' }
] as const;

type DirectionId = typeof directions[number]['id'];
type PageId = typeof navigation[number]['id'];

function getDirection(value: string | null) { return directions.find((direction) => direction.id === value); }
function getPage(value: string | null): PageId { return navigation.some((page) => page.id === value) ? value as PageId : 'chat'; }

export function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const direction = getDirection(searchParams.get('direction'));
  const page = getPage(searchParams.get('page'));
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const [activeSessionId, setActiveSessionId] = useState(sessions[0].id);
  const [hostStatus, setHostStatus] = useState<'preview' | 'checking' | 'ready' | 'offline'>(window.ipc ? 'checking' : 'preview');
  const [about, setAbout] = useState<AboutView>({ version: '1.0.0-rc.2', buildId: 'UX-v2-exploration', developer: 'CetaMesh Team', website: null, gitcode: 'https://gitcode.com/ygdnn/CetaMesh', github: 'https://github.com/chx6418-source/whalebridge' });

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (!window.ipc) return;
    const unsubscribe = bridge.subscribe('core.status', ({ ready }) => setHostStatus(ready ? 'ready' : 'offline'));
    void bridge.invoke('app.status', {}).then((status) => setHostStatus(status.ready ? 'ready' : 'offline')).catch(() => setHostStatus('offline'));
    void bridge.invoke('app.about', {}).then((result) => setAbout((current) => ({ ...current, ...result }))).catch(() => { /* Keep the safe demo projection if Core About is not yet available. */ });
    return unsubscribe;
  }, []);

  function navigate(changes: { direction?: DirectionId | null; page?: PageId }) {
    const next = new URLSearchParams(searchParams);
    if ('direction' in changes) {
      if (changes.direction) next.set('direction', changes.direction);
      else next.delete('direction');
      next.set('page', changes.page ?? 'chat');
    }
    if (changes.page) next.set('page', changes.page);
    setSearchParams(next);
  }

  if (!direction) return <DirectionPicker onChoose={(id) => navigate({ direction: id })} />;
  return <div className={`app-shell direction-${direction.id}`} data-direction={direction.id}>
    <aside className="app-sidebar">
      <div className="brand-lockup"><span className="brand-mark"><Icon name="sparkles" size={19} /></span><span className="brand-copy"><strong>CetaMesh</strong><small>Desktop · UX v2</small></span><button className="prototype-chip" onClick={() => navigate({ direction: null })} title="切换设计方向">原型</button></div>
      <div className="workspace-switch"><span className="workspace-avatar">CM</span><span><strong>个人工作区</strong><small>本地工作区</small></span><Icon name="down" size={14} /></div>
      <nav aria-label="主导航" className="primary-nav">
        <span className="nav-label">工作空间</span>
        {navigation.slice(0, 4).map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate({ page: item.id })} title={item.hint}><Icon name={item.icon} size={17} /><span>{item.label}</span>{item.id === 'work' && <small className="nav-count">4</small>}</button>)}
      </nav>
      {page === 'chat' && <section className="session-section" aria-label="最近会话"><div className="session-heading"><span className="nav-label">最近会话</span><IconButton label="新建会话" icon="add" compact /></div><div className="session-list">{sessions.map((session) => <button className={`session-item ${activeSessionId === session.id ? 'selected' : ''}`} key={session.id} onClick={() => setActiveSessionId(session.id)} aria-current={activeSessionId === session.id ? 'page' : undefined}><span className="session-unread" aria-hidden="true">{session.unread ? '•' : ''}</span><span><strong>{session.title}</strong><small>{session.preview}</small></span><time>{session.updatedAt}</time></button>)}</div><button className="all-sessions">查看全部会话 <Icon name="right" size={13} /></button></section>}
      <div className="sidebar-bottom"><div className="host-indicator"><span className={`host-dot ${hostStatus}`} /><span>{hostStatus === 'preview' ? '浏览器预览' : hostStatus === 'checking' ? '连接桌面主机' : hostStatus === 'ready' ? '桌面服务已连接' : '桌面服务离线'}</span><button title="主机状态详情"><Icon name="more" size={15} /></button></div><Divider /><div className="utility-nav">{navigation.slice(4).map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate({ page: item.id })}><Icon name={item.icon} size={17} /><span>{item.label}</span></button>)}</div><button className="profile-row"><span className="profile-avatar">林</span><span><strong>本地用户</strong><small>个人空间</small></span><Icon name="more" size={16} /></button></div>
    </aside>
    <main className="app-main">
      <header className="topbar"><div className="breadcrumb"><span>{page === 'chat' ? '会话' : navigation.find((item) => item.id === page)?.label}</span><Icon name="right" size={13} /><strong>{pageTitle(page)}</strong></div><div className="topbar-actions"><label className="global-search"><Icon name="search" size={15} /><Input aria-label="全局搜索" placeholder="搜索会话、任务或插件" /><kbd>⌘ K</kbd></label><span className={`top-host-status ${hostStatus}`}><i />{hostStatus === 'ready' ? '已连接' : hostStatus === 'preview' ? '预览模式' : hostStatus === 'offline' ? '未连接' : '连接中'}</span><IconButton label="切换主题" icon={theme === 'dark' ? 'moon' : 'sun'} onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')} /></div></header>
      <div className={`page-frame page-${page}`}>
        {page === 'chat' && <ChatPage sessionId={activeSessionId} />}
        {page === 'work' && <WorkPage onOpenChat={() => navigate({ page: 'chat' })} />}
        {page === 'agents' && <AgentsPage />}
        {page === 'plugins' && <PluginsPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'about' && <AboutPage about={about} />}
      </div>
    </main>
    <footer className="prototype-footer"><span>{direction.name}</span><span>·</span><span>{direction.subtitle}</span><span className="grow" /><span>UX v2 探索稿 · 数据为演示内容</span></footer>
  </div>;
}

function pageTitle(page: PageId) { return page === 'chat' ? '项目启动失败排查' : navigation.find((item) => item.id === page)?.label ?? 'CetaMesh'; }

function DirectionPicker({ onChoose }: { onChoose(id: DirectionId): void }) {
  return <main className="direction-picker"><header className="picker-top"><div className="brand-lockup"><span className="brand-mark"><Icon name="sparkles" size={19} /></span><span className="brand-copy"><strong>CetaMesh</strong><small>Desktop · UX v2</small></span></div><Badge tone="accent">探索阶段</Badge></header><section className="picker-intro"><p className="eyebrow">DESKTOP UX EXPLORATION</p><h1>选择一个工作方式，<br /><em>开始体验。</em></h1><p>五套独立的导航与信息布局，共用同一套组件、任务状态和本地安全边界。选择方向后可随时切换。</p></section><div className="direction-grid">{directions.map((direction, index) => <button key={direction.id} className={`direction-card direction-${direction.id}`} onClick={() => onChoose(direction.id)}><div className="direction-preview"><span className="preview-sidebar" /><span className="preview-panel"><i /><i /><i /></span><span className="preview-aside" /></div><div className="direction-card-meta"><span className="direction-index">0{index + 1}</span><span className="direction-signal">{direction.signal}</span></div><h2>{direction.name}<span>{direction.subtitle}</span></h2><p>{direction.intent}</p><span className="direction-cta">查看原型 <Icon name="right" size={15} /></span></button>)}</div><p className="picker-note"><Icon name="shield" size={14} /> 所有原型使用本地演示数据，不会发起真实工具执行或插件安装。</p></main>;
}

function ChatPage({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<{ id: string; role: 'user' | 'assistant'; text: string }[]>([{ id: 'assistant-intro', role: 'assistant', text: '我检查了项目启动配置，发现入口脚本引用了已移动的文件。先确认当前分支上的目录结构，再决定最小修复范围。' }]);
  const streamRef = useRef<HTMLDivElement>(null);
  const currentSession = sessions.find((session) => session.id === sessionId) ?? sessions[0];
  useEffect(() => { if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight; }, [messages, sessionId]);
  return <div className="chat-workspace"><section className="conversation-pane"><div className="conversation-toolbar"><div><p className="eyebrow">CETAMESH · CHAT</p><h1>{currentSession.title}</h1><div className="conversation-meta"><Badge tone="accent">Codex · 执行中</Badge><span>更新于 2 分钟前</span><span>·</span><span>CetaMesh Desktop</span></div></div><div className="row"><IconButton label="分享会话" icon="file" /><IconButton label="更多会话操作" icon="more" /></div></div><div className="message-stream" ref={streamRef}><div className="date-marker"><span>今天 · 10:42</span></div><ChatMessage role="user" time="10:42" text="帮我定位启动失败的原因，先检查配置和入口文件。" />{messages.map((message) => <ChatMessage key={message.id} role={message.role} time="10:43" text={message.text} />)}<ToolCallCard /><AgentActivity /><ApprovalCard /></div><div className="composer-dock"><ChatComposer onSend={(text) => setMessages((previous) => [...previous, { id: `user-${Date.now()}`, role: 'user' as const, text }, { id: `assistant-${Date.now()}`, role: 'assistant' as const, text: '收到。这是一个交互预览，消息暂存在当前页面，没有提交到 Core。' }])} /></div></section><aside className="chat-context"><div className="context-heading"><div><p className="eyebrow">运行上下文</p><h2>任务详情</h2></div><IconButton label="收起上下文" icon="sliders" /></div><Card className="context-task"><div className="row between"><Badge tone="warning">等待审批</Badge><Icon name="work" size={16} /></div><h3>修复项目启动失败</h3><p>检查入口脚本、依赖和最近的配置变更。</p><div className="context-progress"><span className="progress-width-72" /></div><div className="row between"><small>执行进度</small><small>72%</small></div><Divider /><div className="context-agent"><span className="agent-avatar">Cx</span><span className="grow"><strong>Codex</strong><small>正在检查 package.json</small></span><Badge tone="success">在线</Badge></div></Card><Surface className="context-section"><div className="section-heading"><h3>能力</h3><Button compact variant="ghost">管理</Button></div><div className="context-chip-list"><Badge tone="accent">项目文件读取</Badge><Badge>代码搜索</Badge><Badge>变更预览</Badge></div></Surface><Surface className="context-section"><div className="section-heading"><h3>相关记忆</h3><button className="text-link">查看全部</button></div><MemoryReference memory={memories[1]} /></Surface><Surface className="context-section"><div className="section-heading"><h3>交付物</h3><Badge>2</Badge></div><ArtifactCard title="启动配置 diff" kind="变更预览 · 2 个文件" /><ArtifactCard title="检查记录" kind="摘要 · 今天 10:44" /></Surface></aside></div>;
}

function WorkPage({ onOpenChat }: { onOpenChat(): void }) {
  const [selected, setSelected] = useState('all');
  const items = selected === 'all' ? tasks : tasks.filter((task) => task.status === selected);
  const tabs = [{ id: 'all', label: '全部 4' }, { id: 'working', label: '运行中 1' }, { id: 'waiting', label: '待处理 1' }, { id: 'completed', label: '已完成 1' }];
  return <div className="content-page"><PageHeading eyebrow="WORKSPACE" title="工作" description="查看跨会话任务的进展、负责人和下一步。"><Button icon="add" variant="primary">新建任务</Button></PageHeading><Banner><strong>有 1 项任务需要你处理。</strong> Codex 正在等待一次性文件变更审批。</Banner><div className="row between work-controls"><Tabs items={tabs} selected={selected} onChange={setSelected} label="按任务状态筛选" /><SearchInput label="搜索任务" placeholder="搜索任务" /></div><div className="task-grid">{items.map((task) => <TaskCard key={task.id} task={task} onOpen={onOpenChat} />)}</div><SectionHeading title="最近工作区" trailing={<button className="text-link">管理工作区</button>} /><div className="workspace-grid"><Card className="workspace-card"><div className="workspace-badge purple">CM</div><div className="workspace-card-body"><strong>CetaMesh Desktop</strong><p>本地项目 · 最近活动 2 分钟前</p></div><Badge tone="success">已同步</Badge></Card><Card className="workspace-card"><div className="workspace-badge blue">DS</div><div className="workspace-card-body"><strong>研究资料</strong><p>本地工作区 · 最近活动 8 分钟前</p></div><Badge>本地</Badge></Card></div></div>;
}

function AgentsPage() {
  const [filter, setFilter] = useState('all');
  const visibleAgents = filter === 'all' ? agents : agents.filter((agent) => agent.status === filter);
  return <div className="content-page"><PageHeading eyebrow="AGENT DIRECTORY" title="Agents" description="查看可用 Agent、连接状态与职责。"><Button icon="sliders">管理 Agent</Button></PageHeading><div className="agent-summary-row"><Surface><strong>3</strong><span>已配置 Agent</span></Surface><Surface><strong>2</strong><span>当前可用</span></Surface><Surface><strong>1</strong><span>需要设置</span></Surface><Surface><strong>1</strong><span>活跃任务</span></Surface></div><div className="row between work-controls"><Tabs items={[{ id: 'all', label: '全部 Agent' }, { id: 'ready', label: '可用 2' }, { id: 'needs-setup', label: '需设置 1' }]} selected={filter} onChange={setFilter} label="Agent 状态筛选" /><SearchInput label="搜索 Agent" placeholder="搜索名称或能力" /></div><div className="agent-grid">{visibleAgents.map((agent) => <AgentCard key={agent.id} agent={agent} onOpen={() => undefined} />)}</div><SectionHeading title="运行策略" trailing={<button className="text-link">查看详情</button>} /><Surface className="policy-row"><span className="policy-icon"><Icon name="approval" /></span><span className="grow"><strong>敏感操作需要确认</strong><small>文件修改、网络访问和外部副作用会先展示权限卡片。</small></span><Badge tone="success">已启用</Badge></Surface></div>;
}

function PluginsPage() {
  const [category, setCategory] = useState('全部');
  const [query, setQuery] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState<PluginView | null>(null);
  const [installed, setInstalled] = useState<string[]>(plugins.filter((plugin) => plugin.status === 'installed').map((plugin) => plugin.id));
  const visible = useMemo(() => plugins.filter((plugin) => (category === '全部' || plugin.category === category) && `${plugin.name} ${plugin.summary}`.toLowerCase().includes(query.toLowerCase())), [category, query]);
  const categories = ['全部', ...new Set(plugins.map((plugin) => plugin.category))];
  return <div className="content-page"><PageHeading eyebrow="EXTENSIONS & CONNECTORS" title="Plugins" description="在一个位置管理扩展能力、外部集成和权限。"><Button icon="add" variant="primary">添加插件</Button></PageHeading><div className="plugin-banner"><span className="plugin-banner-icon"><Icon name="approval" size={19} /></span><span><strong>安装前先查看权限</strong><small>插件清单会说明它能够访问的内容与执行的操作。</small></span><button className="text-link">插件安全说明</button></div><div className="plugin-toolbar"><SearchInput label="搜索插件" placeholder="搜索插件、集成或开发者" value={query} onChange={(event) => setQuery(event.target.value)} /><Tabs items={categories.map((item) => ({ id: item, label: item }))} selected={category} onChange={setCategory} label="插件分类" /><Button compact variant="ghost" icon="sliders">筛选</Button></div><div className="plugin-grid">{visible.map((plugin) => <PluginCard key={plugin.id} plugin={{ ...plugin, status: installed.includes(plugin.id) ? plugin.status === 'update' ? 'update' : 'installed' : 'available' }} onOpen={() => setSelectedPlugin(plugin)} />)}</div><Sheet open={Boolean(selectedPlugin)} title={selectedPlugin?.name ?? '插件详情'} onClose={() => setSelectedPlugin(null)}>{selectedPlugin && <PluginDetails plugin={selectedPlugin} isInstalled={installed.includes(selectedPlugin.id)} onToggle={() => setInstalled((previous) => previous.includes(selectedPlugin.id) ? previous.filter((id) => id !== selectedPlugin.id) : [...previous, selectedPlugin.id])} />}</Sheet></div>;
}

function PluginDetails({ plugin, isInstalled, onToggle }: { plugin: PluginView; isInstalled: boolean; onToggle(): void }) {
  return <div className="plugin-details"><div className="plugin-details-icon"><Icon name={plugin.icon} size={28} /></div><Badge tone={isInstalled ? 'success' : 'default'}>{isInstalled ? '已安装' : '可获取'}</Badge><p>{plugin.summary}</p><dl><div><dt>开发者</dt><dd>{plugin.developer}</dd></div><div><dt>版本</dt><dd>{plugin.version}</dd></div><div><dt>类型</dt><dd>{plugin.kind === 'integration' ? '集成' : '扩展'}</dd></div></dl><Divider /><h3>请求的权限</h3><ul>{plugin.permissions.map((permission) => <li key={permission}><Icon name="check" size={14} />{permission}</li>)}</ul><Divider /><h3>更新说明</h3><p>{plugin.changelog}</p><Button variant={isInstalled ? 'default' : 'primary'} onClick={onToggle}>{isInstalled ? '移除插件' : '安装插件'}</Button><small className="preview-only-note">预览交互：不会实际安装或修改系统。</small></div>;
}

function SettingsPage() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const [toggles, setToggles] = useState({ compact: false, sounds: true, launch: false });
  function flip(key: keyof typeof toggles) { setToggles((current) => ({ ...current, [key]: !current[key] })); }
  return <div className="content-page settings-page"><PageHeading eyebrow="PREFERENCES" title="Settings" description="调整界面偏好和本地工作行为。" /><div className="settings-layout"><nav className="settings-nav" aria-label="设置分类"><a href="#appearance">外观</a><a href="#behavior">行为</a><a href="#privacy">隐私与安全</a><a href="#notifications">通知</a></nav><div className="settings-content"><section id="appearance"><SectionHeading title="外观" trailing={<span className="settings-caption">更改立即应用</span>} /><p className="settings-description">选择 CetaMesh 在此设备上显示的颜色主题。</p><div className="theme-options">{(['system', 'light', 'dark'] as const).map((value) => <button key={value} className={`theme-option ${theme === value ? 'selected' : ''}`} aria-pressed={theme === value} onClick={() => setTheme(value)}><span className={`theme-swatch ${value}`}><i /><i /></span><strong>{value === 'system' ? '跟随系统' : value === 'light' ? '浅色' : '深色'}</strong>{theme === value && <Icon name="check" size={15} />}</button>)}</div></section><Divider /><section id="behavior"><SectionHeading title="行为" /><ToggleRow title="紧凑布局" description="减少列表和卡片之间的留白。" value={toggles.compact} onChange={() => flip('compact')} /><ToggleRow title="播放提示音" description="在任务完成或等待审批时播放提示。" value={toggles.sounds} onChange={() => flip('sounds')} /><ToggleRow title="登录时启动" description="登录 Windows 后在后台启动 CetaMesh。" value={toggles.launch} onChange={() => flip('launch')} /></section><Divider /><section id="privacy"><SectionHeading title="隐私与安全" /><Surface className="privacy-card"><Icon name="approval" /><span className="grow"><strong>本地数据与权限</strong><small>会话和配置保存在本机。敏感操作遵循逐次审批。</small></span><Button compact>查看策略</Button></Surface></section></div></div></div>;
}

function ToggleRow({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange(): void }) {
  return <div className="toggle-row"><span className="grow"><strong>{title}</strong><small>{description}</small></span><button className={`switch ${value ? 'on' : ''}`} role="switch" aria-checked={value} aria-label={title} onClick={onChange}><i /></button></div>;
}

function AboutPage({ about }: { about: AboutView }) {
  return <div className="content-page about-page"><PageHeading eyebrow="ABOUT CETAMESH" title="About" description="一个连接本地工具、Agent 与工作流的桌面空间。" /><div className="about-hero"><span className="about-logo"><Icon name="sparkles" size={34} /></span><div><h2>CetaMesh Desktop</h2><p>让本地 Agent 协作保持透明、可控。</p></div><Badge tone="accent">UX v2 原型</Badge></div><div className="about-grid"><Card><span className="eyebrow">版本</span><strong>{about.version ?? '未知'}</strong><small>构建 {about.buildId ?? '本地预览'}</small></Card><Card><span className="eyebrow">开发者</span><strong>{about.developer ?? 'CetaMesh Team'}</strong><small>Windows 桌面应用</small></Card><UpdateCard update={update} /></div><SectionHeading title="项目链接" /><Surface className="links-list">{([['官方网站', about.website], ['GitCode', about.gitcode], ['GitHub', about.github]] as const).map(([label, url]) => <button key={label} className="link-row" onClick={() => url && void openExternal(url)}><Icon name="globe" size={16} /><span className="grow">{label}</span><span>{url?.replace(/^https:\/\//, '') ?? '未配置'}</span><Icon name="right" size={14} /></button>)}</Surface><p className="about-footnote">桌面 v2 以 WebView2 呈现界面，Core 服务和命名管道保持本地运行。</p></div>;
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{children && <div>{children}</div>}</div>;
}
function SectionHeading({ title, trailing }: { title: string; trailing?: ReactNode }) { return <div className="section-heading page-section-heading"><h2>{title}</h2>{trailing}</div>; }
