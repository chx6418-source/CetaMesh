import type {InboxInput, InboxItem, InboxRepository} from '../../domain/inbox';
import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';
import {newId} from '../../shared/utils/id';

type Row = Record<string, SqliteValue>;

function encode(value: unknown): string {
  let result: string;
  try { result = JSON.stringify(value); } catch { throw new CetaError('invalid_protocol', 'Inbox payload is invalid'); }
  if (result.length > 65_536) { throw new CetaError('unsupported', 'Inbox payload is too large'); }
  return result;
}

function decode(row: Row): InboxItem {
  return {
    inboxId: identifier(row.inbox_id),
    kind: row.kind as InboxItem['kind'],
    payload: JSON.parse(String(row.payload)),
    status: row.status as InboxItem['status'],
    localOnly: true,
    attempts: Number(row.attempts),
    ...(row.last_error === null ? {} : {lastError: String(row.last_error)}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class SqliteOfflineInboxRepository implements InboxRepository {
  private readonly db: SqliteConnection;
  constructor(db: SqliteConnection) { this.db = serializeConnection(db); }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { throw error instanceof CetaError ? error : new CetaError('storage_error', 'Inbox storage operation failed'); }
  }

  private async getRaw(db: SqliteConnection, inboxId: string): Promise<InboxItem> {
    const row = (await db.executeAsync('SELECT * FROM mobile_inbox WHERE inbox_id=?', [inboxId])).results[0];
    if (!row) { throw new CetaError('storage_error', 'Inbox item not found'); }
    return decode(row);
  }

  async create(input: InboxInput): Promise<InboxItem> {
    const inboxId = newId('inbox');
    const now = new Date().toISOString();
    const payload = encode(input.payload);
    return this.safe(async () => {
      await this.db.executeAsync('INSERT INTO mobile_inbox(inbox_id,kind,payload,status,local_only,attempts,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [inboxId, input.kind, payload, 'pending', 1, 0, null, now, now]);
      return this.getRaw(this.db, inboxId);
    });
  }

  get(inboxId: string): Promise<InboxItem> { identifier(inboxId); return this.safe(() => this.getRaw(this.db, inboxId)); }

  list(): Promise<InboxItem[]> { return this.safe(async () => (await this.db.executeAsync('SELECT * FROM mobile_inbox ORDER BY created_at,inbox_id')).results.map(decode)); }

  async updateStatus(inboxId: string, status: InboxItem['status'], error?: string): Promise<InboxItem> {
    identifier(inboxId);
    if (error && error.length > 200) { throw new CetaError('invalid_protocol', 'Inbox error is too long'); }
    return this.safe(() => this.db.transaction(async tx => {
      const current = await this.getRaw(tx, inboxId);
      const attempts = status === 'processing' ? current.attempts + 1 : current.attempts;
      await tx.executeAsync('UPDATE mobile_inbox SET status=?,attempts=?,last_error=?,updated_at=? WHERE inbox_id=?', [status, attempts, error ?? (status === 'pending' ? null : current.lastError ?? null), new Date().toISOString(), inboxId]);
      return this.getRaw(tx, inboxId);
    }));
  }
}
