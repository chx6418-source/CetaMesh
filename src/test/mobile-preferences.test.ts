import {PreferencesRuntime} from '../runtime/session/PreferencesRuntime';
import {SqliteMobilePreferencesRepository} from '../data/repositories/SqliteMobilePreferencesRepository';
import {DEFAULT_NEW_CHAT_CONFIG} from '../domain/preferences/MobilePreferencesRepository';
import type {ChatSessionConfig} from '../domain/chat/ChatRepository';
import {migrateDatabase} from '../data/database/MigrationEngine';
import {appMigrations} from '../data/migrations/AppMigrations';
import {NodeDatabase} from './helpers/NodeDatabase';

test('new-chat preferences default safely and persist validated selections', async () => {
  let saved: ChatSessionConfig | undefined;
  const runtime = new PreferencesRuntime({
    getNewChatDefaults: async () => saved,
    saveNewChatDefaults: async value => {saved = value;},
  });
  await expect(runtime.getNewChatDefaults()).resolves.toEqual(DEFAULT_NEW_CHAT_CONFIG);

  const config = {
    mode: 'smart' as const,
    modelProviderId: 'provider_main',
    modelId: 'reasoning-model',
    reasoning: 'high' as const,
  };
  await runtime.saveNewChatDefaults(config);
  await expect(runtime.getNewChatDefaults()).resolves.toEqual(config);
  await expect(runtime.saveNewChatDefaults({...config, reasoning: 'invalid' as never})).rejects.toMatchObject({code: 'invalid_protocol'});
});

test('SQLite preferences survive reopening and keep only one current defaults record', async () => {
  const {mkdtempSync, rmSync} = require('node:fs');
  const {tmpdir} = require('node:os');
  const {join} = require('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'cetamesh-mobile-preferences-'));
  const path = join(directory, 'preferences.sqlite');
  const first = new NodeDatabase(path);
  await migrateDatabase(first, appMigrations);
  const repository = new SqliteMobilePreferencesRepository(first);
  const config = {
    mode: 'chat' as const,
    modelProviderId: 'provider_main',
    modelId: 'fast-model',
    reasoning: 'fast' as const,
  };
  await repository.saveNewChatDefaults(config);
  await repository.saveNewChatDefaults({...config, modelId: 'updated-model'});
  await first.close();

  const second = new NodeDatabase(path);
  try {
    await migrateDatabase(second, appMigrations);
    const reopened = new SqliteMobilePreferencesRepository(second);
    await expect(reopened.getNewChatDefaults()).resolves.toEqual({...config, modelId: 'updated-model'});
    await expect(second.executeAsync('SELECT * FROM mobile_preferences')).resolves.toMatchObject({results: [{id: 1}]});
    await second.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
