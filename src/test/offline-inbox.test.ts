import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteOfflineInboxRepository} from '../data/repositories/SqliteOfflineInboxRepository';
import {OfflineInboxRuntime} from '../runtime/inbox/OfflineInboxRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('offline share and Quick Memory inputs survive failure and restart locally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cetamesh-inbox-'));
  const path = join(directory, 'inbox.sqlite');
  try {
    const db = new NodeDatabase(path);
    await migrateDatabase(db, appMigrations);
    const runtime = new OfflineInboxRuntime(new SqliteOfflineInboxRepository(db));
    const item = await runtime.accept({kind: 'quick-memory', payload: {type: 'text', text: 'Remember this offline'}});
    expect(item).toMatchObject({status: 'pending', localOnly: true});
    await runtime.fail(item.inboxId, 'network_unavailable');
    await expect(runtime.retry(item.inboxId)).resolves.toMatchObject({status: 'pending', localOnly: true});
    await db.close();

    const reopened = new NodeDatabase(path);
    await migrateDatabase(reopened, appMigrations);
    await expect(new OfflineInboxRuntime(new SqliteOfflineInboxRepository(reopened)).list()).resolves.toEqual([expect.objectContaining({inboxId: item.inboxId, status: 'pending', localOnly: true})]);
    await reopened.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('failed input remains recoverable and cannot be implicitly marked for sync', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const runtime = new OfflineInboxRuntime(new SqliteOfflineInboxRepository(db));
  const item = await runtime.accept({kind: 'share', payload: {type: 'file', name: 'note.txt', uri: 'content://provider/note'}});
  await runtime.fail(item.inboxId, 'unsupported');
  expect(await runtime.list()).toEqual([expect.objectContaining({status: 'failed', localOnly: true, payload: {type: 'file', name: 'note.txt', uri: 'content://provider/note'}})]);
  await db.close();
});
