import type { MemoryRepository } from '../../domain/memory/MemoryRepository';
import type {
  MemoryActor,
  MemoryChatEvidence,
  MemoryInput,
  MemoryPatch,
  MemoryQuery,
  MemoryRecord,
} from '../../domain/memory/Memory';
import {
  invalidMemory,
  normalizeMemory,
  requireRevision,
  validatePatch,
  validateQuery,
} from '../../domain/memory/MemoryValidation';
import { CetaError } from '../../shared/errors/CetaError';
import { newId } from '../../shared/utils/id';
import type {
  SqliteConnection,
  SqliteValue,
} from '../database/SqliteConnection';
import { serializeConnection } from '../database/serializeConnection';
function record(r: Record<string, SqliteValue>): MemoryRecord {
  return {
    id: String(r.id),
    kind: r.kind as MemoryRecord['kind'],
    scope: 'local-only',
    content: String(r.content),
    source: JSON.parse(String(r.source)),
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    pinned: r.pinned === 1,
    revision: Number(r.revision),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastUsedAt: r.last_used_at === null ? null : String(r.last_used_at),
  };
}
export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: SqliteConnection;
  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }
  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof CetaError
        ? e
        : new CetaError('storage_error', 'Memory storage operation failed');
    }
  }
  private async getRaw(
    db: SqliteConnection,
    id: string,
  ): Promise<MemoryRecord> {
    const row = (
      await db.executeAsync('SELECT * FROM memories WHERE id=?', [id])
    ).results[0];
    if (!row) {
      throw new CetaError('storage_error', 'Memory not found');
    }
    return record(row);
  }
  get(id: string): Promise<MemoryRecord> {
    return this.safe(() => this.getRaw(this.db, id));
  }
  private async insert(
    db: SqliteConnection,
    input: Required<MemoryInput>,
  ): Promise<MemoryRecord> {
    const id = newId('memory'),
      now = new Date().toISOString();
    await db.executeAsync(
      'INSERT INTO memories(id,kind,scope,content,source,source_session_id,importance,confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.kind,
        input.scope,
        input.content,
        JSON.stringify(input.source),
        input.source.kind === 'chat' ? input.source.sessionId : null,
        input.importance,
        input.confidence,
        now,
        now,
      ],
    );
    return this.getRaw(db, id);
  }
  create(input: MemoryInput): Promise<MemoryRecord> {
    return this.safe(() => this.insert(this.db, normalizeMemory(input)));
  }
  saveCandidate(
    input: MemoryInput,
    evidence: MemoryChatEvidence,
  ): Promise<MemoryRecord> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        const value = normalizeMemory(input);
        if (value.kind !== 'chat' || value.source.kind !== 'chat') {
          return invalidMemory();
        }
        if (
          !evidence ||
          value.source.messageIds.length !== 1 ||
          evidence.sessionId !== value.source.sessionId ||
          evidence.messageId !== value.source.messageIds[0] ||
          typeof evidence.originalContent !== 'string' ||
          evidence.originalContent.length > 100000
        ) {
          return invalidMemory();
        }
        const source = (
          await tx.executeAsync(
            'SELECT m.content,m.role,m.status FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE m.id=? AND m.session_id=?',
            [evidence.messageId, evidence.sessionId],
          )
        ).results[0];
        if (
          !source ||
          source.role !== 'user' ||
          source.status !== 'completed' ||
          source.content !== evidence.originalContent
        ) {
          throw new CetaError(
            'sync_conflict',
            'Chat source changed; generate a new preview',
          );
        }
        const row = (
          await tx.executeAsync(
            'SELECT * FROM memories WHERE content=? AND source=? AND kind=?',
            [value.content, JSON.stringify(value.source), 'chat'],
          )
        ).results[0];
        return row ? record(row) : this.insert(tx, value);
      }),
    );
  }
  search(query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    return this.safe(async () => {
      const q = validateQuery(query),
        conditions = ['scope=?'],
        params: SqliteValue[] = ['local-only'];
      if (q.kind) {
        conditions.push('kind=?');
        params.push(q.kind);
      }
      if (q.pinned !== undefined) {
        conditions.push('pinned=?');
        params.push(q.pinned ? 1 : 0);
      }
      if (q.sourceSessionId) {
        conditions.push('source_session_id=?');
        params.push(q.sourceSessionId);
      }
      const tokens = [
        ...new Set(
          q.query
            .replace(/[A-Z]/g, letter => letter.toLowerCase())
            .split(/\s+/)
            .filter(Boolean),
        ),
      ].slice(0, 8);
      const ranks: string[] = [],
        rankParams: SqliteValue[] = [];
      for (const token of tokens) {
        conditions.push('instr(lower(content),?)>0');
        params.push(token);
        ranks.push('CASE WHEN instr(lower(content),?)=1 THEN 2 ELSE 1 END');
        rankParams.push(token);
      }
      const ranking = ranks.length ? ranks.join('+') : '0';
      const sql =
        'SELECT *, (' +
        ranking +
        ') AS relevance FROM memories WHERE ' +
        conditions.join(' AND ') +
        ' ORDER BY pinned DESC,relevance DESC,importance DESC,updated_at DESC,id DESC LIMIT ? OFFSET ?';
      return (
        await this.db.executeAsync(sql, [
          ...rankParams,
          ...params,
          q.limit,
          q.offset,
        ])
      ).results.map(record);
    });
  }
  private authorize(
    current: MemoryRecord,
    revision: number,
    actor: MemoryActor,
  ): void {
    requireRevision(current, revision);
    if (!['user', 'automatic'].includes(actor)) {
      return invalidMemory();
    }
    if (actor === 'automatic' && current.pinned) {
      throw new CetaError(
        'permission_denied',
        'Pinned memory requires an explicit user change',
      );
    }
  }
  update(
    id: string,
    patch: MemoryPatch,
    revision: number,
    actor: MemoryActor,
  ): Promise<MemoryRecord> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        const changes = validatePatch(patch),
          current = await this.getRaw(tx, id);
        this.authorize(current, revision, actor);
        const value = { ...current, ...changes };
        await tx.executeAsync(
          'UPDATE memories SET kind=?,content=?,importance=?,confidence=?,revision=revision+1,updated_at=? WHERE id=?',
          [
            value.kind,
            value.content,
            value.importance,
            value.confidence,
            new Date().toISOString(),
            id,
          ],
        );
        return this.getRaw(tx, id);
      }),
    );
  }
  pin(id: string, pinned: boolean, revision: number): Promise<MemoryRecord> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        if (typeof pinned !== 'boolean') {
          return invalidMemory();
        }
        requireRevision(await this.getRaw(tx, id), revision);
        await tx.executeAsync(
          'UPDATE memories SET pinned=?,revision=revision+1,updated_at=? WHERE id=?',
          [pinned ? 1 : 0, new Date().toISOString(), id],
        );
        return this.getRaw(tx, id);
      }),
    );
  }
  delete(id: string, revision: number, actor: MemoryActor): Promise<void> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        this.authorize(await this.getRaw(tx, id), revision, actor);
        await tx.executeAsync('DELETE FROM memories WHERE id=?', [id]);
      }),
    );
  }
}
