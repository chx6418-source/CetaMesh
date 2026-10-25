import type {ExtensionManifest} from '../../domain/extension/ExtensionManifest';
import type {ExtensionPermission} from '../../domain/extension/ExtensionPermission';
import type {ExtensionRepository, InstalledExtension} from '../../domain/extension/ExtensionRepository';
import type {ExtensionSource, ExtensionStatus} from '../../domain/extension/SecurityReport';
import {CetaError} from '../../shared/errors/CetaError';
import {ExtensionValidationRuntime, mapExtensionPermissions} from './ExtensionValidationRuntime';
import {
  ExtensionInstallRuntime,
  type ExtensionInstallInput,
} from './ExtensionInstallRuntime';

const HIGH_RISK_CAPABILITIES = new Set([
  'camera.capture',
  'camera.scanDocument',
  'camera.scanQr',
  'microphone.record',
  'location.current',
  'nfc.read',
  'nfc.write',
  'bluetooth.scan',
  'bluetooth.connect',
]);

export type ExtensionPermissionDiff = {
  readonly added: readonly ExtensionPermission[];
  readonly removed: readonly ExtensionPermission[];
  readonly requiresConfirmation: boolean;
};

function key(permission: ExtensionPermission): string {
  return `${permission.capability}:${permission.scope.kind}:${permission.scope.id ?? ''}`;
}

export function permissionDiff(previous: ExtensionManifest, next: ExtensionManifest): ExtensionPermissionDiff {
  const previousPermissions = mapExtensionPermissions(previous.permissions);
  const nextPermissions = mapExtensionPermissions(next.permissions);
  const previousKeys = new Set(previousPermissions.map(key));
  const nextKeys = new Set(nextPermissions.map(key));
  const added = nextPermissions.filter(permission => !previousKeys.has(key(permission)));
  const removed = previousPermissions.filter(permission => !nextKeys.has(key(permission)));
  return {
    added,
    removed,
    requiresConfirmation: added.some(permission => HIGH_RISK_CAPABILITIES.has(permission.capability)),
  };
}

function statusTransition(value: ExtensionStatus): ExtensionStatus {
  if (value !== 'enabled' && value !== 'disabled') {
    throw new CetaError('unsupported', 'Invalid extension lifecycle transition');
  }
  return value;
}

export type ExtensionUpdateInput = ExtensionInstallInput & {
  readonly acceptPermissionEscalation?: boolean;
};

export class ExtensionLifecycleRuntime {
  private readonly validation = new ExtensionValidationRuntime();

  constructor(
    private readonly repository: ExtensionRepository,
    private readonly installer: ExtensionInstallRuntime,
    private readonly clock: () => number = Date.now,
  ) {}

  install(input: ExtensionInstallInput): Promise<InstalledExtension> {
    return this.installer.install(input);
  }

  get(extensionId: string, source: ExtensionSource): Promise<InstalledExtension | undefined> {
    return this.repository.get(extensionId, source);
  }

  list(): Promise<InstalledExtension[]> {
    return this.repository.list();
  }

  private async transition(extensionId: string, source: ExtensionSource, status: ExtensionStatus): Promise<InstalledExtension> {
    const existing = await this.repository.get(extensionId, source);
    if (!existing) {
      throw new CetaError('storage_error', 'Extension is not installed');
    }
    const nextStatus = statusTransition(status);
    if (existing.status === nextStatus) {
      return existing;
    }
    try {
      return await this.repository.save({
        ...existing,
        status: nextStatus,
        revision: existing.revision + 1,
        updatedAt: new Date(this.clock()).toISOString(),
      });
    } catch (error) {
      if (error instanceof CetaError) {
        throw error;
      }
      throw new CetaError('storage_error', 'Extension lifecycle update failed', {cause: error});
    }
  }

  enable(extensionId: string, source: ExtensionSource): Promise<InstalledExtension> {
    return this.transition(extensionId, source, 'enabled');
  }

  disable(extensionId: string, source: ExtensionSource): Promise<InstalledExtension> {
    return this.transition(extensionId, source, 'disabled');
  }

  async update(input: ExtensionUpdateInput): Promise<InstalledExtension> {
    const raw = input.manifest;
    const candidateId = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).id === 'string'
      ? String((raw as Record<string, unknown>).id)
      : '';
    const existing = await this.repository.get(candidateId, input.source);
    if (!existing) {
      throw new CetaError('storage_error', 'Extension is not installed');
    }
    const validated = this.validation.validateManifest(input.manifest);
    if (validated.id !== existing.id) {
      throw new CetaError('invalid_protocol', 'Extension update identifier does not match');
    }
    const diff = permissionDiff(existing.manifest, validated);
    if (diff.requiresConfirmation && !input.acceptPermissionEscalation) {
      throw new CetaError('permission_denied', 'Extension update requires permission confirmation');
    }
    return this.installer.install({
      ...input,
      manifest: validated,
      permissionReview: {
        addedPermissions: diff.added,
        requiresConfirmation: diff.requiresConfirmation,
      },
    });
  }

  async rollback(extensionId: string, source: ExtensionSource): Promise<InstalledExtension> {
    const existing = await this.repository.get(extensionId, source);
    if (!existing) {
      throw new CetaError('storage_error', 'Extension is not installed');
    }
    if (!existing.previousManifest) {
      throw new CetaError('unsupported', 'Extension has no previous version to restore');
    }
    return this.installer.install({
      manifest: existing.previousManifest,
      source,
      packageData: existing.previousManifest,
      publisherMetadata: {publisher: existing.previousManifest.publisher, signatureState: 'unknown'},
      permissionReview: {addedPermissions: [], requiresConfirmation: false},
    });
  }

  async remove(extensionId: string, source: ExtensionSource): Promise<void> {
    const existing = await this.repository.get(extensionId, source);
    if (!existing) {
      throw new CetaError('storage_error', 'Extension is not installed');
    }
    await this.repository.remove(extensionId, source);
  }
}
