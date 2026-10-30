import { useEffect, useRef, useState } from 'react';

type GitEntry = { x: string; y: string; path: string; origPath?: string | null; conflict: boolean; commitEligible: boolean; sha256?: string | null; blockedReason?: string };
type GitTask = { id: string; goal: string; status: string; workspaceId: string; readOnly: boolean };
type GitOverview = {
  workspaceId: string;
  git: { isRepo: boolean; branch: string; headSha: string | null; dirty: boolean; entries: GitEntry[] };
  conflicts: GitEntry[];
  branches: { name: string; headSha: string; current: boolean; upstream: string | null; taskId: string | null; baselineHead: string | null }[];
  history: { sha: string; parents: string[]; committedAt: number; subject: string }[];
  worktrees: { workspaceId: string | null; name: string; branch: string | null; headSha: string | null; current: boolean; managed: boolean; locked: boolean; prunable: boolean; taskId: string | null; parentWorkspaceId: string | null; baselineHead: string | null }[];
  tasks: GitTask[];
  worktreeRelation?: { taskId: string; parentWorkspaceId: string; branch: string; baselineHead: string } | null;
  truncated: boolean;
};
type GitDiff = { output: string; cached: boolean; truncated: boolean; hasChanges: boolean };
export type GitWorkspaceProps = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  workspaces: { id: string; name: string }[];
  activeWorkspaceId?: string | null;
  onWorkspaceChanged?(): void | Promise<void>;
  onOpenTask?(id: string): void;
};
const shortSha = (sha: string | null | undefined) => sha ? sha.slice(0, 10) : '尚无提交';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const terminal = (task: GitTask) => ['completed', 'failed', 'cancelled'].includes(task.status);
const css = `
.git-workspace{height:100%;overflow:auto;padding:28px 32px;color:var(--text-primary,#303c36)}
.git-workspace *{box-sizing:border-box}.git-workspace button,.git-workspace input,.git-workspace select,.git-workspace textarea{font:inherit}
.git-workspace h1{font-size:24px;margin:0 0 5px}.git-workspace h2{font-size:15px;margin:0 0 12px}.git-workspace p{line-height:1.65}.git-workspace small{color:var(--text-secondary,#737b72)}
.git-heading,.git-toolbar,.git-inline{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.git-heading{justify-content:space-between;margin-bottom:22px}.git-heading p{margin:0;color:var(--text-secondary,#737b72);font-size:13px}
.git-workspace button{cursor:pointer;background:var(--surface,#fbfcf8);border:1px solid var(--border,#dbe1d5);border-radius:8px;padding:8px 12px;color:inherit}.git-workspace button:disabled{opacity:.45;cursor:default}.git-workspace button.git-primary{background:#4d6952;border-color:#4d6952;color:#fff}.git-workspace button.git-link{padding:0;border:0;background:none;color:#4d6952;text-align:left}
.git-workspace input:not([type=checkbox]),.git-workspace select,.git-workspace textarea{min-width:0;max-width:100%;border:1px solid var(--border,#dbe1d5);border-radius:8px;background:var(--surface,#fffef9);color:inherit;padding:9px 11px}.git-workspace label{font-size:13px}.git-workspace select{min-width:170px}
.git-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px}.git-stat{padding:15px 17px;border:1px solid var(--border,#dbe1d5);border-radius:12px;background:var(--surface,#fffef9)}.git-stat strong{display:block;font-size:18px;margin:5px 0;overflow:hidden;text-overflow:ellipsis}.git-stat small{font-size:11px}.git-stat.warn{border-color:#dbbc81}
.git-layout{display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:20px}.git-panel{min-width:0;padding:18px;border:1px solid var(--border,#dbe1d5);border-radius:12px;background:var(--surface,#fffef9)}.git-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border,#dbe1d5);margin:-4px 0 16px;padding-bottom:12px}.git-tabs button{border:0;background:none;padding:6px 10px;font-size:13px}.git-tabs button[aria-selected=true]{background:#e8eee3;color:#354d39}
.git-file{display:grid;grid-template-columns:18px 32px minmax(0,1fr);align-items:start;gap:10px;padding:12px 0;border-bottom:1px solid var(--border,#eef0e9);font-size:13px}.git-file code{white-space:pre-wrap;overflow-wrap:anywhere}.git-file small{display:block;margin-top:5px;font-size:11px}.git-file input{margin:3px 0}.git-status-code{font-family:monospace;color:#667b53;white-space:pre}.git-file.conflicted{color:#9c6227}.git-empty{padding:30px 8px;text-align:center;color:var(--text-secondary,#737b72);font-size:13px}
.git-commit{margin-top:18px;padding-top:15px;border-top:1px solid var(--border,#dbe1d5);display:grid;gap:10px}.git-commit textarea{resize:vertical;width:100%;font-size:13px}.git-commit p{margin:0;font-size:12px}
.git-notice{padding:11px 14px;border-radius:9px;background:#edf1e7;margin:0 0 16px;font-size:13px;overflow-wrap:anywhere}.git-notice.error{background:#fff1e7;color:#925536}.git-side{display:grid;gap:16px;align-content:start}.git-side label{display:grid;gap:7px;margin-top:13px}.git-side p{font-size:12px;color:var(--text-secondary,#737b72)}.git-side button.git-primary{margin-top:14px;width:100%}.git-side .git-inline button{flex:1;font-size:12px;margin-top:0}
.git-data-row{padding:12px 0;border-bottom:1px solid var(--border,#eef0e9);display:flex;gap:14px;justify-content:space-between;align-items:start;font-size:13px}.git-data-row>div{min-width:0}.git-data-row strong{display:block;overflow-wrap:anywhere}.git-data-row small{display:block;margin-top:5px}.git-data-row code{font-size:11px;white-space:nowrap}.git-pill{font-size:10px;padding:3px 7px;border-radius:12px;background:#e8eee3;color:#4d6952;white-space:nowrap}
.git-diff{white-space:pre;tab-size:4;overflow:auto;max-height:58vh;padding:14px;margin:14px 0 0;border-radius:8px;background:var(--background,#f7f8f3);font:11px/1.8 Consolas,monospace;color:inherit}.git-review{padding:12px;background:#edf1e7;border-radius:9px;margin-top:14px}.git-review code{display:block;font-size:11px;overflow-wrap:anywhere}.git-review .git-inline{margin-top:10px}.git-worktree-list button{font-size:12px}.git-task-item{padding:10px 0;border-bottom:1px solid var(--border,#eef0e9);font-size:12px}.git-task-item small{display:block;margin-top:5px}
@media(max-width:1100px){.git-layout{grid-template-columns:minmax(0,1fr)}.git-side{grid-template-columns:repeat(2,minmax(0,1fr))}.git-workspace{padding:20px}.git-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.git-side{grid-template-columns:minmax(0,1fr)}.git-workspace{padding:15px}.git-summary{gap:8px}.git-stat{padding:12px}.git-heading{align-items:start}}
`;

/** Renderer has no repository paths or Git commands; the injected call uses Owner UI DTOs. */
export function GitWorkspace({ call, workspaces, activeWorkspaceId, onWorkspaceChanged, onOpenTask }: GitWorkspaceProps) {
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? '');
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [tab, setTab] = useState('changes');
  const [cached, setCached] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [diffError, setDiffError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [taskId, setTaskId] = useState('');
  const [branch, setBranch] = useState('');
  const [review, setReview] = useState<'branch' | 'worktree' | null>(null);
  const callRef = useRef(call); callRef.current = call;
  const generation = useRef(0);

  useEffect(() => { if (activeWorkspaceId) setWorkspaceId(activeWorkspaceId); }, [activeWorkspaceId]);
  useEffect(() => { if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id); }, [workspaceId, workspaces]);
  useEffect(() => {
    const epoch = ++generation.current;
    setOverview(null); setSelected([]); setReview(null); setError('');
    if (!workspaceId) return;
    setLoading(true);
    void callRef.current('ui.workspace.git.overview', { id: workspaceId }).then(value => {
      if (generation.current !== epoch) return;
      const current = value as GitOverview; setOverview(current);
      setTaskId(previous => current.tasks.some(task => task.id === previous && !terminal(task) && !task.readOnly) ? previous : current.tasks.find(task => !terminal(task) && !task.readOnly)?.id ?? '');
    }).catch(cause => { if (generation.current === epoch) setError(errorMessage(cause)); })
      .finally(() => { if (generation.current === epoch) setLoading(false); });
    return () => { generation.current++; };
  }, [workspaceId, revision]);
  useEffect(() => {
    let current = true; setDiff(null); setDiffError('');
    if (!workspaceId || tab !== 'diff') return;
    void callRef.current('ui.workspace.git.diff', { id: workspaceId, cached }).then(value => { if (current) setDiff(value as GitDiff); })
      .catch(cause => { if (current) setDiffError(errorMessage(cause)); });
    return () => { current = false; };
  }, [workspaceId, revision, cached, tab]);

  const entries = overview?.git.entries ?? [];
  const eligible = entries.filter(entry => entry.commitEligible);
  const tasks = overview?.tasks ?? [];
  const currentTask = tasks.find(task => task.id === taskId);
  const locked = loading || busy;
  const canCreate = !!overview?.git.headSha && !!currentTask && !terminal(currentTask) && !currentTask.readOnly && !!branch.trim() && !overview.conflicts.length;
  const tabs = [{ id: 'changes', label: '变更', count: entries.length }, { id: 'diff', label: 'Diff' }, { id: 'branches', label: '分支', count: overview?.branches.length }, { id: 'history', label: '提交记录' }, { id: 'worktrees', label: 'Agent Worktree', count: overview?.worktrees.length }];
  async function mutate(method: string, params: Record<string, unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await callRef.current(method, params) as { status?: string; committed?: boolean; created?: boolean; code?: string; result?: { committed?: boolean; created?: boolean; status?: string } };
      const result = response.result ?? response;
      if (response.status === 'pending' || result.status === 'pending') setNotice('请求正在等待审批，请打开任务页，在审批面板确认当前操作。');
      else if (result.committed === false) setNotice('所选文件没有可提交的变化。');
      else if (response.status === 'failed' || response.status === 'rejected') throw new Error('操作未完成，请查看审批或错误详情。');
      else setNotice(success);
      setReview(null); setRevision(value => value + 1); await onWorkspaceChanged?.();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!overview || !selected.length || !message.trim()) return;
    const selectedEntries = entries.filter(entry => selected.includes(entry.path) && entry.commitEligible);
    await mutate('ui.workspace.git.commit', { id: workspaceId, ...(taskId ? { taskId } : {}), message: message.trim(), paths: selectedEntries.map(entry => entry.path), expectedHead: overview.git.headSha, expectedHashes: Object.fromEntries(selectedEntries.map(entry => [entry.path, entry.sha256])) }, '所选文件已提交，未选中的改动已保留。');
  }
  async function openWorktree(id: string) {
    setBusy(true); setError('');
    try { await callRef.current('ui.workspace.open', { id }); setWorkspaceId(id); setTaskId(''); await onWorkspaceChanged?.(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="git-workspace"><style>{css}</style>
    <header className="git-heading"><div><h1>Git</h1><p>查看项目变更、提交记录与 Agent 的隔离工作区。</p></div><div className="git-toolbar">
      <select aria-label="Git 工作区" value={workspaceId} disabled={busy} onChange={event => { setWorkspaceId(event.target.value); setTaskId(''); setNotice(''); }}><option value="" disabled>选择工作区</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>
      <button type="button" disabled={locked || !workspaceId} onClick={() => setRevision(value => value + 1)}>刷新</button></div></header>
    {error && <div className="git-notice error" role="alert">{error}</div>}{notice && <div className="git-notice" role="status">{notice}</div>}
    {!workspaceId ? <div className="git-empty">先登记一个本地项目工作区。</div> : loading ? <div className="git-empty" role="status">正在读取 Git 状态…</div> : overview && !overview.git.isRepo ? <div className="git-empty">这个工作区尚未初始化 Git 仓库。</div> : overview && <>
      <div className="git-summary"><div className="git-stat"><small>当前分支</small><strong title={overview.git.branch}>{overview.git.branch || 'Detached HEAD'}</strong><small>{shortSha(overview.git.headSha)}</small></div><div className="git-stat"><small>待处理变更</small><strong>{entries.length}</strong><small>{overview.git.dirty ? '包含工作目录与暂存区' : '工作目录干净'}</small></div><div className={`git-stat ${overview.conflicts.length ? 'warn' : ''}`}><small>冲突</small><strong>{overview.conflicts.length}</strong><small>{overview.conflicts.length ? '需要在项目中处理后刷新' : '没有未合并的文件'}</small></div><div className="git-stat"><small>Agent Worktree</small><strong>{overview.worktrees.filter(item => item.managed).length}</strong><small>已登记的任务隔离目录</small></div></div>
      {overview.truncated && <p className="git-notice">项目数据超过显示上限；这里只显示有界的状态、分支或工作区列表。</p>}
      {overview.worktreeRelation && <p className="git-notice">隔离分支 {overview.worktreeRelation.branch} · 关联 Task {overview.worktreeRelation.taskId} · 基线 {shortSha(overview.worktreeRelation.baselineHead)}</p>}
      <div className="git-layout"><section className="git-panel" aria-label="Git 项目数据"><div className="git-tabs" role="tablist" aria-label="Git 视图">{tabs.map(item => <button type="button" key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}{item.count !== undefined ? ` ${item.count}` : ''}</button>)}</div>
        {tab === 'changes' && <><div className="git-inline"><h2 style={{ margin: 0 }}>文件变更</h2><button type="button" disabled={locked || !eligible.length || !!overview.conflicts.length} onClick={() => setSelected(selected.length === eligible.length ? [] : eligible.map(entry => entry.path))}>{selected.length === eligible.length && eligible.length ? '取消全选' : '选择可提交文件'}</button><small>{selected.length} 个已选择</small></div>
          {!entries.length && <div className="git-empty">所有改动都已提交。</div>}{entries.map(entry => <label className={`git-file ${entry.conflict ? 'conflicted' : ''}`} key={entry.path}><input type="checkbox" aria-label={`提交 ${entry.path}`} checked={selected.includes(entry.path)} disabled={locked || !entry.commitEligible || !!overview.conflicts.length} onChange={event => setSelected(previous => event.target.checked ? [...previous, entry.path] : previous.filter(item => item !== entry.path))} /><span className="git-status-code">{entry.x}{entry.y}</span><span><code>{entry.path}</code>{entry.origPath && <small>来自 {entry.origPath}</small>}{entry.conflict ? <small>文件包含未解决的 Git 冲突</small> : !entry.commitEligible ? <small>需要单独审查 · {entry.blockedReason}</small> : <small title={entry.sha256 ?? '已删除'}>{entry.sha256 ? `SHA-256 ${entry.sha256.slice(0, 16)}…` : '已删除 · 提交将记录删除'}</small>}</span></label>)}
          <div className="git-commit"><label htmlFor="git-commit-message">提交信息</label><textarea id="git-commit-message" value={message} onChange={event => setMessage(event.target.value)} placeholder="说明这次改动解决了什么" rows={2} maxLength={2000} disabled={locked} /><p><small>只提交已选文件，审批绑定当前 HEAD 与页面读取到的文件内容。</small></p><div className="git-inline"><button type="button" className="git-primary" disabled={locked || !selected.length || !message.trim() || !!overview.conflicts.length} onClick={() => void commit()}>提交所选文件（{selected.length}）</button><small>{overview.conflicts.length ? '冲突处理完成后才能提交' : `基于 ${shortSha(overview.git.headSha)}`}</small></div></div></>}
        {tab === 'diff' && <><div className="git-inline"><h2 style={{ margin: 0 }}>代码差异</h2><select aria-label="Diff 来源" value={cached ? 'cached' : 'working'} onChange={event => setCached(event.target.value === 'cached')}><option value="working">工作目录</option><option value="cached">暂存区</option></select></div>{diffError ? <p className="git-notice error" role="alert">{diffError}</p> : !diff ? <div className="git-empty">正在读取 Diff…</div> : <>{diff.truncated && <p className="git-notice">Diff 已截断，提交前请检查完整文件。</p>}<pre className="git-diff">{diff.output || '当前来源没有已跟踪文件的差异。未跟踪文件可在文件变更中查看。'}</pre></>}</>}
        {tab === 'branches' && <>{!overview.branches.length && <div className="git-empty">首次提交后会显示本地分支。</div>}{overview.branches.map(item => <div className="git-data-row" key={item.name}><div><strong>{item.name}</strong><small>{item.upstream ? `跟踪 ${item.upstream}` : '本地分支'}{item.taskId ? ` · Task ${item.taskId}` : ''}</small></div><div>{item.current && <span className="git-pill">当前分支</span>}<small><code>{shortSha(item.headSha)}</code></small></div></div>)}</>}
        {tab === 'history' && <>{!overview.history.length && <div className="git-empty">仓库还没有提交记录。</div>}{overview.history.map(item => <div className="git-data-row" key={item.sha}><div><strong>{item.subject}</strong><small>{new Date(item.committedAt).toLocaleString()} · {item.parents.length > 1 ? '合并提交' : '提交'}</small></div><code title={item.sha}>{shortSha(item.sha)}</code></div>)}</>}
        {tab === 'worktrees' && <div className="git-worktree-list">{overview.worktrees.map((item, index) => <div className="git-data-row" key={item.workspaceId ?? `${item.branch}-${index}`}><div><strong>{item.branch || 'Detached HEAD'} {item.current && <span className="git-pill">当前</span>}</strong><small>{item.managed ? 'Agent 隔离目录' : item.workspaceId ? '已登记工作区' : '外部工作区'} · {item.name}</small><small>{shortSha(item.headSha)}{item.taskId ? ` · Task ${item.taskId}` : ''}{item.locked ? ' · 已锁定' : ''}{item.prunable ? ' · 需要检查登记状态' : ''}</small></div>{item.workspaceId && !item.current && <button type="button" disabled={locked} onClick={() => void openWorktree(item.workspaceId!)}>打开</button>}</div>)}</div>}
      </section><aside className="git-side"><section className="git-panel"><h2>为任务创建分支</h2><p>基于当前提交创建分支或隔离目录。源工作区中的未提交改动保留在原处。</p><label>关联 Task<select aria-label="关联 Task" disabled={locked} value={taskId} onChange={event => { setTaskId(event.target.value); setReview(null); }}><option value="">选择当前工作区的任务</option>{tasks.map(task => <option key={task.id} value={task.id} disabled={terminal(task) || task.readOnly}>{task.goal}{task.readOnly ? ' · 只读' : terminal(task) ? ' · 已结束' : ''}</option>)}</select></label><label>新分支名称<input aria-label="新分支名称" value={branch} placeholder="codex/task-name" maxLength={200} disabled={locked} onChange={event => { setBranch(event.target.value); setReview(null); }} /></label><p>起点 <code>{shortSha(overview.git.headSha)}</code></p><div className="git-inline"><button type="button" disabled={locked || !canCreate} onClick={() => setReview('branch')}>创建分支</button><button type="button" disabled={locked || !canCreate} onClick={() => setReview('worktree')}>创建 Worktree</button></div>{!tasks.length && <p>在这个工作区创建一个 Task 后可关联 Git 分支。</p>}{review && <div className="git-review"><strong>{review === 'worktree' ? '创建任务隔离目录' : '创建本地分支'}</strong><p>{currentTask?.goal}</p><code>{branch.trim()}</code><code>HEAD {overview.git.headSha}</code><div className="git-inline"><button type="button" disabled={locked} onClick={() => setReview(null)}>取消</button><button type="button" className="git-primary" disabled={locked || !canCreate} onClick={() => void mutate(`ui.workspace.git.${review}.create`, { id: workspaceId, taskId, branch: branch.trim(), expectedHead: overview.git.headSha }, review === 'worktree' ? 'Agent Worktree 已创建并登记，可在 Worktree 列表中打开。' : '本地分支已创建并关联当前 Task。')}>确认创建</button></div></div>}</section><section className="git-panel"><h2>关联任务</h2>{tasks.length ? tasks.map(task => <div className="git-task-item" key={task.id}>{onOpenTask ? <button type="button" className="git-link" onClick={() => onOpenTask(task.id)}>{task.goal}</button> : <strong>{task.goal}</strong>}<small>{task.status} · {task.id}</small></div>) : <p>当前工作区尚无关联任务。</p>}</section></aside></div>
    </>}
  </div>;
}
