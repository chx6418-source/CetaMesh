// CetaMesh Desktop —— 更新公共入口（阶段 12 / 分发运行时 v1）。
export { createUpdateService } from './service.js';
export { createUpdateChecker } from './checker.js';
export { verifyManifestSignature } from './verify.js';
export {
  DOWNLOAD_MAX_BYTES_DEFAULT,
  DOWNLOAD_MAX_REDIRECTS_DEFAULT,
  DOWNLOAD_TIMEOUT_MS_DEFAULT,
  createArtifactDownloader
} from './download.js';
export {
  DEFAULT_GITHUB_FALLBACK_MANIFEST_URL,
  DEFAULT_GITCODE_MANIFEST_URL,
  DEFAULT_SOURCE_TIMEOUT_MS,
  UPDATE_SOURCE_IDS,
  buildUpdateSources
} from './sources.js';
export {
  UPDATE_CHANNELS,
  UPDATE_MANIFEST_VERSION,
  compareVersions,
  hostAllowedForDownload,
  manifestSigningString,
  selectArtifact,
  signManifest,
  updateError,
  validateManifest
} from './manifest.js';
