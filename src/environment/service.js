import crypto from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readJsonFile,writeJsonAtomic,writeTextAtomic} from '../storage/json-file.js';
import {environmentError,sha256} from './contracts.js';
import {assertOwnedPath} from './paths.js';

export function registerEnvironmentCapabilities({broker,taskRuntime,principalForTask,stateDir,ownedArtifactRoot=null,client=null,onChanged=()=>{}}) {
 const file=stateDir?path.join(stateDir,'environment','core-runs.json'):null;
 const rows=file?readJsonFile(file,{missing:{},maxBytes:4194304}):{};
 const active=new Map();const save=()=>{if(file)writeJsonAtomic(file,rows);};
 for(const row of Object.values(rows)) if(row.state==='running') {
  row.state='unknown';row.code='CORE_RESTART_RECONCILIATION_REQUIRED';
  try{const task=taskRuntime.get({id:row.binding.taskId}).task;const attempt=task.attempts.find(a=>a.id===row.binding.attemptId);if(attempt && ['started','accepted'].includes(attempt.state))taskRuntime.settleAttempt({id:task.id,expectedRev:task.rev,requestId:attempt.requestId,state:'unknown',reason:row.code});}
  catch(error){row.attemptRecoveryCode=error.code || 'ENV_ATTEMPT_RECOVERY_FAILED';}
 }
 save();
 const unavailable=()=>{if(!client || !taskRuntime)throw environmentError('ENV_HOST_UNAVAILABLE','Developer environment Host is not configured');};
 async function profile(request) {
  unavailable();const input=request.input;
  if(!['owner','agent'].includes(request.actor.kind))throw environmentError('ENV_IDENTITY_INVALID','Only Core Owner and assigned Agent may request environments');
  if(!input || Object.keys(input).some(k=>!['profileId','profileDigest'].includes(k)) || typeof input.profileId!=='string' || !/^[0-9a-f]{64}$/.test(input.profileDigest || ''))throw environmentError('ENV_SCHEMA_INVALID','Select a pinned profile ID and digest');
  const p=(await client.profiles()).find(p=>p.id===input.profileId);
  if(!p || p.digest!==input.profileDigest)throw environmentError('ENV_PROFILE_MISMATCH','Profile changed; request a new approval');
  return p;
 }
 const taskSnapshot=task=>sha256({workspaceId:task.workspaceId,currentAgent:task.currentAgent,authorizationRevision:task.authorizationRevision});
 async function execute(request) {
  const authorizedTask=taskRuntime.get({id:request.taskId}).task,authorizedSnapshot=taskSnapshot(authorizedTask);
  const p=await profile(request);let task=taskRuntime.get({id:request.taskId}).task;
  if(taskSnapshot(task)!==authorizedSnapshot || ['completed','failed','cancelled','blocked','paused'].includes(task.status) || (request.actor.kind==='agent' && sha256(principalForTask(task.id).grants)!==sha256(request.actor.grants)))throw environmentError('ENV_AUTH_REVOKED','Task authorization changed while resolving profile');
  if(Object.values(rows).some(r=>r.binding.taskId===task.id && ['running','unknown'].includes(r.state)))throw environmentError('ENV_TASK_BUSY','Previous environment run requires reconciliation');
  if(taskRuntime.listChildren({parentTaskId:task.id}).children.some(t=>!['completed','failed','cancelled'].includes(t.status)))throw environmentError('TASK_CHILDREN_ACTIVE','Child Tasks must finish before environment execution');
  const runId=crypto.randomUUID(),environmentId=crypto.randomUUID();
  task=taskRuntime.recordAttempt({id:task.id,expectedRev:task.rev,provider:'environment-test',sessionId:runId,state:'started',requestId:request.requestId});
  const attempt=task.attempts.find(a=>a.requestId===request.requestId);
  const binding={version:1,actor:{kind:request.actor.kind,id:request.actor.id},taskId:task.id,attemptId:attempt.id,runId,environmentId,workspaceId:task.workspaceId,capability:'environment.test',expiresAt:Date.now()+p.limits.timeoutMs,profileId:p.id,profileDigest:p.digest,limits:p.limits};
  const row={binding,state:'running',requestId:request.requestId};rows[runId]=row;save();
  const controller=new AbortController(),abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();
  const snapshot=taskSnapshot(task),grants=request.actor.kind==='agent'?sha256(request.actor.grants):null;
  const stillAuthorized=()=>{try{const t=taskRuntime.get({id:task.id}).task;return !['completed','failed','cancelled','blocked','paused'].includes(t.status) && t.attempts.some(a=>a.id===attempt.id && ['started','accepted'].includes(a.state)) && taskSnapshot(t)===snapshot && (!grants || sha256(principalForTask(task.id).grants)===grants) && Date.now()<binding.expiresAt;}catch{return false;}};
  const monitorController=new AbortController();
  const monitor=(async()=>{
   try {
    while(!controller.signal.aborted){await delay(100,undefined,{signal:monitorController.signal});if(!stillAuthorized())abort();}
   }catch(error){
    if(error.code!=='ABORT_ERR'){row.authorizationMonitorCode=error.code || 'ENV_AUTH_MONITOR_FAILED';abort();}
   }
  })();
  active.set(runId,{controller,binding});
  try {
   if(!stillAuthorized())abort();
   if(controller.signal.aborted)throw environmentError('ENV_AUTH_REVOKED','Environment authorization changed');
   const result=await client.run(binding,{signal:controller.signal});
   if(sha256(result.binding)!==sha256(binding))throw environmentError('ENV_EVIDENCE_BINDING','Host returned a foreign result');
   if(controller.signal.aborted || !stillAuthorized()) {result.status='INCONCLUSIVE';result.code='ENV_AUTH_REVOKED';}
   row.result=result;row.state=result.cleanup?.state==='quarantined'?'unknown':'completed';
   const state=row.state==='unknown'?'unknown':result.status==='PASS'?'completed':result.status==='BLOCKED_ENV'?'cancelled':'failed';
   const current=taskRuntime.get({id:task.id}).task;taskRuntime.settleAttempt({id:task.id,expectedRev:current.rev,requestId:request.requestId,state,reason:`Environment ${result.status}`});
   if(ownedArtifactRoot) {
    const relative=`environment/${runId}.md`,target=assertOwnedPath(ownedArtifactRoot,relative);
    writeTextAtomic(target,`# Environment test result\n\nStatus: ${result.status}\n\nEvidence layer: ${result.layer}\n\nTask: ${task.id}\n\nAttempt: ${attempt.id}\n\nRun: ${runId}\n\nCleanup: ${result.cleanup?.state || 'unknown'}\n\nCode: ${result.code || 'none'}\n\n${(result.checks || []).map(c=>`- ${c.packId || ''}/${c.id}: ${c.status}`).join('\n')}\n`);
    row.artifactRef=`cetamesh-artifact:${relative}`;
    const latest=taskRuntime.get({id:task.id}).task;taskRuntime.addArtifact({id:task.id,expectedRev:latest.rev,kind:'report',label:'Environment test report',ref:row.artifactRef});
    result.artifactRef=row.artifactRef;
   }
   save();onChanged({taskId:task.id,runId,status:result.status});return result;
  }catch(error){row.state='unknown';row.code=error.code || 'ENV_HOST_DISCONNECTED';try{const current=taskRuntime.get({id:task.id}).task;taskRuntime.settleAttempt({id:task.id,expectedRev:current.rev,requestId:request.requestId,state:'unknown',reason:row.code});}catch(settlementError){row.attemptSettlementCode=settlementError.code || 'ENV_ATTEMPT_SETTLEMENT_FAILED';}save();throw error;}
  finally{monitorController.abort();await monitor;request.signal?.removeEventListener('abort',abort);active.delete(runId);}
 }
 broker.register({id:'environment.test',permission:'test.run',provider:'environment',category:'environment',requiresTask:true,workspace:true,risk:'high',cancellationAware:true,available:!!client,descriptorVersion:'environment-v1',description:'Run approved offline Windows environment tests through the developer Host.',inputSchema:{type:'object',properties:{profileId:{type:'string'},profileDigest:{type:'string'}},required:['profileId','profileDigest'],additionalProperties:false},validate:profile,execute});
 function owned(request) {
  if(!request.input || Object.keys(request.input).some(k=>k!=='runId'))throw environmentError('ENV_SCHEMA_INVALID','Run ID required');
  const row=rows[request.input.runId];if(!row || row.binding.taskId!==request.taskId || row.binding.workspaceId!==request.workspaceId)throw environmentError('ENV_EVIDENCE_BINDING','Run belongs to a different Task');return row;
 }
 broker.register({id:'environment.status',permission:'log',provider:'environment',requiresTask:true,workspace:true,risk:'low',available:!!client,description:'Read this Task environment result.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},validate:owned,execute:r=>{const row=owned(r);return row.result || {binding:row.binding,status:row.state==='unknown'?'INCONCLUSIVE':'NOT_RUN',code:row.code};}});
 broker.register({id:'environment.report',permission:'log',provider:'environment',requiresTask:true,workspace:true,risk:'low',available:!!client,description:'Read this Task environment report reference.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},validate:owned,execute:r=>{const row=owned(r);return {artifactRef:row.artifactRef || null,result:row.result || null};}});
 broker.register({id:'environment.cancel',permission:'log',provider:'environment',requiresTask:true,workspace:true,risk:'low',available:!!client,description:'Request cancellation of this Task environment run; unknown effects remain blocked.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},validate:owned,execute:async r=>{const row=owned(r);active.get(row.binding.runId)?.controller.abort();return {requested:true,completed:row.state==='completed'};}});
 broker.register({id:'environment.profiles',permission:'log',provider:'environment',requiresTask:true,workspace:true,risk:'low',available:!!client,description:'List pinned developer environment profiles without Host paths or credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false},validate:r=>{unavailable();if(Object.keys(r.input || {}).length)throw environmentError('ENV_SCHEMA_INVALID','No profile-list input allowed');},execute:()=>client.profiles()});
 broker.register({id:'environment.reconcile',permission:'log',provider:'environment',requiresTask:true,workspace:true,risk:'high',available:!!client,modelCallable:false,description:'Owner review of a disconnected environment run; queries final evidence without replay.',inputSchema:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},validate:r=>{unavailable();if(r.actor.kind!=='owner')throw environmentError('PERMISSION_DENIED','Owner reconciliation required');owned(r);},execute:async r=>{
  const row=owned(r);if(active.has(row.binding.runId))throw environmentError('ENV_BUSY','Run still active');
  const observed=await client.status(row.binding);
  if(sha256(observed.binding)!==sha256(row.binding) || !/^[0-9a-f]{64}$/.test(observed.finalReport?.sha256 || '') || !['destroyed','not-created'].includes(observed.cleanup?.state))throw environmentError('ENV_RECONCILIATION_REQUIRED','Final identity-bound resource cleanup not confirmed');
  const task=taskRuntime.get({id:r.taskId}).task;
  taskRuntime.addDecision({id:task.id,expectedRev:task.rev,decision:`Owner reconciled environment ${row.binding.runId}`,rationale:`Verified Host final report ${observed.finalReport.sha256}; cleanup ${observed.cleanup.state}; execution ${observed.status}. Original unknown Attempt remains historical, not rewritten as success.`});
  row.result=observed;row.state='reconciled';save();return {reconciled:true,result:observed};
 }});
 return {
  blocker:taskId=>Object.values(rows).some(r=>r.binding.taskId===taskId && ['running','unknown'].includes(r.state))?'TASK_ENVIRONMENT_UNCONFIRMED':null,
  recovery:taskId=>Object.values(rows).some(r=>r.binding.taskId===taskId && r.state==='unknown')?{state:'needs-reconciliation',capability:'environment.test'}:null,
  cancel:scope=>{for(const run of active.values())if(!scope?.taskId || run.binding.taskId===scope.taskId)run.controller.abort();},
  close:()=>{for(const run of active.values())run.controller.abort();}
 };
}
