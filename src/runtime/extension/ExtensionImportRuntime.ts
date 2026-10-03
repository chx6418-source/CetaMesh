import type {ExtensionManifest} from '../../domain/extension/ExtensionManifest';
import type {ExtensionPackagePicker} from '../../domain/extension/ExtensionPackagePicker';
import type {ExtensionPermission} from '../../domain/extension/ExtensionPermission';
import type {InstalledExtension} from '../../domain/extension/ExtensionRepository';
import {EXTENSION_PACKAGE_MAX_BYTES} from '../../domain/extension/ExtensionPackagePicker';
import {CetaError} from '../../shared/errors/CetaError';
import {ExtensionValidationRuntime, mapExtensionPermissions} from './ExtensionValidationRuntime';
import {validateExtensionPackageData} from './ExtensionInstallRuntime';
import {ExtensionLifecycleRuntime, permissionDiff} from './ExtensionLifecycleRuntime';

export type ExtensionImportCandidate = {
  readonly fileName: string;
  readonly manifest: ExtensionManifest;
  readonly existingRevision?: number;
  readonly existingVersion?: string;
  readonly addedPermissions: readonly ExtensionPermission[];
  readonly removedPermissions: readonly ExtensionPermission[];
  readonly requiresPermissionConfirmation: boolean;
};

export class ExtensionImportRuntime {
  private readonly validation = new ExtensionValidationRuntime();

  constructor(
    private readonly lifecycle: ExtensionLifecycleRuntime,
    private readonly picker: ExtensionPackagePicker,
  ) {}

  async prepareImport(): Promise<ExtensionImportCandidate> {
    const document = await this.picker.pick();
    if (!document.text || document.text.length > EXTENSION_PACKAGE_MAX_BYTES || document.text.includes('\0')) {
      throw new CetaError('unsupported', 'Extension manifest is empty or too large');
    }
    let value: unknown;
    try {
      value = JSON.parse(document.text);
    } catch {
      throw new CetaError('invalid_protocol', 'Choose a valid CetaMesh extension manifest');
    }
    const manifest = this.validation.validateManifest(value);
    validateExtensionPackageData(manifest);
    const existing = await this.lifecycle.get(manifest.id, 'import');
    const permissions = existing
      ? permissionDiff(existing.manifest, manifest)
      : {added: mapExtensionPermissions(manifest.permissions), removed: [], requiresConfirmation: false};
    return {
      fileName: document.name,
      manifest,
      ...(existing ? {existingRevision: existing.revision, existingVersion: existing.manifest.version} : {}),
      addedPermissions: permissions.added,
      removedPermissions: permissions.removed,
      requiresPermissionConfirmation: permissions.added.length > 0,
    };
  }

  async install(candidate: ExtensionImportCandidate, acceptPermissionChanges: boolean): Promise<InstalledExtension> {
    const manifest = this.validation.validateManifest(candidate.manifest);
    const existing = await this.lifecycle.get(manifest.id, 'import');
    if ((candidate.existingRevision ?? 0) !== (existing?.revision ?? 0)) {
      throw new CetaError('sync_conflict', 'This extension changed. Review the package again.');
    }
    const diff = existing
      ? permissionDiff(existing.manifest, manifest)
      : {added: mapExtensionPermissions(manifest.permissions), removed: [], requiresConfirmation: false};
    if (diff.added.length > 0 && !acceptPermissionChanges) {
      throw new CetaError('permission_denied', 'Review and accept the added extension permissions');
    }
    const input = {
      manifest,
      packageData: manifest,
      source: 'import' as const,
      publisherMetadata: {publisher: manifest.publisher, signatureState: 'unsigned' as const},
      permissionReview: {addedPermissions: diff.added, requiresConfirmation: diff.added.length > 0},
    };
    if (existing) {
      return this.lifecycle.update({...input, acceptPermissionEscalation: acceptPermissionChanges});
    }
    return this.lifecycle.install(input);
  }
}
