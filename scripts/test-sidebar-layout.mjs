import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(root + 'package.json');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { WorkspaceSidebar, groupWorkspaceSessions } = await vite.ssrLoadModule('/src/app/WorkspaceSidebar.tsx');
  const workspaces = [{ id: 'w1', name: 'NexBox-main', status: 'ready' }, { id: 'w2', name: 'CetaMesh', status: 'ready' }];
  const sessions = [
    { id: 's1', title: '分析项目', config: { workspaceId: 'w1' } },
    { id: 's2', title: '普通聊天', config: { workspaceId: null } },
    { id: 's3', title: '旧工作区会话', config: { workspaceId: 'removed' } },
    { id: 's4', title: '第二项目', config: { workspaceId: 'w2' } }
  ];
  const grouped = groupWorkspaceSessions(workspaces, sessions);
  assert.deepEqual(grouped.projects.map(group => group.sessions.map(session => session.id)), [['s1'], ['s4']]);
  assert.deepEqual(grouped.recent.map(session => session.id), ['s2', 's3'], 'unknown workspace sessions remain reachable');
  assert.equal(new Set([...grouped.projects.flatMap(group => group.sessions), ...grouped.recent].map(session => session.id)).size, sessions.length);
  const props = { page: 'chat', workspaces, sessions, activeWorkspaceId: 'w1', activeSessionId: 's1', taskCount: 10, hostStatus: 'ready', collapsed: false, onToggle() {}, onNavigate() {}, onOpenWorkspace() {}, onOpenSession() {}, onNewSession() {}, onAllSessions() {}, renderSessionActions: () => null };
  const html = renderToStaticMarkup(React.createElement(WorkspaceSidebar, props));
  for (const label of ['Chat', 'Work', '记忆', 'Agents', 'Plugins', 'Settings', '关于']) {
    assert.ok(html.includes(`aria-label="${label}"`), `accessible icon ${label}`);
    assert.ok(!html.includes(`<span>${label}</span>`), `no visible rail label ${label}`);
  }
  assert.ok(html.includes('aria-expanded="true"'));
  const memory = renderToStaticMarkup(React.createElement(WorkspaceSidebar, { ...props, page: 'memory', collapsed: true }));
  assert.match(memory, /<button[^>]*aria-label="记忆"[^>]*aria-current="page"/);
  for (const label of ['分析项目', '普通聊天', '旧工作区会话', 'NexBox-main', '查看全部会话']) assert.ok(html.includes(label));
  assert.equal((html.match(/>分析项目</g) ?? []).length, 1);
  const closed = renderToStaticMarkup(React.createElement(WorkspaceSidebar, { ...props, collapsed: true }));
  assert.ok(closed.includes('aria-label="展开工作区列表"'));
  assert.ok(!closed.includes('class="workspace-panel"'), 'collapsed panel is unmounted and has no hidden focus targets');
  const settings = renderToStaticMarkup(React.createElement(WorkspaceSidebar, { ...props, page: 'settings', collapsed: true }));
  assert.ok(!settings.includes('rail-panel-toggle'), 'settings page has no ineffective workspace expansion control');
  console.log('PASS workspace grouping, orphan session reachability, icon accessible names, compact list and collapsed focus boundary');
} finally { await vite.close(); }
