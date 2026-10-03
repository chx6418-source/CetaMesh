import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteTaskRepository} from '../data/repositories/SqliteTaskRepository';
import {NodeDatabase} from './helpers/NodeDatabase';

const event = {
  eventId: 'event-1',
  taskId: 'task-1',
  type: 'task.created' as const,
  revision: 1,
  payload: {source: 'mobile'},
  createdAt: '2026-09-30T00:00:00.000Z',
};

test('task repository persists task state and deduplicates event ids', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const repository = new SqliteTaskRepository(db);
  const task = await repository.create({
    taskId: 'task-1',
    goal: 'Prepare a release summary',
    source: 'mobile',
    phase: 'planning',
  });

  expect(task).toMatchObject({taskId: 'task-1', status: 'queued', progress: 0});
  await repository.update('task-1', {status: 'running', phase: 'executing', progress: 0.25}, 1);
  expect(await repository.get('task-1')).toMatchObject({status: 'running', revision: 2});
  await expect(repository.appendEvent(event)).resolves.toBe(true);
  await expect(repository.appendEvent(event)).resolves.toBe(false);
  await expect(repository.events('task-1')).resolves.toHaveLength(1);
  await db.close();
});

test('attention records are bounded and idempotent', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const repository = new SqliteTaskRepository(db);
  await repository.create({taskId: 'task-1', goal: 'Wait for approval', source: 'mobile', phase: 'waiting'});

  const attention = {
    attentionId: 'attention-1',
    taskId: 'task-1',
    kind: 'approval.required' as const,
    title: 'Approval required',
    summary: 'Camera capture needs approval',
    status: 'pending' as const,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
  await expect(repository.upsertAttention(attention)).resolves.toBe(true);
  await expect(repository.upsertAttention(attention)).resolves.toBe(false);
  await expect(repository.listAttention('task-1')).resolves.toEqual([attention]);
  await db.close();
});
