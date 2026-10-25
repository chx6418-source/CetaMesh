declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): {changes: number | bigint};
    };
    close(): void;
  }
}
