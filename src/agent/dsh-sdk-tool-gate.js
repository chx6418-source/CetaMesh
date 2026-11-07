/** Owned Host policy for the separately launched, native-only DSH SDK loop. */
export const DSH_GATE_POLICY_VERSION = 'cetamesh-dsh-tool-v1';

// A literal asset survives Core bundling without capturing esbuild helpers or
// depending on a source path that is absent in the Node SEA executable.
export const DSH_TOOL_GATE_SOURCE = String.raw`
export const name = 'cetamesh-task-gate';
export const inject = ['tools', 'approval', 'agents', 'sessions'];
export function apply(ctx, config) {
  const policyVersion = 'cetamesh-dsh-tool-v1';
  const supported = new Set(['read', 'write', 'edit']);
  const maxReasonBytes = 64 * 1024;
  const maxCalls = 4096;
  if (!config || typeof config.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(config.sessionId)
    || typeof config.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(config.nonce)
    || typeof config.policyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(config.policyFingerprint)) {
    throw new Error('DSH task gate configuration is invalid');
  }
  if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function' || typeof ctx?.provide !== 'function'
    || typeof ctx.tools?.guard !== 'function' || typeof ctx.approval?.request !== 'function'
    || typeof ctx.agents?.get !== 'function' || typeof ctx.sessions?.flush !== 'function') {
    throw new Error('DSH task gate requires policy, Agent and durability dependencies');
  }

  const sessionId = config.sessionId;
  const processNonce = config.nonce;
  const policyFingerprint = config.policyFingerprint;
  const lifetime = new AbortController();
  const pending = new Map();
  const permits = new Map();
  const admitted = new Map();
  const seen = new Map();
  let active = true;
  let boundAgent;

  const deny = reason => ({ kind: 'deny', reason: 'CetaMesh DSH gate: ' + reason });
  const revoke = () => {
    active = false;
    lifetime.abort();
    pending.clear();
    permits.clear();
    admitted.clear();
  };

  // The official pipeline has already materialized JSON. Reject anything that
  // cannot be compared without executing a getter or losing an input value.
  function canonical(value, ancestors = new Set(), depth = 0) {
    if (depth > 64) throw new Error('input nesting exceeds gate limits');
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('input is not lossless JSON');
      return JSON.stringify(value);
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('input is not lossless JSON');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error('input must contain plain JSON objects');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new Error('input contains symbol properties');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => !Object.hasOwn(descriptors[key], 'value'))) throw new Error('input contains accessors');
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      if (value.length > 8192 || keys.length !== value.length + 1) throw new Error('input array is not lossless JSON');
      const entries = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(descriptors, i)) throw new Error('input array has holes');
        entries.push(canonical(descriptors[i].value, ancestors, depth + 1));
      }
      result = '[' + entries.join(',') + ']';
    } else {
      if (keys.length > 8192 || keys.some(key => !descriptors[key].enumerable)) throw new Error('input object exceeds gate limits');
      result = '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonical(descriptors[key].value, ancestors, depth + 1)).join(',') + '}';
    }
    ancestors.delete(value);
    if (new TextEncoder().encode(result).length > maxReasonBytes) throw new Error('input exceeds gate limits');
    return result;
  }

  function live(agent) {
    return active && agent === boundAgent && agent?.id === sessionId && agent.session?.id === sessionId
      && agent.session.header?.parentSession === undefined && ctx.agents.get(sessionId) === agent;
  }

  function capture(exec) {
    if (!live(exec?.agent)) throw new Error('the call has no current owned Agent');
    if (!supported.has(exec.name) || exec.parent !== undefined || exec.rootCallId !== exec.callId) {
      throw new Error('the tool or nested execution is unsupported');
    }
    if (typeof exec.token !== 'symbol' || typeof exec.callId !== 'string'
      || !/^[^\u0000-\u001f\u007f]{1,256}$/.test(exec.callId)
      || !exec.signal || typeof exec.signal.addEventListener !== 'function'
      || typeof exec.signal.aborted !== 'boolean' || exec.signal.aborted) {
      throw new Error('the execution identity or cancellation lifetime is invalid');
    }
    if (!exec.arguments || typeof exec.arguments !== 'object' || Array.isArray(exec.arguments)) {
      throw new Error('a native file tool requires complete object arguments');
    }
    return { exec, agent: exec.agent, session: exec.agent.session, token: exec.token, callId: exec.callId,
      rootCallId: exec.rootCallId, name: exec.name, parent: exec.parent, signal: exec.signal,
      schema: exec.schema, toolSet: exec.toolSet, cwd: exec.agent.session.header?.cwd,
      input: canonical(exec.arguments) };
  }

  function matches(exec, record) {
    if (!record || record.ambiguous || !live(record.agent) || record.signal.aborted || lifetime.signal.aborted
      || exec !== record.exec || exec.agent !== record.agent || exec.agent.session !== record.session
      || exec.token !== record.token || exec.callId !== record.callId || exec.rootCallId !== record.rootCallId
      || exec.name !== record.name || exec.parent !== record.parent || exec.schema !== record.schema
      || exec.toolSet !== record.toolSet || exec.agent.session.header?.cwd !== record.cwd) return false;
    try { return canonical(exec.arguments) === record.input; } catch { return false; }
  }

  async function flush(record) {
    return matches(record.exec, record) && await ctx.sessions.flush(record.session) === true
      && matches(record.exec, record);
  }

  async function prepare(exec) {
    let record;
    try {
      const prior = live(exec?.agent) ? seen.get(exec.callId) : undefined;
      if (prior) {
        prior.ambiguous = true;
        return deny('this call identity cannot be reused');
      }
      record = capture(exec);
      if (seen.size >= maxCalls) return deny('the runtime call limit requires a new controlled run');
      seen.set(record.callId, record);
      const reason = JSON.stringify({ format: policyVersion, processNonce, policyFingerprint,
        sessionId, callId: record.callId, toolName: record.name, input: JSON.parse(record.input) });
      if (new TextEncoder().encode(reason).length > maxReasonBytes) return deny('the complete input exceeds approval limits');
      record.reason = reason;
      pending.set(exec, record);
      // tool/call is appended by the official executor before this hook. Await
      // its actual persistence barrier; an in-memory append is not durability.
      if (!await flush(record)) return deny('native call durability is unavailable');
      const outcome = await ctx.approval.request({ agent: record.agent, toolName: record.name,
        callId: record.callId, reason, signal: AbortSignal.any([record.signal, lifetime.signal]) });
      if (outcome !== 'allowed-once') return deny('Core did not grant this execution');
      // Commit the official asked/decided audit pair before the body can run.
      if (!await flush(record)) return deny('approval durability or current authority is unavailable');
      permits.set(exec, record);
      return { kind: 'allow' };
    } catch {
      return deny('the complete current call could not be authorized');
    } finally {
      pending.delete(exec);
    }
  }

  function guard(exec) {
    const permit = permits.get(exec);
    permits.delete(exec);
    if (!matches(exec, permit)) return 'CetaMesh DSH gate: a current single-use Core permit is required';
    admitted.set(exec, permit);
    return undefined;
  }

  async function dispatch(exec, next) {
    const permit = admitted.get(exec);
    admitted.delete(exec);
    if (!matches(exec, permit)) throw new Error('CetaMesh DSH gate: dispatch input or permit is no longer current');
    const priorSignal = exec.signal;
    exec.signal = AbortSignal.any([priorSignal, permit.signal, lifetime.signal]);
    try {
      exec.signal.throwIfAborted();
      return await next();
    } finally {
      exec.signal = priorSignal;
    }
  }

  ctx.effect(function* () {
    yield ctx.on('agent/created', ({ agent }) => {
      if (agent?.id !== sessionId) return;
      if (boundAgent !== undefined && boundAgent !== agent) { revoke(); return; }
      if (ctx.agents.get(sessionId) === agent && agent.session?.id === sessionId
        && agent.session.header?.parentSession === undefined) boundAgent = agent;
    });
    yield ctx.on('agent/disposed', ({ agent }) => { if (agent === boundAgent) revoke(); });
    yield ctx.on('tools/pre-execute', prepare);
    yield ctx.tools.guard(guard);
    yield ctx.on('tools/execute', dispatch);
    yield ctx.on('tools/result', exec => { pending.delete(exec); permits.delete(exec); admitted.delete(exec); });
    // The SDK server is held behind our readiness service, so this listener
    // precedes its sole stdio answerer in the owned minimal composition.
    yield ctx.on('approval/request', async (request, next) => {
      const record = [...pending.values()].find(item => item.agent === request.agent
        && item.callId === request.callId && item.name === request.toolName && item.reason === request.reason);
      if (!record || !await flush(record)) return 'unavailable';
      return next();
    });
    yield ctx.provide('cetameshDshTaskGateReady', Object.freeze({ policyVersion, policyFingerprint,
      sessionId, processNonce, tools: Object.freeze([...supported]) }));
    // Reverse, ordered teardown closes admission and withdraws readiness before
    // the mandatory guard is removed. Revocation never means removing a guard.
    yield revoke;
  }, 'CetaMesh DSH Task tool gate');
}
`;
