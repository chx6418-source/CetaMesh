import { ProviderSettings } from '../runtime/session/ProviderSettings';
import { KeychainStorage } from '../native/secure-storage/KeychainStorage';
import type { ProviderConfig } from '../domain/model/ModelProvider';
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device' },
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

test('keychain adapter isolates services and clears a saved secret', async () => {
  const records = new Map<string, string>();
  const storage = new KeychainStorage({
    setGenericPassword: async (
      _u: string,
      p: string,
      o: { service: string },
    ) => {
      records.set(o.service, p);
      return { service: o.service, storage: 'test' };
    },
    getGenericPassword: async (o: { service: string }) =>
      records.has(o.service)
        ? {
            username: 'api',
            password: records.get(o.service)!,
            service: o.service,
            storage: 'test',
          }
        : false,
    resetGenericPassword: async (o: { service: string }) =>
      records.delete(o.service),
  });
  await storage.set('provider:p', 'do-not-log');
  expect(await storage.get('provider:p')).toBe('do-not-log');
  expect(await storage.get('provider:q')).toBeNull();
  await storage.delete('provider:p');
  expect(await storage.get('provider:p')).toBeNull();
});
test('native credential errors never expose the raw exception', async () => {
  const fail = async () => {
    throw new Error('super-secret');
  };
  const storage = new KeychainStorage({
    setGenericPassword: fail,
    getGenericPassword: fail,
    resetGenericPassword: fail,
  });
  for (const op of [
    () => storage.set('provider:p', 'secret'),
    () => storage.get('provider:p'),
    () => storage.delete('provider:p'),
  ]) {
    await expect(op()).rejects.toMatchObject({ code: 'storage_error' });
    await expect(op()).rejects.not.toThrow('super-secret');
  }
});
test('provider settings validate before storage and persist only a credential reference', async () => {
  const records = new Map<string, string>();
  let saved: ProviderConfig | undefined;
  const settings = new ProviderSettings(
    {
      get: async r => records.get(r) ?? null,
      set: async (r, s) => {
        records.set(r, s);
      },
      delete: async r => {
        records.delete(r);
      },
    },
    {
      list: async () => (saved ? [saved] : []),
      save: async c => {
        saved = c;
      },
    },
  );
  await expect(
    settings.save(
      {
        id: 'p',
        name: 'Provider',
        baseUrl: 'http://example.com',
        supportsReasoning: false,
      },
      'secret',
    ),
  ).rejects.toThrow();
  expect(records.size).toBe(0);
  await settings.save(
    {
      id: 'p',
      name: 'Provider',
      baseUrl: 'https://example.com/v1',
      supportsReasoning: false,
    },
    'secret',
  );
  expect(JSON.stringify(saved)).not.toContain('secret');
  expect(saved?.credentialRef).toBe('provider:p');
  await settings.removeSecret('p');
  expect(records.size).toBe(0);
});
