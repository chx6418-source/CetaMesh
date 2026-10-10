// CetaMesh Desktop —— 产品面公共入口（产品化任务 D + 反馈修正）。
export { createProductService } from './service.js';
export {
  DEFAULT_RELEASE_CONFIG,
  DEFAULT_FEEDBACK_PATHS,
  RELEASE_CONFIG_FILENAME,
  RELEASE_CONFIG_VERSION,
  configReadiness,
  deriveAdvisoryUrl,
  loadReleaseConfig,
  resolveFeedbackBaseUrl,
  resolveSecurityContact
} from './release-config.js';
export {
  BROWSER_OPEN_FAILURE_MESSAGE,
  FEEDBACK_ALLOWED_QUERY_KEYS,
  FEEDBACK_ENTRY_IDS,
  FEEDBACK_NOT_CONFIGURED_MESSAGE,
  SECURITY_NOTICE,
  buildEntryUrl,
  buildFeedbackLinks,
  entryById,
  platformTag,
  safeQueryValue,
  sanitizeQueryValue
} from './feedback-links.js';
export {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_POLICY,
  DIAGNOSTICS_SCHEMA_VERSION,
  buildDiagnostics
} from './diagnostics.js';
export { ERROR_REGISTRY_LIMIT, createErrorRegistry } from './error-registry.js';
export {
  EMPTY_STATES,
  GENERIC_EMPTY_STATE_KEY,
  TECHNICAL_CODE_TO_STATE,
  emptyStateFor,
  emptyStateForError
} from './empty-states.js';
export {
  PROVIDER_BASIC_FIELD_KEYS,
  buildProviderView,
  describeProviderTestFailure,
  providerFieldGuidance
} from './provider-view.js';
