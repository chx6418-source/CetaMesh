export type SyncQueueStatus = 'pending' | 'sending' | 'acked' | 'failed' | 'dead-letter';

export type SyncQueueInput = {
  readonly eventId: string;
  readonly kind: string;
  readonly payload: unknown;
};

export type SyncQueueItem = SyncQueueInput & {
  readonly status: SyncQueueStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export interface SyncQueueRepository {
  enqueue(input: SyncQueueInput, now: number): Promise<SyncQueueItem>;
  get(eventId: string): Promise<SyncQueueItem>;
  next(now: number): Promise<SyncQueueItem | undefined>;
  ack(eventId: string): Promise<SyncQueueItem>;
  fail(eventId: string, error: string, nextAttemptAt: number): Promise<SyncQueueItem>;
  deadLetter(eventId: string, error: string): Promise<SyncQueueItem>;
  recoverInterrupted(now: number): Promise<number>;
  list(): Promise<SyncQueueItem[]>;
}
