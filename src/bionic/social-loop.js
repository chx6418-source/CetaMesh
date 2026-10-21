export function createSocialLoop({ tick, intervalMs = 5000, onError = error => console.error('Social loop failed:', error?.message ?? error) }) {
  let timer = null;
  let active = false;
  const schedule = () => {
    if (!active) return;
    timer = setTimeout(async () => {
      try { if (active) await tick(); }
      catch (error) { onError(error); }
      finally { if (active) schedule(); }
    }, intervalMs);
    timer.unref?.();
  };
  return {
    start() { if (!active) { active = true; schedule(); } return timer; },
    stop() { active = false; if (timer) clearTimeout(timer); timer = null; },
    running: () => active
  };
}
