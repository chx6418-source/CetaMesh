import crypto from 'node:crypto';
import path from 'node:path';
import { isNativePermissionSecurity } from './execution-security.js';
import { agentProviderError as fault, defineAgentProvider, normalizePromptContent } from './agent-provider.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import { createAgentEventBuffer } from './protocol/agent-event-buffer.js';
import { createAgentPermissionBridge } from './protocol/agent-permission-bridge.js';
import { createStagingWorkspace, collectStagedChanges, refreshStagingBaseline, cleanupStagingWorkspace } from '../workspace/staging.js';

/** ACP v1 only. launch is a trusted process supervisor, never an RPC supplied command. */
export function createAcpAgentProvider({descriptor, launch, resolveTaskWorkspace, applyChanges,
  cleanupStage = cleanupStagingWorkspace, stagingRoot, excludedRoots = [], listWorkspaceRoots = async () => [], snapshotExcludedPaths = [], validateRuntime = async () => {},
  approvalStatus = () => null, cancelApproval = async () => {}, requestNativeApproval, log = () => {}} = {}) {
  if (!descriptor?.id || !descriptor?.label) throw new TypeError('ACP descriptor required');
  const policy = structuredClone(descriptor), sessions = new Map();
  let creating = 0, shuttingDown = false;
  const pendingCreations = new Set();
  async function shutdown() {
    shuttingDown = true;
    for (const record of pendingCreations) {
      const session = record.session;
      if (session?.handle) {
        session.permissions?.close();
        void session.rpc?.close();
        void stop(session).catch(error => log(`ACP pending creation stop failed: ${error?.code ?? 'ACP_CLOSE_UNKNOWN'}`));
      }
    }
    let timer, creationError;
    try { await Promise.race([
      Promise.all([...pendingCreations].map(record => record.done)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fault('ACP_CLOSE_UNKNOWN','Session creation cleanup unconfirmed')),30000); })
    ]); } catch (error) { creationError = error; } finally { clearTimeout(timer); }
    const results = await Promise.allSettled([...sessions.keys()].map(sessionId => closeSession({sessionId})));
    if (creationError || results.some(result => result.status === 'rejected')) {
      throw fault('ACP_CLOSE_UNKNOWN','Owned session shutdown unconfirmed; staging retained');
    }
    return {closed:true};
  }
  const eligible = () => policy.protocolVersion === 1 && policy.verifiedRuntime === true
    && policy.security?.verified === true
    && ((policy.security.mode === 'native' && policy.security.nativeSandboxSupported === true && policy.security.nativeApprovalSupported === true)
      || (isNativePermissionSecurity(policy.security) && typeof requestNativeApproval === 'function'))
    && typeof launch === 'function' && typeof resolveTaskWorkspace === 'function';
  const requireSession = id => {
    const session = sessions.get(id);
    if (!session || session.closed) throw fault('SESSION_NOT_FOUND','ACP session unavailable');
    return session;
  };
  async function stop(s) {
    if (!s.handle) return;
    if (typeof s.handle.close !== 'function' || typeof s.handle.done?.then !== 'function') throw fault('ACP_CLOSE_UNKNOWN','Invalid supervisor exit contract');
    if (!s.stopPromise) s.stopPromise = (async()=>{
      let timer;
      try {
        await Promise.race([
          Promise.all([Promise.resolve().then(()=>s.handle.close()), s.handle.done]),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('ACP_CLOSE_UNKNOWN','Runtime exit unconfirmed')),30000);})
        ]);
      } finally { clearTimeout(timer); }
    })();
    try { await s.stopPromise; } catch (error) { s.stopPromise = null; throw error; }
  }
  function emit(s,type,turn,data = {}) {
    const seq = ++s.sequence;
    s.buffer.push({type:'event',seq,eventId:`${policy.id}:${s.id}:${seq}`,event:{type,data:{turn,...data}}});
  }
  function end(s,run,kind,error = null) {
    if (s.run !== run) return;
    // The legacy Codex exec code is a post-process-exit recovery proof. ACP snapshots
    // are collected while the native process may still run, so keep Domain codes distinct.
    const errorCode = error?.code === 'STAGING_READ_FAILED' ? 'ACP_STAGING_READ_FAILED' : error?.code;
    s.permissions?.cancel();
    s.run = null; s.state = s.closed ? 'closed' : kind === 'error' ? 'unknown' : 'ready';
    s.lastRunStatus = kind === 'aborted' ? 'cancelled' : kind === 'error' ? 'failed' : 'completed';
    s.lastError = errorCode ?? null;
    emit(s,'turn/end',run.id,{reason:{kind,...(error ? {error:{code:errorCode ?? 'PROVIDER_ERROR',message:'ACP turn failed'}} : {}),usage:null}});
  }
  async function revokeImport(s,record = s.importApproval,{retry = false} = {}) {
    if (!record || record.terminal) return;
    if (record.failure && !retry) throw record.failure;
    if (retry) record.failure = null;
    if (!record.cancellation) record.cancellation = Promise.resolve().then(()=>cancelApproval(record.id)).then(()=>{
      record.revoked = true;
      if (s.importApproval === record) { s.importApproval = null; s.approvalId = null; }
    });
    const pending = record.cancellation;
    try { await pending; }
    catch (error) {
      if (record.cancellation === pending) { record.cancellation = null; record.failure = error; }
      throw error;
    }
  }
  async function disconnect(s,error) {
    if (s.disconnected || s.closing) return;
    s.disconnected = true; s.permissions?.close(); s.wake?.();
    try { await revokeImport(s); }
    catch (failure) { log(`ACP import revocation failed: ${failure?.code ?? 'APPROVAL_CANCEL_FAILED'}`); }
    await s.rpc?.close(error);
    if (s.run) {
      try { end(s,s.run,'error',error); }
      catch (failure) { s.buffer.close(failure); }
    }
    s.state = s.closed ? 'closed' : 'unknown';
    s.detach?.();
    try { await stop(s); } catch (failure) { log(`ACP supervisor stop failed: ${failure?.code ?? 'ACP_CLOSE_UNKNOWN'}`); }
  }
  async function waitImport(s,run,record) {
    const deadline = Date.now() + 600000;
    const id = record.id; s.state = 'waiting';
    try {
      while (!s.closed && !s.closing && !s.disconnected && !run.cancelled && Date.now() < deadline) {
        const result = await approvalStatus(id);
        if (result?.status && result.status !== 'pending') { record.terminal = true; return result; }
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); s.wake = null; resolve(); };
          const timer = setTimeout(done,250); s.wake = done;
        });
      }
      return {status:run.cancelled || s.closed ? 'cancelled' : 'expired'};
    } finally {
      if (!record.terminal) await revokeImport(s,record);
      if (s.importApproval === record && record.terminal) { s.importApproval = null; s.approvalId = null; }
    }
  }
  async function finish(s,run,result) {
    if (s.run !== run || s.closed || s.closing || s.disconnected) return;
    if (result?.stopReason === 'cancelled') { end(s,run,'aborted'); return; }
    if (run.cancelled) { s.state = 'unknown'; throw fault('ACP_CANCEL_UNCONFIRMED','Agent did not confirm cancellation'); }
    if (!['end_turn','max_tokens','max_turn_requests','refusal'].includes(result?.stopReason)) throw fault('ACP_STOP_REASON_UNKNOWN','Unrecognized ACP stop reason');
    await validateRuntime();
    if (s.run !== run || s.closed || s.closing || s.disconnected) return;
    if (run.cancelled) { end(s,run,'aborted'); return; }
    const changes = collectStagedChanges(s.stage);
    if (changes.changes.length) {
      if (typeof applyChanges !== 'function') throw fault('AGENT_BOUNDARY_UNSUPPORTED','Import adapter unavailable');
      let imported = await applyChanges({provider:policy.id,sessionId:s.id,taskId:s.taskId,workspaceId:s.workspaceId,
        requestId:`${policy.id}-import-${crypto.randomUUID()}`,changes:changes.changes,summary:changes.summary});
      if (imported?.status === 'pending') {
        const record = {id:imported.approvalId,cancellation:null,terminal:false};
        s.importApproval = record; s.approvalId = record.id;
        if (run.cancelled || s.closed || s.closing || s.disconnected || s.run !== run) {
          await revokeImport(s,record);
          imported = {status:'cancelled'};
        } else imported = await waitImport(s,run,record);
      }
      if (s.run !== run || s.closed || s.closing || s.disconnected) return;
      if (run.cancelled) { end(s,run,'aborted'); return; }
      if (imported?.status !== 'completed') throw fault('WORKSPACE_IMPORT_NOT_COMPLETED','Import not completed');
      refreshStagingBaseline(s.stage);
    }
    if (run.text) emit(s,'assistant/message',run.id,{message:{content:[{type:'text',text:run.text}]}});
    end(s,run,'completed');
  }
  async function closeSession({sessionId}) {
    const s = requireSession(sessionId); s.closing = true; s.state = 'unknown'; s.permissions?.close(); s.wake?.();
    let revocationError = null;
    try { await revokeImport(s,s.importApproval,{retry:true}); }
    catch (error) { revocationError = error; }
    await s.rpc?.close();
    try {
      await stop(s);
      if (revocationError) throw revocationError;
    }
    catch (error) {
      s.closing = false;
      if (s.run) { try { end(s,s.run,'error',fault('ACP_CLOSE_UNKNOWN','Runtime exit unconfirmed')); } catch (failure) { s.buffer.close(failure); } }
      throw fault('ACP_CLOSE_UNKNOWN','Runtime exit or import authority revocation unconfirmed; staging retained');
    }
    // Exit and approval revocation are confirmed; retain their completed state if only disk cleanup fails.
    if (s.run) { try { end(s,s.run,'aborted'); } catch (error) { s.buffer.close(error); } }
    s.detach?.();
    try { cleanupStage(s.stage); }
    catch (error) {
      s.closing = false; s.state = 'unknown'; s.lastError = error?.code ?? 'ACP_CLEANUP_FAILED';
      s.buffer.close();
      throw error;
    }
    s.closed = true; s.state = 'closed'; sessions.delete(s.id); s.buffer.close();
    return {closed:true,sessionId};
  }
  return Object.freeze({...defineAgentProvider({id:policy.id,label:policy.label,eventProtocol:'agent-turn-events-v1',
    capabilityExtras:{requiresTask:true,security:policy.security ?? {mode:'native',nativeSandboxSupported:false},
      workspaceBoundary:eligible() ? 'native-staged' : 'unsupported',supportsFreshSession:eligible(),
      executionMode:'native-security-staging',requiresSessionCleanup:true},
    methods:{
      async health() { const available = eligible(); return {provider:policy.id,available,taskEligible:available,
        reason:available ? null : 'external_protocol_unverified',protocolVersion:1}; },
      async createSession({taskId,workspaceId} = {}) {
        if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN','ACP provider is shutting down');
        if (!eligible()) throw fault('PROVIDER_UNAVAILABLE','Verified ACP runtime and native security required');
        await validateRuntime();
        if (sessions.size + creating >= 16) throw fault('AGENT_SESSION_LIMIT','ACP session limit reached');
        creating++;
        let completed;
        const record = {done:new Promise(resolve => { completed = resolve; })};
        pendingCreations.add(record);
        let s;
        try {
          const binding = await resolveTaskWorkspace({taskId,workspaceId});
          if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN','ACP provider is shutting down');
          if (!taskId || !workspaceId || binding?.task?.id !== taskId || binding.task.workspaceId !== workspaceId
            || binding.workspace?.id !== workspaceId || typeof binding.workspace.root !== 'string') throw fault('TASK_WORKSPACE_MISMATCH','Task Workspace binding invalid');
          const registeredRoots=await listWorkspaceRoots();
          const runtimeExclusions=snapshotExcludedPaths.map(relative=>{
            if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>!part||part==='..'||part==='.') ) throw fault('ACP_SNAPSHOT_POLICY_INVALID','Invalid runtime snapshot exclusion');
            return path.join(binding.workspace.root,relative);
          });
          const stage = await createStagingWorkspace({taskId,workspaceId,sourceRoot:binding.workspace.root,stagingRoot,
            additionalWorkspaceRoots:[...(binding.additionalWorkspaceRoots ?? []),...(Array.isArray(registeredRoots)?registeredRoots.map(item=>typeof item==='string'?item:item?.root).filter(Boolean):[])],
            excludedRoots:[...(binding.excludedRoots ?? []),...excludedRoots,...runtimeExclusions]});
          s = {id:crypto.randomUUID(),taskId,workspaceId,stage,buffer:createAgentEventBuffer(),sequence:0,state:'new',run:null,closed:false};
          record.session = s;
          const onHandle = handle => {
            if (s.handle && s.handle !== handle) throw fault('ACP_LAUNCH_HANDLE_MISMATCH','Launcher changed the supervised handle');
            s.handle = handle;
          };
          await validateRuntime();
          const launched = await launch({provider:policy.id,sessionId:s.id,taskId,workspaceId,cwd:stage.root,
            descriptor:structuredClone(policy),onHandle});
          if (s.handle && s.handle !== launched) throw fault('ACP_LAUNCH_HANDLE_MISMATCH','Returned handle differs from captured handle');
          s.handle = launched;
          if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN','ACP provider is shutting down');
          if (!s.handle?.readable || !s.handle?.writable || typeof s.handle.close !== 'function'
            || typeof s.handle.done?.then !== 'function') throw fault('ACP_LAUNCH_INVALID','Supervised streams, close and done required');
          s.rpc = createJsonRpcTransport({readable:s.handle.readable,writable:s.handle.writable,framing:'acp-v1-jsonl',
            onRequest:async (method,params) => {
              if (method !== 'session/request_permission') throw fault('AGENT_UNSUPPORTED','Client method unsupported');
              const run = s.run;
              const active = () => s.run === run && run && !run.cancelled && !s.closed && !s.closing && !s.disconnected;
              if (!active()) return {outcome:{outcome:'cancelled'}};
              s.state = 'waiting';
              try {
                const result = await s.permissions.request(params);
                return active() ? result : {outcome:{outcome:'cancelled'}};
              } finally { if (active()) s.state = 'running'; }
            },
            onNotification:(method,params) => {
              if (s.closed || s.disconnected || method !== 'session/update' || params?.sessionId !== s.nativeId || !s.run || s.run.cancelled) return;
              if (['provider','taskId','workspaceId'].some(key=>Object.hasOwn(params,key))) throw fault('TASK_WORKSPACE_MISMATCH','Forged notification binding');
              const update = params.update, run = s.run;
              try {
                if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
                  if (Buffer.byteLength(run.text) + Buffer.byteLength(update.content.text ?? '') > 1048576) throw fault('ACP_TEXT_LIMIT','ACP turn text limit reached');
                  run.text += update.content.text;
                  emit(s,'assistant/chunk',run.id,{chunk:{type:'text-delta',text:update.content.text}});
                } else if (['tool_call','tool_call_update'].includes(update?.sessionUpdate)) {
                  s.permissions.invalidate(update.toolCallId);
                  emit(s,'tool/activity',run.id,{activity:{id:update.toolCallId,capability:`${policy.id}.native.${update.kind ?? 'tool'}`,
                    name:String(update.title ?? 'Native tool').slice(0,160),executionBoundary:'agent-native',
                    status:update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'running'}});
                }
              } catch (error) { void disconnect(s,error); }
            }});
          const lost = () => { void disconnect(s,fault('ACP_CONNECTION_LOST','ACP connection lost')); };
          s.handle.readable.on('end',lost); s.handle.readable.on('close',lost); s.handle.readable.on('error',lost);
          s.handle.writable.on('close',lost); s.handle.writable.on('error',lost);
          s.detach = () => { for (const event of ['end','close','error']) s.handle.readable.off(event,lost);
            for (const event of ['close','error']) s.handle.writable.off(event,lost); };
          Promise.resolve(s.handle.done).then(lost,lost);
          const initialized = await s.rpc.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'CetaMesh',version:'1'}},{timeoutMs:15000});
          if (initialized?.protocolVersion !== 1) throw fault('ACP_VERSION_UNSUPPORTED','ACP version negotiation failed');
          const created = await s.rpc.request('session/new',{cwd:stage.root,mcpServers:[]});
          if (s.disconnected || typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 1024) throw fault('ACP_SESSION_INVALID','ACP session creation failed');
          s.nativeId = created.sessionId;
          s.permissions = createAgentPermissionBridge({provider:policy.id,sessionId:s.id,nativeSessionId:s.nativeId,taskId,workspaceId,requestNativeApproval});
          if (shuttingDown) throw fault('PROVIDER_SHUTTING_DOWN','ACP provider is shutting down');
          s.state = 'ready'; sessions.set(s.id,s);
          return {provider:policy.id,sessionId:s.id,taskId,workspaceId,cwd:stage.root};
        } catch (error) {
          if (s) { s.closed = true; s.permissions?.close(); s.detach?.(); await s.rpc?.close();
            try { await stop(s); cleanupStage(s.stage); }
            catch (failure) {
              log(`ACP failed creation retained staging: ${failure?.code ?? 'ACP_CLOSE_UNKNOWN'}`);
              s.closed = false; s.closing = false; s.state = 'unknown'; s.disconnected = true;
              sessions.set(s.id,s);
              const retained = fault('ACP_CLOSE_UNKNOWN','Failed creation retained staging until supervised exit is confirmed');
              retained.provider = policy.id; retained.sessionId = s.id;
              throw retained;
            }
            s.buffer.close(); }
          throw error;
        } finally { creating--; pendingCreations.delete(record); completed(); }
      },
      async send({sessionId,content} = {}) {
        const s = requireSession(sessionId);
        if (s.state !== 'ready' || s.run || s.closing) throw fault('TURN_BUSY','ACP session is not ready; prompt will not be replayed');
        await validateRuntime();
        const prompt = normalizePromptContent(content);
        if (prompt.some(block=>block.type !== 'text' || typeof block.text !== 'string')) throw fault('AGENT_UNSUPPORTED','Only text prompts supported');
        const run = {id:crypto.randomUUID(),text:'',cancelled:false}; s.run = run; s.state = 'running';
        emit(s,'turn/start',run.id);
        run.done = s.rpc.request('session/prompt',{sessionId:s.nativeId,prompt},{timeoutMs:0})
          .then(result=>finish(s,run,result)).catch(error=>{
            if (s.closing) return;
            try { end(s,run,error?.rpcCode === -32800 ? 'aborted' : 'error',error?.rpcCode === -32800 ? null : error); }
            catch (failure) { s.buffer.close(failure); }
            if (error?.rpcCode !== -32800) void disconnect(s,error);
          });
        return {accepted:true,provider:policy.id,sessionId,taskId:s.taskId,workspaceId:s.workspaceId,turnId:run.id};
      },
      async cancel({sessionId} = {}) {
        const s = requireSession(sessionId);
        if (!s.run) return {cancelled:false,reason:'not-running',sessionId};
        s.run.cancelled = true; s.state = 'unknown'; s.permissions.cancel(); s.wake?.();
        await revokeImport(s,s.importApproval,{retry:true});
        s.rpc.notify('session/cancel',{sessionId:s.nativeId});
        return {cancelled:false,cancelRequested:true,sessionId,state:'unknown'};
      },
      async status({sessionId} = {}) {
        const s = requireSession(sessionId);
        let runtimeError=null;
        try { await validateRuntime(); } catch(error) { runtimeError=error?.code ?? 'AGENT_RUNTIME_CHANGED'; }
        return {provider:policy.id,sessionId,taskId:s.taskId,workspaceId:s.workspaceId,
          state:runtimeError?'unknown':s.state,running:!!s.run,waitingForApproval:!runtimeError && s.state==='waiting',
          runtimeValid:!runtimeError,approvalId:s.approvalId??null,lastRunStatus:s.lastRunStatus??'idle',errorCode:runtimeError??s.lastError??null};
      },
      async contextUsage({sessionId} = {}) { requireSession(sessionId); return {provider:policy.id,sessionId,available:false,usage:null}; },
      async *follow({sessionId,signal,sinceSequence=0} = {}) { const s = requireSession(sessionId); yield* s.buffer.follow({signal,sinceSequence}); },
      closeSession
    }}), shutdown});
}
