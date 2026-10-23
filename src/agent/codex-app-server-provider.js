import { PassThrough } from 'node:stream';
import { createAcpAgentProvider } from './acp-agent-provider.js';
import { agentProviderError as fault } from './agent-provider.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';

export const CODEX_APP_SERVER_SCHEMA_VERSION = '0.163.0-alpha.11.1';
/** Translates the pinned native protocol into the shared staged Agent lifecycle.
 * No executable/argv or policy is accepted from model messages. */
export function createCodexAppServerProvider({launch,taskOptions = {},requestNativeApproval,log} = {}) {
  const runtime = taskOptions.verifiedRuntime;
  const security = runtime?.security;
  const verified = runtime?.verified === true && runtime.version === CODEX_APP_SERVER_SCHEMA_VERSION
    && security?.verified === true && security.mode === 'native'
    && security.nativeSandboxSupported === true && security.nativeApprovalSupported === true
    && security.inheritedExtensionsDisabled === true && security.sandbox === 'read-only'
    && security.approvalPolicy === 'on-request';
  const controls = new Map();
  const base = createAcpAgentProvider({resolveTaskWorkspace:taskOptions.resolveTaskWorkspace,
    applyChanges:taskOptions.applyChanges,approvalStatus:taskOptions.approvalStatus,cancelApproval:taskOptions.cancelApproval,
    descriptor:{id:'codex',label:'Codex App Server',protocolVersion:1,
    verifiedRuntime:verified,security:security ?? {}},requestNativeApproval,log,
    launch:typeof launch !== 'function' ? undefined : async binding => {
      const incoming = new PassThrough(), outgoing = new PassThrough();
      let handle, native, facade, threadId, active = null, closed = false;
      const invalid = () => fault('CODEX_PROTOCOL_ERROR','Codex native protocol invalid');
      const fail = () => {
        if (closed) return;
        closed = true; active?.reject(invalid()); active = null;
        incoming.destroy(); outgoing.destroy(); void native?.close(); void facade?.close();
      };
      const update = update => facade.notify('session/update',{sessionId:threadId,update});
      // The wrapper owns raw supervision; shared staging owns this one stable facade identity.
      // Publish it during raw capture so a launcher throwing after onHandle still has an owner.
      const supervised = {readable:incoming,writable:outgoing,get done() {return handle?.done;},async close() {
        fail(); controls.delete(binding.sessionId);
        if (typeof handle?.close !== 'function' || typeof handle?.done?.then !== 'function') {
          throw fault('ACP_CLOSE_UNKNOWN','Codex native supervisor exit contract unavailable');
        }
        await handle.close(); await handle.done;
      }};
      const onHandle = raw => {
        if (handle && handle !== raw) throw fault('ACP_LAUNCH_HANDLE_MISMATCH','Codex launcher changed raw supervised handle');
        handle = raw;
        binding.onHandle?.(supervised);
      };
      const returned = await launch({...binding,onHandle,transport:'app-server',schemaVersion:CODEX_APP_SERVER_SCHEMA_VERSION});
      onHandle(returned);
      if (!handle?.readable || !handle?.writable || typeof handle.close !== 'function' || !handle.done?.then) {
        throw fault('ACP_LAUNCH_INVALID','Codex supervised streams, close and exit observation required');
      }
      native = createJsonRpcTransport({readable:handle.readable,writable:handle.writable,framing:'codex-app-server-jsonl',onClose:fail,
        onRequest:async (method,p) => {
          if (!['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)) throw invalid();
          if (!active?.id || active.cancelled || p?.threadId !== threadId || p.turnId !== active.id
            || typeof p.itemId !== 'string' || !Number.isSafeInteger(p.startedAtMs)) return {decision:'decline'};
          const run = active;
          const result = await facade.request('session/request_permission',{sessionId:threadId,
            toolCall:{toolCallId:p.itemId,kind:method.includes('commandExecution')?'execute':'edit',
              // Preserve full callback identity for fingerprinting, including approvalId.
              nativeRequest:structuredClone(p)},options:[{optionId:'accept',kind:'allow_once'},{optionId:'decline',kind:'reject_once'}]},{timeoutMs:0});
          return {decision:active === run && !run.cancelled && result?.outcome?.outcome === 'selected'
            && result.outcome.optionId === 'accept' ? 'accept':'decline'};
        },
        onNotification:(method,p) => {
          if (!active || p?.threadId !== threadId) return;
          if (!active.id && ['item/agentMessage/delta','turn/completed'].includes(method)) { fail(); return; }
          const id = method === 'turn/completed' ? p.turn?.id : p.turnId;
          if (id !== active.id) return; // Never associate an out-of-order native turn with the next prompt.
          if (method === 'item/agentMessage/delta') {
            if (typeof p.delta !== 'string') { fail(); return; }
            if (!active.cancelled) update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:p.delta}});
          } else if (['item/started','item/completed'].includes(method)
            && ['commandExecution','fileChange'].includes(p.item?.type)) {
            if (typeof p.item.id !== 'string') { fail(); return; }
            update({sessionUpdate:'tool_call_update',toolCallId:p.item.id,kind:p.item.type === 'fileChange'?'edit':'execute',
              title:p.item.type === 'fileChange'?'Native file change':'Native command',
              status:method === 'item/completed' ? (p.item.status === 'failed'?'failed':'completed') : 'in_progress'});
          } else if (method === 'turn/completed') {
            const run = active; active = null;
            if (p.turn.status === 'completed' && !run.cancelled) run.resolve({stopReason:'end_turn'});
            else if (p.turn.status === 'interrupted') run.resolve({stopReason:'cancelled'});
            else run.reject(fault('CODEX_TURN_FAILED','Codex turn failed'));
          }
        }});
      const policy = {cwd:binding.cwd,sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'};
      facade = createJsonRpcTransport({readable:outgoing,writable:incoming,framing:'acp-v1-jsonl',
        onRequest:async (method,p) => {
          if (method === 'initialize') {
            await native.request('initialize',{clientInfo:{name:'CetaMesh',title:'CetaMesh',version:'1'},capabilities:{experimentalApi:false}},{timeoutMs:15000});
            native.notify('initialized'); return {protocolVersion:1};
          }
          if (method === 'session/new') {
            const result = await native.request('thread/start',policy);
            if (typeof result?.thread?.id !== 'string' || !result.thread.id || result.thread.id.length > 1024) throw invalid();
            threadId = result.thread.id;
            controls.set(binding.sessionId,{async resume() {
              if (closed || active) throw fault('TURN_BUSY','Codex session not ready');
              const result = await native.request('thread/resume',{threadId,...policy,excludeTurns:true});
              if (result?.thread?.id !== threadId) throw invalid();
              return {provider:'codex',sessionId:binding.sessionId,resumed:true};
            }});
            return {sessionId:threadId};
          }
          if (method === 'session/prompt') {
            if (active || p.sessionId !== threadId) throw invalid();
            let resolve,reject;
            const completed = new Promise((yes,no)=>{resolve=yes;reject=no;});
            // Install a catch immediately; thread/start failures must not leave a dangling rejection.
            completed.catch(()=>{}); // Completion is awaited below after native turn creation.
            const run = {resolve,reject,id:null,cancelled:false}; active = run;
            try {
              const result = await native.request('turn/start',{threadId,input:p.prompt.map(b=>({type:'text',text:b.text,text_elements:[]}))});
              if (active !== run || typeof result?.turn?.id !== 'string' || result.turn.status !== 'inProgress') throw invalid();
              run.id = result.turn.id;
              return await completed;
            } catch (error) { if (active === run) active = null; throw error; }
          }
          throw invalid();
        },onNotification:(method,p) => {
          if (method !== 'session/cancel' || p?.sessionId !== threadId || !active) return;
          active.cancelled = true;
          if (!active.id) { fail(); return; }
          void native.request('turn/interrupt',{threadId,turnId:active.id}).catch(fail);
        }});
      for (const event of ['end','close','error']) handle.readable.on(event,fail);
      for (const event of ['close','error']) handle.writable.on(event,fail);
      Promise.resolve(handle.done).then(fail,fail);
      return supervised;
    }});
  return Object.freeze({...base,async resume({sessionId,taskId,workspaceId} = {}) {
    const status = await base.status({sessionId});
    if (status.state !== 'ready' || status.taskId !== taskId || status.workspaceId !== workspaceId) throw fault('TASK_WORKSPACE_MISMATCH','Codex resume binding unavailable');
    const control = controls.get(sessionId);
    if (!control) throw fault('SESSION_NOT_FOUND','Codex native session unavailable; create a new session');
    return control.resume();
  },capabilities() {const c=base.capabilities(); return {...c,supported:{...c.supported,resume:true},unsupported:c.unsupported.filter(n=>n!=='resume')};}});
}
