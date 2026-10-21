import { useState } from 'react';
import { Icon } from '../icons';
import { Button, Dropdown, IconButton } from '../primitives/inputs';
import { Badge, Card } from '../primitives/surfaces';
import { Markdown } from '../primitives/content';
import { agents, models } from '../../data/mock';
import { copy } from '../../i18n/zh-CN';
import { useUi } from '../../stores/ui';

export function ChatMessage({ role, text, time }: { role: 'user' | 'assistant'; text: string; time?: string }) {
  return <article className={`chat-message ${role}`}><div className="message-avatar">{role === 'assistant' ? <Icon name="sparkles" size={16} /> : '你'}</div><div className="message-body"><div className="message-meta"><strong>{role === 'assistant' ? 'CetaMesh' : '你'}</strong>{time && <span>{time}</span>}</div><Markdown>{text}</Markdown></div></article>;
}

export function ToolCallCard() {
  return <details className="tool-call"><summary><Icon name="check" size={15} /><span>读取 package.json</span><span className="tool-duration">0.8 秒</span><Icon name="down" size={14} /></summary><div className="tool-detail"><div><b>输入</b><code>package.json</code></div><div><b>结果</b><span>已找到项目脚本与依赖清单。</span></div></div></details>;
}

export function AgentActivity({ compact = false }: { compact?: boolean }) {
  const steps = [
    { label: '搜索文件', done: true }, { label: '读取 package.json', done: true },
    { label: '修改 3 个文件', done: true }, { label: '等待测试批准', done: false }
  ];
  return <div className={`agent-activity ${compact ? 'compact' : ''}`}><div className="row between"><strong>执行进度</strong><Badge tone="accent">Codex · Working</Badge></div><ol>{steps.map((step) => <li key={step.label} className={step.done ? 'done' : ''}><Icon name={step.done ? 'check' : 'clock'} size={14} />{step.label}</li>)}</ol></div>;
}

export function ApprovalCard() {
  const approval = useUi((state) => state.approval);
  const decide = useUi((state) => state.decideApproval);
  return <Card className="approval-card"><div className="approval-icon"><Icon name="approval" size={19} /></div><div className="grow"><div className="row between"><strong>等待你的批准</strong><Badge tone="warning">需要处理</Badge></div><p>CetaMesh 需要运行项目测试。</p><small>将执行项目定义的测试命令。此卡片为交互演示，不会运行命令。</small>{approval === 'pending' ? <div className="row approval-actions"><Button compact variant="ghost" onClick={() => decide('denied')}>{copy.deny}</Button><Button compact variant="primary" onClick={() => decide('approved')}>{copy.approveOnce}</Button></div> : <div className="approval-result" role="status">{approval === 'approved' ? '已在演示中批准一次' : '已在演示中拒绝'}</div>}</div></Card>;
}

export function ModelSelector() {
  const [selected, setSelected] = useState(models[0].id);
  const model = models.find((item) => item.id === selected) ?? models[0];
  return <Dropdown label={model.name}>{models.map((item) => <button key={item.id} className="dropdown-item" disabled={!item.configured} onClick={() => setSelected(item.id)}><Icon name="sparkles" size={14} />{item.name}{!item.configured && <small>未配置</small>}</button>)}<div className="dropdown-hint">Provider 与推理设置位于「设置 → 模型」。</div></Dropdown>;
}

export function ChatComposer({ onSend }: { onSend(text: string): void }) {
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState(false);
  function submit() { const text = draft.trim(); if (text) { onSend(text); setDraft(''); } }
  return <div className="chat-composer"><div className="composer-field"><textarea aria-label="输入消息" placeholder={copy.prompt} value={draft} rows={2} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} /><div className="composer-bottom"><div className="row"><IconButton label="添加附件（演示）" icon="attach" onClick={() => setAttachment(!attachment)} /><Dropdown label="能力"><div className="dropdown-hint">按需选择工具、智能体与工作模式</div><button className="dropdown-item"><Icon name="tools" size={14} />工具</button><button className="dropdown-item"><Icon name="agents" size={14} />{agents[1].name}</button><button className="dropdown-item"><Icon name="work" size={14} />任务模式</button></Dropdown><ModelSelector /></div><Button variant="primary" icon="send" aria-label="发送消息" onClick={submit} disabled={!draft.trim()}>发送</Button></div></div>{attachment && <div className="attachment-note" role="status">附件入口演示：真实文件选择将在最终 UI 接入。</div>}<div className="composer-footnote">探索预览 · 内容与操作为演示数据</div></div>;
}
