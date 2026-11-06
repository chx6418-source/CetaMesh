// Public Chat failure metadata carries known recovery codes, never raw process,
// boot or filesystem evidence. Repeat this projection when reading old history.
const RECOVERY_CODES = new Set([
  'CODEX_HOST_RESTART_REQUIRED',
  'CODEX_LEGACY_STOP_EVIDENCE_MISSING',
  'CODEX_HOST_RESTART_UNVERIFIED'
]);

export function projectChatFailureDetails(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && RECOVERY_CODES.has(value.recoveryCode)
    ? { recoveryCode: value.recoveryCode } : null;
}

export function projectChatFailureMessage(value, code) {
  if (!value) return null;
  if (code === 'TASK_WORKSPACE_BUSY') return '工作区仍被占用，程序将自动核验恢复条件。';
  if (code === 'SESSION_EXECUTION_UNCONFIRMED') return '旧执行停止状态尚未确认，程序将自动核验恢复条件。';
  return typeof value === 'string' ? value.slice(0, 1000) : null;
}
