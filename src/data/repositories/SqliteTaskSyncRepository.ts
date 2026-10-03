import type {TaskSyncSnapshot, TaskSyncStore} from '../../domain/sync';
import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';

type Row = Record<string, SqliteValue>;

function decode(row: Row): TaskSyncSnapshot {
  const value = JSON.parse(String(row.snapshot)) as TaskSyncSnapshot;
  identifier(value.taskId);
  iso(value.updatedAt);
  return value;
}

export class SqliteTaskSyncRepository implements TaskSyncStore {
  private readonly db: SqliteConnection;
  constructor(db: SqliteConnection) { this.db = serializeConnection(db); }

  async get(taskId: string): Promise<TaskSyncSnapshot | undefined> {
    identifier(taskId);
    try {
      const row = (await this.db.executeAsync('SELECT * FROM mesh_task_sync WHERE task_id=?', [taskId])).results[0];
      return row ? decode(row) : undefined;
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Task sync storage operation failed');
    }
  }

  async upsert(object: TaskSyncSnapshot): Promise<void> {
    identifier(object.taskId);
    identifier(object.ownerId);
    identifier(object.scopeId);
    iso(object.updatedAt);
    let snapshot: string;
    try { snapshot = JSON.stringify(object); } catch { throw new CetaError('invalid_protocol', 'Task sync snapshot is invalid'); }
    if (snapshot.length > 65_536) { throw new CetaError('invalid_protocol', 'Task sync snapshot is too large'); }
    try {
      await this.db.executeAsync('INSERT INTO mesh_task_sync(task_id,owner_id,scope_type,scope_id,revision,snapshot,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET owner_id=excluded.owner_id,scope_type=excluded.scope_type,scope_id=excluded.scope_id,revision=excluded.revision,snapshot=excluded.snapshot,updated_at=excluded.updated_at', [object.taskId, object.ownerId, object.scopeType, object.scopeId, object.revision, snapshot, object.updatedAt]);
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Task sync storage operation failed');
    }
  }
}
