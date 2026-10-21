export const PUSH_EVENT_KINDS = [
  'approval.required',
  'question.required',
  'task.blocked',
  'task.updated',
  'security.event',
  'sync.required',
] as const;

export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

export type PushAttentionPayload = {
  readonly kind: PushEventKind;
  readonly taskId?: string;
  readonly attentionId?: string;
  readonly eventId?: string;
};
