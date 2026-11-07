import { Button } from '../components/primitives/inputs';
import { Badge } from '../components/primitives/surfaces';

import type { ChildTaskResultFacts } from '../bridge/typed-client';
export type { ChildTaskReadFact, ChildTaskResultFacts } from '../bridge/typed-client';

export type ChildTaskResultsProps = { results: readonly ChildTaskResultFacts[]; onOpenChild?: (id: string) => void | Promise<void> };

const taskStatus: Record<string, string> = { queued: '待开始', running: '执行中', waiting: '等待中', paused: '已暂停',
  blocked: '需要核对', completed: '已结束', failed: '失败', cancelled: '已停止' };
const attemptStatus: Record<string, string> = { started: '正在执行', accepted: '后台执行中', completed: '回合已结束',
  failed: '回合失败', cancelled: '已停止', unknown: '结果未知', reviewed: '原尝试已核对' };
const receiptStatus: Record<string, string> = { completed: '收到完成回执', failed: '收到失败回执', denied: '调用被拒绝',
  cancelled: '收到停止回执', 'outcome-unknown': '结果未知', unknown: '结果未知' };
const reasons: Record<string, string> = {
  TASK_CHILD_PARENT_CHANGED: '父任务目标已变化', TASK_PARENT_UNAVAILABLE: '父任务目前不可接收该结果', CHILD_SUPERSEDED: '已有后续子任务',
  ATTEMPT_NOT_STARTED: '尚未记录执行尝试', ATTEMPT_OUTCOME_UNKNOWN: '原执行尝试结果未知', ATTEMPT_NOT_SETTLED: '执行尝试尚未确认结束',
  CURRENT_RUN_CHANGED: '当前回合归属已变化', CURRENT_RUN_UNAVAILABLE: '当前回合归属尚未确认', CURRENT_EXECUTION_NOT_SETTLED: '当前执行未正常结束',
  OUTCOME_UNKNOWN: '存在尚待核对的执行结果', NATIVE_OBSERVATION_UNVERIFIED: '原生观察尚未独立核验', READ_ONLY_EFFECT_OBSERVATION: '出现只读合同以外的执行观察',
  CHILD_CONTRACT_UNSUPPORTED: '合同范围尚未确认', CHILD_NOT_COMPLETED: '子任务尚未结束', CURRENT_REPORT_UNAVAILABLE: '本轮分析报告来源尚未确认',
  CHILD_VERIFICATION_REQUIRED: '合同证据待核验', VERIFICATION_REV_CHANGED: '子任务在核验后发生变化', CURRENT_SOURCE_EVIDENCE_MISSING: '当前来源证据缺失或不可用',
  LATEST_TOOL_RESULT_UNVERIFIED: '最近必需的工具结果未核验', LATEST_SOURCE_RESULT_UNVERIFIED: '最近来源读取未成功',
  VERIFICATION_REASONS_PRESENT: '已存核验仍有未解决项', PROJECTION_IDENTITY_OMITTED: '本次摘录未包含完整来源归属'
};
const nextSteps: Record<string, string> = {
  REVIEW_ORIGINAL_ATTEMPT_WITHOUT_REPLAY: '先核对原执行尝试与回执，再决定后续工作', CONTINUE_WITH_FRESH_SESSION: '使用既有恢复流程建立新的会话继续',
  REVIEW_PARENT_OBJECTIVE_AND_CREATE_FRESH_CHILD: '核对父任务新目标后再发起新的子任务', OPEN_SUPERSEDING_CHILD: '查看已有的后续子任务',
  FOLLOW_OR_CANCEL_EXISTING_CHILD: '继续查看现有执行；停止操作使用既有任务控制', CREATE_FRESH_SUPERSEDING_CHILD: '核对已结束的尝试后创建后续子任务',
  OWNER_REVIEW_CURRENT_ANALYSIS_SOURCES: '由 Owner 核对本轮分析和来源', VERIFY_CURRENT_CHILD_EVIDENCE: '通过现有入口核对当前子任务证据',
  OPEN_CHILD_RECORD: '打开子任务查看完整记录'
};

function References({ ids }: { ids: readonly string[] }) {
  return ids.length ? <ul>{ids.map(id => <li key={id}><code>{id}</code></li>)}</ul> : <p className="muted">当前摘录没有来源标识。</p>;
}

/** Presentation only. Task/Attempt/Broker and Owner review retain authority. */
export function ChildTaskResults({ results, onOpenChild }: ChildTaskResultsProps) {
  if (!results.length) return <p className="muted">暂无结构化子任务结果。</p>;
  return <section aria-label="子任务结构化结果">{results.map(row => <article className="task-child-summary" key={row.childId}>
    <div className="task-child-heading">
      {onOpenChild ? <Button compact variant="ghost" onClick={() => onOpenChild(row.childId)}>{row.goal ?? row.childId}</Button> : <strong>{row.goal ?? row.childId}</strong>}
      <Badge>{taskStatus[row.status] ?? '状态未知'}</Badge>
      <Badge tone={row.verification.current && row.verification.status === 'VERIFIED' ? 'success' : 'warning'}>
        {row.verification.current && row.verification.status === 'VERIFIED' ? '当前合同证据已核验' : '当前合同证据待核验'}
      </Badge>
    </div>
    <p>{row.hostFacts.readOnly ? '只读合同：文件读取与搜索' : '合同范围待核对'} · {row.attempt ? attemptStatus[row.attempt.state] ?? '尝试状态未知' : '尚未记录执行尝试'}</p>
    {!row.verification.current && row.verification.status === 'VERIFIED' && <p className="muted">已存核验记录保留，当前来源已变化或尚未确认。</p>}
    {row.supersededBy && <p>已有后续子任务：{onOpenChild ? <Button compact variant="ghost" onClick={() => onOpenChild(row.supersededBy!)}>查看后续记录</Button> : <code>{row.supersededBy}</code>}</p>}
    <details className="task-advanced"><summary>执行者报告与发现</summary>
      <h4>执行者报告 · 自述</h4>
      {row.report ? <><p>{row.report.summary ?? row.report.text}</p>
        <details><summary>报告原文摘录</summary><pre>{row.report.text}</pre>{row.report.truncated && <p>报告原文已截取。</p>}<code>{row.report.eventId}</code></details>
        {row.report.claimedFilesChanged.length > 0 && <><h4>自述修改文件 · 未独立核验</h4><ul>{row.report.claimedFilesChanged.map((file, index) => <li key={index}>{file}</li>)}</ul></>}
        {row.report.claimedCommands.length > 0 && <><h4>自述命令 · 未独立核验</h4><ul>{row.report.claimedCommands.map((command, index) => <li key={index}>{command}</li>)}</ul></>}
        {row.report.claimedRemaining.length > 0 && <><h4>执行者自述后续事项</h4><ul>{row.report.claimedRemaining.map((claim, index) => <li key={index}>{claim}</li>)}</ul></>}
      </> : <p className="muted">本次摘录没有可归属当前尝试的最终报告。</p>}
      {row.findings.length > 0 && <><h4>执行者发现 · 未独立核验</h4><ul>{row.findings.map((finding, index) => <li key={index}><p>{finding.text}</p>
        {finding.evidenceEventIds.length > 0 && <References ids={finding.evidenceEventIds}/>}
        {finding.missingEvidenceIds.length > 0 && <p>部分自述引用未找到当前来源证据。</p>}</li>)}</ul></>}
    </details>
    <details className="task-advanced"><summary>宿主观察 · {row.hostFacts.coverage === 'complete' ? '已列出观察' : row.hostFacts.coverage === 'partial' ? '部分来源信息' : '暂无当前观察'}</summary>
      <h4>文件读取回执</h4>
      {row.hostFacts.reads.length ? <ul>{row.hostFacts.reads.map(read => <li key={read.eventId}>
        <p>{read.capability === 'filesystem.search' ? '文件搜索' : '文件读取'} · {receiptStatus[read.status] ?? '观察状态未知'} · {read.path ?? '读取路径未留存'}</p>
        {read.provenance === 'native-observation' && <p>原生观察 · 未独立核验</p>}<code>{read.eventId}</code>
      </li>)}</ul> : <p className="muted">当前摘录没有读取回执。</p>}
      <p>受控命令回执 {row.hostFacts.commands.length} · 文件写入回执 {row.hostFacts.writes.length}</p>
      {row.hostFacts.artifacts.length > 0 && <><h4>Task 产物记录</h4><ul>{row.hostFacts.artifacts.map(artifact => <li key={artifact.id}>
        {artifact.label ?? artifact.id}{artifact.ref && <> · {artifact.ref}</>} · {artifact.current ? '有关联的当前观察' : '当前来源归属未确认'} · 文件结果待独立核验
      </li>)}</ul></>}
      {row.hostFacts.observations.length > 0 && <><h4>其他执行观察 · 未独立核验</h4><ul>{row.hostFacts.observations.map(observation => <li key={observation.eventId}>
        {observation.capability} · {receiptStatus[observation.status] ?? '观察状态未知'} · <code>{observation.eventId}</code>
      </li>)}</ul></>}
    </details>
    {row.remaining.blockers.length > 0 && <div><h4>待核对事项</h4><ul>{row.remaining.blockers.map(code => <li key={code}>{reasons[code] ?? '来源或结果需要进一步核对'}</li>)}</ul></div>}
    {row.remaining.nextSteps.length > 0 && <div><h4>后续步骤</h4><ul>{row.remaining.nextSteps.map(code => <li key={code}>{nextSteps[code] ?? '打开子任务查看完整状态'}</li>)}</ul></div>}
    <details className="task-advanced"><summary>来源与核验记录</summary>
      <p>子任务修订 {row.taskRev ?? '未知'} · 已存核验修订 {row.verification.verificationRev ?? '未知'}</p>
      {row.attempt && <dl><dt>执行者</dt><dd>{row.attempt.provider}</dd><dt>会话</dt><dd><code>{row.attempt.sessionId}</code></dd><dt>回合</dt><dd><code>{row.attempt.runId}</code></dd>
        <dt>来源绑定</dt><dd>{row.attempt.binding === 'current-run' ? '当前回合' : row.attempt.binding === 'attempt-only' ? '仅有尝试记录' : '尚未确认'}</dd></dl>}
      <References ids={row.verification.evidenceEventIds}/>
      {Object.values(row.omitted).some(count => count > 0) && <p>当前详情为有界摘录，完整记录保留在子任务中。</p>}
    </details>
  </article>)}</section>;
}
