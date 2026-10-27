import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCetaMeshServices} from '../src/app/service-container.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'m6b-task-model-'));
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:root,sourceRoot:root,resourceRoot:root});
const calls=[];
const provider='m6b-model-fixture';
services.modelRegistry.register({id:provider,label:'Fixture without intrinsic default',supportsTools:true,
 listModels:async()=>[{id:'chosen-a'},{id:'chosen-b'}],health:async()=>({}),
 chat:async request=>{calls.push(request.model);return{text:'synthetic task result'};},
 stream:async function*(request){calls.push(request.model);yield{type:'assistant/chunk',data:{chunk:{type:'text-delta',text:'synthetic task result'}}};yield{type:'turn/end',data:{reason:{kind:'completed'}}};}});
services.providerSecrets.set({provider,apiKey:'synthetic-loopback-only'});
const ui=(method,params)=>services.desktopUiService.execute({method,params});
async function defaults(model){await services.settingsService.execute({method:'settings.update',params:{section:'models',values:{provider,defaultModel:model}}});}
async function finished(id){for(let i=0;i<200;i++){const t=services.taskService.runtime.get({id}).task;if(t.checkpoint?.summary?.includes('synthetic task result')||['failed','blocked'].includes(t.status))return t;await new Promise(r=>setTimeout(r,10));}throw Error('fixture Agent result did not reach Task checkpoint');}
try{
 const workspaceRoot=path.join(root,'workspace');fs.mkdirSync(workspaceRoot);
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{name:'fixture',root:workspaceRoot}})).workspace;
 await defaults('chosen-a');
 const created=(await ui('ui.task.create',{goal:'Use the Owner-selected default model',workspaceId:workspace.id})).task;
 let task=await finished(created.id);
 assert.match(task.checkpoint?.summary??'',/synthetic task result/,`Work must use the configured model, not block with ${task.progress?.note}`);
 assert.equal(task.modelConfig.modelProvider,provider);assert.equal(task.modelConfig.model,'chosen-a');
 await ui('ui.task.cancel',{id:task.id,expectedRev:task.rev});
 await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'dsh'}}});
 const countBeforePreference=services.taskService.runtime.countAll();
 await assert.rejects(ui('ui.task.create',{goal:'Respect unavailable preferred executor',workspaceId:workspace.id}),
  error=>['PROVIDER_UNAVAILABLE','AGENT_BOUNDARY_UNSUPPORTED'].includes(error.code));
 assert.equal(services.taskService.runtime.countAll(),countBeforePreference,'an unavailable Owner preference must not silently fall back or leave a Task');
 await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'auto'}}});
 const savedHealth=services.agentBroker.health,savedCapabilities=services.agentBroker.capabilities,savedConsent=services.agentBroker.assertExecutionConsent;
 services.agentBroker.health=async()=>({available:true,installed:true,authenticated:true,sessionCapable:true,taskEligible:true,sandboxCapable:true});
 services.agentBroker.capabilities=()=>({workspaceBoundary:'native-staged'});
 services.agentBroker.assertExecutionConsent=()=>{throw Object.assign(new Error('scope review required'),{code:'AGENT_SECURITY_CONFIRMATION_REQUIRED'});};
 await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'codex'}}});
 try {
  await assert.rejects(ui('ui.task.create',{goal:'Require native consent before creating Task',workspaceId:workspace.id}),{code:'AGENT_SECURITY_CONFIRMATION_REQUIRED'});
  assert.equal(services.taskService.runtime.countAll(),countBeforePreference,'missing native consent must not create an incomplete Task');
 } finally {
  services.agentBroker.health=savedHealth;services.agentBroker.capabilities=savedCapabilities;services.agentBroker.assertExecutionConsent=savedConsent;
  await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'auto'}}});
 }
 await defaults('chosen-b');
 const queued=services.taskService.runtime.create({goal:'Keep this Task model pinned',workspaceId:workspace.id,requestedAgentProvider:'cetamesh'});
 const pinned=services.taskService.runtime.setModelConfig({id:queued.id,expectedRev:queued.rev,modelProvider:provider,model:'chosen-a'});
 await ui('ui.task.start',{id:pinned.id,expectedRev:pinned.rev,agentProvider:'cetamesh'});
 task=await finished(pinned.id);assert.match(task.checkpoint?.summary??'',/synthetic task result/);assert.equal(task.modelConfig.model,'chosen-a','changed global default must not override a persisted Task model');
 await ui('ui.task.cancel',{id:task.id,expectedRev:task.rev});
 const explicit=(await ui('ui.task.create',{goal:'Use explicit per-task model',workspaceId:workspace.id,agentProvider:'cetamesh',modelProvider:provider,model:'chosen-explicit'})).task;
 task=await finished(explicit.id);assert.match(task.checkpoint?.summary??'',/synthetic task result/);assert.equal(task.modelConfig.model,'chosen-explicit');
 assert.deepEqual(calls,['chosen-a','chosen-a','chosen-explicit']);
 console.log('PASS production Work defaults without provider intrinsic model; persisted and explicit models remain pinned');
}finally{
 await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.pluginCenterService.close();await services.extensionService.close();await services.channelService.close();await services.bionicService.close();
 if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('m6b-task-model-'))throw Error('fixture cleanup boundary');
 fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
