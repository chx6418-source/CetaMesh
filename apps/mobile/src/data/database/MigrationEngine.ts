import {CetaError} from '../../shared/errors/CetaError';
import type {Migration} from '../migrations/Migration';
import type {SqliteConnection} from './SqliteConnection';

const CREATE_SCHEMA_VERSION =
  'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)';
const READ_SCHEMA_VERSION =
  'SELECT version FROM schema_version WHERE id = 1';

function validateMigrations(migrations: readonly Migration[]): void {
  const versions = new Set<number>();

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new CetaError(
        'storage_error',
        `Migration version must be a positive integer: ${migration.version}`,
      );
    }

    if (versions.has(migration.version)) {
      throw new CetaError(
        'storage_error',
        `Duplicate migration version: ${migration.version}`,
      );
    }

    versions.add(migration.version);
  }
}

export type MigrationResult = {
  readonly version: number;
};

export async function migrateDatabase(
  database: SqliteConnection,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  validateMigrations(migrations);
  await database.executeAsync(CREATE_SCHEMA_VERSION);

  const versionResult = await database.executeAsync<{version: number}>(READ_SCHEMA_VERSION);
  let currentVersion = versionResult.results[0]?.version ?? 0;

  if (versionResult.results.length === 0) {
    await database.executeAsync('INSERT INTO schema_version (id, version) VALUES (1, 0)');
  }

  const pendingMigrations = [...migrations]
    .filter(migration => migration.version > currentVersion)
    .sort((left, right) => left.version - right.version);

  for (const migration of pendingMigrations) {
    await database.transaction(async transaction => {
      for (const statement of migration.statements) {
        await transaction.executeAsync(statement);
      }

      await transaction.executeAsync(
        `UPDATE schema_version SET version = ${migration.version} WHERE id = 1`,
      );
    });
    currentVersion = migration.version;
  }

  return {version: currentVersion};
}

export const bootstrapDatabase = migrateDatabase;
