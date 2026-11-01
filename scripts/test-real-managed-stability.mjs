// Opt-in real model stability. Uses production Desktop Task endpoints and Core tools;
// this is API acceptance, not a claim of ten native Desktop interactions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';

if(process.env.WHALEBRIDGE_TEST_REAL_MANAGED!=='1'){
 console.log('NOT_RUN_ENVIRONMENT: explicit real Managed model opt-in required');process.exit(77);
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-managed-stability-'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
// Git diff excludes untracked/ignored files. Verify the complete controlled
// project before and after executing the unchanged independent verifier.
function projectSnapshot(project){
 const entries=Object.create(null);
 function visit(directory,prefix=''){
  for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   if(!prefix&&item.name==='.git')continue;
   const relative=prefix+item.name,absolute=path.join(directory,item.name);
   assert.ok(!item.isSymbolicLink(),'unexpected symbolic link: '+relative);
   if(item.isDirectory()){entries[relative+'/']='directory';visit(absolute,relative+'/');}
   else {assert.ok(item.isFile(),'unexpected special file: '+relative);entries[relative]=hash(fs.readFileSync(absolute));}
  }
 }
 visit(project);return entries;
}
function assertOnlyMathChanged(before,after){
 assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort(),'project paths changed, including untracked or ignored entries');
 for(const [file,digest]of Object.entries(before))if(file!=='math.mjs')assert.equal(after[file],digest,'protected project entry changed: '+file);
 assert.notEqual(after['math.mjs'],before['math.mjs'],'math.mjs must actually change');
}
// Negative controls prove the guard rejects previously missed additions and
// changes made by executing an imported module, independent of model output.
assert.throws(()=>assertOnlyMathChanged({'math.mjs':'old','verify.mjs':'fixed'},{'math.mjs':'new','verify.mjs':'fixed','ignored.tmp':'extra'}));
assert.throws(()=>assertOnlyMathChanged({'math.mjs':'old','verify.mjs':'fixed'},{'math.mjs':'new','verify.mjs':'changed'}));
const snapshotProbe=path.join(root,'snapshot-guard');fs.mkdirSync(snapshotProbe);
try{
 fs.writeFileSync(path.join(snapshotProbe,'math.mjs'),'old');
 const before=projectSnapshot(snapshotProbe);fs.writeFileSync(path.join(snapshotProbe,'math.mjs'),'new');
 fs.writeFileSync(path.join(snapshotProbe,'__proto__'),'untracked');
 const after=projectSnapshot(snapshotProbe);assert.ok(Object.hasOwn(after,'__proto__'));
 assert.throws(()=>assertOnlyMathChanged(before,after),/project paths changed/);
}finally{
 for(const name of ['__proto__','math.mjs'])fs.rmSync(path.join(snapshotProbe,name),{force:true});
 fs.rmdirSync(snapshotProbe);
}
const provider=process.env.CETAMESH_TEST_MANAGED_PROVIDER||'deepseek-official';
const model=process.env.CETAMESH_TEST_MANAGED_MODEL||'deepseek-flash';
const existing=createProviderSecrets({root:process.env.CETAMESH_TEST_PROVIDER_DATA_ROOT||path.join(process.env.LOCALAPPDATA||os.homedir(),'WhaleBridge')});
const credentials=Object.freeze({list:()=>existing.list(),raw:id=>existing.raw(id)});
const evidence={kind:'real-model-production-Core-API',nativeDesktop:false,authorizationMode:'Owner-explicit existing protected-code-tests contract; each source effect still approved',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),provider,model,startedAt:new Date().toISOString(),requiredConsecutiveTasks:10,tasks:[],modelRequests:0};
let services,currentTaskId=null,settled=false;
const create=()=>createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:credentials,log:()=>{}});
async function close(){if(!services)return;for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','extensionService'])await services[name].close();}
try{
 services=create();
 const stream=services.modelRuntime.stream.bind(services.modelRuntime);
 services.modelRuntime.stream=async function*(request){evidence.modelRequests++;(evidence.modelToolManifests??=[]).push((request.tools??[]).map(item=>item.id));yield*stream(request);};
 for(let index=1;index<=10;index++){
  const started=Date.now(),project=path.join(root,'project-'+index);fs.mkdirSync(project);
  const files={'math.mjs':'export const add=(a,b)=>a-b;\n','verify.mjs':`import assert from 'node:assert/strict';import {add} from './math.mjs';assert.equal(add(${index},4),${index+4});assert.equal(add(-2,5),3);console.log('STABILITY_TASK_${index}_VERIFIED');\n`,'package.json':JSON.stringify({private:true,type:'module',scripts:{test:'node verify.mjs'}})+'\n'};
  for(const [file,content]of Object.entries(files))fs.writeFileSync(path.join(project,file),content);
  const protectedHashes=Object.fromEntries(['verify.mjs','package.json'].map(file=>[file,hash(fs.readFileSync(path.join(project,file)))]));
  for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Stability','-c','user.email=stability@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','controlled baseline']])execFileSync('git',args,{stdio:'ignore'});
  const originalSnapshot=projectSnapshot(project);
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Managed stability '+index}})).workspace;
  const goal=`Stability task ${index}: fix add in math.mjs to add its arguments. Read math.mjs, verify.mjs and package.json, change only math.mjs, then run existing npm test via test.run and report actual results. Do not change verify.mjs/package.json, delegate, install, use network, or commit. Keep actions minimal.`;
  const result=await services.desktopUiService.execute({method:'ui.task.create',params:{goal,workspaceId:workspace.id,agentProvider:'cetamesh',modelProvider:provider,model,requestId:'stability-'+index,
   collaboration:{enabled:true,allowUnknownCost:false,prepareNative:false,verification:{editablePaths:['math.mjs'],testFiles:['verify.mjs']}}}});
  currentTaskId=result.task.id;
  const row={index,taskId:currentTaskId,workspaceId:workspace.id,approvals:[],status:'running',startedAt:new Date(started).toISOString()};evidence.tasks.push(row);
  const approved=new Set(),deadline=Date.now()+180000;let task;
  while(Date.now()<deadline){
   for(const approval of services.capabilityService.broker.approvals.list()){
    if(approval.status!=='pending'||approval.request?.taskId!==currentTaskId||approved.has(approval.id))continue;
    const request=approval.request;
    for(const [file,digest]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.join(project,file))),digest,'protected input must not change');
    if(request.capability==='filesystem.write')assert.equal(request.input.path,'math.mjs');
    else if(request.capability==='test.run'){assert.equal(request.input.tool,'npm');assert.deepEqual(request.input.args,['test']);}
    else throw Error('Unexpected approval: '+request.capability);
    approved.add(approval.id);row.approvals.push(request.capability);
    await services.capabilityService.execute({method:'capability.approval.decide',params:{id:approval.id,approve:true}});
   }
   task=services.taskService.runtime.get({id:currentTaskId}).task;
   if(task.executionObservation?.state==='awaiting-review'||['blocked','failed','cancelled'].includes(task.status))break;
   await delay(100);
  }
  assert.equal(task.executionObservation?.state,'awaiting-review',JSON.stringify({status:task.status,progress:task.progress}));
  const observed=task.executionObservation;
  const coreTests=task.executionEvidence.filter(item=>item.source==='core-test'&&item.provider==='cetamesh'&&item.runId===observed.runId&&item.sessionId===task.currentAgent.sessionId);
  assert.ok(coreTests.length,'real current-run Core test evidence required');assert.equal(coreTests.at(-1).exitCode,0);
  assert.equal(task.currentAgent.provider,'cetamesh');assert.ok(!task.delegationProposal,'single-Agent scenario must not delegate');
  for(const [file,digest]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.join(project,file))),digest);
  const changed=execFileSync('git',['-C',project,'diff','--name-only'],{encoding:'utf8'}).trim().split(/\r?\n/);assert.deepEqual(changed,['math.mjs']);
  assertOnlyMathChanged(originalSnapshot,projectSnapshot(project));
  const output=execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8',timeout:30000});assert.match(output,new RegExp('STABILITY_TASK_'+index+'_VERIFIED'));
  const finalSnapshot=projectSnapshot(project);assertOnlyMathChanged(originalSnapshot,finalSnapshot);
  // Explicit test-owner acceptance follows actual file/test verification. No
  // model, prompt or fake readiness is allowed to complete the Task by itself.
  const completed=await services.desktopUiService.execute({method:'ui.task.complete',params:{id:task.id,expectedRev:task.rev,reviewed:true,summary:'Test Owner verified only math.mjs changed, protected hashes unchanged, current Core test and original verifier exit 0.'}});
  assert.equal(completed.task.status,'completed');
  const saved=JSON.parse(fs.readFileSync(path.join(root,'state/tasks/tasks.json'),'utf8')).tasks.find(item=>item.id===task.id);assert.equal(saved.status,'completed');
  Object.assign(row,{status:'PASS',taskStatus:saved.status,coreTestExitCode:0,testExitCodes:coreTests.map(item=>item.exitCode),currentRunId:observed.runId,fileSHA256:hash(fs.readFileSync(path.join(project,'math.mjs'))),protectedHashes,originalSnapshot,finalSnapshot,elapsedMs:Date.now()-started});
  await services.agentBroker.closeSession(task.currentAgent);currentTaskId=null;
  console.log('PASS REAL Managed consecutive task '+index+'/10 ('+row.elapsedMs+'ms)');
 }
 await close();services=create();
 for(const row of evidence.tasks)assert.equal(services.taskService.runtime.get({id:row.taskId}).task.status,'completed');
 evidence.serviceRestart={kind:'real production service composition restart; not native process E2E',persistedCompletedTasks:10};
 evidence.passedConsecutiveTasks=evidence.tasks.filter(row=>row.status==='PASS').length;assert.equal(evidence.passedConsecutiveTasks,10);settled=true;
}catch(error){evidence.failure={code:error?.code||error.name,message:String(error.message).slice(0,700)};process.exitCode=1;
 if(services&&currentTaskId){const task=services.taskService.runtime.get({id:currentTaskId}).task;evidence.failedTask={id:task.id,status:task.status,observedState:task.executionObservation?.state,capabilities:services.capabilityService.principalForTask(task.id).grants.capabilities,toolEvidence:task.executionEvidence.map(item=>({capability:item.capability,status:item.status,source:item.source??null,exitCode:item.exitCode??null}))};}
}
finally{
 if(services&&currentTaskId){const task=services.taskService.runtime.get({id:currentTaskId}).task;try{await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:task.id,expectedRev:task.rev}});}catch(error){evidence.cleanupCode=error.code||'CANCEL_UNCONFIRMED';}}
 await close();evidence.finishedAt=new Date().toISOString();evidence.elapsedMs=Date.parse(evidence.finishedAt)-Date.parse(evidence.startedAt);
 if(process.env.CETAMESH_TEST_EVIDENCE_FILE)fs.writeFileSync(process.env.CETAMESH_TEST_EVIDENCE_FILE,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({realStabilityEvidence:evidence}));
 // Retain uncertain synthetic state for reconciliation instead of deleting it.
 if(settled){assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('cetamesh-managed-stability-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 else console.log('Suite did not delete synthetic failure state; parent runner retention policy may reclaim: '+root);
}
