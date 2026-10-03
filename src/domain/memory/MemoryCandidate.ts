import type { MemorySource } from './Memory';
export type MemoryCandidate = {
  id: string;
  kind: 'chat';
  scope: 'local-only';
  content: string;
  source: Extract<MemorySource, { kind: 'chat' }>;
  importance: number;
  confidence: number;
};
