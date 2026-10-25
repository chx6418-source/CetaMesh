import type { SqliteConnection } from './SqliteConnection';
const connections = new WeakMap<SqliteConnection, SqliteConnection>();
export function serializeConnection(
  connection: SqliteConnection,
): SqliteConnection {
  const existing = connections.get(connection);
  if (existing) {
    return existing;
  }
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work);
    tail = pending.catch(() => undefined);
    return pending;
  };
  const result: SqliteConnection = {
    executeAsync: (sql, params) =>
      run(() => connection.executeAsync(sql, params)),
    transaction: work => run(() => connection.transaction(work)),
    close: () => run(() => connection.close()),
  };
  connections.set(connection, result);
  connections.set(result, result);
  return result;
}
