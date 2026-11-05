import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';

// The external leaf is deterministic. Core persistence, transactions and the
// Owner UI projection are real; this is not native Agent or account acceptance.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-agent-model-control-'));
let sequence=0,failures=0;
const control=(model='model-a',reasoningEffort='medium')=>({status:'available',source:'acp-session',runtimeVersion:'fixture',
 application:'runtime-confirmed',selection:{model,reasoningEffort},
 model:{configId:'model',options:[{value:'model-a',label:'Native A'},{value:'model-b',label:'Native B'}]},
 reasoning:{configId:'reasoning',options:[{value:'medium',label:'Medium'},{value:'xhigh',label:'Extra high'}]}});
function fixture({provider='opencode',state='ready',selection,modelRuntime,linked=false,automatic=false,handoff=false,handoffError}={}){
 const stateDir=path.join(root,String(++sequence));fs.mkdirSync(path.join(stateDir,'desktop-chat'),{recursive:true});
 const task={id:'task',rev:1,status:'running',workspaceId:'workspace',currentAgent:{provider,sessionId:'agent-session'},executionObservation:{state:state==='ready'?'completed':state}};
 fs.writeFileSync(path.join(stateDir,'desktop-chat','sessions.json'),JSON.stringify({schemaVersion:1,sessions:[{id:'chat',title:'Fixture',taskId:linked?'task':null,createdAt:1,updatedAt:1,
  config:{provider:'dsh',model:'model-a',modelProvider:null,reasoning:'medium',mode:'chat',agentProvider:automatic?null:provider,workspaceId:'workspace'}}]}));
 const calls=[];let current=control();
 const service=createChatService({stateDir,modelRuntime,resolveTask:async()=>task,
  agentProviders:[{id:provider,label:provider,eventProtocol:'agent-turn-events-v1'}],
  agentExecute:async request=>{calls.push(request);if(request.method==='agent.status')return {running:state==='running',state,waitingForApproval:false,queued:0,modelControl:current};
   if(request.method==='agent.createSession')return {sessionId:'agent-session',modelControl:current};
   if(request.method==='agent.send')return {accepted:true};
   if(request.method==='agent.selectModel')return selection?selection(request.params):{confirmed:true,modelControl:current=control(request.params.model,request.params.reasoningEffort)};
   if(request.method==='agent.list')return{providers:[{id:provider,available:true}]};return{};},
  ...(handoff?{handoffTask:async request=>{calls.push({method:'continuity.handoff',params:request});if(handoffError)throw handoffError;current=control(request.model,request.reasoningEffort);task.currentAgent={provider,sessionId:'agent-replacement'};return {to:task.currentAgent,modelControl:current};}}:{})});
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
 await check('native reasoning survives load, exact ACK, UI projection and restart',async()=>{
  const f=fixture();try{await f.bind();assert.equal(f.saved().config.reasoning,'medium');
   const changed=await f.set({reasoning:'xhigh'});assert.equal(changed.config.reasoning,'xhigh');
   assert.equal(f.saved().config.reasoning,'xhigh');await f.service.close();
   const reloaded=createChatService({stateDir:f.stateDir});try{assert.equal((await reloaded.execute({method:'chat.sessions.list',params:{}})).sessions[0].config.reasoning,'xhigh');}finally{await reloaded.close();}
  }finally{await f.service.close();}
 });
 await check('native ACK mismatch rejects without replacing confirmed Chat config',async()=>{
  const f=fixture({selection:async()=>({confirmed:true,modelControl:control('model-a','medium')})});
  try{await f.bind();const before=f.saved();await assert.rejects(f.set({model:'model-b'}),{code:'MODEL_ACK_MISMATCH'});assert.deepEqual(f.saved().config,before.config);assert.equal(f.saved().dshSessionId,'agent-session');}finally{await f.service.close();}
 });
 await check('pending runtime ACK does not appear current or allow another config transaction',async()=>{
  let release,entered;const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
  const f=fixture({selection:async p=>{entered();await gate;return{confirmed:true,modelControl:control(p.model,p.reasoningEffort)};}});
  try{await f.bind();const pending=f.set({model:'model-b'});await started;assert.equal(f.saved().config.model,'model-a');
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
