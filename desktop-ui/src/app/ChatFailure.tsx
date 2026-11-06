import type { ChatFailureDetails, ChatMessage } from '../bridge/typed-client';
import { Button } from '../components/primitives/inputs';
import { DiagnosticsEntry } from './StartupDiagnostics';

export type ChatFailure = {
  error?: string | null;
  errorCode?: string | null;
  errorDetails?: ChatFailureDetails | null;
  failureStage?: 'pre-dispatch' | 'execution' | 'unknown' | null;
  requestId?: string | null;
  routing?: Record<string, unknown>;
};

const safeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;
export function chatFailureTaskId(failure: ChatFailure, fallback?: string | null) {
  return safeId(failure.routing?.blockingTaskId) || safeId(failure.routing?.taskId) || safeId(fallback);
}

export function chatFailureInHistory(failure: ChatFailure, messages: ChatMessage[]) {
  if (!failure.error) return false;
  if (failure.requestId) return messages.some(message => Boolean(message.error) && message.requestId === failure.requestId
    && (!failure.errorCode || !message.errorCode || message.errorCode === failure.errorCode));
  const last = messages.at(-1);
  return Boolean(last?.error && last.error === failure.error && (!failure.errorCode || last.errorCode === failure.errorCode));
}

const recoveryCodes = new Set(['NEEDS_RECONCILIATION', 'OUTCOME_UNKNOWN', 'REQUEST_RECOVERY_REQUIRED', 'INVOKE_CANCEL_UNCONFIRMED', 'TASK_EFFECT_UNCONFIRMED', 'SESSION_TRANSPORT_UNKNOWN', 'SESSION_EXECUTION_UNCONFIRMED', 'SESSION_NOT_FOUND', 'TASK_RECOVERY_REVIEW_REQUIRED', 'TASK_DISPATCH_INCOMPLETE', 'TASK_NOT_RUNNING']);
const approvalCodes = new Set(['APPROVAL_PENDING', 'APPROVAL_REJECTED', 'APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_REQUIRED', 'AGENT_SECURITY_CONFIRMATION_REQUIRED']);
const providerCodes = new Set(['PROVIDER_UNAVAILABLE', 'MODEL_PROVIDER_UNAVAILABLE', 'DSH_UNAVAILABLE', 'CODEX_SANDBOX_UNAVAILABLE', 'AGENT_BOUNDARY_UNSUPPORTED', 'AGENT_PROVIDER_SELECTION_REQUIRED']);
const legacyRecovery: Record<ChatFailureDetails['recoveryCode'], { title: string; detail: string }> = {
  CODEX_HOST_RESTART_REQUIRED: { title: '需要重启 Windows 一次', detail: '程序已记录本次系统启动。请保存工作后使用 Windows“重启”。重新打开程序后，程序会自动核验并释放符合恢复条件的旧占用；需要执行时再发送新指令。原消息不会自动执行。' },
  CODEX_LEGACY_STOP_EVIDENCE_MISSING: { title: '旧执行停止证据不足', detail: '程序尚未取得旧执行的有效停止证据，工作区占用会保留。请查看诊断；证据可用后，打开任务时程序会自动核验。原消息不会自动执行。' },
  CODEX_HOST_RESTART_UNVERIFIED: { title: '系统启动信息尚未验证', detail: '程序无法确认系统是否已完整重启，工作区占用会保留。请查看诊断；启动信息可读后，打开任务时程序会自动核验。原消息不会自动执行。' }
};

function recoveryCodeOf(failure: ChatFailure) {
  const code = failure.errorDetails?.recoveryCode;
  return code && Object.hasOwn(legacyRecovery, code) ? code : null;
}

export function chatFailurePresentation(failure: ChatFailure) {
  const code = failure.errorCode ?? '';
  const recoveryCode = recoveryCodeOf(failure);
  if (recoveryCode && ['TASK_WORKSPACE_BUSY', 'SESSION_EXECUTION_UNCONFIRMED'].includes(code)) return { ...legacyRecovery[recoveryCode], gated: true };
  if (code === 'TASK_WORKSPACE_BUSY') return { title: '工作区正在被其他任务占用', detail: '查看占用任务时，程序会自动核验已停止的旧执行，满足条件后释放占用；若任务仍在执行，请等待结束。原消息已保留，不会自动执行。', gated: true };
  if (approvalCodes.has(code)) return { title: code === 'APPROVAL_PENDING' ? '等待你审批' : '操作需要审批处理', detail: '在待审批操作中核对本次请求；拒绝或过期的审批不会自动重发或重新执行。', gated: true };
  if (recoveryCodes.has(code)) return { title: code === 'SESSION_NOT_FOUND' ? '旧执行会话已失效' : '任务暂时无法继续', detail: '打开任务时，程序会自动核验恢复条件。活动执行、待审批或未知结果仍会阻止继续；原请求不会自动重放。', gated: true };
  if (providerCodes.has(code)) return { title: '执行者暂不可用', detail: '通过诊断检查连接与执行条件；修复后重新检查。已有任务请先查看任务当前状态。', gated: false };
  if (failure.failureStage === 'pre-dispatch') return { title: '请求在派发前被阻止', detail: '核对所选执行者、工作区和授权条件后，再重新提交。原消息仍保留。', gated: false };
  if (failure.failureStage === 'execution') return { title: '本轮执行未能完成', detail: '先查看已有输出、工具记录和任务状态，再决定下一步；失败不表示已撤销之前的操作。', gated: true };
  return { title: '请求结果尚未确认', detail: '先查看诊断和任务状态。当前无法确认执行结果，不能直接重发旧操作。', gated: true };
}

export function ChatFailureCard({ failure, taskId, onOpenTask, onRetry, retrying = false, onNewChat }: {
  failure: ChatFailure; taskId?: string | null; onOpenTask?(id: string): void;
  onRetry?(): void; retrying?: boolean; onNewChat?(): void;
}) {
  const target = chatFailureTaskId(failure, taskId), view = chatFailurePresentation(failure);
  const code = typeof failure.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(failure.errorCode) ? failure.errorCode : 'UNKNOWN_ERROR';
  const requestId = safeId(failure.requestId);
  const recoveryCode = recoveryCodeOf(failure);
  const mayRetry = Boolean(onRetry && failure.failureStage === 'pre-dispatch' && !view.gated && !target);
  return <section className="turn-error chat-failure-card" role="alert" aria-label="请求处理提示">
    <strong>{view.title}</strong>
    {failure.failureStage === 'pre-dispatch' && <p>本次请求尚未开始执行。</p>}
    <p>{view.detail}</p>
    <div className="row">
      {target && onOpenTask && <Button compact variant="ghost" onClick={() => onOpenTask(target)}>{failure.routing?.blockingTaskId === target ? '查看占用任务' : '查看任务'}</Button>}
      {mayRetry && <Button compact variant="ghost" disabled={retrying} onClick={onRetry}>{retrying ? '正在提交…' : '重新提交'}</Button>}
      <DiagnosticsEntry label="诊断" />
      {onNewChat && <Button compact variant="ghost" onClick={onNewChat}>新建普通聊天</Button>}
    </div>
    <details className="chat-failure-diagnostics"><summary>诊断详情</summary><dl>
      <dt>错误代码</dt><dd><code>{code}</code></dd>
      {recoveryCode && <><dt>恢复原因</dt><dd><code>{recoveryCode}</code></dd></>}
      {target && <><dt>Task ID</dt><dd><code>{target}</code></dd></>}
      {requestId && <><dt>Request ID</dt><dd><code>{requestId}</code></dd></>}
      <dt>执行阶段</dt><dd>{failure.failureStage === 'pre-dispatch' ? '派发前阻断' : failure.failureStage === 'execution' ? '执行中失败' : '尚未确认'}</dd>
    </dl></details>
  </section>;
}
