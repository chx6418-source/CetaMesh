// CetaMesh Desktop —— 设置公共入口（阶段 12）。
export { createSettingsService } from './service.js';
export { createSettingsStore } from './store.js';
export {
  ENGINEERING_AREAS,
  ENGINEERING_PAGES,
  PRIMARY_PAGES,
  engineeringPlacement
} from './pages.js';
export {
  FIELDS,
  SECTION_LABELS,
  SETTINGS_SCHEMA_VERSION,
  SETTING_SECTIONS,
  coerceField,
  defaultSettings,
  describeFields,
  isKnownSection,
  normalizeSettings,
  settingsError,
  validateSectionPatch
} from './schema.js';
