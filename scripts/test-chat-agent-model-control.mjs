import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import { readCodexModelCatalog, projectCodexModelControl } from '../src/agent/protocol/codex-model-control.js';
import {projectAgentModelControl} from '../src/desktop/chat-telemetry.js';
import {defineAgentProvider} from '../src/agent/agent-provider.js';
import {createAgentProviderRegistry} from '../src/agent/registry.js';
import {createAgentBroker} from '../src/agent/broker.js';
import {createTaskRuntime} from '../src/task/runtime.js';
import {createContinuityService} from '../src/continuity/service.js';

// The external leaf is deterministic. Core persistence, transactions and the
// Owner UI projection are real; this is not native Agent or account acceptance.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-agent-model-control-'));
let sequence=0,failures=0;
const control=(model='model-a',reasoningEffort='medium')=>({status:'available',source:'acp-session',runtimeVersion:'fixture',
 application:'runtime-confirmed',selection:{model,reasoningEffort},
 model:{configId:'model',options:[{value:'model-a',label:'Native A'},{value:'model-b',label:'Native B'}]},
 reasoning:{configId:'reasoning',options:[{value:'medium',label:'Medium'},{value:'xhigh',label:'Extra high'}]}});
const codexModels=[{value:'model-a',label:'Native A',reasoningOptions:[{value:'low',label:'Low'}],defaultReasoningEffort:'low'},
 {value:'model-b',label:'Native B',reasoningOptions:[{value:'high',label:'High'},{value:'maximum',label:'Maximum'}],defaultReasoningEffort:'high'}];
const codexControl=(model='model-a',reasoningEffort='low',models=codexModels)=>({status:'available',source:'codex-app-server',runtimeVersion:'0.167.0-alpha.3.2',
 application:'runtime-confirmed',changeApplication:'requires-new-session',selection:{model,reasoningEffort,modelProvider:'fixture-native'},
 model:{options:structuredClone(models)},reasoning:{options:structuredClone(models.find(option=>option.value===model)?.reasoningOptions??[])}});
async function codexTaskFixture({models=codexModels,persistedReasoning='low',persistedModel='model-a',persistedProvider='fixture-native',automatic=false,initialReasoning='low'}={}){
 const stateDir=path.join(root,'codex-'+(++sequence)),calls=[],controls=new Map(),ends=new Map();let serial=0;
 const taskRuntime=createTaskRuntime({stateDir});const task=taskRuntime.create({goal:'Native complete model pair',workspaceId:'fixture-workspace'});
 const registry=createAgentProviderRegistry();
 registry.register(defineAgentProvider({id:'codex',label:'Owned Codex fixture',capabilityExtras:{workspaceBoundary:'capability-broker'},methods:{
  async createSession(options){const sessionId='codex-'+(++serial);const model=options.model??'model-a',reasoningEffort=options.reasoningEffort===undefined?'low':options.reasoningEffort;
   calls.push({method:'create',sessionId,model,reasoningEffort});
   const modelControl=codexControl(model,reasoningEffort,models);controls.set(sessionId,modelControl);return{sessionId,modelControl};},
  async status({sessionId}){calls.push({method:'status',sessionId});return{running:false,queued:0,modelControl:controls.get(sessionId)};},
  async send({sessionId}){const requestId='bootstrap-'+sessionId;ends.set(sessionId,{type:'turn/end',data:{requestId,reason:{kind:'completed'}}});return{accepted:true,requestId};},
  async cancel({sessionId}){calls.push({method:'cancel',sessionId});return{cancelled:true};},async closeSession({sessionId}){calls.push({method:'close',sessionId});return{closed:true};},
  async selectModel(){calls.push({method:'select'});throw Object.assign(new Error('Fresh native Session required'),{code:'AGENT_CONFIGURATION_REQUIRES_NEW_SESSION'});},
  async *follow({sessionId}){if(ends.has(sessionId))yield ends.get(sessionId);},async contextUsage(){return{available:false};},async resume(){return{};},async health(){return{available:true};}
 }}));
 const broker=createAgentBroker({registry});const source=await broker.createSession('codex',{taskId:task.id,workspaceId:task.workspaceId,reasoningEffort:initialReasoning});
 taskRuntime.start({id:task.id,expectedRev:taskRuntime.get({id:task.id}).task.rev,provider:'codex',sessionId:source.sessionId});
 const continuity=createContinuityService({stateDir,taskRuntime,agentBroker:broker,canRollover:()=>true});
 fs.mkdirSync(path.join(stateDir,'desktop-chat'),{recursive:true});
 fs.writeFileSync(path.join(stateDir,'desktop-chat','sessions.json'),JSON.stringify({schemaVersion:1,sessions:[{id:'chat',title:'Native fixture',taskId:task.id,createdAt:1,updatedAt:1,
  config:{provider:'dsh',agentProvider:automatic?null:'codex',model:persistedModel,modelProvider:persistedProvider,reasoning:persistedReasoning,workspaceId:task.workspaceId,mode:'chat'}}]}));
 const options={stateDir,resolveTask:async id=>taskRuntime.get({id}).task,handoffTaskSupportsBeforeEffects:true,
  handoffTask:async({expectedConfigurationSource,...invocation})=>{calls.push({method:'handoff',invocation});return continuity.runtime.rollover(invocation);},
  readTaskHandoff:({taskId,from})=>continuity.runtime.history({taskId}).rollovers.findLast(row=>row.from.provider===from.provider&&row.from.sessionId===from.sessionId),
  agentProviders:[{id:'codex',eventProtocol:'agent-turn-events-v1',requiresTask:true}],agentExecute:request=>broker[request.method.slice(6)](request.params),
  agentFollow:async function*({signal}){if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}};
 let service=createChatService(options),ui=createDesktopUiService({services:{chatService:service}});
 await service.synchronizeTaskAssignment({taskId:task.id,provider:'codex',sessionId:source.sessionId});
 return{calls,task,taskRuntime,continuity,source,get service(){return service;},get ui(){return ui;},
  saved:()=>JSON.parse(fs.readFileSync(service._store.sessionsFile,'utf8')).sessions[0],
  set:config=>ui.execute({method:'ui.chat.config.set',params:{id:'chat',config}}),
  async restart(){await service.close();service=createChatService(options);ui=createDesktopUiService({services:{chatService:service}});}};
}
function fixture({provider='opencode',state='ready',selection,modelRuntime,linked=false,automatic=false,handoff=false,handoffError,controlFactory=control}={}){
 const stateDir=path.join(root,String(++sequence));fs.mkdirSync(path.join(stateDir,'desktop-chat'),{recursive:true});
 const task={id:'task',rev:1,status:'running',workspaceId:'workspace',currentAgent:{provider,sessionId:'agent-session'},executionObservation:{state:state==='ready'?'completed':state}};
 fs.writeFileSync(path.join(stateDir,'desktop-chat','sessions.json'),JSON.stringify({schemaVersion:1,sessions:[{id:'chat',title:'Fixture',taskId:linked?'task':null,createdAt:1,updatedAt:1,
  config:{provider:'dsh',model:'model-a',modelProvider:null,reasoning:'medium',mode:'chat',agentProvider:automatic?null:provider,workspaceId:'workspace'}}]}));
 const calls=[];let current=controlFactory();
 const service=createChatService({stateDir,modelRuntime,resolveTask:async()=>task,
  agentProviders:[{id:provider,label:provider,eventProtocol:'agent-turn-events-v1'}],
  agentExecute:async request=>{calls.push(request);if(request.method==='agent.status')return {running:state==='running',state,waitingForApproval:false,queued:0,modelControl:current};
   if(request.method==='agent.createSession')return {sessionId:'agent-session',modelControl:current};
   if(request.method==='agent.send')return {accepted:true};
   if(request.method==='agent.selectModel')return selection?selection(request.params):{confirmed:true,modelControl:current=controlFactory(request.params.model,request.params.reasoningEffort)};
   if(request.method==='agent.list')return{providers:[{id:provider,available:true}]};return{};},
  ...(handoff?{handoffTask:async request=>{calls.push({method:'continuity.handoff',params:request});if(handoffError)throw handoffError;current=controlFactory(request.model,request.reasoningEffort);task.currentAgent={provider,sessionId:'agent-replacement'};return {to:task.currentAgent,modelControl:current};}}:{})});
 const ui=createDesktopUiService({services:{chatService:service}});
 return{service,ui,calls,task,stateDir,bind:async()=>{
   if(linked)return service.synchronizeTaskAssignment({taskId:'task',provider,sessionId:'agent-session'});
   await service.execute({method:'chat.send',params:{id:'chat',text:'Synthetic completed turn'}});
   for(let i=0;i<100&&!calls.some(row=>row.method==='agent.send');i++)await new Promise(resolve=>setTimeout(resolve,1));
   service._injectEvent('chat',{type:'turn/start',data:{turn:'fixture-turn'}});
   service._injectEvent('chat',{type:'turn/end',data:{turn:'fixture-turn',reason:{kind:'completed'}}});
   for(let i=0;i<100&&(await service.execute({method:'chat.status',params:{id:'chat'}})).turn;i++)await new Promise(resolve=>setTimeout(resolve,1));
  },
  saved:()=>JSON.parse(fs.readFileSync(service._store.sessionsFile,'utf8')).sessions[0],
  set:config=>ui.execute({method:'ui.chat.config.set',params:{id:'chat',config}})};
}
async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+': '+error.message);}}
try{
 await check('an exact-limit valid native catalog survives the complete display projection without synthetic null metadata',async()=>{
  const rows=Array.from({length:256},(_,index)=>({model:'model-'+String(index).padStart(3,'0'),displayName:'L'.repeat(256),
   supportedReasoningEfforts:[{reasoningEffort:'low',description:'R'.repeat(142)+(index===1?'R'.repeat(45):'')}],defaultReasoningEffort:'low'}));
  let page=0;const catalog=await readCodexModelCatalog(async()=>({data:rows.slice(page*100,++page*100),nextCursor:page<3?'page-'+page:null}));
  const native=projectCodexModelControl({version:'0.167.0-alpha.3.2',catalog,selection:{model:'model-000',modelProvider:'synthetic',reasoningEffort:'low'}}),before=structuredClone(native);
  assert.equal(Buffer.byteLength(JSON.stringify(native)),131072);
  const projected=projectAgentModelControl(native);assert.ok(projected,'the consumer must accept the producer\'s legal complete boundary');
  assert.equal(projected.model.options.length,256);assert.equal(Buffer.byteLength(JSON.stringify(projected)),131072);
  assert.equal(Object.hasOwn(projected.model,'configId'),false);assert.equal(Object.hasOwn(projected.reasoning,'configId'),false);
  assert.deepEqual(native,before);
 });
 await check('native DTO preserves each exact advertised model tuple and fresh-session application',async()=>{
  const longModel='native-'+ 'm'.repeat(249),longEffort='effort-'+ 'r'.repeat(249);
  const models=[...codexModels,{value:longModel,label:'Long native model',reasoningOptions:[{value:longEffort,label:'Exact effort'}],defaultReasoningEffort:longEffort}];
  const projected=projectAgentModelControl(codexControl('model-a','low',models));
  assert.deepEqual(projected.model.options,models);assert.equal(projected.changeApplication,'requires-new-session');
  assert.deepEqual(projected.reasoning.options,codexModels[0].reasoningOptions,'current reasoning remains the current model advertisement');
  const invalid=structuredClone(codexControl());invalid.model.options[1].defaultReasoningEffort='low';
  assert.equal(projectAgentModelControl(invalid),null,'a target default cannot borrow another model effort');
  const oversized=structuredClone(codexControl());oversized.model.options[1].reasoningOptions=[{value:'r'.repeat(257),label:'Invalid effort'}];
  assert.equal(projectAgentModelControl(oversized),null,'oversized native effort identity is refused rather than truncated into a valid option');
 });
 await check('malformed model-specific advertisements cannot become a silently partial selector',async()=>{
  const oversized=structuredClone(codexControl());oversized.model.options[1].value='m'.repeat(257);
  assert.equal(projectAgentModelControl(oversized),null,'a native model identity is never truncated or silently dropped');
  const duplicate=structuredClone(codexControl());duplicate.model.options.push(structuredClone(duplicate.model.options[0]));
  assert.equal(projectAgentModelControl(duplicate),null,'duplicate model-specific records cannot hide a conflicting advertisement');
  const excessive=codexControl();excessive.model.options=Array.from({length:257},(_,index)=>({...structuredClone(codexModels[0]),value:'model-'+index}));
  assert.equal(projectAgentModelControl(excessive),null,'oversized model-specific catalogs are not silently sliced');
 });
 await check('Codex complete target pair uses one formal Continuity handoff and confirms before replacing the source',async()=>{
  const f=await codexTaskFixture();try{const changed=await f.set({model:'model-b',reasoning:'high'});
   assert.equal(changed.config.model,'model-b');assert.equal(changed.config.reasoning,'high');assert.equal(changed.configuration.runtime,'confirmed');
   assert.equal(f.calls.filter(row=>row.method==='handoff').length,1);assert.equal(f.calls.filter(row=>row.method==='select').length,0);
   const created=f.calls.filter(row=>row.method==='create');assert.equal(created.length,2);assert.deepEqual([created[1].model,created[1].reasoningEffort],['model-b','high']);
   assert.equal(f.saved().dshSessionId,created[1].sessionId);assert.equal(f.taskRuntime.get({id:f.task.id}).task.currentAgent.sessionId,created[1].sessionId);
   assert.equal(f.calls.filter(row=>row.method==='cancel'&&row.sessionId===f.source.sessionId).length,1);
   assert.ok(f.calls.findIndex(row=>row.method==='create'&&row.sessionId===created[1].sessionId)<f.calls.findIndex(row=>row.method==='cancel'&&row.sessionId===f.source.sessionId));
  }finally{await f.service.close();}
 });
 for(const patch of [{model:'model-b',reasoning:'low'},{model:'model-b'}])await check('Codex refuses an invalid effective target effort before effects '+JSON.stringify(patch),async()=>{
  const f=await codexTaskFixture({persistedReasoning:patch.reasoning===undefined?'high':'low'});try{const before=f.saved(),taskBefore=f.taskRuntime.get({id:f.task.id}).task;
   await assert.rejects(f.set(patch),{code:'MODEL_REASONING_UNSUPPORTED'});
   assert.deepEqual(f.saved(),before);assert.deepEqual(f.taskRuntime.get({id:f.task.id}).task,taskBefore);
   assert.equal(f.calls.filter(row=>['handoff','select','cancel','close'].includes(row.method)).length,0);assert.equal(f.calls.filter(row=>row.method==='create').length,1);
  }finally{await f.service.close();}
 });
 await check('a stale persisted tuple cannot bypass actual native target validation by looking unchanged',async()=>{
  const f=await codexTaskFixture({persistedModel:'model-b'});try{const before=f.saved();
   await assert.rejects(f.set({model:'model-b',reasoning:'low'}),{code:'MODEL_REASONING_UNSUPPORTED'});
   assert.deepEqual(f.saved(),before);assert.equal(f.calls.filter(row=>['handoff','cancel','select'].includes(row.method)).length,0);
  }finally{await f.service.close();}
 });
 await check('a matching native no-op reads the actual ACK and preserves storage without a handoff',async()=>{
  const f=await codexTaskFixture();try{const before=f.saved(),observed=f.calls.filter(row=>row.method==='status').length;
   await f.set({model:'model-a',reasoning:'low',modelProvider:'fixture-native'});
   assert.ok(f.calls.filter(row=>row.method==='status').length>observed,'a persisted match is not an actual native acknowledgement');
   assert.deepEqual(f.saved(),before);assert.equal(f.calls.filter(row=>['handoff','cancel','select'].includes(row.method)).length,0);
  }finally{await f.service.close();}
 });
 await check('an unadvertised native ACK effort cannot become an allowed no-op request',async()=>{
  const f=await codexTaskFixture({initialReasoning:'ghost',persistedReasoning:'ghost'});try{const before=f.saved();
   await assert.rejects(f.set({model:'model-a',reasoning:'ghost'}),{code:'MODEL_REASONING_UNSUPPORTED'});assert.deepEqual(f.saved(),before);
  }finally{await f.service.close();}
 });
 await check('an explicit complete pair applies a reasoning value equal to stale storage but different from the native ACK',async()=>{
  const f=await codexTaskFixture({persistedReasoning:'high'});try{const changed=await f.set({model:'model-b',reasoning:'high'});
   assert.equal(changed.config.model,'model-b');assert.equal(changed.config.reasoning,'high');
   assert.equal(f.calls.find(row=>row.method==='handoff').invocation.reasoningEffort,'high');
  }finally{await f.service.close();}
 });
 await check('an omitted native model provider comes from the actual ACK rather than stale storage',async()=>{
  const f=await codexTaskFixture({persistedProvider:'stale-provider'});try{const changed=await f.set({model:'model-b',reasoning:'high'});
   assert.equal(changed.config.modelProvider,'fixture-native');assert.equal(f.calls.find(row=>row.method==='handoff').invocation.modelProvider,'fixture-native');
  }finally{await f.service.close();}
 });
 await check('an explicitly requested stale native provider refuses before effects even when storage matches it',async()=>{
  const f=await codexTaskFixture({persistedProvider:'stale-provider'});try{const before=f.saved();
   await assert.rejects(f.set({model:'model-b',reasoning:'high',modelProvider:'stale-provider'}),{code:'AGENT_MODEL_UNSUPPORTED'});
   assert.deepEqual(f.saved(),before);assert.equal(f.calls.filter(row=>['handoff','cancel','select'].includes(row.method)).length,0);
  }finally{await f.service.close();}
 });
 await check('native 256-character model identity survives full-pair ACK, UI projection and restart; 257 refuses',async()=>{
  const value='native-'+ 'm'.repeat(249),models=[...codexModels,{value,label:'Long native model',reasoningOptions:[{value:'high',label:'High'}],defaultReasoningEffort:'high'}];
  const f=await codexTaskFixture({models});try{const changed=await f.set({model:value,reasoning:'high'});
   assert.equal(changed.config.model,value);assert.equal(f.saved().config.model,value);await f.restart();
   const listed=await f.ui.execute({method:'ui.chat.sessions.list',params:{}});assert.equal(listed.sessions[0].config.model,value);
   const before=f.saved();await assert.rejects(f.set({model:value+'x',reasoning:'high'}),{code:'INVALID_PARAMS'});assert.deepEqual(f.saved(),before);
  }finally{await f.service.close();}
 });
 await check('Auto Task retains saved native 256 identity before and after authoritative assignment restoration',async()=>{
  const value='native-'+ 'a'.repeat(249),models=[...codexModels,{value,label:'Auto native model',reasoningOptions:[{value:'high',label:'High'}]}];
  const f=await codexTaskFixture({models,automatic:true});try{
   assert.equal(Object.hasOwn((await f.service.execute({method:'chat.sessions.list',params:{}})).sessions[0],'modelAgentProvider'),false,
    'saved request metadata needs no duplicate provider-state projection');
   const changed=await f.set({model:value,reasoning:'high'});
   assert.equal(changed.config.agentProvider,null);assert.equal(changed.config.model,value);assert.equal(Object.hasOwn(changed,'modelAgentProvider'),false,'internal provider metadata stays out of renderer DTOs');
   assert.equal((await f.ui.execute({method:'ui.chat.sessions.list',params:{}})).sessions[0].config.model,value);
   await f.restart();assert.equal(f.saved().config.model,value,'restart preserves the exact persisted identity without inventing a live Session');assert.equal(f.saved().dshSessionId,null);
   assert.equal((await f.ui.execute({method:'ui.chat.sessions.list',params:{}})).sessions[0].config.model,value,
    'saved requested identity must not be truncated merely because its live runtime is currently unknown');
   const binding=f.taskRuntime.get({id:f.task.id}).task.currentAgent;await f.service.synchronizeTaskAssignment({taskId:f.task.id,...binding});
   assert.equal((await f.ui.execute({method:'ui.chat.sessions.list',params:{}})).sessions[0].config.model,value);
  }finally{await f.service.close();}
 });
 await check('a target with no reasoning receives explicit null through Owner UI, Chat and formal Continuity',async()=>{
  const models=structuredClone(codexModels);models[1].reasoningOptions=[];delete models[1].defaultReasoningEffort;
  const f=await codexTaskFixture({models});try{
   const changed=await f.set({model:'model-b',reasoning:''});
   assert.equal(f.calls.find(row=>row.method==='handoff').invocation.reasoningEffort,null);
   const target=f.calls.find(row=>row.method==='create'&&row.sessionId!==f.source.sessionId);
   assert.equal(target.model,'model-b');assert.equal(target.reasoningEffort,null);
   assert.equal(changed.config.model,'model-b');assert.equal(changed.config.reasoning,'');
   assert.equal(f.taskRuntime.get({id:f.task.id}).task.modelConfig.reasoningEffort,null);
   assert.equal(f.calls.filter(row=>row.method==='cancel'&&row.sessionId===f.source.sessionId).length,1);
  }finally{await f.service.close();}
 });
 await check('native advertised reasoning identity above the legacy Task 40-character bound survives formal handoff',async()=>{
  const effort='effort-'+ 'r'.repeat(57),models=structuredClone(codexModels);models[1].reasoningOptions.push({value:effort,label:'Native exact effort'});
  const f=await codexTaskFixture({models});try{const changed=await f.set({model:'model-b',reasoning:effort});
   assert.equal(changed.config.reasoning,effort);assert.equal(f.saved().config.reasoning,effort);assert.equal(f.taskRuntime.get({id:f.task.id}).task.modelConfig.reasoningEffort,effort);
  }finally{await f.service.close();}
 });
 await check('Taskless fresh-session control refusal retains the source and does not fabricate a replacement',async()=>{
  const f=fixture({provider:'codex',controlFactory:codexControl,selection:async()=>{throw Object.assign(new Error('模型变更需要新会话，请通过任务交接继续'),{code:'AGENT_CONFIGURATION_REQUIRES_NEW_SESSION'});}});
  try{await f.bind();const before=f.saved();await assert.rejects(f.set({model:'model-b',reasoning:'high'}),{code:'AGENT_CONFIGURATION_REQUIRES_NEW_SESSION'});
   assert.deepEqual(f.saved().config,before.config);assert.equal(f.saved().dshSessionId,'agent-session');assert.equal(f.saved().pendingConfiguration,null);
   assert.equal(f.calls.filter(row=>row.method==='agent.createSession').length,1);assert.equal(f.calls.filter(row=>row.method==='agent.closeSession').length,0);
  }finally{await f.service.close();}
 });
 for(const provider of [null,'none','cetamesh'])await check('ordinary '+provider+' model parameter keeps its 200-character boundary',async()=>{
  const service=createChatService({stateDir:path.join(root,'ordinary-'+(++sequence)),defaultAgentProvider:()=>provider,agentProviders:[{id:'cetamesh',eventProtocol:'agent-turn-events-v1'}]});
  try{const row=await service.execute({method:'chat.sessions.create',params:{}}),before=JSON.parse(fs.readFileSync(service._store.sessionsFile,'utf8'));
   await assert.rejects(service.execute({method:'chat.config.set',params:{id:row.id,config:{model:'m'.repeat(201)}}}),{code:'INVALID_PARAMS'});
   assert.deepEqual(JSON.parse(fs.readFileSync(service._store.sessionsFile,'utf8')),before);
  }finally{await service.close();}
 });
 await check('native reasoning survives load, exact ACK, UI projection and restart',async()=>{
  const f=fixture();try{await f.bind();assert.equal(f.saved().config.reasoning,'medium');
   const changed=await f.set({reasoning:'xhigh'});assert.equal(changed.config.reasoning,'xhigh');
   assert.equal(changed.configuration.application,'runtime-confirmed');assert.equal(changed.configuration.durable,true);
   assert.equal(f.saved().config.reasoning,'xhigh');await f.service.close();
   const reloaded=createChatService({stateDir:f.stateDir});try{assert.equal((await reloaded.execute({method:'chat.sessions.list',params:{}})).sessions[0].config.reasoning,'xhigh');}finally{await reloaded.close();}
  }finally{await f.service.close();}
 });
 await check('native ACK mismatch rejects without replacing confirmed Chat config',async()=>{
  const f=fixture({selection:async()=>({confirmed:true,modelControl:control('model-a','medium')})});
  try{await f.bind();const before=f.saved();await assert.rejects(f.set({model:'model-b'}),{code:'MODEL_ACK_MISMATCH'});assert.deepEqual(f.saved().config,before.config);assert.equal(f.saved().dshSessionId,'agent-session');
   assert.equal(f.saved().pendingConfiguration.phase,'needs-reconciliation');
   const status=await f.ui.execute({method:'ui.chat.status',params:{id:'chat'}});assert.equal(status.configuration.runtime,'unknown');assert.equal(status.configuration.durable,false);
  }finally{await f.service.close();}
 });
 await check('pending runtime ACK does not appear current or allow another config transaction',async()=>{
  let release,entered;const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
  const f=fixture({selection:async p=>{entered();await gate;return{confirmed:true,modelControl:control(p.model,p.reasoningEffort)};}});
  try{await f.bind();const pending=f.set({model:'model-b'});await started;assert.equal(f.saved().config.model,'model-a');
   assert.equal(f.saved().pendingConfiguration.phase,'needs-reconciliation');assert.ok(f.saved().pendingConfiguration.changeId);
   await assert.rejects(f.set({reasoning:'xhigh'}),{code:'CONFIG_BUSY'});release();assert.equal((await pending).config.model,'model-b');
  }finally{release?.();await f.service.close();}
 });
 for(const state of ['running','unknown'])await check('Task '+state+' cannot change model while Chat is idle',async()=>{
  const f=fixture({state,linked:true});try{await f.bind();await assert.rejects(f.set({model:'model-b'}));assert.equal(f.calls.filter(row=>row.method==='agent.selectModel').length,0);assert.equal(f.saved().config.model,'model-a');}finally{await f.service.close();}
 });
 await check('explicit DSH rejection preserves old config, binding and ownership',async()=>{
  const f=fixture({provider:'dsh',selection:async()=>{throw Object.assign(new Error('Unknown model'),{code:'MODEL_NOT_FOUND'});}});
  try{await f.bind();const before=f.saved();await assert.rejects(f.set({model:'model-b'}));assert.deepEqual(f.saved().config,before.config);assert.equal(f.saved().dshSessionId,'agent-session');assert.equal(f.calls.filter(row=>row.method==='agent.closeSession').length,0);}finally{await f.service.close();}
 });
 await check('external catalog is session-owned and does not query ordinary Model Runtime models',async()=>{
  let leaked=0;const runtime={isRegistered:()=>true,listProviders:()=>{leaked++;return[{id:'ordinary',hasKey:true}];},listModels:async()=>({models:[{id:'ordinary-only'}]}),defaultProviderId:()=> 'ordinary'};
  const f=fixture({modelRuntime:runtime});try{await f.bind();const catalog=await f.ui.execute({method:'ui.chat.catalog',params:{id:'chat'}});
   assert.deepEqual(catalog.modelProviders,[]);assert.equal(leaked,0);assert.equal(catalog.agentProvider,'opencode');assert.equal(catalog.modelControl.selection.model,'model-a');
   assert.deepEqual(catalog.modelControl.reasoning.options.map(v=>v.value),['medium','xhigh']);
   const changed=await f.set({reasoning:'xhigh'});assert.equal(changed.config.reasoning,'xhigh');
  }finally{await f.service.close();}
 });
 await check('Task-bound model changes use existing same-provider Continuity handoff',async()=>{
  const f=fixture({linked:true,handoff:true});try{await f.bind();const changed=await f.set({model:'model-b',reasoning:'xhigh'});
   assert.equal(f.calls.filter(row=>row.method==='agent.selectModel').length,0);
   const transition=f.calls.find(row=>row.method==='continuity.handoff');assert.equal(transition.params.targetProvider,'opencode');assert.equal(transition.params.reason,'owner-request');assert.equal(transition.params.reasoningEffort,'xhigh');
   assert.equal(changed.config.model,'model-b');assert.equal(f.saved().dshSessionId,'agent-replacement');assert.equal(f.saved().taskId,'task');
  }finally{await f.service.close();}
 });
 await check('automatic Chat keeps Task native model identity separate from Model Runtime',async()=>{
  let leaked=0;const runtime={isRegistered:()=>true,listProviders:()=>{leaked++;return[];},defaultProviderId:()=> 'ordinary'};
  const f=fixture({linked:true,automatic:true,handoff:true,modelRuntime:runtime});try{await f.bind();const catalog=await f.ui.execute({method:'ui.chat.catalog',params:{id:'chat'}});
   assert.equal(catalog.agentProvider,'opencode');assert.equal(leaked,0);await f.set({reasoning:'xhigh'});assert.equal(f.saved().config.agentProvider,null);assert.equal(f.saved().config.reasoning,'xhigh');assert.equal(f.calls.filter(row=>row.method==='continuity.handoff').length,1);
  }finally{await f.service.close();}
 });
 await check('Continuity review errors remain actionable and retain the original config and binding',async()=>{
  const error=Object.assign(new Error('非 Git 工作区需要在任务详情核对文件和先前操作'),{code:'WORKSPACE_UNVERIFIED'});
  const f=fixture({linked:true,handoff:true,handoffError:error});try{await f.bind();const before=f.saved();
   await assert.rejects(f.set({model:'model-b'}),cause=>cause.code==='WORKSPACE_UNVERIFIED'&&/任务详情/.test(cause.message));
   assert.deepEqual(f.saved().config,before.config);assert.equal(f.saved().dshSessionId,'agent-session');
  }finally{await f.service.close();}
 });
 await check('no native session means no invented current selection or inherited Model Runtime default',async()=>{
  const service=createChatService({stateDir:path.join(root,'fresh'),defaultAgentProvider:()=> 'qwen',
   defaultModelConfig:()=>({provider:'ordinary',defaultModel:'ordinary-only',reasoningEffort:'max'}),
   modelRuntime:{isRegistered:()=>true,hasKey:()=>true},agentProviders:[{id:'qwen',eventProtocol:'agent-turn-events-v1'}]});
  try{const created=await service.execute({method:'chat.sessions.create',params:{}});assert.equal(created.config.model,'');assert.equal(created.config.modelProvider,null);assert.equal(created.config.reasoning,'');
   await assert.rejects(service.execute({method:'chat.config.set',params:{id:created.id,config:{model:'unconfirmed'}}}),{code:'AGENT_MODEL_SESSION_REQUIRED'});
  }finally{await service.close();}
 });
}finally{
 if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('cm-agent-model-control-'))throw Error('fixture cleanup boundary');
 fs.rmSync(root,{recursive:true,force:true});
}
if(failures)process.exitCode=1;
