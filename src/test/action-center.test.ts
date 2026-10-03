import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteApprovalRepository} from '../data/repositories/SqliteApprovalRepository';
import {SqliteTaskRepository} from '../data/repositories/SqliteTaskRepository';
import {ApprovalRuntime} from '../runtime/task/ApprovalRuntime';
import {EventLogRuntime} from '../runtime/event/EventLogRuntime';
import {TaskRuntime} from '../runtime/task/TaskRuntime';
import {ActionCenterRuntime} from '../runtime/event/ActionCenterRuntime';
import {InMemoryCapabilityAuditLog} from '../domain/capability/CapabilityAudit';
import {NodeDatabase} from './helpers/NodeDatabase';

test('Action Center deterministically aggregates attention, approvals, completed tasks, and security events', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const tasksRepo = new SqliteTaskRepository(db);
  const tasks = new TaskRuntime(tasksRepo, new EventLogRuntime(tasksRepo));
  const approvals = new ApprovalRuntime(new SqliteApprovalRepository(db), () => Date.parse('2026-09-30T00:00:00.000Z'));
  const audit = new InMemoryCapabilityAuditLog();
  const blocked = await tasks.create({taskId: 'task-blocked', goal: 'Blocked work', source: 'mobile', phase: 'waiting'});
  await tasks.appendEvent({eventId: 'question-1', taskId: blocked.taskId, type: 'question.required', revision: 1, payload: {title: 'Need an answer', summary: 'Choose a path'}, createdAt: '2026-09-30T00:00:00.000Z'});
  const completed = await tasks.create({taskId: 'task-completed', goal: 'Finished work', source: 'mobile', phase: 'executing'});
  await tasks.update(completed.taskId, {status: 'completed', progress: 1, phase: 'finalizing'});
  await approvals.request({taskId: blocked.taskId, requestedBy: 'task-runtime', capability: 'camera.capture', scope: {kind: 'task', id: blocked.taskId}, risk: 'high', reason: 'Need one photo', expiresAt: '2026-09-30T00:05:00.000Z'});
  audit.record({eventId: 'security-1', type: 'denied', requestId: 'request-1', capability: 'camera.capture'});

  const runtime = new ActionCenterRuntime(tasks, approvals, audit);
  const items = await runtime.list();
  expect(items.map(item => item.kind)).toEqual(['approval', 'question', 'completed', 'security']);
  expect(new Set(items.map(item => item.actionId)).size).toBe(items.length);
  await db.close();
});
