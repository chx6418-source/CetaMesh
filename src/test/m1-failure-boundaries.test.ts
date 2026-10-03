import { ProviderSettings } from '../runtime/session/ProviderSettings';
import type { ProviderConfig } from '../domain/model/ModelProvider';
import { assembleServices } from '../app/bootstrap/assembleServices';
import { NodeDatabase } from './helpers/NodeDatabase';
import { CetaError } from '../shared/errors/CetaError';

const oldConfig: ProviderConfig = {
  id: 'p',
  name: 'Old',
  baseUrl: 'https://old.example/v1',
  credentialRef: 'provider:p',
  supportsReasoning: false,
};
test('secure write failure cannot publish a changed endpoint with an old key', async () => {
  let saved = oldConfig;
  const settings = new ProviderSettings(
    {
      get: async () => 'OLD_KEY',
      set: async () => {
        throw new CetaError('storage_error', 'write failed');
      },
      delete: async () => {},
    },
    {
      list: async () => [saved],
      save: async config => {
        saved = config;
      },
    },
  );
  await expect(
    settings.save(
      {
        id: 'p',
        name: 'New',
        baseUrl: 'https://new.example/v1',
        supportsReasoning: false,
      },
      'NEW_KEY',
    ),
  ).rejects.toMatchObject({ code: 'storage_error' });
  expect(saved.baseUrl).toBe('https://old.example/v1');
  expect(saved.credentialRef).toBe('provider:p');
});
test('database failure cannot overwrite the previous credential and deletes the staged replacement', async () => {
  const keys = new Map([['provider:p', 'OLD_KEY']]);
  const settings = new ProviderSettings(
    {
      get: async r => keys.get(r) ?? null,
      set: async (r, s) => {
        keys.set(r, s);
      },
      delete: async r => {
        keys.delete(r);
      },
    },
    {
      list: async () => [oldConfig],
      save: async () => {
        throw new CetaError('storage_error', 'DB failed');
      },
    },
  );
  await expect(
    settings.save(
      {
        id: 'p',
        name: 'New',
        baseUrl: 'https://new.example/v1',
        supportsReasoning: false,
      },
      'NEW_KEY',
    ),
  ).rejects.toThrow();
  expect([...keys.entries()]).toEqual([['provider:p', 'OLD_KEY']]);
});
test('service close cancels and drains the reply before closing SQLite', async () => {
  const db = new NodeDatabase();
  const keys = new Map<string, string>();
  let started!: () => void;
  const ready = new Promise<void>(r => {
    started = r;
  });
  const services = await assembleServices(
    db,
    {
      get: async r => keys.get(r) ?? null,
      set: async (r, s) => {
        keys.set(r, s);
      },
      delete: async r => {
        keys.delete(r);
      },
    },
    {
      json: async () => ({}),
      stream: async function* () {
        yield 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
        started();
        await new Promise<void>(() => {});
      },
    },
  );
  await services.settings.save(
    {
      id: 'p',
      name: 'Test',
      baseUrl: 'https://example.com/v1',
      supportsReasoning: false,
    },
    'KEY',
  );
  await services.reloadProviders();
  const session = await services.sessions.create({
    mode: 'chat',
    modelProviderId: 'p',
    modelId: 'm',
    reasoning: 'standard',
  });
  const pending = services.chat.send(session.id, 'Hello').catch(e => e);
  await ready;
  await services.close();
  expect(await pending).toMatchObject({ code: 'cancelled' });
  await expect(
    services.chat.send(session.id, 'After close'),
  ).rejects.toMatchObject({ code: 'cancelled' });
});
