import type {NeedsAttention, TaskEvent, TaskRepository} from '../../domain/task';
import {newId} from '../../shared/utils/id';

const attentionKinds = new Set<NeedsAttention['kind']>([
  'question.required',
  'approval.required',
  'task.blocked',
  'agent.needs_attention',
]);

export class EventLogRuntime {
  constructor(private readonly repository: TaskRepository) {}

  async append(event: TaskEvent): Promise<boolean> {
    const inserted = await this.repository.appendEvent(event);
    if (!inserted || !attentionKinds.has(event.type as NeedsAttention['kind'])) {
      return inserted;
    }
    const payload = event.payload ?? {};
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 200)
      : event.type;
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 2000) : undefined;
    await this.repository.upsertAttention({
      attentionId: event.eventId,
      taskId: event.taskId,
      kind: event.type as NeedsAttention['kind'],
      title,
      ...(summary ? {summary} : {}),
      status: 'pending',
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    });
    return true;
  }

  async appendGenerated(taskId: string, type: TaskEvent['type'], revision: number, payload: Record<string, unknown> = {}): Promise<boolean> {
    return this.append({
      eventId: newId('task-event'),
      taskId,
      type,
      revision,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  listNeedsAttention(taskId?: string): Promise<NeedsAttention[]> {
    return this.repository.listAttention(taskId);
  }

  resolveNeedsAttention(attentionId: string): Promise<void> {
    return this.repository.resolveAttention(attentionId);
  }
}
