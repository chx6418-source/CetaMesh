import type {ChatSessionConfig} from '../../domain/chat/ChatRepository';
import type {MobilePreferencesRepository} from '../../domain/preferences/MobilePreferencesRepository';
import {CetaError} from '../../shared/errors/CetaError';
import type {SqliteConnection} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';

function decode(value: unknown): ChatSessionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new CetaError('storage_error', 'Saved preferences are invalid');
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !['chat', 'smart'].includes(String((parsed as Record<string, unknown>).mode)) ||
    !['fast', 'standard', 'high', 'max'].includes(String((parsed as Record<string, unknown>).reasoning)) ||
    typeof (parsed as Record<string, unknown>).modelProviderId !== 'string' ||
    typeof (parsed as Record<string, unknown>).modelId !== 'string'
  ) {
    throw new CetaError('storage_error', 'Saved preferences are invalid');
  }
  const record = parsed as Record<string, string>;
  return {
    mode: record.mode as ChatSessionConfig['mode'],
    modelProviderId: record.modelProviderId,
    modelId: record.modelId,
    reasoning: record.reasoning as ChatSessionConfig['reasoning'],
  };
}

export class SqliteMobilePreferencesRepository implements MobilePreferencesRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }

  async getNewChatDefaults(): Promise<ChatSessionConfig | undefined> {
    try {
      const row = (await this.db.executeAsync<{new_chat_defaults: string}>(
        'SELECT new_chat_defaults FROM mobile_preferences WHERE id=1',
      )).results[0];
      return row ? decode(row.new_chat_defaults) : undefined;
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Preferences could not be read');
    }
  }

  async saveNewChatDefaults(config: ChatSessionConfig): Promise<void> {
    try {
      await this.db.executeAsync(
        'INSERT INTO mobile_preferences(id,new_chat_defaults) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET new_chat_defaults=excluded.new_chat_defaults',
        [JSON.stringify(config)],
      );
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Preferences could not be saved');
    }
  }
}
