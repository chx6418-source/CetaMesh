import { NodeDatabase } from './helpers/NodeDatabase';
import { assembleServices } from '../app/bootstrap/assembleServices';
import { SqliteChatRepository } from '../data/repositories/SqliteChatRepository';
async function setup() {
  const db = new NodeDatabase();
  const app = await assembleServices(
    db,
    { get: async () => null, set: async () => {}, delete: async () => {} },
    {
      json: async () => {
        throw new Error('Network forbidden');
      },
      stream: async function* () {
        throw new Error('Network forbidden');
      },
    },
  );
  const chat = new SqliteChatRepository(db);
  const s = await app.sessions.create({
    modelProviderId: 'p',
    modelId: 'm',
    mode: 'chat',
    reasoning: 'standard',
  });
  const add = async (text: string, reply = 'Assistant assertion') => {
    const t = await chat.beginTurn(s.id, text, []);
    await chat.finishTurn(t.assistant.id, reply, 'completed');
    return t;
  };
  return { db, app, s, add };
}
test('offline preview proposes explicit user facts only and never saves implicitly', async () => {
  const { app, s, add } = await setup();
  await add('普通对话', '记住：Assistant invented fact');
  await add('记住：API key: NEVER_STORE');
  await add('记住：我喜欢乌龙茶');
  const candidates = await app.memoryExtraction.preview(s.id);
  expect(candidates.map(c => c.content)).toEqual(['我喜欢乌龙茶']);
  expect(await app.memory.search()).toEqual([]);
  const saved = await app.memoryExtraction.confirm(
    candidates[0].id,
    '我喜欢清淡的乌龙茶',
  );
  expect(saved).toMatchObject({
    kind: 'chat',
    scope: 'local-only',
    content: '我喜欢清淡的乌龙茶',
    pinned: false,
  });
  expect(saved.source).toMatchObject({ kind: 'chat', sessionId: s.id });
  await expect(
    app.memoryExtraction.confirm(candidates[0].id, 'Replay'),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await app.close();
});
test('duplicate confirmation never modifies existing pinned memory and rejection is final', async () => {
  const { app, s, add } = await setup();
  await add('Remember that I prefer tea');
  const [one] = await app.memoryExtraction.preview(s.id);
  const saved = await app.memoryExtraction.confirm(one.id, one.content);
  const pinned = await app.memory.pin(saved.id, true, saved.revision);
  const [two] = await app.memoryExtraction.preview(s.id);
  const results = await Promise.allSettled([
    app.memoryExtraction.confirm(two.id, two.content),
    app.memoryExtraction.confirm(two.id, 'Other'),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await app.memory.search()).toHaveLength(1);
  expect(await app.memory.get(saved.id)).toEqual(pinned);
  const [three] = await app.memoryExtraction.preview(s.id);
  app.memoryExtraction.reject(three.id);
  await expect(
    app.memoryExtraction.confirm(three.id, three.content),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await app.close();
});
test('tampered preview, changed/deleted source and secret edits cannot publish memories', async () => {
  const { db, app, s, add } = await setup();
  const turn = await add('请记住：我爱茶');
  const [candidate] = await app.memoryExtraction.preview(s.id);
  candidate.source.messageIds[0] = 'forged';
  candidate.content = 'Forged';
  await expect(
    app.memoryExtraction.confirm(candidate.id, '密码：secret'),
  ).rejects.toMatchObject({ code: 'invalid_protocol' });
  await db.executeAsync('UPDATE chat_messages SET content=? WHERE id=?', [
    'Changed',
    turn.user.id,
  ]);
  await expect(
    app.memoryExtraction.confirm(candidate.id, 'Fact'),
  ).rejects.toMatchObject({ code: 'sync_conflict' });
  const [next] = await (async () => {
    await db.executeAsync('UPDATE chat_messages SET content=? WHERE id=?', [
      '记住：我爱茶',
      turn.user.id,
    ]);
    return app.memoryExtraction.preview(s.id);
  })();
  await app.sessions.delete(s.id);
  await expect(
    app.memoryExtraction.confirm(next.id, next.content),
  ).rejects.toMatchObject({ code: 'storage_error' });
  expect(await app.memory.search()).toEqual([]);
  await app.close();
});
test('English labelled credentials are excluded from preview and edited confirmation', async () => {
  const { app, s, add } = await setup();
  await add('Remember my API key is DUMMY_TEST_VALUE');
  await add('Remember my password is DUMMY_TEST_VALUE');
  expect(await app.memoryExtraction.preview(s.id)).toEqual([]);
  await add('Remember I prefer tea');
  const [candidate] = await app.memoryExtraction.preview(s.id);
  await expect(
    app.memoryExtraction.confirm(
      candidate.id,
      'my password is DUMMY_TEST_VALUE',
    ),
  ).rejects.toMatchObject({ code: 'invalid_protocol' });
  expect(await app.memory.search()).toEqual([]);
  await app.close();
});
test('deleting a source between final runtime validation and SQL insertion cannot save a candidate', async () => {
  const { app, s, add } = await setup();
  await add('Remember I prefer tea');
  const [candidate] = await app.memoryExtraction.preview(s.id);
  const save = app.memory.saveCandidate.bind(app.memory);
  app.memory.saveCandidate = async (...args) => {
    await app.sessions.delete(s.id);
    return save(...args);
  };
  await expect(
    app.memoryExtraction.confirm(candidate.id, candidate.content),
  ).rejects.toMatchObject({ code: 'sync_conflict' });
  expect(await app.memory.search()).toEqual([]);
  await app.close();
});
test('changing source content after runtime validation cannot publish stale provenance', async () => {
  const { db, app, s, add } = await setup();
  const turn = await add('Remember I prefer tea');
  const [candidate] = await app.memoryExtraction.preview(s.id);
  const save = app.memory.saveCandidate.bind(app.memory);
  app.memory.saveCandidate = async (...args) => {
    await db.executeAsync('UPDATE chat_messages SET content=? WHERE id=?', [
      'Changed source',
      turn.user.id,
    ]);
    return save(...args);
  };
  await expect(
    app.memoryExtraction.confirm(candidate.id, candidate.content),
  ).rejects.toMatchObject({ code: 'sync_conflict' });
  expect(await app.memory.search()).toEqual([]);
  await app.close();
});
