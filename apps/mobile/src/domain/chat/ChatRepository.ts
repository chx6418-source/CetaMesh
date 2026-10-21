import type { Reasoning } from '../model/ModelProvider';
import type {SessionUsage, TokenUsage} from '../model/TokenUsage';
import type { CetaErrorCode } from '../../shared/errors/CetaErrorCode';
export type ChatSessionConfig = {
  mode: 'smart' | 'chat';
  modelProviderId: string;
  modelId: string;
  reasoning: Reasoning;
};
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  kind: 'image' | 'text';
  data: string;
  size: number;
};
export type ChatSession = {
  id: string;
  title: string;
  archived: boolean;
  config: ChatSessionConfig;
  createdAt: string;
  updatedAt: string;
};
export type MessageStatus = 'streaming' | 'completed' | 'failed' | 'cancelled';
export type ChatMessage = {
  id: string;
  sequence: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments: Attachment[];
  status: MessageStatus;
  replyTo: string | null;
  errorCode: CetaErrorCode | null;
  createdAt: string;
};
export type Turn = { user: ChatMessage; assistant: ChatMessage };
export type SessionPage = {
  limit?: number;
  offset?: number;
  archived?: boolean;
};
export type MessagePage = { limit?: number; before?: number };
export interface ChatRepository {
  create(config: ChatSessionConfig, title?: string): Promise<ChatSession>;
  get(id: string): Promise<ChatSession>;
  list(page?: SessionPage): Promise<ChatSession[]>;
  rename(id: string, title: string): Promise<void>;
  archive(id: string, archived: boolean): Promise<void>;
  configure(id: string, config: ChatSessionConfig): Promise<void>;
  delete(id: string): Promise<void>;
  messages(id: string, page?: MessagePage): Promise<ChatMessage[]>;
  beginTurn(id: string, text: string, attachments: Attachment[]): Promise<Turn>;
  retryTurn(id: string): Promise<Turn>;
  resumeTurn(id: string): Promise<Turn>;
  finishTurn(
    id: string,
    content: string,
    status: MessageStatus,
    errorCode?: CetaErrorCode,
  ): Promise<void>;
  recoverInterrupted(): Promise<void>;
  recordUsage(assistantMessageId: string, usage: TokenUsage, providerId: string, modelId: string): Promise<void>;
  sessionUsage(sessionId: string): Promise<SessionUsage | undefined>;
  turnUsage(assistantMessageId: string): Promise<TokenUsage | undefined>;
}
