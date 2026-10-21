import { ChatRuntime } from '../runtime/chat/ChatRuntime';
import { ProviderRegistry } from '../runtime/chat/ProviderRegistry';
import { SqliteChatRepository } from '../data/repositories/SqliteChatRepository';
import { NodeDatabase } from './helpers/NodeDatabase';
import { migrateDatabase } from '../data/database/MigrationEngine';
import { appMigrations } from '../data/migrations/AppMigrations';
import type {
  ChatChunk,
  ChatRequest,
  ModelProvider,
} from '../domain/model/ModelProvider';

async function fixture(stream: (r: ChatRequest) => AsyncIterable<ChatChunk>) {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const repo = new SqliteChatRepository(db);
  const registry = new ProviderRegistry();
  registry.register({
    id: 'p',
    stream,
    listModels: async () => [],
    chat: async () => ({ content: '' }),
  } satisfies ModelProvider);
  const runtime = new ChatRuntime(repo, registry);
  const s = await repo.create({
    mode: 'chat',
    modelProviderId: 'p',
    modelId: 'm',
    reasoning: 'high',
  });
  return { db, repo, runtime, s };
}
test('send persists multi-turn context, streaming events and independent settings', async () => {
  const requests: ChatRequest[] = [];
  const f = await fixture(async function* (r) {
    requests.push(r);
    yield { type: 'delta', text: 'Hello' };
    yield { type: 'done' };
  });
  const events: string[] = [];
  const unsubscribe = f.runtime.subscribe(e => events.push(e.type));
  await f.runtime.send(f.s.id, 'First');
  await f.runtime.send(f.s.id, 'Second');
  expect(requests[1].messages.map(m => m.content)).toEqual([
    expect.stringContaining('CetaMesh'),
    'First',
    'Hello',
    'Second',
  ]);
  expect(requests[1].reasoning).toBe('high');
  expect(events).toContain('delta');
  expect(events).toContain('settled');
  expect((await f.repo.messages(f.s.id)).map(m => m.status)).toEqual([
    'completed',
    'completed',
    'completed',
    'completed',
  ]);
  unsubscribe();
  const count = events.length;
  await f.runtime.send(f.s.id, 'Third');
  expect(events).toHaveLength(count);
  await f.db.close();
});
test('provider failure persists safe error and retry reuses the original user turn', async () => {
  let attempt = 0;
  const f = await fixture(async function* () {
    yield { type: 'delta', text: 'partial' };
    if (++attempt === 1) {
      throw new Error('API_KEY=bad');
    }
    yield { type: 'done' };
  });
  await expect(f.runtime.send(f.s.id, 'First')).rejects.toMatchObject({
    code: 'provider_error',
  });
  const first = await f.repo.messages(f.s.id);
  expect(first[1]).toMatchObject({
    content: 'partial',
    status: 'failed',
    errorCode: 'provider_error',
  });
  expect(JSON.stringify(first)).not.toContain('API_KEY');
  await f.runtime.retry(f.s.id);
  const second = await f.repo.messages(f.s.id);
  expect(second).toHaveLength(2);
  expect(second[0].id).toBe(first[0].id);
  expect(second[1].status).toBe('completed');
  await f.db.close();
});
test('cancel interrupts even a stalled provider and rejects concurrent send', async () => {
  let ready!: () => void;
  const started = new Promise<void>(r => {
    ready = r;
  });
  const f = await fixture(async function* () {
    yield { type: 'delta', text: 'part' };
    ready();
    await new Promise<void>(() => {});
    yield { type: 'done' };
  });
  const pending = f.runtime.send(f.s.id, 'First');
  const failure = pending.catch(error => error);
  await started;
  await expect(f.runtime.send(f.s.id, 'Duplicate')).rejects.toMatchObject({
    code: 'sync_conflict',
  });
  f.runtime.cancel(f.s.id);
  expect(await failure).toMatchObject({code:'cancelled'});
  expect((await f.repo.messages(f.s.id))[1]).toMatchObject({
    content: 'part',
    status: 'cancelled',
  });
  expect(f.runtime.isRunning(f.s.id)).toBe(false);
  await f.db.close();
});
test('runtime times out stalled providers and rejects empty input before persistence', async () => {
  const f = await fixture(async function* () {
    await new Promise<void>(() => {});
    yield { type: 'done' };
  });
  await expect(f.runtime.send(f.s.id, '')).rejects.toMatchObject({
    code: 'invalid_protocol',
  });
  expect(await f.repo.messages(f.s.id)).toEqual([]);
  await expect(f.runtime.send(f.s.id, 'Hello', [], 10)).rejects.toMatchObject({
    code: 'timeout',
  });
  expect((await f.repo.messages(f.s.id))[1].status).toBe('failed');
  await f.db.close();
});
test('active streaming runs beyond its first-response timeout and checkpoints less often than deltas', async () => {
  const f = await fixture(async function* () {
    for (let i = 0; i < 9; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      yield {type: 'delta', text: 'chunk'};
    }
    yield {type: 'done'};
  });
  const writes = jest.spyOn(f.repo, 'finishTurn');
  await f.runtime.send(f.s.id, 'Long reply', [], 45);
  expect((await f.repo.messages(f.s.id))[1]).toMatchObject({content: 'chunk'.repeat(9), status: 'completed'});
  expect(writes).toHaveBeenCalledTimes(1);
  await f.db.close();
});
test('stream idle timeout preserves partial answer immediately', async () => {
  const f = await fixture(async function* () {
    yield {type: 'delta', text: '已生成的内容'};
    await new Promise<void>(() => {});
  });
  await expect(f.runtime.send(f.s.id, 'Continue', [], 25)).rejects.toMatchObject({code: 'timeout'});
  expect((await f.repo.messages(f.s.id))[1]).toMatchObject({content: '已生成的内容', status: 'failed'});
  await f.db.close();
});
test('continue appends to an interrupted answer while retry regenerates it', async () => {
  const requests: ChatRequest[] = [];
  let attempt = 0;
  const f = await fixture(async function* (request) {
    requests.push(request);
    if (++attempt === 1) {
      yield {type: 'delta', text: '已有内容'};
      throw new Error('interrupted');
    }
    yield {type: 'delta', text: '，继续内容'};
    yield {type: 'done'};
  });
  await expect(f.runtime.send(f.s.id, '问题')).rejects.toMatchObject({code: 'provider_error'});
  await f.runtime.continueReply(f.s.id);
  expect((await f.repo.messages(f.s.id))[1]).toMatchObject({content: '已有内容，继续内容', status: 'completed'});
  expect(requests[1].messages.slice(-2)).toEqual([
    {role: 'assistant', content: '已有内容'},
    {role: 'user', content: expect.stringContaining('Continue the interrupted answer')},
  ]);
  await f.db.close();
});


test('long chats page backward beyond 200 stored messages and no longer fail at message 201', async () => {
  const requests: ChatRequest[] = [];
  const f = await fixture(async function* (request) {
    requests.push(request);
    yield {type: 'delta', text: 'ok'};
    yield {type: 'done'};
  });
  for (let index = 0; index < 101; index += 1) {
    const turn = await f.repo.beginTurn(f.s.id, `seed-${index}`, []);
    await f.repo.finishTurn(turn.assistant.id, `reply-${index}`, 'completed');
  }

  await f.runtime.send(f.s.id, 'latest');
  expect(requests).toHaveLength(1);
  expect(requests[0].messages.length).toBeGreaterThan(201);
  expect(requests[0].messages.at(-1)?.content).toBe('latest');
  await f.db.close();
});
