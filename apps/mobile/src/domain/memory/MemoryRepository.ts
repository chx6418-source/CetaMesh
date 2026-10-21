import type {
  MemoryActor,
  MemoryChatEvidence,
  MemoryInput,
  MemoryPatch,
  MemoryQuery,
  MemoryRecord,
} from './Memory';
export interface MemoryRepository {
  create(input: MemoryInput): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord>;
  search(query?: MemoryQuery): Promise<MemoryRecord[]>;
  update(
    id: string,
    patch: MemoryPatch,
    revision: number,
    actor: MemoryActor,
  ): Promise<MemoryRecord>;
  pin(id: string, pinned: boolean, revision: number): Promise<MemoryRecord>;
  delete(id: string, revision: number, actor: MemoryActor): Promise<void>;
  saveCandidate(
    input: MemoryInput,
    evidence: MemoryChatEvidence,
  ): Promise<MemoryRecord>;
}
