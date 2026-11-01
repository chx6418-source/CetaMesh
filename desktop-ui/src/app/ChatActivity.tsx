import { useState, type KeyboardEvent } from 'react';
import type { ChatMessage } from '../bridge/typed-client';
import { Icon, type IconName } from '../components/icons';
import { Button } from '../components/primitives/inputs';
import { Badge } from '../components/primitives/surfaces';
import './chat-activity.css';

type ActivityTool = ChatMessage['toolActivity'][number] & { capability?: string | null; filePath?: string | null; exitCode?: number | null };
type ActivityState = 'pending' | 'running' | 'retrying' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'outcome-unknown' | 'unknown';
export type ChatActivityProps = {
  tools: ChatMessage['toolActivity'];
  agentActivity?: ChatMessage['agentActivity'];
  state?: string;
  taskId?: string | null;
  onOpenTask?(taskId: string): void;
};

const STATUS: Record<ActivityState, { label: string; icon: IconName; tone: 'default' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  pending: { label: '等待处理', icon: 'clock', tone: 'default' },
  running: { label: '运行中', icon: 'tools', tone: 'accent' },
  retrying: { label: '正在重试', icon: 'refresh', tone: 'warning' },
  'waiting-approval': { label: '等待审批', icon: 'approval', tone: 'warning' },
  completed: { label: '已结束', icon: 'check', tone: 'success' },
  failed: { label: '失败', icon: 'help', tone: 'danger' },
  cancelled: { label: '已取消', icon: 'close', tone: 'default' },
  'outcome-unknown': { label: '结果待核验', icon: 'help', tone: 'warning' },
  unknown: { label: '状态待核验', icon: 'help', tone: 'warning' }
};

// Exact observed capability identifiers only. Display labels and receipts never
// become an inferred plan, a hidden reasoning transcript or execution evidence.
const CAPABILITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'filesystem.read': '读取文件', 'workspace.read': '读取文件',
  'filesystem.search': '检查工作区', 'workspace.search': '检查工作区',
  'git.status': '检查工作区', 'git.diff': '检查工作区', 'git.overview': '检查工作区',
  'filesystem.write': '修改文件', 'workspace.write': '修改文件', 'workspace.apply': '修改文件',
  'test.run': '运行测试', 'workspace.test.run': '运行测试',
  'context.evidence.read': '读取上下文', 'operation.read': '核对操作回执',
  'memory.read': '读取记忆', 'memory.write': '保存记忆',
  'task.create': '创建任务', 'agent.run': '执行任务'
});

function activityState(value: string | undefined): ActivityState {
  if (value && Object.hasOwn(STATUS, value)) return value as ActivityState;
  const phases: Record<string, ActivityState> = { starting: 'pending', streaming: 'running', recovering: 'retrying', done: 'completed', error: 'failed' };
  return value && Object.hasOwn(phases, value) ? phases[value] : 'unknown';
}

function toolName(tool: ActivityTool) {
  const name = tool.label?.trim() || tool.capability?.trim();
  return !name || name === tool.id || /(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:|^call_[A-Za-z0-9_-]{12,})/i.test(name) ? '工具调用' : name;
}

function summarize(tools: ActivityTool[], agent: ChatMessage['agentActivity'], state?: string) {
  const phase = state && state !== 'idle' ? activityState(state) : agent ? activityState(agent.status) : null;
  const latest = (wanted: ActivityState) => [...tools].reverse().find(tool => activityState(tool.status) === wanted);
  const settledWithFailures = phase === 'completed' && Boolean(latest('failed'))
    && tools.every(tool => ['completed', 'failed', 'cancelled'].includes(activityState(tool.status)));
  let status: ActivityState;
  if (phase === 'waiting-approval' || latest('waiting-approval')) status = 'waiting-approval';
  else if (phase === 'outcome-unknown' || latest('outcome-unknown')) status = 'outcome-unknown';
  else if (phase === 'cancelled' || phase === 'failed') status = phase;
  else if (phase === 'completed' && tools.some(tool => ['pending', 'running', 'retrying'].includes(activityState(tool.status)))) status = 'unknown';
  else if (phase === 'retrying' || latest('retrying')) status = 'retrying';
  else if (latest('running') || phase === 'running') status = 'running';
  else if (latest('pending') || phase === 'pending') status = 'pending';
  else if (latest('failed')) status = 'failed';
  else if (latest('unknown') || phase === 'unknown') status = 'unknown';
  else if (latest('cancelled')) status = 'cancelled';
  else status = phase ?? (tools.length ? 'completed' : 'unknown');
  const active = latest(status);
  const capability = active?.capability?.trim() || active?.label?.trim() || '';
  const action = Object.hasOwn(CAPABILITY_LABELS, capability) ? CAPABILITY_LABELS[capability] : null;
  const headline = settledWithFailures ? '本轮执行已结束，存在失败记录'
    : status === 'running' ? action ? `正在${action}` : tools.length ? '工具活动进行中' : '执行者正在处理请求'
    : status === 'pending' ? '等待处理下一步操作'
    : status === 'retrying' ? '正在重试当前操作'
    : status === 'waiting-approval' ? '等待审批后继续操作'
    : status === 'failed' ? action ? `${action}失败` : '当前操作失败'
    : status === 'cancelled' ? '当前操作已取消'
    : status === 'outcome-unknown' ? '操作结果待核验'
    : status === 'completed' ? tools.length ? '工具调用已结束' : '执行者本轮已结束'
    : state === 'cancelling' ? '正在停止，状态待核验' : '活动状态待核验';
  return { status, headline, settledWithFailures };
}

function closeDisclosure(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Escape' || !(event.target instanceof Element)) return;
  let disclosure = event.target.closest('details');
  while (disclosure && !disclosure.open) disclosure = disclosure.parentElement?.closest('details') ?? null;
  if (!disclosure || !event.currentTarget.contains(disclosure)) return;
  event.preventDefault(); event.stopPropagation();
  disclosure.open = false;
  disclosure.querySelector<HTMLElement>(':scope > summary')?.focus();
}

function ToolActivityRow({ tool }: { tool: ActivityTool }) {
  const status = activityState(tool.status), view = STATUS[status];
  const duration = typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs) && tool.durationMs >= 0 ? `${(tool.durationMs / 1000).toFixed(1)} 秒` : null;
  return <details className={`tool-call ${status === 'running' || status === 'retrying' ? 'active' : status === 'failed' ? 'failed' : status === 'unknown' || status === 'outcome-unknown' ? 'unverified' : ''}`}>
    <summary><span className="chat-tool-main"><Icon name={view.icon} size={15} /><span className="chat-tool-name" title={toolName(tool)}>{toolName(tool)}</span></span><span className="tool-state">{status === 'completed' ? '已完成' : view.label}</span>{duration && <span className="tool-duration">{duration}</span>}<Icon name="down" size={14} /></summary>
    {tool.summary && <p className="tool-call-receipt">{tool.summary}</p>}
    {tool.filePath && <p className="chat-tool-file">{tool.filePath}</p>}
    {typeof tool.exitCode === 'number' && Number.isFinite(tool.exitCode) && <p className="chat-tool-exit">退出码 {tool.exitCode}</p>}
    <details className="tool-diagnostic"><summary>高级详情</summary><dl><dt>调用标识</dt><dd><code>{tool.id}</code></dd>{tool.capability && <><dt>能力标识</dt><dd><code>{tool.capability}</code></dd></>}<dt>原始状态</dt><dd>{tool.status}</dd></dl></details>
  </details>;
}

function ActivityPager({ page, total, onPage, label }: { page: number; total: number; onPage(page: number): void; label: string }) {
  const last = Math.max(0, Math.ceil(total / 20) - 1);
  return total > 20 ? <nav className="chat-activity-pagination" aria-label={label}><Button type="button" compact disabled={page === 0} onClick={() => onPage(page - 1)}>上一组</Button><small>{page * 20 + 1}–{Math.min(total, (page + 1) * 20)} / {total}</small><Button type="button" compact disabled={page >= last} onClick={() => onPage(page + 1)}>下一组</Button></nav> : null;
}

// The existing two bounded receipt groups remain independently paged at20 rows.
export function ToolActivity({ tools }: { tools: ChatMessage['toolActivity'] }) {
  const [attentionPage, setAttentionPage] = useState(0), [completedPage, setCompletedPage] = useState(0);
  if (!tools.length) return null;
  const completed = tools.filter(tool => tool.status === 'completed'), attention = tools.filter(tool => tool.status !== 'completed');
  const attentionCurrent = Math.min(attentionPage, Math.max(0, Math.ceil(attention.length / 20) - 1));
  const completedCurrent = Math.min(completedPage, Math.max(0, Math.ceil(completed.length / 20) - 1));
  const counts = (Object.keys(STATUS) as ActivityState[]).map(status => [status === 'completed' ? '已完成' : STATUS[status].label, tools.filter(tool => activityState(tool.status) === status).length] as const).filter(([, count]) => count > 0);
  return <section className="tool-activity chat-tool-activity" aria-label="工具活动" onKeyDown={closeDisclosure}>
    <div className="tool-activity-heading"><strong>工具活动</strong><span>{counts.map(([label, count]) => `${label} ${count}`).join(' · ')}</span></div>
    {attention.slice(attentionCurrent * 20, (attentionCurrent + 1) * 20).map(tool => <ToolActivityRow key={tool.id} tool={tool} />)}
    <ActivityPager page={attentionCurrent} total={attention.length} onPage={setAttentionPage} label="待处理工具分页" />
    {completed.length > 0 && <details className="tool-completed"><summary><Icon name="check" size={14} /><span>已完成 {completed.length} 项</span><small>展开明细</small><Icon name="down" size={14} /></summary><div className="tool-completed-list" tabIndex={0} aria-label="已完成工具调用明细">{completed.slice(completedCurrent * 20, (completedCurrent + 1) * 20).map(tool => <ToolActivityRow key={tool.id} tool={tool} />)}<ActivityPager page={completedCurrent} total={completed.length} onPage={setCompletedPage} label="已完成工具分页" /></div></details>}
  </section>;
}

export function ChatActivity({ tools, agentActivity, state, taskId, onOpenTask }: ChatActivityProps) {
  const [expanded, setExpanded] = useState(false);
  if (!tools.length && !agentActivity && (!state || state === 'idle')) return null;
  const { status, headline, settledWithFailures } = summarize(tools, agentActivity, state);
  const view = settledWithFailures ? { ...STATUS[status], label: '已结束 · 有失败记录', tone: 'warning' as const } : STATUS[status];
  const names: Record<string, string> = { codex: 'Codex', cetamesh: 'CetaMesh Agent', dsh: 'DeepSeek Harness', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen', opencode: 'OpenCode' };
  const provider = agentActivity ? agentActivity.label && agentActivity.label !== agentActivity.providerId ? agentActivity.label : Object.hasOwn(names, agentActivity.providerId) ? names[agentActivity.providerId] : 'Agent' : null;
  return <section className="chat-activity" aria-label="Agent 活动" onKeyDown={closeDisclosure}>
    <details className={`chat-activity-card ${settledWithFailures ? 'settled' : status}`} onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
      <summary className="chat-activity-summary"><span className="chat-activity-main"><span className="chat-activity-icon"><Icon name={view.icon} size={17} /></span><span className="chat-activity-copy"><strong role="status" aria-live="polite" aria-atomic="true">{headline}</strong><small>{[provider, tools.length ? `${tools.length} 项工具活动` : '尚无工具活动记录'].filter(Boolean).join(' · ')}</small></span></span><Badge tone={view.tone}>{view.label}</Badge><Icon name="down" size={14} /></summary>
      {expanded && <div className="chat-activity-body"><ToolActivity tools={tools} />{!tools.length && <p className="chat-activity-empty">执行者尚未报告工具活动。</p>}{taskId && onOpenTask && <Button type="button" compact variant="ghost" icon="work" onClick={() => onOpenTask(taskId)}>查看任务</Button>}<details className="chat-activity-advanced"><summary>高级详情</summary><dl>{agentActivity && <><dt>执行者标识</dt><dd><code>{agentActivity.providerId}</code></dd><dt>执行者状态</dt><dd>{agentActivity.status}</dd></>}{taskId && <><dt>任务标识</dt><dd><code>{taskId}</code></dd></>}{state && <><dt>会话状态</dt><dd>{state}</dd></>}</dl></details></div>}
    </details>
  </section>;
}
