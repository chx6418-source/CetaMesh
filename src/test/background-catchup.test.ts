import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteOfflineInboxRepository} from '../data/repositories/SqliteOfflineInboxRepository';
import {SqliteSyncQueueRepository} from '../data/repositories/SqliteSyncQueueRepository';
import {BackgroundCatchupRuntime} from '../runtime/sync/BackgroundCatchupRuntime';
import {OfflineInboxRuntime} from '../runtime/inbox/OfflineInboxRuntime';
import {SyncQueueRuntime} from '../runtime/sync/SyncQueueRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';

test('background catch-up recovers interrupted queue and inbox work within a bounded budget', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const queue = new SyncQueueRuntime(new SqliteSyncQueueRepository(db), () => 1_000);
  const inbox = new OfflineInboxRuntime(new SqliteOfflineInboxRepository(db));
  await queue.enqueue({eventId: 'sync-1', kind: 'task.updated', payload: {taskId: 'task-1'}});
  await queue.next();
  const item = await inbox.accept({kind: 'share', payload: {type: 'text', value: 'offline'}});
  await inbox.process(item.inboxId);
  const runtime = new BackgroundCatchupRuntime(queue, inbox, {maxWork: 1, now: () => 1_000});

  await expect(runtime.resume()).resolves.toMatchObject({processed: 1, bounded: true});
  expect(await queue.list()).toEqual([expect.objectContaining({status: 'failed', lastError: 'interrupted'})]);
  expect(await inbox.get(item.inboxId)).toMatchObject({status: 'pending'});
  await db.close();
});

test('background catch-up does not open a WebSocket or start recording', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const queue = new SyncQueueRuntime(new SqliteSyncQueueRepository(db), () => 1_000);
  const inbox = new OfflineInboxRuntime(new SqliteOfflineInboxRepository(db));
  const runtime = new BackgroundCatchupRuntime(queue, inbox, {maxWork: 0, now: () => 1_000});
  await expect(runtime.resume()).resolves.toMatchObject({processed: 0, bounded: true});
  await db.close();
});
