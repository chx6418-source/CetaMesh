import type {ExecutionRef} from './ExecutionRef';
import type {TaskEvent} from './TaskEvent';
import type {NeedsAttention} from './NeedsAttention';

export const TASK_STATUSES = ['queued', 'running', 'blocked', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskSource = 'mobile' | 'desktop-node' | 'server-node' | 'sync' | 'user';

export type Task = {
  readonly taskId: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly phase: string;
  readonly progress: number;
  readonly source: TaskSource;
  readonly workspaceRef?: string;
  readonly providerExecutionRef?: ExecutionRef;
  readonly checkpointRef?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TaskInput = {
  readonly taskId?: string;
  readonly goal: string;
  readonly source: TaskSource;
  readonly phase: string;
  readonly workspaceRef?: string;
  readonly providerExecutionRef?: ExecutionRef;
  readonly checkpointRef?: string;
};

export type TaskPatch = Partial<Pick<Task, 'goal' | 'status' | 'phase' | 'progress' | 'workspaceRef' | 'providerExecutionRef' | 'checkpointRef'>>;

export interface TaskRepository {
  create(input: TaskInput): Promise<Task>;
  get(taskId: string): Promise<Task>;
  list(limit?: number): Promise<Task[]>;
  update(taskId: string, patch: TaskPatch, expectedRevision: number): Promise<Task>;
  appendEvent(event: TaskEvent): Promise<boolean>;
  events(taskId: string): Promise<TaskEvent[]>;
  upsertAttention(attention: NeedsAttention): Promise<boolean>;
  listAttention(taskId?: string): Promise<NeedsAttention[]>;
  resolveAttention(attentionId: string): Promise<void>;
}
