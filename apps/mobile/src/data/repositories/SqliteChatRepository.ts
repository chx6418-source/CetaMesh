import type {
  Attachment,
  ChatMessage,
  ChatRepository,
  ChatSession,
  ChatSessionConfig,
  MessagePage,
  MessageStatus,
  SessionPage,
  Turn,
} from '../../domain/chat/ChatRepository';
import { CetaError } from '../../shared/errors/CetaError';
import type { CetaErrorCode } from '../../shared/errors/CetaErrorCode';
import { newId } from '../../shared/utils/id';
import type {
  SqliteConnection,
  SqliteValue,
} from '../database/SqliteConnection';
import { serializeConnection } from '../database/serializeConnection';
import type {SessionUsage, TokenUsage} from '../../domain/model/TokenUsage';
type Row = Record<string, SqliteValue>;
function session(r: Row): ChatSession {
  return {
    id: String(r.id),
    title: String(r.title),
    archived: r.archived === 1,
    config: JSON.parse(String(r.config)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
function message(r: Row): ChatMessage {
  return {
    id: String(r.id),
    sequence: Number(r.sequence),
    sessionId: String(r.session_id),
    role: r.role as ChatMessage['role'],
    content: String(r.content),
    attachments: JSON.parse(String(r.attachments)),
    status: r.status as MessageStatus,
    replyTo: r.reply_to as string | null,
    errorCode: r.error_code as CetaErrorCode | null,
    createdAt: String(r.created_at),
  };
}
function pageLimit(limit = 40): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CetaError('invalid_protocol', 'Page limit must be 1–200');
  }
  return limit;
}
export class SqliteChatRepository implements ChatRepository {
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
        : new CetaError('storage_error', 'Chat storage operation failed');
    }
  }
  private async getRaw(db: SqliteConnection, id: string): Promise<ChatSession> {
    const row = (
      await db.executeAsync('SELECT * FROM chat_sessions WHERE id=?', [id])
    ).results[0];
    if (!row) {
      throw new CetaError('storage_error', 'Session not found');
    }
    return session(row);
  }
  private async idle(db: SqliteConnection, id: string): Promise<void> {
    await this.getRaw(db, id);
    const rows = await db.executeAsync(
      'SELECT id FROM chat_messages WHERE session_id=? AND status=?',
      [id, 'streaming'],
    );
    if (rows.results.length) {
      throw new CetaError('sync_conflict', 'Stop the active reply first');
    }
  }
  async create(
    config: ChatSessionConfig,
    title = 'New Chat',
  ): Promise<ChatSession> {
    const now = new Date().toISOString();
    const value: ChatSession = {
      id: newId('chat'),
      title: title.trim().slice(0, 200) || 'New Chat',
      archived: false,
      config,
      createdAt: now,
      updatedAt: now,
    };
    return this.safe(async () => {
      await this.db.executeAsync(
        'INSERT INTO chat_sessions(id,title,archived,config,created_at,updated_at) VALUES(?,?,0,?,?,?)',
        [value.id, value.title, JSON.stringify(config), now, now],
      );
      return value;
    });
  }
  get(id: string): Promise<ChatSession> {
    return this.safe(() => this.getRaw(this.db, id));
  }
  list(page: SessionPage = {}): Promise<ChatSession[]> {
    return this.safe(async () => {
      const limit = pageLimit(page.limit);
      const offset = page.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new CetaError('invalid_protocol', 'Invalid page offset');
      }
      return (
        await this.db.executeAsync(
          'SELECT * FROM chat_sessions WHERE archived=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?',
          [page.archived ? 1 : 0, limit, offset],
        )
      ).results.map(session);
    });
  }
  private mutate(
    id: string,
    sql: string,
    params: SqliteValue[],
  ): Promise<void> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        await this.idle(tx, id);
        await tx.executeAsync(sql, params);
      }),
    );
  }
  rename(id: string, title: string): Promise<void> {
    if (!title.trim()) {
      return Promise.reject(
        new CetaError('invalid_protocol', 'Title is required'),
      );
    }
    return this.mutate(
      id,
      'UPDATE chat_sessions SET title=?,updated_at=? WHERE id=?',
      [title.trim().slice(0, 200), new Date().toISOString(), id],
    );
  }
  archive(id: string, archived: boolean): Promise<void> {
    return this.mutate(
      id,
      'UPDATE chat_sessions SET archived=?,updated_at=? WHERE id=?',
      [archived ? 1 : 0, new Date().toISOString(), id],
    );
  }
  configure(id: string, config: ChatSessionConfig): Promise<void> {
    return this.mutate(
      id,
      'UPDATE chat_sessions SET config=?,updated_at=? WHERE id=?',
      [JSON.stringify(config), new Date().toISOString(), id],
    );
  }
  delete(id: string): Promise<void> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        await this.idle(tx, id);
        await tx.executeAsync('DELETE FROM chat_messages WHERE session_id=?', [
          id,
        ]);
        await tx.executeAsync('DELETE FROM chat_turn_usage WHERE session_id=?', [id]);
        await tx.executeAsync('DELETE FROM chat_sessions WHERE id=?', [id]);
      }),
    );
  }
  recordUsage(assistantMessageId: string, usage: TokenUsage, providerId: string, modelId: string): Promise<void> {
    return this.safe(async () => {
      await this.db.executeAsync(
        `INSERT OR REPLACE INTO chat_turn_usage
        (assistant_message_id,session_id,provider_id,model_id,input_tokens,output_tokens,total_tokens,cached_input_tokens,cache_miss_input_tokens,created_at)
        SELECT id,session_id,?,?,?,?,?,?,?,? FROM chat_messages WHERE id=? AND role='assistant' AND status='completed'`,
        [providerId, modelId, usage.inputTokens, usage.outputTokens, usage.totalTokens,
          usage.cachedInputTokens ?? null, usage.cacheMissInputTokens ?? null, new Date().toISOString(), assistantMessageId],
      );
    });
  }
  turnUsage(assistantMessageId: string): Promise<TokenUsage | undefined> {
    return this.safe(async () => {
      const row = (await this.db.executeAsync(
        'SELECT input_tokens,output_tokens,total_tokens,cached_input_tokens,cache_miss_input_tokens FROM chat_turn_usage WHERE assistant_message_id=?',
        [assistantMessageId],
      )).results[0];
      if (!row) {return undefined;}
      return {
        inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens),
        ...(row.cached_input_tokens === null || row.cache_miss_input_tokens === null ? {} : {
          cachedInputTokens: Number(row.cached_input_tokens), cacheMissInputTokens: Number(row.cache_miss_input_tokens),
        }),
        providerReported: true,
      };
    });
  }
  sessionUsage(sessionId: string): Promise<SessionUsage | undefined> {
    return this.safe(async () => {
      const rows = (await this.db.executeAsync(
        `SELECT input_tokens,output_tokens,total_tokens,cached_input_tokens,cache_miss_input_tokens FROM chat_turn_usage WHERE session_id=?`, [sessionId],
      )).results;
      if (!rows.length) {return undefined;}
      const completed = (await this.db.executeAsync(
        "SELECT COUNT(*) AS count FROM chat_messages WHERE session_id=? AND role='assistant' AND status='completed'", [sessionId],
      )).results[0];
      const cacheKnown = rows.every(row => row.cached_input_tokens !== null && row.cache_miss_input_tokens !== null);
      const hasCacheData = rows.some(row => row.cached_input_tokens !== null && row.cache_miss_input_tokens !== null);
      return {
        inputTokens: rows.reduce((sum, row) => sum + Number(row.input_tokens), 0),
        outputTokens: rows.reduce((sum, row) => sum + Number(row.output_tokens), 0),
        totalTokens: rows.reduce((sum, row) => sum + Number(row.total_tokens), 0),
        ...(hasCacheData ? {
          cachedInputTokens: rows.reduce((sum, row) => sum + Number(row.cached_input_tokens ?? 0), 0),
          cacheMissInputTokens: rows.reduce((sum, row) => sum + Number(row.cache_miss_input_tokens ?? 0), 0),
        } : {}),
        providerReported: true, turns: rows.length,
        partial: rows.length < Number(completed?.count ?? rows.length) || !cacheKnown,
      };
    });
  }
  messages(id: string, page: MessagePage = {}): Promise<ChatMessage[]> {
    return this.safe(async () => {
      const limit = pageLimit(page.limit);
      const before = page.before ?? Number.MAX_SAFE_INTEGER;
      return (
        await this.db.executeAsync(
          'SELECT * FROM chat_messages WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?',
          [id, before, limit],
        )
      ).results
        .map(message)
        .reverse();
    });
  }
  async beginTurn(
    id: string,
    text: string,
    attachments: Attachment[],
  ): Promise<Turn> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        await this.idle(tx, id);
        const current = await this.getRaw(tx, id);
        if (current.archived) {
          throw new CetaError(
            'permission_denied',
            'Restore this archived session first',
          );
        }
        const userId = newId('msg'),
          assistantId = newId('msg'),
          now = new Date().toISOString();
        await tx.executeAsync(
          'INSERT INTO chat_messages(id,session_id,role,content,attachments,status,created_at) VALUES(?,?,?,?,?,?,?)',
          [
            userId,
            id,
            'user',
            text,
            JSON.stringify(attachments),
            'completed',
            now,
          ],
        );
        await tx.executeAsync(
          'INSERT INTO chat_messages(id,session_id,role,content,attachments,status,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?)',
          [assistantId, id, 'assistant', '', '[]', 'streaming', userId, now],
        );
        await tx.executeAsync(
          'UPDATE chat_sessions SET updated_at=? WHERE id=?',
          [now, id],
        );
        const rows = (
          await tx.executeAsync(
            'SELECT * FROM chat_messages WHERE id IN (?,?) ORDER BY sequence',
            [userId, assistantId],
          )
        ).results.map(message);
        return { user: rows[0], assistant: rows[1] };
      }),
    );
  }
  async retryTurn(id: string): Promise<Turn> {
    return this.safe(() =>
      this.db.transaction(async tx => {
        await this.idle(tx, id);
        if ((await this.getRaw(tx, id)).archived) {
          throw new CetaError(
            'permission_denied',
            'Restore this archived session first',
          );
        }
        const last = (
          await tx.executeAsync(
            'SELECT * FROM chat_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
            [id],
          )
        ).results[0];
        if (
          !last ||
          last.role !== 'assistant' ||
          !['failed', 'cancelled'].includes(String(last.status))
        ) {
          throw new CetaError(
            'unsupported',
            'Only the latest failed or stopped reply can be retried',
          );
        }
        const user = (
          await tx.executeAsync(
            'SELECT * FROM chat_messages WHERE id=? AND session_id=?',
            [last.reply_to, id],
          )
        ).results[0];
        if (!user) {
          throw new CetaError('storage_error', 'Original message not found');
        }
        await tx.executeAsync(
          'UPDATE chat_messages SET content=?,status=?,error_code=NULL WHERE id=?',
          ['', 'streaming', last.id],
        );
        return {
          user: message(user),
          assistant: message({
            ...last,
            content: '',
            status: 'streaming',
            error_code: null,
          }),
        };
      }),
    );
  }
  async resumeTurn(id: string): Promise<Turn> {
    return this.safe(() => this.db.transaction(async tx => {
      await this.idle(tx, id);
      if ((await this.getRaw(tx, id)).archived) {
        throw new CetaError('permission_denied', 'Restore this archived session first');
      }
      const last = (await tx.executeAsync(
        'SELECT * FROM chat_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 1', [id],
      )).results[0];
      if (!last || last.role !== 'assistant' || !['failed', 'cancelled'].includes(String(last.status)) || !String(last.content).trim()) {
        throw new CetaError('unsupported', 'Only a partial interrupted reply can be continued');
      }
      const user = (await tx.executeAsync('SELECT * FROM chat_messages WHERE id=? AND session_id=?', [last.reply_to, id])).results[0];
      if (!user) {throw new CetaError('storage_error', 'Original message not found');}
      await tx.executeAsync('UPDATE chat_messages SET status=?,error_code=NULL WHERE id=?', ['streaming', last.id]);
      return {user: message(user), assistant: message({...last, status: 'streaming', error_code: null})};
    }));
  }
  async finishTurn(
    id: string,
    content: string,
    status: MessageStatus,
    errorCode?: CetaErrorCode,
  ): Promise<void> {
    await this.safe(async () => {
      await this.db.executeAsync(
        'UPDATE chat_messages SET content=?,status=?,error_code=? WHERE id=? AND role=?',
        [content, status, errorCode ?? null, id, 'assistant'],
      );
    });
  }
  async recoverInterrupted(): Promise<void> {
    await this.safe(async () => {
      await this.db.executeAsync(
        'UPDATE chat_messages SET status=?,error_code=? WHERE status=?',
        ['failed', 'cancelled', 'streaming'],
      );
    });
  }
}
