/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDatabase } from './helpers/NodeDatabase';
import { migrateDatabase } from '../data/database/MigrationEngine';
import { appMigrations } from '../data/migrations/AppMigrations';
import { SqliteMemoryRepository } from '../data/repositories/SqliteMemoryRepository';
import { SqliteChatRepository } from '../data/repositories/SqliteChatRepository';
async function setup(path?: string) {
  const db = new NodeDatabase(path);
  await migrateDatabase(db, appMigrations);
  return { db, repo: new SqliteMemoryRepository(db) };
}
test('CRUD, kind/source filters and literal Unicode/wildcard queries are parameterized', async () => {
  const { db, repo } = await setup();
  const a = await repo.create({
    kind: 'local',
    content: "乌龙茶 100% _ ' OR 1=1 --",
    importance: 0.8,
  });
  const b = await repo.create({
    kind: 'user',
    content: 'Tea preference',
    source: { kind: 'chat', sessionId: 'chat1', messageIds: ['u'] },
  });
  expect((await repo.search({ query: '乌龙茶' })).map(m => m.id)).toEqual([
    a.id,
  ]);
  expect((await repo.search({ query: '% _' })).map(m => m.id)).toEqual([a.id]);
  expect(await repo.search({ query: "' OR 1=1 --" })).toHaveLength(1);
  expect(
    (
      await repo.search({
        query: 'TEA',
        kind: 'user',
        sourceSessionId: 'chat1',
      })
    )[0].id,
  ).toBe(b.id);
  expect(await repo.search({ query: 'absent' })).toEqual([]);
  expect((await repo.search({ limit: 1 })).length).toBe(1);
  expect((await repo.search({ limit: 1, offset: 1 })).length).toBe(1);
  const edited = await repo.update(
    a.id,
    { content: 'Edited' },
    a.revision,
    'user',
  );
  expect(edited.content).toBe('Edited');
  expect(edited.revision).toBe(2);
  await repo.delete(a.id, edited.revision, 'user');
  await expect(repo.get(a.id)).rejects.toMatchObject({ code: 'storage_error' });
  await db.close();
});
test('pin and optimistic revisions prevent stale or automatic changes atomically', async () => {
  const { db, repo } = await setup();
  const a = await repo.create({ kind: 'chat', content: 'A fact' });
  const pinned = await repo.pin(a.id, true, a.revision);
  await expect(
    repo.update(a.id, { content: 'stale' }, a.revision, 'user'),
  ).rejects.toMatchObject({ code: 'sync_conflict' });
  await expect(
    repo.update(a.id, { content: 'automatic' }, pinned.revision, 'automatic'),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(
    repo.delete(a.id, pinned.revision, 'automatic'),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  const newer = await repo.update(
    a.id,
    { content: 'User correction' },
    pinned.revision,
    'user',
  );
  expect(newer.pinned).toBe(true);
  const race = await Promise.allSettled([
    repo.update(a.id, { content: 'one' }, newer.revision, 'user'),
    repo.update(a.id, { content: 'two' }, newer.revision, 'user'),
  ]);
  expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const unpinned = await repo.create({
    kind: 'local',
    content: 'Recent',
    importance: 1,
  });
  expect((await repo.search())[0].id).toBe(a.id);
  expect(unpinned.pinned).toBe(false);
  await expect(repo.search({ limit: 0 })).rejects.toMatchObject({
    code: 'invalid_protocol',
  });
  await expect(
    repo.update(a.id, { importance: 2 }, 4, 'user'),
  ).rejects.toMatchObject({ code: 'invalid_protocol' });
  await db.close();
});
test('candidate saves deduplicate without overwriting pin/content and survive isolated reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceta-m2-'));
  try {
    const file = join(dir, 'test.sqlite');
    const first = await setup(file);
    const chat = new SqliteChatRepository(first.db);
    const s = await chat.create({
      mode: 'chat',
      modelProviderId: 'p',
      modelId: 'm',
      reasoning: 'standard',
    });
    const turn = await chat.beginTurn(s.id, 'Remember tea', []);
    await chat.finishTurn(turn.assistant.id, 'Okay', 'completed');
    const evidence = {
      sessionId: s.id,
      messageId: turn.user.id,
      originalContent: 'Remember tea',
    };
    const input = {
      kind: 'chat' as const,
      content: 'Remember tea',
      source: {
        kind: 'chat' as const,
        sessionId: s.id,
        messageIds: [turn.user.id],
      },
    };
    const a = await first.repo.saveCandidate(input, evidence);
    await first.repo.pin(a.id, true, a.revision);
    const duplicate = await first.repo.saveCandidate(
      {
        ...input,
        importance: 1,
      },
      evidence,
    );
    expect(duplicate.id).toBe(a.id);
    expect(duplicate.importance).toBe(0.5);
    await chat.delete(s.id);
    expect((await first.repo.get(a.id)).pinned).toBe(true);
    await first.db.close();
    const second = await setup(file);
    expect((await second.repo.get(a.id)).pinned).toBe(true);
    expect((await second.repo.get(a.id)).source).toEqual(input.source);
    const isolated = await setup();
    expect(await isolated.repo.search()).toEqual([]);
    await isolated.db.close();
    await second.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('identical accented, Cyrillic and Greek text remains searchable alongside ASCII folding', async () => {
  const { db, repo } = await setup();
  for (const content of ['Éclair', 'МОСКВА', 'Σπίτι']) {
    const saved = await repo.create({ kind: 'local', content });
    expect((await repo.search({ query: content })).map(m => m.id)).toEqual([
      saved.id,
    ]);
  }
  await db.close();
});
