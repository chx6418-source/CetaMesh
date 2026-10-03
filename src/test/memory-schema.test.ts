import { NodeDatabase } from './helpers/NodeDatabase';
import { migrateDatabase } from '../data/database/MigrationEngine';
import { appMigrations } from '../data/migrations/AppMigrations';
const memoryMigrations=appMigrations.filter(m=>m.version<=2);
test('additive M2 migration preserves M1 rows and reruns at version 2', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(
    db,
    appMigrations.filter(m => m.version === 1),
  );
  await db.executeAsync(
    "INSERT INTO chat_sessions VALUES('existing','History',0,'{}','old','old')",
  );
  expect(await migrateDatabase(db, memoryMigrations)).toEqual({ version: 2 });
  await db.executeAsync(
    "INSERT INTO memories(id,kind,content,created_at,updated_at) VALUES('m','chat','Keep me','now','now')",
  );
  expect(
    (await db.executeAsync('SELECT scope,pinned,revision FROM memories'))
      .results[0],
  ).toMatchObject({ scope: 'local-only', pinned: 0, revision: 1 });
  await migrateDatabase(db, memoryMigrations);
  expect(
    (await db.executeAsync('SELECT title FROM chat_sessions')).results[0].title,
  ).toBe('History');
  expect(
    (await db.executeAsync('SELECT content FROM memories')).results[0].content,
  ).toBe('Keep me');
  await db.close();
});
test('memory schema enforces local scope, supported kinds and bounded metadata', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, memoryMigrations);
  for (const kind of ['working', 'chat', 'user', 'task', 'local']) {
    await db.executeAsync(
      "INSERT INTO memories(id,kind,content,created_at,updated_at) VALUES(?,?,?,'now','now')",
      [kind, kind, kind],
    );
  }
  for (const statement of [
    "UPDATE memories SET scope='cloud'",
    "UPDATE memories SET kind='agent'",
    "UPDATE memories SET content=''",
    'UPDATE memories SET importance=2',
    'UPDATE memories SET confidence=-1',
    'UPDATE memories SET pinned=3',
    'UPDATE memories SET revision=0',
  ]) {
    await expect(db.executeAsync(statement)).rejects.toThrow();
  }
  expect(
    (await db.executeAsync('SELECT count(*) AS n FROM memories')).results[0].n,
  ).toBe(5);
  await db.close();
});
