import type {ChatSessionConfig} from '../chat/ChatRepository';

export const DEFAULT_NEW_CHAT_CONFIG: ChatSessionConfig = {
  mode: 'chat',
  modelProviderId: '',
  modelId: '',
  reasoning: 'standard',
};

export interface MobilePreferencesRepository {
  getNewChatDefaults(): Promise<ChatSessionConfig | undefined>;
  saveNewChatDefaults(config: ChatSessionConfig): Promise<void>;
}
