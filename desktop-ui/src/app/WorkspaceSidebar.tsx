import type { ReactNode } from 'react';
import type { ChatSession } from '../bridge/typed-client';
import { Icon, type IconName } from '../components/icons';

type Workspace = { id: string; name: string; status: string };
type NavigationPage = 'chat' | 'work' | 'memory' | 'agents' | 'plugins' | 'settings' | 'about';
const navigation: { id: NavigationPage; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' }, { id: 'work', label: 'Work', icon: 'work' },
  { id: 'memory', label: '记忆', icon: 'memory' },
  { id: 'agents', label: 'Agents', icon: 'agents' }, { id: 'plugins', label: 'Plugins', icon: 'plugins' },
  { id: 'settings', label: 'Settings', icon: 'settings' }, { id: 'about', label: '关于', icon: 'help' }
];

export function groupWorkspaceSessions(workspaces: Workspace[], sessions: ChatSession[]) {
  const buckets = new Map(workspaces.map(workspace => [workspace.id, [] as ChatSession[]]));
  const recent: ChatSession[] = [];
  for (const session of sessions) {
    const bucket = session.config.workspaceId ? buckets.get(session.config.workspaceId) : undefined;
    if (bucket) bucket.push(session);
    else recent.push(session);
  }
  return { projects: workspaces.map(workspace => ({ ...workspace, sessions: buckets.get(workspace.id)! })), recent };
}

export function WorkspaceSidebar({ page, workspaces, sessions, activeWorkspaceId, activeSessionId, taskCount,
  hostStatus, collapsed, workspaceError, sessionError, onToggle, onNavigate, onOpenWorkspace, onOpenSession,
  onNewSession, onAllSessions, renderSessionActions }: {
  page: string; workspaces: Workspace[]; sessions: ChatSession[]; activeWorkspaceId: string | null;
  activeSessionId: string; taskCount: number; hostStatus: 'ready' | 'checking' | 'offline'; collapsed: boolean;
  workspaceError?: string; sessionError?: string; onToggle(): void; onNavigate(page: NavigationPage): void;
  onOpenWorkspace(id: string): void; onOpenSession(id: string): void; onNewSession(): void;
  onAllSessions(): void; renderSessionActions(session: ChatSession): ReactNode;
}) {
  const { projects, recent } = groupWorkspaceSessions(workspaces, sessions);
  const connection = hostStatus === 'ready' ? '已连接' : hostStatus === 'checking' ? '正在连接' : '桌面服务离线';
  const railButton = (item: typeof navigation[number]) => <button key={item.id} type="button"
    className={`nav-item rail-button ${page === item.id ? 'active' : ''}`} aria-label={item.label} title={item.label}
    aria-current={page === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
    <Icon name={item.icon} size={21} />
    {item.id === 'work' && taskCount > 0 && <small className="nav-count" aria-label={`${taskCount} 个任务`}>{taskCount > 99 ? '99+' : taskCount}</small>}
  </button>;
  const sessionRow = (session: ChatSession) => <div className="session-row" key={session.id}>
    <button type="button" className={`session-item ${activeSessionId === session.id ? 'selected' : ''}`}
      title={session.title || '新会话'} aria-current={activeSessionId === session.id ? 'page' : undefined}
      onClick={() => onOpenSession(session.id)}><Icon name="file" size={15} /><span className="session-copy"><strong>{session.title || '新会话'}</strong></span></button>
    {renderSessionActions(session)}
  </div>;
  return <aside className={`harbor-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="应用导航与工作区">
    <div className="navigation-rail">
      <nav aria-label="工作空间" className="primary-nav">{navigation.filter(item => item.id !== 'settings' && item.id !== 'about').map(railButton)}</nav>
      {page !== 'settings' && <button type="button" className="rail-panel-toggle" aria-label={collapsed ? '展开工作区列表' : '收起工作区列表'}
        title={collapsed ? '展开工作区列表' : '收起工作区列表'} aria-expanded={!collapsed} aria-controls="workspace-panel" onClick={onToggle}><Icon name="panelLeft" size={19} /></button>}
      <div className="sidebar-bottom">
        <nav aria-label="设置与帮助" className="utility-nav">{navigation.filter(item => item.id === 'settings' || item.id === 'about').map(railButton)}</nav>
        <div className="profile-avatar" title="本地用户 · 个人空间" role="img" aria-label="本地用户，个人空间">CM</div>
      </div>
    </div>
    {!collapsed && <section className="workspace-panel" id="workspace-panel" aria-label="工作区与会话">
      <div className="workspace-panel-heading"><details className="workspace-switch"><summary><strong>工作区</strong><Icon name="down" size={14} /></summary>
        <div className="workspace-menu">{workspaces.map(workspace => <button type="button" key={workspace.id} aria-current={workspace.id === activeWorkspaceId ? 'true' : undefined} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onOpenWorkspace(workspace.id); }}><strong>{workspace.name}</strong><small>{workspace.status}</small></button>)}
          {!workspaces.length && <p>尚未登记工作区</p>}<button type="button" className="workspace-add" onClick={() => onNavigate('work')}>管理工作区</button></div></details>
      </div>
      <button type="button" className="sidebar-new-session" onClick={onNewSession}><Icon name="add" size={18} />新会话</button>
      <div className="sidebar-scroll">
        {workspaceError && <p className="sidebar-error" role="alert">{workspaceError}</p>}
        {sessionError && <p className="sidebar-error" role="alert">{sessionError}</p>}
        <section className="workspace-projects" aria-label="项目"><div className="session-heading"><span className="nav-label">项目</span><button type="button" aria-label="管理工作区" title="管理工作区" onClick={() => onNavigate('work')}><Icon name="add" size={17} /></button></div>
          {projects.map(project => <details className="workspace-project" key={project.id} open={project.id === activeWorkspaceId || project.sessions.some(session => session.id === activeSessionId)}>
            <summary title={project.name}><Icon name="right" size={13} /><Icon name="folder" size={17} /><strong>{project.name}</strong>{project.id === activeWorkspaceId && <span className="workspace-current-dot" title="当前工作区" />}</summary>
            <div className="workspace-session-list">{project.sessions.map(sessionRow)}{!project.sessions.length && <p className="sidebar-empty">暂无会话</p>}</div>
          </details>)}{!projects.length && <p className="sidebar-empty">在 Work 中添加工作区</p>}
        </section>
        <section className="session-section" aria-label="最近会话"><div className="session-heading"><span className="nav-label">最近会话</span></div><div className="session-list">{recent.slice(0, 7).map(sessionRow)}</div>
          {!recent.length && <p className="sidebar-empty">暂无其他会话</p>}<button type="button" className="all-sessions" onClick={onAllSessions}>查看全部会话<Icon name="right" size={13} /></button></section>
      </div>
      <div className="host-indicator" role="status"><span className={`host-dot ${hostStatus}`} /><span>{connection}</span></div>
    </section>}
  </aside>;
}
