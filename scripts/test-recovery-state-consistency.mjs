// Real local effects and persistent restart boundaries; no model or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCapabilityService } from '../src/capability/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { assertRecoveryAccount } from './real-recovery-account-guard.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-recovery-consistency-'));
const owner={kind:'owner',id:'desktop'};
function fixture(name){
 const base=path.join(root,name),stateDir=path.join(base,'state'),project=path.join(base,'project');
 fs.mkdirSync(project,{recursive:true});
 const workspaceService=createWorkspaceService({stateDir}),taskRuntime=createTaskRuntime({stateDir});
 return {base,stateDir,project,workspaceService,taskRuntime};
}
async function bind(f){
 const workspace=(await f.workspaceService.execute({method:'workspace.create',params:{root:f.project,name:'recovery fixture'}})).workspace;
 f.workspaceId=workspace.id;f.task=f.taskRuntime.create({goal:'Bounded recovery fixture',workspaceId:workspace.id});
 f.service=createCapabilityService({stateDir:f.stateDir,workspaceService:f.workspaceService,taskRuntime:f.taskRuntime});
 f.request={actor:owner,approved:true,taskId:f.task.id,workspaceId:f.workspaceId,capability:'fixture.effect',requestId:'one-effect',input:{}};
 return f;
}
const register=(f,execute)=>f.service.broker.register({id:'fixture.effect',permission:'filesystem.write',effect:'conditional-write',execute});
try{
 const account={auth:{auth_mode:'chatgpt'},config:'model_provider="openai"\n'};
 assert.doesNotThrow(()=>assertRecoveryAccount(account));
 assert.throws(()=>assertRecoveryAccount({...account,config:'model_provider="openai"\n[profiles.api]\nmodel_provider="thirdparty"\n[model_providers.thirdparty]\nbase_url="https://custom.example/v1"'}),{code:'CODEX_ACCOUNT_MODE_REQUIRED'});
 for(const config of ['[model_providers.openai]\nbase_url="https://custom.example/v1"','profiles={api={model_provider="thirdparty"}}','"model_provider"="thirdparty"'])
  assert.throws(()=>assertRecoveryAccount({...account,config}),{code:'CODEX_ACCOUNT_MODE_REQUIRED'});
 assert.throws(()=>assertRecoveryAccount({...account,environment:{OPENAI_BASE_URL:'https://custom.example/v1'}}),{code:'CODEX_ACCOUNT_MODE_REQUIRED'});
 assert.throws(()=>assertRecoveryAccount({...account,auth:{auth_mode:'api_key'}}),{code:'CODEX_ACCOUNT_MODE_REQUIRED'});
 console.log('PASS subscription acceptance refuses custom/profile/quoted/inline provider routes and API credentials');
 const f=await bind(fixture('settlement-failure'));
 const dispatchFile=path.join(f.stateDir,'capability/dispatches.json'),marker=path.join(f.project,'effect.txt');
 let calls=0;
 register(f,()=>{calls++;fs.writeFileSync(marker,'effect happened');return {done:true};});
 const rename=fs.renameSync;
 let saves=0;
 fs.renameSync=function(from,to,...args){
  if(path.resolve(String(to))===dispatchFile&&++saves>1)throw Object.assign(new Error('injected settlement failure'),{code:'EIO'});
  return rename.call(this,from,to,...args);
 };
 try{await assert.rejects(f.service.broker.execute(f.request),error=>error.code==='DISPATCH_RESULT_PERSIST_FAILED'&&error.effectStatus==='unknown','an effect without operationId must not report durable success after its journal write failed');}
 finally{fs.renameSync=rename;}
 assert.equal(calls,1);assert.equal(fs.readFileSync(marker,'utf8'),'effect happened');
 const row=JSON.parse(fs.readFileSync(dispatchFile))['one-effect'];
 assert.equal(row.status,'started');assert.equal(row.taskId,f.task.id);assert.equal(row.workspaceId,f.workspaceId);
 assert.equal(f.service.completionBlocker(f.task.id),'TASK_EFFECT_UNCONFIRMED');
 f.service=createCapabilityService({stateDir:f.stateDir,workspaceService:f.workspaceService,taskRuntime:f.taskRuntime});
 register(f,()=>{calls++;throw Error('must not replay');});
 assert.equal(JSON.parse(fs.readFileSync(dispatchFile))['one-effect'].status,'outcome-unknown');
 assert.equal(f.service.recoveryForTask(f.task.id)?.state,'needs-reconciliation');
 assert.equal(f.service.completionBlocker(f.task.id),'TASK_EFFECT_UNCONFIRMED');
 await assert.rejects(f.service.broker.execute(f.request),{code:'REQUEST_ALREADY_DISPATCHED'});
 assert.equal(calls,1);
 console.log('PASS unkeyed effect settlement failure retains Task ownership and blocks replay across restart');

 const cancelled=await bind(fixture('cancelled-effect'));
 let failEffect,entered;
 const enteredPromise=new Promise(resolve=>{entered=resolve;});
 register(cancelled,()=>{entered();return new Promise((resolve,reject)=>{failEffect=reject;});});
 const controller=new AbortController();
 const inFlight=cancelled.service.broker.execute(cancelled.request,{signal:controller.signal});
 await enteredPromise;controller.abort();
 await assert.rejects(inFlight,{code:'INVOKE_CANCEL_UNCONFIRMED'});
 assert.equal(cancelled.service.recoveryForTask(cancelled.task.id)?.state,'needs-reconciliation');
 assert.throws(()=>cancelled.service.acknowledgeTaskRecovery(cancelled.task.id),{code:'OPERATION_STILL_RUNNING'});
 assert.equal(cancelled.service.broker.uncertainDispatchesForTask({taskId:cancelled.task.id,workspaceId:'unrelated'}).length,0);
 failEffect(Object.assign(new Error('fixture executor lost its result'),{code:'FIXTURE_RESULT_LOST'}));
 // Settlement belongs to the original promise, even after its caller cancelled.
 for(let i=0;i<100&&cancelled.service.broker.dispatchStatus('one-effect').status==='started';i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(cancelled.service.broker.dispatchStatus('one-effect').status,'outcome-unknown');
 assert.equal(cancelled.service.completionBlocker(cancelled.task.id),'TASK_EFFECT_UNCONFIRMED');
 assert.equal(cancelled.service.acknowledgeTaskRecovery(cancelled.task.id).reconciled,1);
 assert.equal(cancelled.service.completionBlocker(cancelled.task.id),null);
 await assert.rejects(cancelled.service.broker.execute(cancelled.request),{code:'REQUEST_ALREADY_DISPATCHED'});
 console.log('PASS cancellation retains the active fence, settled uncertainty requires explicit exact-Task review, reviewed request never replays');

 const conflict=await bind(fixture('conflict'));
 const conflictFile=path.join(conflict.project,'keep.txt');fs.writeFileSync(conflictFile,'concurrent user edit');
 await assert.rejects(conflict.service.broker.execute({...conflict.request,capability:'workspace.apply',input:{changes:[{action:'write',path:'keep.txt',content:'replacement',hash:'1'.repeat(64),expectedHash:'0'.repeat(64)}]}}),{code:'WORKSPACE_CONFLICT'});
 assert.equal(fs.readFileSync(conflictFile,'utf8'),'concurrent user edit');
 assert.equal(conflict.service.broker.dispatchStatus('one-effect'),null,'validation failure has not entered an executor');
 assert.equal(conflict.service.completionBlocker(conflict.task.id),null);
 console.log('PASS pre-execution batch-import conflict preserves user bytes without an invented unknown effect');

 const crashed=await bind(fixture('process-crash'));
 const moduleUrl=new URL('../src/capability/service.js',import.meta.url).href;
 const workspaceUrl=new URL('../src/workspace/service.js',import.meta.url).href;
 const taskUrl=new URL('../src/task/runtime.js',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import fs from 'node:fs';
  import {createCapabilityService} from ${JSON.stringify(moduleUrl)};
  import {createWorkspaceService} from ${JSON.stringify(workspaceUrl)};
  import {createTaskRuntime} from ${JSON.stringify(taskUrl)};
  const stateDir=${JSON.stringify(crashed.stateDir)};
  const service=createCapabilityService({stateDir,workspaceService:createWorkspaceService({stateDir}),taskRuntime:createTaskRuntime({stateDir})});
  service.broker.register({id:'fixture.effect',permission:'filesystem.write',effect:'conditional-write',execute(){fs.writeFileSync(${JSON.stringify(path.join(crashed.project,'effect.txt'))},'confirmed physical effect');process.exit(73);}});
  await service.broker.execute(${JSON.stringify(crashed.request)});
 `],{windowsHide:true,encoding:'utf8'});
 assert.equal(child.status,73,child.stderr);
 assert.equal(fs.readFileSync(path.join(crashed.project,'effect.txt'),'utf8'),'confirmed physical effect');
 crashed.service=createCapabilityService({stateDir:crashed.stateDir,workspaceService:crashed.workspaceService,taskRuntime:crashed.taskRuntime});
 let replayed=0;register(crashed,()=>{replayed++;});
 assert.equal(crashed.service.recoveryForTask(crashed.task.id)?.state,'needs-reconciliation');
 assert.equal(crashed.service.broker.dispatchStatus('one-effect').status,'outcome-unknown');
 await assert.rejects(crashed.service.broker.execute(crashed.request),{code:'REQUEST_ALREADY_DISPATCHED'});
 assert.equal(replayed,0);
 console.log('PASS actual child exit after a file effect restarts into unknown ownership and does not repeat the effect');

 const observation=fixture('execution-observation');
 const created=observation.taskRuntime.create({goal:'Persist native observation'});
 observation.taskRuntime.start({id:created.id,expectedRev:created.rev,provider:'codex',sessionId:'owned-session'});
 const started=observation.taskRuntime.beginExecutionObservation({id:created.id,provider:'codex',sessionId:'owned-session',runId:'owned-run',phase:'user'});
 const observing=observation.taskRuntime.observeExecution({id:created.id,provider:'codex',sessionId:'owned-session',runId:'owned-run',phase:'user',state:'awaiting-review',toolActivity:true});
 const restoredRuntime=createTaskRuntime({stateDir:observation.stateDir});
 assert.deepEqual(restoredRuntime.get({id:created.id}).task.executionObservation,observing.executionObservation,'loading a persisted Task must retain its current execution observation');
 restoredRuntime.recoverInterrupted();
 const interrupted=restoredRuntime.get({id:created.id}).task;
 assert.equal(interrupted.status,'blocked');assert.equal(interrupted.executionObservation.state,'unknown');
 assert.equal(interrupted.executionObservation.runId,started.executionObservation.runId);
 assert.equal(interrupted.executionObservation.hadToolActivity,true);
 console.log('PASS persisted execution observation survives loading and becomes unknown on interrupted restart');

 const unbound=fixture('task-without-workspace');
 unbound.task=unbound.taskRuntime.create({goal:'Task without a Workspace'});
 const reopen=()=>createCapabilityService({stateDir:unbound.stateDir,workspaceService:unbound.workspaceService,taskRuntime:unbound.taskRuntime});
 unbound.service=reopen();
 unbound.service.broker.register({id:'fixture.publish',permission:'publish',effect:'non-idempotent',execute(){throw Error('response lost after effect');}});
 const unboundRequest={actor:owner,approved:true,capability:'fixture.publish',requestId:'unbound-effect',taskId:unbound.task.id,workspaceId:null,input:{}};
 await assert.rejects(unbound.service.broker.execute(unboundRequest),error=>error.effectStatus==='unknown');
 assert.equal(unbound.service.completionBlocker(unbound.task.id),'TASK_EFFECT_UNCONFIRMED','null Workspace is an exact Task scope, not absent ownership');
 unbound.service=reopen();
 assert.equal(unbound.service.recoveryForTask(unbound.task.id)?.state,'needs-reconciliation');
 assert.equal(unbound.service.acknowledgeTaskRecovery(unbound.task.id).reconciled,1);
 console.log('PASS null-Workspace Task retains uncertain effect ownership through restart and exact Task review');

 const collision=await bind(fixture('read-request-collision'));
 let finishEffect,beginEffect;
 const began=new Promise(resolve=>{beginEffect=resolve;});
 register(collision,()=>{beginEffect();return new Promise(resolve=>{finishEffect=resolve;});});
 collision.service.broker.register({id:'fixture.read',permission:'log',effect:'read-only',execute:()=>({read:true})});
 const effect=collision.service.broker.execute(collision.request);await began;
 await assert.rejects(collision.service.broker.execute({...collision.request,capability:'fixture.read'}),{code:'REQUEST_ID_CONFLICT'},'a read cannot reuse another effect request identity');
 assert.equal(collision.service.broker.dispatchStatus('one-effect').status,'started');
 assert.throws(()=>collision.service.acknowledgeTaskRecovery(collision.task.id),{code:'OPERATION_STILL_RUNNING'});
 finishEffect({done:true});await effect;
 assert.equal(collision.service.broker.dispatchStatus('one-effect').status,'completed');
 console.log('PASS only the original dispatch claim settles an effect; read request ID collision cannot clear its active fence');
}finally{
 // Only this suite's newly created fixture root is removed.
 assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
 assert.ok(path.basename(root).startsWith('cetamesh-recovery-consistency-'));
 fs.rmSync(root,{recursive:true,force:true});
}
