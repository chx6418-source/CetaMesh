import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';
import type {SyncQueueInput, SyncQueueItem, SyncQueueRepository} from '../../domain/sync';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';

type Row = Record<string, SqliteValue>;

function encode(payload: unknown): string {
  let value: string;
  try {
    value = JSON.stringify(payload);
  } catch {
    throw new CetaError('invalid_protocol', 'Invalid sync queue payload');
  }
  if (value.length > 65_536) {
    throw new CetaError('invalid_protocol', 'Sync queue payload is too large');
  }
  return value;
}

function decode(row: Row): SyncQueueItem {
  return {
    eventId: identifier(row.event_id),
    kind: String(row.kind),
    payload: JSON.parse(String(row.payload)),
    status: row.status as SyncQueueItem['status'],
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    ...(row.last_error === null ? {} : {lastError: String(row.last_error)}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class SqliteSyncQueueRepository implements SyncQueueRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Sync queue storage operation failed');
    }
  }

  private async getRaw(db: SqliteConnection, eventId: string): Promise<SyncQueueItem> {
    const row = (await db.executeAsync('SELECT * FROM sync_queue WHERE event_id=?', [eventId])).results[0];
    if (!row) {
      throw new CetaError('storage_error', 'Sync queue event not found');
    }
    return decode(row);
  }

  async enqueue(input: SyncQueueInput, now: number): Promise<SyncQueueItem> {
    identifier(input.eventId);
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(input.kind) || !Number.isFinite(now)) {
      throw new CetaError('invalid_protocol', 'Invalid sync queue event');
    }
    const payload = encode(input.payload);
    const timestamp = new Date(now).toISOString();
    return this.safe(() => this.db.transaction(async tx => {
      const existing = await tx.executeAsync('SELECT * FROM sync_queue WHERE event_id=?', [input.eventId]);
      if (existing.results[0]) {
        return decode(existing.results[0]);
      }
      await tx.executeAsync('INSERT INTO sync_queue(event_id,kind,payload,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [input.eventId, input.kind, payload, 'pending', 0, now, null, timestamp, timestamp]);
      return this.getRaw(tx, input.eventId);
    }));
  }

  get(eventId: string): Promise<SyncQueueItem> {
    identifier(eventId);
    return this.safe(() => this.getRaw(this.db, eventId));
  }

  async next(now: number): Promise<SyncQueueItem | undefined> {
    if (!Number.isFinite(now)) {
      throw new CetaError('invalid_protocol', 'Invalid sync queue clock');
    }
    return this.safe(() => this.db.transaction(async tx => {
      const row = (await tx.executeAsync('SELECT * FROM sync_queue WHERE (status=? OR (status=? AND next_attempt_at<=?)) AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,event_id LIMIT 1', ['pending', 'failed', now, now])).results[0];
      if (!row) {
        return undefined;
      }
      const eventId = identifier(row.event_id);
      const attempts = Number(row.attempts) + 1;
      await tx.executeAsync('UPDATE sync_queue SET status=?,attempts=?,updated_at=? WHERE event_id=? AND status IN (?,?)', ['sending', attempts, new Date(now).toISOString(), eventId, 'pending', 'failed']);
      return this.getRaw(tx, eventId);
    }));
  }

  async ack(eventId: string): Promise<SyncQueueItem> {
    identifier(eventId);
    return this.safe(() => this.db.transaction(async tx => {
      const current = await this.getRaw(tx, eventId);
      if (current.status === 'acked') {
        return current;
      }
      if (current.status !== 'sending') {
        throw new CetaError('sync_conflict', 'Only a sending event can be acknowledged');
      }
      await tx.executeAsync('UPDATE sync_queue SET status=?,updated_at=? WHERE event_id=?', ['acked', new Date().toISOString(), eventId]);
      return this.getRaw(tx, eventId);
    }));
  }

  async fail(eventId: string, error: string, nextAttemptAt: number): Promise<SyncQueueItem> {
    identifier(eventId);
    if (!error || error.length > 200 || !Number.isFinite(nextAttemptAt)) {
      throw new CetaError('invalid_protocol', 'Invalid sync queue failure');
    }
    return this.safe(() => this.db.transaction(async tx => {
      const current = await this.getRaw(tx, eventId);
      if (current.status !== 'sending') {
        return current;
      }
      await tx.executeAsync('UPDATE sync_queue SET status=?,next_attempt_at=?,last_error=?,updated_at=? WHERE event_id=?', ['failed', nextAttemptAt, error, new Date().toISOString(), eventId]);
      return this.getRaw(tx, eventId);
    }));
  }

  async deadLetter(eventId: string, error: string): Promise<SyncQueueItem> {
    identifier(eventId);
    if (!error || error.length > 200) {
      throw new CetaError('invalid_protocol', 'Invalid dead-letter reason');
    }
    return this.safe(() => this.db.transaction(async tx => {
      const current = await this.getRaw(tx, eventId);
      if (current.status === 'dead-letter') {
        return current;
      }
      await tx.executeAsync('UPDATE sync_queue SET status=?,last_error=?,updated_at=? WHERE event_id=?', ['dead-letter', error, new Date().toISOString(), eventId]);
      return this.getRaw(tx, eventId);
    }));
  }

  async recoverInterrupted(now: number): Promise<number> {
    if (!Number.isFinite(now)) { throw new CetaError('invalid_protocol', 'Invalid sync queue clock'); }
    return this.safe(async () => {
      const result = await this.db.executeAsync('UPDATE sync_queue SET status=?,next_attempt_at=?,last_error=?,updated_at=? WHERE status=?', ['failed', now, 'interrupted', new Date(now).toISOString(), 'sending']);
      return Number(result.rowsAffected ?? 0);
    });
  }

  list(): Promise<SyncQueueItem[]> {
    return this.safe(async () => (await this.db.executeAsync('SELECT * FROM sync_queue ORDER BY created_at,event_id')).results.map(decode));
  }
}
