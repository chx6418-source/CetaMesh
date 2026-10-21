import {open, type NitroSQLiteConnection, type SQLiteQueryParams} from 'react-native-nitro-sqlite';
import {createDatabaseConfig, type DatabaseMode} from './DatabaseConfig';
import type {
  SqliteConnection,
  SqliteQueryResult,
  SqliteValue,
} from './SqliteConnection';

function adaptConnection(nativeConnection: NitroSQLiteConnection): SqliteConnection {
  return {
    executeAsync: async <Row extends Record<string, SqliteValue>>(
      sql: string,
      params: readonly SqliteValue[] = [],
    ): Promise<SqliteQueryResult<Row>> => {
      const result = await nativeConnection.executeAsync<Row>(
        sql,
        params as SQLiteQueryParams,
      );

      return {
        results: result.rows._array as Row[],
        rowsAffected: result.rowsAffected,
        insertId: result.insertId,
      };
    },
    transaction: async callback =>
      nativeConnection.transaction(async transaction =>
        callback(adaptTransaction(transaction)),
      ),
    close: async () => {
      nativeConnection.close();
    },
  };
}

function adaptTransaction(
  transaction: Pick<NitroSQLiteConnection, 'executeAsync'>,
): SqliteConnection {
  return {
    executeAsync: async <Row extends Record<string, SqliteValue>>(
      sql: string,
      params: readonly SqliteValue[] = [],
    ): Promise<SqliteQueryResult<Row>> => {
      const result = await transaction.executeAsync<Row>(
        sql,
        params as SQLiteQueryParams,
      );

      return {
        results: result.rows._array as Row[],
        rowsAffected: result.rowsAffected,
        insertId: result.insertId,
      };
    },
    transaction: async () => {
      throw new Error('Nested SQLite transactions are not supported');
    },
    close: async () => {
      throw new Error('SQLite transaction handles cannot be closed');
    },
  };
}

export function openCetaDatabase(mode: DatabaseMode = 'production'): SqliteConnection {
  const config = createDatabaseConfig(mode);
  return adaptConnection(
    open({
      name: config.name,
      location: 'databases',
    }),
  );
}
