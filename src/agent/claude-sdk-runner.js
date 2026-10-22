import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import crypto from 'node:crypto';
import { loadClaudeSdkResource } from './claude-sdk-resource.js';
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
    onNotification(method, params) {
      if (method === 'session/cancel' && params?.sessionId === nativeId) active?.controller.abort();
    },
    async onRequest(method, params = {}) {
      if (closed) throw fault('CLAUDE_RUNNER_CLOSED');
      if (method === 'initialize') {
        if (configuration && params.protocolVersion === 1) return { protocolVersion: 1, agentCapabilities: {} };
        if (configuration || typeof params.credential !== 'string' || !params.credential ||
            typeof params.cwd !== 'string' || !params.cwd || typeof params.runtimePath !== 'string' || !params.runtimePath ||
            !Array.isArray(params.tools) || params.tools.some(t => typeof t !== 'string')) throw fault('CLAUDE_INVALID_CONFIG');
        const loaded = await loadSdk();
        if (closed || typeof loaded?.query !== 'function') throw fault('CLAUDE_SDK_UNAVAILABLE');
        sdk = loaded;
        configuration = { credential: params.credential, cwd: params.cwd, runtimePath: params.runtimePath, tools: [...params.tools] };
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
      const permission = async (tool, toolInput) => {
        if (turn.controller.signal.aborted || !config.tools.includes(tool)) return deny;
        try {
          const decision = await rpc.request(acp ? 'session/request_permission' : 'permission', acp ? {
            sessionId: nativeId, toolCall: { toolCallId: crypto.randomUUID(), title: tool, kind: 'other', rawInput: toolInput },
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }]
          } : { tool, input: toolInput }, { signal: turn.controller.signal });
          const approved = acp ? decision?.outcome?.outcome === 'selected' && decision.outcome.optionId === 'allow' : decision?.approved === true;
          return approved && !turn.controller.signal.aborted ? { behavior: 'allow', updatedInput: toolInput } : deny;
        } catch { return deny; /* Cancellation/disconnect/timeouts settle pending permission as deny. */ }
      };
      try {
        turn.query = sdk.query({ prompt: params.prompt, options: {
          cwd: config.cwd, pathToClaudeCodeExecutable: config.runtimePath,
          env: { ANTHROPIC_API_KEY: config.credential }, settingSources: [], mcpServers: {}, plugins: [], strictMcpConfig: true,
          tools: config.tools, allowedTools: [], permissionMode: 'default',
          abortController: turn.controller, includePartialMessages: true,
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
      finally { if (active === turn) active = null; }
    }
  });
  input.once('end', stop); input.once('close', stop); input.once('error', stop); output.once('error', stop);
  try { await done; }
  finally { input.off('end', stop); input.off('close', stop); input.off('error', stop); output.off('error', stop); }
}
