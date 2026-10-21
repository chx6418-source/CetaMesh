import type {ExtensionManifest} from '../domain/extension/ExtensionManifest';
import type {
  ExtensionRepository,
  InstalledExtension,
} from '../domain/extension/ExtensionRepository';
import {ExtensionInstallRuntime} from '../runtime/extension/ExtensionInstallRuntime';
import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteExtensionRepository} from '../data/repositories/SqliteExtensionRepository';
import {NodeDatabase} from './helpers/NodeDatabase';
import {createHash} from 'node:crypto';

const manifest: ExtensionManifest = {
  id: 'tool.weather',
  name: 'Weather Tool',
  version: '1.0.0',
  type: 'declarative-tool',
  publisher: 'publisher-1',
  platforms: ['android', 'ios'],
  runtime: 'declarative',
  permissions: [],
  capabilities: [],
  networkAccess: {mode: 'none'},
  inputSchema: {type: 'object'},
  outputSchema: {type: 'object'},
  minimumProtocolVersion: 1,
};

class FakeExtensionRepository implements ExtensionRepository {
  readonly records = new Map<string, InstalledExtension>();
  failAfterSave = false;

  private key(extensionId: string, source: InstalledExtension['source']): string {
    return `${extensionId}:${source}`;
  }

  async get(extensionId: string, source: InstalledExtension['source']): Promise<InstalledExtension | undefined> {
    return this.records.get(this.key(extensionId, source));
  }

  async save(extension: InstalledExtension): Promise<InstalledExtension> {
    this.records.set(this.key(extension.id, extension.source), extension);
    if (this.failAfterSave) {
      throw new Error('simulated storage failure');
    }
    return extension;
  }

  async remove(extensionId: string, source: InstalledExtension['source']): Promise<void> {
    this.records.delete(this.key(extensionId, source));
  }

  async list(): Promise<InstalledExtension[]> {
    return [...this.records.values()];
  }
}

const clock = () => Date.parse('2026-09-30T00:00:00.000Z');

test('install produces a bounded security report and deterministic content hash', async () => {
  const repository = new FakeExtensionRepository();
  const runtime = new ExtensionInstallRuntime(repository, undefined, clock);

  const packageData = {manifest, declaration: 'safe'};
  const installed = await runtime.install({
    manifest,
    source: 'base',
    packageData,
    publisherMetadata: {signatureState: 'verified'},
  });

  expect(installed.status).toBe('disabled');
  expect(installed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(installed.contentHash).toBe(createHash('sha256').update(JSON.stringify({manifest: JSON.stringify(manifest), package: JSON.stringify(packageData)})).digest('hex'));
  expect(installed.securityReport).toMatchObject({
    source: 'base',
    publisher: 'publisher-1',
    signatureState: 'verified',
    risk: 'low',
    requiresPermissionConfirmation: false,
  });
  expect(installed.securityReport.contentHash).toBe(installed.contentHash);
});

test('install rejects executable payloads before persistence', async () => {
  const repository = new FakeExtensionRepository();
  const runtime = new ExtensionInstallRuntime(repository, undefined, clock);

  await expect(runtime.install({
    manifest,
    source: 'import',
    packageData: {declaration: {script: 'do-not-run'}},
  })).rejects.toMatchObject({code: 'unsupported'});
  await expect(repository.list()).resolves.toHaveLength(0);
});

test('install rolls back a repository write when persistence fails', async () => {
  const repository = new FakeExtensionRepository();
  repository.failAfterSave = true;
  const runtime = new ExtensionInstallRuntime(repository, undefined, clock);

  await expect(runtime.install({manifest, source: 'import'})).rejects.toMatchObject({code: 'storage_error'});
  await expect(repository.list()).resolves.toHaveLength(0);
});

test('SQLite extension records migrate idempotently and survive reopen with source isolation', async () => {
  const {mkdtempSync, rmSync} = require('node:fs');
  const {tmpdir} = require('node:os');
  const {join} = require('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'cetamesh-m8-extension-'));
  const path = join(directory, 'extensions.sqlite');
  try {
    const first = new NodeDatabase(path);
    await migrateDatabase(first, appMigrations);
    const runtime = new ExtensionInstallRuntime(new SqliteExtensionRepository(first), undefined, clock);
    await runtime.install({manifest, source: 'base'});
    await runtime.install({manifest: {...manifest, name: 'Overlay Weather'}, source: 'user-overlay'});
    await migrateDatabase(first, appMigrations);
    await first.close();

    const second = new NodeDatabase(path);
    await migrateDatabase(second, appMigrations);
    const repository = new SqliteExtensionRepository(second);
    await expect(repository.get(manifest.id, 'base')).resolves.toMatchObject({source: 'base', manifest});
    await expect(repository.get(manifest.id, 'user-overlay')).resolves.toMatchObject({source: 'user-overlay', manifest: {...manifest, name: 'Overlay Weather'}});
    await expect(second.executeAsync<{version: number}>('SELECT version FROM schema_version')).resolves.toEqual({results: [{version: 12}]});
    await second.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
