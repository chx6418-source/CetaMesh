import type {
  MemoryActor,
  MemoryChatEvidence,
  MemoryInput,
  MemoryPatch,
  MemoryQuery,
  MemoryRecord,
} from '../../domain/memory/Memory';
import type { MemoryRepository } from '../../domain/memory/MemoryRepository';
import { MemoryPolicy } from '../../security/MemoryPolicy';
import { CetaError } from '../../shared/errors/CetaError';
import { newId } from '../../shared/utils/id';
export type MemoryEvent = {
  type: 'memory.saved' | 'memory.updated' | 'memory.pinned' | 'memory.deleted';
  memoryId: string;
  traceId: string;
  eventId: string;
  timestamp: string;
};
export class MemoryRuntime {
  private readonly listeners = new Set<(event: MemoryEvent) => void>();
  private closed = false;
  constructor(
    private readonly repository: MemoryRepository,
    private readonly policy = new MemoryPolicy(),
  ) {}
  subscribe(listener: (event: MemoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new CetaError('cancelled', 'Memory runtime is closed');
    }
    try {
      return await fn();
    } catch (e) {
      throw e instanceof CetaError
        ? e
        : new CetaError('storage_error', 'Memory operation failed');
    }
  }
  private emit(type: MemoryEvent['type'], id: string): void {
    const event: MemoryEvent = {
      type,
      memoryId: id,
      traceId: newId('trace'),
      eventId: newId('event'),
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener({ ...event });
      } catch {
        /* Observers cannot roll back a saved memory. */
      }
    }
  }
  save(input: MemoryInput): Promise<MemoryRecord> {
    return this.safe(async () => {
      const record = await this.repository.create(this.policy.save(input));
      this.emit('memory.saved', record.id);
      return record;
    });
  }
  saveCandidate(
    input: MemoryInput,
    evidence: MemoryChatEvidence,
  ): Promise<MemoryRecord> {
    return this.safe(async () => {
      const record = await this.repository.saveCandidate(
        this.policy.save(input),
        evidence,
      );
      this.emit('memory.saved', record.id);
      return record;
    });
  }
  get(id: string): Promise<MemoryRecord> {
    return this.safe(() => this.repository.get(id));
  }
  search(query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    return this.safe(() => this.repository.search(query));
  }
  update(
    id: string,
    patch: MemoryPatch,
    revision: number,
    actor: MemoryActor = 'user',
  ): Promise<MemoryRecord> {
    return this.safe(async () => {
      const record = await this.repository.update(
        id,
        this.policy.update(patch),
        revision,
        actor,
      );
      this.emit('memory.updated', id);
      return record;
    });
  }
  pin(id: string, pinned: boolean, revision: number): Promise<MemoryRecord> {
    return this.safe(async () => {
      const record = await this.repository.pin(id, pinned, revision);
      this.emit('memory.pinned', id);
      return record;
    });
  }
  delete(
    id: string,
    revision: number,
    actor: MemoryActor = 'user',
  ): Promise<void> {
    return this.safe(async () => {
      await this.repository.delete(id, revision, actor);
      this.emit('memory.deleted', id);
    });
  }
}
