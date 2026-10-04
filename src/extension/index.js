// CetaMesh Desktop Extension v1 —— 公共入口（阶段 10）。
export { createExtensionService } from './service.js';
export { createExtensionRuntime } from './runtime.js';
export { createExtensionInstaller } from './installer.js';
export { createExtensionStore, EXTENSION_REGISTRY_VERSION } from './store.js';
export { createExtensionHost } from './host.js';
export { ENFORCED_PERMISSIONS, buildReview, isEnforced, permissionDelta, reviewSummaryLines, reviewToken } from './review.js';
export {
  assertManifest,
  canonicalManifestHash,
  manifestFingerprint,
  validateManifest,
  MANIFEST_FILENAMES,
  MANIFEST_VERSION
} from './manifest.js';
export { blankOutComments, scanEntrySource } from './scan.js';
export {
  EXTENSION_LIMITS,
  EXTENSION_STATUSES,
  EXTENSION_TYPES,
  PERMISSIONS,
  PERMISSION_NAMES,
  RISK_LEVELS,
  compareVersions,
  extensionError,
  hostAllowed,
  isKnownPermission,
  permissionRisk,
  requiresExplicitApproval,
  riskRank
} from './types.js';
