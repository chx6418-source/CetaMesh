import type { ChatMessage, ModelUsage } from '../bridge/typed-client';
import { Icon } from '../components/icons';

const observationCount = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : '未知';
const requestChangeLabels: Record<string,string> = {'first-request':'首次请求','unknown':'对比证据不足','unchanged':'请求投影未变化',
  'provider-changed':'提供方变化','endpoint-changed':'服务端点变化','protocol-changed':'协议变化','model-changed':'请求模型变化',
  'response-model-changed':'响应模型变化','tools-changed':'工具目录变化','system-changed':'系统提示变化','history-changed':'历史内容变化',
  'parameters-changed':'请求参数变化','projection-changed':'序列化投影变化'};

export function UsageObservationDetails({usage}:{usage:ModelUsage|null|undefined}) {
  if (!usage) return null;
  const partial = ([['inputTokens','输入'],['outputTokens','输出'],['totalTokens','合计'],['cacheReadTokens','缓存读取'],['cacheWriteTokens','缓存写入']] as const)
    .filter(([field]) => usage[field] == null && usage.knownUsage?.[field] != null)
    .map(([field,label]) => `${label} ${observationCount(usage.knownUsage?.[field])}`);
  const coverage=usage.cacheCoverage, diagnostic=usage.requestDiagnostics;
  const snapshotCount=usage.requestCountKind==='snapshot-records';
  if (!partial.length && !coverage && !diagnostic && !snapshotCount) return null;
  return <div className="usage-observations">
    {snapshotCount&&<p>含历史用量快照；该范围无法还原真实请求数。</p>}
    {partial.length>0&&<p>{`已报告小计：${partial.join(' · ')}；尚有未报告用量，总量仍未知。`}</p>}
    {coverage&&<><p>{`缓存读取报告 ${coverage.read.reportedRequests} / ${coverage.totalRequests} 次请求 · 缓存写入报告 ${coverage.write.reportedRequests} / ${coverage.totalRequests} 次请求`}</p>
      <small>{`读取报告对应输入 ${observationCount(coverage.read.knownInputTokens)} Tokens · 已报告部分命中 ${coverage.read.reportedHitRate===null?'未知':`${Math.round(coverage.read.reportedHitRate*10000)/100}%`}；覆盖率表示报告情况。`}</small></>}
    {diagnostic&&<details className="chat-evidence-details"><summary>请求变化诊断</summary>
      <p>{diagnostic.changes.map(code=>requestChangeLabels[code]??'未知变化').join(' · ')||'对比证据不足'}</p>
      <p>本地请求变化不代表服务商缓存失效或实际节省。</p>
      {diagnostic.latest?<p>{`最近投影 ${diagnostic.latest.requestHash.slice(0,12)} · ${observationCount(diagnostic.latest.bodyBytes)} 字节 · ${observationCount(diagnostic.latest.messageCount)} 条消息 · ${observationCount(diagnostic.latest.toolCount)} 个工具`}</p>:<p>最近请求未提供可核对的投影记录。</p>}
      <small>{`已保留 ${diagnostic.retainedRequests} / ${diagnostic.totalRequests} 条观测 · 已裁剪 ${diagnostic.omittedRequests} · 未报告 ${diagnostic.unreportedRequests}；用量统计仍覆盖全部回执。`}</small>
    </details>}
  </div>;
}

export function UsageSummary({ usage, label = '本轮用量' }: { usage: ChatMessage['usage']; label?: string }) {
  if (!usage) return <small className="muted usage-summary">{label} 未知</small>;
  const count = (value: number | null) => value === null ? '未知' : String(value);
  const cost = usage.cost;
  const costLabel = cost?.amount != null && cost.currency && cost.complete ? `${cost.status === 'actual' ? '实际费用' : '估算费用'} ${cost.currency} ${cost.amount}` : `费用 未知${cost?.knownAmount != null && cost.currency ? `（已核算 ${cost.currency} ${cost.knownAmount}，不代表总费用）` : ''}`;
  const complete = usage.accountingComplete === false ? '已知用量（不完整）' : usage.accountingComplete === true ? '已核算' : '核算完整性未知';
  const rows = ['推理 ' + count(usage.reasoningTokens), '缓存读取 ' + count(usage.cacheReadTokens), '缓存写入 ' + count(usage.cacheWriteTokens), '缓存命中 ' + (usage.cacheHitRate === null ? '未知' : `${Math.round(usage.cacheHitRate * 10000) / 100}%`), '请求 ' + count(usage.requestCount), costLabel];
  return <details className="muted usage-summary usage-disclosure" aria-label={label}><summary><span>{label}</span><span>{'输入 ' + count(usage.inputTokens)}</span><span>{'输出 ' + count(usage.outputTokens)}</span><span className="usage-accounting">{complete}</span><Icon name="down" size={12} /></summary><div className="usage-detail-grid">{rows.map(row => <span key={row}>{row}</span>)}</div><UsageObservationDetails usage={usage}/></details>;
}
