import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';
import {createDesktopUiService,createDesktopUiEventBus} from '../src/desktop/ui-service.js';
import {projectChatContext,projectModelCapabilities} from '../src/desktop/chat-telemetry.js';
import {createToolExecutionCoordinator} from '../src/model/tool-execution.js';
import {createManagedAgentProvider} from '../src/agent/managed-agent-provider.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-chat-panels-'));
const snapshot={schemaVersion:1,providerId:'fixture',model:'model-a',at:Date.now(),status:'estimated',inputTokens:123,windowTokens:1000,reservedOutputTokens:100,capacityStatus:'declared',source:'fixture-profile',version:'v1',estimator:'utf8-conservative-v1',composition:{messages:{tokens:30,status:'estimated'},system:{tokens:40,status:'estimated'},tools:{tokens:20,status:'estimated'},other:{tokens:33,status:'estimated'}},prompt:'secret-context-must-not-cross',projection:{status:'observed',compacted:false,compactionCount:0,truncated:false,bytes:80,maxBytes:512000}};
const bus=createDesktopUiEventBus();bus.publish('chat.streaming',{sessionId:'fixture-session',context:snapshot,toolActivity:[{id:'call',capability:'test.run',status:'running',filePath:'verify.mjs',exitCode:0,rawSecret:'must-not-cross'}]});
const event=(await bus.next({waitMs:0})).events[0];assert.equal(event.data.context.inputTokens,123);assert.ok(!JSON.stringify(event).includes('secret-context-must-not-cross'));assert.ok(!JSON.stringify(event).includes('must-not-cross'));assert.equal(event.data.toolActivity[0].capability,'test.run');
assert.equal(projectChatContext({...snapshot,status:'unknown',inputTokens:0}).inputTokens,null);
assert.equal(projectModelCapabilities({reasoning:{levels:['max'],status:'unknown'}}).reasoning.levels.length,0);
let reasoning;
const runtime={defaultProviderId:()=> 'fixture',isRegistered:id=>id==='fixture',resolveProvider:()=>({id:'fixture'}),supportsToolCalling:()=>false,
 listProviders:()=>[{id:'fixture',label:'Fixture',hasKey:true}],
 modelCapabilities:()=>({vision:{supported:null,status:'unknown',source:null},tools:{supported:false,status:'unsupported',source:'fixture'},reasoning:{levels:['off','low'],status:'declared',source:'fixture'},context:{status:'declared',contextWindowTokens:1000,maxOutputTokens:100,defaultOutputTokens:100,source:'fixture',version:'v1'}}),
 listModels:async()=>({models:[{id:'model-a',label:'A',capabilities:runtime.modelCapabilities()}],error:null}),
 async *stream(request){reasoning=request.reasoning;request.onContext?.(snapshot);yield {type:'turn/start',data:{}};yield {type:'assistant/chunk',data:{chunk:{type:'text-delta',text:'actual fixture event'}}};yield {type:'turn/end',data:{reason:{kind:'completed'},usage:{inputTokens:7,outputTokens:2,totalTokens:9},resolvedModel:'model-a'}};}
};
let chat=createChatService({stateDir:root,modelRuntime:runtime,defaults:{model:'model-a'}});
let ui=createDesktopUiService({services:{chatService:chat}});
try{
 const session=await ui.execute({method:'ui.chat.sessions.create',params:{}});
 await ui.execute({method:'ui.chat.config.set',params:{id:session.id,config:{modelProvider:'fixture',model:'model-a',reasoning:'low'}}});
 assert.equal((await ui.execute({method:'ui.chat.sessions.list',params:{}})).sessions[0].config.reasoning,'low');
 await ui.execute({method:'ui.chat.send',params:{id:session.id,text:'synthetic request'}});
 for(let i=0;i<100&&(await chat.execute({method:'chat.status',params:{id:session.id}})).turn;i++)await new Promise(r=>setTimeout(r,5));
 let status=await ui.execute({method:'ui.chat.status',params:{id:session.id}});
 assert.equal(reasoning,'low');assert.equal(status.context.inputTokens,123,'request snapshot, never cumulative usage');assert.equal(status.context.phase,'last-request');
 assert.equal(status.turnUsage.inputTokens,7);assert.equal(status.quota.status,'unknown');
 assert.ok(!JSON.stringify(status).includes('secret-context-must-not-cross'));
 const catalog=await ui.execute({method:'ui.chat.catalog',params:{}});assert.deepEqual(catalog.modelProviders[0].models[0].capabilities.reasoning.levels,['off','low']);
 await assert.rejects(ui.execute({method:'ui.chat.config.set',params:{id:session.id,config:{reasoning:'high'}}}),{code:'MODEL_REASONING_UNSUPPORTED'});
 chat.close();chat=createChatService({stateDir:root,modelRuntime:runtime,defaults:{model:'model-a'}});ui=createDesktopUiService({services:{chatService:chat}});
 status=await ui.execute({method:'ui.chat.status',params:{id:session.id}});assert.equal(status.context.inputTokens,123,'bounded numeric last-request context survives restart');
 await ui.execute({method:'ui.chat.config.set',params:{id:session.id,config:{model:'model-b',reasoning:'off'}}});
 assert.equal((await ui.execute({method:'ui.chat.status',params:{id:session.id}})).context,null,'old snapshot must not inherit the new model window');
 let releaseStream;const streamGate=new Promise(resolve=>{releaseStream=resolve;});
 const activeChat=createChatService({stateDir:path.join(root,'active-stream'),modelRuntime:{...runtime,supportsToolCalling:()=>true},defaults:{model:'model-a'},toolExecutionCoordinator:{
  run:async request=>{request.onTextDelta('visible streamed text');await streamGate;return {status:'completed',text:'visible streamed text'};},cancelSession:()=>({cancelled:0})}});
 try{const active=await activeChat.execute({method:'chat.sessions.create',params:{}});
  await activeChat.execute({method:'chat.send',params:{id:active.id,text:'synthetic stream phase'}});
  assert.equal((await activeChat.execute({method:'chat.status',params:{id:active.id}})).turn.state,'streaming','first public text delta must advance starting to streaming');
 }finally{releaseStream();await new Promise(r=>setTimeout(r,0));activeChat.close();}
 console.log('PASS context attribution, numeric redaction, reasoning wire selection, unsupported level refusal, quota unknown, persistence and model change invalidation');
 const unresolved=createChatService({stateDir:path.join(root,'unknown'),modelRuntime:runtime,defaults:{model:'model-a'},toolExecutionCoordinator:{recoveryForSession:()=>({state:'needs-reconciliation'}),cancelSession:()=>({cancelled:0})}});
 try{const pending=await unresolved.execute({method:'chat.sessions.create',params:{}});
  await assert.rejects(unresolved.execute({method:'chat.config.set',params:{id:pending.id,config:{model:'model-b'}}}),{code:'CONFIG_RECONCILIATION_REQUIRED'});
 }finally{unresolved.close();}
 // A Managed Agent tool journal belongs to the provider Session and Task, not the Chat UUID.
 // The real coordinator and Managed provider observe an unknown Broker result; no external effect runs.
 const managedState=path.join(root,'managed-unknown');let brokerCalls=0;
 const principal={taskId:'managed-task',workspaceId:'managed-workspace',actor:{kind:'agent',id:'managed-fixture',
  grants:{taskIds:['managed-task'],workspaceIds:['managed-workspace'],capabilities:['fixture.write']}}};
 const managedModel={supportsToolCalling:()=>true,chat:async()=>({text:'',toolCalls:[{id:'unknown-write',capabilityId:'fixture.write',arguments:'{}'}]})};
 const coordinator=createToolExecutionCoordinator({stateDir:managedState,modelRuntime:managedModel,
  capabilityBroker:{execute:async()=>{brokerCalls++;return {status:'outcome-unknown',error:{code:'OUTCOME_UNKNOWN'}};}}});
 const managed=createManagedAgentProvider({modelRuntime:managedModel,toolExecutionCoordinator:coordinator,
  taskPrincipalResolver:()=>principal,buildProductTurnContext:()=>({context:'fixture context',
   manifest:[{id:'fixture.write',description:'Fixture effect whose result cannot be confirmed',permission:'filesystem.write',inputSchema:{type:'object'}}]})});
 const bound=await managed.provider.createSession({model:'model-a',modelProvider:'fixture'});
 const managedTask={id:principal.taskId,status:'running',currentAgent:{provider:'cetamesh',sessionId:bound.sessionId},
  executionObservation:{state:'failed',provider:'cetamesh',sessionId:bound.sessionId}};
 const managedChat=createChatService({stateDir:managedState,modelRuntime:runtime,defaults:{model:'model-a'},
  defaultAgentProvider:()=> 'cetamesh',agentProviders:[{id:'cetamesh',eventProtocol:'dsh-session-events',requiresTask:true}],
  toolExecutionCoordinator:coordinator,resolveTask:async()=>managedTask,
  platformRoute:async({text})=>{const accepted=await managed.provider.send({sessionId:bound.sessionId,content:text});
   return {kind:'agent',accepted:true,provider:'cetamesh',sessionId:bound.sessionId,taskId:managedTask.id,requestId:accepted.requestId};},
  agentFollow:params=>managed.provider.follow(params),
  agentExecute:({method,params})=>managed.provider[method.slice('agent.'.length)](params)});
 try{
  const boundChat=await managedChat.execute({method:'chat.sessions.create',params:{}});
  await managedChat.execute({method:'chat.send',params:{id:boundChat.id,text:'observe the synthetic unknown result'}});
  let managedStatus;
  for(let i=0;i<200;i++){managedStatus=await managedChat.execute({method:'chat.status',params:{id:boundChat.id}});if(!managedStatus.turn)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(managedStatus.turn,null,'Managed Agent unknown-effect turn settled');
  assert.equal(managedStatus.lastState,'needs-reconciliation','UI receives the authoritative Task recovery state and disables model switching');
  assert.equal(brokerCalls,1,'only the synthetic Broker result is observed');
  assert.equal(coordinator.recoveryForSession(bound.sessionId)?.state,'needs-reconciliation');
  assert.equal(coordinator.recoveryForTask(managedTask.id)?.state,'needs-reconciliation');
  assert.equal(coordinator.recoveryForSession(boundChat.id),null,'Chat UUID must not replace the provider Session identity');
  const before=(await managedChat.execute({method:'chat.sessions.list',params:{}})).sessions.find(row=>row.id===boundChat.id);
  assert.equal(before.taskId,managedTask.id,'the Chat remains linked to its authoritative Task');
  await assert.rejects(managedChat.execute({method:'chat.config.set',params:{id:boundChat.id,config:{model:'model-b'}}}),
   {code:'CONFIG_RECONCILIATION_REQUIRED'},'unknown Managed effects block model switching after the failed turn clears its live Session binding');
  const after=(await managedChat.execute({method:'chat.sessions.list',params:{}})).sessions.find(row=>row.id===boundChat.id);
  assert.deepEqual(after.config,before.config,'rejected switch preserves the saved Chat configuration');
 }finally{await managedChat.close();await managed.close();}
 // Exercise the production composition proxy, not a directly injected coordinator.
 // With the live provider binding gone, only Task recovery can reach this orphan journal entry.
 const {createCetaMeshServices}=await import('../src/app/service-container.js');
 const {createTaskRuntime}=await import('../src/task/runtime.js');
 const compositionRoot=path.join(root,'composition-recovery'),compositionState=path.join(compositionRoot,'state');
 const compositionTask=createTaskRuntime({stateDir:compositionState}).create({goal:'Recover a synthetic unconfirmed Managed effect'});
 const compositionChatFile=path.join(compositionState,'desktop-chat','sessions.json');
 const compositionJournalFile=path.join(compositionState,'model','tool-executions.json');
 fs.mkdirSync(path.dirname(compositionChatFile),{recursive:true});fs.mkdirSync(path.dirname(compositionJournalFile),{recursive:true});
 fs.writeFileSync(compositionChatFile,JSON.stringify({schemaVersion:1,sessions:[{id:'composition-chat',title:'Recovery fixture',
  taskId:compositionTask.id,dshSessionId:null,runtimeProvider:null,createdAt:1,updatedAt:1,
  config:{provider:'dsh',model:'model-a',reasoning:'off',mode:'chat',modelProvider:null,agentProvider:null,workspaceId:null}}]}));
 fs.writeFileSync(compositionJournalFile,JSON.stringify({'fixture-dispatch':{status:'outcome-unknown',
  sessionId:'orphan-managed-session',turnId:'orphan-managed-turn',taskId:compositionTask.id,capability:'filesystem.write',at:Date.now()}}));
 const originalFetch=globalThis.fetch;let networkAttempts=0,composed;
 globalThis.fetch=async()=>{networkAttempts++;throw new Error('Composition recovery fixture must not contact external services');};
 try{
  composed=createCetaMeshServices({dataRoot:compositionRoot,stateDir:compositionState,config:{},deferOptionalStart:true,
   dshDesktop:{status:async()=>({installed:false,available:false,running:false}),refresh:async()=>({installed:false,available:false,running:false})}});
  await composed.channelControlsReady;
  assert.equal(composed.toolExecutionCoordinator.recoveryForTask(compositionTask.id)?.state,'needs-reconciliation');
  assert.equal(composed.toolExecutionCoordinator.recoveryForSession('composition-chat'),null);
  const actualTask=composed.taskService.runtime.get({id:compositionTask.id}).task;
  assert.equal(actualTask.currentAgent,null,'no provider Session shortcut can conceal a missing Task recovery proxy');
  const linked=(await composed.desktopUiService.execute({method:'ui.chat.sessions.list',params:{}})).sessions.find(row=>row.id==='composition-chat');
  assert.equal(linked.taskId,compositionTask.id,'actual factory loaded the persisted Chat/Task association');
  const unchanged=fs.readFileSync(compositionChatFile),journalBefore=fs.readFileSync(compositionJournalFile);
  await assert.rejects(composed.desktopUiService.execute({method:'ui.chat.config.set',params:{id:linked.id,config:{model:'model-b'}}}),
   {code:'CONFIG_RECONCILIATION_REQUIRED'},'Owner UI must traverse the production composition proxy to the authoritative Task recovery journal');
  assert.deepEqual(fs.readFileSync(compositionChatFile),unchanged,'rejected composition switch preserves the persisted Chat bytes');
  assert.deepEqual(fs.readFileSync(compositionJournalFile),journalBefore,'UI configuration cannot reconcile or rewrite the unknown effect');
  assert.equal(networkAttempts,0,'actual service construction and recovery denial stay offline');
 }finally{
  if(composed)for(const name of ['simulationService','bionicService','channelService','meshService','integrationService','autonomousHandoff',
   'chatService','managedAgent','extensionService','pluginCenterService','capabilityService','agentService'])await composed[name]?.close?.();
  globalThis.fetch=originalFetch;
 }
}finally{chat.close();fs.rmSync(root,{recursive:true,force:true});}
