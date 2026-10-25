import type {MemorySyncObject, MemorySyncStore, SyncApplyResult} from '../../domain/sync';
import {reconcileVersioned} from './ReconciliationRuntime';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';

export type MemoryScopeAuthorizer = (object: MemorySyncObject) => boolean | Promise<boolean>;

function validate(object: MemorySyncObject): void {
  identifier(object.memoryId);
  identifier(object.ownerId);
  identifier(object.scopeId);
  if (object.objectType !== 'memory' || !Number.isInteger(object.revision) || typeof object.source !== 'string' || object.source.length > 1000 || object.content !== undefined && (typeof object.content !== 'string' || object.content.length > 16_000) || object.deleted !== undefined && typeof object.deleted !== 'boolean') {
    throw new CetaError('invalid_protocol', 'Invalid Memory sync object');
  }
  iso(object.updatedAt);
}

export class MemorySyncRuntime {
  constructor(
    private readonly store: MemorySyncStore,
    private readonly authorize: MemoryScopeAuthorizer,
  ) {}

  async apply(object: MemorySyncObject): Promise<SyncApplyResult<MemorySyncObject>> {
    validate(object);
    if (object.scopeType !== 'my-devices' || object.policy !== 'my-devices') {
      return {status: 'denied'};
    }
    if (object.revision < 1) {
      return {status: 'stale'};
    }
    if (!(await this.authorize(object))) {
      return {status: 'denied'};
    }
    const current = await this.store.get(object.memoryId);
    const status = reconcileVersioned(current, object);
    if (status === 'applied') {
      await this.store.upsert(object);
      return {status, object};
    }
    return {status, ...(current ? {object: current} : {})};
  }
}
