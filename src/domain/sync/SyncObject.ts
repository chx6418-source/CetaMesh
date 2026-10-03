import type {CapabilityScope} from '../capability/Capability';
import type {NeedsAttention, Task, ExecutionRef} from '../task';

export type MemorySyncObject = {
  readonly objectType: 'memory';
  readonly memoryId: string;
  readonly ownerId: string;
  readonly scopeType: 'my-devices';
  readonly scopeId: string;
  readonly revision: number;
  readonly source: string;
  readonly policy: 'my-devices';
  readonly content?: string;
  readonly deleted?: boolean;
  readonly updatedAt: string;
};

export type ArtifactMetadata = {
  readonly artifactId: string;
  readonly kind: string;
  readonly name: string;
  readonly size: number;
};

export type TaskSyncSnapshot = {
  readonly objectType: 'task';
  readonly taskId: string;
  readonly ownerId: string;
  readonly scopeType: 'my-devices';
  readonly scopeId: string;
  readonly revision: number;
  readonly goal: string;
  readonly status: Task['status'];
  readonly phase: string;
  readonly progress: number;
  readonly providerExecutionRef?: ExecutionRef;
  readonly checkpointRef?: string;
  readonly needsAttention: readonly NeedsAttention[];
  readonly artifacts: readonly ArtifactMetadata[];
  readonly deleted?: boolean;
  readonly updatedAt: string;
};

export type SyncApplyStatus = 'applied' | 'duplicate' | 'stale' | 'conflict' | 'denied';
export type SyncApplyResult<T> = {readonly status: SyncApplyStatus; readonly object?: T};

export interface MemorySyncStore {
  get(memoryId: string): Promise<MemorySyncObject | undefined>;
  upsert(object: MemorySyncObject): Promise<void>;
}

export interface TaskSyncStore {
  get(taskId: string): Promise<TaskSyncSnapshot | undefined>;
  upsert(object: TaskSyncSnapshot): Promise<void>;
}

export type RemoteCapabilityApproval = {
  readonly approvalId: string;
  readonly nonce: string;
};

export type RemoteCapabilityRequest = {
  readonly trusted: boolean;
  readonly remoteDeviceId: string;
  readonly taskId?: string;
  readonly capability: string;
  readonly scope: CapabilityScope;
  readonly target?: string;
  readonly input?: unknown;
  readonly approval?: RemoteCapabilityApproval;
};
