import type { ChatRepository } from '../../domain/chat/ChatRepository';
import type { MemoryCandidate } from '../../domain/memory/MemoryCandidate';
import type { MemoryRecord } from '../../domain/memory/Memory';
import { isSensitiveMemoryText } from '../../security/MemoryPolicy';
import { CetaError } from '../../shared/errors/CetaError';
import { newId } from '../../shared/utils/id';
import type { MemoryRuntime } from './MemoryRuntime';
type Issued = {
  candidate: MemoryCandidate;
  original: string;
  sequence: number;
};
const prefix = /^(?:(?:请\s*)?记住(?:[：:\s]+)|remember(?:\s+that)?[：:\s]+)/i;
export class ChatMemoryExtraction {
  private readonly issued = new Map<string, Issued>();
  private readonly confirming = new Set<string>();
  private version = 0;
  constructor(
    private readonly chat: ChatRepository,
    private readonly memory: MemoryRuntime,
  ) {}
  clear(): void {
    this.version++;
    this.issued.clear();
  }
  reject(id: string): void {
    this.issued.delete(id);
  }
  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof CetaError
        ? e
        : new CetaError('storage_error', 'Memory candidate operation failed');
    }
  }
  preview(sessionId: string): Promise<MemoryCandidate[]> {
    return this.safe(async () => {
      if (this.confirming.size) {
        throw new CetaError('sync_conflict', 'Wait for memory confirmation');
      }
      this.clear();
      const version = this.version;
      await this.chat.get(sessionId);
      const messages = await this.chat.messages(sessionId, { limit: 200 });
      if (version !== this.version) {
        throw new CetaError('cancelled', 'Memory preview cancelled');
      }
      const found: Issued[] = [];
      for (const message of messages) {
        if (
          message.role !== 'user' ||
          message.status !== 'completed' ||
          !prefix.test(message.content.trim())
        ) {
          continue;
        }
        const content = message.content.trim().replace(prefix, '').trim();
        if (
          !content ||
          content.length > 4000 ||
          content.includes('\0') ||
          isSensitiveMemoryText(content)
        ) {
          continue;
        }
        found.push({
          original: message.content,
          sequence: message.sequence,
          candidate: {
            id: newId('candidate'),
            kind: 'chat',
            scope: 'local-only',
            content,
            source: { kind: 'chat', sessionId, messageIds: [message.id] },
            importance: 0.5,
            confidence: 0.5,
          },
        });
      }
      return found.slice(-10).map(item => {
        this.issued.set(item.candidate.id, item);
        return {
          ...item.candidate,
          source: {
            ...item.candidate.source,
            messageIds: [...item.candidate.source.messageIds],
          },
        };
      });
    });
  }
  confirm(id: string, editedContent: string): Promise<MemoryRecord> {
    return this.safe(async () => {
      const issued = this.issued.get(id);
      if (!issued || this.confirming.has(id)) {
        throw new CetaError(
          'permission_denied',
          'Candidate is no longer available',
        );
      }
      this.confirming.add(id);
      try {
        const candidate = issued.candidate,
          source = candidate.source;
        await this.chat.get(source.sessionId);
        const [message] = await this.chat.messages(source.sessionId, {
          before: issued.sequence + 1,
          limit: 1,
        });
        if (
          !message ||
          message.id !== source.messageIds[0] ||
          message.role !== 'user' ||
          message.status !== 'completed' ||
          message.content !== issued.original
        ) {
          throw new CetaError(
            'sync_conflict',
            'Source changed; generate a new preview',
          );
        }
        if (this.issued.get(id) !== issued) {
          throw new CetaError(
            'permission_denied',
            'Candidate is no longer available',
          );
        }
        const record = await this.memory.saveCandidate(
          {
            kind: 'chat',
            scope: 'local-only',
            content: editedContent,
            source,
            importance: candidate.importance,
            confidence: candidate.confidence,
          },
          {
            sessionId: source.sessionId,
            messageId: source.messageIds[0],
            originalContent: issued.original,
          },
        );
        this.issued.delete(id);
        return record;
      } finally {
        this.confirming.delete(id);
      }
    });
  }
}
