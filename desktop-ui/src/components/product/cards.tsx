import type { AgentView, MemoryView, PluginView, TaskView, UpdateView } from '../../types/views';
import { Icon } from '../icons';
import { Badge, Card } from '../primitives/surfaces';
import { Button } from '../primitives/inputs';

const taskLabels = { working: '进行中', waiting: '等待批准', paused: '已暂停', completed: '已完成' };
const agentLabels = { ready: '已就绪', 'needs-setup': '需要设置', 'not-installed': '未安装', 'not-supported': '暂不支持', unavailable: '暂不可用' };

export function TaskCard({ task, onOpen }: { task: TaskView; onOpen?(): void }) {
  return <Card className="task-card"><div className="row between"><div className="task-icon"><Icon name="work" size={17} /></div><Badge tone={task.status === 'completed' ? 'success' : task.status === 'waiting' ? 'warning' : 'accent'}>{taskLabels[task.status]}</Badge></div><h3>{task.title}</h3><div className="task-meta">{task.agent || '未分配智能体'}<span>·</span>{task.workspace}</div><div className="progress-track" role="progressbar" aria-label={`${task.title}进度`} aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}><span className={`progress-width-${task.progress}`} /></div><div className="row between"><small>{task.progress}% · {task.lastActivity}</small>{onOpen && <Button compact variant="ghost" onClick={onOpen}>打开 <Icon name="right" size={14} /></Button>}</div></Card>;
}

export function AgentCard({ agent, onOpen }: { agent: AgentView; onOpen?(): void }) {
  return <Card className="agent-card"><div className="row between"><div className="agent-avatar">{agent.initials}</div><Badge tone={agent.status === 'ready' ? 'success' : 'warning'}>{agentLabels[agent.status]}</Badge></div><h3>{agent.name}</h3><strong className="agent-role">{agent.role}</strong><p>{agent.description}</p>{onOpen && <Button compact variant="ghost" onClick={onOpen}>查看智能体 <Icon name="right" size={14} /></Button>}</Card>;
}

export function PluginCard({ plugin, onOpen }: { plugin: PluginView; onOpen(): void }) {
  return <button className="plugin-card" onClick={onOpen}><span className={`plugin-icon ${plugin.icon}`}><Icon name={plugin.icon} size={22} /></span><span className="plugin-card-body"><span className="row between"><strong>{plugin.name}</strong><Badge tone={plugin.status === 'installed' ? 'success' : plugin.status === 'update' ? 'warning' : 'default'}>{plugin.status === 'installed' ? '已安装' : plugin.status === 'update' ? '可更新' : '可获取'}</Badge></span><span className="plugin-summary">{plugin.summary}</span><span className="plugin-footer"><span>{plugin.developer}</span><span>v{plugin.version}</span><span>{plugin.kind === 'integration' ? '集成' : '扩展包'}</span></span></span></button>;
}

export function CapabilityBadge({ label }: { label: string }) { return <Badge tone="accent"><Icon name="tools" size={12} />{label}</Badge>; }
export function MemoryReference({ memory }: { memory: MemoryView }) { return <div className="memory-ref"><Icon name="memory" size={16} /><div><strong>{memory.title}</strong><small>{memory.category} · {memory.updatedAt}</small></div></div>; }
export function ArtifactCard({ title, kind }: { title: string; kind: string }) { return <div className="artifact-card"><Icon name="file" size={18} /><span className="grow"><strong>{title}</strong><small>{kind}</small></span><Icon name="right" size={15} /></div>; }
export function UpdateCard({ update }: { update: UpdateView }) { return <Card className="update-card"><div className="row between"><h3>软件更新</h3><Icon name="update" size={18} /></div><p>当前版本 {update.currentVersion}</p><small>{update.status === 'unknown' ? '尚未检查更新' : update.status === 'current' ? '已是最新版本' : `新版本 ${update.latestVersion}`}</small></Card>; }
