import type {CapabilityPlatform, CapabilityRisk} from '../capability/Capability';
import type {ExtensionNetworkAccess} from './ExtensionManifest';
import type {ExtensionPermission} from './ExtensionPermission';

export const EXTENSION_SIGNATURE_STATES = ['unsigned', 'verified', 'invalid', 'unknown'] as const;
export type ExtensionSignatureState = (typeof EXTENSION_SIGNATURE_STATES)[number];
export type ExtensionSource = 'base' | 'user-overlay' | 'import';
export type ExtensionStatus = 'installed' | 'enabled' | 'disabled';

export type SecurityReport = {
  readonly source: ExtensionSource;
  readonly publisher: string;
  readonly signatureState: ExtensionSignatureState;
  readonly permissions: readonly ExtensionPermission[];
  readonly addedPermissions: readonly ExtensionPermission[];
  readonly capabilities: readonly string[];
  readonly dataScope: readonly string[];
  readonly networkAccess: ExtensionNetworkAccess;
  readonly platforms: readonly CapabilityPlatform[];
  readonly risk: CapabilityRisk;
  readonly contentHash: string;
  readonly requiresPermissionConfirmation: boolean;
};
