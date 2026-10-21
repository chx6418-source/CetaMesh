export const TASK_EVENT_TYPES = [
  'task.created',
  'task.started',
  'task.progress',
  'task.blocked',
  'task.paused',
  'task.resumed',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.provider_changed',
  'task.session_changed',
  'question.required',
  'approval.required',
  'agent.needs_attention',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export type TaskEvent = {
  readonly eventId: string;
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly revision: number;
  readonly payload?: Record<string, unknown>;
  readonly createdAt: string;
};
