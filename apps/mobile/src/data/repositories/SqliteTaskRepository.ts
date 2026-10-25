import type {
  NeedsAttention,
  Task,
  TaskEvent,
  TaskInput,
  TaskPatch,
  TaskRepository,
} from '../../domain/task';
import {CetaError} from '../../shared/errors/CetaError';
import {newId} from '../../shared/utils/id';
import {iso, identifier} from '../../protocol/PairingProtocol';
import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';

type Row = Record<string, SqliteValue>;

function json(value: unknown, max: number, message: string): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CetaError('invalid_protocol', message);
  }
  if (encoded.length > max) {
    throw new CetaError('invalid_protocol', message);
  }
  return encoded;
}

function task(row: Row): Task {
  return {
    taskId: identifier(row.task_id),
    goal: String(row.goal),
    status: row.status as Task['status'],
    phase: String(row.phase),
    progress: Number(row.progress),
    source: row.source as Task['source'],
    ...(row.workspace_ref === null ? {} : {workspaceRef: String(row.workspace_ref)}),
    ...(row.provider_execution_ref === null ? {} : {providerExecutionRef: JSON.parse(String(row.provider_execution_ref))}),
    ...(row.checkpoint_ref === null ? {} : {checkpointRef: String(row.checkpoint_ref)}),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function event(row: Row): TaskEvent {
  const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
  return {
    eventId: identifier(row.event_id),
    taskId: identifier(row.task_id),
    type: row.type as TaskEvent['type'],
    revision: Number(row.revision),
    ...(Object.keys(payload).length ? {payload} : {}),
    createdAt: iso(row.created_at),
  };
}

function attention(row: Row): NeedsAttention {
  return {
    attentionId: identifier(row.attention_id),
    taskId: identifier(row.task_id),
    kind: row.kind as NeedsAttention['kind'],
    title: String(row.title),
    ...(row.summary === null ? {} : {summary: String(row.summary)}),
    status: row.status as NeedsAttention['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function boundedLimit(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CetaError('invalid_protocol', 'Task page limit must be 1–200');
  }
  return limit;
}

export class SqliteTaskRepository implements TaskRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof CetaError
        ? error
        : new CetaError('storage_error', 'Task storage operation failed');
    }
  }

  private async getRaw(db: SqliteConnection, taskId: string): Promise<Task> {
    identifier(taskId);
    const row = (await db.executeAsync('SELECT * FROM tasks WHERE task_id=?', [taskId])).results[0];
    if (!row) {
      throw new CetaError('storage_error', 'Task not found');
    }
    return task(row);
  }

  async create(input: TaskInput): Promise<Task> {
    const taskId = input.taskId ?? newId('task');
    identifier(taskId);
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 4000 || typeof input.phase !== 'string' || !input.phase.trim() || input.phase.length > 100) {
      throw new CetaError('invalid_protocol', 'Invalid Task goal or phase');
    }
    const now = new Date().toISOString();
    return this.safe(async () => {
      await this.db.executeAsync(
        'INSERT INTO tasks(task_id,goal,status,phase,progress,source,workspace_ref,provider_execution_ref,checkpoint_ref,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          taskId,
          input.goal.trim(),
          'queued',
          input.phase.trim(),
          0,
          input.source,
          input.workspaceRef ?? null,
          input.providerExecutionRef ? json(input.providerExecutionRef, 16_384, 'Invalid ExecutionRef') : null,
          input.checkpointRef ?? null,
          1,
          now,
          now,
        ],
      );
      return this.getRaw(this.db, taskId);
    });
  }

  get(taskId: string): Promise<Task> {
    return this.safe(() => this.getRaw(this.db, taskId));
  }

  list(limit = 100): Promise<Task[]> {
    return this.safe(async () =>
      (await this.db.executeAsync('SELECT * FROM tasks ORDER BY updated_at DESC,task_id DESC LIMIT ?', [boundedLimit(limit)])).results.map(task),
    );
  }

  async update(taskId: string, patch: TaskPatch, expectedRevision: number): Promise<Task> {
    identifier(taskId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new CetaError('sync_conflict', 'Invalid Task revision');
    }
    return this.safe(() => this.db.transaction(async tx => {
      const current = await this.getRaw(tx, taskId);
      if (current.revision !== expectedRevision) {
        throw new CetaError('sync_conflict', 'Task revision is stale');
      }
      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
        revision: current.revision + 1,
      };
      if (typeof next.goal !== 'string' || !next.goal.trim() || next.goal.length > 4000 || typeof next.phase !== 'string' || !next.phase.trim() || next.phase.length > 100 || !Number.isFinite(next.progress) || next.progress < 0 || next.progress > 1) {
        throw new CetaError('invalid_protocol', 'Invalid Task update');
      }
      await tx.executeAsync(
        'UPDATE tasks SET goal=?,status=?,phase=?,progress=?,source=?,workspace_ref=?,provider_execution_ref=?,checkpoint_ref=?,revision=?,updated_at=? WHERE task_id=? AND revision=?',
        [
          next.goal.trim(),
          next.status,
          next.phase.trim(),
          next.progress,
          next.source,
          next.workspaceRef ?? null,
          next.providerExecutionRef ? json(next.providerExecutionRef, 16_384, 'Invalid ExecutionRef') : null,
          next.checkpointRef ?? null,
          next.revision,
          next.updatedAt,
          taskId,
          expectedRevision,
        ],
      );
      return this.getRaw(tx, taskId);
    }));
  }

  async appendEvent(value: TaskEvent): Promise<boolean> {
    identifier(value.eventId);
    identifier(value.taskId);
    if (!Number.isInteger(value.revision) || value.revision < 1) {
      throw new CetaError('invalid_protocol', 'Invalid Task event revision');
    }
    const payload = json(value.payload ?? {}, 65_536, 'Task event payload is too large');
    iso(value.createdAt);
    return this.safe(() => this.db.transaction(async tx => {
      await this.getRaw(tx, value.taskId);
      const existing = await tx.executeAsync('SELECT event_id FROM task_events WHERE event_id=?', [value.eventId]);
      if (existing.results.length) {
        return false;
      }
      await tx.executeAsync(
        'INSERT INTO task_events(event_id,task_id,type,revision,payload,created_at) VALUES(?,?,?,?,?,?)',
        [value.eventId, value.taskId, value.type, value.revision, payload, value.createdAt],
      );
      return true;
    }));
  }

  events(taskId: string): Promise<TaskEvent[]> {
    identifier(taskId);
    return this.safe(async () =>
      (await this.db.executeAsync('SELECT * FROM task_events WHERE task_id=? ORDER BY created_at,event_id', [taskId])).results.map(event),
    );
  }

  async upsertAttention(value: NeedsAttention): Promise<boolean> {
    identifier(value.attentionId);
    identifier(value.taskId);
    if (!value.title.trim() || value.title.length > 200 || value.summary && value.summary.length > 2000) {
      throw new CetaError('invalid_protocol', 'Invalid attention item');
    }
    iso(value.createdAt);
    iso(value.updatedAt);
    return this.safe(() => this.db.transaction(async tx => {
      await this.getRaw(tx, value.taskId);
      const existing = await tx.executeAsync('SELECT attention_id FROM task_attention WHERE attention_id=?', [value.attentionId]);
      if (existing.results.length) {
        return false;
      }
      await tx.executeAsync(
        'INSERT INTO task_attention(attention_id,task_id,kind,title,summary,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        [value.attentionId, value.taskId, value.kind, value.title.trim(), value.summary ?? null, value.status, value.createdAt, value.updatedAt],
      );
      return true;
    }));
  }

  listAttention(taskId?: string): Promise<NeedsAttention[]> {
    if (taskId) {
      identifier(taskId);
    }
    return this.safe(async () => {
      const result = taskId
        ? await this.db.executeAsync('SELECT * FROM task_attention WHERE task_id=? AND status=? ORDER BY updated_at,attention_id', [taskId, 'pending'])
        : await this.db.executeAsync('SELECT * FROM task_attention WHERE status=? ORDER BY updated_at,attention_id', ['pending']);
      return result.results.map(attention);
    });
  }

  async resolveAttention(attentionId: string): Promise<void> {
    identifier(attentionId);
    await this.safe(async () => {
      await this.db.executeAsync('UPDATE task_attention SET status=?,updated_at=? WHERE attention_id=?', ['resolved', new Date().toISOString(), attentionId]);
    });
  }
}
