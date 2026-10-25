import {CetaError} from '../../shared/errors/CetaError';

export type ReconciliationStatus = 'applied' | 'duplicate' | 'stale' | 'conflict';

function encoded(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new CetaError('invalid_protocol', 'Sync object is not serializable');
  }
}

export function reconcileVersioned<T extends {readonly revision: number}>(current: T | undefined, incoming: T): ReconciliationStatus {
  if (!Number.isInteger(incoming.revision) || incoming.revision < 1) {
    throw new CetaError('invalid_protocol', 'Invalid sync object revision');
  }
  if (!current) {
    return 'applied';
  }
  if (incoming.revision < current.revision) {
    return 'stale';
  }
  if (incoming.revision === current.revision) {
    return encoded(current) === encoded(incoming) ? 'duplicate' : 'conflict';
  }
  return 'applied';
}
