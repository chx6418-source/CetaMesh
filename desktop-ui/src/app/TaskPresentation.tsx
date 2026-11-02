import { useState, type ReactNode } from 'react';
import type { Task } from '../bridge/typed-client';
import { Icon } from '../components/icons';
import { Button, IconButton } from '../components/primitives/inputs';
import { Card } from '../components/primitives/surfaces';
import { StatusBadge, relativeLabel } from './PagePresentation';
import { activeTaskChildren } from './TaskExecutionFeedback';
export function SmallPager({ page, total, size, onPage, label }: { page: number; total: number; size: number; onPage(page:number):void; label:string }) {
  const last = Math.max(0, Math.ceil(total / size) - 1);
  return total > size ? <nav className="task-list-pagination" aria-label={label}><Button compact disabled={page === 0} onClick={() => onPage(page - 1)}>上一组</Button><small>{page * size + 1}–{Math.min(total, (page + 1) * size)} / {total}</small><Button compact disabled={page >= last} onClick={() => onPage(page + 1)}>下一组</Button></nav> : null;
}

export function taskDisplayStatus(task: Task) {
  return task.status === 'running' && task.execution?.state === 'awaiting-review' ? 'awaiting-review' : task.status;
}

export function taskProgressValue(task: Task) {
  if (task.progress.percent === 0 && (task.execution?.state === 'awaiting-review' || task.execution?.hasEvidence || task.artifacts?.length)) return null;
  return task.progress.percent;
}

export function taskProgressLabel(task: Task) {
  if (task.status === 'running' && task.execution?.state === 'awaiting-review') return '执行已结束，待验收';
  if (task.progress.percent === 0 && (task.execution?.hasEvidence || task.artifacts?.length)) return '已有成果，进度未量化';
  return progressLabel(task.progress.percent);
}

function progressValue(percent: number | null) {
  return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function progressLabel(percent: number | null) {
  const value = progressValue(percent);
  return value === null ? '进度未报告' : `${value}%`;
}

export function TaskProgress({ percent, label = '任务进度' }: { percent: number | null; label?: string }) {
  const value = progressValue(percent);
  return <div className="progress-track" role="progressbar" aria-label={label}
    aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}
    aria-valuetext={value === null ? '进度未报告' : undefined}>
    {value !== null && <span className="progress-value" style={{ width: `${value}%` }} />}
  </div>;
}

export function taskListTitle(task: Pick<Task, 'title' | 'goal'>): string {
  const original = (task.title || task.goal || '').trim();
  const envelope = '[Prior Owner constraints in this Task Chat Session; verify against the current request]';
  const requestMarker = '[Current request]';
  const source = original.startsWith(envelope) && !original.includes(requestMarker) ? (task.goal || original).trim() : original;
  const marker = source.lastIndexOf(requestMarker);
  if (source.startsWith(envelope) && marker < envelope.length) return '历史任务（原始描述见详情）';
  const display = source.startsWith(envelope) ? source.slice(marker + requestMarker.length).trim() : original;
  return display.replace(/\s+/g, ' ') || '未命名任务';
}

export function taskDialogTitle(task:Pick<Task,'title'|'goal'>):string { const title=Array.from(taskListTitle(task));return title.length>68?title.slice(0,68).join('')+'…':title.join(''); }

export function WorkTaskList({ tasks, workspaces, providers, historyInitiallyOpen = false, onOpen, onAction }: {
  tasks: Task[]; workspaces: { id: string; name: string }[]; providers: { id: string; name: string }[];
  historyInitiallyOpen?: boolean; onOpen(task: Task): void; onAction(task: Task, action: 'start' | 'pause' | 'resume' | 'cancel'): void;
}) {
  const [attentionPage, setAttentionPage] = useState(0), [historyPage, setHistoryPage] = useState(0);
  const isHistory = (task: Task) => ['completed', 'cancelled'].includes(task.status);
  const history = tasks.filter(isHistory), attention = tasks.filter(task => !isHistory(task));
  const attentionCurrent = Math.min(attentionPage, Math.max(0, Math.ceil(attention.length / 50) - 1)), historyCurrent = Math.min(historyPage, Math.max(0, Math.ceil(history.length / 50) - 1));
  const workspaceName = (task: Task) => workspaces.find(item => item.id === task.workspaceId)?.name || (task.workspaceId ? '工作区已不可用' : '未绑定工作区');
  const executorName = (task: Task) => {
    const current = task.currentAgent?.provider || task.agent, prior = task.agentHistory.at(-1)?.provider, provider = current || prior;
    if (!provider) return isHistory(task) ? '执行者已结束' : '未分配智能体';
    const name = providers.find(item => item.id === provider)?.name || ({ codex: 'Codex', cetamesh: 'CetaMesh Managed Agent', dsh: 'DSH' } as Record<string,string>)[provider] || provider;
    return name + (!current ? '（已结束）' : '');
  };
  return <div className="work-task-list">
    {attention.length > 0 && <><div className="task-grid">{attention.slice(attentionCurrent * 50, (attentionCurrent + 1) * 50).map(task => <TaskCollaborationCard key={task.id} task={task} workspaceName={workspaceName(task)} executorName={executorName(task)} onOpen={() => onOpen(task)} onAction={action => onAction(task, action)} />)}</div><SmallPager page={attentionCurrent} total={attention.length} size={50} onPage={setAttentionPage} label="任务分页" /></>}
    {history.length > 0 && <details className="task-history" open={historyInitiallyOpen || undefined}><summary><Icon name="work" size={16} /><strong>历史任务</strong><span>{history.length} 项</span><small>已完成 {history.filter(task => task.status === 'completed').length} · 已取消 {history.filter(task => task.status === 'cancelled').length}</small><Icon name="down" size={15} /></summary><div className="task-history-list">{history.slice(historyCurrent * 50, (historyCurrent + 1) * 50).map(task => <article key={task.id} className="task-history-row"><div className="task-history-main"><h3 title={taskListTitle(task)}>{taskListTitle(task)}</h3><div className="task-meta"><span>{workspaceName(task)}</span><span>·</span><span>{executorName(task)}</span><span>·</span><time>{relativeLabel(task.updatedAt)}</time></div></div><StatusBadge value={taskDisplayStatus(task)} /><Button compact variant="ghost" onClick={() => onOpen(task)}>详情 <Icon name="right" size={14} /></Button></article>)}</div><SmallPager page={historyCurrent} total={history.length} size={50} onPage={setHistoryPage} label="历史任务分页" /></details>}
  </div>;
}

export function TaskCollaborationCard({ task, workspaceName, executorName, onOpen, onAction }: { task: Task; workspaceName: string; executorName: string; onOpen(): void; onAction(action: 'start' | 'pause' | 'resume' | 'cancel'): void }) {
  return <Card className="task-card task-collaboration-card"><div className="task-card-heading"><div className="task-icon"><Icon name="work" size={18} /></div><StatusBadge value={taskDisplayStatus(task)} /></div><h3 title={taskListTitle(task)}>{taskListTitle(task)}</h3><dl className="task-card-context"><div><dt>项目</dt><dd>{workspaceName}</dd></div><div><dt>执行者</dt><dd>{executorName}</dd></div></dl>{activeTaskChildren(task).length > 0 && <small className="task-dependency-hint">等待 {activeTaskChildren(task).length} 个子任务</small>}{task.execution?.state === 'awaiting-review' && <small className="task-delivery-note">执行结果已返回，等待验收</small>}<TaskProgress percent={taskProgressValue(task)} label={`${taskListTitle(task)}进度`} /><div className="task-card-outcome"><small>{taskProgressLabel(task)}</small><span><Icon name="file" size={12} />交付物 {task.artifacts?.length ?? 0}</span></div><footer className="task-card-footer"><small>{relativeLabel(task.updatedAt)}</small><div className="task-card-actions"><Button compact variant="ghost" onClick={onOpen}>详情 <Icon name="right" size={14} /></Button>{task.status === 'queued' && task.workspaceId ? <Button compact variant="ghost" onClick={onOpen}>{activeTaskChildren(task).length ? '查看子任务' : '选择执行者'}</Button> : task.status === 'running' ? <Button compact variant="ghost" onClick={() => onAction('pause')}>暂停</Button> : ['paused', 'waiting', 'blocked'].includes(task.status) && !/needs-reconciliation|Owner reviewed interrupted effect/i.test(task.progress.note) ? <Button compact variant="ghost" disabled={activeTaskChildren(task).length > 0} onClick={() => onAction('resume')}>继续</Button> : null}{!['completed', 'cancelled', 'failed'].includes(task.status) && <IconButton label="取消任务" icon="close" compact onClick={() => onAction('cancel')} />}</div></footer></Card>;
}

export function TaskCollaborationStatus({task}:{task:Task}){
 const state=task.collaboration;if(!state)return null;
 const labels:Record<string,string>={proposed:'正在选择并准备执行者',dispatching:'正在核验并交接', 'awaiting-result':'协作执行中',returning:'正在接回结果',verifying:'正在独立验证',verified:'机器验收通过','needs-review':'结果待核验',blocked:'协作需要处理',unknown:'结果未知，需先核对副作用'};
 return <section aria-label="自动协作状态"><h3>{labels[state.state??'']??(state.enabled?'按需自动协作已启用':'自动协作已撤销')}</h3><p>{state.selectedProvider?'执行者：'+state.selectedProvider+'。 ':''}{state.machineVerification?'以固定测试和文件范围验收。':'交付结果需要人工核验。'}{state.code?' 原因：'+state.code:''}</p></section>;
}

export function TaskDetailSection({ title, initialOpen = false, children }: { title:string; initialOpen?:boolean; children:ReactNode }) {
  return <details className="task-detail-section" open={initialOpen || undefined}><summary>{title}<Icon name="down" size={14} /></summary><div className="task-detail-section-body">{children}</div></details>;
}
