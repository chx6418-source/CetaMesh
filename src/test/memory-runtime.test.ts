import { NodeDatabase } from './helpers/NodeDatabase';
import { migrateDatabase } from '../data/database/MigrationEngine';
import { appMigrations } from '../data/migrations/AppMigrations';
import { SqliteMemoryRepository } from '../data/repositories/SqliteMemoryRepository';
import { MemoryRuntime } from '../runtime/memory/MemoryRuntime';
import type { MemoryInput } from '../domain/memory/Memory';
import { assembleServices } from '../app/bootstrap/assembleServices';
async function setup() {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  return { db, memory: new MemoryRuntime(new SqliteMemoryRepository(db)) };
}
test('runtime enforces local-only and validates text/scores before persistence', async () => {
  const { db, memory } = await setup();
  for (const input of [
    { kind: 'local', content: 'Fact', scope: 'my-devices' },
    { kind: 'local', content: ' ' },
    { kind: 'local', content: 'x'.repeat(16001) },
    { kind: 'local', content: 'Fact', confidence: NaN },
    { kind: 'local', content: 'api_key: DO_NOT_STORE' },
    { kind: 'local', content: '密码：abc123' },
    {
      kind: 'local',
      content: 'Fact',
      source: { kind: 'chat', sessionId: 's', messageIds: [] },
    },
  ]) {
    await expect(memory.save(input as MemoryInput)).rejects.toMatchObject({
      code: 'invalid_protocol',
    });
  }
  expect(await memory.search()).toEqual([]);
  const value = await memory.save({ kind: 'user', content: '我喜欢茶' });
  expect(value.scope).toBe('local-only');
  await expect(
    memory.update(value.id, { content: 'api_key: SECRET' }, value.revision),
  ).rejects.toMatchObject({ code: 'invalid_protocol' });
  await db.close();
  await expect(memory.search()).rejects.toMatchObject({
    code: 'storage_error',
  });
});
test('events contain correlation IDs but no body; pin protects automatic edits while user can correct', async () => {
  const { db, memory } = await setup();
  const events: unknown[] = [];
  const off = memory.subscribe(e => {
    events.push(e);
  });
  const a = await memory.save({ kind: 'working', content: 'PRIVATE_FACT' });
  const b = await memory.pin(a.id, true, a.revision);
  await expect(
    memory.update(a.id, { content: 'Auto' }, b.revision, 'automatic'),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  const corrected = await memory.update(a.id, { content: 'User' }, b.revision);
  await expect(memory.delete(a.id, b.revision)).rejects.toMatchObject({
    code: 'sync_conflict',
  });
  await memory.delete(a.id, corrected.revision);
  expect(events).toHaveLength(4);
  expect(events[0]).toMatchObject({
    memoryId: a.id,
    traceId: expect.any(String),
    eventId: expect.any(String),
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE_FACT');
  expect(JSON.stringify(events)).not.toContain('content');
  off();
  await memory.save({ kind: 'task', content: 'Local task note' });
  expect(events).toHaveLength(4);
  await db.close();
});
test('production composition exposes offline memory without a configured model', async () => {
  const app = await assembleServices(
    new NodeDatabase(),
    { get: async () => null, set: async () => {}, delete: async () => {} },
    {
      json: async () => {
        throw new Error('Network must not run');
      },
      stream: async function* () {
        throw new Error('Network must not run');
      },
    },
  );
  await app.memory.save({ kind: 'local', content: 'Offline' });
  expect((await app.memory.search())[0].content).toBe('Offline');
  await app.close();
});
test('English labelled credentials are rejected by manual save and update', async () => {
  const { db, memory } = await setup();
  const a = await memory.save({ kind: 'local', content: 'Safe fact' });
  for (const content of [
    'my API key is DUMMY_TEST_VALUE',
    'my password is DUMMY_TEST_VALUE',
  ]) {
    await expect(memory.save({ kind: 'local', content })).rejects.toMatchObject(
      { code: 'invalid_protocol' },
    );
    await expect(
      memory.update(a.id, { content }, a.revision),
    ).rejects.toMatchObject({ code: 'invalid_protocol' });
  }
  expect((await memory.search()).map(m => m.content)).toEqual(['Safe fact']);
  await db.close();
});
