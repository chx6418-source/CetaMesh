export type NeedsAttentionKind = 'question.required' | 'approval.required' | 'task.blocked' | 'agent.needs_attention';
export type NeedsAttentionStatus = 'pending' | 'resolved';

export type NeedsAttention = {
  readonly attentionId: string;
  readonly taskId: string;
  readonly kind: NeedsAttentionKind;
  readonly title: string;
  readonly summary?: string;
  readonly status: NeedsAttentionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};
