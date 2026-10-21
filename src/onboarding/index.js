// CetaMesh Desktop —— 首次运行引导公共入口（产品化任务 D，第七节）。
export { createOnboardingService, sanitizeStepData } from './service.js';
export {
  ONBOARDING_STEPS,
  OPTIONAL_STEP_IDS,
  REQUIRED_STEP_IDS,
  STEP_STATES,
  checkRequiredOrder,
  isKnownStepId,
  missingRequiredStepIds,
  nextStepId,
  stepById
} from './steps.js';
export {
  ONBOARDING_ERROR_CODES,
  ONBOARDING_STATUSES,
  ONBOARDING_STORE_VERSION,
  createOnboardingStore,
  freshState,
  normalizeState,
  onboardingStoreError
} from './store.js';
