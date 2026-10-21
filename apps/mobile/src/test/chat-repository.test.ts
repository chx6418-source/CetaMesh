/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDatabase } from './helpers/NodeDatabase';
import { migrateDatabase } from '../data/database/MigrationEngine';
import { appMigrations } from '../data/migrations/AppMigrations';
import { SqliteChatRepository } from '../data/repositories/SqliteChatRepository';
import { SqliteProviderRepository } from '../data/repositories/SqliteProviderRepository';
import { SessionRuntime } from '../runtime/session/SessionRuntime';
const config = {
  mode: 'chat' as const,
  modelProviderId: 'p',
  modelId: 'm',
  reasoning: 'high' as const,
};
async function setup(path?: string) {
  const db = new NodeDatabase(path);
  await migrateDatabase(db, appMigrations);
  return { db, repo: new SqliteChatRepository(db) };
}
test('CRUD, archive and pagination preserve independent configs with parameterized titles', async () => {
  const { db, repo } = await setup();
  const a = await repo.create(
    config,
    "O'Reilly'); DROP TABLE chat_sessions;--",
  );
  const b = await repo.create({ ...config, reasoning: 'fast' }, 'Second');
  expect(await repo.list({ limit: 1 })).toHaveLength(1);
  expect(await repo.list({ limit: 1, offset: 1 })).toHaveLength(1);
  await repo.rename(a.id, 'Renamed');
  expect((await repo.get(a.id)).title).toBe('Renamed');
  await repo.archive(a.id, true);
  expect((await repo.list()).map(s => s.id)).toEqual([b.id]);
  expect(await repo.list({ archived: true })).toHaveLength(1);
  expect((await repo.get(b.id)).config.reasoning).toBe('fast');
  await repo.delete(a.id);
  await expect(repo.get(a.id)).rejects.toMatchObject({ code: 'storage_error' });
  await db.close();
});
test('real file-backed SQLite survives closing and reopening, migration rerun, and interrupted turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceta-m1-test-'));
  const path = join(dir, 'isolated.sqlite');
  try {
    const first = await setup(path);
    const session = await first.repo.create(config, 'Persist');
    const turn = await first.repo.beginTurn(session.id, 'Hello', []);
    await first.repo.finishTurn(turn.assistant.id, 'partial', 'streaming');
    await first.db.close();
    const second = await setup(path);
    await second.repo.recoverInterrupted();
    expect((await second.repo.get(session.id)).config).toEqual(config);
    expect(
      (await second.repo.messages(session.id)).map(m => [
        m.role,
        m.content,
        m.status,
      ]),
    ).toEqual([
      ['user', 'Hello', 'completed'],
      ['assistant', 'partial', 'failed'],
    ]);
    const retry = await second.repo.retryTurn(session.id);
    expect(retry.user.id).toBe(turn.user.id);
    expect(await second.repo.messages(session.id)).toHaveLength(2);
    await second.repo.finishTurn(retry.assistant.id, 'Done', 'completed');
    await second.repo.delete(session.id);
    expect(await second.repo.messages(session.id)).toEqual([]);
    await second.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('concurrent turns reject duplication, active sessions cannot be mutated, pagination is stable', async () => {
  const { db, repo } = await setup();
  const s = await repo.create(config, 'Test');
  const results = await Promise.allSettled([
    repo.beginTurn(s.id, 'one', []),
    repo.beginTurn(s.id, 'two', []),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  await expect(repo.delete(s.id)).rejects.toMatchObject({
    code: 'sync_conflict',
  });
  const messages = await repo.messages(s.id, { limit: 1 });
  expect(messages[0].role).toBe('assistant');
  const older = await repo.messages(s.id, {
    limit: 1,
    before: messages[0].sequence,
  });
  expect(older[0].role).toBe('user');
  await db.close();
});
test('provider repository projects permitted fields and session runtime validates settings', async () => {
  const { db, repo } = await setup();
  const providers = new SqliteProviderRepository(db);
  await providers.save({
    id: 'p',
    name: 'Provider',
    baseUrl: 'https://example.com/v1',
    credentialRef: 'provider:p',
    supportsReasoning: false,
    ...{ apiKey: 'NEVER_PERSIST' },
  });
  const rows = await db.executeAsync('SELECT * FROM model_providers');
  expect(JSON.stringify(rows)).not.toContain('NEVER_PERSIST');
  const runtime = new SessionRuntime(repo);
  await expect(
    runtime.create({ ...config, modelId: '' }),
  ).rejects.toMatchObject({ code: 'invalid_protocol' });
  await expect(repo.list({ limit: 0 })).rejects.toThrow();
  await db.close();
});
