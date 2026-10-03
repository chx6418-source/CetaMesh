import type {CapabilityAuditEvent, CapabilityAuditSink} from '../../domain/capability/CapabilityAudit';
import type {Approval, NeedsAttention} from '../../domain/task';
import type {ApprovalRuntime} from '../task/ApprovalRuntime';
import type {TaskRuntime} from '../task/TaskRuntime';

export type ActionCenterItem = {
  readonly actionId: string;
  readonly kind: 'approval' | 'question' | 'blocked' | 'completed' | 'security';
  readonly taskId?: string;
  readonly title: string;
  readonly summary?: string;
  readonly createdAt?: string;
};

type AuditLog = CapabilityAuditSink & {list?: () => readonly CapabilityAuditEvent[]};

function attentionItem(item: NeedsAttention): ActionCenterItem {
  return {
    actionId: `attention:${item.attentionId}`,
    kind: item.kind === 'question.required' ? 'question' : item.kind === 'task.blocked' ? 'blocked' : 'approval',
    taskId: item.taskId,
    title: item.title,
    ...(item.summary ? {summary: item.summary} : {}),
    createdAt: item.createdAt,
  };
}

function approvalItem(item: Approval): ActionCenterItem {
  return {actionId: `approval:${item.approvalId}`, kind: 'approval', taskId: item.taskId, title: item.capability, summary: item.reason, createdAt: item.createdAt};
}

export class ActionCenterRuntime {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly approvals: ApprovalRuntime,
    private readonly audit?: AuditLog,
  ) {}

  async list(): Promise<ActionCenterItem[]> {
    const [attention, approvals, tasks] = await Promise.all([
      this.tasks.listNeedsAttention(),
      this.approvals.listPending(),
      this.tasks.list(),
    ]);
    const items: ActionCenterItem[] = [
      ...approvals.map(approvalItem),
      ...attention.map(attentionItem),
      ...tasks.filter(task => task.status === 'completed').map(task => ({actionId: `task:${task.taskId}:completed`, kind: 'completed' as const, taskId: task.taskId, title: task.goal, createdAt: task.updatedAt})),
      ...(this.audit?.list?.() ?? []).filter(event => event.type === 'denied' || event.type === 'failed').map(event => ({actionId: `security:${event.eventId}`, kind: 'security' as const, title: 'Capability security event', summary: event.errorCode ?? event.capability})),
    ];
    const seen = new Set<string>();
    const priority = {approval: 0, question: 1, blocked: 2, completed: 3, security: 4};
    return items.filter(item => {
      if (seen.has(item.actionId)) { return false; }
      seen.add(item.actionId);
      return true;
    }).sort((left, right) => priority[left.kind] - priority[right.kind] || (left.actionId < right.actionId ? -1 : 1));
  }
}
