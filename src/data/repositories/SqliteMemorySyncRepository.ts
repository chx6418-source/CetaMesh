import type {MemorySyncObject, MemorySyncStore} from '../../domain/sync';
import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';

type Row = Record<string, SqliteValue>;

function decode(row: Row): MemorySyncObject {
  return {
    objectType: 'memory',
    memoryId: identifier(row.memory_id),
    ownerId: identifier(row.owner_id),
    scopeType: 'my-devices',
    scopeId: identifier(row.scope_id),
    revision: Number(row.revision),
    source: String(row.source),
    policy: 'my-devices',
    ...(row.content === null ? {} : {content: String(row.content)}),
    ...(Number(row.deleted) ? {deleted: true} : {}),
    updatedAt: iso(row.updated_at),
  };
}

export class SqliteMemorySyncRepository implements MemorySyncStore {
  private readonly db: SqliteConnection;
  constructor(db: SqliteConnection) { this.db = serializeConnection(db); }

  async get(memoryId: string): Promise<MemorySyncObject | undefined> {
    identifier(memoryId);
    try {
      const row = (await this.db.executeAsync('SELECT * FROM mesh_memory_sync WHERE memory_id=?', [memoryId])).results[0];
      return row ? decode(row) : undefined;
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Memory sync storage operation failed');
    }
  }

  async upsert(object: MemorySyncObject): Promise<void> {
    identifier(object.memoryId);
    identifier(object.ownerId);
    identifier(object.scopeId);
    iso(object.updatedAt);
    try {
      await this.db.executeAsync('INSERT INTO mesh_memory_sync(memory_id,owner_id,scope_type,scope_id,revision,source,policy,content,deleted,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET owner_id=excluded.owner_id,scope_type=excluded.scope_type,scope_id=excluded.scope_id,revision=excluded.revision,source=excluded.source,policy=excluded.policy,content=excluded.content,deleted=excluded.deleted,updated_at=excluded.updated_at', [object.memoryId, object.ownerId, object.scopeType, object.scopeId, object.revision, object.source, object.policy, object.content ?? null, object.deleted ? 1 : 0, object.updatedAt]);
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Memory sync storage operation failed');
    }
  }
}
