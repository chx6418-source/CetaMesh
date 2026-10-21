import { DatabaseSync } from 'node:sqlite';
import type {
  SqliteConnection,
  SqliteQueryResult,
  SqliteValue,
} from '../../data/database/SqliteConnection';
export class NodeDatabase implements SqliteConnection {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }
  async executeAsync<T extends Record<string, SqliteValue>>(
    sql: string,
    params: readonly SqliteValue[] = [],
  ): Promise<SqliteQueryResult<T>> {
    const stmt = this.db.prepare(sql);
    const bindings = params.map(value => typeof value === 'boolean' ? Number(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) {
      return { results: stmt.all(...bindings) as T[] };
    }
    const result = stmt.run(...bindings);
    return { results: [], rowsAffected: Number(result.changes) };
  }
  async transaction<T>(work: (db: SqliteConnection) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await work(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async close() {
    this.db.close();
  }
}
