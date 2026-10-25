import crypto from 'node:crypto';
import { OWNER_ACTOR, capabilityError } from '../capability/types.js';
import { requestFingerprint } from '../capability/approval.js';
import { redactText } from '../logging/redact.js';
import { isNativePermissionSecurity } from './execution-security.js';
import { permissionFingerprint } from './protocol/agent-permission-bridge.js';

const CAPABILITY = 'agent.native.approve';
const TTL_MS = 600000;
const MAX_PENDING = 128;
const cancelled = () => ({ outcome: 'cancelled' });
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\x00-\x1f\x7f]/.test(value);

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function reviewText(value, limit) {
  const text=redactText(String(value ?? ''))
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => {
      try { const parsed = new URL(url); return parsed.origin + parsed.pathname + (parsed.search || parsed.hash || parsed.username || parsed.password ? '[REDACTED_URL_PARAMETERS]' : ''); }
      catch { return '[REDACTED_URL]'; }
    });
  return limit === undefined ? text : text.slice(0,limit);
}

function reviewValue(value, budget = {nodes:0}, depth = 0) {
  if (depth > 12 || ++budget.nodes > 2048) throw capabilityError('AGENT_NATIVE_REVIEW_LIMIT','Native operation is too complex to review completely');
  if (typeof value === 'string') return reviewText(value);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(item => reviewValue(item,budget,depth + 1));
  if (typeof value !== 'object') throw capabilityError('AGENT_NATIVE_REVIEW_LIMIT','Native operation contains unsupported review data');
  const safe = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const safeKey = reviewText(key);
    if (Object.hasOwn(safe,safeKey)) throw capabilityError('AGENT_NATIVE_REVIEW_LIMIT','Native review field names are ambiguous');
    // Keep executable arguments and write content visible; redact only credential and private context fields.
    safe[safeKey] = /secret|token|auth|credential|password|passwd|api.?key|private.?key|cookie|^env(?:ironment)?$|^prompt$|^history$|^output$/i.test(key)
      ? '[REDACTED_SECRET]' : reviewValue(item,budget,depth + 1);
  }
  return safe;
}

function nativeDetails(snapshot) {
  const summary = { action: reviewText(snapshot.action), title: reviewText(snapshot.target.title),
    locations: reviewValue(snapshot.target.locations ?? []), arguments: reviewValue(snapshot.target.rawInput ?? {}) };
  const text = JSON.stringify(summary);
  // Approval cannot cover an operation whose meaningful arguments were silently omitted.
  if (Buffer.byteLength(text,'utf8') > 8192) throw capabilityError('AGENT_NATIVE_REVIEW_LIMIT','Native operation exceeds the complete review size limit');
  return text;
}

/** Trusted in-process native permission callback. Its capability never runs an OS tool. */
export function createNativeApprovalAdapter({ broker, resolveTask, resolveWorkspace, agentBroker, now = () => Date.now() } = {}) {
  const pending = new Map();
  const seen = new Map();
  let closed = false;
  // A persisted approval is unusable without its process-local native request.
  for (const row of broker.approvals.list()) {
    if (row.request?.capability === CAPABILITY) broker.approvals.cancel(row.id, 'native-process-restarted');
  }

  function revoke(entry, reason) {
    if (!entry.approvalId) return true;
    try {
      const row = broker.approvals.get(entry.approvalId);
      if (row.status === 'pending') broker.approvals.cancel(entry.approvalId, reason);
      else if (row.status === 'approved') broker.approvals.revoke(entry.approvalId, reason);
      return true;
    } catch {
      // A missing/unwritable authority row cannot preserve an approval outcome.
      return false;
    }
  }
  function finish(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    if (outcome.outcome !== 'approved' && !revoke(entry, 'native-' + outcome.outcome)) outcome = cancelled();
    clearTimeout(entry.poll);
    clearTimeout(entry.timeout);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (pending.get(entry.snapshot.requestId) === entry) pending.delete(entry.snapshot.requestId);
    entry.resolve(outcome);
  }
  function checkBinding(entry) {
    if (closed || entry.settled || entry.signal?.aborted || pending.get(entry.snapshot.requestId) !== entry)
      throw capabilityError('AGENT_NATIVE_APPROVAL_CANCELLED', 'Native permission request is no longer active');
    if (now() >= entry.expiresAt) throw capabilityError('APPROVAL_EXPIRED', 'Native permission request expired');
    const input = entry.snapshot;
    const task = resolveTask?.(input.taskId);
    if (!task || task.id !== input.taskId || task.status !== 'running' || task.workspaceId !== input.workspaceId
      || task.currentAgent?.provider !== input.provider || task.currentAgent?.sessionId !== input.sessionId
      || (task.authorizationRevision ?? task.rev) !== entry.authorizationRevision)
      throw capabilityError('TASK_NOT_AUTHORIZED', 'Native permission Task assignment changed');
    const workspace = resolveWorkspace?.(input.workspaceId);
    if (!workspace || permissionFingerprint(workspace) !== entry.workspaceFingerprint)
      throw capabilityError('WORKSPACE_RECONCILIATION_REQUIRED', 'Native permission Workspace changed');
    const scope = agentBroker?.assertExecutionConsent?.(input.provider, { workspaceId: input.workspaceId });
    if (!scope?.authorized || !isNativePermissionSecurity(scope.security)
      || scope.fingerprint !== entry.securityFingerprint)
      throw capabilityError('AGENT_SECURITY_POLICY_CHANGED', 'Native permission execution policy changed');
  }
  async function checkSession(entry) {
    checkBinding(entry);
    const input = entry.snapshot;
    const status = await agentBroker.status({ provider: input.provider, sessionId: input.sessionId });
    checkBinding(entry);
    if (status?.sessionId !== input.sessionId || status.taskId !== input.taskId || status.workspaceId !== input.workspaceId
      || status.running !== true || !['waiting', 'running'].includes(status.state)
      || (status.provider != null && status.provider !== input.provider))
      throw capabilityError('AGENT_NATIVE_SESSION_INACTIVE', 'Native permission Session is no longer executing');
  }
  function denyChanged(entry) {
    finish(entry, { outcome: now() >= entry.expiresAt ? 'expired' : 'cancelled' });
  }
  function activeRequest(request) {
    const entry = pending.get(request.requestId);
    if (request.actor?.kind !== 'owner' || request.actor.id !== OWNER_ACTOR.id || request.approved === true
      || !entry || entry.settled || request.capability !== CAPABILITY
      || request.taskId !== entry.snapshot.taskId || request.workspaceId !== entry.snapshot.workspaceId
      || request.reason !== entry.reason || permissionFingerprint(request.input) !== entry.inputFingerprint
      || (request.approvalId ? request.approvalId !== entry.approvalId : entry.approvalId !== null))
      throw capabilityError('PERMISSION_DENIED', 'Only an active internal native permission request may be reviewed');
    return entry;
  }
  broker.register({ id: CAPABILITY, permission: 'agent.run', provider: 'agent-broker', workspace: true,
    requiresTask: true, risk: 'high', modelCallable: false,
    description: 'Allow one exact native Agent tool request after Owner review. Native execution has no OS sandbox.',
    async validate(request) {
      const entry = activeRequest(request);
      try { await checkSession(entry); }
      catch (error) { denyChanged(entry); throw error; }
    },
    async execute(request) {
      const entry = activeRequest(request);
      try {
        await checkSession(entry);
        const approval = broker.approvals.get(request.approvalId);
        if (approval.status !== 'consumed' || approval.fingerprint !== requestFingerprint(request))
          throw capabilityError('PERMISSION_DENIED', 'A consumed Owner approval is required for native execution');
        const result = { outcome: 'approved', optionId: entry.optionId };
        finish(entry, result);
        return result;
      } catch (error) { denyChanged(entry); throw error; }
    }
  });

  function request(input, { signal } = {}) {
    let snapshot;
    try {
      if (closed || signal?.aborted || !input || typeof input !== 'object') return Promise.resolve(cancelled());
      if (!['provider', 'sessionId', 'workspaceId', 'taskId', 'requestId'].every(key => identifier(input[key]))
        || !input.target || typeof input.target !== 'object' || !identifier(input.target.toolCallId)
        || !Object.hasOwn(input.target,'rawInput') || input.target.rawInput === null
        || typeof input.target.rawInput !== 'object' || Array.isArray(input.target.rawInput)
        || ![Object.prototype,null].includes(Object.getPrototypeOf(input.target.rawInput))
        || !Array.isArray(input.options) || input.options.length > 32
        || input.action !== (input.target.kind ?? 'other')
        || input.options.some(option => !identifier(option?.optionId) || !['allow_once', 'reject_once'].includes(option.kind))
        || !input.options.some(option => option.kind === 'allow_once')) return Promise.resolve(cancelled());
      if (JSON.stringify(input).length > 262144) return Promise.resolve(cancelled());
      snapshot = immutable(structuredClone(input));
      const hash = permissionFingerprint({ provider: snapshot.provider, sessionId: snapshot.sessionId,
        workspaceId: snapshot.workspaceId, taskId: snapshot.taskId, toolCall: snapshot.target, options: snapshot.options });
      if (hash !== snapshot.fingerprint) return Promise.resolve(cancelled());
      for (const [id, expiry] of seen) if (expiry <= now()) seen.delete(id);
      if (pending.size >= MAX_PENDING || seen.size >= 4096 || seen.has(snapshot.requestId)) return Promise.resolve(cancelled());
      const workspace = resolveWorkspace?.(snapshot.workspaceId);
      const task = resolveTask?.(snapshot.taskId);
      const scope = agentBroker?.assertExecutionConsent?.(snapshot.provider, { workspaceId: snapshot.workspaceId });
      if (!workspace || !task || !scope?.authorized || !isNativePermissionSecurity(scope.security)) return Promise.resolve(cancelled());
      const entry = { snapshot, signal, settled: false, approvalId: null, expiresAt: now() + TTL_MS,
        workspaceFingerprint: permissionFingerprint(workspace), securityFingerprint: scope.fingerprint,
        authorizationRevision: task.authorizationRevision ?? task.rev,
        optionId: snapshot.options.find(option => option.kind === 'allow_once').optionId };
      const review = { nativeMarker: crypto.randomUUID(), nativeDetails: nativeDetails(snapshot) };
      entry.reason = 'Owner approval for one native Agent tool: ' + reviewText(snapshot.target.title || snapshot.action, 800)
        + '. No OS sandbox; the approved tool may access host files and network.';
      entry.inputFingerprint = permissionFingerprint(review);
      const result = new Promise(resolve => { entry.resolve = resolve; });
      pending.set(snapshot.requestId, entry);
      seen.set(snapshot.requestId, entry.expiresAt);
      entry.onAbort = () => finish(entry, cancelled());
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      entry.timeout = setTimeout(() => finish(entry, { outcome: 'expired' }), TTL_MS);
      const poll = async () => {
        if (entry.settled) return;
        try {
          await checkSession(entry);
          if (entry.approvalId) {
            const row = broker.approvals.get(entry.approvalId);
            if (row.expiresAt <= now()) finish(entry, { outcome: 'expired' });
            else if (row.status === 'rejected') finish(entry, { outcome: 'rejected' });
            else if (['cancelled', 'revoked'].includes(row.status)) finish(entry, cancelled());
          }
        } catch { denyChanged(entry); }
        finally {
          if (!entry.settled) entry.poll = setTimeout(poll, Math.min(25, Math.max(1, entry.expiresAt - now())));
        }
      };
      entry.poll = setTimeout(poll, 25);
      Promise.resolve().then(async () => {
        const created = await broker.execute({ requestId: snapshot.requestId, actor: OWNER_ACTOR,
          capability: CAPABILITY, taskId: snapshot.taskId, workspaceId: snapshot.workspaceId,
          input: review, reason: entry.reason }, { signal });
        if (created.status !== 'pending' || !created.approvalId) throw capabilityError('PERMISSION_DENIED', 'Native request requires Owner approval');
        entry.approvalId = created.approvalId;
        entry.expiresAt = Math.min(entry.expiresAt, created.expiresAt);
        if (entry.settled) revoke(entry, 'native-cancelled');
      }).catch(() => denyChanged(entry));
      if (signal?.aborted) entry.onAbort();
      return result;
    } catch { return Promise.resolve(cancelled()); }
  }
  return { request, close() { closed = true; for (const entry of [...pending.values()]) finish(entry, cancelled()); } };
}
