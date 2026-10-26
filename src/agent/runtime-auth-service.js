import crypto from 'node:crypto';
import {agentProviderError as fault} from './agent-provider.js';
import {describeRuntimeAuth} from './runtime-auth-capabilities.js';
const providers=new Set(['gemini','opencode','qwen','claude']);
function providerId(provider){if(!providers.has(provider))throw fault('INVALID_PARAMS','Unsupported Agent authentication provider');return provider;}
/** Synchronous reservations precede every asynchronous task/auth/config launch. */
export function createConnectionLeases() {
 const rows=new Map();
 const row=provider=>{providerId(provider);if(!rows.has(provider))rows.set(provider,{epoch:0,owners:new Set()});return rows.get(provider);};
 return Object.freeze({epoch:provider=>row(provider).epoch,reserve({provider,kind,expectedEpoch}) {
  if(!['auth','task','configure'].includes(kind))throw fault('INVALID_PARAMS','Invalid connection lease');
  const state=row(provider);
  if(state.epoch!==expectedEpoch)throw fault('AGENT_RUNTIME_CHANGED','Agent connection changed; refresh before continuing');
  if([...state.owners].some(owner=>owner.kind!=='task'||kind!=='task'))throw fault('AGENT_RUNTIME_BUSY','Close active tasks or authentication before changing this connection');
  let released=false;
  const lease={provider,kind,epoch:expectedEpoch,
   assertCurrent(){if(released||state.epoch!==expectedEpoch)throw fault('AGENT_RUNTIME_CHANGED','Agent connection changed before launch');},
   advance(){lease.assertCurrent();if(state.epoch>=Number.MAX_SAFE_INTEGER)throw fault('AGENT_RUNTIME_CHANGED','Agent epoch exhausted');state.epoch++;},
   release({exitConfirmed}={}){if(exitConfirmed!==true)throw fault('AGENT_EXIT_UNCONFIRMED','Keep ownership until process exit is confirmed');if(!released){state.owners.delete(lease);released=true;}}
  };state.owners.add(lease);return Object.freeze(lease);
 }});
}
const params=(input,allowed)=>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw fault('INVALID_PARAMS','Unsupported authentication options');
 providerId(input.provider);return input;
};
export function createAgentRuntimeAuthService({configuration,adapters={},profileStore,connectionLeases,deadlineMs=300000,exitWaitMs=5000}={}) {
 const attempts=new Map();let closing=false;
 const dto=a=>({provider:a.provider,attemptId:a.id,state:a.state,reason:a.reason??null,revision:a.revision,epoch:connectionLeases.epoch(a.provider)});
 const capability=provider=>adapters[provider]?.describe?.() ?? describeRuntimeAuth({provider});
 const unknown=error=>/CLOSE_UNKNOWN|EXIT_UNCONFIRMED/.test(error?.code??'');
 const alive=a=>!a.cancelled&&!closing&&attempts.get(a.provider)===a;
 function check(a) {
  if(!alive(a))throw fault('AGENT_AUTH_CANCELLED','Authentication was cancelled');
  a.lease.assertCurrent();if(configuration.identity(a.provider)!==a.identity)throw fault('AGENT_RUNTIME_CHANGED','Authentication connection changed');
 }
 function finalize(a) {
  if(a.settled||!a.workDone)return;
  if(a.untrackedExit||[...a.handles.values()].some(h=>!h.exited)){a.state='exit-unconfirmed';a.reason='auth_process_exit_unconfirmed';return;}
  clearTimeout(a.timer);a.settled=true;
  try {
   if(a.cancelled){a.state=a.expired?'expired':'cancelled';a.reason=null;}
   else if(a.outcome==='session-present') {
    check(a);a.profile.validate();
    if(a.kind==='login')profileStore.promote({provider:a.provider,generationId:a.profile.generationId,attemptId:a.id,expectedEpoch:a.lease.epoch,lease:a.lease,exitConfirmed:true,cancelled:false});
    a.state='session-present';a.reason=null;
   } else {a.state=a.outcome??'failed';a.reason=a.state==='failed'?'auth_status_unverified':null;}
  }catch{a.state='failed';a.reason='auth_status_unverified';}
  finally{a.lease.release({exitConfirmed:true});}
 }
 function failed(a,error) {
  if(unknown(error)&&![...a.handles.values()].some(h=>!h.exited))a.untrackedExit=true;
  a.outcome='failed';
 }
 function capture(a,handle) {
  if(!handle||typeof handle.close!=='function'||!handle.done)throw fault('AGENT_EXIT_UNCONFIRMED','Authentication subprocess ownership missing');
  if(a.handles.has(handle))return;
  const record={handle,exited:false};a.handles.set(handle,record);
  Promise.resolve(handle.done).then(()=>{record.exited=true;finalize(a);},()=>{a.untrackedExit=true;a.state='exit-unconfirmed';});
 }
 function create(provider,config,kind,methodId=null) {
  const lease=connectionLeases.reserve({provider,kind:'auth',expectedEpoch:config.authorizationEpoch});
  const a={provider,id:crypto.randomUUID(),methodId,kind,revision:config.revision,identity:configuration.identity(provider),lease,adapter:adapters[provider],controller:new AbortController(),handles:new Map(),state:'starting',cancelled:false,settled:false,workDone:false};
  attempts.set(provider,a);return a;
 }
 async function inspect(a) {
  check(a);a.profile.validate();
  const result=await a.adapter.inspect({profile:a.profile,signal:a.controller.signal,assertCurrent:()=>check(a),onHandle:handle=>capture(a,handle)});
  check(a);a.profile.validate();return result?.state==='session-present'?'session-present':'no-session';
 }
 function lookup(input) {
  params(input,['provider','attemptId']);const a=attempts.get(input.provider);
  if(!a||a.id!==input.attemptId)throw fault('AGENT_AUTH_ATTEMPT_STALE','Authentication attempt is no longer current');return a;
 }
 async function bounded(work) {
  let timer;
  try {return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(10,Math.min(10000,exitWaitMs)));})]);}
  finally{clearTimeout(timer);}
 }
 async function stop(a,expired=false) {
  if(a.settled)return dto(a);
  a.cancelled=true;a.expired ||= expired;a.controller.abort();clearTimeout(a.timer);
  // Close already-captured status/login handles before waiting on work: status
  // work may itself be awaiting the very process that Cancel must close.
  const closeOwned=async()=>{await Promise.all([...a.handles.values()].filter(h=>!h.exited).map(async h=>{try{await bounded(h.handle.close());}catch(error){failed(a,error);}}));};
  await closeOwned();await bounded(a.started);await closeOwned();
  if(!a.untrackedExit&&[...a.handles.values()].every(h=>h.exited))await bounded(a.work);
  finalize(a);
  if(!a.settled){a.state='exit-unconfirmed';a.reason='auth_process_exit_unconfirmed';}
  return dto(a);
 }
 const service={
  async describe(provider) {
   providerId(provider);const config=configuration.get(provider),caps=capability(provider),adapter=adapters[provider];
   if(closing)throw fault('PROVIDER_SHUTTING_DOWN','Authentication service is closing');
   const current=attempts.get(provider);if(current&&!current.settled)return {...dto(current),...caps};
   if(!adapter||!caps.methods.some(m=>m.supported&&m.id!=='api-key'))return {provider,state:'unsupported',reason:caps.accountReason??'windows_auth_contract_unverified',revision:config.revision,epoch:connectionLeases.epoch(provider),attemptId:null,...caps};
   let profile;try{profile=profileStore.current(provider);}catch{return {provider,state:'failed',reason:'auth_profile_invalid',revision:config.revision,epoch:connectionLeases.epoch(provider),attemptId:null,...caps};}
   if(!profile)return {provider,state:'no-session',reason:null,revision:config.revision,epoch:connectionLeases.epoch(provider),attemptId:null,...caps};
   const a=create(provider,config,'inspect');a.profile=profile;a.started=Promise.resolve();
   a.work=(async()=>{try{a.outcome=await inspect(a);}catch(error){failed(a,error);}finally{a.workDone=true;finalize(a);}})();
   a.timer=setTimeout(()=>{void stop(a,true);},15000);
   await bounded(a.work);return {...dto(a),...caps};
  },
  async start(input) {
   params(input,['provider','expectedRevision','methodId']);const {provider,expectedRevision,methodId}=input;
   if(closing)throw fault('PROVIDER_SHUTTING_DOWN','Authentication service is closing');
   const config=configuration.get(provider);
   if(!Number.isSafeInteger(expectedRevision)||config.revision!==expectedRevision)throw fault('AGENT_RUNTIME_CHANGED','Refresh Agent configuration before login');
   if(config.authMode!=='provider-login')throw fault('AGENT_AUTH_MODE_REQUIRED','Save provider login mode first');
   const previous=attempts.get(provider);
   if(previous&&!previous.settled){if(previous.kind==='login'&&previous.methodId===methodId&&previous.revision===expectedRevision&&!previous.cancelled)return dto(previous);throw fault('AGENT_RUNTIME_BUSY','Previous authentication still owns this connection');}
   const caps=capability(provider);
   if(!adapters[provider]||!caps.methods.some(m=>m.id===methodId&&m.id!=='api-key'&&m.supported))throw fault('AGENT_AUTH_UNSUPPORTED','This official login route awaits native Windows verification');
   const a=create(provider,config,'login',methodId);
   a.started=(async()=>{
    try{a.profile=profileStore.createGeneration(provider);check(a);
     a.login=await a.adapter.start({profile:a.profile,signal:a.controller.signal,assertCurrent:()=>check(a),methodId,onHandle:handle=>capture(a,handle),onEvent:event=>{if(alive(a)&&event?.state==='awaiting-user')a.state='awaiting-user';}});capture(a,a.login);
    }catch(error){failed(a,error);}
   })();
   a.work=(async()=>{await a.started;
    try{check(a);if(!a.login)throw Error('Login did not start');const result=await a.login.done;check(a);if(result?.exitCode!==0||result?.startFailed)throw Error('Login failed');a.outcome=await inspect(a);if(a.outcome!=='session-present')a.outcome='failed';}
    catch(error){failed(a,error);}finally{a.workDone=true;finalize(a);}
   })();
   a.timer=setTimeout(()=>{void stop(a,true);},Math.max(10,Math.min(300000,deadlineMs)));
   await bounded(a.started);if(!a.login&&a.outcome==='failed')await bounded(a.work);return dto(a);
  },
  taskProfile(provider) {
   providerId(provider);const config=configuration.get(provider);
   if(config.authMode!=='provider-login')throw fault('AGENT_AUTH_MODE_REQUIRED','Provider login mode required');
   const profile=profileStore.current(provider);if(!profile)throw fault('AGENT_AUTH_UNSUPPORTED','No promoted owned account profile');
   profile.validate();const identity=configuration.identity(provider),task=adapters[provider]?.taskProfile?.(profile)??profile;
   return {...task,generationId:profile.generationId,validate(){
    if(configuration.identity(provider)!==identity||profileStore.current(provider)?.generationId!==profile.generationId)throw fault('AGENT_RUNTIME_CHANGED','Owned account generation changed');
    profile.validate();task.validate();
   },async cleanup(){/* Promoted account state is never task-owned disposable state. */}};
  },
  async status(input){return dto(lookup(input));},async cancel(input){return stop(lookup(input));},
  async close(){closing=true;await Promise.all([...attempts.values()].map(a=>stop(a)));if([...attempts.values()].some(a=>!a.settled))throw fault('AGENT_EXIT_UNCONFIRMED','Authentication process exit remains unconfirmed');}
 };
 return Object.freeze(service);
}

/** Add connection ownership without changing any Broker or native tool approval. */
export function withConnectionLeases(provider,connectionLeases) {
 if(!connectionLeases||!providers.has(provider.id))return provider;
 const sessions=new Map(),pending=new Set(),orphans=new Set();
 return Object.freeze({...provider,
  async createSession(params) {
   const lease=connectionLeases.reserve({provider:provider.id,kind:'task',expectedEpoch:connectionLeases.epoch(provider.id)});
   const work=(async()=>{
    try {lease.assertCurrent();const result=await provider.createSession(params);sessions.set(result.sessionId,lease);return result;}
    catch(error){if(error?.sessionId)sessions.set(error.sessionId,lease);else if(/CLOSE_UNKNOWN|EXIT_UNCONFIRMED/.test(error?.code??''))orphans.add(lease);else lease.release({exitConfirmed:true});throw error;}
   })();pending.add(work);try{return await work;}finally{pending.delete(work);}
  },
  async closeSession(params){const result=await provider.closeSession(params);sessions.get(params?.sessionId)?.release({exitConfirmed:true});sessions.delete(params?.sessionId);return result;},
  async shutdown(){await Promise.allSettled([...pending]);await provider.shutdown();for(const lease of [...sessions.values(),...orphans])lease.release({exitConfirmed:true});sessions.clear();orphans.clear();}
 });
}
