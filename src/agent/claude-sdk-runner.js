import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { claudeProfileEnvironment } from './claude-runtime.js';
import { permissionFingerprint } from './protocol/agent-permission-bridge.js';
import { loadClaudeSdkResource } from './claude-sdk-resource.js';
function validEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try { const endpoint = new URL(value); return endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash; }
  catch { return false; }
}
const fault = code => Object.assign(new Error(code), { code });

/** Private anonymous stdio RPC. Never write credentials or SDK exception text to output. */
export async function runClaudeSdkRunner({ input = process.stdin, output = process.stdout, loadSdk = loadClaudeSdkResource } = {}) {
  let sdk, configuration, active, closed = false, nativeId, resumeId;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  function stop() {
    if (closed) return;
    closed = true;
    active?.controller.abort();
    // AbortController is the SDK's authoritative shutdown signal; interrupt is best effort.
    Promise.resolve().then(() => active?.query?.interrupt()).catch(() => { /* SDK errors cannot escape private supervision. */ });
    configuration = null; sdk = null;
    rpc.close(); finish();
  }
  const rpc = createJsonRpcTransport({ readable: input, writable: output, framing: 'acp-v1-jsonl',
    onClose: stop,
    onNotification(method, params) {
      if (method === 'session/cancel' && params?.sessionId === nativeId) active?.controller.abort();
    },
    async onRequest(method, params = {}) {
      if (closed) throw fault('CLAUDE_RUNNER_CLOSED');
      if (method === 'initialize') {
        if (configuration && params.protocolVersion === 1) return { protocolVersion: 1, agentCapabilities: {} };
        const account=params.authMode==='provider-login';
        if (configuration || (params.authMode!==undefined&&!['api-key','provider-login'].includes(params.authMode))
            || (account ? (params.credential!==undefined||params.baseUrl!==undefined||!params.profileRoot||params.executionMode!=='native-permissions') : (typeof params.credential !== 'string' || !params.credential)) ||
            typeof params.cwd !== 'string' || !params.cwd || typeof params.runtimePath !== 'string' || !params.runtimePath ||
            !Array.isArray(params.tools) || params.tools.some(t => typeof t !== 'string')
            || (params.baseUrl !== undefined && !validEndpoint(params.baseUrl))
            || (params.profileRoot !== undefined && (typeof params.profileRoot !== 'string' || !path.isAbsolute(params.profileRoot) || path.dirname(params.profileRoot) === params.profileRoot))
            || (params.executionMode !== undefined && (params.executionMode !== 'native-permissions' || !params.profileRoot))
            || (params.model !== undefined && (typeof params.model !== 'string' || !params.model.trim()
              || params.model !== params.model.trim() || params.model.length > 256 || /[\u0000-\u001f\u007f]/.test(params.model)))) throw fault('CLAUDE_INVALID_CONFIG');
        const loaded = await loadSdk();
        if (closed || typeof loaded?.query !== 'function') throw fault('CLAUDE_SDK_UNAVAILABLE');
        sdk = loaded;
        configuration = { authMode:account?'provider-login':'api-key', ...(params.baseUrl === undefined ? {} : { baseUrl: params.baseUrl }),
          ...(params.profileRoot === undefined ? {} : { profileRoot: params.profileRoot }),
          ...(params.executionMode === undefined ? {} : { executionMode: params.executionMode }), credential: params.credential, cwd: params.cwd, runtimePath: params.runtimePath, tools: [...params.tools], ...(params.model === undefined ? {} : { model: params.model }) };
        return { initialized: true };
      }
      if (method === 'shutdown') { setImmediate(stop); return { stopped: true }; }
      if (!configuration) throw fault('CLAUDE_NOT_INITIALIZED');
      if (method === 'session/new') {
        if (nativeId || params.cwd !== configuration.cwd) throw fault('CLAUDE_SESSION_INVALID');
        nativeId = crypto.randomUUID();
        return { sessionId: nativeId };
      }
      const acp = method === 'session/prompt';
      if (acp) {
        if (params.sessionId !== nativeId || !Array.isArray(params.prompt) || params.prompt.some(p => p.type !== 'text' || typeof p.text !== 'string')) throw fault('CLAUDE_SESSION_INVALID');
        params = { prompt: params.prompt.map(p => p.text).join('\n'), ...(resumeId ? {resume:resumeId} : {}) };
      }
      if (method === 'cancel') {
        active?.controller.abort();
        if (active?.query) await active.query.interrupt();
        return { cancelled: Boolean(active) };
      }
      if (method !== 'turn' && !acp) throw fault('CLAUDE_METHOD_UNSUPPORTED');
      if (active || typeof params.prompt !== 'string' || !params.prompt.trim() ||
          (params.resume !== undefined && typeof params.resume !== 'string')) throw fault('CLAUDE_INVALID_TURN');
      const turn = { controller: new AbortController(), query: null };
      active = turn;
      const config = configuration;
      const deny = { behavior: 'deny', message: 'Tool use denied by host policy' };
      // SDK0.3.308: PreToolUseHookInput.tool_use_id and CanUseTool.options.toolUseID
      // identify the same call. Hooks run before default-policy auto-approval of reads.
      // https://code.claude.com/docs/en/agent-sdk/permissions
      // These native tool permissions provide no OS sandbox or filesystem isolation.
      const decisions = new Map(), seenHooks = new Set();
      const alive = signal => !closed && active === turn && !turn.controller.signal.aborted && !signal?.aborted;
      async function approvedInput(tool, toolInput, toolUseID, signal, fromHook = false) {
        if (!alive(signal) || typeof toolUseID !== 'string' || !toolUseID) return null;
        let entry = decisions.get(toolUseID);
        // A hook ID is consumed by its first invocation. A duplicate revokes even
        // an in-flight decision, and the matching SDK second stage can be used once.
        if (entry && (fromHook || entry.permissionConsumed)) { entry.controller.abort(); return null; }
        if (!config.tools.includes(tool) || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
          entry?.controller.abort(); return null;
        }
        let snapshot, fingerprint;
        try {
          snapshot = structuredClone(toolInput);
          fingerprint = permissionFingerprint({ tool, input: snapshot });
        } catch { entry?.controller.abort(); return null; }
        if (entry && entry.fingerprint !== fingerprint) { entry.controller.abort(); return null; }
        // canUseTool is only a second SDK stage for the hook's exact call. It must
        // never create another prompt, accept a different input, or persist rules.
        if (!entry) {
          if (!fromHook || decisions.size >= 1024) return null;
          const controller = new AbortController();
          const combined = AbortSignal.any([turn.controller.signal, controller.signal, ...(signal ? [signal] : [])]);
          entry = { fingerprint, snapshot, controller, signal: combined, decision: null, permissionConsumed: false };
          decisions.set(toolUseID, entry);
          entry.decision = (async () => {
            try {
              const decision = await rpc.request(acp ? 'session/request_permission' : 'permission', acp ? {
                sessionId: nativeId, toolCall: { toolCallId: toolUseID, title: tool, kind: 'other', rawInput: snapshot },
                options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }]
              } : { tool, input: snapshot }, { signal: combined, timeoutMs: 600000 });
              const approved = acp ? decision?.outcome?.outcome === 'selected' && decision.outcome.optionId === 'allow' : decision?.approved === true;
              return approved && alive(combined);
            } catch { return false; /* Disconnect, timeout and cancellation always deny. */ }
          })();
        }
        if (!fromHook) entry.permissionConsumed = true;
        const abort = () => entry.controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          return await entry.decision && alive(signal) && alive(entry.signal) ? structuredClone(entry.snapshot) : null;
        } finally { signal?.removeEventListener('abort', abort); }
      }
      const preToolUse = async (input, toolUseID, context = {}) => {
        const id = input?.tool_use_id;
        const freshId = typeof id === 'string' && Boolean(id) && !seenHooks.has(id) && seenHooks.size < 1024;
        if (freshId) seenHooks.add(id);
        const validHook = freshId && input?.hook_event_name === 'PreToolUse' && (toolUseID === undefined || toolUseID === id);
        if (!validHook) decisions.get(id)?.controller.abort();
        const snapshot = validHook
          ? await approvedInput(input.tool_name, input.tool_input, id, context.signal, true) : null;
        return { hookSpecificOutput: { hookEventName: 'PreToolUse',
          permissionDecision: snapshot ? 'allow' : 'deny',
          permissionDecisionReason: snapshot ? 'Approved once by host policy' : deny.message,
          ...(snapshot ? { updatedInput: snapshot } : {}) } };
      };
      const permission = async (tool, toolInput, context = {}) => {
        const snapshot = await approvedInput(tool, toolInput, context.toolUseID, context.signal);
        return snapshot ? { behavior: 'allow', updatedInput: snapshot } : deny;
      };
      try {
        turn.query = sdk.query({ prompt: params.prompt, options: {
          cwd: config.cwd, pathToClaudeCodeExecutable: config.runtimePath,
          env: { ...(config.profileRoot ? claudeProfileEnvironment(config.profileRoot) : {}), ...(config.authMode==='provider-login'?{}:{ANTHROPIC_API_KEY:config.credential}),
            ...(config.baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: config.baseUrl }) },
          ...(config.executionMode === 'native-permissions' ? { sandbox: { enabled: false } } : {}), settingSources: [], mcpServers: {}, plugins: [], strictMcpConfig: true,
          tools: [...config.tools], allowedTools: [], permissionMode: 'default',
          hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 600 }] },
          abortController: turn.controller, includePartialMessages: true,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(params.resume ? { resume: params.resume } : {}), canUseTool: permission,
          stderr: () => { /* Discard vendor stderr: no secrets or unbounded stderr ring retained. */ }
        } });
        let terminal = null;
        for await (const message of turn.query) {
          if (closed || turn.controller.signal.aborted || active !== turn) break;
          if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') {
            if (acp) rpc.notify('session/update', {sessionId:nativeId, update:{sessionUpdate:'agent_message_chunk', content:{type:'text',text:message.event.delta.text}}});
            else rpc.notify('event', { type: 'text-delta', text: message.event.delta.text });
          }
          if (acp && message.type === 'user' && Array.isArray(message.message?.content)) {
            for (const result of message.message.content) {
              if (result?.type !== 'tool_result' || typeof result.tool_use_id !== 'string') continue;
              const entry = decisions.get(result.tool_use_id);
              if (!entry || entry.resultEmitted || !seenHooks.has(result.tool_use_id)
                || !alive(entry.signal) || await entry.decision !== true || result.content === undefined) continue;
              entry.resultEmitted = true;
              rpc.notify('session/update', {sessionId:nativeId, update:{sessionUpdate:'tool_call_update',
                toolCallId:result.tool_use_id,kind:'tool',status:result.is_error === true ? 'failed' : 'completed',
                rawOutput:{content:result.content,isError:result.is_error === true}}});
            }
          }
          if (message.type === 'result') terminal = { outcome: message.subtype === 'success' ? 'completed' : 'failed',
            ...(typeof message.session_id === 'string' ? { sessionId: message.session_id } : {}) };
        }
        if (terminal?.sessionId) resumeId = terminal.sessionId;
        if (acp) {
          if (turn.controller.signal.aborted) return {stopReason:'cancelled'};
          if (terminal?.outcome !== 'completed') throw fault('CLAUDE_TURN_FAILED');
          return {stopReason:'end_turn'};
        }
        return turn.controller.signal.aborted ? { outcome: 'cancelled' } : terminal ?? { outcome: 'failed' };
      } catch { if (acp) { if (turn.controller.signal.aborted) return {stopReason:'cancelled'}; throw fault('CLAUDE_TURN_FAILED'); }
        return { outcome: turn.controller.signal.aborted ? 'cancelled' : 'failed' }; /* Do not expose SDK error details. */ }
      finally { decisions.clear(); seenHooks.clear(); if (active === turn) active = null; }
    }
  });
  input.once('end', stop); input.once('close', stop); input.once('error', stop); output.once('error', stop);
  try { await done; }
  finally { input.off('end', stop); input.off('close', stop); input.off('error', stop); output.off('error', stop); }
}
