import type {ChatSessionConfig} from '../../domain/chat/ChatRepository';
import {
  DEFAULT_NEW_CHAT_CONFIG,
  type MobilePreferencesRepository,
} from '../../domain/preferences/MobilePreferencesRepository';
import {CetaError} from '../../shared/errors/CetaError';

function normalize(config: ChatSessionConfig): ChatSessionConfig {
  if (
    !config ||
    !['chat', 'smart'].includes(config.mode) ||
    !['fast', 'standard', 'high', 'max'].includes(config.reasoning) ||
    typeof config.modelProviderId !== 'string' ||
    typeof config.modelId !== 'string' ||
    config.modelProviderId.length > 128 ||
    config.modelId.length > 256
  ) {
    throw new CetaError('invalid_protocol', 'Invalid new-conversation defaults');
  }
  return {
    mode: config.mode,
    modelProviderId: config.modelProviderId.trim(),
    modelId: config.modelId.trim(),
    reasoning: config.reasoning,
  };
}

export class PreferencesRuntime {
  constructor(private readonly repository: MobilePreferencesRepository) {}

  async getNewChatDefaults(): Promise<ChatSessionConfig> {
    const value = await this.repository.getNewChatDefaults();
    return value ? normalize(value) : {...DEFAULT_NEW_CHAT_CONFIG};
  }

  async saveNewChatDefaults(config: ChatSessionConfig): Promise<void> {
    await this.repository.saveNewChatDefaults(normalize(config));
  }
}
