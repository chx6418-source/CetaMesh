import { useRef, useState } from 'react';
import { Button, Textarea } from '../components/primitives/inputs';
import { Badge } from '../components/primitives/surfaces';
import type { ExperienceState, ExperienceConditions, ExperienceSnapshot, MemoryExperience } from '../bridge/typed-client';
export type { ExperienceState, ExperienceConditions, ExperienceReceipt, ExperienceSnapshot, MemoryExperience } from '../bridge/typed-client';
type Command = { id: string; expectedRev: number };
type Props = { id: string; revision: number; content: string; experience: MemoryExperience; disabled?: boolean;
  onTransition: (command: Command & { state: ExperienceState }) => void | Promise<void>;
  onRevise?: (command: Command & { content: string }) => void | Promise<void>;
  onRollback: (command: Command & { revision: number }) => void | Promise<void> };
type Pending = Command & ({ kind: 'transition'; state: ExperienceState } | { kind: 'revise'; content: string } | { kind: 'rollback'; snapshot: ExperienceSnapshot });
const stateName = (state: ExperienceState) => state === 'trial' ? '试用' : state === 'active' ? '采用中' : '已退役';
const date = (value: number) => Number.isFinite(value) ? new Date(value).toLocaleString() : '时间未知';

function Conditions({ value }: { value: ExperienceConditions }) {
  return <dl><dt>工作区</dt><dd><code>{value.workspaceId}</code></dd><dt>平台</dt><dd>{value.platform}</dd><dt>工具</dt><dd>{value.tool ?? '用户陈述，无机器校验条件'}</dd>
    {value.configDigest && <><dt>校验配置摘要</dt><dd><code>{value.configDigest}</code></dd></>}
    {value.sourceDigest && <><dt>工作区文件摘要</dt><dd><code>{value.sourceDigest}</code></dd></>}</dl>;
}

/** Owner review UI only. Source observations, scopes, revisions and writes stay
 * in the existing Memory service; this component never computes authority. */
export function MemoryExperienceDetails({ id, revision, content, experience, disabled = false, onTransition, onRevise, onRollback }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<{ id: string; revision: number; content: string } | null>(null);
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const busy = disabled || submitting;
  const stale = pending && (pending.id !== id || pending.expectedRev !== revision);
  const currentDraft = draft?.id === id ? draft : null;
  function review(action: Pending) { if (!busy) { setPending(action); setError(''); } }
  async function confirm() {
    if (!pending || busy || stale || lock.current) return;
    lock.current = true; setSubmitting(true); setError('');
    const command = pending;
    try {
      if (command.kind === 'transition') await onTransition({ id: command.id, expectedRev: command.expectedRev, state: command.state });
      else if (command.kind === 'rollback') await onRollback({ id: command.id, expectedRev: command.expectedRev, revision: command.snapshot.revision });
      else if (onRevise) await onRevise({ id: command.id, expectedRev: command.expectedRev, content: command.content });
      setPending(null); if (command.kind === 'revise') setDraft(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; setSubmitting(false); }
  }
  return <section className="memory-experience-details" aria-label="项目经验治理">
    <div className="memory-metadata"><Badge tone={experience.state === 'trial' ? 'warning' : 'default'}>{stateName(experience.state)}</Badge><Badge>条件参考</Badge><small>版本 {revision}</small></div>
    <p>Owner 批准保存的是有适用条件的经验参考。试用与采用状态均不授予工具权限，也不会安装可执行技能。</p>
    <details className="memory-source-detail"><summary>适用条件与来源证据</summary><Conditions value={experience.conditions}/>
      {experience.conditions.sourceDigest && <p>文件摘要覆盖当次工作区观察范围；外部依赖、账户与机器环境仍需分别核对。</p>}
      <dl><dt>来源 Task</dt><dd><code>{experience.trigger.taskId}</code></dd><dt>来源 Run</dt><dd><code>{experience.trigger.runId}</code></dd><dt>来源会话</dt><dd><code>{experience.trigger.sessionId}</code></dd>
        <dt>触发记录</dt><dd><code>{experience.trigger.id}</code></dd>{experience.trigger.ownerMessageId && <><dt>用户原话引用</dt><dd><code>{experience.trigger.ownerMessageId}</code></dd></>}</dl>
      {experience.evidence.length ? <ul>{experience.evidence.map(receipt => <li key={receipt.eventId}>{receipt.status === 'pass' ? '通过观察' : '失败观察'} · <code>{receipt.eventId}</code> · Run <code>{receipt.runId}</code> · {date(receipt.at)}</li>)}</ul> : <p>用户陈述，没有独立机器回执。</p>}
    </details>
    <details className="memory-source-detail"><summary>观察结果 · {experience.outcomes.length}</summary><p>这些是后续独立校验观察，无法据此认定经验造成了成功或失败；观察不会自动转正。</p>
      {experience.outcomes.length ? <ul>{experience.outcomes.map(receipt => <li key={receipt.eventId}>{receipt.status === 'pass' ? '通过观察' : '失败观察'} · Task <code>{receipt.taskId}</code> · <code>{receipt.eventId}</code> · {date(receipt.at)}</li>)}</ul> : <p>尚无后续观察。</p>}
      {experience.omittedOutcomes > 0 && <p>另有 {experience.omittedOutcomes} 条较早观察未在当前详情中展开。</p>}
      {experience.outcomes.length >= 8 && <p>当前行观察容量已满，新增结果保留在来源 Task，经验不会自行提升状态。</p>}
    </details>
    <div className="memory-actions">
      {experience.state === 'trial' && <Button compact disabled={busy} onClick={() => review({ kind: 'transition', id, expectedRev: revision, state: 'active' })}>审核采用</Button>}
      {experience.state === 'active' && <Button compact disabled={busy} onClick={() => review({ kind: 'transition', id, expectedRev: revision, state: 'trial' })}>改为试用</Button>}
      {experience.state === 'retired' ? <Button compact disabled={busy} onClick={() => review({ kind: 'transition', id, expectedRev: revision, state: 'trial' })}>重新试用</Button>
        : <Button compact variant="ghost" disabled={busy} onClick={() => review({ kind: 'transition', id, expectedRev: revision, state: 'retired' })}>退役经验</Button>}
      {onRevise && <Button compact variant="ghost" disabled={busy} onClick={() => setDraft({ id, revision, content })}>更正经验内容</Button>}
    </div>
    {currentDraft && <div className="memory-editor"><p>更正基于版本 {currentDraft.revision}；刷新不会替换草稿。</p><Textarea aria-label="更正经验内容" value={currentDraft.content} maxLength={4000} rows={4} disabled={busy}
      onChange={event => setDraft({ ...currentDraft, content: event.target.value })}/><div className="memory-actions"><Button compact disabled={busy} onClick={() => setDraft(null)}>取消经验草稿</Button>
      <Button compact disabled={busy || !currentDraft.content.trim()} onClick={() => review({ kind: 'revise', id: currentDraft.id, expectedRev: currentDraft.revision, content: currentDraft.content.trim() })}>预览经验更正</Button></div></div>}
    <details className="memory-source-detail"><summary>修订历史 · {experience.history.length}</summary>
      {experience.history.length ? experience.history.map(snapshot => <div className="memory-review-card" key={snapshot.revision}><p>版本 {snapshot.revision} · {stateName(snapshot.state)} · {date(snapshot.at)}</p><pre>{snapshot.content}</pre>
        <Button compact disabled={busy} onClick={() => review({ kind: 'rollback', id, expectedRev: revision, snapshot })}>预览回滚到版本 {snapshot.revision}</Button></div>) : <p>尚无可回滚的修订。</p>}
      {experience.omittedHistory > 0 && <p>较早的 {experience.omittedHistory} 次修订已超出本行四份历史容量；不可用版本不会被重建。</p>}
    </details>
    {pending && <section className="memory-editor" aria-label="经验操作预览"><h4>{pending.kind === 'transition' ? '预览经验状态变更' : pending.kind === 'rollback' ? '预览经验回滚' : '预览经验更正'}</h4>
      <p>记录 <code>{pending.id}</code> · 核对版本 {pending.expectedRev}</p>
      {pending.kind === 'transition' ? <><p>目标状态：{stateName(pending.state)}</p><p>{pending.state === 'retired' ? '保留内容与证据，停止自动召回。' : 'Core 将重新核对当前适用条件与来源。'}</p></>
        : pending.kind === 'rollback' ? <><p>恢复版本 {pending.snapshot.revision} 的内容、状态与条件，并新增当前修订；后续观察仍保留。</p><Badge>{stateName(pending.snapshot.state)}</Badge><pre>{pending.snapshot.content}</pre><Conditions value={pending.snapshot.conditions}/></>
          : <><p>将保存以下更正，保留当前条件与来源。</p><pre>{pending.content}</pre></>}
      {stale && <p role="alert">记录已更新；请关闭预览并重新核对当前版本。</p>}
      <div className="memory-actions"><Button compact disabled={submitting} onClick={() => setPending(null)}>取消经验操作</Button><Button compact variant="primary" disabled={busy || Boolean(stale)} onClick={() => void confirm()}>{submitting ? '正在保存经验…' : '确认经验操作'}</Button></div>
    </section>}
    {error && <p className="memory-feedback error" role="alert">{error}</p>}
  </section>;
}
