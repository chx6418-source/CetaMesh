export type InboxKind = 'share' | 'quick-memory' | 'voice' | 'task-note';
export type InboxStatus = 'pending' | 'processing' | 'failed' | 'completed';

export type InboxPayload =
  | {readonly type: 'url'; readonly value: string}
  | {readonly type: 'text'; readonly value?: string; readonly text?: string}
  | {readonly type: 'image'; readonly name: string; readonly uri: string}
  | {readonly type: 'file'; readonly name: string; readonly uri: string}
  | {readonly type: 'voice'; readonly recordingId: string; readonly mime: string; readonly data: string; readonly size: number; readonly durationMs: number};

export type InboxItem = {
  readonly inboxId: string;
  readonly kind: InboxKind;
  readonly payload: InboxPayload;
  readonly status: InboxStatus;
  readonly localOnly: true;
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type InboxInput = {
  readonly kind: InboxKind;
  readonly payload: InboxPayload;
};

export interface InboxRepository {
  create(input: InboxInput): Promise<InboxItem>;
  get(inboxId: string): Promise<InboxItem>;
  list(): Promise<InboxItem[]>;
  updateStatus(inboxId: string, status: InboxStatus, error?: string): Promise<InboxItem>;
}
