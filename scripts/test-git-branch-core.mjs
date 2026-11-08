import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createTaskService} from '../src/task/service.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {workspaceJournalDir,inspectWorkspaceByteTransaction} from '../src/workspace/transaction.js';
async function runFixture(scenario) {
const parent=fs.realpathSync.native(os.tmpdir()),base=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'cm-git-branch-core-'))),owned=fs.lstatSync(base,{bigint:true});
const root=path.join(base,'project'),stateDir=path.join(base,'state');
const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
const git=(...args)=>execFileSync('git',['-c','commit.gpgSign=false','-c','core.hooksPath='+path.join(base,'no-hooks'),...args],{cwd:root,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
let capabilities, ownedJournal, childHook=()=>{};let nativeCalls=0,clock=Date.now();
const execOriginal=childProcess.execFile, renameOriginal=fs.renameSync, rmOriginal=fs.rmSync, children=new Set(), retainedResources=[];
childProcess.execFile=function(command,args,...rest){childHook(command,args);if(args.some(x=>typeof x==='string'&&x.startsWith('--workspace-byte-transaction=')))nativeCalls++;
 const child=execOriginal.call(this,command,args,...rest),closed=new Promise(resolve=>child.once('close',resolve));children.add(closed);closed.then(()=>children.delete(closed));return child;};syncBuiltinESMExports();
try{
 fs.mkdirSync(root);git('init','-b','main');git('config','user.name','Core fixture');git('config','user.email','core@example.invalid');git('config','core.autocrlf','false');
 fs.writeFileSync(path.join(root,'a.txt'),'base\n');git('add','.');git('commit','-m','base');git('checkout','-b','target');fs.writeFileSync(path.join(root,'a.txt'),'target\n');git('commit','-am','target');git('checkout','main');
 let tasks;let workspace=createWorkspaceService({stateDir,getTask:id=>tasks.runtime.get({id}).task,listTasks:q=>tasks.runtime.list(q).tasks,nativeExecutable:process.env.CETAMESH_TEST_WORKSPACE_NATIVE});
 tasks=createTaskService({stateDir,resolveWorkspace:id=>workspace.describeWorkspace(id)});
 const {workspace:entry}=await workspace.execute({method:'workspace.create',params:{root,name:'Branch Core fixture'}});
 capabilities=createCapabilityService({stateDir,workspaceService:workspace,taskRuntime:tasks.runtime,now:()=>clock});
 let ui=createDesktopUiService({services:{workspaceService:workspace,taskService:tasks,capabilityService:capabilities}});
 const call=(method,params)=>ui.execute({method,params});
 const fresh=(mode='clean',targetBranch='refs/heads/target')=>call('ui.workspace.git.branch.review',{id:entry.id,targetBranch,mode});
 const input=r=>Object.fromEntries(['paths','targetBranch','mode','expectedHead','expectedHeadRef','expectedTargetHead','indexIdentity','expectedRepositoryIdentity','expectedDirtyIdentity','expectedHashes','expectedWorkingModes',...(r.byteTransaction?['byteTransaction']:[])].map(k=>[k,r[k]]));
 const request=async(mode='clean',targetBranch='refs/heads/target',scope={})=>{const reviewed=await fresh(mode,targetBranch);return call('ui.workspace.git.branch.switch',{id:entry.id,...(reviewed.taskId?{taskId:reviewed.taskId}:{}),...scope,...input(reviewed)});};
 const decide=p=>capabilities.execute({method:'capability.approval.decide',params:{id:p.approvalId,approve:true}});
 const decideUi=async p=>{const accepted=await call('ui.approvals.decide',{id:p.approvalId,approve:true});assert.equal(accepted.status,'accepted');
  const deadline=Date.now()+30000;let result;
  do{result=(await call('ui.approvals.list',{})).operations.find(row=>row.operationId===accepted.operationId);if(result&&!['accepted','running','waiting'].includes(result.status))break;await delay(10);}while(Date.now()<deadline);
  assert.ok(result&&!['accepted','running','waiting'].includes(result.status),'UI approval operation must reach a real terminal observation');return result;};
 const journal=()=>{const dir=workspaceJournalDir(root);if(!ownedJournal&&fs.existsSync(dir))ownedJournal={dir,node:fs.lstatSync(dir,{bigint:true})};return dir;};
 const rows=()=>JSON.parse(fs.readFileSync(path.join(stateDir,'capability','dispatches.json'),'utf8'));
 async function reconstruct(){await capabilities.close();workspace=createWorkspaceService({stateDir,getTask:id=>tasks.runtime.get({id}).task,listTasks:q=>tasks.runtime.list(q).tasks,nativeExecutable:process.env.CETAMESH_TEST_WORKSPACE_NATIVE});
  tasks=createTaskService({stateDir,resolveWorkspace:id=>workspace.describeWorkspace(id)});capabilities=createCapabilityService({stateDir,workspaceService:workspace,taskRuntime:tasks.runtime,now:()=>clock});ui=createDesktopUiService({services:{workspaceService:workspace,taskService:tasks,capabilityService:capabilities}});}
 if(scenario==='cleanup'){
  const pending=await request(),unrelated=path.join(base,'unrelated-private-resource');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'retain.txt'),'unowned by Git cleanup');
  fs.rmSync=function(target,...args){if(path.basename(String(target)).startsWith('cm-git-head-routing-')){retainedResources.push({path:String(target),node:fs.lstatSync(target,{bigint:true})});throw Object.assign(new Error('fixture routing anchor busy'),{code:'EBUSY'});}return rmOriginal.call(this,target,...args);};
  const completed=await decide(pending);fs.rmSync=rmOriginal;journal();const durable=rows()[pending.requestId].retainedResult;
  assert.equal(completed.status,'completed');assert.equal(git('symbolic-ref','HEAD'),'refs/heads/target');assert.equal(nativeCalls,1);assert.equal(children.size,0);assert.deepEqual(fs.readdirSync(journal()),[]);
  assert.ok(retainedResources.length);assert.equal(durable.cleanupPending,true);assert.equal(completed.result.cleanupPending,true,'raw ACK cannot clear a retained routing anchor obligation');
  assert.deepEqual(completed.result.cleanupResources,durable.cleanupResources);assert.ok(completed.result.cleanupResources.some(row=>row.kind==='git-head-routing-anchor'));assert.ok(fs.existsSync(retainedResources[0].path));assert.equal(fs.readFileSync(path.join(unrelated,'retain.txt'),'utf8'),'unowned by Git cleanup');
  console.log('PASS real native/Git completion retains routing-anchor EBUSY cleanup in direct and durable receipts after raw ACK; unrelated resources remain intact');
  return;
 }
 if(['metadata-proof','metadata-proof-owner','metadata-ui','metadata-ui-owner'].includes(scenario)){
  const viaUi=scenario.startsWith('metadata-ui');
  const same=await request('clean','refs/heads/main');assert.equal((await decide(same)).status,'completed');
  const old=git('rev-parse','HEAD'),other=git('rev-parse','target'),branch='refs/heads/proof-alias';git('branch','proof-alias',old);
  const task=!scenario.endsWith('-owner')?tasks.runtime.create({goal:'Retained metadata proof Task',workspaceId:entry.id}):null;
  const original=await request('clean',branch,task?{taskId:task.id,operationId:'fix1-original'}:{});let injected=false;
  childHook=(command,args)=>{if(!injected&&command==='git'&&args.includes('update-ref')&&args.includes('--stdin')){injected=true;git('update-ref',branch,other,old);}};
  if(viaUi)assert.equal((await decideUi(original)).status,'unknown');else await assert.rejects(decide(original),{effectStatus:'unknown'});
  childHook=()=>{};assert.ok(injected);git('update-ref',branch,old,other);assert.equal(children.size,0);
  const originalRow=()=>Object.values(rows()).find(row=>row.requestId===original.requestId),originalIndex=fs.readFileSync(path.join(root,'.git','index'));
  assert.equal(originalRow().gitMetadata.closed,true);assert.equal((await fresh('finish-prepared',branch)).canSwitch,true);
  for(const status of ['consumed','pending']){
   const copy=path.join(base,'legacy-'+status);fs.cpSync(stateDir,copy,{recursive:true});const dispatchFile=path.join(copy,'capability','dispatches.json'),value=JSON.parse(fs.readFileSync(dispatchFile,'utf8'));delete Object.values(value).find(row=>row.requestId===original.requestId).gitMetadata.reviewProof;fs.writeFileSync(dispatchFile,JSON.stringify(value));
   const file=path.join(copy,'capability','approvals.json'),approvals=JSON.parse(fs.readFileSync(file,'utf8'));approvals.find(row=>row.id===original.approvalId).status=status;fs.writeFileSync(file,JSON.stringify(approvals));
   const owner=createWorkspaceService({stateDir:copy}),caps=createCapabilityService({stateDir:copy,workspaceService:owner,taskRuntime:tasks.runtime,now:()=>clock});
   try{if(status==='consumed')assert.equal(caps.broker.gitMetadataRecovery(entry.id).metadataRecovery.targetBranch,branch);else assert.throws(()=>caps.broker.gitMetadataRecovery(entry.id),{code:'WORKSPACE_RECOVERY_REQUIRED'});}finally{await caps.close();}
  }
  // Seed only historical traffic; actual production pending/cancel performs pruning.
  await capabilities.close();const approvalFile=path.join(stateDir,'capability','approvals.json'),history=JSON.parse(fs.readFileSync(approvalFile,'utf8'));
  while(history.length<1000)history.push({...history[0],id:'fixture-history-'+history.length,status:'rejected',createdAt:clock});fs.writeFileSync(approvalFile,JSON.stringify(history));await reconstruct();
  for(let n=0;n<6;n++){const extra=capabilities.broker.approvals.pending({requestId:'fixture-retention-pressure-'+n,actor:{kind:'owner',id:'desktop'},capability:'fixture.history',input:{}});capabilities.broker.approvals.cancel(extra.id);}
  assert.throws(()=>capabilities.broker.approvals.get(original.approvalId),{code:'APPROVAL_NOT_FOUND'});await reconstruct();
  if(viaUi){
   const copy=path.join(base,'unrelated-pruned-wrapper');fs.cpSync(stateDir,copy,{recursive:true});const file=path.join(copy,'capability','operations.json'),operations=JSON.parse(fs.readFileSync(file,'utf8'));
   operations['approval:unrelated-pruned']={operationId:'approval:unrelated-pruned',approvalId:'unrelated-pruned',approve:true,status:'unknown'};fs.writeFileSync(file,JSON.stringify(operations));
   const owner=createWorkspaceService({stateDir:copy}),caps=createCapabilityService({stateDir:copy,workspaceService:owner,taskRuntime:tasks.runtime,now:()=>clock});
   try{assert.equal((await caps.execute({method:'capability.operation.get',params:{id:'approval:unrelated-pruned'}})).status,'unknown');
    await assert.rejects(caps.executeWorkspace({method:'workspace.git.branch.review',params:{id:entry.id,targetBranch:branch,mode:'finish-prepared'}}),{code:'WORKSPACE_OPERATION_UNCONFIRMED'});
   }finally{await caps.close();}
  }
  assert.equal((await fresh('finish-prepared',branch)).canSwitch,true,'closed original dispatch proof must survive normal approval-history pruning');
  const proof=originalRow().gitMetadata.reviewProof;assert.ok(proof);assert.equal(proof.binding.operationId,task?'fix1-original':null);assert.equal(proof.binding.taskId,task?.id??null);assert.deepEqual(Object.keys(proof).sort(),['approvalFingerprint','binding','input','schema','scopeFingerprint']);
  const assertInvalid=async(name,mutate,code='WORKSPACE_RECOVERY_REQUIRED')=>{
   const copy=path.join(base,'proof-negative-'+name);fs.cpSync(stateDir,copy,{recursive:true});const file=path.join(copy,'capability','dispatches.json'),value=JSON.parse(fs.readFileSync(file,'utf8'));mutate(Object.values(value).find(row=>row.requestId===original.requestId),value);fs.writeFileSync(file,JSON.stringify(value));
   const owner=createWorkspaceService({stateDir:copy}),caps=createCapabilityService({stateDir:copy,workspaceService:owner,taskRuntime:tasks.runtime,now:()=>clock});
   try{await assert.rejects(caps.executeWorkspace({method:'workspace.git.branch.review',params:{id:entry.id,targetBranch:branch,mode:'finish-prepared'}}),{code});}finally{await caps.close();}
  };
  await assertInvalid('changed',row=>{row.gitMetadata.reviewProof.input.expectedHead='0'.repeat(40);});
  await assertInvalid('copied',(row,value)=>{row.gitMetadata.reviewProof=structuredClone(Object.values(value).find(item=>item.requestId===same.requestId).gitMetadata.reviewProof);});
  await assertInvalid('unclosed',row=>{row.gitMetadata.closed=false;},'EXECUTION_UNCONFIRMED');
  await assertInvalid('missing-legacy',row=>{delete row.gitMetadata.reviewProof;},'GIT_RECOVERY_PROOF_UNAVAILABLE');
  const pending=await request('finish-prepared',branch);await assert.rejects(fresh('finish-prepared',branch),{code:'WORKSPACE_APPROVAL_PENDING'});await capabilities.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:false}});
  const completion=await request('finish-prepared',branch,task?{operationId:'fix1-finish'}:{});assert.notEqual(completion.approvalId,original.approvalId);assert.equal((await (viaUi?decideUi:decide)(completion)).status,'completed');
  assert.equal(nativeCalls,0);assert.equal(git('symbolic-ref','HEAD'),branch);assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),originalIndex);assert.equal(originalRow().status,'reconciled');assert.equal(originalRow().historicalStatus,'outcome-unknown');assert.equal(originalRow().completionRequestId,completion.requestId);assert.deepEqual(originalRow().gitMetadata.reviewProof,proof);
  if(viaUi){await reconstruct();
   for(const changed of ['unknown-successor','started-successor','other-workspace','other-task','missing-successor','missing-receipt','duplicate-approval','non-git-original']){
    const copy=path.join(base,changed);fs.cpSync(stateDir,copy,{recursive:true});const file=path.join(copy,'capability','dispatches.json'),dispatches=JSON.parse(fs.readFileSync(file,'utf8'));
    const [key,next]=Object.entries(dispatches).find(([,row])=>row.capability==='git.branch.switch'&&row.requestId===completion.requestId);
    const originalEntry=Object.values(dispatches).find(row=>row.capability==='git.branch.switch'&&row.requestId===original.requestId);
    if(changed==='unknown-successor')next.status='outcome-unknown';else if(changed==='started-successor')next.status='started';else if(changed==='other-workspace')next.workspaceId='unrelated';else if(changed==='other-task')next.taskId='unrelated';else if(changed==='missing-receipt')delete next.retainedResult;else if(changed==='duplicate-approval')dispatches.duplicate=structuredClone(originalEntry);else if(changed==='non-git-original')originalEntry.capability='filesystem.write';else delete dispatches[key];fs.writeFileSync(file,JSON.stringify(dispatches));
    const owner=createWorkspaceService({stateDir:copy}),caps=createCapabilityService({stateDir:copy,workspaceService:owner,taskRuntime:tasks.runtime,now:()=>clock});
    try{assert.equal(caps.broker.gitApprovalReceipt(original.approvalId),null);assert.equal((await caps.execute({method:'capability.operation.get',params:{id:'approval:'+original.approvalId}})).status,'unknown');}finally{await caps.close();}
   }
   assert.equal((await call('ui.approvals.operation',{id:'approval:'+original.approvalId})).status,'completed');assert.equal((await fresh('clean','refs/heads/main')).canSwitch,true,'reconciled wrapper must not permanently block later legitimate Git work');}
  console.log('PASS actual zero-file CAS failure survives production approval pruning and cold '+(task?'logical-Task':'Owner/no-Task')+' recovery with fresh approval; exact legacy fallback works, changed/copied/missing proof, pending approval and unclosed invocation refuse without native/index replay');
  return;
 }
 const review=await ui.execute({method:'ui.workspace.git.branch.review',params:{id:entry.id,targetBranch:'refs/heads/target',mode:'clean'}});
 assert.equal(review.canSwitch,true);assert.equal(review.targetBranch,'refs/heads/target');
 const pending=await ui.execute({method:'ui.workspace.git.branch.switch',params:{id:entry.id,...review,approved:true}});
 assert.equal(pending.status,'pending');assert.equal(git('symbolic-ref','HEAD'),'refs/heads/main');
 await capabilities.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:false}});
 assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'base\n');
 console.log('PASS actual Core branch review and once-only approval refuse renderer bypass and rejection');
 const latePending=await request();let lateEdit=false;const lateIndex=fs.readFileSync(path.join(root,'.git','index'));
 fs.renameSync=function(from,to){if(!lateEdit&&String(to)===path.join(stateDir,'capability','dispatches.json')){const value=JSON.parse(fs.readFileSync(from,'utf8'));if(value[latePending.requestId]?.status==='started'){lateEdit=true;fs.writeFileSync(path.join(root,'a.txt'),'late after durable intent\n');}}return renameOriginal.call(this,from,to);};
 await assert.rejects(decide(latePending),error=>error.effectStatus!=='unknown');fs.renameSync=renameOriginal;assert.ok(lateEdit);assert.equal(rows()[latePending.requestId].status,'failed-no-effect');assert.equal(nativeCalls,0);assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),lateIndex);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'late after durable intent\n');fs.writeFileSync(path.join(root,'a.txt'),'base\n');
 console.log('PASS late file edit after durable dispatch intent is exact domain failed-no-effect, with bytes/index preserved and fresh approval still required');
 const foreignPending=await request();let foreignBatch,foreignManifest;
 fs.renameSync=function(from,to){if(!foreignBatch&&String(to)===path.join(stateDir,'capability','dispatches.json')){const value=JSON.parse(fs.readFileSync(from,'utf8'));if(value[foreignPending.requestId]?.status==='started'){
  const directory=workspaceJournalDir(root);fs.mkdirSync(directory,{recursive:true});journal();foreignBatch=path.join(directory,'batch-late-foreign-import');fs.mkdirSync(foreignBatch);
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');foreignManifest=Buffer.from(JSON.stringify({schemaVersion:1,root,status:'committing',rows:[{action:'write',path:'a.txt',originalHash:sha('retained prior import\n'),stagedHash:sha('base\n'),backup:'0.preimage'}]}));fs.writeFileSync(path.join(foreignBatch,'manifest.json'),foreignManifest);fs.writeFileSync(path.join(foreignBatch,'0.preimage'),'retained prior import\n');
 } }return renameOriginal.call(this,from,to);};
 await assert.rejects(decide(foreignPending),error=>error.code==='WORKSPACE_RECOVERY_REQUIRED'&&error.effectStatus!=='unknown');fs.renameSync=renameOriginal;assert.ok(foreignBatch);assert.equal(rows()[foreignPending.requestId].status,'failed-no-effect');assert.equal(nativeCalls,0);assert.equal(workspace.describeWorkspace(entry.id),null);assert.deepEqual(fs.readFileSync(path.join(foreignBatch,'manifest.json')),foreignManifest);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'base\n');
 await workspace.collectRecoveryProof(entry.id);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'retained prior import\n');fs.writeFileSync(path.join(root,'a.txt'),'base\n');assert.ok(workspace.describeWorkspace(entry.id));
 console.log('PASS late foreign import stays blocked with bytes/evidence intact; exact new pure-admission refusal is no-effect and only original Workspace recovery restores its bytes');
 const old=git('rev-parse','HEAD'),target=git('rev-parse','refs/heads/target');let fault=false;
 childHook=(command,args)=>{if(!fault&&command==='git'&&args.includes('update-ref')&&args.includes('--stdin')){fault=true;git('update-ref','refs/heads/target',old,target);}};
 const interrupted=await request();await assert.rejects(decide(interrupted),{effectStatus:'unknown'});childHook=()=>{};assert.ok(fault);assert.equal(nativeCalls,1);assert.equal(children.size,0,'all actual Git/native children closed before recovery');
 git('update-ref','refs/heads/target',target,old);journal();const raw=inspectWorkspaceByteTransaction(root);assert.equal(raw.owner.dispatchBinding.requestId,interrupted.requestId);assert.equal(raw.owner.dispatchBinding.taskId,null);assert.equal(workspace.describeWorkspace(entry.id),null);
 const cold=createWorkspaceService({stateDir});assert.equal(cold.describeGitRecoveryWorkspace(entry.id).closedBindings.length,1);
 assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'target\n');assert.equal(git('symbolic-ref','HEAD'),'refs/heads/main');
 const manifest=path.join(journal(),raw.evidence.name,'manifest.json'),saved=fs.readFileSync(manifest);
 const unclosed=JSON.parse(saved);unclosed.gitInvocations[0].state='started';fs.writeFileSync(manifest,JSON.stringify(unclosed));
 assert.throws(()=>cold.describeGitRecoveryWorkspace(entry.id),{code:'EXECUTION_UNCONFIRMED'});fs.writeFileSync(manifest,saved);
 const rawOnly=JSON.parse(saved);delete rawOnly.gitInvocations;fs.writeFileSync(manifest,JSON.stringify(rawOnly));assert.throws(()=>cold.describeGitRecoveryWorkspace(entry.id),{code:'EXECUTION_UNCONFIRMED'});fs.writeFileSync(manifest,saved);
 // Independent copied control-state fixture: a Broker intent without a durable
 // new raw started marker may not borrow an older invocation's closure.
 const negativeState=path.join(base,'negative-control-state');fs.cpSync(stateDir,negativeState,{recursive:true});
 let negativeWorkspace=createWorkspaceService({stateDir:negativeState,nativeExecutable:process.env.CETAMESH_TEST_WORKSPACE_NATIVE});
 let negativeCaps=createCapabilityService({stateDir:negativeState,workspaceService:negativeWorkspace,now:()=>clock});
 try {
  const scoped=await fresh('finish-prepared'),negativePending=await negativeCaps.broker.execute({capability:'git.branch.switch',workspaceId:entry.id,actor:{kind:'owner',id:'desktop'},input:input(scoped)});
  const beforeIndex=fs.readFileSync(path.join(root,'.git','index'));let refusedStart=false;
  fs.renameSync=function(from,to){if(String(to)===manifest){const data=JSON.parse(fs.readFileSync(from,'utf8'));if(data.gitInvocations?.length===2&&data.gitInvocations.at(-1).state==='started'){refusedStart=true;throw Object.assign(new Error('fixture start marker persist failure'),{code:'EIO'});}}return renameOriginal.call(this,from,to);};
  await assert.rejects(negativeCaps.execute({method:'capability.approval.decide',params:{id:negativePending.approvalId,approve:true}}),{effectStatus:'unknown'});fs.renameSync=renameOriginal;assert.ok(refusedStart);assert.deepEqual(fs.readFileSync(manifest),saved);assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),beforeIndex);assert.equal(nativeCalls,1);assert.equal(git('symbolic-ref','HEAD'),'refs/heads/main');
  await negativeCaps.close();negativeWorkspace=createWorkspaceService({stateDir:negativeState});negativeCaps=createCapabilityService({stateDir:negativeState,workspaceService:negativeWorkspace,now:()=>clock});
  await assert.rejects(negativeCaps.executeWorkspace({method:'workspace.git.branch.review',params:{id:entry.id,targetBranch:'refs/heads/target',mode:'finish-prepared'}}),{code:'WORKSPACE_OPERATION_UNCONFIRMED'});
  const nested=path.join(root,'empty-overlap-fixture');fs.mkdirSync(nested);await negativeWorkspace.execute({method:'workspace.create',params:{root:nested,name:'Overlapping registration fixture'}});
  assert.throws(()=>negativeWorkspace.describeGitRecoveryWorkspace(entry.id),{code:'WORKSPACE_RECOVERY_REQUIRED'});
 } finally {fs.renameSync=renameOriginal;await negativeCaps.close();}
 console.log('PASS new invocation marker persistence failure writes no Git phase; reconstructed unmatched Broker intent cannot borrow old closed proof; overlapping registration refuses');
 fs.mkdirSync(path.join(journal(),'batch-unrelated'));await assert.rejects(fresh('finish-prepared'),{code:'WORKSPACE_RECOVERY_REQUIRED'});fs.rmdirSync(path.join(journal(),'batch-unrelated'));assert.deepEqual(fs.readFileSync(manifest),saved);
 fs.writeFileSync(path.join(root,'a.txt'),'late user bytes\n');await assert.rejects(fresh('finish-prepared'),{code:'WORKSPACE_CONFLICT'});fs.writeFileSync(path.join(root,'a.txt'),'target\n');
 const repeat=await request('finish-prepared');fault=false;
 childHook=(command,args)=>{if(!fault&&command==='git'&&args.includes('update-ref')&&args.includes('--stdin')){fault=true;
  const during=JSON.parse(fs.readFileSync(manifest,'utf8'));assert.equal(during.gitInvocations.length,2);assert.equal(during.gitInvocations[0].state,'closed');assert.equal(during.gitInvocations[1].state,'started');
  assert.throws(()=>cold.describeGitRecoveryWorkspace(entry.id),{code:'EXECUTION_UNCONFIRMED'});git('update-ref','refs/heads/target',old,target);}};
 await assert.rejects(decide(repeat),{effectStatus:'unknown'});childHook=()=>{};assert.ok(fault);assert.equal(children.size,0);git('update-ref','refs/heads/target',target,old);
 assert.equal(inspectWorkspaceByteTransaction(root).invocations.filter(row=>row.state==='closed').length,2);
 const chainSaved=fs.readFileSync(manifest),forged=JSON.parse(chainSaved);forged.gitInvocations[1].binding.fingerprint='0'.repeat(64);fs.writeFileSync(manifest,JSON.stringify(forged));await assert.rejects(fresh('finish-prepared'),{code:'WORKSPACE_RECOVERY_REQUIRED'});fs.writeFileSync(manifest,chainSaved);await reconstruct();
 // Restoring bytes in place preserves the native file node, permitting fresh review.
 const completion=await request('finish-prepared');const completed=await decide(completion);assert.equal(completed.status,'completed');assert.equal(nativeCalls,1);assert.equal(git('symbolic-ref','HEAD'),'refs/heads/target');assert.ok(workspace.describeWorkspace(entry.id));assert.deepEqual(fs.readdirSync(journal()),[]);
 const original=rows()[interrupted.requestId];assert.equal(original.status,'reconciled');assert.equal(original.historicalStatus,'outcome-unknown');assert.equal(original.completionRequestId,completion.requestId);assert.equal(rows()[completion.requestId].retainedResult.phase,'completed');
 assert.equal(rows()[repeat.requestId].status,'reconciled');assert.equal(rows()[repeat.requestId].historicalStatus,'outcome-unknown');assert.equal(rows()[repeat.requestId].completionRequestId,completion.requestId);
 await assert.rejects(capabilities.broker.execute({...capabilities.broker.approvals.get(interrupted.approvalId).request,approvalId:interrupted.approvalId}),error=>['WORKSPACE_RECOVERY_REQUIRED','APPROVAL_NOT_APPROVED','GIT_HEAD_CHANGED','REQUEST_ALREADY_DISPATCHED'].includes(error.code));
 console.log('PASS two actual HEAD CAS failures close exact bounded invocation chain; reconstructed Core fresh approval finishes without second byte publication; raw-only/latest-started/mixed/changed bytes refuse');
 // Terminal Git receipt must survive a failed durable Broker result write.
 const back=await request('clean','refs/heads/main');let persistFaults=0;
 fs.renameSync=function(from,to){if(String(to)===path.join(stateDir,'capability','dispatches.json')){const data=JSON.parse(fs.readFileSync(from,'utf8'));if(data[back.requestId]?.status==='completed'){persistFaults++;throw Object.assign(new Error('fixture durable result failure'),{code:'EIO'});}}return renameOriginal.call(this,from,to);};
 await assert.rejects(decide(back),{code:'DISPATCH_RESULT_PERSIST_FAILED',effectStatus:'unknown'});fs.renameSync=renameOriginal;assert.ok(persistFaults);assert.equal(git('symbolic-ref','HEAD'),'refs/heads/main');assert.equal(nativeCalls,2);assert.equal(inspectWorkspaceByteTransaction(root).completion.result.phase,'completed');
 await reconstruct();assert.equal(workspace.describeWorkspace(entry.id),null);const terminal=await request('finish-prepared','refs/heads/main');assert.equal((await decide(terminal)).status,'completed');assert.equal(nativeCalls,2);assert.ok(workspace.describeWorkspace(entry.id));assert.deepEqual(fs.readdirSync(journal()),[]);
 console.log('PASS Broker persistence failure retains terminal raw marker; reconstructed Core fresh approval settles exact original request without native replay');
 // Missing index can be completed only from the exact original normal index.
 const index=path.join(root,'.git','index'),before=fs.readFileSync(index);let indexFault=false;
 fs.renameSync=function(from,to){if(String(to)===index&&String(from)===index+'.lock'){indexFault=true;throw Object.assign(new Error('fixture held normal index'),{code:'EIO'});}return renameOriginal.call(this,from,to);};
 const indexPending=await request();await assert.rejects(decide(indexPending),{effectStatus:'unknown'});fs.renameSync=renameOriginal;assert.ok(indexFault);assert.deepEqual(fs.readFileSync(index),before);assert.equal(nativeCalls,3);
 const finishIndex=await request('finish-prepared');assert.equal((await decide(finishIndex)).status,'completed');assert.equal(nativeCalls,3);assert.equal(git('symbolic-ref','HEAD'),'refs/heads/target');
 console.log('PASS actual native files retained across missing normal index; approved completion rebuilds only index/HEAD and never republishes files');
 const cleanupPending=await request('clean','refs/heads/main');let cleanupFault=false;
 fs.renameSync=function(from,to){if(path.dirname(String(to))===journal()&&path.basename(String(to)).startsWith('cleanup-')){cleanupFault=true;throw Object.assign(new Error('fixture private cleanup busy'),{code:'EIO'});}return renameOriginal.call(this,from,to);};
 const cleanupResult=await decide(cleanupPending);fs.renameSync=renameOriginal;assert.ok(cleanupFault);assert.equal(cleanupResult.status,'completed');assert.equal(cleanupResult.result.cleanupPending,true);assert.equal(rows()[cleanupPending.requestId].status,'completed');assert.equal(nativeCalls,4);
 await workspace.collectRecoveryProof(entry.id);assert.ok(workspace.describeWorkspace(entry.id));assert.deepEqual(fs.readdirSync(journal()),[]);assert.equal(nativeCalls,4);
 console.log('PASS cleanup failure preserves known durable Git outcome and affirmative terminal journal transition; existing recovery retries private cleanup only');
 const wrapperPending=await request();let wrapperFault=false;
 fs.renameSync=function(from,to){if(String(to)===path.join(stateDir,'capability','operations.json')){const data=JSON.parse(fs.readFileSync(from,'utf8'));if(Object.values(data).some(row=>row.approvalId===wrapperPending.approvalId&&row.status==='completed')){wrapperFault=true;throw Object.assign(new Error('fixture wrapper persistence failure'),{code:'EIO'});}}return renameOriginal.call(this,from,to);};
 const accepted=await call('ui.approvals.decide',{id:wrapperPending.approvalId,approve:true});assert.equal(accepted.status,'accepted');
 for(let attempt=0;!wrapperFault&&attempt<1200;attempt++)await delay(25);
 assert.ok(wrapperFault);fs.renameSync=renameOriginal;await delay(20);const wrapper=await call('ui.approvals.operation',{id:accepted.operationId});assert.equal(wrapper.status,'completed');assert.equal(nativeCalls,5);assert.equal(rows()[wrapperPending.requestId].status,'completed');assert.deepEqual(fs.readdirSync(journal()),[]);
 console.log('PASS approval accepted is not completion; failed wrapper persistence reconciles from exact durable Broker receipt after journal ACK without replay');
 const stale=await request('clean','refs/heads/main');const priorBytes=fs.readFileSync(path.join(root,'a.txt'));fs.writeFileSync(path.join(root,'a.txt'),'unapproved later edit\n');await assert.rejects(decide(stale),error=>['GIT_WORKTREE_CHANGED','WORKSPACE_CONFLICT'].includes(error.code));assert.equal(nativeCalls,5);fs.writeFileSync(path.join(root,'a.txt'),priorBytes);
 const expired=await request('clean','refs/heads/main');clock+=600001;await assert.rejects(decide(expired),{code:'APPROVAL_EXPIRED'});assert.equal(nativeCalls,5);
 const pendingOther=await request('clean','refs/heads/main');await assert.rejects(fresh('clean','refs/heads/main'),{code:'WORKSPACE_APPROVAL_PENDING'});await capabilities.execute({method:'capability.approval.decide',params:{id:pendingOther.approvalId,approve:false}});
 const grantTask=tasks.runtime.create({goal:'Explicitly scoped Git task',workspaceId:entry.id});capabilities.grantTask(grantTask.id,{capabilities:['filesystem.read','git.status']});const principal=capabilities.principalForTask(grantTask.id);
 await assert.rejects(capabilities.broker.execute({capability:'git.branch.switch',workspaceId:entry.id,taskId:grantTask.id,actor:principal,input:input(await fresh('clean','refs/heads/main'))}),{code:'PERMISSION_DENIED'});
 console.log('PASS stale/expired reviews and concurrent pending approvals refuse before effects; default Task grants do not gain branch switching');
 const nativeBeforeMetadata=nativeCalls,metadataIndex=fs.readFileSync(index);
 for(const scenario of ['same-core','reconstructed-core']){
  const branch='refs/heads/alias-'+scenario;git('branch',branch.slice(11),target);let injected=false;
  const metadataPending=await request('clean',branch,scenario==='reconstructed-core'?{taskId:grantTask.id,operationId:'metadata-cold-original'}:{});
  childHook=(command,args)=>{if(!injected&&command==='git'&&args.includes('update-ref')&&args.includes('--stdin')){injected=true;git('update-ref',branch,old,target);}};
  await assert.rejects(decide(metadataPending),{effectStatus:'unknown'});childHook=()=>{};assert.ok(injected);git('update-ref',branch,target,old);assert.equal(nativeCalls,nativeBeforeMetadata);assert.deepEqual(fs.readFileSync(index),metadataIndex);assert.deepEqual(fs.readdirSync(journal()),[]);
  const metadataRow=Object.values(rows()).find(row=>row.requestId===metadataPending.requestId);assert.equal(metadataRow.gitMetadata.closed,true);
  if(scenario==='reconstructed-core'){
   const incompleteState=path.join(base,'metadata-incomplete-state');fs.cpSync(stateDir,incompleteState,{recursive:true});const file=path.join(incompleteState,'capability','dispatches.json'),snapshot=JSON.parse(fs.readFileSync(file,'utf8'));
   Object.values(snapshot).find(row=>row.requestId===metadataPending.requestId).gitMetadata.closed=false;fs.writeFileSync(file,JSON.stringify(snapshot));
   const incompleteWorkspace=createWorkspaceService({stateDir:incompleteState}),incompleteCaps=createCapabilityService({stateDir:incompleteState,workspaceService:incompleteWorkspace});
   try{await assert.rejects(incompleteCaps.executeWorkspace({method:'workspace.git.branch.review',params:{id:entry.id,targetBranch:branch,mode:'finish-prepared'}}),{code:'EXECUTION_UNCONFIRMED'});}finally{await incompleteCaps.close();}
   Object.values(snapshot).find(row=>row.requestId===metadataPending.requestId).gitMetadata.closed=true;fs.writeFileSync(file,JSON.stringify(snapshot));
   const unrelatedCaps=createCapabilityService({stateDir:incompleteState,workspaceService:incompleteWorkspace,taskRuntime:tasks.runtime});
   try{
    unrelatedCaps.broker.register({id:'fixture.same-task.unknown',provider:'fixture',permission:'git.commit',workspace:true,effect:'non-idempotent',risk:'low',execute(){throw Error('same Task unknown fixture');}});
    await assert.rejects(unrelatedCaps.broker.execute({requestId:'same-task-unrelated',capability:'fixture.same-task.unknown',taskId:grantTask.id,workspaceId:entry.id,actor:{kind:'owner',id:'desktop'},input:{}}),{effectStatus:'unknown'});
    await assert.rejects(unrelatedCaps.executeWorkspace({method:'workspace.git.branch.review',params:{id:entry.id,targetBranch:branch,mode:'finish-prepared'}}),{code:'WORKSPACE_OPERATION_UNCONFIRMED'});
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8'))['same-task-unrelated'].status,'outcome-unknown');
   }finally{await unrelatedCaps.close();}
   await reconstruct();
  }
  const metadataFinish=await request('finish-prepared',branch);assert.equal((await decide(metadataFinish)).status,'completed');assert.equal(git('symbolic-ref','HEAD'),branch);assert.deepEqual(fs.readFileSync(index),metadataIndex);assert.equal(nativeCalls,nativeBeforeMetadata);
  const reconciled=Object.values(rows()).find(row=>row.requestId===metadataPending.requestId);assert.equal(reconciled.status,'reconciled');assert.equal(reconciled.historicalStatus,'outcome-unknown');assert.equal(reconciled.completionRequestId,metadataFinish.requestId);
 }
 console.log('PASS zero-file actual HEAD CAS failures finish with same-Core/cold closed dispatch proof, exact Task/operation scope and no native file or index writes; unclosed metadata and unrelated same-Task unknown refuse');
 let live=tasks.runtime.create({goal:'Other Task retains its executor',workspaceId:entry.id});live=tasks.runtime.attachAgent({id:live.id,expectedRev:live.rev,provider:'external',sessionId:'fixture-unconfirmed'}).task;tasks.runtime.start({id:live.id,expectedRev:live.rev});
 await assert.rejects(fresh('clean','refs/heads/main'),{code:'TASK_WORKSPACE_BUSY'});assert.equal(nativeCalls,nativeBeforeMetadata);
 console.log('PASS another Task execution owner blocks ordinary Git admission without modifying Task or source');
 capabilities.broker.register({id:'fixture.git.unrelated',provider:'fixture',permission:'git.commit',effect:'non-idempotent',workspace:true,risk:'low',execute(){throw Error('unrelated fixture uncertainty');}});
 await assert.rejects(capabilities.broker.execute({requestId:'unrelated-no-task',capability:'fixture.git.unrelated',workspaceId:entry.id,actor:{kind:'owner',id:'owner'},input:{}}),{effectStatus:'unknown'});
 await assert.rejects(fresh('clean','refs/heads/main'),{code:'WORKSPACE_OPERATION_UNCONFIRMED'});assert.equal(rows()['unrelated-no-task'].status,'outcome-unknown');assert.equal(nativeCalls,5);
 console.log('PASS unrelated Owner no-Task unknown dispatch remains fenced and unreconciled');
}finally{
 fs.renameSync=renameOriginal;fs.rmSync=rmOriginal;childHook=()=>{};await capabilities?.close();await Promise.allSettled([...children]);childProcess.execFile=execOriginal;syncBuiltinESMExports();
 for(const resource of retainedResources){if(!fs.existsSync(resource.path))continue;const stat=fs.lstatSync(resource.path,{bigint:true});assert.equal(path.dirname(resource.path),parent);assert.equal(fs.realpathSync.native(resource.path),resource.path);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.dev===resource.node.dev&&stat.ino===resource.node.ino);rmOriginal(resource.path,{recursive:true,force:true});}
 if(ownedJournal&&fs.existsSync(ownedJournal.dir)){const st=fs.lstatSync(ownedJournal.dir,{bigint:true});assert.equal(fs.realpathSync.native(ownedJournal.dir),ownedJournal.dir);assert.ok(st.isDirectory()&&!st.isSymbolicLink()&&st.dev===ownedJournal.node.dev&&st.ino===ownedJournal.node.ino);fs.rmSync(ownedJournal.dir,{recursive:true,force:true});}
 const current=fs.lstatSync(base,{bigint:true});assert.equal(path.dirname(base),parent);assert.equal(fs.realpathSync.native(base),base);assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===owned.dev&&current.ino===owned.ino);fs.rmSync(base,{recursive:true,force:true});
}
}
const selected=process.env.CETAMESH_TEST_GIT_BRANCH_CASE;
const fixCases=['cleanup','metadata-proof','metadata-proof-owner'];
const uiCases=['metadata-ui','metadata-ui-owner'];
assert.ok(!selected||selected==='fix1'||selected==='fix2'||[...fixCases,...uiCases].includes(selected),'Unknown focused Git branch case');
for(const scenario of selected==='fix1'?fixCases:selected==='fix2'?uiCases:selected?[selected]:[...fixCases,...uiCases,'existing'])await runFixture(scenario);
