// Actual, read-only service responses. Availability of external execution stays with its Broker.
import crypto from 'node:crypto';
const valid=(v,condition)=>{if(!condition)throw Error('CHECK_CONTRACT_INVALID');return v;};
const state=(status,code)=>({status,code});
export function serviceDiagnosticChecks(services,{dataProbe=null,uiProbe=null,light=false}={}){
 const call=(owner,method,params={})=>owner.execute({method,params});
 return [
  {id:'workspace',stage:'core',critical:true,run:async()=>{const v=await call(services.workspaceService,'workspace.health');return valid(true,Number.isSafeInteger(v.registered)&&typeof v.activeValid==='boolean'&&v.activeValid);}},
  {id:'tasks',stage:'core',critical:true,run:async()=>{const v=await call(services.taskService,'task.list',{limit:1});return valid(true,Array.isArray(v.tasks)&&Number.isSafeInteger(v.total));}},
  {id:'memory',stage:'core',critical:true,run:async()=>{const v=await call(services.memoryService,'memory.stats');return valid(true,Number.isSafeInteger(v.total)&&v.total>=0);}},
  {id:'capability',stage:'core',critical:true,run:async()=>{
   const v=await call(services.capabilityService,'capability.list');valid(v,Array.isArray(v.capabilities)&&v.capabilities.some(c=>c.id==='filesystem.read'));
   let denied=false;
   try{await services.capabilityService.broker.execute({requestId:crypto.randomUUID(),actor:{kind:'external',id:'startup-read-only-probe'},capability:'filesystem.read',input:{path:'diagnostic-never-read'}});}
   catch(e){denied=e.code==='PERMISSION_DENIED';}
   return valid(true,denied);
  }},
  {id:'approval',stage:'core',critical:true,run:async()=>{const a=await call(services.capabilityService,'capability.approval.list'),g=await call(services.capabilityService,'capability.grant.list');return valid(true,Array.isArray(a.approvals)&&Array.isArray(g.grants));}},
  {id:'journal',stage:'core',critical:true,run:async()=>{
   const t=await call(services.taskService,'task.list'),o=await call(services.capabilityService,'capability.operation.list');
   valid(o,Array.isArray(o.operations));await call(services.continuityService,'continuity.policy.get');
   let unknown=o.operations.some(r=>r.status==='unknown');
   for(const task of t.tasks){const recovery=services.capabilityService.recoveryForTask(task.id);if(recovery?.state==='needs-reconciliation'||(task.attempts??[]).some(a=>a.state==='unknown'))unknown=true;}
   return unknown?state('DEGRADED','RECONCILIATION_REQUIRED'):true;
  }},
  ...(dataProbe?[{id:'dataIpc',stage:'transport',critical:true,timeoutMs:1500,run:dataProbe}]:[]),
  ...(uiProbe?[{id:'uiIpc',stage:'transport',critical:true,timeoutMs:1500,run:uiProbe}]:[]),
  {id:'plugins',stage:'extensions',critical:false,run:async()=>{const v=await call(services.extensionService,'ext.overview');valid(v,Array.isArray(v.extensions));return v.extensions.some(e=>e.status==='disabled_due_to_crash'||(e.status==='enabled'&&(['failed','crashed','unavailable','error'].includes(e.runtimeState)||e.health?.healthy===false)))?state('DEGRADED','CHECK_FAILED'):v.extensions.some(e=>e.status==='enabled'&&!e.loaded)?state('NOT_RUN','PLUGIN_LAZY_NOT_RUN'):true;}},
  {id:'managed',stage:'extensions',critical:false,run:async()=>{const v=await services.managedAgent.provider.health();return v?.available===true?state('PASS','LOCAL_LIFECYCLE_ONLY'):state('DEGRADED','CHECK_FAILED');}},
  {id:'agents',stage:'extensions',critical:false,timeoutMs:1500,run:async(signal)=>{
   const ids=services.agentBroker.ids();valid(ids,Array.isArray(ids));
   // No external sessions or probes that spawn CLI/auth processes on startup.
   if(ids.includes('dsh')){const health=await services.agentBroker.health('dsh',{signal});return health?.available===true?state('NOT_RUN','SESSION_PROBE_NOT_RUN'):state('DEGRADED','CHECK_FAILED');}
   return state('NOT_RUN','SESSION_PROBE_NOT_RUN');
  }},
  {id:'models',stage:'extensions',critical:false,run:()=>{const list=services.modelRuntime.listProviders();valid(list,Array.isArray(list));return state(list.some(p=>p.hasKey)?'NOT_RUN':'DEGRADED','MODEL_REQUEST_NOT_RUN');}},
  {id:'mcp',stage:'extensions',critical:false,run:async()=>{const v=await call(services.integrationService,'mcp.list');valid(v,Array.isArray(v.servers));return !v.servers.length?state('NOT_RUN','MCP_NOT_CONFIGURED'):v.servers.some(s=>s.enabled!==false&&s.status!=='running')?state('DEGRADED','MCP_STOPPED'):state('NOT_RUN','MCP_DISCOVERY_ONLY');}},
  {id:'forge',stage:'extensions',critical:false,run:()=>{const v=services.forgeService.describe();valid(v,Array.isArray(v.providers));return state('NOT_RUN','REMOTE_API_NOT_RUN');}},
  {id:'qq',stage:'extensions',critical:false,timeoutMs:1500,run:async()=>{const q=await call(services.channelService,'channel.qq.health');
   valid(q,typeof q.ready==='boolean');if(!q.configured)return state('NOT_RUN','QQ_NOT_CONFIGURED');if(!q.ready)return state('DEGRADED','QQ_STOPPED');
   const b=await services.bionicService.health();return b?.running?state('NOT_RUN','QQ_READ_ONLY_READY'):state('DEGRADED','QQ_STOPPED');}},
  {id:'browser',stage:'extensions',critical:false,run:()=>state('NOT_RUN','BROWSER_EXECUTION_NOT_RUN')},
  {id:'environment',stage:'extensions',critical:false,run:()=>state('NOT_RUN','ENVIRONMENT_NOT_RUN')}
 ];
}
