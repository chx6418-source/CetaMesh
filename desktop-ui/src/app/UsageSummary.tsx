import type { ChatMessage } from '../bridge/typed-client';
import { Icon } from '../components/icons';

export function UsageSummary({ usage, label = '本轮用量' }: { usage: ChatMessage['usage']; label?: string }) {
  if (!usage) return <small className="muted usage-summary">{label} 未知</small>;
  const count = (value: number | null) => value === null ? '未知' : String(value);
  const cost = usage.cost;
  const costLabel = cost?.amount != null && cost.currency && cost.complete ? `${cost.status === 'actual' ? '实际费用' : '估算费用'} ${cost.currency} ${cost.amount}` : `费用 未知${cost?.knownAmount != null && cost.currency ? `（已核算 ${cost.currency} ${cost.knownAmount}，不代表总费用）` : ''}`;
  const complete = usage.accountingComplete === false ? '已知用量（不完整）' : usage.accountingComplete === true ? '已核算' : '核算完整性未知';
  const rows = ['推理 ' + count(usage.reasoningTokens), '缓存读取 ' + count(usage.cacheReadTokens), '缓存写入 ' + count(usage.cacheWriteTokens), '缓存命中 ' + (usage.cacheHitRate === null ? '未知' : `${Math.round(usage.cacheHitRate * 10000) / 100}%`), '请求 ' + count(usage.requestCount), costLabel];
  return <details className="muted usage-summary usage-disclosure" aria-label={label}><summary><span>{label}</span><span>{'输入 ' + count(usage.inputTokens)}</span><span>{'输出 ' + count(usage.outputTokens)}</span><span className="usage-accounting">{complete}</span><Icon name="down" size={12} /></summary><div className="usage-detail-grid">{rows.map(row => <span key={row}>{row}</span>)}</div></details>;
}
