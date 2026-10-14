/** Classify a test suite exit without confusing an explicit, verified environment skip with PASS. */
export function classifySuiteOutcome({ code, signal = null, error = null, treeError = null, timedOut = false, output = '' } = {}) {
  const environmentSkipped = !error && !treeError && !timedOut && signal === null
    && code === 77 && /^NOT_RUN_ENVIRONMENT:/m.test(String(output));
  const failed = Boolean(error) || Boolean(treeError) || timedOut || (code !== 0 && !environmentSkipped);
  return {
    status: environmentSkipped ? 'NOT_RUN_ENVIRONMENT' : failed ? 'FAIL' : 'PASS',
    failed
  };
}
