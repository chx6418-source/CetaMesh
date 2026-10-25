import {normalizeTokenUsage, cacheHitRate} from '../providers/model/TokenUsageNormalization';
import {SqliteChatRepository} from '../data/repositories/SqliteChatRepository';
import {NodeDatabase} from './helpers/NodeDatabase';
import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';

test('normalizes reported OpenAI and DeepSeek cache fields without estimating missing cache', () => {
  expect(normalizeTokenUsage({prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: {cached_tokens: 90}})).toMatchObject({inputTokens: 100, outputTokens: 20, cachedInputTokens: 90, cacheMissInputTokens: 10, providerReported: true});
  expect(normalizeTokenUsage({prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 92, prompt_cache_miss_tokens: 8})).toMatchObject({cachedInputTokens: 92, cacheMissInputTokens: 8});
  const unknown = normalizeTokenUsage({prompt_tokens: 100, completion_tokens: 20});
  expect(unknown?.cachedInputTokens).toBeUndefined();
  expect(cacheHitRate(unknown)).toBeNull();
  const explicitZero = normalizeTokenUsage({prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100});
  expect(cacheHitRate(explicitZero)).toBe(0);
  expect(cacheHitRate({inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 90, cacheMissInputTokens: 10, providerReported: true})).toBe(90);
});

test('persists real turn usage and aggregates partial sessions across app restarts', async () => {
  const db = new NodeDatabase();
  await migrateDatabase(db, appMigrations);
  const repo = new SqliteChatRepository(db);
  const session = await repo.create({mode: 'chat', modelProviderId: 'p', modelId: 'm', reasoning: 'standard'});
  const first = await repo.beginTurn(session.id, 'one', []);
  await repo.finishTurn(first.assistant.id, 'yes', 'completed');
  await repo.recordUsage(first.assistant.id, {inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 90, cacheMissInputTokens: 10, providerReported: true}, 'p', 'm');
  const second = await repo.beginTurn(session.id, 'two', []);
  await repo.finishTurn(second.assistant.id, 'yes', 'completed');
  await repo.recordUsage(second.assistant.id, {inputTokens: 50, outputTokens: 5, totalTokens: 55, providerReported: true}, 'p', 'm');
  const result = await new SqliteChatRepository(db).sessionUsage(session.id);
  expect(result).toMatchObject({inputTokens: 150, outputTokens: 15, totalTokens: 165, cachedInputTokens: 90, cacheMissInputTokens: 10, partial: true});
  expect(cacheHitRate(result)).toBeNull();
  expect(await repo.turnUsage(first.assistant.id)).toMatchObject({inputTokens: 100, outputTokens: 10, cachedInputTokens: 90});
  await db.close();
});
