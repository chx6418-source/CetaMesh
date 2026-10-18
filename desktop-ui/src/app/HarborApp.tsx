import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { createPortal } from 'react-dom';
import { mergeChatHistorySnapshot, mergeLatestChatMessages, prependOlderChatMessages } from './chat-history';
import { applyChatStreamUpdates, ChatRequestEpoch, ChatStreamRevision, pendingReplyVisible, type ChatStreamUpdate } from './chat-async-state';
import { aboutClient, agentClient, approvalClient, bridge, chatClient, extensionSettingsClient, feedbackClient, hostClient, memoryClient, onboardingClient, openExternal, pluginClient, searchClient, settingsClient, taskClient, updateClient, workspaceClient, workshopClient, type Agent, type Approval, type ChatMessage as ChatMessageDto, type ChatSession, type ExtensionSettingsDescription, type ExtensionSettingsSnapshot, type IntegrationSettings, type Memory, type Plugin, type ProviderSettingField, type SettingField, type Settings, type Task, type WorkshopProposal } from '../bridge/typed-client';
import { Icon, type IconName } from '../components/icons';
import { ArtifactCard } from '../components/product/cards';
import { Button, IconButton, Input, normalizeSelectOptionLabel, SearchInput, Select, Tabs } from '../components/primitives/inputs';
import { Sheet } from '../components/primitives/overlays';
import { Badge, Banner, Card, Divider, LoadingState, Surface } from '../components/primitives/surfaces';
import { Markdown, VirtualList, type VirtualListAnchor, type VirtualListController } from '../components/primitives/content';
import { useUi } from '../stores/ui';
import './harbor.css';

type PageId = 'chat' | 'work' | 'agents' | 'plugins' | 'settings' | 'about' | 'memory' | 'onboarding';
const NAV: { id: Exclude<PageId, 'onboarding'>; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' }, { id: 'work', label: 'Work', icon: 'work' },
  { id: 'agents', label: 'Agents', icon: 'agents' }, { id: 'plugins', label: 'Plugins', icon: 'plugins' },
  { id: 'settings', label: 'Settings', icon: 'settings' }, { id: 'about', label: 'About', icon: 'help' }
];
const isPage = (value: string | null): value is PageId => value === 'chat' || value === 'work' || value === 'agents' || value === 'plugins' || value === 'settings' || value === 'about' || value === 'memory' || value === 'onboarding';
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作暂时无法完成，请稍后重试。';
const dateLabel = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
};
const relativeLabel = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - date) / 60_000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
};
const taskStatusLabel = (status: string) => ({ working: '运行中', running: '运行中', waiting: '等待处理', 'waiting-approval': '等待审批', paused: '已暂停', completed: '已完成', cancelled: '已取消', error: '需要处理' }[status] ?? status);
const agentActivityStatusLabel = (status: string) => ({ running: '正在运行', completed: '已完成', cancelled: '已停止', failed: '未完成' }[status] ?? status);
const updateStatusLabel = (status: string) => ({ update_available: '有可用更新', up_to_date: '已是最新版本', checked: '已完成检查', error: '检查失败', unknown: '尚未检查' }[status] ?? status);
const agentInitials = (id: string) => id.slice(0, 2).toUpperCase();

function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="harbor-error" role="alert"><Icon name="help" size={17} /><span>{error}</span>{onRetry && <Button compact variant="ghost" onClick={onRetry}>重试</Button>}</div>;
}
function EmptyNotice({ icon = 'sparkles', title, detail, action }: { icon?: IconName; title: string; detail: string; action?: ReactNode }) {
  return <div className="harbor-empty"><Icon name={icon} size={26} /><strong>{title}</strong><p>{detail}</p>{action}</div>;
}
function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}
function StatusBadge({ value, available }: { value: string; available?: boolean }) {
  const tone = available === true || ['ready', 'running', 'enabled', 'completed', 'current', 'installed'].includes(value) ? 'success'
    : ['needs-setup', 'descriptor-incomplete', 'pending', 'waiting-approval', 'starting', 'start-timeout', 'checking', 'update'].includes(value) ? 'warning'
      : ['unavailable', 'error', 'failed', 'stopped', 'disabled'].includes(value) ? 'danger' : 'default';
  const label = ({ ready: '已就绪', running: '运行中', enabled: '已启用', installed: '已安装', update: '可更新', completed: '已完成', current: '当前步骤', 'needs-setup': '需要设置', 'descriptor-incomplete': '配置不完整', 'not-installed': '未安装', 'not-supported': '不支持', 'not-checked': '未检查', checking: '检查中', 'start-timeout': '等待网关就绪', invalid: '安装需修复', unavailable: '暂不可用', disabled: '已停用', stopped: '已停止', pending: '等待处理', 'waiting-approval': '等待审批', starting: '启动中', error: '异常', failed: '失败' } as Record<string, string>)[value] ?? value;
  return <Badge tone={tone}>{label}</Badge>;
}
function availabilityReasonLabel(reason: string | null) {
  if (!reason) return '';
  return ({
    'not-installed': '未安装', 'needs-setup': '需要配置', stopped: '已停止', 'start-timeout': '等待网关就绪',
    'provider-unavailable': '服务未连接', 'server-stopped': '已停止', 'task-required': '创建任务后使用',
    'workspace-required': '需要工作区', 'scope-unavailable': '需要工作区', 'descriptor-incomplete': '能力描述不完整',
    'not-supported': '暂不支持', 'not-checked': '尚未检查', unavailable: '服务未连接'
  } as Record<string, string>)[reason] ?? reason;
}

export function HarborApp() {
  const [params, setParams] = useSearchParams();
  const routePage = isPage(params.get('page')) ? params.get('page') as PageId : 'chat';
  const [hostStatus, setHostStatus] = useState<'checking' | 'ready' | 'offline'>('checking');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [allSessions, setAllSessions] = useState<ChatSession[]>([]);
  const [allSessionsOpen, setAllSessionsOpen] = useState(false);
  const [allSessionsQuery, setAllSessionsQuery] = useState('');
  const [allSessionsScope, setAllSessionsScope] = useState<'all' | 'active' | 'archived'>('all');
  const [allSessionsError, setAllSessionsError] = useState('');
  const [taskCount, setTaskCount] = useState(0);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; status: string; lastActivity: string | number | null }[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const [onboarding, setOnboarding] = useState<{ complete: boolean; currentStep: string | null } | null>(null);
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ sessions: ChatSession[]; tasks: Task[]; plugins: Plugin[] } | null>(null);
  const [searchError, setSearchError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const theme = useUi(state => state.theme);
  const setTheme = useUi(state => state.setTheme);
  const activeSession = sessions.find(session => session.id === activeSessionId) ?? null;
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null;
  const onboardingRequired = onboarding !== null && !onboarding.complete;
  const page: PageId = onboardingRequired ? 'onboarding' : routePage;

  const navigate = useCallback((next: PageId, sessionId?: string) => {
    const query = new URLSearchParams(params);
    query.set('page', next);
    if (sessionId) setActiveSessionId(sessionId);
    setParams(query);
    setGlobalSearch('');
    setSearchResults(null);
  }, [params, setParams]);

  const refreshSessions = useCallback(async () => {
    try {
      const result = await chatClient.sessions.list();
      setSessions(result.sessions);
      setSessionError('');
      setActiveSessionId(current => result.sessions.some(session => session.id === current) ? current : (result.sessions[0]?.id ?? ''));
    } catch (error) { setSessionError(messageOf(error)); }
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const result = await workspaceClient.list();
      setWorkspaces(result.workspaces);
      setActiveWorkspaceId(result.activeId);
      setWorkspaceError('');
    } catch (error) { setWorkspaceError(messageOf(error)); }
  }, []);
  async function openWorkspace(id: string) {
    try {
      const result = await workspaceClient.open(id);
      setActiveWorkspaceId(result.activeId);
      setWorkspaceError('');
      navigate('work');
      await refreshWorkspaces();
    } catch (error) { setWorkspaceError(messageOf(error)); }
  }
  const refreshTaskCount = useCallback(async () => {
    try { setTaskCount((await taskClient.overview('', '')).total); } catch { setTaskCount(0); }
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    void refreshSessions();
    void refreshWorkspaces();
    void refreshTaskCount();
    void hostClient.status().then(status => setHostStatus(status.ready ? 'ready' : 'offline')).catch(() => setHostStatus('offline'));
    void onboardingClient.status().then(setOnboarding).catch(() => setOnboarding(null));
    void settingsClient.get().then(result => {
      const saved = result.settings.general?.theme;
      if (saved === 'system' || saved === 'light' || saved === 'dark') setTheme(saved);
    }).catch(() => { /* Settings load errors are surfaced on the Settings page. */ });
    const offSessions = bridge.subscribe('chat.updated', () => { void refreshSessions(); });
    const offCore = bridge.subscribe('core.status', ({ ready }) => setHostStatus(ready ? 'ready' : 'offline'));
    const offRestart = bridge.subscribe('core.restarted', () => {
      void refreshSessions();
      void refreshWorkspaces();
      void refreshTaskCount();
      void hostClient.status().then(status => setHostStatus(status.ready ? 'ready' : 'offline')).catch(() => setHostStatus('offline'));
    });
    const offTasks = bridge.subscribe('task.updated', () => { void refreshTaskCount(); });
    const offWorkspaces = bridge.subscribe('workspace.updated', () => { void refreshWorkspaces(); });
    return () => { offSessions(); offCore(); offRestart(); offTasks(); offWorkspaces(); };
  }, [refreshSessions, refreshWorkspaces, refreshTaskCount, setTheme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!globalSearch.trim()) { setSearchResults(null); setSearchError(''); return; }
    const timer = window.setTimeout(() => {
      void searchClient.search(globalSearch.trim()).then(setSearchResults).catch(error => { setSearchError(messageOf(error)); setSearchResults(null); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [globalSearch]);

  async function createSession() {
    try {
      const session = await chatClient.sessions.create();
      setSessions(current => [session, ...current]);
      setActiveSessionId(session.id);
      navigate('chat', session.id);
    } catch (error) { setSessionError(messageOf(error)); }
  }

  async function loadAllSessions() {
    try { setAllSessions((await chatClient.sessions.list(true)).sessions); setAllSessionsError(''); }
    catch (error) { setAllSessionsError(messageOf(error)); }
  }

  async function manageSession(session: ChatSession, action: 'rename' | 'archive' | 'restore' | 'delete') {
    if (action === 'rename') {
      const title = window.prompt('重命名会话', session.title);
      if (title === null) return;
      if (!title.trim()) { setSessionError('会话名称不能为空。'); return; }
      try { await chatClient.sessions.rename(session.id, title.trim()); }
      catch (error) { setSessionError(messageOf(error)); setAllSessionsError(messageOf(error)); return; }
    } else if (action === 'delete') {
      if (!window.confirm(`永久删除“${session.title || '新会话'}”？此操作不可撤销。`)) return;
      try { await chatClient.sessions.remove(session.id); }
      catch (error) { setSessionError(messageOf(error)); setAllSessionsError(messageOf(error)); return; }
    } else {
      const archived = action === 'archive';
      if (archived && !window.confirm(`归档“${session.title || '新会话'}”？`)) return;
      try { await chatClient.sessions.archive(session.id, archived); }
      catch (error) { setSessionError(messageOf(error)); setAllSessionsError(messageOf(error)); return; }
    }
    await refreshSessions();
    if (allSessionsOpen) await loadAllSessions();
  }

  async function changeTheme(next: 'system' | 'light' | 'dark') {
    setTheme(next);
    try {
      const result = await settingsClient.get();
      await settingsClient.update('general', { theme: next }, result.revision);
    } catch { /* Theme applies in this window even when Core cannot persist it. */ }
  }

  const title = page === 'chat' ? activeSession?.title ?? 'Chat' : page === 'memory' ? 'Memory' : NAV.find(item => item.id === page)?.label ?? '首次设置';
  const recentSessions = sessions.slice(0, 7);
  const shownAllSessions = allSessions.filter(session => {
    const inScope = allSessionsScope === 'all' || (allSessionsScope === 'archived' ? session.archived : !session.archived);
    return inScope && `${session.title} ${session.id}`.toLowerCase().includes(allSessionsQuery.toLowerCase());
  });
  return <div className="harbor-shell" onContextMenu={event => {
    const target = event.target as Element;
    if (target.closest('input, textarea, [contenteditable="true"], .chat-message, .cm-markdown, .cm-code')) return;
    event.preventDefault();
  }}>
    <aside className="harbor-sidebar">
      <div className="brand-lockup"><span className="brand-mark"><Icon name="sparkles" size={20} /></span><span className="brand-copy"><strong>CetaMesh</strong><small>Desktop · UX v2</small></span></div>
      <details className="workspace-switch"><summary><span className="workspace-avatar">CM</span><span className="workspace-label"><strong>{activeWorkspace?.name ?? '个人工作区'}</strong><small>{activeWorkspace?.status ?? '本地工作区'}</small></span><Icon name="down" size={14} /></summary><div className="workspace-menu">{workspaceError && <p role="alert">{workspaceError}</p>}{workspaces.length ? workspaces.map(workspace => <button key={workspace.id} aria-current={workspace.id === activeWorkspaceId ? 'true' : undefined} onClick={() => void openWorkspace(workspace.id)}><strong>{workspace.name}</strong><small>{workspace.status}</small></button>) : <p>尚未登记工作区</p>}<button className="workspace-add" onClick={() => navigate('work')}>管理工作区</button></div></details>
      <nav aria-label="工作空间" className="primary-nav"><span className="nav-label">工作空间</span>{NAV.slice(0, 4).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} size={18} /><span>{item.label}</span>{item.id === 'work' && taskCount > 0 && <small className="nav-count">{taskCount}</small>}</button>)}</nav>
      {page === 'chat' && <section className="session-section" aria-label="最近会话">
        <div className="session-heading"><span className="nav-label">最近会话</span><IconButton label="新建会话" icon="add" compact onClick={() => void createSession()} /></div>
        {sessionError && <div className="sidebar-error" role="alert">{sessionError}</div>}
        <div className="session-list">{recentSessions.map(session => <div className="session-row" key={session.id}>
          <button className={`session-item ${activeSessionId === session.id ? 'selected' : ''}`} onClick={() => setActiveSessionId(session.id)} aria-current={activeSessionId === session.id ? 'page' : undefined}>
            <span className="session-unread" aria-hidden="true">{activeSessionId === session.id ? '•' : ''}</span><span className="session-copy"><strong>{session.title || '新会话'}</strong><small>{relativeLabel(session.updatedAt)}</small></span><time>{dateLabel(session.updatedAt).split(' ').at(-1)}</time>
          </button>
          <SessionActionsMenu session={session} onAction={action => { void manageSession(session, action); }} />
        </div>)}</div>
        {!sessions.length && !sessionError && <p className="sidebar-empty">还没有会话</p>}
        <button className="all-sessions" onClick={() => { setAllSessionsOpen(true); setAllSessionsQuery(''); void loadAllSessions(); }}>查看全部会话 <Icon name="right" size={13} /></button>
      </section>}
      <div className="sidebar-bottom"><div className="host-indicator"><span className={`host-dot ${hostStatus}`} /><span>{hostStatus === 'ready' ? '桌面工作台已连接' : hostStatus === 'checking' ? '连接桌面主机' : '桌面服务离线'}</span><span className="host-more"><Icon name="more" size={16} /></span></div><Divider /><div className="utility-nav">{NAV.slice(4).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} size={18} /><span>{item.label}</span></button>)}</div><div className="profile-row"><span className="profile-avatar">CM</span><span><strong>本地用户</strong><small>个人空间</small></span></div></div>
    </aside>
    <div className="harbor-main">
      <header className="topbar"><div className="breadcrumb"><span>{page === 'chat' ? '会话' : page === 'onboarding' ? '首次设置' : title}</span><Icon name="right" size={13} /><strong>{page === 'chat' ? title : page === 'onboarding' ? '开始使用' : title}</strong></div><div className="topbar-actions"><label className="global-search"><Icon name="search" size={16} /><Input ref={searchRef} aria-label="搜索会话、任务或插件" placeholder="搜索会话、任务或插件" value={globalSearch} onChange={event => setGlobalSearch(event.target.value)} /><kbd>⌘ K</kbd></label><span className={`top-host-status ${hostStatus}`}><i />{hostStatus === 'ready' ? '已连接' : hostStatus === 'checking' ? '连接中' : '未连接'}</span><IconButton label={`当前主题：${theme}`} icon={theme === 'dark' ? 'moon' : 'sun'} onClick={() => void changeTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')} /></div>
        {globalSearch && <div className="search-popover" role="region" aria-label="搜索结果">{searchError ? <ErrorNotice error={searchError} /> : searchResults ? <SearchResults results={searchResults} onSelectSession={id => navigate('chat', id)} onSelectPage={navigate} /> : <LoadingState label="正在搜索…" />}</div>}
      </header>
      <main className={`page-frame page-${page}`}>
        {page === 'chat' && <ChatPage key={activeSession?.id ?? 'no-session'} session={activeSession} workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onSessionUpdate={updated => setSessions(current => current.map(item => item.id === updated.id ? updated : item))} onNew={createSession} onOpenMemory={() => navigate('memory')} onReviewTask={id => { setReviewTaskId(id); navigate('work'); }} />}
        {page === 'work' && <WorkPage workspaces={workspaces} onRefreshWorkspaces={refreshWorkspaces} reviewTaskId={reviewTaskId} onReviewTaskOpened={() => setReviewTaskId(null)} />}
        {page === 'memory' && <MemoryPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'plugins' && <PluginsPage />}
        {page === 'settings' && <SettingsPage theme={theme} onThemeChange={changeTheme} onOpenPlugins={() => navigate('plugins')} />}
        {page === 'about' && <AboutPage />}
        {page === 'onboarding' && <OnboardingPage onComplete={async () => { const state = await onboardingClient.status(); setOnboarding(state); navigate('chat'); }} />}
      </main>
      <footer className="harbor-footer"><span>Harbor</span><span>·</span><span>熟悉的多栏工作台</span><span className="grow" /><span>本地 Core · WebView2</span></footer>
    </div>
    <Sheet open={allSessionsOpen} title="全部会话" onClose={() => setAllSessionsOpen(false)}>
      <div className="all-session-manager">
        <SearchInput label="搜索会话" placeholder="搜索会话标题" value={allSessionsQuery} onChange={event => setAllSessionsQuery(event.target.value)} />
        <Tabs label="会话范围" selected={allSessionsScope} onChange={value => setAllSessionsScope(value as 'all' | 'active' | 'archived')} items={[{ id: 'all', label: `全部 ${allSessions.length}` }, { id: 'active', label: '进行中' }, { id: 'archived', label: `已归档 ${allSessions.filter(session => session.archived).length}` }]} />
        {allSessionsError && <ErrorNotice error={allSessionsError} onRetry={() => void loadAllSessions()} />}
        {shownAllSessions.length ? <div className="all-session-list">{shownAllSessions.map(session => <article className="all-session-row" key={session.id}>
          <button className="all-session-open" onClick={() => { setActiveSessionId(session.id); setAllSessionsOpen(false); navigate('chat', session.id); }}><strong>{session.title || '新会话'}</strong><small>{session.archived ? '已归档' : '最近活动'} · {relativeLabel(session.updatedAt)}</small></button>
          <Button compact onClick={() => void manageSession(session, session.archived ? 'restore' : 'archive')}>{session.archived ? '恢复' : '归档'}</Button>
          <IconButton label={`删除会话：${session.title || '新会话'}`} icon="close" compact onClick={() => void manageSession(session, 'delete')} />
        </article>)}</div> : !allSessionsError && <EmptyNotice icon="chat" title="没有匹配的会话" detail="调整搜索内容或新建一个会话。" />}
      </div>
    </Sheet>
  </div>;
}

function SearchResults({ results, onSelectSession, onSelectPage }: { results: { sessions: ChatSession[]; tasks: Task[]; plugins: Plugin[] }; onSelectSession(id: string): void; onSelectPage(page: PageId): void }) {
  if (!results.sessions.length && !results.tasks.length && !results.plugins.length) return <EmptyNotice icon="search" title="没有找到结果" detail="试试会话标题、任务内容或插件名称。" />;
  return <div className="search-results">{results.sessions.map(session => <button key={`s-${session.id}`} onClick={() => onSelectSession(session.id)}><Icon name="chat" size={16} /><span><strong>{session.title || '新会话'}</strong><small>会话 · {dateLabel(session.updatedAt)}</small></span></button>)}{results.tasks.map(task => <button key={`t-${task.id}`} onClick={() => onSelectPage('work')}><Icon name="work" size={16} /><span><strong>{task.title}</strong><small>任务 · {taskStatusLabel(task.status)}</small></span></button>)}{results.plugins.map(plugin => <button key={`p-${plugin.id}`} onClick={() => onSelectPage('plugins')}><Icon name="plugins" size={16} /><span><strong>{plugin.name}</strong><small>插件 · {plugin.developer}</small></span></button>)}</div>;
}

function SessionActionsMenu({ session, onAction }: { session: ChatSession; onAction(action: 'rename' | 'archive' | 'delete'): void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.right - 150, window.innerWidth - 158));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 136));
    setPosition({ top, left });
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    const scroll = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', scroll);
    };
  }, [open]);
  function action(name: 'rename' | 'archive' | 'delete') { setOpen(false); onAction(name); }
  const style: CSSProperties = { position: 'fixed', top: position.top, left: position.left };
  return <>
    <button ref={triggerRef} type="button" className="session-menu-trigger" aria-label={`会话操作：${session.title || '新会话'}`} aria-haspopup="menu" aria-expanded={open} onClick={() => open ? setOpen(false) : show()}><Icon name="more" size={15} /></button>
    {open && createPortal(<div ref={menuRef} className="session-menu-items" role="menu" style={style} aria-label={`会话操作：${session.title || '新会话'}`}>
      <button role="menuitem" onClick={() => action('rename')}>重命名</button>
      <button role="menuitem" onClick={() => action('archive')}>归档</button>
      <button role="menuitem" className="session-delete" onClick={() => action('delete')}>删除会话</button>
    </div>, document.body)}
  </>;
}

type ChatTimelineItem =
  | { id: string; kind: 'message'; message: ChatMessageDto }
  | { id: 'load-earlier'; kind: 'load-earlier' }
  | { id: 'loading'; kind: 'loading' }
  | { id: 'error'; kind: 'error'; message: string }
  | { id: 'empty'; kind: 'empty' }
  | { id: 'streaming'; kind: 'streaming'; message: ChatMessageDto }
  | { id: 'turn-error'; kind: 'turn-error'; message: string }
  | { id: string; kind: 'approval'; approval: Approval };
const chatTimelineKey = (item: ChatTimelineItem) => item.id;
const isChatMessageAnchor = (item: ChatTimelineItem) => item.kind === 'message';

export function ChatCatalogStatus({ catalog }: { catalog: Awaited<ReturnType<typeof chatClient.catalog>> | null }) {
  // `available` describes the optional legacy DSH catalog. Model discovery
  // has its own state; a loaded directory is not proof of inference readiness.
  const hasDirectCatalog = catalog?.modelProviders.some(provider => provider.catalogState === 'loaded' && provider.models.length > 0);
  return <span>{catalog?.available === false && !hasDirectCatalog ? catalog.reason || '模型状态不可用' : 'CetaMesh Desktop'}</span>;
}

function ChatPage({ session, workspaces, activeWorkspaceId, onSessionUpdate, onNew, onOpenMemory, onReviewTask }: { session: ChatSession | null; workspaces: { id: string; name: string; status: string }[]; activeWorkspaceId: string | null; onSessionUpdate(session: ChatSession): void; onNew(): Promise<void>; onOpenMemory(): void; onReviewTask(id: string): void }) {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [status, setStatus] = useState<{ state: string; displayText: string; statusMessage: string | null; requestId: string | null; retryCount: number; followState: string; followError: string | null; toolActivity: ChatMessageDto['toolActivity']; agentActivity: ChatMessageDto['agentActivity']; error: string | null; errorCode: string | null; approvalId: string | null; routing: Record<string, unknown> }>({ state: 'idle', displayText: '', statusMessage: null, requestId: null, retryCount: 0, followState: 'idle', followError: null, toolActivity: [], agentActivity: null, error: null, errorCode: null, approvalId: null, routing: {} });
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof chatClient.catalog>> | null>(null);
  const [linkedTask, setLinkedTask] = useState<Task | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [settlingReply, setSettlingReply] = useState<{ requestId: string | null; text: string } | null>(null);

  const historySessionIdRef = useRef<string | null>(null);
  const lastHistoryMessageIdRef = useRef<string | null>(null);
  const requestEpochRef = useRef(new ChatRequestEpoch());
  const activeSessionIdRef = useRef<string | null>(session?.id ?? null);
  activeSessionIdRef.current = session?.id ?? null;
  requestEpochRef.current.activate(activeSessionIdRef.current);
  const activeStreamRequestIdRef = useRef<string | null>(null);
  const streamRevisionRef = useRef(new ChatStreamRevision());
  const statusRef = useRef(status);
  statusRef.current = status;
  const isAtBottomRef = useRef(true);
  const skipAutomaticScrollRef = useRef(false);
  const olderPageRequestRef = useRef(false);
  const virtualListRef = useRef<VirtualListController | null>(null);
  const streamStatusFrameRef = useRef<number | null>(null);
  const streamUpdateRef = useRef<ChatStreamUpdate[]>([]);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingSendsRef = useRef(new Map<string, { text: string; attachments: { name: string; content: string; mimeType?: string }[] }>());
  const previousStreamRef = useRef({ state: 'idle', text: '' });

  const refreshCatalog = useCallback(async () => {
    try { setCatalog(await chatClient.catalog()); }
    catch { /* A slow or failed directory must not block local Chat history refresh. */ }
  }, []);

  const load = useCallback(async () => {
    const sessionId = session?.id ?? null;
    const request = requestEpochRef.current.begin('load', sessionId);
    if (!session) {
      if (!requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) return;
      historySessionIdRef.current = null;
      lastHistoryMessageIdRef.current = null;
      seenMessageIdsRef.current.clear();
      previousStreamRef.current = { state: 'idle', text: '' };
      activeStreamRequestIdRef.current = null;
      setMessages([]);
      setSettlingReply(null);
      setHasMoreHistory(false);
      setHasNewMessages(false);
      setLoading(false);
      const idleStatus = { state: 'idle', displayText: '', statusMessage: null, requestId: null, retryCount: 0, followState: 'idle', followError: null, toolActivity: [], agentActivity: null, error: null, errorCode: null, approvalId: null, routing: {} };
      statusRef.current = idleStatus;
      setStatus(idleStatus);
      setLinkedTask(null);
      setMemories([]);
      setApprovals([]);
      return;
    }
    if (historySessionIdRef.current !== session.id) setLoading(true);
    try {
      const history = await chatClient.history(session.id, 100);
      if (!requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) return;
      if (historySessionIdRef.current !== session.id) {
        historySessionIdRef.current = session.id;
        lastHistoryMessageIdRef.current = history.messages.at(-1)?.id ?? null;
        seenMessageIdsRef.current = new Set(history.messages.map(message => message.id));
        setHasNewMessages(false);
        isAtBottomRef.current = true;
        setMessages(current => requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)
          ? mergeChatHistorySnapshot(current, history.messages, false)
          : current);
        setHasMoreHistory(history.hasMore);
      } else {
        setHasMoreHistory(history.hasMore);
        lastHistoryMessageIdRef.current = history.messages.at(-1)?.id ?? lastHistoryMessageIdRef.current;
        const protectedIds = new Set(pendingSendsRef.current.keys());
        setMessages(current => requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)
          ? mergeLatestChatMessages(current, history.messages, protectedIds)
          : current);
      }
      setError('');
    } catch (cause) {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setError(messageOf(cause));
    } finally {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setLoading(false);
    }
  }, [session?.id]);

  const refreshHistory = useCallback(async (afterMessageId?: string | null) => {
    if (!session) return;
    const request = requestEpochRef.current.begin('load', session.id);
    const sameSession = historySessionIdRef.current === session.id;
    const cursor = afterMessageId !== undefined
      ? afterMessageId
      : sameSession ? lastHistoryMessageIdRef.current : null;
    try {
      const history = await chatClient.history(session.id, 100, null, cursor);
      if (!requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) return;
      if (!sameSession || !cursor) {
        historySessionIdRef.current = session.id;
        lastHistoryMessageIdRef.current = history.messages.at(-1)?.id ?? null;
        setHasMoreHistory(history.hasMore);
        const protectedIds = new Set(pendingSendsRef.current.keys());
        setMessages(current => requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)
          ? mergeChatHistorySnapshot(current, history.messages, sameSession, protectedIds)
          : current);
      } else if (history.messages.length) {
        lastHistoryMessageIdRef.current = history.messages.at(-1)?.id ?? cursor;
        setMessages(current => requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)
          ? mergeLatestChatMessages(current, history.messages, new Set(pendingSendsRef.current.keys()))
          : current);
      }
      setError('');
    } catch (cause) {
      if (!requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) return;
      if (messageOf(cause).includes('游标')) {
        void load();
        return;
      }
      setError(messageOf(cause));
    }
  }, [session?.id, load]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSettlingReply(null); }, [session?.id]);
  useEffect(() => {
    if (!session) return;
    try { setContextCollapsed(window.localStorage.getItem(`harbor:chat-context:${session.id}`) === 'collapsed'); }
    catch { setContextCollapsed(false); }
  }, [session?.id]);
  useEffect(() => {
    olderPageRequestRef.current = false;
    setLoadingOlder(false);
  }, [session?.id]);
  function toggleContext() {
    if (!session) return;
    const next = !contextCollapsed;
    setContextCollapsed(next);
    try { window.localStorage.setItem(`harbor:chat-context:${session.id}`, next ? 'collapsed' : 'expanded'); }
    catch { /* Context visibility still works for this session when storage is unavailable. */ }
  }
  const refreshContext = useCallback(async () => {
    if (!session) return;
    const request = requestEpochRef.current.begin('context', session.id);
    const snapshotRevision = streamRevisionRef.current.beginSnapshot();
    void chatClient.status(session.id).then(async nextStatus => {
      if (!requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)
        || !streamRevisionRef.current.shouldApply(snapshotRevision, statusRef.current, nextStatus)) return;
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      activeStreamRequestIdRef.current = nextStatus.requestId ?? null;
      const taskId = nextStatus.taskId || (typeof nextStatus.routing.taskId === 'string' ? nextStatus.routing.taskId : '');
      const nextTask = taskId ? await taskClient.get(taskId).then(result => result.task).catch(() => null) : null;
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setLinkedTask(nextTask);
    }).catch(cause => {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setError(messageOf(cause));
    });
    void memoryClient.overview(session.title || '', '').then(memoryData => {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setMemories(memoryData.memories.slice(0, 5));
    }).catch(cause => {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setError(messageOf(cause));
    });
    void approvalClient.list().then(approvalData => {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setApprovals(approvalData.approvals.filter(item => item.status === 'pending'));
    }).catch(cause => {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setError(messageOf(cause));
    });
  }, [session?.id, session?.title]);
  useEffect(() => { void refreshContext(); }, [refreshContext]);
  useEffect(() => {
    if (!session) return;
    const refreshConversation = () => { void refreshHistory(); };
    const offRestart = bridge.subscribe('core.restarted', () => { refreshConversation(); void refreshContext(); });
    const offUpdated = bridge.subscribe('chat.updated', data => { if (!data.sessionId || data.sessionId === session.id) refreshConversation(); });
    const offStreaming = bridge.subscribe('chat.streaming', data => {
      if (data.sessionId !== session.id || activeSessionIdRef.current !== session.id) return;
      streamRevisionRef.current.noteEvent();
      streamUpdateRef.current.push(data);
      if (streamStatusFrameRef.current !== null) return;
      streamStatusFrameRef.current = window.requestAnimationFrame(() => {
        streamStatusFrameRef.current = null;
        const updates = streamUpdateRef.current;
        streamUpdateRef.current = [];
        if (!updates.length || activeSessionIdRef.current !== session.id) return;
        setStatus(current => {
          const next = applyChatStreamUpdates(current, updates, session.id, activeStreamRequestIdRef.current);
          statusRef.current = next;
          return next;
        });
        const lastReset = [...updates].reverse().find(update => update.reset && update.requestId);
        if (lastReset?.requestId) activeStreamRequestIdRef.current = lastReset.requestId;
      });
    });
    const offApproval = bridge.subscribe('approval.pending', () => { void refreshContext(); });
    const offResolved = bridge.subscribe('approval.resolved', refreshContext);
    const offWarning = bridge.subscribe('chat.warning', data => {
      if (!data.sessionId || data.sessionId === session.id) setError(String(data.message ?? '旧 Agent 会话清理失败。'));
    });
    const offTasks = bridge.subscribe('task.updated', () => { void refreshContext(); });
    const offMemory = bridge.subscribe('memory.updated', () => { void refreshContext(); });
    const timer = window.setInterval(() => { void refreshContext(); }, 2500);
    return () => {
      window.clearInterval(timer);
      if (streamStatusFrameRef.current !== null) {
        window.cancelAnimationFrame(streamStatusFrameRef.current);
        streamStatusFrameRef.current = null;
      }
      streamUpdateRef.current = [];
      offUpdated(); offStreaming(); offApproval(); offResolved(); offWarning(); offTasks(); offMemory(); offRestart();
    };
  }, [session?.id, refreshHistory, load, refreshContext]);
  const loadOlderHistory = useCallback(async () => {
    if (!session || !hasMoreHistory || loadingOlder || olderPageRequestRef.current || !messages.length) return;
    const request = requestEpochRef.current.begin('older', session.id);
    const cursor = messages[0].id;
    const anchor: VirtualListAnchor | null = virtualListRef.current?.captureAnchor() ?? null;
    olderPageRequestRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await chatClient.history(session.id, 100, cursor);
      if (!requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) return;
      const existingBeforeRequest = new Set(messages.map(message => message.id));
      if (page.messages.some(message => !existingBeforeRequest.has(message.id))) {
        if (anchor) {
          virtualListRef.current?.preserveAnchorOnNextChange(anchor);
          skipAutomaticScrollRef.current = true;
        }
        setMessages(current => prependOlderChatMessages(current, page.messages));
      }
      setHasMoreHistory(page.hasMore);
    } catch (cause) {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) setError(messageOf(cause));
    } finally {
      if (requestEpochRef.current.isCurrent(request, activeSessionIdRef.current)) {
        olderPageRequestRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [session?.id, hasMoreHistory, loadingOlder, messages]);

  const streaming = ['starting', 'streaming', 'recovering', 'cancelling'].includes(status.state);
  useLayoutEffect(() => {
    if (streaming && status.displayText && status.requestId) {
      setSettlingReply(current => current?.requestId === status.requestId && current.text === status.displayText
        ? current : { requestId: status.requestId, text: status.displayText });
    } else if (settlingReply && !pendingReplyVisible(settlingReply, messages)) {
      setSettlingReply(null);
    }
  }, [streaming, status.displayText, status.requestId, settlingReply, messages]);
  useEffect(() => {
    if (!session || streaming || !pendingReplyVisible(settlingReply, messages)) return;
    void refreshHistory();
    const retry = window.setInterval(() => { void refreshHistory(); }, 2500);
    return () => window.clearInterval(retry);
  }, [session?.id, streaming, settlingReply, messages, refreshHistory]);
  const keepSettlingReply = !streaming && pendingReplyVisible(settlingReply, messages);
  const timelineItems = useMemo<ChatTimelineItem[]>(() => {
    const rows: ChatTimelineItem[] = [];
    if (hasMoreHistory && messages.length) rows.push({ id: 'load-earlier', kind: 'load-earlier' });
    if (loading && !messages.length) rows.push({ id: 'loading', kind: 'loading' });
    if (error) rows.push({ id: 'error', kind: 'error', message: error });
    if (!messages.length && !loading && !error) rows.push({ id: 'empty', kind: 'empty' });
    rows.push(...messages.map(message => ({ id: `message:${message.id}`, kind: 'message' as const, message })));
    if (streaming) rows.push({
      id: 'streaming', kind: 'streaming',
      message: { id: 'streaming', role: 'assistant', text: status.displayText || status.statusMessage || (status.agentActivity ? `${status.agentActivity.label} 正在执行…` : status.toolActivity.length ? '正在处理工具调用…' : '正在思考…'), at: null, attachments: [], toolActivity: status.toolActivity, agentActivity: status.agentActivity, error: null, cancelled: false }
    });
    if (keepSettlingReply && settlingReply) rows.push({ id: 'streaming', kind: 'streaming',
      message: { id: 'streaming', role: 'assistant', text: settlingReply.text, at: null,
        attachments: [], toolActivity: [], agentActivity: null, error: null, cancelled: false } });
    if (status.error && !streaming) rows.push({ id: 'turn-error', kind: 'turn-error', message: status.error });
    rows.push(...approvals.map(approval => ({ id: `approval:${approval.id}`, kind: 'approval' as const, approval })));
    return rows;
  }, [hasMoreHistory, messages, loading, error, streaming, keepSettlingReply, settlingReply, status.displayText, status.statusMessage, status.agentActivity, status.toolActivity, status.error, approvals]);

  useLayoutEffect(() => {
    const hasNewConversationContent =
      messages.some(message => !seenMessageIdsRef.current.has(message.id)) ||
      (streaming && (
        !['streaming', 'cancelling'].includes(previousStreamRef.current.state) ||
        status.displayText !== previousStreamRef.current.text
      ));
    seenMessageIdsRef.current = new Set(messages.map(message => message.id));
    previousStreamRef.current = { state: status.state, text: status.displayText };
    if (skipAutomaticScrollRef.current) {
      skipAutomaticScrollRef.current = false;
      return;
    }
    if (isAtBottomRef.current) {
      setHasNewMessages(false);
      virtualListRef.current?.scrollToBottom();
    } else if (hasNewConversationContent) {
      setHasNewMessages(true);
    }
  }, [timelineItems, messages, streaming, status.state, status.displayText]);

  const renderTimelineItem = (item: ChatTimelineItem) => {
    switch (item.kind) {
      case 'load-earlier': return <div className="chat-load-earlier"><Button compact variant="ghost" disabled={loadingOlder} onClick={() => void loadOlderHistory()}>{loadingOlder ? '正在加载更早消息…' : '加载更早消息'}</Button></div>;
      case 'loading': return <LoadingState label="正在读取会话…" />;
      case 'error': return <ErrorNotice error={item.message} onRetry={() => void load()} />;
      case 'empty': return <EmptyNotice icon="chat" title="还没有消息" detail="写下你要处理的事情。模型和 Agent 会按会话设置运行。" />;
      case 'message': return <MessageBubble message={item.message} sendError={sendErrors[item.message.id]} onRetry={sendErrors[item.message.id] ? () => void retrySend(item.message.id) : undefined} />;
      case 'streaming': return <MessageBubble message={item.message} streaming />;
      case 'turn-error': return <div className="turn-error" role="alert">{item.message}<div className="row">{linkedTask && (/needs-reconciliation|interrupted after Core restart/i.test(linkedTask.progress.note) || ['NEEDS_RECONCILIATION', 'TASK_RECOVERY_REVIEW_REQUIRED'].includes(status.errorCode ?? '')) ? <Button compact variant="ghost" onClick={() => onReviewTask(linkedTask.id)}>核对任务后恢复</Button> : <><Button compact variant="ghost" onClick={() => void chatClient.retry(session!.id).then(load).catch(cause => setError(messageOf(cause)))}>重试</Button><Button compact variant="ghost" onClick={() => void chatClient.continue(session!.id).then(load).catch(cause => setError(messageOf(cause)))}>继续</Button></>}</div></div>;
      case 'approval': return <ApprovalCard approval={item.approval} onDecide={decideApproval} />;
    }
  };

  async function send(text: string, attachments: { name: string; content: string; mimeType?: string }[], clientMessageId: string) {
    if (!session) return;
    const historyCursorBeforeSend = lastHistoryMessageIdRef.current;
    setError('');
    pendingSendsRef.current.set(clientMessageId, { text, attachments });
    setMessages(current => current.some(message => message.id === clientMessageId) ? current : mergeLatestChatMessages(current, [{
      id: clientMessageId, role: 'user', text, at: Date.now(), attachments: attachments.map(item => item.name), toolActivity: [], error: null, cancelled: false
    }]));
    try {
      await chatClient.send(session.id, text, attachments, clientMessageId);
      pendingSendsRef.current.delete(clientMessageId);
      setSendErrors(current => { const next = { ...current }; delete next[clientMessageId]; return next; });
      void refreshHistory(historyCursorBeforeSend);
    } catch (cause) {
      const message = messageOf(cause);
      setSendErrors(current => ({ ...current, [clientMessageId]: message }));
      setError(message);
    }
  }
  async function retrySend(messageId: string) {
    const pending = pendingSendsRef.current.get(messageId);
    if (pending) await send(pending.text, pending.attachments, messageId);
    else if (session) {
      try { await chatClient.retry(session.id); setSendErrors(current => { const next = { ...current }; delete next[messageId]; return next; }); void load(); }
      catch (cause) { setError(messageOf(cause)); }
    }
  }
  async function updateAgent(provider: string) {
    if (!session) return;
    try {
      const updated = await chatClient.setConfig(session.id, { ...session.config, agentProvider: provider || null });
      onSessionUpdate(updated);
      await load();
    }
    catch (cause) { setError(messageOf(cause)); }
  }
  async function updateModel(provider: string, model: string) {
    if (!session) return;
    try { onSessionUpdate(await chatClient.setConfig(session.id, { ...session.config, modelProvider: provider, model })); await load(); }
    catch (cause) { setError(messageOf(cause)); }
  }
  async function updateWorkspace(workspaceId: string) {
    if (!session) return;
    try {
      onSessionUpdate(await chatClient.setConfig(session.id, { ...session.config, workspaceId: workspaceId || null }));
      setError('');
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function decideApproval(id: string, approve: boolean) {
    try {
      const result = await approvalClient.decide(id, approve);
      await load();
      if (result.resumeError) setError(`审批已记录，但聊天回合继续失败（${result.resumeError}）。`);
    }
    catch (cause) { setError(messageOf(cause)); }
  }

  if (!session) return <div className="content-page chat-empty-page"><EmptyNotice icon="chat" title="开始一段新会话" detail="会话记录保存在本机 Core 中。发送消息后，当前配置的模型与 Agent 将处理请求。" action={<Button variant="primary" icon="add" onClick={() => void onNew()}>新建会话</Button>} /></div>;
  const providers = catalog?.modelProviders ?? [];
  const selectedProvider = providers.find(provider => provider.id === session.config.modelProvider) ?? providers.find(provider => provider.configured) ?? providers[0];
  const selectedModelKey = JSON.stringify([session.config.modelProvider ?? selectedProvider?.id ?? '', session.config.model || '']);
  return <div className={`chat-workspace ${contextCollapsed ? 'context-collapsed' : ''}`}>
    <section className="conversation-pane">
      <div className="conversation-toolbar"><div><p className="eyebrow">CETAMESH · CHAT</p><h1>{session.title || '新会话'}</h1><div className="conversation-meta"><StatusBadge value={status.state || 'idle'} /><span>更新于 {relativeLabel(session.updatedAt)}</span><span>·</span><ChatCatalogStatus catalog={catalog} /></div></div><div className="row"><IconButton label={contextCollapsed ? '显示运行上下文' : '隐藏运行上下文'} icon="work" onClick={toggleContext} /><IconButton label="刷新会话" icon="update" onClick={() => void load()} /><IconButton label="新建会话" icon="add" onClick={() => void onNew()} /></div></div>
      <VirtualList
        items={timelineItems}
        estimateSize={112}
        height="100%"
        getItemKey={chatTimelineKey}
        isAnchorable={isChatMessageAnchor}
        controllerRef={virtualListRef}
        onScrollStateChange={atBottom => {
          isAtBottomRef.current = atBottom;
          if (atBottom) setHasNewMessages(false);
        }}
        overlay={hasNewMessages ? <Button compact variant="ghost" onClick={() => {
          setHasNewMessages(false);
          isAtBottomRef.current = true;
          virtualListRef.current?.scrollToBottom();
        }}>有新消息 · 跳到最新</Button> : null}
        render={renderTimelineItem}
      />
      <div className="composer-dock"><ChatComposer busy={streaming} models={providers} selectedModelKey={selectedModelKey} agentProviders={catalog?.agentProviders ?? []} selectedAgent={session.config.agentProvider ?? ''} workspaces={workspaces} workspaceId={session.config.workspaceId ?? ''} activeWorkspaceId={activeWorkspaceId} onWorkspaceChange={updateWorkspace} onModelChange={value => { try { const [provider, model] = JSON.parse(value) as [string, string]; void updateModel(provider, model); } catch { setError('无法识别所选模型。'); } }} onAgentChange={updateAgent} onSend={send} onStop={() => void chatClient.stop(session.id).then(load).catch(cause => setError(messageOf(cause)))} /></div>
    </section>
    {!contextCollapsed && <ChatContextPanel task={linkedTask} memories={memories} approvals={approvals} onOpenMemory={onOpenMemory} />}
  </div>;
}

export function MessageBubble({ message, streaming = false, sendError, onRetry }: { message: ChatMessageDto; streaming?: boolean; sendError?: string; onRetry?(): void }) {
  const role = message.role === 'user' ? 'user' : 'assistant';
  const agentActivity = message.agentActivity;
  return <article className={`chat-message ${role} ${streaming ? 'streaming' : ''}`}><div className="message-avatar">{role === 'assistant' ? <Icon name="sparkles" size={16} /> : '你'}</div><div className="message-body"><div className="message-meta"><strong>{role === 'assistant' ? 'CetaMesh' : '你'}</strong><span>{dateLabel(message.at)}</span>{streaming && <Badge tone="accent">生成中</Badge>}</div>{agentActivity && <div className={`agent-activity ${agentActivity.status}`} role="status"><Icon name={agentActivity.status === 'running' ? 'sparkles' : agentActivity.status === 'completed' ? 'check' : 'help'} size={15} /><span>{agentActivity.label}</span><strong>{agentActivityStatusLabel(agentActivity.status)}</strong></div>}{message.text ? <Markdown>{message.text}</Markdown> : <span className="muted">（没有文本内容）</span>}{message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map(name => <span key={name}><Icon name="attach" size={13} />{name}</span>)}</div>}{message.toolActivity.map(tool => <details key={tool.id} className="tool-call"><summary><Icon name={tool.status === 'cancelled' ? 'close' : tool.status === 'failed' ? 'help' : tool.status === 'running' ? 'update' : 'check'} size={15} /><span>{tool.label || tool.id}</span><span className="tool-duration">{tool.status === 'cancelled' ? '已取消' : tool.durationMs === null ? taskStatusLabel(tool.status) : `${(tool.durationMs / 1000).toFixed(1)} 秒`}</span><Icon name="down" size={14} /></summary>{tool.summary && <p>{tool.summary}</p>}</details>)}{sendError && <div className="message-error" role="alert">{sendError}<Button compact variant="ghost" onClick={onRetry}>重试发送</Button></div>}{message.error && <p className="message-error" role="alert">{message.error}</p>}{message.cancelled && <small>本轮已停止</small>}</div></article>;
}

function ApprovalCard({ approval, onDecide }: { approval: Approval; onDecide(id: string, approve: boolean): void }) {
  return <Card className="approval-card"><div className="approval-icon"><Icon name="approval" size={20} /></div><div className="grow"><div className="row between"><strong>{approval.title}</strong><Badge tone="warning">需要处理</Badge></div><p>{approval.summary}</p><div className="approval-meta"><span>{approval.capability}</span><span>风险：{approval.risk}</span>{approval.expiresAt && <span>有效至 {dateLabel(approval.expiresAt)}</span>}</div><div className="row approval-actions"><Button compact variant="ghost" onClick={() => onDecide(approval.id, false)}>拒绝</Button><Button compact variant="primary" onClick={() => onDecide(approval.id, true)}>批准一次</Button></div></div></Card>;
}

function ChatComposer({ busy, models, selectedModelKey, agentProviders, selectedAgent, workspaces, workspaceId, activeWorkspaceId, onWorkspaceChange, onModelChange, onAgentChange, onSend, onStop }: {
  busy: boolean; models: { id: string; label: string; configured: boolean; models: { id?: string; name?: string; label?: string; displayName?: string; modelName?: string }[] }[];
  selectedModelKey: string; agentProviders: Agent[]; selectedAgent: string;
  workspaces: { id: string; name: string; status: string }[]; workspaceId: string; activeWorkspaceId: string | null;
  onWorkspaceChange(workspaceId: string): void; onModelChange(value: string): void; onAgentChange(provider: string): void;
  onSend(text: string, attachments: { name: string; content: string; mimeType?: string }[], clientMessageId: string): void; onStop(): void;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; content: string; mimeType?: string }[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [picking, setPicking] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const modelChoices: { value: string; label: string; disabled?: boolean }[] = models.flatMap(provider => {
    if (!provider.configured) return [];
    const list = provider.models.length ? provider.models : [{ id: '', name: provider.label, label: provider.label }];
    return list.map(model => ({
      value: JSON.stringify([provider.id, normalizeSelectOptionLabel(model.id, model.name, model.modelName, provider.id)]),
      label: normalizeSelectOptionLabel(model.displayName, model.label, model.name, model.modelName, model.id, provider.label, provider.id)
    }));
  });
  if (selectedModelKey && !modelChoices.some(choice => choice.value === selectedModelKey)) {
    let selectedLabel = selectedModelKey;
    let availability = '不可用';
    try {
      const [providerId, modelId] = JSON.parse(selectedModelKey) as [string, string];
      const provider = models.find(item => item.id === providerId);
      const selected = provider?.models.find(item => item.id === modelId);
      selectedLabel = normalizeSelectOptionLabel(selected?.displayName, selected?.label, selected?.name, selected?.modelName, modelId, provider?.label, providerId);
      if (provider && !provider.configured) availability = '未配置';
    } catch { /* Keep the serialized selection visible as a safe fallback label. */ }
    modelChoices.push({ value: selectedModelKey, label: `${selectedLabel} · ${availability}`, disabled: true });
  }
  async function addFiles() {
    setAttachmentError(''); setPicking(true);
    try { const result = await hostClient.pickFiles(); setAttachments(current => [...current, ...result.attachments].slice(0, 8)); }
    catch (error) { setAttachmentError(messageOf(error)); }
    finally { setPicking(false); textarea.current?.focus(); }
  }
  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text, attachments, crypto.randomUUID());
    setDraft(''); setAttachments([]);
  }
  return <div className="chat-composer"><div className="composer-field"><textarea ref={textarea} aria-label="输入消息" placeholder="告诉 CetaMesh 你想做什么。" value={draft} rows={2} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} /><div className="composer-bottom"><div className="row composer-controls"><IconButton label="添加文本或源码附件" icon="attach" onClick={() => void addFiles()} disabled={picking || busy} /><Select label="任务工作区" value={workspaceId} onChange={event => onWorkspaceChange(event.target.value)}><option value="">自动（当前工作区{activeWorkspaceId ? '' : '，未指定'}）</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{normalizeSelectOptionLabel(workspace.name, workspace.id)}</option>)}</Select><Select label="选择 Agent" value={selectedAgent} onChange={event => onAgentChange(event.target.value)}><option value="">能力</option><option value="none">不使用 Agent</option>{agentProviders.map(agent => { const needsScope = ['task-required', 'workspace-required'].includes(agent.reason ?? ''); const disabled = !agent.available || (!agent.eligible && !needsScope); const state = agent.eligible ? '' : availabilityReasonLabel(agent.reason) || availabilityReasonLabel(agent.status) || (agent.available ? '当前不可使用' : '不可用'); return <option key={agent.id} value={agent.id} disabled={disabled}>{normalizeSelectOptionLabel(agent.name, agent.id)}{state ? ` · ${state}` : ''}</option>; })}{selectedAgent && !agentProviders.some(agent => agent.id === selectedAgent) && <option value={selectedAgent} disabled>{normalizeSelectOptionLabel(selectedAgent)} · 不可用</option>}</Select><Select label="选择模型" value={selectedModelKey} onChange={event => onModelChange(event.target.value)} disabled={!modelChoices.length}>{modelChoices.length ? modelChoices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>) : <option value="">暂无已配置模型</option>}</Select></div>{busy ? <Button variant="danger" icon="square" onClick={onStop}>停止</Button> : <Button variant="primary" icon="send" onClick={submit} disabled={!draft.trim()}>发送</Button>}</div>{attachments.length > 0 && <div className="attachment-list">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><Icon name="file" size={13} />{file.name}<button aria-label={`移除 ${file.name}`} onClick={() => setAttachments(current => current.filter((_, item) => item !== index))}><Icon name="close" size={13} /></button></span>)}</div>}{attachmentError && <p className="inline-error" role="alert">{attachmentError}</p>}</div><div className="composer-footnote">消息与附件通过本机 Core 处理，附件总大小上限 128 KiB。</div></div>;
}

function ChatContextPanel({ task, memories, approvals, onOpenMemory }: { task: Task | null; memories: Memory[]; approvals: Approval[]; onOpenMemory(): void }) {
  return <aside className="chat-context"><div className="context-heading"><div><p className="eyebrow">运行上下文</p><h2>任务详情</h2></div></div>
    {task ? <Card className="context-task"><div className="row between"><StatusBadge value={task.status} /><Icon name="work" size={17} /></div><h3>{task.title}</h3><p>{task.currentPhase || task.progress.note || task.goal}</p><div className="context-progress" role="progressbar" aria-label="任务进度" aria-valuenow={task.progress.percent} aria-valuemin={0} aria-valuemax={100}><span className={`progress-${Math.round(task.progress.percent / 25) * 25}`} /></div><div className="row between"><small>执行进度</small><small>{task.progress.percent}%</small></div><Divider /><div className="context-agent"><span className="agent-avatar">{agentInitials(task.agent ?? 'CM')}</span><span className="grow"><strong>{task.agent ?? '待分配'}</strong><small>{task.workspaceId ? '工作区任务' : '未绑定工作区'}</small></span><StatusBadge value={task.status} /></div></Card> : <Surface className="context-section"><EmptyNotice icon="work" title="没有关联任务" detail="任务会在由会话创建或分配后显示在这里。" /></Surface>}
    <Surface className="context-section"><div className="section-heading"><h3>审批</h3><Badge>{approvals.length}</Badge></div>{approvals.length ? approvals.slice(0, 2).map(item => <div className="context-approval" key={item.id}><strong>{item.title}</strong><small>{item.summary}</small><small>{item.capability}</small></div>) : <p className="muted context-note">当前没有待处理审批。</p>}</Surface>
    <Surface className="context-section"><div className="section-heading"><h3>相关记忆</h3><button className="text-link" onClick={onOpenMemory}>查看全部</button></div>{memories.length ? memories.slice(0, 2).map(memory => <button className="memory-ref" key={memory.id} onClick={onOpenMemory}><Icon name="memory" size={16} /><span><strong>{memory.title}</strong><small>{memory.scope} · {relativeLabel(memory.updatedAt)}</small></span></button>) : <p className="muted context-note">没有找到相关记忆。</p>}</Surface>
    <Surface className="context-section"><div className="section-heading"><h3>交付物</h3><Badge>{task?.artifacts.length ?? 0}</Badge></div>{task?.artifacts.length ? task.artifacts.slice(0, 4).map(artifact => <ArtifactCard key={artifact.id} taskId={task.id} artifact={artifact} />) : <EmptyNotice icon="file" title="暂无交付物" detail={task ? '任务尚未生成交付物。' : '关联任务生成交付物后会显示在这里。'} />}</Surface>

  </aside>;
}

function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [candidates, setCandidates] = useState<import('../bridge/typed-client').MemoryCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [candidateCapacity, setCandidateCapacity] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; status: string; lastActivity: string | number | null }[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [category, setCategory] = useState('recent');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [memoryResult, workspaceResult] = await Promise.all([
        memoryClient.overview(query, '', 200, 0, category === 'preferences' ? ['user'] : category === 'project' ? ['workspace'] : category === 'knowledge' ? ['knowledge', 'skill'] : undefined),
        workspaceClient.list().catch(() => ({ workspaces: [], activeId: null }))
      ]);
      setMemories(memoryResult.memories);
      setCandidates(memoryResult.candidates);
      setTotal(memoryResult.total);
      setCandidateCapacity(memoryResult.candidateMeta?.remaining ?? null);
      setWorkspaces(workspaceResult.workspaces);
      setWorkspaceId(current => current || workspaceResult.activeId || workspaceResult.workspaces[0]?.id || '');
      setError(memoryResult.recovery?.failed?.length ? '部分记忆确认仍在恢复中，请检查存储后刷新。' : '');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, [category, query]);
  useEffect(() => {
    void refresh();
    return bridge.subscribe('memory.updated', () => { void refresh(); });
  }, [refresh]);
  const filtered = useMemo(() => {
    const recent = [...memories].sort((left, right) => {
      const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime() || 0;
      const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime() || 0;
      return rightTime - leftTime;
    });
    if (category === 'preferences') return recent.filter(item => item.type === 'user');
    if (category === 'project') return recent.filter(item => item.type === 'workspace' || item.scope.startsWith('workspace:'));
    if (category === 'knowledge') return recent.filter(item => item.type === 'knowledge' || item.type === 'skill');
    return recent;
  }, [memories, category]);
  const createType = category === 'preferences' ? 'user' : category === 'project' ? 'workspace' : 'knowledge';
  const createScope = category === 'preferences' ? 'user:desktop' : category === 'project' ? (workspaceId ? 'workspace:' + workspaceId : '') : 'global';
  async function decideCandidates(decision: 'accept' | 'reject', ids: string[]) {
    try {
      const result = await memoryClient.confirmBatch(ids, decision);
      const errors = result.results.filter(row => row.error);
      setSelectedCandidates([]);
      await refresh();
      if (errors.length) setError(`${errors.length} 条候选未处理：${errors[0].error?.message}`);
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function loadMore() {
    try {
      const result = await memoryClient.overview(query, '', 200, memories.length,
        category === 'preferences' ? ['user'] : category === 'project' ? ['workspace'] : category === 'knowledge' ? ['knowledge', 'skill'] : undefined);
      setMemories(current => [...current, ...result.memories]);
      setTotal(result.total);
    } catch (cause) { setError(messageOf(cause)); }
  }
  return <div className="content-page memory-page">
    <Heading eyebrow="MEMORY" title="记忆" description="管理偏好、项目记忆、已保存知识与最近引用。" action={<Button icon="update" onClick={() => void refresh()}>刷新</Button>} />
    {error && <ErrorNotice error={error} onRetry={() => void refresh()} />}
    <SearchInput label="搜索全部记忆" placeholder="搜索历史记忆" value={query} onChange={event => setQuery(event.target.value)} />
    {candidates.some(row => row.status === 'pending' || row.status === 'confirming') && <section className="memory-candidates"><h3>待确认记忆（{candidates.filter(row => row.status === 'pending').length}）</h3>
      <p className="muted">候选尚未保存为长期记忆；批准后才会在新会话中使用。</p>
      {candidateCapacity === 0 && <p className="muted">候选容量已满。请先处理待确认项；新的提议会明确报错，不会静默丢弃。</p>}
      <div className="row"><Button compact disabled={!selectedCandidates.length} onClick={() => void decideCandidates('accept', selectedCandidates)}>批准选中</Button><Button compact disabled={!selectedCandidates.length} onClick={() => void decideCandidates('reject', selectedCandidates)}>拒绝选中</Button></div>
      {candidates.filter(candidate => candidate.status === 'pending' || candidate.status === 'confirming').map(candidate => <article className="memory-item" key={candidate.id}><label><input type="checkbox" disabled={candidate.status !== 'pending'} checked={selectedCandidates.includes(candidate.id)} onChange={event => setSelectedCandidates(current => event.target.checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))} /> {candidate.content}</label><small>{candidate.scope} · {candidate.reason} · {candidate.status}</small>{candidate.status === 'pending' && <div className="row"><Button compact onClick={() => void decideCandidates('accept', [candidate.id])}>批准</Button><Button compact onClick={() => void decideCandidates('reject', [candidate.id])}>拒绝</Button></div>}</article>)}
    </section>}
    {candidates.some(row => row.status === 'accepted' || row.status === 'rejected') && <section className="memory-candidates"><h3>最近处理的候选</h3>{candidates.filter(row => row.status === 'accepted' || row.status === 'rejected').slice(0, 20).map(candidate => <article className="memory-item" key={candidate.id}><p>{candidate.content}</p><small>{candidate.scope} · {candidate.status === 'accepted' ? '已批准' : '已拒绝'} · {candidate.reason}</small></article>)}</section>}
    <Tabs items={[{ id: 'preferences', label: '偏好' }, { id: 'project', label: '项目记忆' }, { id: 'knowledge', label: '已保存知识' }, { id: 'recent', label: '最近' }]} selected={category} onChange={setCategory} label="记忆分类" />
    {category === 'project' && <label className="memory-workspace-picker">项目工作区<select className="cm-input" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">选择工作区</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{normalizeSelectOptionLabel(workspace.name, workspace.id)}</option>)}</select></label>}
    {category === 'project' && !workspaces.length && <p className="muted">先创建工作区，再保存项目记忆。</p>}
    {loading ? <LoadingState label="正在读取本机记忆…" /> : <MemoryManager initial={filtered} createType={createType} createScope={createScope} createDisabled={category === 'project' && !workspaceId} onChanged={refresh} />}
    {memories.length < total && <Button onClick={() => void loadMore()}>加载更多（{memories.length}/{total}）</Button>}
  </div>;
}

function MemoryManager({ initial, onChanged, createType = 'knowledge', createScope = 'global', createDisabled = false }: { initial: Memory[]; onChanged(): Promise<void> | void; createType?: string; createScope?: string; createDisabled?: boolean }) {
  const [memories, setMemories] = useState(initial);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editDraft, setEditDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [allLoaded, setAllLoaded] = useState(false);
  async function refresh(search = query) {
    setBusy(true);
    try { const result = await memoryClient.overview(search); setMemories(result.memories); setError(''); setAllLoaded(true); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  useEffect(() => { setMemories(initial); }, [initial]);
  const shown = useMemo(() => memories.filter(item => `${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [memories, query]);
  async function create() {
    if (!draft.trim()) return;
    setBusy(true);
    try { await memoryClient.create({ type: createType, scope: createScope, content: draft.trim() }); setDraft(''); await onChanged(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function change(memory: Memory, action: 'pin' | 'delete') {
    setError('');
    try {
      if (action === 'pin') await memoryClient.pin(memory.id, !memory.pinned, memory.rev ?? undefined);
      else if (window.confirm(`删除记忆“${memory.title}”？此操作不可撤销。`)) await memoryClient.remove(memory.id, memory.rev ?? undefined);
      await onChanged();
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function saveEdit(memory: Memory) {
    if (!editDraft.trim()) return;
    setBusy(true); setError('');
    try {
      await memoryClient.update({ id: memory.id, expectedRev: memory.rev ?? undefined, content: editDraft.trim(), tags: memory.tags, pinned: memory.pinned });
      setEditingId(''); setEditDraft(''); await onChanged();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  return <div className="memory-manager"><p className="muted">记忆由本机 Memory 服务管理，可搜索、编辑、固定或删除。</p><SearchInput label="搜索记忆" placeholder="搜索记忆内容" value={query} onChange={event => setQuery(event.target.value)} /><div className="memory-create"><textarea aria-label="新建记忆内容" placeholder="添加一条需要长期保留的记忆" value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={4000} /><Button compact variant="primary" onClick={() => void create()} disabled={busy || !draft.trim() || createDisabled}>保存记忆</Button></div>{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}{busy && <LoadingState />}{shown.length ? <div className="memory-list">{shown.map(memory => <article className="memory-item" key={memory.id}><div className="row between"><strong>{memory.title}</strong><div className="row"><Button compact variant="ghost" onClick={() => { setEditingId(memory.id); setEditDraft(memory.content); }}>编辑记忆</Button><IconButton label={memory.pinned ? '取消固定记忆' : '固定记忆'} icon="approval" compact onClick={() => void change(memory, 'pin')} /><IconButton label="删除记忆" icon="close" compact onClick={() => void change(memory, 'delete')} /></div></div>{editingId === memory.id ? <div className="memory-edit"><textarea className="cm-textarea" aria-label="编辑记忆内容" value={editDraft} onChange={event => setEditDraft(event.target.value)} rows={4} maxLength={4000} /><div className="row"><Button compact onClick={() => { setEditingId(''); setEditDraft(''); }}>取消</Button><Button compact variant="primary" disabled={busy || !editDraft.trim()} onClick={() => void saveEdit(memory)}>保存更改</Button></div></div> : <p>{memory.content}</p>}<small>{memory.scope} · {relativeLabel(memory.updatedAt)}</small></article>)}</div> : !busy && <EmptyNotice icon="memory" title={allLoaded ? '没有匹配的记忆' : '没有相关记忆'} detail="记忆只会在本地 Memory 服务中创建并保存。" />}</div>;
}

function WorkPage({ workspaces, onRefreshWorkspaces, reviewTaskId, onReviewTaskOpened }: { workspaces: { id: string; name: string; status: string; lastActivity: string | number | null }[]; onRefreshWorkspaces(): Promise<void>; reviewTaskId: string | null; onReviewTaskOpened(): void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskSheet, setTaskSheet] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [handoffProviders, setHandoffProviders] = useState<{ id: string; name: string; eligible: boolean; reason: string | null }[]>([]);
  const selectedTaskIdRef = useRef('');
  selectedTaskIdRef.current = selectedTask?.id ?? '';
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await taskClient.overview(query, filter);
      setTasks(result.tasks);
      const selectedId = selectedTaskIdRef.current;
      if (selectedId) setSelectedTask(await taskClient.get(selectedId).then(value => value.task).catch(() => null));
      setError('');
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { if (!quiet) setLoading(false); }
  }, [query, filter]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!reviewTaskId) return;
    void taskClient.get(reviewTaskId).then(value => { setSelectedTask(value.task); onReviewTaskOpened(); }).catch(cause => setError(messageOf(cause)));
  }, [reviewTaskId, onReviewTaskOpened]);
  useEffect(() => { void agentClient.list().then(value => setHandoffProviders(value.agents.map(agent => ({ id: agent.id, name: agent.name, eligible: agent.taskEligible, reason: agent.reason ?? agent.lastError })))).catch(() => setHandoffProviders([])); }, []);
  useEffect(() => {
    const off = bridge.subscribe('task.updated', () => { void refresh(true); });
    const timer = window.setInterval(() => { void refresh(true); }, 3000);
    return () => { window.clearInterval(timer); off(); };
  }, [refresh]);
  async function openTask(task: Task) {
    try { setSelectedTask((await taskClient.get(task.id)).task); }
    catch (cause) { setError(messageOf(cause)); setSelectedTask(task); }
  }
  async function taskAction(task: Task, action: 'start' | 'pause' | 'resume' | 'cancel', agentProvider?: string) {
    if (action === 'cancel' && !window.confirm(`取消任务“${task.title}”？`)) return;
    try {
      const result = action === 'start' ? await taskClient.start(task.id, task.rev ?? undefined, agentProvider)
        : action === 'pause' ? await taskClient.pause(task.id, task.rev ?? undefined)
        : action === 'resume' ? await taskClient.resume(task.id, task.rev ?? undefined)
          : await taskClient.cancel(task.id, task.rev ?? undefined);
      setSelectedTask(result.task);
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function handoffTask(task: Task, provider: string) {
    try {
      const result = await taskClient.handoff(task.id, provider, task.rev ?? undefined);
      setSelectedTask(result.task);
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function reconcileTask(task: Task, reviewSummary: string, nextInstruction: string) {
    try {
      const result = await taskClient.reconcile(task.id, task.rev ?? undefined,
        reviewSummary, nextInstruction, crypto.randomUUID());
      setSelectedTask(result.task);
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function addWorkspace() {
    setWorkspaceError('');
    try {
      const picked = await hostClient.pickFolder();
      if (!picked.path) return;
      const fallback = picked.path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '本地工作区';
      const name = workspaceName.trim() || fallback;
      setWorkspaceBusy(true);
      await workspaceClient.create(name, picked.path);
      setWorkspaceName('');
      await onRefreshWorkspaces();
    } catch (cause) { setWorkspaceError(messageOf(cause)); }
    finally { setWorkspaceBusy(false); }
  }
  const counts = useMemo(() => ({ all: tasks.length, working: tasks.filter(task => ['working', 'running'].includes(task.status)).length, waiting: tasks.filter(task => task.status.includes('waiting')).length, completed: tasks.filter(task => task.status === 'completed').length }), [tasks]);
  return <div className="content-page"><Heading eyebrow="WORKSPACE" title="工作" description="查看跨会话任务的进展、负责人和下一步。" action={<Button icon="add" variant="primary" onClick={() => setTaskSheet(true)}>新建任务</Button>} />
    {error && <ErrorNotice error={error} onRetry={() => void refresh()} />}
    <div className="row between work-controls"><Tabs items={[{ id: '', label: `全部 ${counts.all}` }, { id: 'running', label: `运行中 ${counts.working}` }, { id: 'waiting', label: `待处理 ${counts.waiting}` }, { id: 'completed', label: `已完成 ${counts.completed}` }]} selected={filter} onChange={setFilter} label="按任务状态筛选" /><SearchInput label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {loading && !tasks.length ? <LoadingState label="正在读取任务…" /> : tasks.length ? <div className="task-grid">{tasks.map(task => <TaskCard key={task.id} task={task} onOpen={() => void openTask(task)} onAction={action => void taskAction(task, action)} />)}</div> : !error && <EmptyNotice icon="work" title={query || filter ? '没有匹配的任务' : '还没有任务'} detail="你可以在这里创建任务并查看 Core 与 Agent 的执行进度。" action={<Button variant="primary" icon="add" onClick={() => setTaskSheet(true)}>新建任务</Button>} />}
    <WorkshopInbox providers={handoffProviders} />
    <div className="section-heading page-section-heading"><h2>最近工作区</h2><div className="row"><Input aria-label="工作区名称" placeholder="工作区名称（可选）" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} /><Button compact icon="add" onClick={() => void addWorkspace()} disabled={workspaceBusy}>{workspaceBusy ? '添加中…' : '添加工作区'}</Button></div></div>
    {workspaceError && <ErrorNotice error={workspaceError} />}{workspaces.length ? <div className="workspace-grid">{workspaces.map(workspace => <Card className="workspace-card" key={workspace.id}><div className="workspace-badge">CM</div><div className="workspace-card-body"><strong>{workspace.name}</strong><p>{workspace.status} · 最近活动 {relativeLabel(workspace.lastActivity)}</p></div><StatusBadge value={workspace.status} /></Card>)}</div> : <Surface className="workspace-empty"><p className="muted">尚未登记工作区。添加工作区时会使用 Windows 原生文件夹选择器。</p></Surface>}
    <Sheet open={taskSheet} title="新建任务" onClose={() => setTaskSheet(false)}><TaskCreateForm workspaces={workspaces} providers={handoffProviders} onCreated={async () => { setTaskSheet(false); await refresh(); }} /></Sheet>
    <Sheet open={Boolean(selectedTask)} title={selectedTask?.title ?? '任务详情'} onClose={() => setSelectedTask(null)}>{selectedTask && <TaskDetails task={selectedTask} providers={handoffProviders} onHandoff={provider => void handoffTask(selectedTask, provider)} onAction={action => void taskAction(selectedTask, action)} onStart={provider => void taskAction(selectedTask, 'start', provider)} onReconcile={(summary, instruction) => void reconcileTask(selectedTask, summary, instruction)} />}</Sheet>
  </div>;
}

function WorkshopInbox({ providers }: { providers: { id: string; name: string; eligible: boolean; reason: string | null }[] }) {
  const [proposals, setProposals] = useState<WorkshopProposal[]>([]);
  const [selected, setSelected] = useState<WorkshopProposal | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [provider, setProvider] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [deliveryLabel, setDeliveryLabel] = useState('');
  const [deliveryContent, setDeliveryContent] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const deliveryRequest = useRef<{ content: string; id: string } | null>(null);
  const refresh = useCallback(async () => {
    try { setProposals((await workshopClient.proposals()).proposals); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh(); }, 5000); return () => window.clearInterval(timer); }, [refresh]);
  async function open(id: string) {
    try {
      const proposal = (await workshopClient.proposal(id)).proposal;
      setSelected(proposal); setWorkspaceName(proposal.plan?.workspace.name ?? proposal.title);
      setWorkspaceRoot(proposal.plan?.workspace.root ?? ''); setProvider(proposal.plan?.provider ?? '');
      setCapabilities(proposal.plan?.capabilities ?? []); setReason(''); setDeliveryLabel(''); setDeliveryContent('');
      setTaskStatus(proposal.taskId ? (await workshopClient.taskStatus(id)).task?.status ?? '' : ''); setError('');
    } catch (cause) { setError(messageOf(cause)); }
  }
  async function act(action: 'approve' | 'reject' | 'retry' | 'deliver') {
    if (!selected) return;
    if (action === 'approve' && !window.confirm(`批准“${selected.title}”并创建工作区及任务？`)) return;
    if (action === 'deliver' && !window.confirm(`向 ${selected.submitter.id} 交付“${deliveryLabel}”？`)) return;
    setBusy(true); setError('');
    try {
      let result: { proposal: WorkshopProposal };
      if (action === 'approve') result = await workshopClient.review(selected.id, true, reason, {
        workspace: { name: workspaceName.trim(), root: workspaceRoot, createIfMissing: true }, provider, capabilities });
      else if (action === 'reject') result = await workshopClient.review(selected.id, false, reason);
      else if (action === 'retry') result = await workshopClient.retry(selected.id);
      else {
        const fingerprint = JSON.stringify([selected.id, deliveryLabel, deliveryContent]);
        if (deliveryRequest.current?.content !== fingerprint) deliveryRequest.current = { content: fingerprint, id: crypto.randomUUID() };
        result = await workshopClient.deliver(selected.id, deliveryLabel.trim(), deliveryContent, deliveryRequest.current.id);
        deliveryRequest.current = null;
      }
      setSelected(result.proposal);
      setTaskStatus(result.proposal.taskId ? (await workshopClient.taskStatus(result.proposal.id)).task?.status ?? '' : '');
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  const toggleCapability = (capability: string) => setCapabilities(current => current.includes(capability)
    ? current.filter(item => item !== capability) : [...current, capability]);
  return <section aria-label="Workshop 提议"><div className="section-heading page-section-heading"><h2>Workshop 提议</h2><Button compact variant="ghost" onClick={() => void refresh()}>刷新</Button></div>
    <p className="muted">外部提议先由 Owner 审查；批准时明确选择工作区、执行者和能力。</p>
    {error && <ErrorNotice error={error} />}
    {proposals.length ? <div className="task-grid">{proposals.map(item => <Card className="task-card" key={item.id}><div className="row between"><strong>{item.title}</strong><StatusBadge value={item.status} /></div><p>{item.description}</p><small>{item.submitter.id} · {dateLabel(item.updatedAt)}</small><div><Button compact variant="ghost" onClick={() => void open(item.id)}>审查与交付</Button></div></Card>)}</div>
      : <Surface className="workspace-empty"><p className="muted">暂无外部提议。</p></Surface>}
    <Sheet open={Boolean(selected)} title={selected?.title ?? 'Workshop 提议'} onClose={() => setSelected(null)}>{selected && <div className="task-details">
      <div className="row between"><StatusBadge value={selected.status} /><small>提交者 {selected.submitter.id}</small></div>
      <p>{selected.description}</p>{selected.requirements.map((item, index) => <p key={index}>· {item}</p>)}
      {selected.supplements.map(item => <p key={item.id}>补充：{item.text}</p>)}
      {selected.review && <p>审查：{selected.review.decision} {selected.review.reason}</p>}
      {selected.status === 'submitted' && <section><h3>Owner 审查</h3>
        <label>工作区名称<Input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} /></label>
        <label>工作区目录<Input value={workspaceRoot} onChange={event => setWorkspaceRoot(event.target.value)} /></label>
        <Button compact variant="ghost" onClick={() => void hostClient.pickFolder().then(value => { if (value.path) setWorkspaceRoot(value.path); }).catch(cause => setError(messageOf(cause)))}>选择目录</Button>
        <Select label="执行者" value={provider} onChange={event => setProvider(event.target.value)}><option value="">选择可用 Agent</option>{providers.filter(item => item.eligible).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
        <p>批准的能力（仅作用于本任务）</p>{[['filesystem.read', '读取文件'], ['filesystem.write', '写入文件'], ['filesystem.search', '搜索文件'], ['git.status', 'Git 状态'], ['git.diff', 'Git 差异'], ['git.commit', 'Git 提交'], ['test.run', '运行测试']].map(([cap, label]) => <label key={cap}><input type="checkbox" checked={capabilities.includes(cap)} onChange={() => toggleCapability(cap)} /> {label}</label>)}
        <label>审查说明<textarea className="cm-textarea" value={reason} onChange={event => setReason(event.target.value)} rows={3} maxLength={2000} /></label>
        <div className="row"><Button variant="primary" disabled={busy || !workspaceName.trim() || !workspaceRoot.trim() || !provider} onClick={() => void act('approve')}>批准并执行</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void act('reject')}>拒绝</Button></div>
      </section>}
      {selected.plan && <section><h3>已批准范围</h3><p>{selected.plan.workspace.root} · {selected.plan.provider}</p><p>{selected.plan.capabilities.join('、') || '无工具能力'}</p></section>}
      {selected.errorCode && <p>执行失败：{selected.errorCode}</p>}
      {selected.status === 'provision_failed' && <Button disabled={busy} onClick={() => void act('retry')}>重试执行</Button>}
      {selected.taskId && <section><h3>任务与交付</h3><p>Task {selected.taskId} · {taskStatus || '读取中'}</p><Button compact variant="ghost" onClick={() => void open(selected.id)}>刷新状态</Button>
        {taskStatus === 'completed' && selected.status !== 'delivered' && <><label>交付标签<Input value={deliveryLabel} onChange={event => setDeliveryLabel(event.target.value)} /></label><label>交付内容<textarea className="cm-textarea" value={deliveryContent} onChange={event => setDeliveryContent(event.target.value)} rows={5} maxLength={256000} /></label><Button variant="primary" disabled={busy || !deliveryLabel.trim() || !deliveryContent.trim()} onClick={() => void act('deliver')}>批准交付</Button></>}
        {selected.artifacts.map(item => <p key={item.id}>已交付：{item.label} · {dateLabel(item.deliveredAt)}</p>)}
      </section>}
    </div>}</Sheet>
  </section>;
}

function TaskCard({ task, onOpen, onAction }: { task: Task; onOpen(): void; onAction(action: 'start' | 'pause' | 'resume' | 'cancel'): void }) {
  const progress = Math.max(0, Math.min(100, task.progress.percent));
  const progressBucket = Math.round(progress / 10) * 10;
  return <Card className="task-card"><div className="row between"><div className="task-icon"><Icon name="work" size={18} /></div><StatusBadge value={task.status} /></div><h3>{task.title || task.goal}</h3><div className="task-meta">{task.agent ?? '未分配智能体'}<span>·</span>{task.workspaceId ?? '未绑定工作区'}</div><div className="progress-track" role="progressbar" aria-label={`${task.title}进度`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span className={`progress-value progress-${progressBucket}`} /></div><div className="row between"><small>{progress}% · {relativeLabel(task.updatedAt)}</small><div className="row"><Button compact variant="ghost" onClick={onOpen}>详情 <Icon name="right" size={14} /></Button>{task.status === 'queued' && task.workspaceId ? <Button compact variant="ghost" onClick={onOpen}>选择执行者</Button> : task.status === 'running' ? <Button compact variant="ghost" onClick={() => onAction('pause')}>暂停</Button> : ['paused', 'waiting', 'blocked'].includes(task.status) && !/needs-reconciliation|Owner reviewed interrupted effect/i.test(task.progress.note) ? <Button compact variant="ghost" onClick={() => onAction('resume')}>继续</Button> : null}{!['completed', 'cancelled', 'failed'].includes(task.status) && <IconButton label="取消任务" icon="close" compact onClick={() => onAction('cancel')} />}</div></div></Card>;
}

function TaskCreateForm({ workspaces, providers, onCreated }: { workspaces: { id: string; name: string }[]; providers: { id: string; name: string; eligible: boolean; reason: string | null }[]; onCreated(): Promise<void> }) {
  const [goal, setGoal] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [agentProvider, setAgentProvider] = useState('');
  const createRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!goal.trim()) return;
    setBusy(true); setError('');
    try {
      const fingerprint = JSON.stringify([goal.trim(), workspaceId, agentProvider]);
      if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: crypto.randomUUID() };
      await taskClient.create({ goal: goal.trim(), workspaceId: workspaceId || null, agentProvider,
        requestId: createRequest.current.id });
      createRequest.current = null;
      await onCreated();
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  return <form className="task-create-form" onSubmit={submit}><label>任务目标<textarea className="cm-textarea" aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={4} maxLength={2000} placeholder="描述需要完成的工作和预期结果" required /></label><Select label="工作区" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">选择工作区</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</Select><Select label="执行者" value={agentProvider} onChange={event => setAgentProvider(event.target.value)}><option value="">选择可用 Agent</option>{providers.map(item => <option key={item.id} value={item.id} disabled={!item.eligible}>{item.name}{item.eligible ? '' : ` · 不可用：${item.reason ?? '能力或健康未验证'}`}</option>)}</Select>{error && <ErrorNotice error={error} />}<Button variant="primary" type="submit" disabled={busy || !goal.trim() || !workspaceId || !agentProvider}>{busy ? '创建中…' : '创建任务'}</Button></form>;
}

function TaskDetails({ task, providers, onHandoff, onAction, onStart, onReconcile }: { task: Task; providers: { id: string; name: string; eligible: boolean }[]; onHandoff(provider: string): void; onAction(action: 'start' | 'pause' | 'resume' | 'cancel'): void; onStart(provider: string): void; onReconcile(summary: string, instruction: string): void }) {
  const [handoffProvider, setHandoffProvider] = useState('');
  const [startProvider, setStartProvider] = useState('');
  const [reviewSummary, setReviewSummary] = useState('');
  const [nextInstruction, setNextInstruction] = useState('');
  return <div className="task-details">{task.status === "queued" && task.workspaceId && <section><h3>启动任务</h3><div className="row"><Select label="执行者" value={startProvider} onChange={event => setStartProvider(event.target.value)}><option value="">选择可用 Agent</option>{providers.filter(item => item.eligible).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Button disabled={!startProvider} onClick={() => onStart(startProvider)}>启动</Button></div></section>}<div className="row between"><StatusBadge value={task.status} /><small>更新于 {dateLabel(task.updatedAt)}</small></div><p>{task.goal}</p>{task.currentPhase && <section><h3>当前阶段</h3><p>{task.currentPhase}</p></section>}{task.progress.note && <section><h3>进度说明</h3><p>{task.progress.note}</p></section>}{task.checkpoint && <section><h3>检查点</h3><p>{task.checkpoint.summary}</p>{task.checkpoint.nextAction && <small>下一步：{task.checkpoint.nextAction}</small>}</section>}{task.result && <section><h3>执行结果</h3><p>{task.result.summary}</p></section>}<section><h3>交付物</h3>{task.artifacts.length ? task.artifacts.map(item => <ArtifactCard key={item.id} taskId={task.id} artifact={item} />) : <p className="muted">暂无交付物。</p>}</section>{task.failure?.reason && <section><h3>中断或失败原因</h3><p>{task.failure.reason}</p></section>}<section><h3>执行证据</h3>{task.executionEvidence.length ? task.executionEvidence.slice(-20).reverse().map(item => <p key={item.eventId}><strong>{item.capability}</strong> · {item.status}{item.tool ? ` · ${item.tool}` : ""}{item.exitCode !== null ? ` · exit ${item.exitCode}` : ""}{item.filePath ? ` · ${item.filePath}` : ""} · Task rev {item.taskRev}</p>) : <p className="muted">暂无工具或测试执行记录。</p>}</section><section><h3>执行者与交接记录</h3>{task.agentHistory.length ? task.agentHistory.map((item, index) => <p key={`${item.sessionId}-${index}`}><strong>{item.provider}</strong> · {dateLabel(item.attachedAt)}{item.detachedAt ? ` → ${dateLabel(item.detachedAt)}` : " · 当前执行者"}{item.note ? ` · ${item.note}` : ""}</p>) : <p className="muted">暂无执行者记录。</p>}</section>{task.currentAgent && ["queued", "running", "waiting", "blocked", "paused"].includes(task.status) && <section><h3>转交执行者</h3><div className="row"><Select label="目标 Agent" value={handoffProvider} onChange={event => setHandoffProvider(event.target.value)}><option value="">选择 Agent</option>{providers.filter(item => item.eligible && item.id !== task.currentAgent?.provider).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Button disabled={!handoffProvider} onClick={() => onHandoff(handoffProvider)}>交接任务</Button></div></section>}{/needs-reconciliation|interrupted after Core restart/i.test(task.progress.note) && <section><h3>人工核对后恢复</h3><p>先核对工作区和上次操作的实际结果，再给出新的执行指令；不会重放中断前的工具调用。</p><label>核对结果<textarea className="cm-textarea" value={reviewSummary} onChange={event => setReviewSummary(event.target.value)} rows={3} maxLength={1000} /></label><label>新的执行指令<textarea className="cm-textarea" value={nextInstruction} onChange={event => setNextInstruction(event.target.value)} rows={4} maxLength={32000} /></label><Button disabled={!reviewSummary.trim() || !nextInstruction.trim()} onClick={() => onReconcile(reviewSummary, nextInstruction)}>确认核对并执行新指令</Button></section>}<div className="row task-detail-actions">{['working', 'running'].includes(task.status) ? <Button onClick={() => onAction('pause')}>暂停任务</Button> : ['paused', 'waiting', 'blocked'].includes(task.status) && !/needs-reconciliation|Owner reviewed interrupted effect/i.test(task.progress.note) ? <Button onClick={() => onAction('resume')}>继续任务</Button> : null}{!['completed', 'cancelled', 'failed'].includes(task.status) && <Button variant="danger" onClick={() => onAction('cancel')}>取消任务</Button>}</div></div>;
}

function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const [agentResult, taskResult] = await Promise.all([agentClient.list(), taskClient.overview('', '')]); setAgents(agentResult.agents); setTasks(taskResult.tasks); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const ready = agents.filter(agent => agent.eligible).length;
  const needsSetup = agents.filter(agent => agent.status === 'needs-setup').length;
  const activeTasks = tasks.filter(task => ['working', 'running'].includes(task.status)).length;
  const visible = agents.filter(agent => (filter === 'all' || (filter === 'ready' ? agent.eligible : !agent.eligible)) && `${agent.name} ${agent.role} ${agent.description}`.toLowerCase().includes(query.toLowerCase()));
  async function check(agent: Agent) {
    setChecking(agent.id);
    try {
      const health = await agentClient.health(agent.id, true);
      setAgents(current => current.map(item => {
        if (item.id !== agent.id) return item;
        const available = health.available === true;
        const requiresTask = ['capability-broker', 'staged-capability-broker'].includes(item.workspaceBoundary ?? '');
        const boundaryUnverified = item.workspaceBoundary === 'unverified';
        return {
          ...item, available, installed: health.installed, authenticated: health.authenticated,
          eligible: available && !requiresTask && !boundaryUnverified,
          status: boundaryUnverified && available ? 'descriptor-incomplete' : health.status,
          reason: health.reason ?? (boundaryUnverified ? 'descriptor-incomplete' : requiresTask ? 'task-required' : null),
          version: health.version ?? item.version, desktopApp: health.desktopApp ?? item.desktopApp
        };
      }));
      setError('');
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setChecking(''); }
  }
  return <div className="content-page"><Heading eyebrow="AGENT DIRECTORY" title="Agents" description="查看可用 Agent、连接状态与职责。" action={<Button icon="update" onClick={() => void refresh()}>刷新状态</Button>} />{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}
    <div className="agent-summary-row"><Surface><strong>{agents.length}</strong><span>已配置 Agent</span></Surface><Surface><strong>{ready}</strong><span>当前可用</span></Surface><Surface><strong>{needsSetup}</strong><span>需要设置</span></Surface><Surface><strong>{activeTasks}</strong><span>活跃任务</span></Surface></div>
    <div className="row between work-controls"><Tabs items={[{ id: 'all', label: `全部 Agent ${agents.length}` }, { id: 'ready', label: `可用 ${ready}` }, { id: 'setup', label: `需设置 ${needsSetup}` }]} selected={filter} onChange={setFilter} label="Agent 状态筛选" /><SearchInput label="搜索 Agent" placeholder="搜索名称或职责" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {loading && !agents.length ? <LoadingState label="正在读取 Agent 状态…" /> : visible.length ? <div className="agent-grid">{visible.map(agent => <Card className="agent-card" key={agent.id}><div className="row between"><div className="agent-avatar">{agentInitials(agent.id)}</div><StatusBadge value={agent.status} available={agent.eligible} /></div><h3>{agent.name}</h3><strong className="agent-role">{agent.role}</strong><p>{agent.description}</p>{agent.status === 'needs-setup' && <small>请先完成本地登录或凭据配置。</small>}{agent.reason === 'task-required' && <small>Agent 已就绪；此能力需要先分配工作区任务。</small>}{agent.reason && agent.reason !== 'task-required' && <small>{availabilityReasonLabel(agent.reason)}</small>}{agent.lastError && <small role="status">{agent.lastError}</small>}{agent.version && <small>版本 {agent.version}</small>}{agent.desktopApp && <div className="agent-desktop-state"><strong>DeepSeek Harness Desktop</strong><span>桌面应用：{agent.desktopApp.installed ? '已安装' : '未安装'} · {agent.desktopApp.running ? '运行中' : agent.desktopApp.status}</span><span>DSH Agent Provider：{agent.available ? '已连接' : agent.status}</span></div>}<Button compact variant="ghost" disabled={checking === agent.id} onClick={() => void check(agent)}>{checking === agent.id ? '检查中…' : '检查连接'} <Icon name="right" size={14} /></Button></Card>)}</div> : !error && <EmptyNotice icon="agents" title="没有匹配的 Agent" detail="当前安装和注册的 Agent 会在这里显示。" />}
    <div className="section-heading page-section-heading"><h2>运行策略</h2></div><Surface className="policy-row"><span className="policy-icon"><Icon name="approval" /></span><span className="grow"><strong>敏感操作需要确认</strong><small>文件写入、网络访问和外部副作用由 Capability Broker 逐次管理。</small></span><Badge tone="success">由 Core 强制执行</Badge></Surface>
  </div>;
}

type PluginReview = { id: string; stageId: string; action: 'install' | 'update' | 'enable'; installable: boolean; requiresReview: boolean; permissions: string[]; summary: string[]; trust: string };
type ExtensionSettingsFormState = {
  description: ExtensionSettingsDescription;
  values: ExtensionSettingsSnapshot['values'];
  draft: Record<string, string | number | boolean | null>;
};
function extensionSettingsDraft(description: ExtensionSettingsDescription, values: ExtensionSettingsSnapshot['values']): Record<string, string | number | boolean | null> {
  return Object.fromEntries(description.fields.map(field => {
    const value = values[field.key];
    if (field.type === 'secretRef') return [field.key, ''];
    const safeValue = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
    if (safeValue !== undefined) return [field.key, safeValue];
    if (field.default !== undefined) return [field.key, field.default];
    if (field.type === 'boolean') return [field.key, false];
    if (field.type === 'number' || field.type === 'enum') return [field.key, null];
    return [field.key, ''];
  }));
}
type IntegrationRow = { id: string; name: string; status: string; enabled: boolean; available: boolean; eligible: boolean; configured: boolean; reason: string | null; lastError: string | null };
type McpRow = { id: string; name: string; status: string; enabled: boolean; running: boolean; available: boolean; toolCallable: boolean; eligible: boolean; configured: boolean; source: string; toolCount: number | null; discoveredToolCount: number; transport: string; reason: string | null; lastError: string | null };

function PluginsPage() {
  const [tab, setTab] = useState('catalog');
  const [view, setView] = useState('all');
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<{ available: boolean; configured: boolean; offline: boolean; reason: string | null; plugins: Plugin[] } | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [servers, setServers] = useState<McpRow[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null);
  const extensionSettingsRequest = useRef(0);
  const [extensionSettings, setExtensionSettings] = useState<ExtensionSettingsFormState | null>(null);
  const [extensionSettingsLoading, setExtensionSettingsLoading] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationSettings | null>(null);
  const [snowLumaConfigDraft, setSnowLumaConfigDraft] = useState({ httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', accessToken: '', clearAccessToken: false });
  const [selectedServer, setSelectedServer] = useState<{ server: McpRow; tools: { id: string; name: string; description: string; enabled: boolean; discovered: boolean; callable: boolean }[]; config: { id: string; enabled: boolean; hasArgs: boolean; hasEnvironment: boolean; timeoutMs: number | null; note: string } } | null>(null);
  const [mcpConfigDraft, setMcpConfigDraft] = useState({ timeoutMs: '', note: '' });
  const [review, setReview] = useState<PluginReview | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogResult, statusResult] = await Promise.all([
        pluginClient.catalog(query.trim(), category === 'all' ? '' : category, view), pluginClient.status()
      ]);
      setCatalog(catalogResult);
      setDeveloperMode(statusResult.developerMode);
      setIntegrations(statusResult.integrations);
      setServers(statusResult.mcp);
      setError('');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, [category, query, view]);
  const refreshConnections = useCallback(async () => {
    try {
      const [integrationResult, mcpResult] = await Promise.all([pluginClient.integrations(), pluginClient.mcp()]);
      setIntegrations(integrationResult.integrations);
      setServers(mcpResult.servers);
      setError('');
    } catch (cause) { setError(messageOf(cause)); }
  }, []);
  const refreshApprovals = useCallback(async () => {
    try { setPendingApprovals((await approvalClient.list()).approvals.filter(item => item.status === 'pending')); }
    catch (cause) { setError(messageOf(cause)); }
  }, []);
  useEffect(() => { if (tab === 'catalog') void refreshCatalog(); }, [tab, refreshCatalog]);
  useEffect(() => { if (tab !== 'catalog') void refreshConnections(); }, [tab, refreshConnections]);
  useEffect(() => {
    void refreshApprovals();
    const offPending = bridge.subscribe('approval.pending', () => { void refreshApprovals(); });
    const offResolved = bridge.subscribe('approval.resolved', () => { void refreshApprovals(); });
    const timer = window.setInterval(() => { void refreshApprovals(); }, 4000);
    return () => { window.clearInterval(timer); offPending(); offResolved(); };
  }, [refreshApprovals]);
  useEffect(() => bridge.subscribe('plugin.updated', () => { if (tab === 'catalog') void refreshCatalog(); else void refreshConnections(); }), [refreshCatalog, refreshConnections, tab]);

  async function stage(plugin: Plugin) {
    setBusy(plugin.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.stage(plugin.id);
      setReview({ id: plugin.id, stageId: result.stageId, action: plugin.status === 'update' ? 'update' : 'install', installable: result.installable, requiresReview: result.requiresReview, permissions: result.permissions, summary: result.summary, trust: result.trust });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function stageLocalPackage() {
    setError(''); setNotice('');
    try {
      const selected = await hostClient.pickExtensionPackage();
      if (!selected.path) return;
      setBusy('local-package');
      const result = await pluginClient.stageLocal(selected.path);
      setReview({ id: result.plugin.id, stageId: result.stageId, action: 'install', installable: result.installable, requiresReview: true, permissions: result.permissions, summary: result.summary, trust: 'local-unverified · Owner Review' });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function reviewEnable(plugin: Plugin) {
    setBusy(plugin.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.reviewEnable(plugin.id);
      setReview({ ...result, action: 'enable' });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function confirmReview() {
    if (!review || !review.installable) return;
    setBusy(review.id); setError('');
    try {
      if (review.action === 'install' || review.action === 'update') await pluginClient.install(review.stageId);
      else await pluginClient.enable(review.id, review.stageId);
      setNotice(review.action === 'update' ? '插件已更新。' : review.action === 'install' ? '插件已安装。' : '插件已启用。');
      setReview(null);
      await refreshCatalog();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function pluginAction(plugin: Plugin, action: 'disable' | 'uninstall') {
    const verb = action === 'disable' ? '停用' : '卸载';
    if (!window.confirm(`${verb}“${plugin.name}”？`)) return;
    setBusy(plugin.id); setError(''); setNotice('');
    try {
      await pluginClient[action](plugin.id);
      setSelectedPlugin(null);
      setNotice(`已${verb}插件。`);
      await refreshCatalog();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function toggleIntegration(item: IntegrationRow) {
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.manageIntegration(item.id, item.enabled ? 'disable' : 'enable');
      setNotice(result.pending === true || result.approvalId ? '此操作已提交，等待 Core 审批。' : '集成状态已更新。');
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function toggleIntegrationTool(integrationId: string, tool: IntegrationSettings['tools'][number]) {
    const key = `${integrationId}:${tool.id}`;
    setBusy(key); setError(''); setNotice('');
    try {
      const result = await pluginClient.toggleTool(integrationId, tool.id, !tool.enabled);
      setNotice(result.pending === true || result.approvalId ? '工具权限变更已提交，等待 Core 审批。' : '工具状态已更新。');
      setSelectedIntegration(await pluginClient.integrationSettings(integrationId));
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function manageSnowLuma(action: 'detect' | 'start' | 'stop' | 'configure') {
    setBusy(`snowluma:${action}`); setError(''); setNotice('');
    try {
      const params = action === 'configure' ? {
        httpUrl: snowLumaConfigDraft.httpUrl,
        wsUrl: snowLumaConfigDraft.wsUrl,
        ...(snowLumaConfigDraft.accessToken ? { accessToken: snowLumaConfigDraft.accessToken } : {}),
        ...(snowLumaConfigDraft.clearAccessToken ? { clearAccessToken: true } : {})
      } : {};
      const result = await pluginClient.integrationAction('snowluma', action, params);
      setNotice(result.pending === true || result.approvalId ? '操作已提交，等待 Core 审批。' : action === 'configure' ? 'SnowLuma 连接设置已保存。' : 'SnowLuma 状态已更新。');
      const settings = await pluginClient.integrationSettings('cetamesh-snowluma');
      setSelectedIntegration(settings);
      setSnowLumaConfigDraft(current => ({ ...current, accessToken: '', clearAccessToken: false }));
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function manageServer(item: McpRow, action: 'start' | 'stop' | 'enable' | 'disable' | 'restart') {
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.manageMcp(item.id, action);
      setNotice(result.pending === true || result.approvalId ? '此操作已提交，等待 Core 审批。' : 'MCP 服务状态已更新。');
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function openPlugin(plugin: Plugin) {
    const request = ++extensionSettingsRequest.current;
    setSelectedPlugin(plugin);
    setExtensionSettings(null);
    setExtensionSettingsLoading(true);
    try {
      const result = await pluginClient.detail(plugin.id);
      const selected = result.plugin ?? plugin;
      if (request !== extensionSettingsRequest.current) return;
      setSelectedPlugin(selected);
      if (!selected.installed) return;
      const description = await extensionSettingsClient.describe(selected.id);
      if (request !== extensionSettingsRequest.current || !description.available || !description.fields.length) return;
      const snapshot = await extensionSettingsClient.get(selected.id);
      if (request !== extensionSettingsRequest.current) return;
      setExtensionSettings({ description, values: snapshot.values, draft: extensionSettingsDraft(description, snapshot.values) });
    } catch (cause) { if (request === extensionSettingsRequest.current) setError(messageOf(cause)); }
    finally { if (request === extensionSettingsRequest.current) setExtensionSettingsLoading(false); }
  }
  async function saveExtensionSettings() {
    if (!extensionSettings || !selectedPlugin) return;
    const values: Record<string, string | number | boolean | null> = {};
    for (const field of extensionSettings.description.fields) {
      const value = extensionSettings.draft[field.key];
      if (field.type === 'secretRef') {
        if (value === null) values[field.key] = null;
        else if (typeof value === 'string' && value.length > 0) values[field.key] = value;
      } else if (value !== undefined) values[field.key] = value;
    }
    setBusy('extension-settings'); setError(''); setNotice('');
    try {
      const snapshot = await extensionSettingsClient.update(selectedPlugin.id, values);
      setExtensionSettings(current => current && current.description.id === snapshot.id
        ? { ...current, values: snapshot.values, draft: extensionSettingsDraft(current.description, snapshot.values) }
        : current);
      setNotice('扩展设置已保存。');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function openIntegration(item: IntegrationRow) {
    try {
      const settings = await pluginClient.integrationSettings(item.id);
      setSelectedIntegration(settings);
      if (settings.id === 'cetamesh-snowluma' && settings.localService) {
        setSnowLumaConfigDraft({ httpUrl: settings.localService.httpUrl || 'http://127.0.0.1:3000', wsUrl: settings.localService.wsUrl || 'ws://127.0.0.1:3001', accessToken: '', clearAccessToken: false });
      }
    }
    catch (cause) { setError(messageOf(cause)); }
  }
  async function openServer(item: McpRow) {
    try {
      const [result, config] = await Promise.all([pluginClient.mcpTools(item.id), pluginClient.mcpConfig(item.id)]);
      setSelectedServer({ server: item, tools: result.tools, config });
      setMcpConfigDraft({ timeoutMs: config.timeoutMs === null ? '' : String(config.timeoutMs), note: config.note });
    } catch (cause) { setError(messageOf(cause)); }
  }

  async function decidePendingApproval(id: string, approve: boolean) {
    setBusy(`approval:${id}`); setError(''); setNotice('');
    try {
      const result = await approvalClient.decide(id, approve);
      if (result.resumeError) setError(`审批已记录，但回合继续失败（${result.resumeError}）。`);
      else if (approve && result.resumePending) setNotice('已批准一次，后续敏感操作仍需审批。');
      else if (approve) setNotice(result.turnResumed ? '已批准一次，聊天回合已继续。' : '已批准一次，Core 正在继续操作。');
      else setNotice(result.turnResumed ? '已拒绝，聊天回合已收到结果并继续。' : '已拒绝此操作。');
      await refreshApprovals();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }

  async function saveMcpConfig() {
    if (!selectedServer) return;
    const timeoutText = mcpConfigDraft.timeoutMs.trim();
    const timeoutMs = timeoutText ? Number(timeoutText) : null;
    if (timeoutText && (timeoutMs === null || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)) {
      setError('MCP 超时必须是 100 到 300000 毫秒之间的整数。');
      return;
    }
    setBusy('mcp-config'); setError(''); setNotice('');
    try {
      await pluginClient.updateMcpConfig(selectedServer.server.id, {
        ...(timeoutMs === null ? {} : { timeoutMs }),
        note: mcpConfigDraft.note.trim()
      });
      const config = await pluginClient.mcpConfig(selectedServer.server.id);
      setSelectedServer(current => current ? { ...current, config } : current);
      setMcpConfigDraft({ timeoutMs: config.timeoutMs === null ? '' : String(config.timeoutMs), note: config.note });
      setNotice('MCP 设置已保存。');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  const plugins = catalog?.plugins ?? [];
  const categories = ['all', ...new Set(plugins.map(plugin => plugin.category).filter(Boolean))];
  return <div className="content-page plugins-page">
    <Heading eyebrow="EXTENSIONS & CONNECTORS" title="Plugins" description="在一个位置管理扩展能力、外部集成和 MCP 连接。" action={<Button icon="add" variant="primary" onClick={() => { setTab('catalog'); setView('all'); }}>添加插件</Button>} />
    <Banner><span className="banner-icon"><Icon name="approval" size={20} /></span><span className="grow"><strong>安装前先查看权限</strong><small>插件详情与权限清单会在安装前显示；高风险操作仍由 Core 审批。</small></span><span className="banner-link">仅安装可信来源</span></Banner>
    <div className="plugins-controls row between"><SearchInput label="搜索插件" placeholder="搜索插件、集成或开发者" value={query} onChange={event => setQuery(event.target.value)} /><Tabs label="插件视图" selected={tab} onChange={setTab} items={[{ id: 'catalog', label: '插件中心' }, { id: 'connections', label: `集成 ${integrations.length || ''}` }, { id: 'mcp', label: `MCP ${servers.length || ''}` }]} /></div>
    {error && <ErrorNotice error={error} onRetry={() => tab === 'catalog' ? void refreshCatalog() : void refreshConnections()} />}{notice && <p className="inline-success" role="status">{notice}</p>}
    {pendingApprovals.length > 0 && <section className="plugin-approval-inbox"><div className="section-heading"><h2>待处理审批</h2><Badge tone="warning">{pendingApprovals.length}</Badge></div>{pendingApprovals.map(approval => <ApprovalCard key={approval.id} approval={approval} onDecide={(id, approve) => { void decidePendingApproval(id, approve); }} />)}</section>}
    {tab === 'catalog' && <>
    <div className="catalog-filters"><Tabs label="插件分类" selected={category} onChange={setCategory} items={categories.map(value => ({ id: value, label: value === 'all' ? '全部' : value }))} /><Tabs label="安装状态" selected={view} onChange={setView} items={[{ id: 'all', label: '全部' }, { id: 'recommended', label: '精选' }, { id: 'installed', label: '已安装' }, { id: 'update-available', label: '可更新' }]} />{developerMode && <Button compact onClick={() => void stageLocalPackage()} disabled={busy === 'local-package'}>{busy === 'local-package' ? '读取本地包…' : '导入本地扩展'}</Button>}<Button compact icon="update" onClick={() => void refreshCatalog()} disabled={loading}>刷新目录</Button></div>
      {catalog?.offline && <Banner>当前目录离线，显示 Core 缓存的插件信息。{catalog.reason ? ` ${catalog.reason}` : ''}</Banner>}
      {loading && !plugins.length ? <LoadingState label="正在读取插件目录…" /> : plugins.length ? <div className="plugin-grid">{plugins.map(plugin => <Card className="plugin-card" key={plugin.id}><button className="plugin-card-main" onClick={() => void openPlugin(plugin)}><span className={`plugin-icon plugin-icon-${plugin.icon}`}><Icon name={(plugin.icon as IconName) || 'layers'} size={20} /></span><span className="plugin-card-copy"><strong>{plugin.name}</strong><span>{plugin.summary}</span><small>{plugin.developer} · v{plugin.version || '—'} · {plugin.category || plugin.kind}</small></span><StatusBadge value={plugin.status === 'update' ? 'update' : plugin.enabled ? 'enabled' : plugin.installed ? 'installed' : plugin.status} /></button><div className="plugin-card-actions"><Button compact variant="ghost" onClick={() => void openPlugin(plugin)}>查看详情 <Icon name="right" size={13} /></Button>{plugin.status === 'update' ? <Button compact variant="primary" disabled={busy === plugin.id} onClick={() => void stage(plugin)}>查看更新并安装</Button> : !plugin.installed ? <Button compact variant="primary" disabled={busy === plugin.id} onClick={() => void stage(plugin)}>安装</Button> : plugin.enabled ? <Button compact disabled={busy === plugin.id} onClick={() => void pluginAction(plugin, 'disable')}>停用</Button> : <Button compact variant="primary" disabled={busy === plugin.id} onClick={() => void reviewEnable(plugin)}>启用</Button>}</div></Card>)}</div> : !loading && <EmptyNotice icon="plugins" title="没有匹配的插件" detail={catalog?.reason || '调整搜索条件，或刷新插件目录。'} />}
    </>}
    {tab === 'connections' && <div className="connection-list">{integrations.length ? integrations.map(item => <Surface className="connection-row" key={item.id}><span className="connection-icon"><Icon name="plug" size={20} /></span><span className="grow"><strong>{item.name}</strong><small>{item.id} · {availabilityReasonLabel(item.reason) || item.lastError || (item.available ? item.status : '当前不可用')}</small></span><StatusBadge value={item.available ? item.status : item.enabled ? (item.reason === 'needs-setup' ? 'needs-setup' : item.reason === 'not-installed' ? 'not-installed' : 'unavailable') : 'disabled'} available={item.eligible} /><Button compact onClick={() => void openIntegration(item)}>详情与设置</Button><Button compact variant={item.enabled ? 'default' : 'primary'} disabled={busy === item.id} onClick={() => void toggleIntegration(item)}>{item.enabled ? '停用' : '启用'}</Button></Surface>) : <EmptyNotice icon="plug" title="没有已注册的集成" detail="Integration 状态由本机 Core 提供。安装扩展请前往插件中心。" />}</div>}
    {tab === 'mcp' && <div className="connection-list">{servers.length ? servers.map(item => <Surface className="connection-row" key={item.id}><span className="connection-icon mcp-icon"><Icon name="layers" size={20} /></span><span className="grow"><strong>{item.name}</strong><small>{item.source === 'builtin' ? '内置服务 · 默认启动入口' : item.transport || '本机连接'} · {item.discoveredToolCount}/{item.toolCount ?? '?'} 个工具已发现{item.reason ? ` · ${availabilityReasonLabel(item.reason) || item.reason}` : ''}</small></span><StatusBadge value={item.toolCallable ? 'ready' : item.running ? 'needs-setup' : item.status} available={item.toolCallable} /><Button compact onClick={() => void openServer(item)}>查看工具</Button><Button compact variant={item.enabled ? 'default' : 'primary'} disabled={busy === item.id} onClick={() => void manageServer(item, item.enabled ? 'disable' : 'enable')}>{item.enabled ? '禁用' : '启用'}</Button><Button compact disabled={busy === item.id || !item.enabled || item.status === 'unsupported'} onClick={() => void manageServer(item, item.status === 'running' ? 'stop' : 'start')}>{item.status === 'running' ? '停止' : '启动'}</Button></Surface>) : <EmptyNotice icon="layers" title="没有配置 MCP 服务" detail="MCP 服务与凭据由本机 Core 配置和管理。" />}</div>}
    <Sheet open={Boolean(selectedPlugin)} title={selectedPlugin?.name ?? '插件详情'} onClose={() => { extensionSettingsRequest.current += 1; setSelectedPlugin(null); setExtensionSettings(null); setExtensionSettingsLoading(false); }}>{selectedPlugin && <div className="plugin-detail"><p className="eyebrow">{selectedPlugin.developer} · {selectedPlugin.kind}</p><h3>{selectedPlugin.summary}</h3><p>{selectedPlugin.description || '暂无详细说明。'}</p><div className="detail-facts"><span>版本 <strong>{selectedPlugin.version || '—'}</strong></span><span>分类 <strong>{selectedPlugin.category || '未分类'}</strong></span><span>信任 <strong>{selectedPlugin.compatibility.minimum || 'Core 验证'}</strong></span></div><section><h3>权限</h3>{selectedPlugin.permissions.length ? <ul>{selectedPlugin.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul> : <p className="muted">该插件没有声明权限。</p>}</section>{selectedPlugin.warning && <Banner>{selectedPlugin.warning}</Banner>}
      {selectedPlugin.installed && extensionSettingsLoading && <p className="muted">正在读取扩展设置…</p>}
      {selectedPlugin.installed && extensionSettings && extensionSettings.description.fields.length > 0 && <section className="extension-settings">
        <div><h3>扩展设置</h3><p className="muted">设置由本机 Core 保存；敏感值只显示是否已配置。</p></div>
        {extensionSettings.description.fields.map(field => {
          const draft = extensionSettings.draft[field.key];
          const stored = extensionSettings.values[field.key];
          const configured = field.type === 'secretRef' && typeof stored === 'object' && stored !== null && stored.configured;
          const updateDraft = (value: string | number | boolean | null) => setExtensionSettings(current => current
            ? { ...current, draft: { ...current.draft, [field.key]: value } } : current);
          return <div className="extension-setting" key={field.key}>
            <div className="extension-setting-copy"><strong>{field.label}</strong>{field.required && <small>必填</small>}</div>
            {field.type === 'boolean'
              ? <label className="extension-setting-toggle"><span className="sr-only">{field.label}</span><Input type="checkbox" checked={draft === true} onChange={event => updateDraft(event.target.checked)} /></label>
              : field.type === 'enum'
                ? <Select label={field.label} value={typeof draft === 'string' ? draft : ''} onChange={event => updateDraft(event.target.value || null)}><option value="">未设置</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</Select>
                : field.type === 'number'
                  ? <Input type="number" aria-label={field.label} min={field.min ?? undefined} max={field.max ?? undefined} step="any" value={typeof draft === 'number' ? draft : typeof draft === 'string' ? draft : ''} onChange={event => updateDraft(event.target.value === '' ? null : Number(event.target.value))} />
                  : field.type === 'secretRef'
                    ? <div className="extension-secret-control"><Input type="password" aria-label={field.label} autoComplete="new-password" maxLength={field.maxLength ?? undefined} value={typeof draft === 'string' ? draft : ''} placeholder={configured ? '已配置，留空保持不变' : '输入敏感值'} onChange={event => updateDraft(event.target.value)} /><span className="muted">{configured ? '已配置' : '未配置'}</span>{configured && draft !== null && <Button compact variant="ghost" onClick={() => updateDraft(null)}>清除</Button>}</div>
                    : <Input aria-label={field.label} maxLength={field.maxLength ?? undefined} value={typeof draft === 'string' ? draft : ''} onChange={event => updateDraft(event.target.value)} />}
          </div>;
        })}
        <div className="row detail-actions"><Button compact variant="primary" disabled={busy === 'extension-settings'} onClick={() => void saveExtensionSettings()}>{busy === 'extension-settings' ? '正在保存…' : '保存扩展设置'}</Button></div>
      </section>}
      <section><h3>更新说明</h3>{selectedPlugin.changelog.length ? <ul>{selectedPlugin.changelog.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul> : <p className="muted">没有更新说明。</p>}</section><div className="row detail-actions">{selectedPlugin.status === 'update' ? <Button variant="primary" disabled={busy === selectedPlugin.id} onClick={() => void stage(selectedPlugin)}>查看更新并安装</Button> : !selectedPlugin.installed ? <Button variant="primary" disabled={busy === selectedPlugin.id} onClick={() => void stage(selectedPlugin)}>查看权限并安装</Button> : selectedPlugin.enabled ? <Button disabled={busy === selectedPlugin.id} onClick={() => void pluginAction(selectedPlugin, 'disable')}>停用</Button> : <Button variant="primary" disabled={busy === selectedPlugin.id} onClick={() => void reviewEnable(selectedPlugin)}>查看权限并启用</Button>}{selectedPlugin.installed && <Button variant="danger" disabled={busy === selectedPlugin.id} onClick={() => void pluginAction(selectedPlugin, 'uninstall')}>卸载</Button>}</div></div>}</Sheet>
    <Sheet open={Boolean(review)} title="安装与权限审查" onClose={() => setReview(null)}>{review && <div className="review-detail"><Badge tone={review.trust === 'publisher-signature-verified' ? 'success' : 'warning'}>{review.trust || '来源待核验'}</Badge><h3>{review.action === 'update' ? '更新前查看权限' : review.action === 'install' ? '安装前查看权限' : '启用前查看权限'}</h3><p>仅继续本次明确选择的操作。运行时能力仍需 Core 按策略审批。</p>{review.summary.length ? <section><h4>操作说明</h4><ul>{review.summary.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul></section> : null}<section><h4>请求的权限</h4>{review.permissions.length ? <ul>{review.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul> : <p>没有声明额外权限。</p>}</section>{!review.installable && <ErrorNotice error="Core 尚未允许该插件安装或启用。请先处理完整性或兼容性问题。" />}<div className="row detail-actions"><Button onClick={() => setReview(null)}>取消</Button><Button variant="primary" disabled={!review.installable || busy === review.id} onClick={() => void confirmReview()}>{busy === review.id ? '正在处理…' : review.action === 'update' ? '确认更新' : review.action === 'install' ? '确认安装' : '确认启用'}</Button></div></div>}</Sheet>
    <Sheet open={Boolean(selectedIntegration)} title={selectedIntegration?.name ?? '集成设置'} onClose={() => setSelectedIntegration(null)}>
      {selectedIntegration && <div className="plugin-detail">
        <StatusBadge value={selectedIntegration.enabled ? 'enabled' : 'disabled'} available={selectedIntegration.available} />
        {selectedIntegration.id === 'cetamesh-snowluma' && selectedIntegration.localService && <section className="snowluma-settings">
          <div className="row between"><h3>SnowLuma 网关</h3><StatusBadge value={selectedIntegration.localService.status} available={selectedIntegration.localService.ready} /></div>
          <p>{!selectedIntegration.localService.installed ? '未检测到本机 SnowLuma 安装。先安装并启动 SnowLuma，再检测连接状态。' : !selectedIntegration.localService.configured ? '需要配置 OneBot HTTP 地址后才能验证连接。' : selectedIntegration.localService.ready ? '网关已就绪，可以连接 QQ 通道。' : selectedIntegration.localService.running ? '进程正在运行；请在 SnowLuma 中完成 QQ 登录和 OneBot 网关配置。' : 'SnowLuma 已安装但当前已停止。'}</p>
          {selectedIntegration.localService.version && <small>版本 {selectedIntegration.localService.version}</small>}
          {selectedIntegration.localService.lastError && <p className="message-error" role="status">{selectedIntegration.localService.lastError}</p>}
          <label>OneBot HTTP 地址<Input value={snowLumaConfigDraft.httpUrl} onChange={event => setSnowLumaConfigDraft(current => ({ ...current, httpUrl: event.target.value }))} maxLength={500} /></label>
          <label>OneBot WebSocket 地址<Input value={snowLumaConfigDraft.wsUrl} onChange={event => setSnowLumaConfigDraft(current => ({ ...current, wsUrl: event.target.value }))} maxLength={500} /></label>
          <label>Access Token<Input type="password" autoComplete="new-password" value={snowLumaConfigDraft.accessToken} placeholder={selectedIntegration.localService.accessTokenConfigured ? '已配置；留空保持不变' : '可选'} onChange={event => setSnowLumaConfigDraft(current => ({ ...current, accessToken: event.target.value, clearAccessToken: false }))} maxLength={512} /></label>
          {selectedIntegration.localService.accessTokenConfigured && <Button compact variant="ghost" onClick={() => setSnowLumaConfigDraft(current => ({ ...current, accessToken: '', clearAccessToken: !current.clearAccessToken }))}>{snowLumaConfigDraft.clearAccessToken ? '保留已配置令牌' : '清除已保存令牌'}</Button>}
          <div className="row detail-actions">
            <Button compact variant="primary" disabled={busy.startsWith('snowluma:')} onClick={() => void manageSnowLuma('configure')}>保存设置</Button>
            <Button compact disabled={busy.startsWith('snowluma:')} onClick={() => void manageSnowLuma('detect')}>检测安装</Button>
            {selectedIntegration.localService.running
              ? <Button compact disabled={busy.startsWith('snowluma:')} onClick={() => void manageSnowLuma('stop')}>停止</Button>
              : <Button compact variant="primary" disabled={busy.startsWith('snowluma:') || !selectedIntegration.localService.installed || !selectedIntegration.localService.configured} title={!selectedIntegration.localService.configured ? '先保存 OneBot 地址' : undefined} onClick={() => void manageSnowLuma('start')}>启动</Button>}
          </div>
        </section>}
        {selectedIntegration.inventory && <Surface className="bionic-inventory">
          <div className="section-heading"><h3>仿生聊天工具清单</h3><small>按当前 Integration Registry 状态统计</small></div>
          <div className="bionic-inventory-counts">
            <Surface><strong>{selectedIntegration.inventory.restored}</strong><small>已恢复</small></Surface>
            <Surface><strong>{selectedIntegration.inventory.partial}</strong><small>部分恢复</small></Surface>
            <Surface><strong>{selectedIntegration.inventory.legacyUnsupported}</strong><small>不可恢复</small></Surface>
          </div>
        </Surface>}
        <h3>能力与工具</h3>
        {selectedIntegration.tools.length ? selectedIntegration.tools.map(tool => {
          const restoreLabel = tool.restore === 'restored' ? '已恢复' : tool.restore === 'partial' ? '部分恢复'
            : tool.restore === 'deprecated' ? '已弃用' : tool.restore === 'legacy-unsupported' ? '不可恢复' : '状态未识别';
          return <div className="tool-setting-row" key={tool.id}>
            <span className="grow"><strong>{tool.name}</strong><small>{tool.permission || '权限由 Core 控制'} · {restoreLabel}</small>{tool.reason && <small>{tool.reason}</small>}</span>
            <div className="row"><StatusBadge value={tool.enabled ? 'enabled' : 'disabled'} />{tool.enabled && !tool.available && <StatusBadge value="unavailable" />}</div>
            <Button compact disabled={!tool.restorable || busy === `${selectedIntegration.id}:${tool.id}`} title={!tool.restorable ? tool.reason : undefined} onClick={() => void toggleIntegrationTool(selectedIntegration.id, tool)}>{tool.enabled ? '关闭工具' : '开启工具'}</Button>
          </div>;
        }) : <p className="muted">没有公开的工具配置。</p>}
        {selectedIntegration.legacyRetired.length > 0 && <details className="bionic-retired-tools">
          <summary>已退役工具 <span>{selectedIntegration.legacyRetired.length}</span></summary>
          {selectedIntegration.legacyRetired.map(tool => <div className="tool-setting-row" key={tool.id}>
            <span className="grow"><strong>{tool.name}</strong><small>{tool.feature}</small><small>{tool.reason}</small>{tool.replacement && <small>已注册替代项：{tool.replacement.label}</small>}</span>
            <Badge tone={tool.restore === 'deprecated' ? 'default' : 'danger'}>{tool.restore === 'deprecated' ? 'Deprecated' : 'Legacy Unsupported'}</Badge>
          </div>)}
        </details>}
        <h3>安全设置</h3>
        {Object.entries(selectedIntegration.settings).length ? Object.entries(selectedIntegration.settings).map(([key, value]) => <div className="tool-setting-row" key={key}><strong>{key}</strong><span>{typeof value === 'boolean' ? value ? '启用' : '停用' : String(value ?? '—')}</span></div>) : <p className="muted">没有可展示的非敏感设置。</p>}
      </div>}
    </Sheet>
    <Sheet open={Boolean(selectedServer)} title={selectedServer?.server.name ?? 'MCP 工具'} onClose={() => setSelectedServer(null)}>{selectedServer && <div className="plugin-detail">
      <div className="row between"><p>工具可调用状态来自运行时发现与 Core 权限策略。调用仍由 Capability Broker 审核。</p><Button compact onClick={() => void manageServer(selectedServer.server, 'restart')}>重启</Button></div>
      <Surface className="mcp-settings-card"><div className="row between"><strong>服务器状态</strong><StatusBadge value={selectedServer.server.status} /></div><p>传输方式：{selectedServer.server.transport || '未检查'} · {selectedServer.server.source === 'builtin' ? '内置启动配置' : '外部启动配置'}</p><p>{selectedServer.server.source === 'builtin' ? `启动参数覆盖：${selectedServer.config.hasArgs ? '已设置' : '未设置，使用内置入口'} · 环境变量覆盖：${selectedServer.config.hasEnvironment ? '已设置' : '未设置'}` : `启动参数：${selectedServer.config.hasArgs ? '已配置' : '未配置'} · 环境变量：${selectedServer.config.hasEnvironment ? '已配置' : '未配置'}`}</p><p className="muted">凭据和原始环境值不会传入界面。</p><label>启动超时（毫秒，留空保持现有值）<Input type="number" min={100} max={300000} value={mcpConfigDraft.timeoutMs} onChange={event => setMcpConfigDraft(current => ({ ...current, timeoutMs: event.target.value }))} /></label><label>备注<Input value={mcpConfigDraft.note} onChange={event => setMcpConfigDraft(current => ({ ...current, note: event.target.value }))} maxLength={500} /></label><Button compact disabled={busy === 'mcp-config'} onClick={() => void saveMcpConfig()}>保存 MCP 设置</Button></Surface>
      {selectedServer.tools.length ? selectedServer.tools.map(tool => <article className="mcp-tool-row" key={tool.id}><div className="row between"><strong>{tool.name}</strong><StatusBadge value={tool.callable ? 'ready' : tool.enabled && tool.discovered ? 'unavailable' : tool.enabled ? 'not-checked' : 'disabled'} /></div><p>{tool.description || '没有描述。'}</p></article>) : <EmptyNotice icon="layers" title="没有发现工具" detail="服务可能尚未启动，或当前没有注册工具。" />}
    </div>}</Sheet>
  </div>;
}

const SETTING_SECTION_LABELS: Record<string, string> = {
  models: '模型', agents: 'Agent', memory: '记忆', workspace: '工作区', devices: '设备与连接',
  extensions: '插件与扩展', security: '隐私与安全', updates: '更新', advanced: '高级'
};
const SETTING_FIELD_LABELS: Record<string, string> = {
  language: '界面语言', startMinimized: '启动时最小化', confirmOnExit: '退出前确认', provider: '默认服务商',
  defaultModel: '默认模型', reasoningEffort: '推理强度', streaming: '流式响应', defaultAgentPreset: '默认 Agent 预设',
  defaultAgentProvider: '默认 Agent', allowBackgroundTurns: '允许后台任务',
  codexOpenAiEnvironmentAuthorized: '允许 Codex 使用 OpenAI 环境变量', enabled: '启用记忆',
  requireConfirmationForLongTerm: '长期记忆需要确认', defaultScope: '默认记忆范围', retrievalLimit: '检索数量',
  defaultWorkspaceId: '默认工作区', boundaryEnforcement: '强制工作区边界', meshEnabled: '启用设备网格',
  requireApprovalForRemoteCapabilities: '远程能力需要审批', presenceTtlMs: '在线状态有效期',
  allowLocalImport: '允许本地导入插件', developerMode: '开发者模式', requireReviewApproval: '插件变更需要审查',
  maxInstalled: '最多安装数量', redactLogs: '日志中隐藏敏感信息', auditRetention: '审计记录保留时间',
  channel: '更新通道', autoCheck: '自动检查更新', manifestUrl: '更新清单地址', fallbackManifestUrl: '备用清单地址',
  showEngineeringPages: '显示诊断页面', logLevel: '日志级别', diagnosticsVerbosity: '诊断信息级别'
};

function ModelConnectionSettings({ provider, model, values, onChange }: { provider: string; model: string; values: Record<string, string | number | boolean | null>; onChange(key: string, value: string | number | boolean): void }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof chatClient.catalog>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKeyPresent, setApiKeyPresent] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await chatClient.catalog();
      setCatalog(next);
      const item = next.modelProviders.find(candidate => candidate.id === provider);
      setConfigured(item?.configured ?? null);
      setError('');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, [provider]);
  useEffect(() => { void refresh(); }, [refresh]);
  const providerRows = catalog?.modelProviders ?? [];
  const selected = providerRows.find(item => item.id === provider);
  const modelOptions = (selected?.models ?? []).map(item => ({ id: item.id ?? item.name ?? item.label ?? '', label: item.label ?? item.name ?? item.id ?? '' })).filter(item => item.id);
  const advancedFields = selected?.settingsFields ?? [];
  async function testConnection() {
    const apiKey = apiKeyRef.current?.value.trim() ?? '';
    if (apiKeyRef.current) apiKeyRef.current.value = '';
    setApiKeyPresent(false); setBusy(true); setMessage(''); setError('');
    try {
      const result = await onboardingClient.testProvider(provider, apiKey, baseUrl, model);
      if (!result.ok) { setError(result.message ?? '连接测试失败。'); return; }
      setMessage(result.message ?? '连接测试成功，凭据已保存在本机。');
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  return <div className="model-connection-settings">
    <h4>模型服务商连接</h4>
    <p className="muted">凭据保存在本机 Core；页面只显示配置状态。</p>
    <Select label="模型服务商" value={provider} onChange={event => { const next = providerRows.find(item => item.id === event.target.value); onChange('provider', event.target.value); if (next?.models[0]) onChange('defaultModel', next.models[0].id ?? next.models[0].name ?? next.models[0].label ?? ''); }}>
      <option value="">选择服务商</option>{providerRows.map(item => <option key={item.id} value={item.id}>{item.label}{item.configured ? ' · 已配置' : ''}</option>)}
    </Select>
    {modelOptions.length ? <Select label="默认模型" value={model} onChange={event => onChange('defaultModel', event.target.value)}><option value="">选择模型</option>{modelOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select> : <Input aria-label="默认模型 ID" placeholder="默认模型 ID" value={model} onChange={event => onChange('defaultModel', event.target.value)} />}
    <div className="model-key-row"><Input ref={apiKeyRef} aria-label="API Key" type="password" autoComplete="new-password" placeholder="输入新 API Key；留空时测试已保存的凭据" onChange={event => setApiKeyPresent(Boolean(event.target.value))} /><Button compact disabled={loading || busy || !provider || (!apiKeyPresent && configured !== true)} onClick={() => void testConnection()}>{busy ? '正在测试…' : '测试连接'}</Button></div>
    {advancedFields.length > 0 && <details className="model-advanced"><summary>高级连接设置</summary>{advancedFields.map((field: ProviderSettingField) => {
      if (field.key === 'baseUrl') return <label key={field.key}>{field.label}<Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="仅自建或代理网关需要填写" /></label>;
      const value = values[field.key] ?? '';
      if (field.choices?.length) return <label key={field.key}>{field.label}<Select label={field.label} value={String(value)} onChange={event => onChange(field.key, event.target.value)}>{field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</Select></label>;
      if (field.type === 'number') return <label key={field.key}>{field.label}<Input type="number" min={field.min} max={field.max} value={String(value)} onChange={event => onChange(field.key, event.target.value === '' ? '' : Number(event.target.value))} /></label>;
      if (field.type === 'boolean') return <label key={field.key}>{field.label}<input type="checkbox" checked={value === true} onChange={event => onChange(field.key, event.target.checked)} /></label>;
      return <label key={field.key}>{field.label}<Input value={String(value)} onChange={event => onChange(field.key, event.target.value)} /></label>;
    })}{advancedFields.some(field => field.key === 'baseUrl') && <small>Base URL 与凭据由本机 Core 保存，不会在设置 DTO 中回显。</small>}</details>}
    {message && <p className="inline-success" role="status">{message}</p>}{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}
    {!loading && provider && configured === false && <p className="muted">该服务商尚未配置凭据。</p>}
  </div>;
}
function SettingsPage({ theme, onThemeChange, onOpenPlugins }: { theme: 'system' | 'light' | 'dark'; onThemeChange(theme: 'system' | 'light' | 'dark'): Promise<void>; onOpenPlugins(): void }) {
  const [activeSection, setActiveSection] = useState('general');
  const [descriptions, setDescriptions] = useState<{ section: string; label: string; fields: SettingField[] }[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [draft, setDraft] = useState<Settings>({});
  const [changes, setChanges] = useState<Record<string, Record<string, unknown>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [current, schema] = await Promise.all([settingsClient.get(), settingsClient.describe()]);
      setDraft(current.settings); setChanges({}); setRevision(current.revision); setDescriptions(schema.fields);
      setRecoveryRequired(current.recoveryRequired);
      setError(current.recoveryRequired ? `${current.lastError ?? '设置文件结构异常'}。原文件已备份：${current.backupPath ?? '备份路径不可用'}。请检查备份后恢复设置。` : '');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  function change(section: string, key: string, value: string | number | boolean) {
    setDraft(current => ({ ...current, [section]: { ...(current[section] ?? {}), [key]: value } }));
    setChanges(current => ({ ...current, [section]: { ...(current[section] ?? {}), [key]: value } }));
  }
  async function save(section: string) {
    if (recoveryRequired) return;
    setSaving(section); setError(''); setNotice('');
    try {
      const values = changes[section] ?? {};
      if (!Object.keys(values).length) return;
      const result = await settingsClient.update(section, values, revision);
      if (section === 'general') await hostClient.setWindowBehavior(result.settings.general?.confirmOnExit !== false);
      setDraft(result.settings); setChanges({}); setRevision(result.revision); setNotice('设置已保存到本机。');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setSaving(''); }
  }
  const sections = descriptions.filter(item => item.section !== 'general' && item.fields.length > 0);
  function renderField(section: string, field: SettingField) {
    if (/(api.?key|secret|token|password|credential|private.?key|pinnedpublickey)/i.test(field.key)) return null;
    const value = draft[section]?.[field.key] ?? field.default;
    const description = field.description || '';
    return <div className="setting-row" key={field.key}><span className="setting-copy"><strong>{SETTING_FIELD_LABELS[field.key] ?? field.label}</strong>{description && <small>{description}</small>}</span>{field.choices?.length ? <Select label={SETTING_FIELD_LABELS[field.key] ?? field.label} value={String(value ?? '')} disabled={field.locked} onChange={event => change(section, field.key, event.target.value)}>{field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</Select> : typeof value === 'boolean' ? <button type="button" role="switch" aria-checked={value} aria-label={SETTING_FIELD_LABELS[field.key] ?? field.label} className={`setting-switch ${value ? 'on' : ''}`} disabled={field.locked} onClick={() => change(section, field.key, !value)}><span /></button> : typeof value === 'number' ? <Input type="number" aria-label={SETTING_FIELD_LABELS[field.key] ?? field.label} value={String(value)} disabled={field.locked} onChange={event => change(section, field.key, Number(event.target.value))} /> : <Input aria-label={SETTING_FIELD_LABELS[field.key] ?? field.label} value={String(value ?? '')} disabled={field.locked} onChange={event => change(section, field.key, event.target.value)} />}</div>;
  }
  const settingPages = [
    { id: 'general', label: '常规' }, { id: 'models', label: '模型' }, { id: 'agents', label: 'Agent' },
    { id: 'extensions', label: '插件与 MCP' }, { id: 'memory', label: '记忆' }, { id: 'workspace', label: '工作区' }, { id: 'devices', label: '设备' },
    { id: 'appearance', label: '外观' }, { id: 'security', label: '隐私与安全' }, { id: 'updates', label: '更新' }, { id: 'advanced', label: '高级' }, { id: 'about', label: '关于' }
  ];
  if (activeSection === 'about') return <AboutPage />;
  function renderSettingsContent() {
    if (activeSection === 'appearance') return <div className="theme-options">{(['system', 'light', 'dark'] as const).map(value => <button key={value} className={`theme-choice ${theme === value ? 'selected' : ''}`} aria-pressed={theme === value} onClick={() => void onThemeChange(value)}><span className={`theme-preview theme-${value}`}><i /><i /><i /></span><span>{value === 'system' ? '跟随系统' : value === 'light' ? '浅色' : '深色'}</span>{theme === value && <Icon name="check" size={16} />}</button>)}</div>;
    const groups = activeSection === 'general' ? descriptions.filter(section => section.section === 'general')
      : activeSection === 'extensions' ? sections.filter(section => section.section === 'extensions')
        : sections.filter(section => section.section === activeSection);
    return <>
      {activeSection === 'extensions' && <Surface className="privacy-summary"><span className="grow"><strong>扩展、插件与 MCP 连接</strong><small>启用开发者模式后可从本地导入扩展。导入包会先进入 Core 权限审查，并以未验证状态安装为停用。</small></span><Button compact onClick={onOpenPlugins}>打开插件中心</Button></Surface>}
      {groups.map(section => <div className="settings-group" key={section.section}><h2>{activeSection === 'general' ? '常规行为' : SETTING_SECTION_LABELS[section.section] ?? section.label}</h2>
        {section.section === 'models' && <ModelConnectionSettings provider={String(draft.models?.provider ?? '')} model={String(draft.models?.defaultModel ?? '')} values={draft.models ?? {}} onChange={(key, value) => change('models', key, value)} />}
        {section.fields.filter(field => !(section.section === 'general' && field.key === 'theme') && (section.section !== 'models' || !['provider', 'defaultModel'].includes(field.key))).map(field => renderField(section.section, field))}
        {section.fields.some(field => !(section.section === 'general' && field.key === 'theme') && (section.section !== 'models' || !['provider', 'defaultModel'].includes(field.key))) && <div className="settings-save"><Button compact variant="primary" disabled={recoveryRequired || saving === section.section} onClick={() => void save(section.section)}>保存{SETTING_SECTION_LABELS[section.section] ?? section.label}</Button></div>}
      </div>)}
      {activeSection === 'security' && <Surface className="privacy-summary"><span className="policy-icon"><Icon name="approval" size={19} /></span><span className="grow"><strong>本地数据与权限</strong><small>会话和配置保存在本机。敏感操作遵循逐次审批。</small></span><Badge tone="success">Core 策略</Badge></Surface>}
      {activeSection === 'devices' && !groups.length && <EmptyNotice icon="plug" title="设备网格设置由 Core 提供" detail="当前没有可调整的设备字段。设备配对和在线状态仍可在 Agents 页面查看。" />}
      {activeSection !== 'appearance' && !groups.length && activeSection !== 'extensions' && activeSection !== 'devices' && <EmptyNotice title="当前没有可调整的设置" detail="可用字段由本机 Core 的设置描述提供。" />}
    </>;
  }
  return <div className="content-page settings-page"><Heading eyebrow="PREFERENCES" title="Settings" description="按类别调整界面偏好和本地工作行为。" />{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}{notice && <p className="inline-success" role="status">{notice}</p>}{loading ? <LoadingState label="正在读取本机设置…" /> : <>
    <Tabs label="设置类别" selected={activeSection} onChange={setActiveSection} items={settingPages} />
    <section className="settings-section"><div className="settings-section-main">{renderSettingsContent()}</div></section>
  </>}</div>;
}

function AboutPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof aboutClient.info>> | null>(null);
  const [feedback, setFeedback] = useState<Awaited<ReturnType<typeof feedbackClient.links>> | null>(null);
  const [update, setUpdate] = useState<Record<string, unknown> | null>(null);
  const [notes, setNotes] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setInfo(await aboutClient.info()); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); void aboutClient.update().then(setUpdate).catch(() => setUpdate(null)); void updateClient.notes().then(setNotes).catch(() => setNotes(null)); void feedbackClient.links().then(setFeedback).catch(() => setFeedback(null)); }, [refresh]);
  async function checkUpdate() {
    setChecking(true); setError('');
    try {
      setUpdate(await updateClient.check());
      setNotes(await updateClient.notes());
      setCheckedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setChecking(false); }
  }
  async function visit(url: string | null) { if (url?.startsWith('https://')) { try { await openExternal(url); } catch (cause) { setError(messageOf(cause)); } } }
  const linkRows = info ? [{ id: 'website', label: '官方网站', url: info.website }, { id: 'gitcode', label: 'GitCode', url: info.gitcode }, { id: 'github', label: 'GitHub', url: info.github }] : [];
  const latestVersionValue = update?.latestVersion ?? update?.latest;
  const latestVersion = typeof latestVersionValue === 'string' ? latestVersionValue : latestVersionValue && typeof latestVersionValue === 'object' ? String((latestVersionValue as { version?: unknown }).version ?? '') : '';
  const updateStatus = updateStatusLabel(String(update?.status ?? 'unknown'));
  const record = notes?.record as { announcement?: { title?: string; notes?: string[]; publishedAt?: string | null } } | undefined;
  const releaseNotes = Array.isArray(record?.announcement?.notes) ? record.announcement.notes : [];  return <div className="content-page about-page"><Heading eyebrow="ABOUT CETAMESH" title="About" description="一个连接本地工具、Agent 与工作流的桌面空间。" />{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}{loading ? <LoadingState label="正在读取版本信息…" /> : info && <>
    <Surface className="about-hero"><span className="about-brand-mark"><Icon name="sparkles" size={34} /></span><span className="grow"><strong>CetaMesh Desktop</strong><small>让本地 Agent 协作保持透明、可控。</small></span><Badge tone="success">UX v2 · Harbor</Badge></Surface>
    <div className="about-facts"><Surface><small>版本</small><strong>{info.version ?? '未知'}</strong><span>构建号 {info.buildNumber ?? '未知'} · {info.channel ?? '未指定'}</span><small>构建标识 {info.buildId ?? '本地构建'}</small></Surface><Surface><small>开发者</small><strong>{info.developer ?? '未配置'}</strong><span>{info.platform ?? 'Windows 桌面应用'}</span></Surface><Surface className="update-card"><div className="row between"><strong>软件更新</strong><Icon name="update" size={18} /></div><span>当前版本 {info.version ?? '未知'}</span><span>最新版本 {latestVersion || '尚未检查'}</span><small>更新状态：{updateStatus}</small><small>{checkedAt ? `最近检查 ${checkedAt}` : '尚未检查更新'}</small><Button compact disabled={checking} onClick={() => void checkUpdate()}>{checking ? '正在检查…' : '检查更新'}</Button></Surface></div>
    <section className="about-links"><h2>项目链接</h2><Surface>{linkRows.map(row => <button className="about-link-row" key={row.id} onClick={() => void visit(row.url ?? null)} disabled={!row.url?.startsWith('https://')}><Icon name="globe" size={18} /><span>{row.label}</span><span className="grow" /><small>{row.url ? row.url.replace(/^https:\/\//, '') : '未配置'}</small><Icon name="right" size={15} /></button>)}</Surface></section>
    <section className="about-links"><h2>反馈与安全</h2><Surface>{feedback?.entries.map(entry => <button className="about-link-row" key={entry.id} onClick={() => void visit(entry.url)} disabled={!entry.url}><Icon name={entry.kind === 'security' ? 'approval' : 'globe'} size={18} /><span><strong>{entry.label}</strong><small className="feedback-description">{entry.description}</small></span><span className="grow" /><small>{entry.url ? entry.url.replace(/^https:\/\//, '') : feedback.message || '暂未配置'}</small><Icon name="right" size={15} /></button>)}{feedback?.securityNotice && <p className="security-notice">{feedback.securityNotice}</p>}{!feedback && <p className="muted">反馈入口由本机产品配置提供。</p>}</Surface></section>
    {releaseNotes.length > 0 && <section className="about-links"><h2>更新说明</h2><Surface>{releaseNotes.map((line, index) => <div className="release-note-row" key={index}><p>{line}</p></div>)}</Surface></section>}
    <p className="about-footnote">桌面使用 WebView2 展示界面，Core 服务和命名管道保持本地运行。</p>
  </>}</div>;
}

function OnboardingPage({ onComplete }: { onComplete(): Promise<void> }) {
  const [status, setStatus] = useState<{ complete: boolean; currentStep: string | null; steps: { id: string; title: string; description: string; status: string; optional: boolean }[] } | null>(null);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof chatClient.catalog>> | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [apiKeyEntered, setApiKeyEntered] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionResult, setConnectionResult] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const next = await onboardingClient.status(); setStatus(next); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void onboardingClient.start().then(setStatus).catch(cause => setError(messageOf(cause))); void chatClient.catalog().then(result => { setCatalog(result); const selected = result.defaultModelProvider ?? result.modelProviders.find(item => item.configured)?.id ?? result.modelProviders[0]?.id ?? ''; setProvider(selected); }).catch(() => setCatalog(null)); void refresh(); }, [refresh]);
  const activeStep = status?.steps.find(step => step.id === status.currentStep) ?? null;
  const providerOptions = catalog?.modelProviders ?? [];
  const selectedProvider = providerOptions.find(item => item.id === provider);
  const modelOptions = (selectedProvider?.models ?? []).map(item => ({ id: item.id ?? item.name ?? item.label ?? '', label: item.label ?? item.name ?? item.id ?? '' })).filter(item => item.id);
  async function finishStep(stepId: string, data: Record<string, unknown> = {}) {
    setBusy(true); setError(''); setNotice('');
    try { await onboardingClient.completeStep(stepId, data); await refresh(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function skipStep(stepId: string) {
    setBusy(true); setError(''); setNotice('');
    try { await onboardingClient.skipStep(stepId); await refresh(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function testConnection(saveProvider: boolean) {
    setBusy(true); setError(''); setNotice(''); setConnectionResult('');
    const key = apiKeyRef.current?.value ?? '';
    if (apiKeyRef.current) apiKeyRef.current.value = '';
    setApiKeyEntered(false);
    try {
      const result = await onboardingClient.testProvider(provider, key, baseUrl, model);
      if (!result.ok) { setConnectionResult(String(result.message ?? '连接测试失败。')); return; }
      if (saveProvider && status?.steps.some(step => step.id === 'provider' && step.status !== 'completed')) await onboardingClient.completeStep('provider', { provider });
      if (status?.steps.some(step => step.id === 'connection' && step.status !== 'completed')) await onboardingClient.completeStep('connection', { provider });
      setCatalog(await chatClient.catalog());
      setConnectionResult(String(result.message ?? '连接成功。'));
      await refresh();
    } catch (cause) { setConnectionResult(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function selectModel() {
    if (!provider || !model) return;
    setBusy(true); setError(''); setNotice('');
    try { await onboardingClient.setModel(provider, model); await refresh(); setNotice('默认模型已保存。'); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  async function completeSetup() {
    setBusy(true); setError('');
    try { await onboardingClient.finish(); await onComplete(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  if (loading) return <div className="content-page"><LoadingState label="正在准备首次设置…" /></div>;
  return <div className="content-page onboarding-page"><div className="onboarding-card"><div className="onboarding-mark"><Icon name="sparkles" size={29} /></div><p className="eyebrow">WELCOME TO CETAMESH</p><h1>开始使用 CetaMesh</h1><p className="page-description">先完成模型服务商和默认模型设置。Agent 与插件可以稍后配置。</p>{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}{notice && <p className="inline-success" role="status">{notice}</p>}{connectionResult && <p className="connection-result" role="status">{connectionResult}</p>}
    {status && <ol className="onboarding-steps">{status.steps.map((step, index) => <li className={step.status === 'completed' || step.status === 'skipped' ? 'done' : step.id === status.currentStep ? 'current' : ''} key={step.id}><span>{step.status === 'completed' ? <Icon name="check" size={15} /> : index + 1}</span><div><strong>{step.title}{step.optional && <small> · 可选</small>}</strong><small>{step.description}</small></div></li>)}</ol>}
    {!activeStep && status?.complete && <Surface><strong>首次设置已完成。</strong><p>你可以随时在 Settings、Agents 和 Plugins 中调整偏好。</p><Button variant="primary" onClick={() => void onComplete()}>进入 Chat</Button></Surface>}
    {activeStep?.id === 'welcome' && <Button variant="primary" disabled={busy} onClick={() => void finishStep('welcome')}>继续设置</Button>}
    {activeStep?.id === 'provider' && <div className="onboarding-form"><Select label="模型服务商" value={provider} onChange={event => setProvider(event.target.value)}><option value="">选择服务商</option>{providerOptions.map(item => <option key={item.id} value={item.id}>{item.label}{item.configured ? ' · 已配置' : ''}</option>)}</Select><Input ref={apiKeyRef} aria-label="API Key" type="password" autoComplete="new-password" placeholder="输入 API Key；仅发送给本机 Core" onChange={event => setApiKeyEntered(Boolean(event.target.value))} /><Input aria-label="服务商 Base URL（可选）" placeholder="Base URL（可选）" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /><Button variant="primary" disabled={busy || !provider || (!apiKeyEntered && !selectedProvider?.configured)} onClick={() => void testConnection(true)}>{busy ? '正在测试…' : '保存并测试连接'}</Button><small>凭据由本机 Core 保存。输入内容不会在页面状态中保留。</small></div>}
    {activeStep?.id === 'connection' && <div className="onboarding-form"><p>使用已保存的服务商凭据测试连接。若要更换 Key，请返回服务商步骤。</p><Button variant="primary" disabled={busy || !provider} onClick={() => void testConnection(false)}>{busy ? '正在测试…' : '测试连接'}</Button></div>}
    {activeStep?.id === 'model' && <div className="onboarding-form"><Select label="默认模型服务商" value={provider} onChange={event => { setProvider(event.target.value); setModel(''); }}><option value="">选择服务商</option>{providerOptions.filter(item => item.configured).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>{modelOptions.length ? <Select label="默认模型" value={model} onChange={event => setModel(event.target.value)}><option value="">选择默认模型</option>{modelOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select> : <Input aria-label="默认模型 ID" placeholder="输入模型 ID" value={model} onChange={event => setModel(event.target.value)} />}<Button variant="primary" disabled={busy || !provider || !model} onClick={() => void selectModel()}>{busy ? '正在保存…' : '保存默认模型'}</Button></div>}
    {(activeStep?.id === 'agent' || activeStep?.id === 'integration') && <div className="onboarding-form"><p>此步骤可稍后在 {activeStep.id === 'agent' ? 'Agents' : 'Plugins'} 页面完成。</p><div className="row"><Button onClick={() => void finishStep(activeStep.id)}>现在完成此步骤</Button><Button variant="primary" disabled={busy} onClick={() => void skipStep(activeStep.id)}>稍后设置</Button></div></div>}
    {activeStep?.id === 'done' && <Surface className="onboarding-done"><Icon name="check" size={22} /><strong>必需设置已完成</strong><p>你可以进入 CetaMesh 并开始新的会话。</p><Button variant="primary" disabled={busy} onClick={() => void completeSetup()}>{busy ? '正在完成…' : '完成并进入 Chat'}</Button></Surface>}
  </div></div>;
}
