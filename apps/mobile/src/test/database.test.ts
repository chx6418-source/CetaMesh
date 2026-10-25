import type {SqliteConnection, SqliteQueryResult} from '../data/database/SqliteConnection';
import {
  bootstrapDatabase,
  migrateDatabase,
} from '../data/database/MigrationEngine';
import {
  createDatabaseConfig,
  type DatabaseMode,
} from '../data/database/DatabaseConfig';
import type {Migration} from '../data/migrations/Migration';
import {DatabaseSync} from 'node:sqlite';

class FakeSqliteConnection implements SqliteConnection {
  readonly executedSql: string[] = [];
  private schemaVersion = 0;
  private failureSql: string | undefined;

  failNext(sql: string): void {
    this.failureSql = sql;
  }

  async executeAsync<T extends Record<string, ArrayBuffer | boolean | number | string | null>>(
    sql: string,
  ): Promise<SqliteQueryResult<T>> {
    if (sql === this.failureSql) {
      this.failureSql = undefined;
      this.executedSql.push(sql);
      throw new Error('simulated migration failure');
    }

    this.executedSql.push(sql);

    if (sql.startsWith('SELECT version FROM schema_version')) {
      return {
        results: (this.schemaVersion === 0
          ? []
          : [{version: this.schemaVersion}]) as unknown as T[],
      };
    }

    const versionMatch =
      sql.match(/VALUES \(1,\s*(\d+)\)/) ?? sql.match(/SET version = (\d+)/);
    if (versionMatch) {
      this.schemaVersion = Number(versionMatch[1]);
    }

    return {results: []};
  }

  async transaction<T>(callback: (connection: SqliteConnection) => Promise<T>): Promise<T> {
    const versionBeforeTransaction = this.schemaVersion;
    const sqlCountBeforeTransaction = this.executedSql.length;

    try {
      return await callback(this);
    } catch (error) {
      this.schemaVersion = versionBeforeTransaction;
      this.executedSql.splice(sqlCountBeforeTransaction);
      throw error;
    }
  }

  async close(): Promise<void> {}

  getVersion(): number {
    return this.schemaVersion;
  }
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    statements: ['CREATE TABLE runtime_metadata (key TEXT PRIMARY KEY)'],
  },
  {
    version: 2,
    statements: ['ALTER TABLE runtime_metadata ADD COLUMN value TEXT'],
  },
];

test('creates schema_version and applies migrations on a new database', async () => {
  const database = new FakeSqliteConnection();

  const result = await bootstrapDatabase(database, migrations);

  expect(result.version).toBe(2);
  expect(database.getVersion()).toBe(2);
  expect(database.executedSql).toContain('CREATE TABLE runtime_metadata (key TEXT PRIMARY KEY)');
  expect(database.executedSql).toContain('ALTER TABLE runtime_metadata ADD COLUMN value TEXT');
});

test('re-running migrations is idempotent and does not reset the database', async () => {
  const database = new FakeSqliteConnection();

  await migrateDatabase(database, migrations);
  const firstRunSqlCount = database.executedSql.length;
  await migrateDatabase(database, migrations);

  expect(database.executedSql).toHaveLength(firstRunSqlCount + 2);
  expect(
    database.executedSql.filter(sql => sql === 'CREATE TABLE runtime_metadata (key TEXT PRIMARY KEY)'),
  ).toHaveLength(1);
  expect(database.executedSql.some(sql => /DROP TABLE|DELETE FROM schema_version/i.test(sql))).toBe(false);
});

test('upgrades an existing database by applying only newer migrations', async () => {
  const database = new FakeSqliteConnection();

  await migrateDatabase(database, [migrations[0]]);
  await migrateDatabase(database, migrations);

  expect(database.getVersion()).toBe(2);
  expect(
    database.executedSql.filter(sql => sql === 'ALTER TABLE runtime_metadata ADD COLUMN value TEXT'),
  ).toHaveLength(1);
});

test('rejects invalid and duplicate migration versions before executing SQL', async () => {
  const database = new FakeSqliteConnection();

  await expect(
    migrateDatabase(database, [{version: 0, statements: []}]),
  ).rejects.toThrow('Migration version must be a positive integer');
  await expect(
    migrateDatabase(database, [
      {version: 1, statements: []},
      {version: 1, statements: []},
    ]),
  ).rejects.toThrow('Duplicate migration version');
});

test('rolls back a failed migration so a later retry can apply it', async () => {
  const database = new FakeSqliteConnection();
  await migrateDatabase(database, [migrations[0]]);
  database.failNext(migrations[1].statements[0]);

  await expect(migrateDatabase(database, migrations)).rejects.toThrow(
    'simulated migration failure',
  );
  expect(database.getVersion()).toBe(1);

  await migrateDatabase(database, migrations);

  expect(database.getVersion()).toBe(2);
  expect(
    database.executedSql.filter(sql => sql === migrations[1].statements[0]),
  ).toHaveLength(1);
});

class NodeSqliteConnection implements SqliteConnection {
  constructor(private readonly database = new DatabaseSync(':memory:')) {}

  async executeAsync<T extends Record<string, ArrayBuffer | boolean | number | string | null>>(
    sql: string,
    params: readonly (ArrayBuffer | boolean | number | string | null)[] = [],
  ): Promise<SqliteQueryResult<T>> {
    const statement = this.database.prepare(sql);
    const bindings = params.map(value => typeof value === 'boolean' ? Number(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const isQuery = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql);
    if (isQuery) {
      return {results: statement.all(...bindings) as T[]};
    }

    const result = statement.run(...bindings);
    return {results: [], rowsAffected: Number(result.changes)};
  }

  async transaction<T>(callback: (connection: SqliteConnection) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN');
    try {
      const result = await callback(this);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

test('runs migrations against executable SQLite in the test environment', async () => {
  const database = new NodeSqliteConnection();

  await bootstrapDatabase(database, migrations);
  const result = await database.executeAsync<{version: number}>(
    'SELECT version FROM schema_version',
  );

  expect(result.results).toEqual([{version: 2}]);
});

test.each<DatabaseMode>(['production', 'test'])('keeps %s database configuration explicit', mode => {
  const config = createDatabaseConfig(mode);

  expect(config.mode).toBe(mode);
  expect(config.name).toContain(mode === 'test' ? 'test' : 'cetamesh');
  expect(config.name).not.toBe('');
});

test('production and test databases use different SQLite names', () => {
  expect(createDatabaseConfig('production').name).not.toBe(createDatabaseConfig('test').name);
});
