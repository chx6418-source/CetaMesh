import type { ApprovalDecisionResult, feedbackClient } from '../bridge/typed-client';
import { useState } from 'react';
import { Icon } from '../components/icons';
import { Button } from '../components/primitives/inputs';

const operationLabels = { accepted: '已接受', running: '执行中', waiting: '等待后续审批', completed: '已完成', failed: '失败', cancelled: '已确认取消', unknown: '结果未知，需核验', rejected: '已拒绝' };
const historical = (operation: ApprovalDecisionResult) => ['completed', 'cancelled', 'rejected'].includes(operation.status);
export const approvalOperationsNeedingAttention = (operations: ApprovalDecisionResult[]) => operations.filter(operation => !historical(operation));

export function ApprovalOperationSummary({ operations, onCancel }: { operations: ApprovalDecisionResult[]; onCancel(id: string): void }) {
  const [attentionLimit, setAttentionLimit] = useState(40);
  const [historyLimit, setHistoryLimit] = useState(40);
  if (!operations.length) return null;
  const attention = approvalOperationsNeedingAttention(operations);
  const history = operations.filter(historical);
  const rows = (items: ApprovalDecisionResult[], limit: number, more: () => void) => <>{items.slice(-limit).map((operation, index) => <div className="approval-operation-row" key={operation.operationId ?? operation.approvalId ?? index}>
    <span className="approval-operation-copy"><strong>{operation.decision === 'rejected' ? '拒绝审批' : '批准操作'}</strong><small>{operation.operationId || operation.approvalId || '审批操作'}{operation.code || operation.resumeError ? ` · ${operation.code || operation.resumeError}` : ''}</small></span>
    <span className={`approval-operation-status status-${operation.status}`}>{operationLabels[operation.status]}</span>
    {['accepted', 'running'].includes(operation.status) && operation.operationId && <Button compact onClick={() => onCancel(operation.operationId!)}>请求停止</Button>}
  </div>)}{items.length > limit && <Button compact variant="ghost" onClick={more}>{`再显示${Math.min(40,items.length-limit)}项（其余 ${items.length-limit} 项）`}</Button>}</>;
  return <section className="plugin-approval-inbox operation-summary" aria-label="审批操作状态">
    {attention.length > 0 && <div className="approval-attention"><h2>操作状态 · {attention.length}</h2>{rows(attention,attentionLimit,()=>setAttentionLimit(limit=>limit+40))}</div>}
    {history.length > 0 && <details className="approval-operation-history"><summary>历史操作 · {history.length}<span>展开查看</span></summary><div className="approval-operation-history-list">{rows(history,historyLimit,()=>setHistoryLimit(limit=>limit+40))}</div></details>}
  </section>;
}

type FeedbackEntry = Awaited<ReturnType<typeof feedbackClient.links>>['entries'][number];
export function FeedbackLinkRow({ entry, message, onVisit }: { entry: FeedbackEntry; message?: string; onVisit(url: string | null): void }) {
  let destination = message || '暂未配置';
  if (entry.url?.startsWith('https://')) {
    try { destination = new URL(entry.url).host; }
    catch { /* Invalid configured URLs stay disabled and keep the fallback label. */ }
  }
  const enabled = Boolean(entry.url?.startsWith('https://') && URL.canParse(entry.url));
  return <button className="about-link-row feedback-link-row" disabled={!enabled} onClick={() => onVisit(entry.url)}>
    <Icon name={entry.kind === 'security' ? 'approval' : 'globe'} size={18} />
    <span className="about-link-copy"><strong>{entry.label}</strong><small className="feedback-description">{entry.description}</small></span>
    <small className="feedback-destination">{destination}</small><Icon name="right" size={15} />
  </button>;
}
