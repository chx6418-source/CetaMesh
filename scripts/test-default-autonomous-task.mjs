import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {createCetaMeshServices} from '../src/app/service-container.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-default-task-'));
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:root,resourceRoot:root,sourceRoot:root});
const provider='default-launch-fixture';let calls=0;
services.modelRegistry.register({id:provider,label:'Local fixture',supportsTools:true,defaultModel:'fixture',health:async()=>({}),listModels:async()=>[{id:'fixture'}],chat:async()=>({text:'fixture'}),
 stream:async function*(){calls++;yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Local fixture result'}]}}};yield {type:'turn/end',data:{reason:{kind:'completed'}}};}});
services.providerSecrets.set({provider,apiKey:'synthetic-local-only'});
const ui=(method,params)=>services.desktopUiService.execute({method,params});
const rt=services.taskService.runtime;
async function stop(id){let row;for(let i=0;i<200;i++){row=rt.get({id}).task;if(row.executionObservation?.state==='awaiting-review')break;await new Promise(r=>setTimeout(r,10));}await ui('ui.task.cancel',{id,expectedRev:row.rev});}
try{
 const project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'math.mjs'),'export const sum=(a,b)=>a-b;');
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({private:true,scripts:{test:'node verify.mjs'}}));fs.writeFileSync(path.join(project,'verify.mjs'),'console.log("fixture");');
 for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','baseline']])execFileSync('git',args,{stdio:'ignore'});
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Fixture'}})).workspace;
 await services.settingsService.execute({method:'settings.update',params:{section:'models',values:{provider,defaultModel:'fixture'}}});
 const input={goal:'Fix the project test with bounded cooperation',workspaceId:workspace.id,requestId:'default-ui-launch',collaboration:{enabled:true,allowUnknownCost:true,prepareNative:true,verification:{editablePaths:['math.mjs'],testFiles:['verify.mjs']}}};
 let releaseSetup,reachedSetup;const setupGate=new Promise(resolve=>{releaseSetup=resolve;}),setupEntered=new Promise(resolve=>{reachedSetup=resolve;});
 const executeCapability=services.capabilityService.execute;let held=false;
 services.capabilityService.execute=async function(command,...args){if(command.method==='capability.operation.prepare'&&!held){held=true;reachedSetup();await setupGate;}return executeCapability.call(this,command,...args);};
 const creating=ui('ui.task.create',input);await setupEntered;const joining=ui('ui.task.create',input);joining.catch(()=>{});releaseSetup();
 const dto=(await creating).task;assert.equal((await joining).task.id,dto.id,'a duplicate joins setup and dispatch while the first launch is still preparing');services.capabilityService.execute=executeCapability;let row=rt.get({id:dto.id}).task;
 assert.equal(row.delegationPolicy?.allowUnknownCost,true,'ordinary UI must issue the explicitly requested bounded policy');
 assert.equal(row.delegationPolicy?.prepareNative,true);assert.equal(row.modelConfig.modelProvider,provider);
 assert.deepEqual(row.delegationPolicy.verification.allowedPaths,['math.mjs']);assert.equal(row.acceptance.length,1);
 const prepared=services.capabilityService.broker.operationRecordForTask({taskId:row.id,workspaceId:workspace.id,operationId:row.delegationPolicy.verification.operationId});assert.ok(prepared,'Core prepares a durable test identity');
 assert.deepEqual((await ui('ui.task.create',input)).task.id,row.id);
 await assert.rejects(ui('ui.task.create',{...input,collaboration:{...input.collaboration,allowUnknownCost:false}}),{code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(ui('ui.task.create',{...input,requestId:'other-click',collaboration:{...input.collaboration,allowUnknownCost:false}}),{code:'TASK_LAUNCH_CONFLICT'});
 await stop(row.id);
 const count=rt.countAll();
 await assert.rejects(ui('ui.task.create',{...input,requestId:'bad-path',goal:'bad path',collaboration:{...input.collaboration,verification:{editablePaths:['../outside'],testFiles:['verify.mjs']}}}),{code:'INVALID_DELEGATION_VERIFICATION'});assert.equal(rt.countAll(),count);
 await assert.rejects(ui('ui.task.create',{...input,requestId:'bad-native',goal:'bad native',collaboration:{enabled:true,allowUnknownCost:true,prepareNative:'yes'}}),{code:'INVALID_TASK_COLLABORATION'});
 const simple=(await ui('ui.task.create',{goal:'A simple local analysis needs no external Agent',workspaceId:workspace.id,requestId:'simple',collaboration:{enabled:true,allowUnknownCost:false,prepareNative:true}})).task;
 row=rt.get({id:simple.id}).task;assert.equal(row.currentAgent.provider,'cetamesh');assert.equal(row.delegationPolicy.allowUnknownCost,false);assert.equal(row.delegationPolicy.verification,undefined);
 assert.equal(row.delegationProposal??null,null);await stop(row.id);assert.equal(calls,2);
 // L2 future authorization must be derived from a pending trusted request, never renderer parameters.
 const grantTask=rt.create({goal:'Exact future grant through product approval',workspaceId:workspace.id});services.capabilityService.grantTask(grantTask.id,{capabilities:['filesystem.write']});
 fs.writeFileSync(path.join(project,'same.txt'),'same');
 const write={actor:services.capabilityService.principalForTask(grantTask.id),taskId:grantTask.id,workspaceId:workspace.id,capability:'filesystem.write',input:{path:'same.txt',content:'same',expectedHash:(await import('node:crypto')).createHash('sha256').update('same').digest('hex')},operationId:'grant-first',requestId:'grant-first'};
 const pending=await services.capabilityService.broker.execute(write);assert.equal(pending.status,'pending');
 const finite=await services.capabilityService.execute({method:'capability.grant.fromApproval',params:{approvalId:pending.approvalId,ttlMs:60000,maxUses:2}});
 const duplicateFinite=await services.capabilityService.execute({method:'capability.grant.fromApproval',params:{approvalId:pending.approvalId,ttlMs:60000,maxUses:2}});assert.equal(duplicateFinite.id,finite.id,'duplicate approval clicks must not mint multiple grants');
 assert.deepEqual(finite.resources,['same.txt']);assert.equal(finite.status,'pending','future authority activates only with actual one-shot approval consumption');assert.equal(finite.uses,0);
 await services.capabilityService.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:true}});
 assert.equal((await services.capabilityService.broker.execute({...write,operationId:'grant-next',requestId:'grant-next'})).status,'completed');
 const list=await ui('ui.approvals.list',{});assert.equal(list.grants.find(row=>row.id===finite.id).uses,1);
 assert.equal((await services.capabilityService.broker.execute({...write,operationId:'different-resource',requestId:'different-resource',input:{path:'other.txt',content:'same'}})).status,'pending');
 await ui('ui.approvals.grant.revoke',{id:finite.id});assert.equal((await services.capabilityService.broker.execute({...write,operationId:'after-revoke',requestId:'after-revoke'})).status,'pending');
 await assert.rejects(services.capabilityService.execute({method:'capability.grant.fromApproval',params:{approvalId:pending.approvalId,ttlMs:60000,maxUses:2}}),{code:'APPROVAL_ALREADY_DECIDED'});
 const raced=await services.capabilityService.broker.execute({...write,operationId:'grant-race',requestId:'grant-race'});
 const issuing=services.capabilityService.execute({method:'capability.grant.fromApproval',params:{approvalId:raced.approvalId,ttlMs:60000,maxUses:2}});
 services.capabilityService.broker.approvals.decide(raced.approvalId,false,{kind:'owner',id:'desktop'});
 await assert.rejects(issuing,{code:'APPROVAL_ALREADY_DECIDED'});
 assert.equal((await services.capabilityService.execute({method:'capability.grant.list'})).grants.filter(row=>row.sourceApprovalId===raced.approvalId&&row.status==='active').length,0,'rejected source cannot race into active future authority');
 console.log('PASS L2 product approval derives exact future scope, counts separately, rejects changed resource and supports revoke');
 console.log('PASS ordinary Task creation: bound model/policy, exact machine contract, durable operation, authority replay conflict, simple local flow');
}finally{
 await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();
 assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('cm-default-task-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
