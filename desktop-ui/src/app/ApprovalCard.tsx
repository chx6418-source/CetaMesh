import { type Approval } from '../bridge/typed-client';
import { Icon } from '../components/icons';
import { Button } from '../components/primitives/inputs';
import { Badge, Card } from '../components/primitives/surfaces';
import { dateLabel } from './PagePresentation';

export function ApprovalCard({ approval, onDecide, onReuse, submitting = false, decisionAccepted = false, submissionError = null, retryDecision = null }: {
  approval: Approval; onDecide(id: string, approve: boolean): void; onReuse?(id:string):void;
  submitting?: boolean; decisionAccepted?: boolean; submissionError?: string | null; retryDecision?: boolean | null;
}) {
  const disabled = submitting || decisionAccepted;
  return <Card className="approval-card" aria-busy={submitting}><div className="approval-icon"><Icon name="approval" size={20} /></div><div className="grow"><div className="row between"><strong>{approval.title}</strong><Badge tone="warning">{submitting ? '正在提交' : decisionAccepted ? '审批已提交' : '需要处理'}</Badge></div><p>{approval.summary}</p>{approval.capability === 'agent.native.approve' && approval.details && <pre aria-label="原生工具参数" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '24rem', overflow: 'auto' }}>{approval.details}</pre>}<p>{approval.resources?.length ? "目标文件："+approval.resources.join("、") : ""}</p>{approval.expiresAt && <small>本次请求有效至 {dateLabel(approval.expiresAt)}</small>}<details><summary>权限详情</summary><span>{approval.capability} · 风险 {approval.risk}</span></details>{submissionError && <p role="alert">{submissionError}。提交结果尚未确认，可核对后重试同一决定。</p>}<div className="row approval-actions"><Button compact variant="ghost" disabled={disabled || retryDecision === true} onClick={() => onDecide(approval.id, false)}>{retryDecision === false ? '重试拒绝' : '拒绝'}</Button><Button compact variant="primary" disabled={disabled || retryDecision === false} onClick={() => onDecide(approval.id, true)}>{retryDecision === true ? '重试批准一次' : '批准一次'}</Button>{approval.reusableL2 && onReuse && <Button compact variant="ghost" disabled={disabled || retryDecision !== null} onClick={()=>onReuse(approval.id)}>批准，并在 15 分钟内复用最多 3 次</Button>}</div></div></Card>;
}
