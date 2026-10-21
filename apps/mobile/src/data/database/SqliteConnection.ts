export type SqliteValue = string | number | boolean | ArrayBuffer | null;

export type SqliteQueryResult<
  Row extends Record<string, SqliteValue> = Record<string, SqliteValue>,
> = {
  readonly results: readonly Row[];
  readonly rowsAffected?: number;
  readonly insertId?: number;
};

export interface SqliteConnection {
  executeAsync<Row extends Record<string, SqliteValue> = Record<string, SqliteValue>>(
    sql: string,
    params?: readonly SqliteValue[],
  ): Promise<SqliteQueryResult<Row>>;
  transaction<T>(callback: (connection: SqliteConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
