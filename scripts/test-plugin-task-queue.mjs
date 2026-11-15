import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import contract from '../src/agentos/managed-v1.json' with {type:'json'};
import {createCetaMeshServices} from '../src/app/service-container.js';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-plugin-queue-')));
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:root,sourceRoot:root,resourceRoot:root,deferOptionalStart:true});
const ui=(method,params={})=>services.desktopUiService.execute({method,params});
let calls=0;
try {
 const project=path.join(root,'project');fs.mkdirSync(project);
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Queued plugin Task'}})).workspace;
 const input={goal:'Prepare plugin access before execution',workspaceId:workspace.id,agentProvider:'cetamesh',deferStart:true,
  collaboration:{enabled:false,allowUnknownCost:false,prepareNative:false},requestId:'queued-plugin-create'};
 const task=(await ui('ui.task.create',input)).task;
 assert.equal(task.status,'queued');assert.equal(task.currentAgent,null);
 assert.equal(services.taskService.runtime.activeWorkspaceOwner({workspaceId:workspace.id}),null);
 assert.throws(()=>services.capabilityService.principalForTask(task.id),{code:'TASK_NOT_AUTHORIZED'});
 assert.equal((await ui('ui.task.create',input)).task.id,task.id,'retry must return the same saved Task without dispatch');
 await assert.rejects(ui('ui.task.create',{...input,deferStart:false}),{code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(ui('ui.task.create',{...input,requestId:'bad-queue',deferStart:'yes'}),{code:'INVALID_TASK_START_MODE'});
 await assert.rejects(ui('ui.task.create',{...input,requestId:'premature-policy',collaboration:{enabled:true,allowUnknownCost:false,prepareNative:true}}),{code:'TASK_DEFERRED_COLLABORATION'});
 const runtime=path.join(root,'runtime');
 for(const dir of ['server/managed','contracts','catalog'])fs.mkdirSync(path.join(runtime,dir),{recursive:true});
 for(const [name,value] of [['agentos.system.json',{id:'org.cetamesh.agentos',version:'2.0.0',managed:{protocol:'cetamesh.agentos.managed.v1',entry:'server/managed/stdio.mjs'}}],['package.json',{type:'module'}],['contracts/agentos-managed-v1.json',contract],['catalog/images.json',{}]])fs.writeFileSync(path.join(runtime,name),JSON.stringify(value));
 fs.writeFileSync(path.join(runtime,'server/managed/stdio.mjs'),'throw Error("queue test must never launch this engine");');
 const checked=await ui('ui.plugins.engines.review',{id:'agentos',root:runtime,nodePath:process.execPath});
 await ui('ui.plugins.engines.enable',{id:'agentos',token:checked.token});
 await ui('ui.plugins.engines.authorize-task',{id:'agentos',taskId:task.id,expectedRev:task.rev});
 const principal=services.capabilityService.principalForTask(task.id);
 assert.ok(principal.grants.capabilities.includes('agentos.call'));
 assert.deepEqual(principal.grants.taskIds,[task.id]);assert.deepEqual(principal.grants.workspaceIds,[workspace.id]);
 services.modelRegistry.register({id:'plugin-queue-fixture',label:'Local fixture only',supportsTools:true,defaultModel:'fixture',
  health:async()=>({}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('stream only');},
  stream:async function*(){calls++;yield{type:'assistant/message',data:{message:{content:[{type:'text',text:'Queue flow complete'}]}}};yield{type:'turn/end',data:{reason:{kind:'completed'}}};}});
 services.providerSecrets.set({provider:'plugin-queue-fixture',apiKey:'synthetic-only'});
 await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'auto'}}});
 await services.settingsService.execute({method:'settings.update',params:{section:'models',values:{provider:'plugin-queue-fixture',defaultModel:'fixture'}}});
 const started=(await ui('ui.task.start',{id:task.id,expectedRev:task.rev,agentProvider:'cetamesh'})).task;
 assert.equal(started.id,task.id);assert.equal(started.currentAgent.provider,'cetamesh');
 for(let i=0;i<200&&calls===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls,1);
 assert.ok(services.capabilityService.principalForTask(task.id).grants.capabilities.includes('agentos.call'),'normal start preserves the exact plugin grant');
 await assert.rejects(ui('ui.plugins.engines.authorize-task',{id:'agentos',taskId:task.id,expectedRev:started.rev}),{code:'TASK_GRANT_NOT_IDLE'});
 console.log('PASS queued creation → exact plugin authorization → existing start; idempotency, no pre-start execution, no premature policy, running Task refusal');
} finally {
 for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','localEngineService','capabilityService','extensionService'])await services[name]?.close();
 fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
