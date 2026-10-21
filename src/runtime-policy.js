/** Canonical runtime policies, independent of per-Chat-Session chat/smart modes. */
export const CONTROL_MODES = Object.freeze(['chat', 'owner-agent', 'social', 'workshop']);
export const RUNTIME_POLICIES = Object.freeze(['social', 'owner-agent', 'workshop']);
const LEGACY_MODE_MIGRATIONS = Object.freeze({
  'closed-agent': 'owner-agent',
  reserved: 'chat',
  reserved2: 'social'
});
/** Preserve unknown values so callers reject them instead of choosing a privileged policy. */
export function normalizeRuntimeMode(value) {
  const text = String(value ?? '').trim();
  return Object.hasOwn(LEGACY_MODE_MIGRATIONS, text) ? LEGACY_MODE_MIGRATIONS[text] : text;
}
export const migrateLegacyMode = normalizeRuntimeMode;
