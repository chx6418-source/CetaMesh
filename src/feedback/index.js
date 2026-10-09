// CetaMesh Desktop —— Feedback 公共入口（产品化任务 D）。
export { createFeedbackService, FLUSH_MAX_PER_CALL } from './service.js';
export {
  OUTBOX_MAX_ENTRIES_DEFAULT,
  OUTBOX_STATUSES,
  OUTBOX_VERSION,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  createFeedbackOutbox,
  outboxError,
  retryDelayMs
} from './outbox.js';
export {
  FEEDBACK_MAX_BODY_BYTES,
  FEEDBACK_TIMEOUT_MS_DEFAULT,
  FEEDBACK_TRANSPORT_CODES,
  createFeedbackTransport
} from './transport.js';
export {
  FEEDBACK_LIMITS,
  FEEDBACK_SCHEMA_VERSION,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_LABELS,
  SECURITY_FEEDBACK_TYPE,
  feedbackError,
  isSecurityType,
  newFeedbackId,
  validateSubmission
} from './types.js';
