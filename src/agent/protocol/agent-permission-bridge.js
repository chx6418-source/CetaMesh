import crypto from 'node:crypto';
const cancelled = () => ({outcome:{outcome:'cancelled'}});
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const permissionFingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Authority is injected by trusted composition, never supplied by the ACP peer. */
export function createAgentPermissionBridge({provider, sessionId, workspaceId, taskId, nativeSessionId = sessionId,
  requestNativeApproval, maxPending = 256} = {}) {
  const pending = new Map();
  let generation = 0, closed = false;
  function invalidate(toolCallId) {
    for (const [key, entry] of pending) if (!toolCallId || entry.toolCallId === toolCallId) {
      pending.delete(key); entry.cancel();
    }
  }
  return {
    async request(params) {
      if (closed || typeof requestNativeApproval !== 'function' || params?.sessionId !== nativeSessionId
        || ['provider','workspaceId','taskId','fingerprint'].some(key => Object.hasOwn(params ?? {},key))
        || !params.toolCall || typeof params.toolCall.toolCallId !== 'string'
        || !Array.isArray(params.options) || pending.size >= maxPending) return cancelled();
      const options = params.options.filter(option => typeof option?.optionId === 'string'
        && ['allow_once','reject_once'].includes(option.kind));
      if (!options.some(option => option.kind === 'allow_once')) return cancelled();
      const requestId = crypto.randomUUID(), epoch = generation;
      const snapshot = structuredClone({toolCall:params.toolCall,options});
      const fingerprint = permissionFingerprint({provider,sessionId,workspaceId,taskId,...snapshot});
      let release, timer;
      const controller = new AbortController();
      const aborted = new Promise(resolve => { release = () => { controller.abort(); resolve(null); }; });
      pending.set(requestId,{cancel:release,toolCallId:params.toolCall.toolCallId});
      try {
        const result = await Promise.race([aborted,
          new Promise(resolve => { timer = setTimeout(()=>{ controller.abort(); resolve(null); },600000); }),
          Promise.resolve().then(() => !closed && epoch === generation && pending.has(requestId) ? requestNativeApproval({
          provider,sessionId,workspaceId,taskId,requestId,fingerprint,
          action:snapshot.toolCall.kind ?? 'other',target:snapshot.toolCall,options:snapshot.options
        }, { signal: controller.signal }) : null)]);
        if (closed || epoch !== generation || !pending.has(requestId) || result?.outcome !== 'approved'
          || permissionFingerprint({provider,sessionId,workspaceId,taskId,...snapshot}) !== fingerprint) return cancelled();
        const selected = options.find(option => option.optionId === result.optionId && option.kind === 'allow_once');
        return selected ? {outcome:{outcome:'selected',optionId:selected.optionId}} : cancelled();
      } catch { return cancelled(); /* Approval failures always deny native execution. */ }
      finally { controller.abort(); clearTimeout(timer); pending.delete(requestId); }
    },
    invalidate,
    cancel() { generation++; invalidate(); },
    close() { closed = true; generation++; invalidate(); }
  };
}
