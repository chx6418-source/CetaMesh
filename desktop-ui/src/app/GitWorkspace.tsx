import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, SearchInput, Select, Tabs, Textarea } from '../components/primitives/inputs';
import { Badge, Surface } from '../components/primitives/surfaces';
import { Sheet as Drawer } from '../components/primitives/overlays';
import { DiffViewer, parseUnifiedDiff } from '../components/product/DiffViewer';
import './GitWorkspace.css';

type GitEntry = { x: string; y: string; path: string; origPath?: string | null; conflict: boolean; commitEligible: boolean; sha256?: string | null; blockedReason?: string };
type GitTask = { id: string; goal: string; status: string; workspaceId: string; readOnly: boolean; executor?: { provider: string | null; sessionId: string | null } | null };
type GitBranch = { name: string; headSha: string; current: boolean; upstream: string | null; taskId: string | null; baselineHead: string | null };
type GitWorktree = { workspaceId: string | null; name: string; branch: string | null; headSha: string | null; current: boolean; managed: boolean; locked: boolean; prunable: boolean; taskId: string | null; parentWorkspaceId: string | null; baselineHead: string | null };
export type GitOverview = {
  workspaceId: string;
  git: { isRepo: boolean; branch: string; headSha: string | null; dirty: boolean; entries: GitEntry[] };
  conflicts: GitEntry[];
  branches: GitBranch[];
  history: { sha: string; parents: string[]; committedAt: number; subject: string }[];
  worktrees: GitWorktree[];
  tasks: GitTask[];
  worktreeRelation?: { taskId: string; parentWorkspaceId: string; branch: string; baselineHead: string } | null;
  truncated: boolean;
};
export type GitDiff = { output: string; cached: boolean; truncated: boolean; hasChanges: boolean };
type Review = { kind: 'branch' | 'worktree'; workspaceId: string; headSha: string; taskId: string; branch: string };
type Detail = { kind: 'branch'; item: GitBranch } | { kind: 'worktree'; item: GitWorktree };
export type GitWorkspaceProps = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  workspaces: { id: string; name: string }[];
  activeWorkspaceId?: string | null;
  onWorkspaceChanged?(): void | Promise<void>;
  onOpenTask?(id: string): void;
  onExplain?(path: string, output: string, workspaceId: string): void | Promise<void>;
};
const PAGE_SIZE = 50;
const tabs = [{ id: 'changes', label: 'Changes · 变更' }, { id: 'history', label: 'History · 提交记录' }, { id: 'branches', label: 'Branches · 分支' }, { id: 'worktrees', label: 'Worktrees · 工作树' }];
const shortSha = (sha: string | null | undefined) => sha ? sha.slice(0, 10) : '尚无提交';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const terminal = (task: GitTask) => ['completed', 'failed', 'cancelled'].includes(task.status);
const staged = (entry: GitEntry) => entry.x !== ' ' && entry.x !== '?';
const working = (entry: GitEntry) => entry.y !== ' ' || entry.x === '?';
const matches = (query: string, values: (string | null | undefined)[]) => values.some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

/** Read-only projections and exact scoped requests use the existing Owner UI DTOs. */
export function GitWorkspace({ call, workspaces, activeWorkspaceId, onWorkspaceChanged, onOpenTask, onExplain }: GitWorkspaceProps) {
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? '');
  const [overviewResult, setOverview] = useState<GitOverview | null>(null);
  const [diffResult, setDiff] = useState<(GitDiff & { workspaceId: string; path: string }) | null>(null);
  const [tab, setTab] = useState('changes');
  const [cached, setCached] = useState(false);
  const [previewPath, setPreviewPath] = useState('');
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
  const [review, setReview] = useState<Review | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [branchQuery, setBranchQuery] = useState('');
  const [worktreeQuery, setWorktreeQuery] = useState('');
  const [lineStatistics, setLineStatistics] = useState<Record<string, { additions: number; deletions: number; truncated: boolean; cached: boolean }>>({});
  const previewWorkspace = useRef<string | null>(null);
  const callRef = useRef(call); callRef.current = call;
  const workspaceRef = useRef(workspaceId); workspaceRef.current = workspaceId;
  const generation = useRef(0);
  const operation = useRef(0);
  const overview = overviewResult?.workspaceId === workspaceId ? overviewResult : null;
  const diff = diffResult?.workspaceId === workspaceId && diffResult.path === previewPath && diffResult.cached === cached ? diffResult : null;

  useEffect(() => { if (activeWorkspaceId) setWorkspaceId(activeWorkspaceId); }, [activeWorkspaceId]);
  useEffect(() => { if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id); }, [workspaceId, workspaces]);
  useEffect(() => {
    // Drafts and selections belong to this Workspace, never to the next selected project.
    operation.current++;
    setBusy(false); setSelected([]); setMessage(''); setBranch(''); setTaskId('');
    setPreviewPath(''); setDiff(null); setDiffError(''); setReview(null); setDetail(null); setNotice('');
    previewWorkspace.current = null; setLineStatistics({});
    setQuery(''); setStatusFilter('all'); setPage(0); setBranchQuery(''); setWorktreeQuery('');
    return () => { operation.current++; };
  }, [workspaceId]);
  useEffect(() => {
    const epoch = ++generation.current;
    setOverview(null); setReview(null); setDetail(null); setError('');
    setLineStatistics({});
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    void callRef.current('ui.workspace.git.overview', { id: workspaceId }).then(value => {
      if (generation.current !== epoch || workspaceRef.current !== workspaceId) return;
      const current = value as GitOverview;
      setOverview(current);
      setSelected(previous => previous.filter(path => current.git.entries.some(entry => entry.path === path && entry.commitEligible)));
      setTaskId(previous => current.tasks.some(task => task.id === previous && !terminal(task) && !task.readOnly) ? previous : current.tasks.find(task => !terminal(task) && !task.readOnly)?.id ?? '');
      setPreviewPath(previous => current.git.entries.some(entry => entry.path === previous) ? previous : '');
    }).catch(cause => { if (generation.current === epoch && workspaceRef.current === workspaceId) setError(errorMessage(cause)); })
      .finally(() => { if (generation.current === epoch && workspaceRef.current === workspaceId) setLoading(false); });
    return () => { generation.current++; };
  }, [workspaceId, revision]);
  useEffect(() => {
    let current = true; setDiff(null); setDiffError('');
    if (!workspaceId || previewWorkspace.current !== workspaceId || tab !== 'changes' || !previewPath) return;
    void callRef.current('ui.workspace.git.diff', { id: workspaceId, cached, path: previewPath }).then(value => {
      if (current && workspaceRef.current === workspaceId) {
        const result=value as GitDiff, parsed=parseUnifiedDiff(result.output);
        setDiff({ ...result, workspaceId, path: previewPath, cached });
        setLineStatistics(previous=>({...previous,[previewPath]:{additions:parsed.additions,deletions:parsed.deletions,truncated:result.truncated||parsed.clipped,cached}}));
      }
    }).catch(cause => { if (current && workspaceRef.current === workspaceId) setDiffError(errorMessage(cause)); });
    return () => { current = false; };
  }, [workspaceId, revision, cached, tab, previewPath]);

  const entries = overview?.git.entries ?? [];
  const filteredEntries = useMemo(() => entries.filter(entry => matches(query, [entry.path, entry.origPath]) && (
    statusFilter === 'all' || statusFilter === 'staged' && staged(entry) || statusFilter === 'working' && working(entry) ||
    statusFilter === 'untracked' && entry.x === '?' || statusFilter === 'conflict' && entry.conflict || statusFilter === 'blocked' && !entry.commitEligible
  )), [entries, query, statusFilter]);
  const lastPage = Math.max(0, Math.ceil(filteredEntries.length / PAGE_SIZE) - 1);
  const visiblePage = Math.min(page, lastPage);
  const visibleEntries = filteredEntries.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const pageEligible = visibleEntries.filter(entry => entry.commitEligible);
  const allPageSelected = pageEligible.length > 0 && pageEligible.every(entry => selectedSet.has(entry.path));
  const hiddenSelection = selected.filter(path => !visibleEntries.some(entry => entry.path === path)).length;
  const tasks = overview?.tasks ?? [];
  const currentTask = tasks.find(task => task.id === taskId);
  const locked = loading || busy;
  const canCreate = !!overview?.git.headSha && !!currentTask && !terminal(currentTask) && !currentTask.readOnly && !!branch.trim() && !overview.conflicts.length;
  const branches = overview?.branches.filter(item => matches(branchQuery, [item.name, item.taskId, item.upstream])) ?? [];
  const worktrees = overview?.worktrees.filter(item => matches(worktreeQuery, [item.name, item.branch, item.taskId, item.workspaceId])) ?? [];
  const detailTask = detail?.item.taskId ? tasks.find(task => task.id === detail.item.taskId) : undefined;
  const projectName = workspaces.find(workspace => workspace.id === workspaceId)?.name ?? '工作区';

  async function mutate(method: string, params: Record<string, unknown>, success: string) {
    const epoch = generation.current, targetWorkspace = workspaceId, request = ++operation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await callRef.current(method, params) as { status?: string; committed?: boolean; created?: boolean; result?: { committed?: boolean; created?: boolean; status?: string } };
      if (generation.current !== epoch || workspaceRef.current !== targetWorkspace || operation.current !== request) return;
      const result = response.result ?? response;
      const statuses = [response.status, result.status];
      if (statuses.some(status => ['failed', 'rejected', 'denied', 'cancelled', 'expired'].includes(status ?? ''))) throw new Error('操作未完成，请查看审批或错误详情。草稿已保留。');
      if (statuses.some(status => ['pending', 'pending_approval'].includes(status ?? ''))) {
        setNotice('请求正在等待审批，请打开任务页，在审批面板确认当前操作。批准完成前不会视为已创建或已提交。');
      } else if (result.committed === false) {
        setNotice('所选文件没有可提交的变化。提交草稿已保留。');
      } else if (result.committed === true || result.created === true) {
        setNotice(success);
      } else {
        setNotice('请求已受理，执行结果尚未确认。请检查审批状态并刷新；草稿已保留。');
      }
      setReview(null); setRevision(value => value + 1); await onWorkspaceChanged?.();
    } catch (cause) {
      if (workspaceRef.current === targetWorkspace && operation.current === request) setError(errorMessage(cause));
    } finally { if (operation.current === request && workspaceRef.current === targetWorkspace) setBusy(false); }
  }
  async function commit() {
    if (!overview || !selected.length || !message.trim() || locked || overview.conflicts.length) return;
    const selectedEntries = entries.filter(entry => selectedSet.has(entry.path) && entry.commitEligible);
    if (!selectedEntries.length) return;
    await mutate('ui.workspace.git.commit', { id: workspaceId, ...(taskId ? { taskId } : {}), message: message.trim(), paths: selectedEntries.map(entry => entry.path), expectedHead: overview.git.headSha, expectedHashes: Object.fromEntries(selectedEntries.map(entry => [entry.path, entry.sha256])) }, '所选文件已提交，未选中的改动已保留。');
  }
  function prepareCreation(kind: Review['kind']) {
    if (!canCreate || !overview?.git.headSha) return;
    setReview({ kind, workspaceId, taskId, branch: branch.trim(), headSha: overview.git.headSha });
  }
  async function openWorktree(id: string) {
    const targetWorkspace = workspaceId, request = ++operation.current;
    setBusy(true); setError('');
    try {
      await callRef.current('ui.workspace.open', { id });
      if (operation.current !== request || workspaceRef.current !== targetWorkspace) return;
      setWorkspaceId(id); setTaskId(''); await onWorkspaceChanged?.();
    } catch (cause) { if (operation.current === request && workspaceRef.current === targetWorkspace) setError(errorMessage(cause)); }
    finally { if (operation.current === request) setBusy(false); }
  }
  function togglePage() {
    const paths = new Set(pageEligible.map(entry => entry.path));
    setSelected(previous => allPageSelected ? previous.filter(path => !paths.has(path)) : [...new Set([...previous, ...paths])]);
  }
  function preview(entry: GitEntry) { previewWorkspace.current=workspaceId; setPreviewPath(entry.path); setCached(staged(entry) && !working(entry)); }

  return <div className="git-workspace">
    <header className="git-heading"><div><h1>Git 工作台</h1><p>在当前项目中审查变更、提交与任务隔离目录。</p></div><div className="git-toolbar">
      <Select label="Git 工作区" value={workspaceId} disabled={busy} onChange={event => setWorkspaceId(event.target.value)}><option value="" disabled>选择工作区</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</Select>
      <Button type="button" disabled={locked || !workspaceId} onClick={() => setRevision(value => value + 1)}>刷新</Button></div></header>
    {error && <div className="git-notice error" role="alert">{error}</div>}{notice && <div className="git-notice" role="status">{notice}</div>}
    {!workspaceId ? <div className="git-empty">先登记一个本地项目工作区。</div> : loading ? <div className="git-empty" role="status">正在读取 Git 状态…</div> : overview && !overview.git.isRepo ? <div className="git-empty">这个工作区尚未初始化 Git 仓库。</div> : overview && <>
      <Surface className="git-repository" aria-label="当前仓库状态"><div className="git-repository-name"><small>Repository · 仓库</small><strong title={projectName}>{projectName}</strong></div><div><small>Branch · 当前分支</small><strong>{overview.git.branch || 'Detached HEAD'}</strong></div><div><small>HEAD</small><code title={overview.git.headSha ?? undefined}>{shortSha(overview.git.headSha)}</code></div><div className="git-repository-status"><Badge tone={overview.conflicts.length ? 'danger' : overview.git.dirty ? 'warning' : 'success'}>{overview.conflicts.length ? overview.conflicts.length + ' 个冲突' : overview.git.dirty ? (overview.truncated ? '显示 ' : '') + entries.length + ' 个变更' : '工作目录干净'}</Badge><small>{entries.filter(staged).length} 已暂存 · {entries.filter(working).length} 工作目录</small></div></Surface>
      {!!overview.conflicts.length && <p className="git-notice error">存在未解决冲突，需要在项目中处理后刷新；提交与创建暂不可用。</p>}
      {overview.truncated && <p className="git-notice">项目数据超过读取上限；这里只显示服务返回的有界状态、分支或工作区列表。</p>}
      {overview.worktreeRelation && <p className="git-notice">登记分支 {overview.worktreeRelation.branch} · Task {overview.worktreeRelation.taskId} · 基线 {shortSha(overview.worktreeRelation.baselineHead)}。实际分支以上方 Git 状态为准。</p>}
      <div className="git-tabs"><Tabs items={tabs} selected={tab} onChange={setTab} label="Git 视图" /></div>
      <div className="git-workbench-grid"><section className="git-panel git-main" aria-label="Git 项目数据">
        {tab === 'changes' && <div className="git-changes">
          <section className="git-files" aria-label="文件变更"><div className="git-section-heading"><h2>文件变更</h2><Badge>{entries.length} 个文件</Badge></div>
            <SearchInput label="搜索变更文件" placeholder="按路径搜索文件…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
            <div className="git-list-tools"><Select label="变更状态筛选" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(0); }}><option value="all">全部状态</option><option value="staged">已暂存</option><option value="working">工作目录</option><option value="untracked">未跟踪</option><option value="conflict">冲突</option><option value="blocked">需单独审查</option></Select><Button type="button" compact disabled={locked || !pageEligible.length || !!overview.conflicts.length} onClick={togglePage}>{allPageSelected ? '取消本页选择' : '选择本页'}</Button></div>
            <div className="git-file-list" role="list" aria-label="变更文件列表">{!filteredEntries.length && <div className="git-empty">{entries.length ? '没有符合搜索与筛选的文件。' : '所有改动都已提交。'}</div>}{visibleEntries.map(entry => <div className={'git-file ' + (entry.conflict ? 'conflicted ' : '') + (previewPath === entry.path ? 'is-previewed' : '')} role="listitem" key={entry.path}>
              <Input type="checkbox" aria-label={'提交 ' + entry.path} checked={selectedSet.has(entry.path)} disabled={locked || !entry.commitEligible || !!overview.conflicts.length} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, entry.path])] : previous.filter(item => item !== entry.path))} />
              <div className="git-file-body"><Button type="button" variant="ghost" compact className="git-file-path" aria-label={'查看差异 ' + entry.path} aria-pressed={previewPath === entry.path} onClick={() => preview(entry)}><code>{entry.path}</code></Button>
                <div className="git-file-status"><span title={'Git index status ' + entry.x}>已暂存 {staged(entry) ? entry.x : '—'}</span><span title={'Git working tree status ' + entry.y}>工作目录 {entry.x === '?' ? '未跟踪' : working(entry) ? entry.y : '—'}</span></div>
                <small className="git-line-statistics">{lineStatistics[entry.path] ? `${lineStatistics[entry.path].cached?'暂存区':'工作目录'} +${lineStatistics[entry.path].additions} −${lineStatistics[entry.path].deletions}${lineStatistics[entry.path].truncated?' · 部分统计':''}` : '增删行待查看差异后统计'}</small>
                {entry.origPath && <small>来自 {entry.origPath}</small>}{entry.conflict ? <small>文件包含未解决的 Git 冲突</small> : !entry.commitEligible ? <small>需要单独审查 · {entry.blockedReason ?? '原因未知'}</small> : null}
              </div></div>)}</div>
            <nav className="git-pagination" aria-label="变更文件分页"><Button type="button" compact disabled={!visiblePage} onClick={() => setPage(visiblePage - 1)}>上一页</Button><small aria-live="polite">{filteredEntries.length ? visiblePage * PAGE_SIZE + 1 : 0}–{Math.min((visiblePage + 1) * PAGE_SIZE, filteredEntries.length)} / {filteredEntries.length} · 每页 {PAGE_SIZE}</small><Button type="button" compact disabled={visiblePage >= lastPage} onClick={() => setPage(visiblePage + 1)}>下一页</Button></nav>
          </section>
          <section className="git-preview" aria-label="文件差异预览"><div className="git-section-heading"><h2>Diff · 文件差异</h2>{previewPath && <Button type="button" variant="ghost" compact onClick={() => setPreviewPath('')}>关闭预览</Button>}</div>
            {!previewPath ? <div className="git-empty">选择文件名，查看该文件的差异。<p>文件复选框仅选择提交范围。</p></div> : <><Select label="Diff 来源" value={cached ? 'cached' : 'working'} onChange={event => setCached(event.target.value === 'cached')}><option value="working">工作目录</option><option value="cached">暂存区</option></Select>
              <DiffViewer path={previewPath} output={diff?.output??''} loading={!diff&&!diffError} error={diffError} truncated={diff?.truncated} onRetry={()=>setRevision(value=>value+1)} onExplain={onExplain?(path,output)=>onExplain(path,output,workspaceId):undefined} />
              <div className="git-stage-unavailable"><Button compact disabled title="现有受控 Git 执行器尚未提供文件级暂存；不会绕过 Broker 直接运行 Git。">{cached?'取消文件暂存':'暂存此文件'}</Button><small>文件级暂存执行器未接入。仍可在提交区按审批提交所选完整文件。</small></div>
            </>}
          </section></div>}
        {tab === 'history' && <><div className="git-section-heading"><h2>提交记录</h2><small>最近 {overview.history.length} 次提交</small></div>{!overview.history.length && <div className="git-empty">仓库还没有提交记录。</div>}{overview.history.map(item => <div className="git-data-row" key={item.sha}><div><strong>{item.subject}</strong><small>{new Date(item.committedAt).toLocaleString()} · {item.parents.length > 1 ? '合并提交' : '提交'}</small></div><code title={item.sha}>{shortSha(item.sha)}</code></div>)}</>}
        {tab === 'branches' && <><div className="git-section-heading"><h2>本地分支</h2><Badge>{overview.branches.length}</Badge></div><SearchInput label="搜索分支" placeholder="搜索分支、上游或 Task…" value={branchQuery} onChange={event => setBranchQuery(event.target.value)} />{!branches.length && <div className="git-empty">{overview.branches.length ? '没有匹配的分支。' : '首次提交后会显示本地分支。'}</div>}{branches.map(item => <div className="git-data-row" key={item.name}><div><Button type="button" variant="ghost" className="git-detail-link" aria-label={'分支详情 ' + item.name} onClick={() => setDetail({ kind: 'branch', item })}>{item.name}</Button><small>{item.upstream ? '跟踪 ' + item.upstream : '本地分支'} · {item.taskId ? 'Task ' + item.taskId : 'Task 未关联'}</small></div><div>{item.current && <Badge tone="accent">当前分支</Badge>}<small><code>{shortSha(item.headSha)}</code></small></div></div>)}</>}
        {tab === 'worktrees' && <><div className="git-section-heading"><h2>Worktrees · 工作树</h2><Badge>{overview.worktrees.length}</Badge></div><SearchInput label="搜索工作树" placeholder="搜索工作树、实际分支或 Task…" value={worktreeQuery} onChange={event => setWorktreeQuery(event.target.value)} /><div className="git-worktree-list">{!worktrees.length && <div className="git-empty">没有匹配的工作树。</div>}{worktrees.map((item, index) => <div className="git-data-row" key={item.workspaceId ?? String(item.branch) + '-' + index}><div><Button type="button" variant="ghost" className="git-detail-link" aria-label={'工作树详情 ' + item.name} onClick={() => setDetail({ kind: 'worktree', item })}>{item.name}</Button><strong className="git-actual-branch">{item.branch || 'Detached HEAD'} {item.current && <Badge tone="accent">当前</Badge>}</strong><small>{item.managed ? 'Agent 隔离目录' : item.workspaceId ? '已登记工作区' : '外部工作区'} · {item.taskId ? 'Task ' + item.taskId : 'Task 未关联'}</small><small>{shortSha(item.headSha)}{item.locked ? ' · 已锁定' : ''}{item.prunable ? ' · 需要检查登记状态' : ''}</small></div>{item.workspaceId && !item.current && <Button type="button" compact disabled={locked} onClick={() => void openWorktree(item.workspaceId!)}>打开</Button>}</div>)}</div></>}
      </section><aside className="git-context" aria-label="Git 操作">
        {tab === 'changes' && <Surface className="git-commit" aria-label="提交所选文件"><div className="git-section-heading"><h2>提交所选文件</h2><Badge tone="accent">{selected.length}</Badge></div><p>复选框选择本次提交范围，不会执行 Git 暂存。</p><small>{hiddenSelection ? '另有 ' + hiddenSelection + ' 个选择位于其他页或已被筛选隐藏。' : '选择会在翻页与筛选后保留。'}</small><label htmlFor="git-commit-message">提交信息</label><Textarea id="git-commit-message" value={message} onChange={event => setMessage(event.target.value)} placeholder="说明这次改动解决了什么" rows={3} maxLength={2000} disabled={locked} /><small>审批绑定 HEAD {shortSha(overview.git.headSha)} 与已选文件的当前内容；提交整个文件。</small><Button type="button" variant="primary" disabled={locked || !selected.length || !message.trim() || !!overview.conflicts.length} onClick={() => void commit()}>提交所选文件（{selected.length}）</Button>{!!selected.length && <Button type="button" variant="ghost" compact disabled={locked} onClick={() => setSelected([])}>清除全部选择</Button>}</Surface>}
        <Surface className="git-create"><h2>为任务创建分支</h2><p>以当前 HEAD 创建分支或隔离目录，源工作区的未提交改动保留在原处。</p><label>关联 Task</label><Select label="关联 Task" disabled={locked} value={taskId} onChange={event => { setTaskId(event.target.value); setReview(null); }}><option value="">选择当前工作区的任务</option>{tasks.map(task => <option key={task.id} value={task.id} disabled={terminal(task) || task.readOnly}>{task.goal + (task.readOnly ? ' · 只读' : terminal(task) ? ' · 已结束' : '')}</option>)}</Select><label htmlFor="git-new-branch">新分支名称</label><Input id="git-new-branch" aria-label="新分支名称" value={branch} placeholder="codex/task-name" maxLength={200} disabled={locked} onChange={event => { setBranch(event.target.value); setReview(null); }} /><small>起点 {shortSha(overview.git.headSha)}</small><div className="git-inline"><Button type="button" compact disabled={locked || !canCreate} onClick={() => prepareCreation('branch')}>创建分支</Button><Button type="button" compact disabled={locked || !canCreate} onClick={() => prepareCreation('worktree')}>创建 Worktree</Button></div>{!tasks.length && <p>在这个工作区创建 Task 后可关联 Git 分支。</p>}
          {review && <div className="git-review"><strong>{review.kind === 'worktree' ? '创建任务隔离目录' : '创建本地分支'}</strong><p>{tasks.find(task => task.id === review.taskId)?.goal ?? review.taskId}</p><code>{review.branch}</code><code>HEAD {review.headSha}</code><small>确认后仍需按工作区策略审批。</small><div className="git-inline"><Button type="button" compact disabled={locked} onClick={() => setReview(null)}>取消</Button><Button type="button" compact variant="primary" disabled={locked || !canCreate} onClick={() => void mutate('ui.workspace.git.' + review.kind + '.create', { id: review.workspaceId, taskId: review.taskId, branch: review.branch, expectedHead: review.headSha }, review.kind === 'worktree' ? 'Agent Worktree 已创建并登记，可在 Worktree 列表中打开。' : '本地分支已创建并关联当前 Task。')}>确认创建</Button></div></div>}
        </Surface>
        {!!tasks.length && <details className="git-related-tasks"><summary>关联任务 · {tasks.length}</summary>{tasks.map(task => <div className="git-task-item" key={task.id}>{onOpenTask ? <Button type="button" compact variant="ghost" onClick={() => onOpenTask(task.id)}>{task.goal}</Button> : <strong>{task.goal}</strong>}<small>{task.status} · {task.id}</small></div>)}</details>}
      </aside></div>
    </>}
    <Drawer open={!!detail} title={detail?.kind === 'branch' ? '分支详情' : '工作树详情'} onClose={() => setDetail(null)}>{detail && <div className="git-detail"><h3>{detail.item.name}</h3><dl><dt>实际分支</dt><dd>{detail.kind === 'branch' ? detail.item.name : detail.item.branch || 'Detached HEAD'}</dd><dt>HEAD</dt><dd><code>{detail.item.headSha ?? '尚无提交'}</code></dd><dt>关联 Task</dt><dd>{detail.item.taskId ? <>{detailTask?.goal ?? '任务详情不可用'}<small>{detail.item.taskId}</small>{onOpenTask && <Button type="button" compact onClick={() => { onOpenTask(detail.item.taskId!); setDetail(null); }}>查看任务</Button>}</> : '未关联'}</dd><dt>Agent</dt><dd>{detailTask?.executor?.provider || '未知 · 未提供执行者信息'}{detailTask?.executor?.sessionId && <small>Session {detailTask.executor.sessionId}</small>}</dd><dt>基线 HEAD</dt><dd><code>{detail.item.baselineHead ?? '未知'}</code></dd>{detail.kind === 'branch' ? <><dt>上游</dt><dd>{detail.item.upstream ?? '未设置'}</dd></> : <><dt>目录类型</dt><dd>{detail.item.managed ? 'Agent 隔离目录' : detail.item.workspaceId ? '已登记工作区' : '外部工作区'}</dd><dt>父工作区</dt><dd>{detail.item.parentWorkspaceId ?? '未知'}</dd><dt>目录状态</dt><dd>{detail.item.locked ? '已锁定' : '未锁定'}{detail.item.prunable ? ' · 需要检查登记状态' : ''}</dd></>}</dl></div>}</Drawer>
  </div>;
}
