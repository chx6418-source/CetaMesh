import type {
  ChatRepository,
  ChatSessionConfig,
  SessionPage,
} from '../../domain/chat/ChatRepository';
import { CetaError } from '../../shared/errors/CetaError';
function valid(config: ChatSessionConfig): void {
  if (
    !config.modelProviderId.trim() ||
    !config.modelId.trim() ||
    !['chat', 'smart'].includes(config.mode) ||
    !['fast', 'standard', 'high', 'max'].includes(config.reasoning)
  ) {
    throw new CetaError(
      'invalid_protocol',
      'Choose a provider, model, mode and reasoning',
    );
  }
}
export class SessionRuntime {
  constructor(private readonly repo: ChatRepository) {}
  async create(config: ChatSessionConfig) {
    valid(config);
    return this.repo.create(config);
  }
  async configure(id: string, config: ChatSessionConfig) {
    valid(config);
    await this.repo.configure(id, config);
  }
  list(page?: SessionPage) {
    return this.repo.list(page);
  }
  get(id: string) {
    return this.repo.get(id);
  }
  rename(id: string, title: string) {
    return this.repo.rename(id, title);
  }
  archive(id: string, value: boolean) {
    return this.repo.archive(id, value);
  }
  delete(id: string) {
    return this.repo.delete(id);
  }
}
