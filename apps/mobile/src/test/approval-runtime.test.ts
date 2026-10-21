import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteApprovalRepository} from '../data/repositories/SqliteApprovalRepository';
import {SqliteTaskRepository} from '../data/repositories/SqliteTaskRepository';
import {ApprovalRuntime} from '../runtime/task/ApprovalRuntime';
import {NodeDatabase} from './helpers/NodeDatabase';

async function fixture(clock = () => Date.parse('2026-09-30T00:00:00.000Z')) {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const tasks = new SqliteTaskRepository(db);
  await tasks.create({taskId: 'task-1', goal: 'Capture a document', source: 'mobile', phase: 'waiting'});
  return {db, runtime: new ApprovalRuntime(new SqliteApprovalRepository(db), clock)};
}

test('approval is bound to Task and scope, and replay has no second side effect', async () => {
  const fixtureValue = await fixture();
  const approval = await fixtureValue.runtime.request({
    taskId: 'task-1',
    requestedBy: 'task-runtime',
    capability: 'camera.capture',
    scope: {kind: 'task', id: 'task-1'},
    target: 'mobile-1',
    risk: 'high',
    reason: 'Capture one document',
    expiresAt: '2026-09-30T00:05:00.000Z',
  });

  await expect(fixtureValue.runtime.decide(approval.approvalId, 'approve-once')).resolves.toMatchObject({status: 'approved'});
  await expect(fixtureValue.runtime.decide(approval.approvalId, 'deny')).resolves.toMatchObject({status: 'approved'});
  await expect(fixtureValue.runtime.consume(approval.approvalId, approval.nonce)).resolves.toMatchObject({status: 'consumed'});
  await expect(fixtureValue.runtime.consume(approval.approvalId, approval.nonce)).resolves.toMatchObject({status: 'consumed'});
  await fixtureValue.db.close();
});

test('expired approval cannot be approved or consumed', async () => {
  let now = Date.parse('2026-09-30T00:00:00.000Z');
  const fixtureValue = await fixture(() => now);
  const approval = await fixtureValue.runtime.request({
    taskId: 'task-1',
    requestedBy: 'task-runtime',
    capability: 'microphone.record',
    scope: {kind: 'task', id: 'task-1'},
    risk: 'high',
    reason: 'Record a note',
    expiresAt: '2026-09-30T00:00:10.000Z',
  });
  now += 11_000;

  await expect(fixtureValue.runtime.expire(approval.approvalId)).resolves.toMatchObject({status: 'expired'});
  await expect(fixtureValue.runtime.decide(approval.approvalId, 'approve-once')).resolves.toMatchObject({status: 'expired'});
  await expect(fixtureValue.runtime.consume(approval.approvalId, approval.nonce)).rejects.toMatchObject({code: 'permission_denied'});
  await fixtureValue.db.close();
});

test('cancelled approval stays cancelled on replay', async () => {
  const fixtureValue = await fixture();
  const approval = await fixtureValue.runtime.request({
    taskId: 'task-1',
    requestedBy: 'task-runtime',
    capability: 'notification.send',
    scope: {kind: 'task', id: 'task-1'},
    risk: 'medium',
    reason: 'Notify the user',
    expiresAt: '2026-09-30T00:05:00.000Z',
  });
  await expect(fixtureValue.runtime.cancel(approval.approvalId)).resolves.toMatchObject({status: 'cancelled'});
  await expect(fixtureValue.runtime.decide(approval.approvalId, 'approve-once')).resolves.toMatchObject({status: 'cancelled'});
  await fixtureValue.db.close();
});
