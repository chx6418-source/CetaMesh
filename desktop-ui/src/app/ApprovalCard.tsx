import { type Approval } from '../bridge/typed-client';
import { Icon } from '../components/icons';
import { Button } from '../components/primitives/inputs';
import { Badge, Card } from '../components/primitives/surfaces';
import { dateLabel } from './PagePresentation';

export function ApprovalCard({ approval, onDecide, onReuse }: { approval: Approval; onDecide(id: string, approve: boolean): void; onReuse?(id:string):void }) {
  return <Card className="approval-card"><div className="approval-icon"><Icon name="approval" size={20} /></div><div className="grow"><div className="row between"><strong>{approval.title}</strong><Badge tone="warning">需要处理</Badge></div><p>{approval.summary}</p>{approval.capability === 'agent.native.approve' && approval.details && <pre aria-label="原生工具参数" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '24rem', overflow: 'auto' }}>{approval.details}</pre>}<p>{approval.resources?.length ? "目标文件："+approval.resources.join("、") : ""}</p>{approval.expiresAt && <small>本次请求有效至 {dateLabel(approval.expiresAt)}</small>}<details><summary>权限详情</summary><span>{approval.capability} · 风险 {approval.risk}</span></details><div className="row approval-actions"><Button compact variant="ghost" onClick={() => onDecide(approval.id, false)}>拒绝</Button><Button compact variant="primary" onClick={() => onDecide(approval.id, true)}>批准一次</Button>{approval.reusableL2 && onReuse && <Button compact variant="ghost" onClick={()=>onReuse(approval.id)}>批准，并在 15 分钟内复用最多 3 次</Button>}</div></div></Card>;
}
