import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteApprovalRepository} from '../data/repositories/SqliteApprovalRepository';
import {SqliteTaskRepository} from '../data/repositories/SqliteTaskRepository';
import {ApprovalRuntime} from '../runtime/task/ApprovalRuntime';
import {EventLogRuntime} from '../runtime/event/EventLogRuntime';
import {TaskRuntime} from '../runtime/task/TaskRuntime';
import {PushAttentionRuntime, validatePushPayload} from '../runtime/task/PushAttentionRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';

test('push payload accepts only opaque attention identifiers', () => {
  expect(validatePushPayload({kind: 'approval.required', taskId: 'task-1', attentionId: 'attention-1'})).toEqual({
    kind: 'approval.required',
    taskId: 'task-1',
    attentionId: 'attention-1',
  });
  expect(() => validatePushPayload({kind: 'task.updated', taskId: 'task-1', goal: 'secret task'})).toThrow();
});

test('opening a push event reads trusted local state instead of trusting push content', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const tasks = new SqliteTaskRepository(db);
  const taskRuntime = new TaskRuntime(tasks, new EventLogRuntime(tasks));
  const task = await taskRuntime.create({taskId: 'task-1', goal: 'Private task', source: 'mobile', phase: 'waiting'});
  const approvals = new ApprovalRuntime(new SqliteApprovalRepository(db));
  const runtime = new PushAttentionRuntime(taskRuntime, approvals);

  const opened = await runtime.open({kind: 'task.updated', taskId: task.taskId});
  expect(opened.task?.goal).toBe('Private task');
  await expect(runtime.open({kind: 'task.updated', taskId: 'missing-task'})).rejects.toMatchObject({code: 'storage_error'});
  await db.close();
});
