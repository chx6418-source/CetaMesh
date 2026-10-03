import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteTaskRepository} from '../data/repositories/SqliteTaskRepository';
import {EventLogRuntime} from '../runtime/event/EventLogRuntime';
import {TaskRuntime} from '../runtime/task/TaskRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';

test('Task survives provider and session replacement with one stable task id', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const repository = new SqliteTaskRepository(db);
  const events = new EventLogRuntime(repository);
  const runtime = new TaskRuntime(repository, events);
  const task = await runtime.create({goal: 'Draft release notes', source: 'mobile', phase: 'planning'});

  await runtime.update(task.taskId, {
    status: 'running',
    phase: 'executing',
    progress: 0.4,
    providerExecutionRef: {
      providerId: 'provider-a',
      executionId: 'execution-a',
      sessionId: 'session-a',
      state: 'running',
    },
  });
  await runtime.switchExecution(task.taskId, {
    providerId: 'provider-b',
    executionId: 'execution-b',
    sessionId: 'session-b',
    state: 'running',
  });

  const updated = await runtime.get(task.taskId);
  expect(updated.taskId).toBe(task.taskId);
  expect(updated.providerExecutionRef).toMatchObject({providerId: 'provider-b', sessionId: 'session-b'});
  expect((await repository.events(task.taskId)).map(item => item.type)).toEqual([
    'task.created',
    'task.progress',
    'task.provider_changed',
    'task.session_changed',
  ]);
  await db.close();
});

test('attention events aggregate once and can be resolved', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const repository = new SqliteTaskRepository(db);
  const events = new EventLogRuntime(repository);
  await repository.create({taskId: 'task-1', goal: 'Need a decision', source: 'mobile', phase: 'waiting'});
  const attentionEvent = {
    eventId: 'attention-event',
    taskId: 'task-1',
    type: 'approval.required' as const,
    revision: 1,
    payload: {title: 'Allow camera?', summary: 'One capture'},
    createdAt: '2026-09-30T00:00:00.000Z',
  };
  await expect(events.append(attentionEvent)).resolves.toBe(true);
  await expect(events.append(attentionEvent)).resolves.toBe(false);
  expect(await events.listNeedsAttention('task-1')).toHaveLength(1);
  await events.resolveNeedsAttention('attention-event');
  expect(await events.listNeedsAttention('task-1')).toHaveLength(0);
  await db.close();
});
