import type {SyncQueueInput, SyncQueueItem, SyncQueueRepository} from '../../domain/sync';
import {CetaError} from '../../shared/errors/CetaError';

export type SyncQueueRuntimeOptions = {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
};

export class SyncQueueRuntime {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly repository: SyncQueueRepository,
    private readonly clock: () => number = Date.now,
    options: SyncQueueRuntimeOptions = {},
  ) {
    this.maxAttempts = Number.isInteger(options.maxAttempts) && Number(options.maxAttempts) > 0 ? Math.min(Number(options.maxAttempts), 10) : 5;
    this.baseDelayMs = Number.isInteger(options.baseDelayMs) && Number(options.baseDelayMs) > 0 ? Math.min(Number(options.baseDelayMs), 60_000) : 1_000;
  }

  enqueue(input: SyncQueueInput): Promise<SyncQueueItem> {
    return this.repository.enqueue(input, this.clock());
  }

  next(): Promise<SyncQueueItem | undefined> {
    return this.repository.next(this.clock());
  }

  ack(eventId: string): Promise<SyncQueueItem> {
    return this.repository.ack(eventId);
  }

  async fail(eventId: string, error: string): Promise<SyncQueueItem> {
    const current = await this.repository.get(eventId);
    if (current.status === 'dead-letter' || current.status === 'acked') {
      return current;
    }
    if (current.status !== 'sending') {
      throw new CetaError('sync_conflict', 'Only a sending event can fail');
    }
    if (current.attempts >= this.maxAttempts) {
      return this.repository.deadLetter(eventId, error);
    }
    const delay = this.baseDelayMs * 2 ** Math.max(0, current.attempts - 1);
    return this.repository.fail(eventId, error, this.clock() + Math.min(delay, 300_000));
  }

  deadLetter(eventId: string, error = 'manual_dead_letter'): Promise<SyncQueueItem> {
    return this.repository.deadLetter(eventId, error);
  }

  recoverInterrupted(): Promise<number> {
    return this.repository.recoverInterrupted(this.clock());
  }

  list(): Promise<SyncQueueItem[]> {
    return this.repository.list();
  }
}
