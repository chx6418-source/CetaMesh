import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { productToolsClient, agentClient, approvalClient, bridge, hostClient, settingsClient, taskClient, workspaceClient, workshopClient, type Approval, type ApprovalDecisionResult, type L2Grant, type Task, type WorkshopProposal, type WorkspaceSummary } from '../bridge/typed-client';
import { ArtifactCard } from '../components/product/cards';
import { Button, Input, SearchInput, Select, Tabs, Textarea } from '../components/primitives/inputs';
import { Sheet } from '../components/primitives/overlays';
import { Badge, Card, LoadingState, Surface } from '../components/primitives/surfaces';
import { ApprovalCard } from './ApprovalCard';
import { ApprovalOperationSummary } from './StatusPresentation';
import { ErrorNotice, Heading, EmptyNotice, StatusBadge, messageOf, dateLabel, relativeLabel, dshSetupReasonLabel, availabilityReasonLabel } from './PagePresentation';
import { SmallPager, taskDisplayStatus, taskProgressValue, taskProgressLabel, TaskProgress, taskDialogTitle, WorkTaskList, TaskCollaborationStatus, TaskDetailSection } from './TaskPresentation';
import { activeTaskChildren, TaskDependencyNotice, taskOperationErrorMessage, validateTaskExecution } from './TaskExecutionFeedback';
import { projectWorkspaceChoices } from './WorkspaceSidebar';
import { GitWorkspace } from './GitWorkspace';
import { WorkspaceChangesReview } from './WorkspaceChangesReview';
import { confirmAgentExecution } from './AgentExecutionScope';
import { UsageSummary } from './UsageSummary';
export function WorkPage({ onExplain, workspaces, activeWorkspaceId, onRefreshWorkspaces, reviewTaskId, onReviewTaskOpened }: { activeWorkspaceId: string | null; workspaces: WorkspaceSummary[]; onRefreshWorkspaces(): Promise<void>; reviewTaskId: string | null; onReviewTaskOpened(): void; onExplain?(path:string,output:string,workspaceId:string):Promise<void> }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [taskWorkspaceId, setTaskWorkspaceId] = useState(activeWorkspaceId ?? '');
  const [taskOffset, setTaskOffset] = useState(0);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [workView, setWorkView] = useState('tasks');
  const [gitWorkspaceId, setGitWorkspaceId] = useState(activeWorkspaceId);
  useEffect(() => { setGitWorkspaceId(activeWorkspaceId); }, [activeWorkspaceId]);
  useEffect(() => { setTaskWorkspaceId(activeWorkspaceId ?? ''); setTaskOffset(0); setTasks([]); }, [activeWorkspaceId]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [taskOperationError, setTaskOperationError] = useState<{ taskId: string; message: string } | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [createdTaskNotice, setCreatedTaskNotice] = useState<Task | null>(null);
  const [taskSheet, setTaskSheet] = useState(false);
  const [taskCreateEpoch,setTaskCreateEpoch]=useState(0);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [handoffProviders, setHandoffProviders] = useState<{ id: string; name: string; eligible: boolean; reason: string | null }[]>([]);
  const selectedTaskIdRef = useRef('');
  const taskNavigationRef = useRef(0);
  const taskRefreshRef = useRef(0);
  const taskQueryRef = useRef('');
  const taskSnapshotsRef = useRef(new Map<string, Task>());
  const rememberTask = useCallback((incoming: Task) => {
    const previous = taskSnapshotsRef.current.get(incoming.id);
    const newest = previous && (previous.rev ?? -1) > (incoming.rev ?? -1) ? previous : incoming;
    taskSnapshotsRef.current.delete(incoming.id);
    taskSnapshotsRef.current.set(incoming.id, newest);
    if (taskSnapshotsRef.current.size > 4096) taskSnapshotsRef.current.delete(taskSnapshotsRef.current.keys().next().value!);
    return newest;
  }, []);
  taskQueryRef.current = [query, filter, taskWorkspaceId, taskOffset].join('\u0000');
  selectedTaskIdRef.current = selectedTask?.id ?? '';
  const refresh = useCallback(async (quiet = false) => {
    const request = ++taskRefreshRef.current;
    const queryKey = [query, filter, taskWorkspaceId, taskOffset].join('\u0000');
    const isCurrent = () => request === taskRefreshRef.current && queryKey === taskQueryRef.current;
    if (!quiet) setLoading(true);
    try {
      const result = await taskClient.overview(query, filter, { workspaceId: taskWorkspaceId || undefined, offset: taskOffset, limit: 50 });
      if (!isCurrent()) return;
      if (taskOffset > 0 && taskOffset >= result.total) { setTaskOffset(Math.max(0, Math.ceil(result.total / 50) - 1) * 50); setTasks([]); return; }
      const snapshots = result.tasks.map(rememberTask);
      setTasks(snapshots);
      setTaskTotal(result.total); setTaskCounts(result.counts);
      const selectedId = selectedTaskIdRef.current;
      const navigation = taskNavigationRef.current;
      if (selectedId) {
        const listed = snapshots.find(task => task.id === selectedId);
        if (listed) setSelectedTask(current => current?.id === selectedId && (current.rev ?? -1) <= (listed.rev ?? -1) ? listed : current);
        // A transient detail error must not close a valid selection. Navigation,
        // including close and same-ID reopen, invalidates the in-flight response.
        const detail = await taskClient.get(selectedId).catch(() => null);
        if (!isCurrent() || navigation !== taskNavigationRef.current || selectedId !== selectedTaskIdRef.current) return;
        if (detail) {
          const newest = rememberTask(detail.task);
          setSelectedTask(current => current?.id === selectedId ? rememberTask(current.rev !== null && current.rev > (newest.rev ?? -1) ? current : newest) : current);
        }
      }
      if (isCurrent()) setError('');
    }
    catch (cause) { if (isCurrent()) setError(messageOf(cause)); }
    finally { if (isCurrent()) setLoading(false); }
  }, [query, filter, taskWorkspaceId, taskOffset, rememberTask]);
  useEffect(() => { void refresh(); return () => { taskRefreshRef.current += 1; }; }, [refresh]);
  useEffect(() => {
    if (!reviewTaskId) return;
    const request = ++taskNavigationRef.current;
    void taskClient.get(reviewTaskId).then(value => { if (request !== taskNavigationRef.current) return; setSelectedTask(rememberTask(value.task)); onReviewTaskOpened(); }).catch(cause => { if (request === taskNavigationRef.current) setError(messageOf(cause)); });
    return () => { taskNavigationRef.current += 1; };
  }, [reviewTaskId, onReviewTaskOpened, rememberTask]);
  useEffect(() => { void agentClient.list().then(value => setHandoffProviders(value.agents.map(agent => ({ id: agent.id, name: agent.name, eligible: agent.taskEligible === true, reason: agent.reason ?? agent.lastError })))).catch(() => setHandoffProviders([])); }, []);
  useEffect(() => {
    const off = bridge.subscribe('task.updated', () => { void refresh(true); });
    const timer = window.setInterval(() => { void refresh(true); }, 3000);
    return () => { window.clearInterval(timer); off(); };
  }, [refresh]);
  function openProjectTasks(workspaceId: string) {
    setWorkView('tasks');
    if (taskWorkspaceId === workspaceId && taskOffset === 0) {
      // Keep this project's loaded rows visible while refreshing the same query.
      void refresh(true);
      return;
    }
    setTaskWorkspaceId(workspaceId); setTaskOffset(0); setTasks([]); setLoading(true);
  }
  function beginCreateTask(){const epoch=++taskNavigationRef.current;setCreatedTaskNotice(null);setTaskCreateEpoch(epoch);setTaskSheet(true);}
  async function showCreatedTask(task:Task,creationEpoch:number){
    const creationQueryKey=[query,filter,taskWorkspaceId,taskOffset].join('\u0000');
    if(creationQueryKey!==taskQueryRef.current){
      if(creationEpoch===taskNavigationRef.current){setTaskSheet(false);setCreatedTaskNotice(rememberTask(task));}
      return;
    }
    if(creationEpoch!==taskNavigationRef.current){await refresh(true);return;}
    const newest = rememberTask(task);
    taskNavigationRef.current+=1;selectedTaskIdRef.current=task.id;setTaskSheet(false);setSelectedTask(newest);
    // A successful creation is already authoritative. Show it while the new
    // overview is pending only when its membership in this page is known.
    // Search can match Core-only requirements, so do not guess search results.
    if (!query.trim() && !taskOffset && (!filter || filter === newest.status) && (!taskWorkspaceId || taskWorkspaceId === newest.workspaceId)) {
      setTasks(current => current.some(row => row.id === newest.id)
        ? current.map(row => row.id === newest.id ? rememberTask(row.rev !== null && row.rev > (newest.rev ?? -1) ? row : newest) : row)
        : [newest, ...current].slice(0, 50));
    }
    await refresh();
  }
  async function openTask(task: Task) {
    const request = ++taskNavigationRef.current;
    setTaskOperationError(null);
    rememberTask(task);
    try {
      const result = await taskClient.get(task.id);
      if (request === taskNavigationRef.current) setSelectedTask(rememberTask(result.task));
    } catch (cause) {
      if (request !== taskNavigationRef.current) return;
      setError(messageOf(cause)); setSelectedTask(rememberTask(task));
    }
  }
  async function openRelatedTask(id: string) {
    const request = ++taskNavigationRef.current;
    const sourceId = selectedTaskIdRef.current;
    try {
      const result = await taskClient.get(id);
      if (request !== taskNavigationRef.current) return;
      setTaskOperationError(null); setSelectedTask(rememberTask(result.task));
    } catch (cause) {
      if (request === taskNavigationRef.current) setTaskOperationError({ taskId: sourceId, message: taskOperationErrorMessage(cause) });
    }
  }
  async function taskAction(task: Task, action: 'start' | 'pause' | 'resume' | 'cancel', agentProvider?: string) {
    if (action === 'cancel' && !window.confirm(`取消任务“${task.title}”？`)) return;
    taskNavigationRef.current += 1;
    setSelectedTask(current => current?.id === task.id ? current : task);
    try {
      setTaskOperationError(null);
      if (action === 'start' || action === 'resume') {
        await validateTaskExecution(task, async id => {
          const value = await taskClient.get(id);
          rememberTask(value.task);
          setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (value.task.rev ?? -1) ? value.task : current);
          return value;
        });
      }
      if (action === 'start' || action === 'resume') await confirmAgentExecution(agentProvider || task.currentAgent?.provider || '', task.workspaceId || '');
      const result = action === 'start' ? await taskClient.start(task.id, task.rev ?? undefined, agentProvider)
        : action === 'pause' ? await taskClient.pause(task.id, task.rev ?? undefined)
        : action === 'resume' ? await taskClient.resume(task.id, task.rev ?? undefined)
          : await taskClient.cancel(task.id, task.rev ?? undefined);
      const newest = rememberTask(result.task);
      setTaskOperationError(null);
      setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (newest.rev ?? -1) ? newest : current);
      setTasks(current => current.map(previous => previous.id === newest.id && (previous.rev ?? -1) <= (newest.rev ?? -1) ? newest : previous));
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
  }
  async function handoffTask(task: Task, provider: string) {
    try {
      await confirmAgentExecution(provider, task.workspaceId || '');
      const result = await taskClient.handoff(task.id, provider, task.rev ?? undefined);
      const newest = rememberTask(result.task);
      setTaskOperationError(null);
      setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (newest.rev ?? -1) ? newest : current);
      setTasks(current => current.map(previous => previous.id === newest.id && (previous.rev ?? -1) <= (newest.rev ?? -1) ? newest : previous));
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
  }
  async function reconcileTask(task: Task, reviewSummary: string, nextInstruction: string, provider?: string) {
    try {
      await confirmAgentExecution(provider || task.currentAgent?.provider || '', task.workspaceId || '');
      const result = await taskClient.reconcile(task.id, task.rev ?? undefined,
        reviewSummary, nextInstruction, crypto.randomUUID(), provider);
      const newest = rememberTask(result.task);
      setTaskOperationError(null);
      setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (newest.rev ?? -1) ? newest : current);
      setTasks(current => current.map(previous => previous.id === newest.id && (previous.rev ?? -1) <= (newest.rev ?? -1) ? newest : previous));
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
  }
  async function reviewAnalysisChild(task: Task, approve: boolean, summary: string, evidenceEventIds: string[]) {
    try {
      if (task.rev === null) throw new Error('Task revision is unavailable');
      const result = await taskClient.reviewChild(task.id, task.rev, approve, summary, evidenceEventIds);
      const newest = rememberTask(result.task);
      setTaskOperationError(null);
      setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (newest.rev ?? -1) ? newest : current);
      setTasks(current => current.map(previous => previous.id === newest.id && (previous.rev ?? -1) <= (newest.rev ?? -1) ? newest : previous));
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
  }
  async function createReadChild(task: Task, goal: string, scope: string, outputKind: 'analysis' | 'tool', supersedesChildId?: string) {
    try {
      if (task.rev === null || !task.workspaceId) throw new Error('Parent Task revision or Workspace is unavailable');
      await taskClient.createChild({ parentTaskId: task.id, expectedParentRev: task.rev,
        requestId: crypto.randomUUID(), goal, workspaceId: task.workspaceId, supersedesChildId,
        contract: { mode: 'read-only', outputKind, readScope: [scope],
          expectedEvidence: outputKind === 'tool' ? ['filesystem.read'] : ['source'] } });
      setTaskOperationError(null);
      const current = rememberTask((await taskClient.get(task.id)).task);
      setSelectedTask(selected => selected?.id === task.id && (selected.rev ?? -1) <= (current.rev ?? -1) ? current : selected);
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
  }
  async function finishTask(task: Task, summary: string, reportOnly = false) {
    try {
      if (task.rev === null) throw new Error('Task revision is unavailable');
      const result = task.parentTaskId
        ? await taskClient.completeChild(task.id, task.rev, summary)
        : await taskClient.complete(task.id, task.rev, summary, reportOnly && task.reviewReport ? { reviewKind: 'report-only', reportEventId: task.reviewReport.eventId, reportSha256: task.reviewReport.sha256 } : undefined);
      const newest = rememberTask(result.task);
      setTaskOperationError(null);
      setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (newest.rev ?? -1) ? newest : current);
      setTasks(current => current.map(previous => previous.id === newest.id && (previous.rev ?? -1) <= (newest.rev ?? -1) ? newest : previous));
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
  }
  async function verifyCompletedChild(task: Task) {
    try {
      if (task.rev === null) throw new Error('Task revision is unavailable');
      const result = await taskClient.verifyChild(task.id, task.rev);
      const newest = rememberTask(result.task);
      setTaskOperationError(null);
      setSelectedTask(current => current?.id === task.id && (current.rev ?? -1) <= (newest.rev ?? -1) ? newest : current);
      setTasks(current => current.map(previous => previous.id === newest.id && (previous.rev ?? -1) <= (newest.rev ?? -1) ? newest : previous));
      await refresh();
    } catch (cause) { setTaskOperationError({ taskId: task.id, message: taskOperationErrorMessage(cause) }); }
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
  const projectWorkspaces = projectWorkspaceChoices(workspaces, [activeWorkspaceId, taskWorkspaceId]);
  const counts = { all: Object.keys(taskCounts).length ? Object.values(taskCounts).reduce((sum, value) => sum + value, 0) : taskTotal,
    working: taskCounts.running ?? tasks.filter(task => task.status === 'running').length,
    waiting: taskCounts.waiting ?? tasks.filter(task => task.status === 'waiting').length,
    completed: taskCounts.completed ?? tasks.filter(task => task.status === 'completed').length };
  return <div className={`content-page work-page work-view-${workView}`}>{workView !== 'git' && <Heading eyebrow="WORKSPACE" title={workView === 'workspaces' ? '工作区' : '工作'} description="查看跨会话任务的进展、负责人和下一步。" action={<Button icon="add" variant="primary" onClick={beginCreateTask}>新建任务</Button>} />}
    <Tabs label="工作与工作区" selected={workView} onChange={setWorkView} items={[{id:'tasks',label:'任务'},{id:'workspaces',label:'工作区'},{id:'git',label:'Git 工作台'}]} />
    {workView === 'tasks' && <>
    {error && <ErrorNotice error={error} onRetry={() => void refresh()} />}
    {createdTaskNotice && <Surface className="task-created-notice" role="status"><p>已创建任务“{taskDialogTitle(createdTaskNotice)}”，它不在当前筛选范围内。</p><Button compact variant="ghost" onClick={() => { const task=createdTaskNotice;setCreatedTaskNotice(null);void openTask(task); }}>查看任务</Button></Surface>}
    <div className="row between work-controls" aria-busy={loading}><Select label="任务项目范围" value={taskWorkspaceId} onChange={event => { setTaskWorkspaceId(event.target.value); setTaskOffset(0); setTasks([]); }}><option value="">全部任务</option>{projectWorkspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name + (workspace.managedIsolation ? ' · 任务隔离目录' : '') + (workspace.recovery?.status === 'blocked' ? ' · 待恢复' : '')}</option>)}</Select><Tabs items={[{ id: '', label: `全部 ${loading ? '…' : counts.all}` }, { id: 'running', label: `运行中 ${loading ? '…' : counts.working}` }, { id: 'waiting', label: `待处理 ${loading ? '…' : counts.waiting}` }, { id: 'completed', label: `已完成 ${loading ? '…' : counts.completed}` }]} selected={filter} onChange={value => { setFilter(value); setTaskOffset(0); setTasks([]); }} label="按任务状态筛选" /><SearchInput label="搜索任务" placeholder="搜索任务" value={query} onChange={event => { setQuery(event.target.value); setTaskOffset(0); setTasks([]); }} /></div>
    {loading && !tasks.length ? <LoadingState label="正在读取任务…" /> : tasks.length ? <WorkTaskList key={[query, filter, taskWorkspaceId, taskOffset].join('|')} tasks={tasks} workspaces={workspaces} providers={handoffProviders} historyInitiallyOpen={Boolean(query || filter || taskOffset)} onOpen={task => void openTask(task)} onAction={(task, action) => void taskAction(task, action)} /> : !error && <EmptyNotice icon="work" title={query || filter ? '没有匹配的任务' : '还没有任务'} detail="你可以在这里创建任务并查看 Core 与 Agent 的执行进度。" action={<Button variant="primary" icon="add" onClick={beginCreateTask}>新建任务</Button>} />}
    {taskTotal > 50 && <nav className="git-pagination" aria-label="全部匹配任务分页"><Button compact disabled={loading || !taskOffset} onClick={() => { setTaskOffset(Math.max(0, taskOffset - 50)); setTasks([]); }}>上一页任务</Button><small>{loading ? '正在读取任务…' : `${taskOffset + 1}–${Math.min(taskOffset + tasks.length, taskTotal)} / ${taskTotal}`}</small><Button compact disabled={loading || taskOffset + 50 >= taskTotal} onClick={() => { setTaskOffset(taskOffset + 50); setTasks([]); }}>下一页任务</Button></nav>}
    <WorkshopInbox providers={handoffProviders} />
    </>}
    {workView === 'workspaces' && <>
    <div className="section-heading page-section-heading"><h2>项目工作区</h2><div className="row"><Input aria-label="工作区名称" placeholder="工作区名称（可选）" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} /><Button compact icon="add" onClick={() => void addWorkspace()} disabled={workspaceBusy}>{workspaceBusy ? '添加中…' : '添加工作区'}</Button></div></div>
    {workspaceError && <ErrorNotice error={workspaceError} />}{projectWorkspaces.length ? <div className="workspace-grid">{projectWorkspaces.map(workspace => <Card className="workspace-card" key={workspace.id}><div className="workspace-badge">CM</div><div className="workspace-card-body"><strong>{workspace.name}</strong><p>{workspace.managedIsolation ? '任务隔离目录' : '本地项目'} · {workspace.activitySource === 'opened' ? '最近打开' : '登记于'} {relativeLabel(workspace.lastActivity)}</p></div><StatusBadge value={workspace.status} /><Button compact disabled={workspaceBusy} onClick={() => openProjectTasks(workspace.id)}>查看任务</Button><Button compact icon="code" disabled={workspaceBusy} onClick={() => { void (async () => { setWorkspaceError(''); setWorkspaceBusy(true); try { await workspaceClient.open(workspace.id); await onRefreshWorkspaces(); setGitWorkspaceId(workspace.id); setWorkView('git'); } catch (cause) { setWorkspaceError(messageOf(cause)); } finally { setWorkspaceBusy(false); } })(); }}>Git 工作台</Button></Card>)}</div> : <Surface className="workspace-empty"><p className="muted">尚未登记工作区。添加工作区时会使用 Windows 原生文件夹选择器。</p></Surface>}
    </>}
    {workView === 'git' && <GitWorkspace onExplain={onExplain} call={productToolsClient.call} workspaces={workspaces} activeWorkspaceId={gitWorkspaceId} onWorkspaceChanged={onRefreshWorkspaces} onOpenTask={id => { setWorkView('tasks'); void openRelatedTask(id); }} />}
    <Sheet open={taskSheet} title="新建任务" onClose={() => {taskNavigationRef.current+=1;setTaskSheet(false);}}><TaskCreateForm key={taskCreateEpoch} activeWorkspaceId={taskWorkspaceId || activeWorkspaceId} workspaces={projectWorkspaces} providers={handoffProviders} onCreated={task=>showCreatedTask(task,taskCreateEpoch)} /></Sheet>
    <Sheet open={Boolean(selectedTask)} title={selectedTask ? taskDialogTitle(selectedTask) : '任务详情'} onClose={() => { taskNavigationRef.current += 1; selectedTaskIdRef.current = ''; setSelectedTask(null); }}>{selectedTask && taskOperationError?.taskId === selectedTask.id && <ErrorNotice error={taskOperationError.message} />}{selectedTask && <TaskCollaborationStatus task={selectedTask} />}{selectedTask && <TaskApprovals key={"approvals:"+selectedTask.id} taskId={selectedTask.id} />}{selectedTask && <TaskDetails key={selectedTask.id} task={selectedTask} providers={handoffProviders} onOpenChild={id => void openRelatedTask(id)} onHandoff={provider => void handoffTask(selectedTask, provider)} onAction={action => void taskAction(selectedTask, action)} onStart={provider => void taskAction(selectedTask, 'start', provider)} onReconcile={(summary, instruction, provider) => void reconcileTask(selectedTask, summary, instruction, provider)} onReview={(approve, summary, ids) => void reviewAnalysisChild(selectedTask, approve, summary, ids)} onCreateChild={(goal, scope, kind, replace) => void createReadChild(selectedTask, goal, scope, kind, replace)} onComplete={(summary, reportOnly) => void finishTask(selectedTask, summary, reportOnly)} onVerifyChild={() => void verifyCompletedChild(selectedTask)} />}</Sheet>
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

export function TaskCreateForm({ workspaces, activeWorkspaceId, providers, onCreated }: { activeWorkspaceId?: string | null; workspaces: { id: string; name: string }[]; providers: { id: string; name: string; eligible: boolean; reason: string | null }[]; onCreated(task: Task): Promise<void> }) {
  const [goal, setGoal] = useState('');
  const defaultWorkspace = activeWorkspaceId && workspaces.some(item => item.id === activeWorkspaceId) ? activeWorkspaceId : workspaces.length === 1 ? workspaces[0].id : '';
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspace);
  const workspaceChosen = useRef(false);
  const workspaceAvailable = workspaces.some(item => item.id === workspaceId);
  useEffect(() => { if (!workspaceChosen.current && !workspaceId && defaultWorkspace) setWorkspaceId(defaultWorkspace); }, [defaultWorkspace, workspaceId]);
  const [agentProvider, setAgentProvider] = useState('');
  const [defaultProvider,setDefaultProvider]=useState(''),[defaultsReady,setDefaultsReady]=useState(false);
  const [cooperate, setCooperate] = useState(true), [allowUnknownCost, setAllowUnknownCost] = useState(false);
  const [machineCheck, setMachineCheck] = useState(false), [editablePaths, setEditablePaths] = useState(''), [testFiles, setTestFiles] = useState('');
  const createRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(()=>{let alive=true;void settingsClient.get().then(({settings})=>{if(!alive)return;const configured=settings.agents?.defaultAgentProvider;const preferred=typeof configured==='string'&&configured!=='auto'?configured:'';setDefaultProvider(preferred);if(preferred&&preferred!=='cetamesh')setCooperate(false);setDefaultsReady(true);}).catch(cause=>{if(alive)setError(messageOf(cause));});return()=>{alive=false;};},[]);
  const effectiveProvider=agentProvider||defaultProvider;
  const managedChoice = !effectiveProvider || effectiveProvider === 'cetamesh';
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!goal.trim()) return;
    if (!workspaceAvailable) { setError('请选择当前可用的工作区'); return; }
    setBusy(true); setError('');
    try {
      await confirmAgentExecution(effectiveProvider, workspaceId);
      const enabled=cooperate && managedChoice;
      const lines=(value:string)=>value.split(/\r?\n/).map(row=>row.trim()).filter(Boolean);
      const collaboration={enabled,allowUnknownCost:enabled && allowUnknownCost,prepareNative:enabled,
        ...(enabled && machineCheck?{verification:{editablePaths:lines(editablePaths),testFiles:lines(testFiles)}}:{})};
      const fingerprint = JSON.stringify([goal.trim(), workspaceId, agentProvider,collaboration]);
      if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: crypto.randomUUID() };
      const result=await taskClient.create({ goal: goal.trim(), workspaceId: workspaceId || null, agentProvider,collaboration,
        requestId: createRequest.current.id });
      createRequest.current = null;
      await onCreated(result.task);
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  return <form className="task-create-form" onSubmit={submit}>
    <label>任务目标<textarea className="cm-textarea" aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={4} maxLength={2000} placeholder="描述需要完成的工作和预期结果" required /></label>
    <Select label="工作区" value={workspaceId} onChange={event => { workspaceChosen.current = true; setWorkspaceId(event.target.value); }}><option value="">选择工作区</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</Select>
    {workspaceId && !workspaceAvailable && <p role="status" className="muted">所选工作区已不可用，请重新选择。</p>}
    <p className="muted">使用已配置的默认执行者。系统按任务需要选择工具和协作方式，进展与待确认操作会显示在任务详情。</p>
    <details><summary>协作与验收设置</summary>
      <Select label="执行者" value={agentProvider} onChange={event => setAgentProvider(event.target.value)}><option value="">自动（使用已配置的默认执行者）</option>{providers.map(item => <option key={item.id} value={item.id} disabled={!item.eligible}>{item.name}{item.eligible ? '' : ' · 不可用'}</option>)}</Select>
      {providers.some(item => !item.eligible) && <details><summary>不可用执行者与恢复方法</summary><ul>{providers.filter(item => !item.eligible).map(item => <li key={item.id}><strong>{item.name}</strong> · {item.id === 'dsh' ? dshSetupReasonLabel(item.reason) : availabilityReasonLabel(item.reason)}</li>)}</ul><p className="muted">请在执行者设置中核对安装、登录、连接与权限，重新检查后重新打开此窗口。执行条件未满足时仍不能派发任务。</p></details>}
      <label><input type="checkbox" checked={cooperate} disabled={!managedChoice} onChange={event=>setCooperate(event.target.checked)} />允许按需协作（本任务最多一次外部分配，30 分钟内有效）</label>
      <label><input type="checkbox" checked={allowUnknownCost} disabled={!managedChoice || !cooperate} onChange={event=>setAllowUnknownCost(event.target.checked)} />允许费用未知的外部 Agent 调用（可能产生费用）</label>
      <p className="muted">原生执行范围仍需单独确认。简单任务会直接处理；未配置自动验收的结果保留人工核验。</p>
      <label><input type="checkbox" checked={machineCheck} disabled={!managedChoice || !cooperate} onChange={event=>setMachineCheck(event.target.checked)} />以现有项目测试作为自动验收标准</label>
      {machineCheck && <><label>允许修改的文件（每行一个精确相对路径）<textarea className="cm-textarea" aria-label="允许修改的文件" value={editablePaths} onChange={event=>setEditablePaths(event.target.value)} required /></label><label>已有验收文件（每行一个，内容保持不变）<textarea className="cm-textarea" aria-label="已有验收文件" value={testFiles} onChange={event=>setTestFiles(event.target.value)} required /></label><p className="muted">Core 将固定这些文件和 package.json 的内容，独立运行 npm test。自动验收仅覆盖此测试和修改范围，需要干净的 Git 基线。</p></>}
    </details>
    {error && <ErrorNotice error={error} />}<Button variant="primary" type="submit" disabled={busy || !defaultsReady || !goal.trim() || !workspaceAvailable}>{busy ? '启动中…' : '开始任务'}</Button></form>;
}

export function TaskApprovals({taskId}:{taskId:string}) {
 const [approvals,setApprovals]=useState<Approval[]>([]),[operations,setOperations]=useState<ApprovalDecisionResult[]>([]),[error,setError]=useState(''),[readError,setReadError]=useState('');
 const knownApprovals=useRef(new Set<string>()),order=useRef({issued:0,applied:0,epoch:0}),actionRef=useRef(0);const [grants,setGrants]=useState<L2Grant[]>([]);
 const refresh=useCallback(async()=>{
   const request=++order.current.issued,epoch=order.current.epoch;
   let data:Awaited<ReturnType<typeof approvalClient.list>>;
   try{data=await approvalClient.list();}catch(cause){
     if(epoch!==order.current.epoch||request<=order.current.applied)return;
     order.current.applied=request;setReadError(messageOf(cause));return;
   }
   if(epoch!==order.current.epoch||request<=order.current.applied)return;
   order.current.applied=request;
   setReadError('');
   const scoped=data.approvals.filter(row=>row.taskId===taskId);for(const row of scoped)knownApprovals.current.add(row.id);
   setApprovals(scoped.filter(row=>row.status==='pending'));
   setGrants((data.grants??[]).filter(row=>row.taskId===taskId&&row.status==='active'&&row.expiresAt>Date.now()&&row.uses<row.maxUses));
   setOperations((data.operations??[]).filter(row=>row.approvalId && knownApprovals.current.has(row.approvalId)));
 },[taskId]);
 useEffect(()=>{let alive=true;const load=()=>{if(alive)void refresh();};load();const off=bridge.subscribe('approval.pending',load),done=bridge.subscribe('approval.operation',load);const timer=window.setInterval(load,1500);return()=>{alive=false;order.current.epoch+=1;off();done();window.clearInterval(timer);};},[refresh]);
 async function changeApproval(action:()=>Promise<unknown>){
   const request=++actionRef.current;order.current.epoch+=1;
   try{await action();order.current.epoch+=1;await refresh();if(request===actionRef.current)setError('');}
   catch(cause){order.current.epoch+=1;if(request===actionRef.current)setError(messageOf(cause));}
 }
 function decide(id:string,approve:boolean,reuse=false){return changeApproval(()=>approvalClient.decide(id,approve,reuse));}
 return <section aria-label="本任务待确认操作">{error && <ErrorNotice error={error} />}{readError && <ErrorNotice error={readError} />}{approvals.map(row=><ApprovalCard key={row.id} approval={row} onDecide={(id,approve)=>void decide(id,approve)} onReuse={id=>void decide(id,true,true)} />)}{(approvals.length>0||grants.length>0)&&<p className="muted">有限授权仅覆盖相同执行者、任务、工作区和完全相同的参数；本次批准与后续 3 次分别计数。</p>}{grants.map(grant=><p key={grant.id}>{grant.resources.join("、")} · 后续已用 {grant.uses}/{grant.maxUses} · 有效至 {dateLabel(grant.expiresAt)} <Button compact variant="ghost" onClick={()=>{void changeApproval(()=>approvalClient.revokeGrant(grant.id));}}>撤销授权</Button></p>)}<ApprovalOperationSummary operations={operations} onCancel={id=>{void changeApproval(()=>approvalClient.cancel(id));}} /></section>;
}

function TaskCollaborationSummary({ task, onReview, onCreateChild, onVerifyChild, onOpenChild }: { task: Task;
  onReview(approve: boolean, summary: string, evidenceEventIds: string[]): void;
  onVerifyChild(): void; onOpenChild?(id:string):void;
  onCreateChild(goal: string, scope: string, outputKind: 'analysis' | 'tool', supersedesChildId?: string): void }) {
  const children = task.children ?? [], attempts = task.attempts ?? [], executionEvidence = task.executionEvidence ?? [];
  const [reviewText, setReviewText] = useState(''), [childGoal, setChildGoal] = useState(''), [childScope, setChildScope] = useState('');
  const [childKind, setChildKind] = useState<'analysis' | 'tool'>('analysis'), [replacement, setReplacement] = useState(''), [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(children.length / 20) - 1));
  const lastSourceEvidence = executionEvidence.filter(item => ['filesystem.read', 'filesystem.search'].includes(item.capability)).at(-1);
  if (!task.parentTaskId && !children.length && !['queued', 'running', 'paused'].includes(task.status)) return <p className="muted">暂无子任务协作记录。</p>;
  return <section aria-label="Task collaboration" className="task-collaboration-summary">
    {task.parentTaskId && <p><Badge>{task.verification === 'VERIFIED' ? '已核验' : '待核验'}</Badge><small>父任务关联保留，可通过上方入口查看。</small></p>}
    {attempts.length > 0 && <details className="task-advanced"><summary>执行尝试 · {attempts.length}</summary>{attempts.slice(-20).map(item => <p key={item.id}><strong>{item.provider}</strong> · <StatusBadge value={item.state} /><small>{dateLabel(item.updatedAt ?? item.at)}</small></p>)}</details>}
    {!task.parentTaskId && task.status === 'running' && <p>先暂停父任务，才能在同一工作区创建只读子任务。</p>}
    {!task.parentTaskId && ['queued', 'paused'].includes(task.status) && <details className="task-advanced"><summary>创建只读子任务</summary><div className="task-form-grid"><p>最多同时执行两个只读子任务。创建后选择可用执行者并启动。</p>
      <label>子任务目标<Input aria-label="子任务目标" value={childGoal} onChange={event => setChildGoal(event.target.value)} maxLength={2000} /></label>
      <label>相对读取范围<Input aria-label="相对读取范围" value={childScope} onChange={event => setChildScope(event.target.value)} maxLength={1000} /></label>
      <Select label="结果类型" value={childKind} onChange={event => setChildKind(event.target.value as 'analysis' | 'tool')}><option value="analysis">分析，需 Owner 核验</option><option value="tool">文件读取结果</option></Select>
      <Select label="替代失败子任务" value={replacement} onChange={event => setReplacement(event.target.value)}><option value="">不替代</option>{children.filter(child => ['failed', 'cancelled'].includes(child.status) && !children.some(row => row.supersedesChildId === child.id)).map(child => <option key={child.id} value={child.id}>{child.title}</option>)}</Select>
      <Button disabled={!childGoal.trim() || !childScope.trim()} onClick={() => onCreateChild(childGoal.trim(), childScope.trim(), childKind, replacement || undefined)}>创建只读子任务</Button>
    </div></details>}
    {task.parentTaskId && task.childOutputKind === 'analysis' && task.status === 'completed' && task.verification !== 'VERIFIED' && <div className="task-form-grid"><label>Owner 核验说明<Textarea aria-label="Owner 核验说明" value={reviewText} onChange={event => setReviewText(event.target.value)} rows={3} maxLength={2000} /></label><div className="row"><Button disabled={!reviewText.trim() || lastSourceEvidence?.status !== 'completed'} onClick={() => onReview(true, reviewText, lastSourceEvidence ? [lastSourceEvidence.eventId] : [])}>确认分析证据</Button><Button disabled={!reviewText.trim()} onClick={() => onReview(false, reviewText, [])}>退回审阅</Button></div></div>}
    {task.parentTaskId && task.childOutputKind === 'tool' && task.status === 'completed' && task.verification !== 'VERIFIED' && <Button onClick={onVerifyChild}>重新核对已观察的证据</Button>}
    {children.slice(currentPage * 20, (currentPage + 1) * 20).map(child => <article key={child.id} className="task-child-summary"><div className="task-child-heading">{onOpenChild ? <Button compact variant="ghost" onClick={() => onOpenChild(child.id)}>{child.title}</Button> : <strong>{child.title}</strong>}<StatusBadge value={child.status} /></div><p>{child.agent || '未分配执行者'} · {child.verification === 'VERIFIED' ? '证据已核验' : '证据待核验'}</p><small>执行尝试 {child.attemptCount}</small><UsageSummary usage={child.usage} label="子任务用量" /></article>)}
    <SmallPager page={currentPage} total={children.length} size={20} onPage={setPage} label="子任务分页" />
  </section>;
}

function WorkspaceVersion({id,executor,revision}: {id:string;executor:string|null;revision:number|null}) {
 const [version,setVersion]=useState<Awaited<ReturnType<typeof workspaceClient.version>>|null>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;setVersion(null);setError('');void workspaceClient.version(id).then(v=>{if(alive){setVersion(v);setError('');}}).catch(e=>{if(alive)setError(messageOf(e));});return()=>{alive=false;};},[id,revision]);
 return <section aria-label="项目版本"><h3>项目版本</h3>{error?<p>{error}</p>:version?<><p>{version.isRepo?(version.headSha?'当前版本 '+version.headSha.slice(0,8):'尚未创建版本'):'普通目录 · 使用文件校验追踪'} · 当前执行者 {executor||'待分配'}</p><p>{version.total ?? version.changes.length} 个变更文件 · {version.changes.some(c=>c.conflict)?'存在版本冲突，需核对':version.truncated?'仅显示部分文件，其余变更仍需核对':'未发现 Git 索引冲突'}</p><details><summary>查看版本详情</summary><p>{version.branch||'未记录分支'} · {version.headSha||'无 Commit'}</p>{version.truncated&&<p>仅显示前 {version.changes.length} 个变更；完整修改可在下方工作区审阅入口或 Git 工作台查看。</p>}{version.changes.map(c=><p key={c.path}>{c.status} · {c.path}</p>)}<p>此处仅显示版本状态；文件导入仍逐项核对 Hash。提交和合并需要独立授权。</p></details></>:<p>正在读取项目版本…</p>}</section>;
}

function TaskRecoveryEvidence({task}: {task:Task}) {
  const [inspection,setInspection]=useState<Awaited<ReturnType<typeof taskClient.inspectRecovery>>|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const identity=useRef('');identity.current=task.id+':'+task.rev;
  useEffect(()=>{identity.current=task.id+':'+task.rev;setInspection(null);setError('');setBusy(false);return()=>{identity.current='';};},[task.id,task.rev]);
  const rows=inspection?.operations??task.recovery?.operations??[];
  async function inspect(){const current=identity.current;setBusy(true);try{const result=await taskClient.inspectRecovery(task.id);if(identity.current!==current)return;if(result.taskRev===task.rev)setInspection(result);else setError('任务已变化，请刷新后重新核对');}catch(e){if(identity.current===current)setError(messageOf(e));}finally{if(identity.current===current)setBusy(false);}}
  return <section aria-label="操作核对证据"><h3>操作核对</h3><p>核对只读取操作回执和当前结果，不重新执行写入。无法证实的结果仍需人工核对。</p>
    <Button disabled={busy} onClick={()=>void inspect()}>{busy?'正在核对…':'核对已记录结果（只读）'}</Button>{error&&<ErrorNotice error={error}/>}
    {rows.map(row=><div key={row.operationId}><p><strong>{row.capability}</strong> · {'verified' in row&&row.verified?'当前结果已核实':row.status}{'code' in row&&row.code?' · '+row.code:''}</p><details><summary>操作标识</summary><code>{row.operationId}</code></details></div>)}
    {!rows.length&&<p>没有可关联的操作回执；请核对工作区差异、文件及外部操作记录后再恢复。</p>}
    {(inspection?.omitted??task.recovery?.omitted??0)>0&&<p>仅展示最近 40 项；仍有历史操作未展示，不代表全部已核对。</p>}
  </section>;
}

export function TaskDetails({ task, providers, onHandoff, onAction, onStart, onReconcile, onReview, onCreateChild, onComplete, onVerifyChild, onOpenChild }: { onOpenChild?(id: string): void; task: Task; providers: { id: string; name: string; eligible: boolean }[]; onHandoff(provider: string): void; onAction(action: 'start' | 'pause' | 'resume' | 'cancel'): void; onStart(provider: string): void; onReconcile(summary: string, instruction: string, provider?: string): void; onReview(approve: boolean, summary: string, evidenceEventIds: string[]): void; onCreateChild(goal: string, scope: string, outputKind: 'analysis' | 'tool', supersedesChildId?: string): void; onComplete(summary: string, reportOnly?: boolean): void; onVerifyChild(): void }) {
  const [handoffProvider, setHandoffProvider] = useState('');
  const [startProvider, setStartProvider] = useState('');
  const [reviewSummary, setReviewSummary] = useState('');
  const [nextInstruction, setNextInstruction] = useState('');
  const [recoveryProvider, setRecoveryProvider] = useState('');
  const [completionSummary, setCompletionSummary] = useState('');
  const [reviewedReport, setReviewedReport] = useState('');
  const reportKey = task.reviewReport ? task.reviewReport.eventId + ':' + task.reviewReport.sha256 : '';
  const reportOnlyAllowed = !task.parentTaskId && !task.children?.length && !task.execution?.hadToolActivity
    && !task.execution?.hasEvidence && task.execution?.state === 'awaiting-review' && Boolean(reportKey);
  const reportOnly = reportOnlyAllowed && reviewedReport === reportKey;
  const readyForReview = task.parentTaskId ? task.attempts?.at(-1)?.state === 'completed'
    : (task.execution?.state === 'awaiting-review' || (!task.currentAgent && Boolean(task.children?.length))) && (task.children?.length
      ? !task.children.filter(child => !task.children.some(other => other.supersedesChildId === child.id)).some(child => child.status !== 'completed' || child.verification !== 'VERIFIED')
      : task.execution?.hasEvidence || reportOnly);

  const recoveryRequired = /needs-reconciliation|interrupted after Core restart/i.test(task.progress.note);
  return <div className="task-details task-product-details">
    {task.parentTaskId && onOpenChild && <Button compact variant="ghost" onClick={() => onOpenChild(task.parentTaskId!)}>返回父任务</Button>}
    <TaskDependencyNotice task={task} onOpenChild={onOpenChild} />
    <div className="task-detail-overview"><StatusBadge value={taskDisplayStatus(task)} /><span>{taskProgressLabel(task)}</span><small>更新于 {dateLabel(task.updatedAt)}</small></div>
    {task.result && <section className="task-delivery-summary" aria-label="任务执行结果"><h3>执行结果</h3><p className="task-review-report">{task.result.summary}</p></section>}
    <TaskDetailSection title="任务目标与进度" initialOpen><p className="task-goal">{task.goal}</p><TaskProgress percent={taskProgressValue(task)} />{task.currentPhase && <p><strong>当前阶段</strong> · {task.currentPhase}</p>}{task.progress.note && <p><strong>进度说明</strong> · {task.progress.note}</p>}{task.checkpoint && <section><h4>检查点</h4><p>{task.checkpoint.summary}</p>{task.checkpoint.nextAction && <small>下一步：{task.checkpoint.nextAction}</small>}</section>}<UsageSummary usage={task.usage} label="任务累计用量" /></TaskDetailSection>
    {task.failure?.reason && <section className="task-failure-summary" role="status"><h3>中断或失败原因</h3><p>{task.failure.reason}</p></section>}
    <TaskDetailSection title="结果与交付" initialOpen={task.execution?.state === 'awaiting-review' || task.status === 'completed'}>
      <section><h3>交付物</h3>{task.artifacts.length ? task.artifacts.map(item => <ArtifactCard key={item.id} taskId={task.id} artifact={item} />) : <p className="muted">暂无交付物。</p>}</section>
      {task.status !== 'completed' && <section className="task-form-grid"><h3>结果验收</h3>{task.execution?.state === 'awaiting-review' && <p>本轮执行已结束，任务仍待你验收；不是已完成，也不自动计为 100%。</p>}{task.reviewReport && <div><h4>本轮分析报告（Agent 自述，未自动核验）</h4><p className="task-review-report">{task.reviewReport.text}</p></div>}{reportOnlyAllowed && <label className="task-check"><Input type="checkbox" checked={reportOnly} onChange={event => setReviewedReport(event.target.checked ? reportKey : '')} /><span>仅验收分析报告；不确认工具、文件修改或测试成功</span></label>}<label>验收说明<Textarea aria-label="验收说明" value={completionSummary} onChange={event => setCompletionSummary(event.target.value)} rows={3} maxLength={1000} /></label><Button disabled={task.status !== 'running' || !completionSummary.trim() || !readyForReview} onClick={() => onComplete(completionSummary.trim(), reportOnly)}>{reportOnly ? '确认分析报告' : '确认结果'}</Button>{!readyForReview && <small>先完成当前执行及必要证据核验，再确认结果。</small>}</section>}
      {task.workspaceId && <TaskWorkspaceChanges workspaceId={task.workspaceId} />}
    </TaskDetailSection>
    <TaskDetailSection title="协作与子任务" initialOpen={Boolean(task.children?.length) || Boolean(task.parentTaskId)}><TaskCollaborationSummary task={task} onReview={onReview} onCreateChild={onCreateChild} onVerifyChild={onVerifyChild} onOpenChild={onOpenChild} /></TaskDetailSection>
    <TaskDetailSection title="执行者与交接" initialOpen={task.status === 'queued'}>
      <section><h3>当前执行者</h3><p>{task.currentAgent?.provider || '尚未分配'}</p></section>
      {task.status === 'queued' && task.workspaceId && <section><h3>启动任务</h3><div className="task-form-grid"><Select label="执行者" value={startProvider} onChange={event => setStartProvider(event.target.value)}><option value="">选择可用 Agent</option>{providers.filter(item => item.eligible).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Button disabled={!startProvider || activeTaskChildren(task).length > 0} onClick={() => onStart(startProvider)}>启动</Button></div></section>}
      {task.currentAgent && ['queued', 'running', 'waiting', 'blocked', 'paused'].includes(task.status) && <section className="task-form-grid"><h3>转交执行者</h3><Select label="目标 Agent" value={handoffProvider} onChange={event => setHandoffProvider(event.target.value)}><option value="">选择 Agent</option>{providers.filter(item => item.eligible && item.id !== task.currentAgent?.provider).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Button disabled={!handoffProvider} onClick={() => onHandoff(handoffProvider)}>交接任务</Button></section>}
      <details className="task-advanced"><summary>执行者与交接记录 · {task.agentHistory.length}</summary>{task.agentHistory.length ? task.agentHistory.slice(-30).map((item, index) => <article className="task-timeline-row" key={item.sessionId + '-' + index}><strong>{item.provider}</strong><small>{dateLabel(item.attachedAt)}{item.detachedAt ? ' → ' + dateLabel(item.detachedAt) : ' · 当前执行者'}</small>{item.note && <p>{item.note}</p>}</article>) : <p className="muted">暂无执行者记录。</p>}</details>
    </TaskDetailSection>
    <TaskDetailSection title="来源与项目版本">{task.workspaceId ? <WorkspaceVersion id={task.workspaceId} executor={task.currentAgent?.provider ?? null} revision={task.rev} /> : <p className="muted">未绑定项目工作区。</p>}<p className="muted">相关来源和文件由执行证据保留；工作区当前修改不等于本任务的全部成果。</p></TaskDetailSection>
    <TaskDetailSection title="执行证据"><p className="muted">记录是执行观察，是否通过验收仍以相应证据核验为准。</p>{task.executionEvidence.length ? task.executionEvidence.slice(-20).reverse().map(item => <article className="task-timeline-row" key={item.eventId}><div className="task-child-heading"><strong>{item.tool || item.capability}</strong><StatusBadge value={item.status} /></div>{item.filePath && <p>{item.filePath}</p>}{item.exitCode !== null && <small>退出码 {item.exitCode}</small>}<details className="task-advanced"><summary>证据详情</summary><p>{item.capability} · Task rev {item.taskRev}</p><code>{item.eventId}</code></details></article>) : <p className="muted">暂无工具或测试执行记录。</p>}</TaskDetailSection>
    {recoveryRequired && <TaskDetailSection title="人工核对后恢复" initialOpen><TaskRecoveryEvidence task={task} /><div className="task-form-grid"><p>先核对工作区和上次操作的实际结果，再给出新的执行指令；不会重放中断前的工具调用。</p>{!task.currentAgent && <Select label="恢复执行者" value={recoveryProvider} onChange={event => setRecoveryProvider(event.target.value)}><option value="">选择恢复任务的 Agent</option>{providers.filter(item => item.eligible).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}<label>核对结果<Textarea aria-label="核对结果" value={reviewSummary} onChange={event => setReviewSummary(event.target.value)} rows={3} maxLength={1000} /></label><label>新的执行指令<Textarea aria-label="新的执行指令" value={nextInstruction} onChange={event => setNextInstruction(event.target.value)} rows={4} maxLength={32000} /></label><Button disabled={!reviewSummary.trim() || !nextInstruction.trim() || (!task.currentAgent && !providers.some(item => item.id === recoveryProvider && item.eligible))} onClick={() => onReconcile(reviewSummary, nextInstruction, task.currentAgent?.provider || recoveryProvider)}>确认核对并执行新指令</Button></div></TaskDetailSection>}
    <div className="row task-detail-actions">{['working', 'running'].includes(task.status) ? <Button onClick={() => onAction('pause')}>暂停任务</Button> : ['paused', 'waiting', 'blocked'].includes(task.status) && !/needs-reconciliation|Owner reviewed interrupted effect/i.test(task.progress.note) ? <Button disabled={activeTaskChildren(task).length > 0} onClick={() => onAction('resume')}>继续任务</Button> : null}{!['completed', 'cancelled', 'failed'].includes(task.status) && <Button variant="danger" onClick={() => onAction('cancel')}>取消任务</Button>}</div>
  </div>;
}

function TaskWorkspaceChanges({ workspaceId }: { workspaceId:string }) {
  const [open, setOpen] = useState(false);
  return <section className="task-workspace-review"><Button compact variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起工作区修改' : '审阅工作区修改'}</Button>{open && <WorkspaceChangesReview workspaceId={workspaceId} call={productToolsClient.call} />}</section>;
}
