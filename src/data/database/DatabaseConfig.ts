export type DatabaseMode = 'production' | 'test';

export type DatabaseConfig = {
  readonly mode: DatabaseMode;
  readonly name: string;
};

export function createDatabaseConfig(mode: DatabaseMode): DatabaseConfig {
  return {
    mode,
    name: mode === 'test' ? 'cetamesh-mobile.test.sqlite' : 'cetamesh-mobile.sqlite',
  };
}

