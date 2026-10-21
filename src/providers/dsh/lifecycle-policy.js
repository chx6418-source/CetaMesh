export const DSH_LIFECYCLE_POLICY = Object.freeze({
  pollIntervalMs: 5000,
  minPollIntervalMs: 1000,
  maxPollIntervalMs: 60000
});
export const DEFAULT_DSH_POLL_INTERVAL_MS = DSH_LIFECYCLE_POLICY.pollIntervalMs;

export function resolveDshPollInterval(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_DSH_POLL_INTERVAL_MS;
  return Math.min(
    DSH_LIFECYCLE_POLICY.maxPollIntervalMs,
    Math.max(DSH_LIFECYCLE_POLICY.minPollIntervalMs, Math.round(requested))
  );
}
