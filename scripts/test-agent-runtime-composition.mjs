import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createChatService } from '../src/desktop/chat-service.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-agent-composition-'));
let services;
try {
 const stateDir=path.join(root,'state'),dataRoot=path.join(root,'data');
 services=createCetaMeshServices({stateDir,dataRoot});
 // Use actual cold production descriptors, before any health refresh or setup.
 const coldDescriptors=services.agentService.listProviders();
 const project=path.join(root,'cold-chat-workspace');fs.mkdirSync(project);
 const waitStatus=async(chat,id,predicate)=>{for(let i=0;i<200;i++){const value=await chat.execute({method:'chat.status',params:{id}});if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Cold Chat route did not settle');};
 for(const provider of ['opencode','qwen','gemini','claude']) {
   const cold=coldDescriptors.find(item=>item.id===provider);
   assert.equal(cold.workspaceBoundary,'unsupported','cold readiness remains unavailable rather than fabricated');
   let configured=false,ownerConfirmed=false,routeCalls=0;
   const calls=[];
   const chat=createChatService({stateDir:path.join(root,'cold-chat-'+provider),defaults:{},agentProviders:[cold],
     resolveWorkspace:id=>({id,root:project}),
     agentExecute:async request=>{calls.push(request);if(request.method==='agent.list')return {providers:[{...cold,available:configured}]};
       if(request.method==='agent.createSession')throw Object.assign(Error('Native coding runtime needs a Task'),{code:'TASK_REQUIRED'});
       return {cancelled:true};},
     platformRoute:async request=>{routeCalls++;assert.equal(request.record.config.agentProvider,provider);
       if(!ownerConfirmed)throw Object.assign(Error('Owner must review native execution scope'),{code:'AGENT_SECURITY_CONFIRMATION_REQUIRED'});
       return {kind:'agent',provider,taskId:'cold-task-'+provider,sessionId:'cold-native-'+provider,accepted:true,turnId:'cold-turn'};},
     agentFollow:async function*({signal}){await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});}
   });
   try {
     const session=await chat.execute({method:'chat.sessions.create',params:{}});
     await chat.execute({method:'chat.config.set',params:{id:session.id,config:{agentProvider:provider,workspaceId:'cold-workspace'}}});
     configured=true;
     await chat.execute({method:'chat.send',params:{id:session.id,text:'Synthetic cold-to-configured Agent request'}});
     const denied=await waitStatus(chat,session.id,value=>value.lastState==='error');
     assert.equal(denied.lastErrorCode,'AGENT_SECURITY_CONFIRMATION_REQUIRED',provider+' must reach platform consent instead of unbound direct Session creation');
     assert.equal(routeCalls,1);assert.equal(calls.some(call=>call.method==='agent.createSession'),false);
     const catalog=await chat.execute({method:'chat.catalog',params:{}});
     const row=catalog.agentProviders.find(item=>item.id===provider);
     assert.equal(row.available,true);assert.equal(row.requiresTask,true,provider+' catalog preserves its structural Task contract');assert.equal(row.eligible,false);
     ownerConfirmed=true;
     await chat.execute({method:'chat.send',params:{id:session.id,text:'Continue through the Owner-confirmed platform Task route'}});
     const active=await waitStatus(chat,session.id,value=>value.turn?.state==='streaming');
     assert.equal(active.taskId,'cold-task-'+provider);assert.equal(routeCalls,2);
     await chat.execute({method:'chat.sessions.delete',params:{id:session.id}});
     assert.equal(calls.filter(call=>call.method==='agent.cancel').length,1,'deleting Chat may request cancel');
     assert.equal(calls.some(call=>call.method==='agent.closeSession'),false,'Chat cannot close the Task-owned native Session');
     assert.equal(calls.some(call=>call.method==='agent.createSession'),false);
     assert.equal(cold.requiresTask,true,'actual startup descriptor carries an immutable Task requirement');
   } finally {await chat.close();}
 }
 console.log('PASS actual cold Agent descriptors preserve platform Task routing, consent, catalog and Task-owned Session cleanup after setup');
 const fixtureKey='fixture-not-a-real-provider-credential';
 for(const provider of ['gemini','opencode','qwen','claude']) {
  await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:provider}}});
  assert.equal(services.settingsService.store.get().settings.agents.defaultAgentProvider,provider,'each connected provider is a valid saved default');
 }
 const result=await services.desktopUiService.execute({method:'ui.agent.configure',params:{provider:'opencode',config:{runtimePath:path.join(root,'absent-runtime.exe'),model:'fixture-model',apiKey:fixtureKey,baseUrl:'https://api.example.invalid/v1'}}});
 assert.equal(result.supported,true);assert.equal(result.configuration.model,'fixture-model');
 assert.equal(result.configuration.credentialConfigured,true);
 assert.equal(JSON.stringify(result).includes(fixtureKey),false);
 const health=await services.agentService.execute({method:'agent.health',params:{provider:'opencode',refresh:true}});
 assert.equal(health.runtimeConfiguration.model,'fixture-model');
 assert.equal(health.runtimeConfiguration.executionMode,'native-permissions');
 assert.equal(health.available,false,'a missing actual runtime never becomes ready from saved settings');
 assert.equal(JSON.stringify(health).includes(fixtureKey),false);
 const stored=fs.readFileSync(path.join(stateDir,'agent-runtimes.json'),'utf8');
 assert.equal(stored.includes(fixtureKey),false);
 assert.equal(typeof services.capabilityService.requestAgentNativeApproval,'function');
 assert.equal(services.capabilityService.broker.registry.require('agent.native.approve').modelCallable,false);
 const corruptState=path.join(root,'corrupt-state');fs.mkdirSync(corruptState);fs.writeFileSync(path.join(corruptState,'agent-runtimes.json'),'{broken');
 const unaffected=createCetaMeshServices({stateDir:corruptState,dataRoot:path.join(root,'corrupt-data')});
 try {
   const rows=await unaffected.agentService.execute({method:'agent.list'});
   const list=Array.isArray(rows)?rows:rows.providers;
   for(const provider of ['gemini','opencode','qwen','claude']) {
     const row=list.find(item=>item.id===provider);assert.equal(row.available,false,provider+' corrupt optional configuration must fail closed');
     assert.match(row.reason,/agent_runtime_config_corrupt/i,provider+' startup must preserve a useful configuration error');
   }
   assert.equal(fs.readFileSync(path.join(corruptState,'agent-runtimes.json'),'utf8'),'{broken','malformed configuration is preserved for recovery');
 } finally {await unaffected.capabilityService.close();await unaffected.agentService.close();}
 for(const provider of ['gemini','opencode','qwen','claude']) {
   const description=await services.desktopUiService.execute({method:'ui.agent.auth.describe',params:{provider}});
   assert.equal(description.methods.some(method=>method.id!=='api-key'&&method.supported),false);
   assert.doesNotMatch(JSON.stringify(description),/apiKey|accessToken|refreshToken|credential value/);
 }
 await assert.rejects(services.desktopUiService.execute({method:'ui.agent.auth.start',params:{provider:'gemini',expectedRevision:0,methodId:'oauth-personal',env:{HOME:'unowned'}}}),{code:'INVALID_PARAMS'});
 await services.agentService.execute({method:'agent.configure',params:{provider:'claude',settings:{authMode:'provider-login'}}});
 await assert.rejects(services.agentService.execute({method:'agent.auth.start',params:{provider:'claude',expectedRevision:1,methodId:'claude-subscription'}}),{code:'AGENT_AUTH_UNSUPPORTED'});
 assert.equal((await services.agentService.execute({method:'agent.health',params:{provider:'claude'}})).available,false);
 console.log('PASS production setup reaches owned runtime configuration and credential vault without enabling missing runtimes or returning secrets');
} finally {
 if(services){await services.capabilityService.close();await services.agentService.close();}
 fs.rmSync(root,{recursive:true,force:true});
}
