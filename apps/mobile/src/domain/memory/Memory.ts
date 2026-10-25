export const memoryKinds = [
  'working',
  'chat',
  'user',
  'task',
  'local',
] as const;
export type MemoryKind = (typeof memoryKinds)[number];
export type MemorySource =
  | { kind: 'manual' }
  | { kind: 'chat'; sessionId: string; messageIds: string[] }
  | { kind: 'task'; taskId: string };
export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  scope: 'local-only';
  content: string;
  source: MemorySource;
  importance: number;
  confidence: number;
  pinned: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};
export type MemoryInput = {
  kind: MemoryKind;
  content: string;
  scope?: 'local-only';
  source?: MemorySource;
  importance?: number;
  confidence?: number;
};
export type MemoryPatch = Partial<
  Pick<MemoryRecord, 'kind' | 'content' | 'importance' | 'confidence'>
>;
export type MemoryQuery = {
  query?: string;
  kind?: MemoryKind;
  pinned?: boolean;
  sourceSessionId?: string;
  limit?: number;
  offset?: number;
};
export type MemoryActor = 'user' | 'automatic';
// Transient evidence for an atomic candidate commit; never stored in memories.
export type MemoryChatEvidence = {
  sessionId: string;
  messageId: string;
  originalContent: string;
};
