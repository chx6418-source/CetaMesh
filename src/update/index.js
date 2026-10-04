// CetaMesh Desktop —— 更新公共入口（阶段 12）。
export { createUpdateService } from './service.js';
export { createUpdateChecker } from './checker.js';
export { verifyManifestSignature } from './verify.js';
export {
  UPDATE_CHANNELS,
  UPDATE_MANIFEST_VERSION,
  compareVersions,
  hostAllowedForDownload,
  manifestSigningString,
  signManifest,
  updateError,
  validateManifest
} from './manifest.js';
