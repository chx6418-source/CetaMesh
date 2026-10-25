import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteSyncQueueRepository} from '../data/repositories/SqliteSyncQueueRepository';
import {SyncQueueRuntime} from '../runtime/sync/SyncQueueRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';

test('sync queue is durable, idempotent, retry-bounded, and dead-letters exhausted events', async () => {
  let now = 1_000;
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const runtime = new SyncQueueRuntime(new SqliteSyncQueueRepository(db), () => now, {maxAttempts: 2, baseDelayMs: 100});

  await expect(runtime.enqueue({eventId: 'event-1', kind: 'task.updated', payload: {taskId: 'task-1'}})).resolves.toMatchObject({status: 'pending', attempts: 0});
  await expect(runtime.enqueue({eventId: 'event-1', kind: 'task.updated', payload: {taskId: 'task-1'}})).resolves.toMatchObject({status: 'pending'});
  const sending = await runtime.next();
  expect(sending).toMatchObject({eventId: 'event-1', status: 'sending', attempts: 1});
  await runtime.fail('event-1', 'network_unavailable');
  now += 100;
  const retry = await runtime.next();
  expect(retry).toMatchObject({eventId: 'event-1', status: 'sending', attempts: 2});
  await runtime.fail('event-1', 'timeout');
  expect(await runtime.next()).toBeUndefined();
  expect(await runtime.list()).toEqual([expect.objectContaining({eventId: 'event-1', status: 'dead-letter'})]);
  await db.close();
});

test('acked event cannot be replayed after a duplicate enqueue', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const runtime = new SyncQueueRuntime(new SqliteSyncQueueRepository(db));
  await runtime.enqueue({eventId: 'event-ack', kind: 'memory.updated', payload: {memoryId: 'memory-1'}});
  await runtime.next();
  await runtime.ack('event-ack');
  await runtime.enqueue({eventId: 'event-ack', kind: 'memory.updated', payload: {memoryId: 'memory-1'}});
  expect(await runtime.next()).toBeUndefined();
  await db.close();
});
