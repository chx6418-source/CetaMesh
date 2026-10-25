import type {ExecutionRef} from '../../domain/task/ExecutionRef';
import type {Task, TaskInput, TaskPatch, TaskRepository} from '../../domain/task';
import {CetaError} from '../../shared/errors/CetaError';
import {EventLogRuntime} from '../event/EventLogRuntime';

export class TaskRuntime {
  constructor(
    private readonly repository: TaskRepository,
    private readonly events: EventLogRuntime,
  ) {}

  async create(input: TaskInput): Promise<Task> {
    const task = await this.repository.create(input);
    await this.events.appendGenerated(task.taskId, 'task.created', task.revision, {source: task.source});
    return task;
  }

  get(taskId: string): Promise<Task> {
    return this.repository.get(taskId);
  }

  list(limit?: number): Promise<Task[]> {
    return this.repository.list(limit);
  }

  async update(taskId: string, patch: TaskPatch, expectedRevision?: number): Promise<Task> {
    const current = await this.repository.get(taskId);
    const updated = await this.repository.update(taskId, patch, expectedRevision ?? current.revision);
    const executionBefore = current.providerExecutionRef;
    const executionAfter = updated.providerExecutionRef;
    if (patch.progress !== undefined || patch.phase !== undefined || patch.status !== undefined) {
      const type = patch.status === 'blocked' ? 'task.blocked' : patch.status === 'paused' ? 'task.paused' : patch.status === 'completed' ? 'task.completed' : patch.status === 'failed' ? 'task.failed' : patch.status === 'cancelled' ? 'task.cancelled' : patch.status === 'running' && current.status === 'paused' ? 'task.resumed' : patch.status === 'running' && current.status === 'queued' && patch.progress === undefined ? 'task.started' : 'task.progress';
      await this.events.appendGenerated(taskId, type, updated.revision, {progress: updated.progress, phase: updated.phase});
    }
    if (executionBefore?.providerId && executionAfter?.providerId && executionBefore.providerId !== executionAfter.providerId) {
      await this.events.appendGenerated(taskId, 'task.provider_changed', updated.revision, {providerId: executionAfter.providerId});
    }
    if (executionBefore?.sessionId && executionAfter?.sessionId && executionBefore.sessionId !== executionAfter.sessionId) {
      await this.events.appendGenerated(taskId, 'task.session_changed', updated.revision, {sessionId: executionAfter.sessionId});
    }
    return updated;
  }

  async switchExecution(taskId: string, execution: ExecutionRef): Promise<Task> {
    if (!execution.providerId.trim() || !execution.executionId.trim()) {
      throw new CetaError('invalid_protocol', 'ExecutionRef requires provider and execution ids');
    }
    return this.update(taskId, {providerExecutionRef: execution});
  }

  appendEvent(event: Parameters<EventLogRuntime['append']>[0]): Promise<boolean> {
    return this.events.append(event);
  }

  listNeedsAttention(taskId?: string) {
    return this.events.listNeedsAttention(taskId);
  }
}
