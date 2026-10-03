import {TASK_STATUSES, type Task} from '../../domain/task';
import type {ArtifactMetadata, TaskSyncSnapshot, TaskSyncStore, SyncApplyResult} from '../../domain/sync';
import {reconcileVersioned} from './ReconciliationRuntime';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';

function validateSnapshot(snapshot: TaskSyncSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new CetaError('invalid_protocol', 'Invalid Task sync snapshot');
  }
  const value = snapshot as unknown as Record<string, unknown>;
  if (typeof value.goal !== 'string' || typeof value.phase !== 'string' || !Array.isArray(value.needsAttention) || !Array.isArray(value.artifacts) || value.deleted !== undefined && typeof value.deleted !== 'boolean' || value.providerExecutionRef !== undefined && (!value.providerExecutionRef || typeof value.providerExecutionRef !== 'object' || Array.isArray(value.providerExecutionRef))) {
    throw new CetaError('invalid_protocol', 'Invalid Task sync snapshot');
  }
  identifier(snapshot.taskId);
  identifier(snapshot.ownerId);
  identifier(snapshot.scopeId);
  if (snapshot.objectType !== 'task' || snapshot.scopeType !== 'my-devices' || !TASK_STATUSES.includes(snapshot.status) || !Number.isInteger(snapshot.revision) || snapshot.revision < 1 || !snapshot.goal.trim() || snapshot.goal.length > 4000 || !snapshot.phase.trim() || snapshot.phase.length > 100 || !Number.isFinite(snapshot.progress) || snapshot.progress < 0 || snapshot.progress > 1 || snapshot.needsAttention.length > 100 || snapshot.artifacts.length > 100 || 'transcript' in value) {
    throw new CetaError('invalid_protocol', 'Invalid Task sync snapshot');
  }
  for (const artifact of snapshot.artifacts) {
    if (!artifact || typeof artifact.artifactId !== 'string' || artifact.artifactId.length > 100 || typeof artifact.kind !== 'string' || artifact.kind.length > 100 || typeof artifact.name !== 'string' || artifact.name.length > 200 || !Number.isInteger(artifact.size) || artifact.size < 0 || artifact.size > 16 * 1024 * 1024) {
      throw new CetaError('invalid_protocol', 'Invalid Task artifact metadata');
    }
  }
  iso(snapshot.updatedAt);
}

export class TaskSyncRuntime {
  constructor(private readonly store: TaskSyncStore) {}

  toSnapshot(task: Task, ownerId: string, scopeId: string, artifacts: readonly ArtifactMetadata[] = [], needsAttention: TaskSyncSnapshot['needsAttention'] = []): TaskSyncSnapshot {
    const snapshot: TaskSyncSnapshot = {
      objectType: 'task',
      taskId: task.taskId,
      ownerId,
      scopeType: 'my-devices',
      scopeId,
      revision: task.revision,
      goal: task.goal,
      status: task.status,
      phase: task.phase,
      progress: task.progress,
      ...(task.providerExecutionRef ? {providerExecutionRef: task.providerExecutionRef} : {}),
      ...(task.checkpointRef ? {checkpointRef: task.checkpointRef} : {}),
      needsAttention: needsAttention.slice(0, 100),
      artifacts: artifacts.slice(0, 100),
      updatedAt: task.updatedAt,
    };
    validateSnapshot(snapshot);
    return snapshot;
  }

  async apply(snapshot: TaskSyncSnapshot): Promise<SyncApplyResult<TaskSyncSnapshot>> {
    validateSnapshot(snapshot);
    const current = await this.store.get(snapshot.taskId);
    const status = reconcileVersioned(current, snapshot);
    if (status === 'applied') {
      await this.store.upsert(snapshot);
      return {status, object: snapshot};
    }
    return {status, ...(current ? {object: current} : {})};
  }
}
