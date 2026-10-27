import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-cap-'));
const workspaceService=createWorkspaceService({stateDir:path.join(dir,'state')});
const taskRuntime=createTaskRuntime({stateDir:path.join(dir,'state')});
const svc=createCapabilityService({stateDir:path.join(dir,'state'),workspaceService,taskRuntime});
const owner={kind:'owner',id:'desktop'};
const req=(capability,input={},extra={})=>({actor:owner,capability,input,...extra});
const deny=async(p,code)=>assert.rejects(p,e=>e.code===code);
try {
 const stateOnly=svc.broker.approvals.pending({actor:owner,capability:'publish.artifact',input:{},requestId:'approval-state-only',reason:'state fixture'});
 assert.equal(stateOnly.status,'pending');
 assert.equal(svc.broker.approvals.decide(stateOnly.id,true,owner).status,'approved','an approval decision is visible before dispatch consumes it');
 await deny(svc.broker.execute(req('missing.tool')),'UNKNOWN_CAPABILITY');
 svc.broker.register({id:'bad.permission',permission:'mystery',execute:()=>{throw Error('must never execute')}});
 await deny(svc.broker.execute(req('bad.permission')),'UNKNOWN_PERMISSION');
 const pending=await svc.broker.execute(req('workspace.create',{root:path.join(dir,'project'),createIfMissing:true,name:'test'}));
 assert.equal(pending.status,'pending');
 const created=await svc.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:true}});
 const ws=created.result.workspace.id;
 assert.equal(svc.broker.approvals.get(pending.approvalId).status,'consumed','Approve Once consumes its request after one dispatch');
 await deny(svc.broker.execute({...svc.broker.approvals.get(pending.approvalId).request,approvalId:pending.approvalId}),'APPROVAL_NOT_APPROVED');
 await deny(svc.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:true}}),'APPROVAL_ALREADY_DECIDED');
 const task=taskRuntime.create({goal:'change source',workspaceId:ws});
 svc.grantTask(task.id,{capabilities:['filesystem.read','filesystem.write','git.status','git.diff','test.run'],workspaceIds:[ws]});
 const actor=svc.principalForTask(task.id);
 const r=await svc.broker.execute({actor,taskId:task.id,workspaceId:ws,capability:'filesystem.write',input:{path:'a.js',content:'hello'}});
 assert.equal(r.status,'pending');
 assert.equal(fs.existsSync(path.join(dir,'project','a.js')),false);
 assert.equal((await svc.execute({method:'capability.approval.decide',params:{id:r.approvalId,approve:true}})).status,'completed');
 assert.equal(fs.readFileSync(path.join(dir,'project','a.js'),'utf8'),'hello');
 fs.mkdirSync(path.join(dir,'project','docs'));
 const extension={kind:'extension',id:'scoped',grants:{capabilities:['filesystem.read'],workspaceIds:[ws],paths:['docs']}};
 await deny(svc.broker.execute({actor:extension,workspaceId:ws,capability:'filesystem.read',input:{path:'docs/../a.js'}}),'FILESYSTEM_SCOPE_DENIED');
 fs.mkdirSync(path.join(dir,'project','private-data'));
 fs.writeFileSync(path.join(dir,'project','private-data','memo.txt'),'PRIVATE');
 fs.symlinkSync(path.join(dir,'project','private-data'),path.join(dir,'project','docs','portal'),'junction');
 await deny(svc.broker.execute({actor:extension,workspaceId:ws,capability:'filesystem.read',input:{path:'docs/portal/memo.txt'}}),'FILESYSTEM_SCOPE_DENIED');
 fs.mkdirSync(path.join(dir,'project','.ssh'));
 fs.writeFileSync(path.join(dir,'project','.ssh','id_rsa'),'PRIVATE KEY');
 fs.symlinkSync(path.join(dir,'project','.ssh'),path.join(dir,'project','docs','key-store'),'junction');
 await deny(svc.broker.execute({actor,taskId:task.id,workspaceId:ws,capability:'filesystem.read',input:{path:'docs/key-store/id_rsa'}}),'SENSITIVE_RESOURCE_DENIED');
 await deny(svc.broker.execute({actor,taskId:task.id,workspaceId:ws,capability:'filesystem.write',input:{path:'.git/config',content:'bad'}}),'SENSITIVE_RESOURCE_DENIED');
 await deny(svc.broker.execute({actor,taskId:task.id,workspaceId:ws,capability:'test.run',input:{}}),'TEST_SANDBOX_UNAVAILABLE');

 const gitRoot=path.join(dir,'git-filter-workspace');fs.mkdirSync(gitRoot);
 const git=(...args)=>execFileSync('git',args,{cwd:gitRoot,stdio:'ignore'});
 git('init','-q');git('config','user.name','CetaMesh test');git('config','user.email','test@example.invalid');
 fs.writeFileSync(path.join(gitRoot,'src.js'),'const value = 1;\n');
 fs.mkdirSync(path.join(gitRoot,'.SSH'));fs.mkdirSync(path.join(gitRoot,'Secrets'));
 fs.writeFileSync(path.join(gitRoot,'.ENV'),'FAKE_UPPER_SECRET=old\n');
 fs.writeFileSync(path.join(gitRoot,'.SSH','key'),'FAKE_SSH_SECRET=old\n');
 fs.writeFileSync(path.join(gitRoot,'Credentials.json'),'FAKE_CREDENTIAL_SECRET=old\n');
 fs.writeFileSync(path.join(gitRoot,'Secrets','data.txt'),'FAKE_SECRET_DIRECTORY=old\n');
 git('add','src.js','.ENV','.SSH','Credentials.json','Secrets');git('commit','-qm','fixture');
 const marker=path.join(dir,'filter-executed.marker'), filterScript=path.join(dir,'filter.cjs');
 fs.writeFileSync(filterScript,"require('fs').writeFileSync(process.argv[2], 'executed'); process.stdin.pipe(process.stdout);\n");
 fs.writeFileSync(path.join(gitRoot,'.gitattributes'),'src.js filter=tripwire\n');
 git('add','.gitattributes');
 git('config','filter.tripwire.clean',`"${process.execPath}" "${filterScript}" "${marker}"`);
 fs.writeFileSync(path.join(gitRoot,'src.js'),'const value = 2;\n');
 fs.writeFileSync(path.join(gitRoot,'.ENV'),'FAKE_UPPER_SECRET=CURRENT\n');
 fs.writeFileSync(path.join(gitRoot,'.SSH','key'),'FAKE_SSH_SECRET=CURRENT\n');
 fs.writeFileSync(path.join(gitRoot,'Credentials.json'),'FAKE_CREDENTIAL_SECRET=CURRENT\n');
 fs.writeFileSync(path.join(gitRoot,'Secrets','data.txt'),'FAKE_SECRET_DIRECTORY=CURRENT\n');
 const filterWs=(await workspaceService.execute({method:'workspace.create',params:{name:'filter-fixture',root:gitRoot}})).workspace;
 const gitTask=taskRuntime.create({goal:'review git diff',workspaceId:filterWs.id});
 svc.grantTask(gitTask.id,{capabilities:['git.status','git.diff'],workspaceIds:[filterWs.id]});
 const gitActor=svc.principalForTask(gitTask.id);
 const userDiff=await svc.broker.execute({actor:owner,workspaceId:filterWs.id,capability:'git.diff',input:{}});
 assert.match(userDiff.result.output,/FAKE_UPPER_SECRET/);
 const scopedDiff=await svc.broker.execute({actor:gitActor,taskId:gitTask.id,workspaceId:filterWs.id,capability:'git.diff',input:{}});
 for (const markerText of ['FAKE_UPPER_SECRET','FAKE_SSH_SECRET','FAKE_CREDENTIAL_SECRET','FAKE_SECRET_DIRECTORY']) {
   assert.doesNotMatch(scopedDiff.result.output,new RegExp(markerText),`Agent diff must omit ${markerText}`);
 }
 assert.equal(fs.existsSync(marker),false,'Brokered worktree diff must not execute Git clean filters');
 git('add','.ENV','.SSH','Credentials.json','Secrets');
 fs.rmSync(marker,{force:true}); // git add is an explicit test-fixture command outside the broker.
 const scopedCachedDiff=await svc.broker.execute({actor:gitActor,taskId:gitTask.id,workspaceId:filterWs.id,capability:'git.diff',input:{cached:true}});
 assert.doesNotMatch(scopedCachedDiff.result.output,/FAKE_UPPER_SECRET|FAKE_SSH_SECRET|FAKE_CREDENTIAL_SECRET|FAKE_SECRET_DIRECTORY/,
   'Agent cached diff must omit protected paths');
 assert.equal(fs.existsSync(marker),false,'Brokered cached diff must not execute Git clean filters');
 await deny(svc.broker.execute({actor,taskId:task.id,workspaceId:ws,capability:'filesystem.write',input:{path:'../escape',content:'bad'}}),'PATH_OUTSIDE_WORKSPACE');
 await deny(svc.broker.execute({actor,taskId:task.id,workspaceId:'outside',capability:'filesystem.read',input:{path:'a.js'}}),'WORKSPACE_RECONCILIATION_REQUIRED');
 await deny(svc.broker.execute({actor:{kind:'external',id:'qq:1'},workspaceId:ws,capability:'filesystem.read',input:{path:'a.js'}}),'PERMISSION_DENIED');
 const userRead=await svc.execute({method:'capability.execute',params:{actor:{kind:'external',id:'evil'},capability:'filesystem.read',workspaceId:ws,input:{path:'a.js'}}});
 assert.equal(userRead.result.content,'hello'); // trusted desktop transport binds owner, never payload actor
 let published=0;
 svc.broker.register({id:'publish.artifact',permission:'publish',risk:'high',execute:()=>{published++;return {sent:true};}});
 const p=await svc.broker.execute(req('publish.artifact',{}, {requestId:'fixed'}));
 await deny(svc.broker.execute(req('publish.artifact',{changed:true},{requestId:'fixed',approvalId:p.approvalId})),'APPROVAL_MISMATCH');
 assert.equal((await svc.execute({method:'capability.approval.decide',params:{id:p.approvalId,approve:false}})).status,'rejected');
 assert.equal(svc.broker.approvals.get(p.approvalId).status,'rejected');
 await deny(svc.broker.execute({...svc.broker.approvals.get(p.approvalId).request,approvalId:p.approvalId}),'APPROVAL_NOT_APPROVED');
 assert.equal(published,0,'tampered, rejected, or replayed requests never dispatch');

 let clock=1000, expiredExecuted=0;
 const expiring=createCapabilityService({stateDir:path.join(dir,'expiring'),now:()=>clock});
 expiring.broker.register({id:'fixture.expiring',permission:'publish',risk:'high',execute:()=>{expiredExecuted++;return {};}});
 const expiringRequest=req('fixture.expiring',{}, {requestId:'expires-once'});
 const expiringPending=await expiring.broker.execute(expiringRequest);
 assert.equal(expiringPending.status,'pending');
 assert.equal(expiring.broker.approvals.list().length,1,'Pending is visible before its deadline');
 clock=expiringPending.expiresAt;
 assert.equal(expiring.broker.approvals.list().length,0,'expired approvals leave the actionable inbox');
 await deny(expiring.execute({method:'capability.approval.decide',params:{id:expiringPending.approvalId,approve:true}}),'APPROVAL_EXPIRED');
 assert.equal(expiredExecuted,0,'expired approval cannot dispatch its capability');
 let declaredEffects=0;
 const effectDefinition={id:'fixture.declared-effect',permission:'extension.invoke',effect:'unknown',risk:'low',
  execute:()=>{declaredEffects++;return {performed:true};}};
 svc.broker.register(effectDefinition);
 assert.throws(()=>svc.broker.register({id:'fixture.invalid-effect',effect:'assume-safe',execute:()=>{}}),{code:'INVALID_CAPABILITY'});
 const effectRequest=req(effectDefinition.id,{target:'fixture'},{requestId:'declared-effect-once',effect:'read-only'});
 await svc.broker.execute(effectRequest);
 await deny(svc.broker.execute(effectRequest),'REQUEST_ALREADY_DISPATCHED');
 assert.equal(declaredEffects,1,'request payload cannot override the server-owned effect classification');
 await deny(svc.broker.execute({...effectRequest,input:{target:'changed'}}),'REQUEST_ID_CONFLICT');
 const restart=createCapabilityService({stateDir:path.join(dir,'state'),workspaceService,taskRuntime});
 restart.broker.register(effectDefinition);
 await deny(restart.broker.execute(effectRequest),'REQUEST_ALREADY_DISPATCHED');
 assert.equal(declaredEffects,1,'the existing dispatch journal retains the effect fence across restart');
 let logicalEffects=0;
 const logicalDefinition={id:'fixture.logical',permission:'extension.invoke',risk:'low',effect:'non-idempotent',
  retainOperationResult:result=>result,execute:()=>({receipt:'receipt-'+(++logicalEffects)})};
 svc.broker.register(logicalDefinition);
 svc.grantTask(task.id,{capabilities:['fixture.logical'],workspaceIds:[ws]});
 const logicalRequest={requestId:'logical-first-attempt',operationId:'logical-send-once',attemptId:'attempt-a',
  actor:owner,taskId:task.id,workspaceId:ws,capability:'fixture.logical',input:{target:'fixture'}};
 const logicalFirst=await svc.broker.execute(logicalRequest);
 const logicalNext={...logicalRequest,requestId:'logical-new-executor',attemptId:'attempt-b',actor:svc.principalForTask(task.id)};
 const logicalReplay=await svc.broker.execute(logicalNext);
 assert.deepEqual(logicalReplay.result,logicalFirst.result,'same logical operation returns the retained result across attempts/executors');
 assert.equal(logicalReplay.replayed,true);
 assert.equal(logicalEffects,1,'a new dispatch identity must not repeat the same logical effect');
 await deny(svc.broker.execute({...logicalRequest,operationId:'changed-operation-under-same-request',input:{target:'different'}}),'REQUEST_ID_CONFLICT');
 const legacyLogical={...logicalRequest,requestId:'legacy-logical-request'};delete legacyLogical.operationId;
 await svc.broker.execute(legacyLogical);
 const effectsAfterLegacy=logicalEffects;
 await deny(svc.broker.execute({...legacyLogical,operationId:'added-after-legacy-dispatch'}),'REQUEST_ID_CONFLICT');
 assert.equal(logicalEffects,effectsAfterLegacy,'a logical ID cannot bypass an existing delivery fence');
 await deny(svc.broker.execute({...logicalNext,requestId:'logical-conflict',input:{target:'changed'}}),'REQUEST_ID_CONFLICT');
 const logicalRestart=createCapabilityService({stateDir:path.join(dir,'state'),workspaceService,taskRuntime});
 logicalRestart.broker.register(logicalDefinition);
 const recoveredResult=await logicalRestart.broker.execute({...logicalNext,requestId:'logical-after-restart'});
 assert.deepEqual(recoveredResult.result,logicalFirst.result);
 assert.equal(logicalEffects,effectsAfterLegacy,'the retained result survives a new Broker process lifetime');
 await logicalRestart.broker.execute({...logicalNext,requestId:'independent-intent',operationId:'new-logical-send'});
 assert.equal(logicalEffects,effectsAfterLegacy+1,'independent repeated intent has a different logical identity');
 logicalRestart.grantTask(task.id,{capabilities:[],workspaceIds:[ws]});
 await deny(logicalRestart.broker.execute({...logicalNext,requestId:'revoked-replay'}),'PERMISSION_DENIED');
 logicalRestart.grantTask(task.id,{capabilities:['filesystem.write','fixture.logical','operation.read'],workspaceIds:[ws]});
 const fileOperation={actor:owner,taskId:task.id,workspaceId:ws,capability:'filesystem.write',approved:true,
  requestId:'append-attempt-a',operationId:'append-once',input:{path:'once-append.txt',content:'once',append:true}};
 const writtenOnce=await logicalRestart.broker.execute(fileOperation);
 const appendedReplay=await logicalRestart.broker.execute({...fileOperation,actor:logicalRestart.principalForTask(task.id),
  approved:false,requestId:'append-attempt-b',attemptId:'new-agent-attempt'});
 assert.deepEqual(appendedReplay.result,writtenOnce.result);
 assert.equal(fs.readFileSync(path.join(dir,'project','once-append.txt'),'utf8'),'once','an append operation cannot append twice after executor change');
 taskRuntime.attachAgent({id:task.id,expectedRev:taskRuntime.get({id:task.id}).task.rev,provider:'replacement-fixture',sessionId:'new-executor-session'});
 const receiptRead=await logicalRestart.broker.execute({actor:logicalRestart.principalForTask(task.id),taskId:task.id,workspaceId:ws,
  capability:'operation.read',input:{operationRef:'append-once'}});
 assert.equal(receiptRead.result.verified,true);assert.deepEqual(receiptRead.result.result,writtenOnce.result);
 const unavailableReceipt=await logicalRestart.broker.execute({actor:logicalRestart.principalForTask(task.id),taskId:task.id,workspaceId:ws,
  capability:'operation.read',input:{operationRef:'logical-send-once'}});
 assert.equal(unavailableReceipt.result.resultAvailable,false);assert.equal(unavailableReceipt.result.needsReview,true);
 assert.equal(unavailableReceipt.result.code,'OPERATION_RESULT_REVIEW_REQUIRED','an unverifiable completed result must explicitly require review');
 await deny(logicalRestart.broker.execute({...fileOperation,requestId:'stale-executor',assignment:{provider:'old-fixture',sessionId:'old-session'}}),'AGENT_ASSIGNMENT_EXPIRED');
 const otherTask=taskRuntime.create({goal:'Other Task cannot read receipt',workspaceId:ws});
 logicalRestart.grantTask(otherTask.id,{capabilities:['operation.read','filesystem.write'],workspaceIds:[ws]});
 await deny(logicalRestart.broker.execute({actor:logicalRestart.principalForTask(otherTask.id),taskId:otherTask.id,workspaceId:ws,
  capability:'operation.read',input:{operationRef:'append-once'}}),'OPERATION_NOT_FOUND');
 fs.writeFileSync(path.join(dir,'project','once-append.txt'),'user changed this file');
 await deny(logicalRestart.broker.execute({...fileOperation,requestId:'append-after-user-change'}),'OPERATION_RESULT_STALE');
 assert.equal(fs.readFileSync(path.join(dir,'project','once-append.txt'),'utf8'),'user changed this file');
 let finishLogical,logicalStarted;
 const startedLogical=new Promise(resolve=>{logicalStarted=resolve;});let concurrentEffects=0;
 logicalRestart.broker.register({id:'fixture.concurrent-operation',permission:'extension.invoke',risk:'low',effect:'non-idempotent',retainOperationResult:r=>r,
  execute:()=>{concurrentEffects++;logicalStarted();return new Promise(resolve=>{finishLogical=resolve;});}});
 const concurrentOperation={...logicalRequest,operationId:'concurrent-operation',capability:'fixture.concurrent-operation',requestId:'concurrent-a'};
 const originalOperation=logicalRestart.broker.execute(concurrentOperation);await startedLogical;
 const runningOperation=await logicalRestart.broker.execute({...concurrentOperation,requestId:'concurrent-b'});
 assert.equal(runningOperation.status,'running');assert.equal(concurrentEffects,1);
 assert.throws(()=>logicalRestart.broker.acknowledgeTaskOperations({taskId:task.id,workspaceId:ws}),{code:'OPERATION_STILL_RUNNING'});
 finishLogical({receipt:'concurrent-receipt'});await originalOperation;
 assert.equal((await logicalRestart.broker.execute({...concurrentOperation,requestId:'concurrent-c'})).result.receipt,'concurrent-receipt');
 const crashState=path.join(dir,'logical-crash'),crashMarker=path.join(dir,'logical-effect.marker');
 const brokerModule=new URL('../src/capability/broker.js',import.meta.url).href;
 const crashSource=`import fs from 'node:fs';import {createCapabilityBroker} from ${JSON.stringify(brokerModule)};
 const broker=createCapabilityBroker({stateDir:${JSON.stringify(crashState)},policy:{authorize:()=>({allowed:true,approvalRequired:false})}});
 broker.register({id:'fixture.crash',permission:'extension.invoke',effect:'non-idempotent',execute:()=>{fs.appendFileSync(${JSON.stringify(crashMarker)},'x');process.exit(71);}});
 await broker.execute({requestId:'crashed-dispatch',operationId:'survive-crash',actor:{kind:'owner',id:'desktop'},taskId:'crash-task',workspaceId:'crash-ws',capability:'fixture.crash',input:{}});`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',crashSource],{stdio:'ignore'}),error=>error.status===71);
 const crashBroker=createCapabilityBroker({stateDir:crashState,policy:{authorize:()=>({allowed:true,approvalRequired:false})}});
 crashBroker.register({id:'fixture.crash',permission:'extension.invoke',effect:'non-idempotent',execute:()=>{throw Error('must not replay crashed effect');}});
 await deny(crashBroker.execute({requestId:'new-dispatch-after-crash',operationId:'survive-crash',actor:owner,
  taskId:'crash-task',workspaceId:'crash-ws',capability:'fixture.crash',input:{}}),'REQUEST_RECOVERY_REQUIRED');
 assert.equal(fs.readFileSync(crashMarker,'utf8'),'x','real child process crash cannot cause the effect to replay');
 assert.equal(restart.principalForTask(task.id).grants.workspaceIds[0],ws);
 const resumeTask=taskRuntime.create({goal:'Resume a verified operation plan',workspaceId:ws});
 logicalRestart.grantTask(resumeTask.id,{capabilities:['filesystem.write','operation.read','operation.continue'],workspaceIds:[ws]});
 taskRuntime.attachAgent({id:resumeTask.id,expectedRev:taskRuntime.get({id:resumeTask.id}).task.rev,provider:'alpha',sessionId:'alpha-plan'});
 const oldPrincipal=logicalRestart.principalForTask(resumeTask.id);
 const plan=await logicalRestart.execute({method:'capability.operation.prepare',params:{taskId:resumeTask.id,workspaceId:ws,
  operationId:'planned-append',capability:'filesystem.write',input:{path:'planned.txt',append:true,content:'one'}}});
 assert.equal(plan.status,'prepared');
 assert.equal(fs.existsSync(path.join(dir,'project','planned.txt')),false,'preparing an intent cannot execute it');
 taskRuntime.attachAgent({id:resumeTask.id,expectedRev:taskRuntime.get({id:resumeTask.id}).task.rev,provider:'beta',sessionId:'beta-plan'});
 const resumePrincipal=logicalRestart.principalForTask(resumeTask.id);
 await deny(logicalRestart.broker.execute({actor:oldPrincipal,taskId:resumeTask.id,workspaceId:ws,
  capability:'filesystem.write',input:{path:'stale-write.txt',content:'bad'}}),'AGENT_ASSIGNMENT_EXPIRED');
 const resumeRequest={actor:resumePrincipal,taskId:resumeTask.id,workspaceId:ws,capability:'operation.continue',
  input:{operationRef:'planned-append',input:{content:'one',append:true,path:'planned.txt'}}};
 let resumePending=await logicalRestart.broker.execute({...resumeRequest,requestId:'beta-resume'});
 assert.equal(resumePending.status,'pending','continuing a prepared write still requires its real source approval');
 await logicalRestart.execute({method:'capability.approval.decide',params:{id:resumePending.approvalId,approve:false}});
 await deny(logicalRestart.broker.execute({...resumeRequest,requestId:'cannot-evade-rejected-approval'}),'OPERATION_PERMISSION_REVIEW_REQUIRED');
 await logicalRestart.execute({method:'capability.operation.review',params:{taskId:resumeTask.id,workspaceId:ws,operationId:'planned-append'}});
 resumePending=await logicalRestart.broker.execute({...resumeRequest,requestId:'owner-reviewed-new-approval'});
 await logicalRestart.execute({method:'capability.approval.decide',params:{id:resumePending.approvalId,approve:true}});
 const resumeResult=await logicalRestart.broker.execute({...resumeRequest,requestId:'new-session-new-tool-call'});
 assert.equal(resumeResult.replayed,true);
 assert.equal(fs.readFileSync(path.join(dir,'project','planned.txt'),'utf8'),'one','reordered parameters and new calls cannot duplicate the append');
 const resumedRead=await logicalRestart.broker.execute({actor:resumePrincipal,taskId:resumeTask.id,workspaceId:ws,
  capability:'operation.read',input:{operationRef:'planned-append'}});
 assert.equal(resumedRead.result.verified,true,'replacement Agents can independently verify the completed source result');
 await deny(logicalRestart.broker.execute({...resumeRequest,requestId:'changed-plan',input:{operationRef:'planned-append',
  input:{path:'planned.txt',content:'changed',append:true}}}),'REQUEST_ID_CONFLICT');
 await deny(logicalRestart.broker.execute({actor:resumePrincipal,taskId:resumeTask.id,workspaceId:ws,capability:'filesystem.write',
  operationId:'guessed-fresh-id',input:{path:'unlinked.txt',content:'unlinked'}}),'OPERATION_LINK_REQUIRED');
 const independentPlan=await logicalRestart.execute({method:'capability.operation.prepare',params:{taskId:resumeTask.id,workspaceId:ws,
  operationId:'independent-intent',capability:'filesystem.write',input:{path:'planned.txt',content:'one',append:true,
   expectedHash:crypto.createHash('sha256').update('one').digest('hex')}}});
 assert.equal(independentPlan.status,'prepared','a separate explicit intent gets a separate logical identity');
 const planAfterRestart=createCapabilityService({stateDir:path.join(dir,'state'),workspaceService,taskRuntime});
 assert.equal(planAfterRestart.broker.operationRecordForTask({taskId:resumeTask.id,workspaceId:ws,operationId:'independent-intent'}).status,'prepared');
 const newIntent=await planAfterRestart.broker.execute({...resumeRequest,actor:planAfterRestart.principalForTask(resumeTask.id),requestId:'independent-intent-call',
  input:{operationRef:'independent-intent',input:{path:'planned.txt',content:'one',append:true,expectedHash:crypto.createHash('sha256').update('one').digest('hex')}}});
 assert.equal(newIntent.status,'pending');
 await planAfterRestart.execute({method:'capability.approval.decide',params:{id:newIntent.approvalId,approve:true}});
 assert.equal(fs.readFileSync(path.join(dir,'project','planned.txt'),'utf8'),'oneone','independent intent is executed, not incorrectly deduplicated');
 await deny(planAfterRestart.broker.execute({...resumeRequest,actor:planAfterRestart.principalForTask(otherTask.id),taskId:otherTask.id,
  input:{operationRef:'planned-append',input:{path:'planned.txt',content:'one',append:true}}}),'PERMISSION_DENIED');
 let admissionChecks=0,noEffectWrites=0;
 const noEffectBroker=createCapabilityBroker({stateDir:path.join(dir,'pre-dispatch-retry'),policy:{authorize:()=>{
  if(++admissionChecks===3)throw Object.assign(new Error('Admission temporarily unavailable'),{code:'TEMPORARY_ADMISSION'});
  return {approvalRequired:false};
 }}});
 noEffectBroker.register({id:'fixture.pre-dispatch',permission:'extension.invoke',effect:'unknown',retainOperationResult:r=>r,
  execute:()=>({writes:++noEffectWrites})});
 const knownUnexecuted={actor:owner,taskId:'no-effect-task',workspaceId:ws,operationId:'retry-known-unexecuted',
  requestId:'before-dispatch',capability:'fixture.pre-dispatch',input:{}};
 await deny(noEffectBroker.execute(knownUnexecuted),'TEMPORARY_ADMISSION');
 assert.equal(noEffectBroker.operationRecordForTask({taskId:'no-effect-task',workspaceId:ws,operationId:'retry-known-unexecuted'}).status,'failed-no-effect');
 assert.equal((await noEffectBroker.execute({...knownUnexecuted,requestId:'controlled-retry'})).result.writes,1);
 const grantTask=taskRuntime.create({goal:'Use a bounded exact write grant',workspaceId:ws});
 logicalRestart.grantTask(grantTask.id,{capabilities:['filesystem.write'],workspaceIds:[ws]});
 fs.writeFileSync(path.join(dir,'project','l2-grant.txt'),'bounded write');
 const grantInput={path:'l2-grant.txt',content:'bounded write',expectedHash:crypto.createHash('sha256').update('bounded write').digest('hex')};
 const bounded=await logicalRestart.execute({method:'capability.grant.create',params:{taskId:grantTask.id,workspaceId:ws,
  capability:'filesystem.write',input:grantInput,ttlMs:60000,maxUses:1}});
 assert.equal(bounded.status,'active');
 const grantedWrite={actor:logicalRestart.principalForTask(grantTask.id),taskId:grantTask.id,workspaceId:ws,
  capability:'filesystem.write',input:grantInput,operationId:'l2-first',requestId:'l2-first-request'};
 assert.equal((await logicalRestart.broker.execute(grantedWrite)).status,'completed','an exact finite Owner grant avoids repeat approval');
 assert.equal((await logicalRestart.execute({method:'capability.grant.list'})).grants.find(row=>row.id===bounded.id).uses,1);
 assert.equal((await logicalRestart.broker.execute({...grantedWrite,requestId:'same-completed-operation'})).replayed,true,'replay does not consume grant again');
 const exhausted=await logicalRestart.broker.execute({...grantedWrite,requestId:'new-independent-write',operationId:'l2-second',
  input:{...grantInput}});
 assert.equal(exhausted.status,'pending','new parameters or exhausted grant require real approval');
 const revoked=await logicalRestart.execute({method:'capability.grant.create',params:{taskId:grantTask.id,workspaceId:ws,
  capability:'filesystem.write',input:{path:'l2-revoked.txt',content:'must not write'},ttlMs:60000,maxUses:2}});
 await logicalRestart.execute({method:'capability.grant.revoke',params:{id:revoked.id}});
 assert.equal((await logicalRestart.broker.execute({...grantedWrite,requestId:'revoked-grant',operationId:'l2-revoked',
  input:{path:'l2-revoked.txt',content:'must not write'}})).status,'pending');
 assert.equal(fs.existsSync(path.join(dir,'project','l2-revoked.txt')),false);
 await deny(logicalRestart.execute({method:'capability.grant.create',params:{taskId:grantTask.id,workspaceId:ws,
  capability:'test.run',input:{},ttlMs:60000,maxUses:1}}),'GRANT_CAPABILITY_DENIED');
 let grantClock=1000;
 const clockGrants=createCapabilityService({stateDir:path.join(dir,'clock-grants'),workspaceService,taskRuntime,now:()=>grantClock});
 clockGrants.grantTask(grantTask.id,{capabilities:['filesystem.write'],workspaceIds:[ws]});
 await clockGrants.execute({method:'capability.grant.create',params:{taskId:grantTask.id,workspaceId:ws,capability:'filesystem.write',
  input:{path:'l2-expired.txt',content:'expired'},ttlMs:1000,maxUses:2}});
 grantClock=2000;
 assert.equal((await clockGrants.broker.execute({...grantedWrite,actor:clockGrants.principalForTask(grantTask.id),requestId:'expired-grant',
  operationId:'expired-grant-op',input:{path:'l2-expired.txt',content:'expired'}})).status,'pending');
 assert.equal(fs.existsSync(path.join(dir,'project','l2-expired.txt')),false,'expiry at the exact deadline prevents dispatch');
 await clockGrants.execute({method:'capability.grant.create',params:{taskId:grantTask.id,workspaceId:ws,capability:'filesystem.write',
  input:{path:'l2-new-executor.txt',content:'must reapprove'},ttlMs:1000,maxUses:2}});
 taskRuntime.attachAgent({id:grantTask.id,expectedRev:taskRuntime.get({id:grantTask.id}).task.rev,provider:'new-fixture',sessionId:'grant-new-executor'});
 assert.equal((await clockGrants.broker.execute({...grantedWrite,actor:clockGrants.principalForTask(grantTask.id),requestId:'grant-moved-executor',
  operationId:'new-executor-grant-op',input:{path:'l2-new-executor.txt',content:'must reapprove'}})).status,'pending');
 console.log('PASS capability broker: registry, permission, boundary, owner approval, replay/tamper, external denial, task grants and desktop actor binding');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
