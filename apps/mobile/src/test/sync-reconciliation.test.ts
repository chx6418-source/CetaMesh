import {MemorySyncRuntime} from '../runtime/sync/MemorySyncRuntime';
import {TaskSyncRuntime} from '../runtime/sync/TaskSyncRuntime';
import {reconcileVersioned} from '../runtime/sync/ReconciliationRuntime';
import {PresenceRuntime} from '../runtime/sync/PresenceRuntime';
import type {MemorySyncObject} from '../domain/sync';
import type {DeviceTrust} from '../domain/device/DeviceTrust';
import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {SqliteMemorySyncRepository} from '../data/repositories/SqliteMemorySyncRepository';
import {SqliteTaskSyncRepository} from '../data/repositories/SqliteTaskSyncRepository';
import {NodeDatabase} from './helpers/NodeDatabase';

const memory = (overrides: Partial<MemorySyncObject> = {}): MemorySyncObject => ({
  objectType: 'memory',
  memoryId: 'memory-1',
  ownerId: 'mobile-1',
  scopeType: 'my-devices',
  scopeId: 'mesh-1',
  revision: 1,
  source: 'manual',
  policy: 'my-devices',
  content: 'remember this locally across my devices',
  updatedAt: '2026-09-30T00:00:00.000Z',
  ...overrides,
});

test('Memory scope is authorized before retrieval or conflict resolution', async () => {
  let reads = 0;
  const applied: MemorySyncObject[] = [];
  const runtime = new MemorySyncRuntime(
    {
      get: async () => {reads += 1; return undefined;},
      upsert: async object => {applied.push(object);},
    },
    async () => false,
  );

  await expect(runtime.apply(memory())).resolves.toMatchObject({status: 'denied'});
  expect(reads).toBe(0);
  expect(applied).toHaveLength(0);
  await expect(runtime.apply(memory({scopeType: 'local-only' as never}))).resolves.toMatchObject({status: 'denied'});
});

test('Memory sync distinguishes applied, duplicate, stale, and conflicting revisions', async () => {
  let current: MemorySyncObject | undefined;
  const runtime = new MemorySyncRuntime(
    {get: async () => current, upsert: async object => {current = object;}},
    async () => true,
  );

  await expect(runtime.apply(memory())).resolves.toMatchObject({status: 'applied'});
  await expect(runtime.apply(memory())).resolves.toMatchObject({status: 'duplicate'});
  await expect(runtime.apply(memory({revision: 0}))).resolves.toMatchObject({status: 'stale'});
  await expect(runtime.apply(memory({content: 'different'}))).resolves.toMatchObject({status: 'conflict'});
  await expect(runtime.apply(memory({revision: 2, deleted: true, content: undefined}))).resolves.toMatchObject({status: 'applied'});
  await expect(runtime.apply(memory({content: 42 as never}))).rejects.toMatchObject({code: 'invalid_protocol'});
});

test('Task sync snapshot is bounded to state metadata and excludes transcript', () => {
  const runtime = new TaskSyncRuntime({get: async () => undefined, upsert: async () => undefined});
  const snapshot = runtime.toSnapshot({
    taskId: 'task-1',
    goal: 'Continue release notes',
    status: 'running',
    phase: 'executing',
    progress: 0.5,
    source: 'desktop-node',
    providerExecutionRef: {providerId: 'provider-a', executionId: 'exec-a', sessionId: 'session-a', state: 'running', contextUsage: {usedTokens: 10, limitTokens: 100}},
    revision: 3,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  }, 'desktop-1', 'mesh-1', [{artifactId: 'artifact-1', kind: 'text', name: 'summary.txt', size: 10}], [{attentionId: 'attention-1', taskId: 'task-1', kind: 'task.blocked', title: 'Blocked', status: 'pending', createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z'}]);
  expect(snapshot).toMatchObject({taskId: 'task-1', providerExecutionRef: {sessionId: 'session-a'}, artifacts: [{artifactId: 'artifact-1'}]});
  expect(snapshot).not.toHaveProperty('transcript');
});

test('malformed Task sync state becomes a standard protocol error before storage access', async () => {
  let reads = 0;
  const runtime = new TaskSyncRuntime({get: async () => {reads += 1; return undefined;}, upsert: async () => undefined});
  const valid = runtime.toSnapshot({taskId: 'task-1', goal: 'Sync state', status: 'running', phase: 'executing', progress: 0.2, source: 'desktop-node', revision: 1, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z'}, 'desktop-1', 'mesh-1');
  await expect(runtime.apply({...valid, needsAttention: undefined as never})).rejects.toMatchObject({code: 'invalid_protocol'});
  expect(reads).toBe(0);
});

test('revision reconciliation does not silently overwrite same-version conflicts', () => {
  const current = {revision: 2, value: 'a'};
  expect(reconcileVersioned(current, {revision: 1, value: 'b'})).toBe('stale');
  expect(reconcileVersioned(current, {revision: 2, value: 'a'})).toBe('duplicate');
  expect(reconcileVersioned(current, {revision: 2, value: 'b'})).toBe('conflict');
  expect(reconcileVersioned(current, {revision: 3, value: 'b'})).toBe('applied');
});

test('presence status is derived separately from trust state', () => {
  const base: DeviceTrust = {
    deviceId: 'peer-1', deviceName: 'Desktop', publicKey: 'B' + 'A'.repeat(86) + '=', endpoint: 'https://desktop.example', localDeviceId: 'mobile-1', localPublicKey: 'B' + 'A'.repeat(86) + '=', createdAt: '2026-09-30T00:00:00.000Z', trustState: 'trusted', lastSeenAt: '2026-09-30T00:00:00.000Z',
  };
  const runtime = new PresenceRuntime(() => Date.parse('2026-09-30T00:01:00.000Z'));
  expect(runtime.derive(base).status).toBe('stale');
  expect(runtime.derive({...base, trustState: 'revoked'}).status).toBe('revoked');
  expect(runtime.derive({...base, lastSeenAt: '2026-09-30T00:00:55.000Z'}).status).toBe('online');
});

test('approved Memory and Task sync objects survive SQLite reopen', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const memoryRuntime = new MemorySyncRuntime(new SqliteMemorySyncRepository(db), async () => true);
  const taskRuntime = new TaskSyncRuntime(new SqliteTaskSyncRepository(db));
  await memoryRuntime.apply(memory());
  const snapshot = taskRuntime.toSnapshot({taskId: 'task-1', goal: 'Sync state', status: 'running', phase: 'executing', progress: 0.2, source: 'desktop-node', revision: 1, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z'}, 'desktop-1', 'mesh-1');
  await taskRuntime.apply(snapshot);
  expect(await new SqliteMemorySyncRepository(db).get('memory-1')).toMatchObject({scopeType: 'my-devices', revision: 1});
  expect(await new SqliteTaskSyncRepository(db).get('task-1')).toMatchObject({taskId: 'task-1', progress: 0.2});
  await db.close();
});
