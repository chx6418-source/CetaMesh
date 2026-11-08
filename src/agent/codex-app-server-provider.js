import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpAgentProvider } from './acp-agent-provider.js';
import { agentProviderError as fault } from './agent-provider.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import { createCodexSessionLifecycle } from './codex-session-lifecycle.js';
import { CODEX_MODEL_CONTROL_SCHEMA_VERSION, readCodexModelCatalog, codexSelectionReceipt, codexRequestedSelection, codexInitialSelection, projectCodexModelControl } from './protocol/codex-model-control.js';

export const CODEX_APP_SERVER_SCHEMA_VERSION = '0.163.0-alpha.11.1';
const CONFIG_FAILURES = new Set(['AGENT_CONFIGURATION_UNSUPPORTED','AGENT_CONFIGURATION_UNCONFIRMED','CODEX_NATIVE_POLICY_UNCONFIRMED','CODEX_MODEL_CATALOG_INVALID','INVALID_PARAMS']);
const sameDirectoryPath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function catalogDirectoryIdentity(directory) {
  const before = fs.lstatSync(directory, { bigint: true });
  const canonical = fs.realpathSync.native(directory);
  const after = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
    || before.dev === 0n || before.ino === 0n || before.dev !== after.dev || before.ino !== after.ino
    || !sameDirectoryPath(canonical, path.resolve(directory))) throw fault('ACP_CLOSE_UNKNOWN', 'Catalog directory ownership is unconfirmed');
  return { canonical, dev: after.dev, ino: after.ino };
}
function assertCatalogDirectoryOwner(probe) {
  const parent = catalogDirectoryIdentity(probe.parent.canonical), current = catalogDirectoryIdentity(probe.root);
  if (parent.dev !== probe.parent.dev || parent.ino !== probe.parent.ino
    || current.dev !== probe.directory?.dev || current.ino !== probe.directory?.ino
    || !sameDirectoryPath(current.canonical, probe.directory.canonical)
    || !sameDirectoryPath(path.dirname(current.canonical), parent.canonical)) {
    throw fault('ACP_CLOSE_UNKNOWN', 'Catalog directory was replaced; current path is retained');
  }
}
/** Translates the pinned native protocol into the shared staged Agent lifecycle.
 * No executable/argv or policy is accepted from model messages. */
export function createCodexAppServerProvider({launch,taskOptions = {},catalogOptions,requestNativeApproval,log} = {}) {
  let lifecycle=taskOptions.sessionLifecycle??(taskOptions.stateDir?createCodexSessionLifecycle({stateDir:taskOptions.stateDir}):null);
  let sessionCreationStarted=false;
  const runtime = taskOptions.verifiedRuntime;
  const nativeModelProfile = runtime?.version === CODEX_MODEL_CONTROL_SCHEMA_VERSION;
  const security = runtime?.security;
  const verified = runtime?.verified === true && (runtime.version === CODEX_APP_SERVER_SCHEMA_VERSION || nativeModelProfile)
    && security?.verified === true && security.mode === 'native'
    && security.nativeSandboxSupported === true && security.nativeApprovalSupported === true
    && security.inheritedExtensionsDisabled === true && security.sandbox === 'read-only'
    && security.approvalPolicy === 'on-request';
  const controls = new Map();
  // This optional trusted profile is distinct from the Task launcher. Its owner
  // must isolate the supplied empty profile and verify the actual runtime/account
  // generation. Neither callbacks nor launch fields are accepted from Agent IPC.
  const catalogLaunch = catalogOptions?.launch, catalogIdentity = catalogOptions?.resolveIdentity;
  const catalogSupported = verified && nativeModelProfile && typeof catalogLaunch === 'function' && typeof catalogIdentity === 'function';
  const catalogTimeout = Math.max(50, Math.min(15000, Number(catalogOptions?.timeoutMs) || 15000));
  const retainedCatalogs = new Set();
  let catalogPending = null, catalogClosing = false;
  async function deadline(operation, code = 'ACP_CLOSE_UNKNOWN') {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fault(code, 'Catalog observation exceeded its bounded wait')), catalogTimeout);
    })]); } finally { clearTimeout(timer); }
  }
  async function readCatalogIdentity() {
    const identity = await deadline(Promise.resolve().then(() => catalogIdentity()), 'AGENT_MODEL_CATALOG_TIMEOUT');
    // Check after the await: shutdown may have started while identity was read.
    if (catalogClosing) throw fault('PROVIDER_UNAVAILABLE', 'Codex catalog discovery is shutting down');
    if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) throw fault('AGENT_RUNTIME_CHANGED', 'Catalog runtime/account identity is unavailable');
    return identity;
  }
  function beginCatalogShutdown() {
    catalogClosing = true;
    // Transport close rejects held control requests immediately. Task Session
    // shutdown remains with the ordinary provider lifecycle, after creations drain.
    for (const probe of retainedCatalogs) void probe.rpc?.close();
  }
  async function stopCatalog(probe) {
    if (probe.stopPromise) return probe.stopPromise;
    const stopping = probe.stopPromise = closeCatalog(probe);
    try { return await stopping; } catch (error) { if (probe.stopPromise === stopping) probe.stopPromise = null; throw error; }
  }
  async function closeCatalog(probe) {
    await probe.rpc?.close();
    if (!probe.stopped) {
      if (typeof probe.handle?.close !== 'function' || !probe.handle?.done?.then) {
        throw fault('ACP_CLOSE_UNKNOWN', 'Catalog launcher has no observed owned process exit');
      }
      const outcomes = await deadline(Promise.all([Promise.resolve().then(() => probe.handle.close()), probe.handle.done]));
      const receipt = outcomes[1];
      if (receipt?.terminationConfirmed === false || receipt?.effectStatus === 'unknown'
        || receipt?.processTreeExitConfirmed !== true && receipt?.terminationConfirmed !== true) {
        throw fault('ACP_CLOSE_UNKNOWN', 'Catalog process-tree exit is unconfirmed; owned profile retained');
      }
      probe.stopped = true;
    }
    // A past mkdtemp path is not present-tense ownership. Recheck canonical
    // parent/root and native node identities immediately before recursive removal.
    try {
      assertCatalogDirectoryOwner(probe);
      fs.rmSync(probe.root, { recursive: true });
    } catch { throw fault('ACP_CLOSE_UNKNOWN', 'Catalog directory cleanup is unconfirmed; current path is retained'); }
    retainedCatalogs.delete(probe);
  }
  async function observeCatalog() {
    if (!catalogSupported) throw fault('AGENT_MODEL_CATALOG_UNSUPPORTED', 'This Codex runtime has no verified catalog-only profile');
    if (catalogClosing) throw fault('PROVIDER_UNAVAILABLE', 'Codex catalog discovery is shutting down');
    if (retainedCatalogs.size) throw fault('ACP_CLOSE_UNKNOWN', 'Previous catalog process cleanup is unconfirmed');
    const identity = await readCatalogIdentity();
    if (catalogClosing) throw fault('PROVIDER_UNAVAILABLE', 'Codex catalog discovery is shutting down');
    const parent = catalogDirectoryIdentity(fs.realpathSync.native(os.tmpdir()));
    const root = fs.mkdtempSync(path.join(parent.canonical, 'cetamesh-codex-catalog-'));
    const probe = { root, parent, directory: null, handle: null, rpc: null, stopped: false };
    retainedCatalogs.add(probe);
    let observation;
    try {
      probe.directory = catalogDirectoryIdentity(root);
      const cwd = path.join(root, 'cwd'), profileRoot = path.join(root, 'profile');
      fs.mkdirSync(cwd); fs.mkdirSync(profileRoot);
      const onHandle = handle => {
        if (probe.handle && probe.handle !== handle) throw fault('ACP_LAUNCH_HANDLE_MISMATCH', 'Catalog launcher changed owned handle');
        probe.handle = handle;
        if (probe.expired) void stopCatalog(probe).catch(() => { /* Retained ownership permits explicit shutdown retry. */ });
      };
      const launching = Promise.resolve().then(() => catalogLaunch({ cwd, profileRoot, purpose: 'model-catalog', transport: 'app-server', schemaVersion: runtime.version, onHandle }))
        .then(handle => { onHandle(handle); return handle; });
      let handle;
      try { handle = await deadline(launching); } catch (error) { probe.expired = true; throw error; }
      if (!handle?.readable || !handle?.writable || !handle?.done?.then || typeof handle.close !== 'function') {
        throw fault('ACP_LAUNCH_INVALID', 'Catalog discovery requires supervised streams and observed close');
      }
      if (catalogClosing) throw fault('PROVIDER_UNAVAILABLE', 'Codex catalog discovery is shutting down');
      const rpc = probe.rpc = createJsonRpcTransport({ readable: handle.readable, writable: handle.writable,
        framing: 'codex-app-server-jsonl', controlTimeoutMs: catalogTimeout,
        // Metadata discovery cannot request native tools or permissions.
        onRequest: async () => { throw fault('AGENT_UNSUPPORTED', 'Native requests are unavailable during metadata discovery'); } });
      await rpc.request('initialize', { clientInfo: { name: 'CetaMesh', title: 'CetaMesh', version: '1' }, capabilities: { experimentalApi: false } });
      rpc.notify('initialized');
      const catalog = await readCodexModelCatalog((method, params) => rpc.request(method, params));
      if (catalogClosing || await readCatalogIdentity() !== identity) throw fault('AGENT_RUNTIME_CHANGED', 'Catalog runtime/account identity changed during discovery');
      const modelControl = projectCodexModelControl({ version: runtime.version, catalog, selection: null });
      // Advertised choices never manufacture an effective native selection.
      modelControl.status = 'unknown'; modelControl.application = 'requires-new-session';
      observation = { supported: true, provider: 'codex', source: 'codex-app-server-model-list', runtimeVersion: runtime.version,
        connectionIdentity: identity, modelControl };
    } finally { await stopCatalog(probe); }
    if (catalogClosing || await readCatalogIdentity() !== identity) throw fault('AGENT_RUNTIME_CHANGED', 'Catalog identity changed before publication');
    return observation;
  }
  const base = createAcpAgentProvider({resolveTaskWorkspace:taskOptions.resolveTaskWorkspace,
    validateCreatedSession(result) {
      if(CONFIG_FAILURES.has(result?.configurationFailure))throw fault(result.configurationFailure,'Codex did not accept the requested initial configuration; the existing Session is unchanged');
    },
    getSessionLifecycle:()=>{sessionCreationStarted=true;return lifecycle;},
    applyChanges:taskOptions.applyChanges,approvalStatus:taskOptions.approvalStatus,cancelApproval:taskOptions.cancelApproval,
    descriptor:{id:'codex',label:'Codex App Server',protocolVersion:1,
    verifiedRuntime:verified,security:security ?? {}},requestNativeApproval,log,
    launch:typeof launch !== 'function' ? undefined : async binding => {
      const incoming = new PassThrough(), outgoing = new PassThrough();
      let handle, native, facade, threadId, active = null, closed = false;
      let catalog = null, selection = null, configurationUnknown = false, configuring = false, dispatching = false, hasNativeTurn = false;
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
      const returned = await launch({...binding,onHandle,transport:'app-server',schemaVersion:runtime.version});
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
              ...(method === 'item/completed' && typeof p.item.aggregatedOutput === 'string' && Number.isInteger(p.item.exitCode)
                ? {rawOutput:{output:p.item.aggregatedOutput,exitCode:p.item.exitCode}} : {}),
              status:method === 'item/completed' ? (p.item.status === 'failed'||(Number.isInteger(p.item.exitCode)&&p.item.exitCode!==0)?'failed':'completed') : 'in_progress'});
          } else if (method === 'turn/completed') {
            const run = active; active = null;
            if (p.turn.status === 'completed' && !run.cancelled) run.resolve({stopReason:'end_turn'});
            else if (p.turn.status === 'interrupted') run.resolve({stopReason:'cancelled'});
            else run.reject(fault('CODEX_TURN_FAILED','Codex turn failed'));
          }
        }});
      const policy = {cwd:binding.cwd,sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'};
      const snapshot = () => projectCodexModelControl({version:runtime.version,catalog,selection,unknown:configurationUnknown});
      const requireKnown = () => {
        if (configurationUnknown) throw fault('AGENT_CONFIGURATION_UNKNOWN','Native configuration outcome is unknown; create a fresh Session');
        if (closed) throw fault('SESSION_NOT_FOUND','Codex native session unavailable');
      };
      async function select(requested, {resume = false} = {}) {
        requireKnown();
        if (configuring || dispatching || active) throw fault('TURN_BUSY','Wait for the current native operation');
        const desired = codexRequestedSelection(catalog, selection, requested);
        configuring = true; let attempted = false;
        try {
          if ((await base.status({sessionId:binding.sessionId})).state !== 'ready') throw fault('TURN_BUSY','Wait for the current Agent turn');
          if (!resume && Object.keys(desired).every(key => desired[key] === selection[key])) return {selected:true,confirmed:true,...selection,modelControl:snapshot()};
          if (!resume) throw fault('AGENT_CONFIGURATION_REQUIRES_NEW_SESSION','This Codex version confirms model changes on thread/start; create the configured target through the existing fresh-Session handoff');
          if (!hasNativeTurn) throw fault('AGENT_CONFIGURATION_REQUIRES_NEW_SESSION','Codex has no resumable rollout before its first turn; apply this selection when creating a fresh Session');
          attempted = true;
          const result = await native.request('thread/resume',{threadId,...policy,excludeTurns:true,model:desired.model,
            ...(desired.reasoningEffort != null ? {config:{model_reasoning_effort:desired.reasoningEffort}} : {})});
          const confirmed = codexSelectionReceipt(result,{threadId,expected:desired,policy});
          if (closed) throw fault('AGENT_CONFIGURATION_UNCONFIRMED','Codex closed before configuration confirmation');
          selection = confirmed;
          return {selected:true,confirmed:true,...selection,modelControl:snapshot()};
        } catch(error) { if(attempted)configurationUnknown=true; throw error; }
        finally {configuring=false;}
      }
      facade = createJsonRpcTransport({readable:outgoing,writable:incoming,framing:'acp-v1-jsonl',
        onRequest:async (method,p) => {
          if (method === 'initialize') {
            await native.request('initialize',{clientInfo:{name:'CetaMesh',title:'CetaMesh',version:'1'},capabilities:{experimentalApi:false}},{timeoutMs:15000});
            native.notify('initialized'); return {protocolVersion:1};
          }
          if (method === 'session/new') {
            try {
            if (nativeModelProfile) {
              try {catalog=await readCodexModelCatalog((method,params)=>native.request(method,params,{timeoutMs:15000}));}
              catch(error) {log?.(`Codex native model catalog unavailable (${error?.code??'CODEX_MODEL_CATALOG_UNAVAILABLE'})`);}
            }
            const initial = nativeModelProfile ? codexInitialSelection(catalog,binding) : null;
            const result = await native.request('thread/start',{...policy,...initial?.parameters});
            if (typeof result?.thread?.id !== 'string' || !result.thread.id || result.thread.id.length > 1024) throw invalid();
            threadId = result.thread.id;
            if (nativeModelProfile) {
              selection = codexSelectionReceipt(result,{threadId,expected:initial.expected,policy});
              if(Object.keys(initial.expected).length)codexRequestedSelection(catalog,selection,initial.expected);
              // Refuse the complete control before publishing the native Session.
              snapshot();
            }
            controls.set(binding.sessionId,{snapshot,select,requireKnown,
              async dispatch(params) {
                requireKnown(); if(configuring || dispatching)throw fault('TURN_BUSY','Native configuration is changing');
                dispatching=true;
                try{return await base.send(params);}finally{dispatching=false;}
              },async resume() {
              if (closed || active) throw fault('TURN_BUSY','Codex session not ready');
              if(nativeModelProfile){await select(selection,{resume:true});return {provider:'codex',sessionId:binding.sessionId,resumed:true,modelControl:snapshot()};}
              const result = await native.request('thread/resume',{threadId,...policy,excludeTurns:true});
              if (result?.thread?.id !== threadId) throw invalid();
              return {provider:'codex',sessionId:binding.sessionId,resumed:true};
            }});
            return {sessionId:threadId};
            } catch(error) {
              // Only failures generated by this owned facade cross as typed
              // validation results. Native RPC errors are never reclassified.
              if(CONFIG_FAILURES.has(error?.code))return {configurationFailure:error.code};
              throw error;
            }
          }
          if (method === 'session/prompt') {
            if (active || p.sessionId !== threadId) throw invalid();
            if(nativeModelProfile){requireKnown();if(configuring)throw fault('TURN_BUSY','Native configuration is changing');}
            let resolve,reject;
            const completed = new Promise((yes,no)=>{resolve=yes;reject=no;});
            // Install a catch immediately; thread/start failures must not leave a dangling rejection.
            completed.catch(()=>{}); // Completion is awaited below after native turn creation.
            const run = {resolve,reject,id:null,cancelled:false}; active = run;
            try {
              const result = await native.request('turn/start',{threadId,input:p.prompt.map(b=>({type:'text',text:b.text,text_elements:[]})),
                ...(nativeModelProfile?{model:selection.model,...(selection.reasoningEffort!=null?{effort:selection.reasoningEffort}:{})}:{})});
              if (active !== run || typeof result?.turn?.id !== 'string' || result.turn.status !== 'inProgress') throw invalid();
              hasNativeTurn = true;
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
  return Object.freeze({...base,
    beginCatalogShutdown,
    modelCatalog() {
      if (!catalogPending) {
        const pending = catalogPending = observeCatalog();
        pending.then(() => { if (catalogPending === pending) catalogPending = null; }, () => { if (catalogPending === pending) catalogPending = null; });
      }
      return catalogPending;
    },
    async shutdown() {
      beginCatalogShutdown();
      let pendingFailure = null;
      try { if (catalogPending) await deadline(catalogPending.catch(() => {})); } catch (error) { pendingFailure = error; }
      const cleanup = await Promise.allSettled([...retainedCatalogs].map(stopCatalog));
      await base.shutdown();
      if (pendingFailure || cleanup.some(result => result.status === 'rejected')) throw fault('ACP_CLOSE_UNKNOWN', 'Catalog cleanup is unconfirmed; owned resources retained');
    },
    async createSession(params = {}) {
      if(verified && !nativeModelProfile && ['model','reasoningEffort','modelProvider'].some(key=>params[key]!=null)) {
        throw fault('AGENT_CONFIGURATION_UNSUPPORTED','This Codex version has no verified native model-control profile; use a verified fresh Session');
      }
      sessionCreationStarted = true;
      const finish = lifecycle?.beginCreation(params);
      try {const created=await base.createSession(params);return nativeModelProfile?{...created,modelControl:controls.get(created.sessionId)?.snapshot()}:created;}
      finally { finish?.(); }
    },
    bindSessionLifecycle(value) {
      if(sessionCreationStarted && lifecycle!==value)throw fault('CODEX_LIFECYCLE_CONFLICT','Cannot replace active Codex lifecycle ownership');
      lifecycle=value;
    },async status(params = {}) {
      const status=await base.status(params);
      return nativeModelProfile?{...status,modelControl:controls.get(params.sessionId)?.snapshot()??status.modelControl}:status;
    },async send(params = {}) {
      if(!nativeModelProfile)return base.send(params);
      const control=controls.get(params.sessionId);if(!control)throw fault('SESSION_NOT_FOUND','Codex native session unavailable');
      return control.dispatch(params);
    },async selectModel({sessionId,...requested} = {}) {
      if(!nativeModelProfile)throw fault('AGENT_CONFIGURATION_UNSUPPORTED','This Codex version has no verified native model-control profile');
      const control=controls.get(sessionId);if(!control)throw fault('SESSION_NOT_FOUND','Codex native session unavailable');
      return control.select(requested);
    },async resume({sessionId,taskId,workspaceId} = {}) {
    const status = await base.status({sessionId});
    if (status.state !== 'ready' || status.taskId !== taskId || status.workspaceId !== workspaceId) throw fault('TASK_WORKSPACE_MISMATCH','Codex resume binding unavailable');
    const control = controls.get(sessionId);
    if (!control) throw fault('SESSION_NOT_FOUND','Codex native session unavailable; create a new session');
    return control.resume();
  },capabilities() {const c=base.capabilities(); return {...c,supported:{...c.supported,resume:true,modelCatalog:catalogSupported},unsupported:c.unsupported.filter(n=>n!=='resume')};}});
}
