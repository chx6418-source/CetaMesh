import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createExtensionRuntime,createExtensionStore} from '../src/extension/index.js';
import https from 'node:https';import http from 'node:http';import {EventEmitter} from 'node:events';import {Readable} from 'node:stream';
import {createCapabilityService} from '../src/capability/service.js';
import {createCapabilityPolicy} from '../src/capability/policy.js';
import {createCapabilityBroker} from '../src/capability/broker.js';import {OWNER_ACTOR} from '../src/capability/types.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-http-extension-'));let runtime;
try {
 const source=path.join(root,'source');fs.mkdirSync(source);
 const manifest={manifestVersion:1,id:'test.http-json',name:'HTTP JSON fixture',version:'1.0.0',type:'external-api',entry:'api.json',permissions:['network'],network:{hosts:['example.com']},scope:{paths:[]},capabilities:[{id:'lookup',requires:['network'],inputSchema:{type:'object',additionalProperties:false,properties:{term:{type:'string',maxLength:50}},required:['term']}}]};
 fs.writeFileSync(path.join(source,'extension.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(source,'api.json'),JSON.stringify({schemaVersion:1,protocol:'http-json-v1',endpoints:[{capability:'lookup',url:'https://example.com/search',method:'GET',queryKeys:['term'],response:'json'}]}));
 const broker=createCapabilityBroker({stateDir:path.join(root,'state'),policy:createCapabilityPolicy({resolveTask:id=>({id,workspaceId:'plugin-workspace',status:'running',rev:1,currentAgent:{provider:'cetamesh',sessionId:'plugin-session'}}),resolveWorkspace:id=>({id,root:source})})});let calls=0;
 broker.register({id:'network',permission:'network',provider:'fixture-transport',risk:'high',execute:async request=>{calls++;assert.equal(request.input.url,'https://example.com/search?term=a%26b');if(request.taskId){assert.equal(request.actor.id,'task:plugin-task');assert.equal(request.taskId,'plugin-task');assert.equal(request.workspaceId,'plugin-workspace');assert.equal(request.constrainedActor?.id,manifest.id);assert.ok(request.operationId,'nested call uses a durable derived identity');}else assert.equal(request.actor.id,manifest.id);return {statusCode:200,body:'{"value":4217}',truncated:false};}});
 runtime=createExtensionRuntime({store:createExtensionStore({stateDir:path.join(root,'state')}),capabilityBroker:broker,monitorIntervalMs:0});
 const review=runtime.review({sourceDir:source});assert.equal(review.scan.ok,true);assert.equal(review.review.executionBoundary.codeExecution,false);
 runtime.install({sourceDir:source,approval:{approved:true,token:review.review.token}});runtime.enable({id:manifest.id});
 const pending=await runtime.invoke({id:manifest.id,capability:'lookup',input:{term:'a&b'}});
 assert.equal(pending.status,'pending','HTTP method alone cannot prove absence of side effects');assert.equal(calls,0);
 const result=await broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR});
 assert.deepEqual(result.result.result,{statusCode:200,data:{value:4217}});assert.equal(calls,1);
 await assert.rejects(broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR}));assert.equal(calls,1,'repeat approval cannot dispatch twice');
 await assert.rejects(runtime.invoke({id:manifest.id,capability:'lookup',input:{term:'ok',url:'https://unapproved.invalid'}}),{code:'TOOL_ARGUMENTS_INVALID'});
 const taskActor={kind:'agent',id:'task:plugin-task',grants:{capabilities:['extension.'+manifest.id+'.lookup','network'],taskIds:['plugin-task'],workspaceIds:['plugin-workspace']}};
 const taskCall={actor:taskActor,taskId:'plugin-task',workspaceId:'plugin-workspace',capability:'extension.'+manifest.id+'.lookup',input:{term:'a&b'},operationId:'plugin-parent',requestId:'plugin-parent-call'};
 const scopedPending=await broker.execute(taskCall);assert.equal(scopedPending.status,'pending');
 const childPending=await broker.decide({id:scopedPending.approvalId,approve:true,actor:OWNER_ACTOR});assert.equal(childPending.status,'pending','Task authority requires a separate concrete network decision');assert.equal(calls,1,'wrapper approval cannot grant underlying network authority');
 const scopedResult=await broker.decide({id:childPending.approvalId,approve:true,actor:OWNER_ACTOR});assert.equal(scopedResult.status,'completed');assert.equal(calls,2,'approved exact data adapter calls transport once');
 const missingGrant=await broker.execute({...taskCall,requestId:'missing-parent-grant',operationId:'missing-parent-grant',actor:{...taskActor,grants:{...taskActor.grants,capabilities:['extension.'+manifest.id+'.lookup']}},approved:true});assert.equal(missingGrant.status,'pending','Agent approved flag is never authority');
 await assert.rejects(broker.decide({id:missingGrant.approvalId,approve:true,actor:OWNER_ACTOR}),{code:'PERMISSION_DENIED'});
 assert.equal(calls,2,'installed plugin network permission cannot increase Task authority');
 await runtime.disable({id:manifest.id});await assert.rejects(runtime.invoke({id:manifest.id,capability:'lookup',input:{term:'blocked'}}),{code:'EXTENSION_DISABLED'});
 const service=createCapabilityService({stateDir:path.join(root,'redirect-state')});const originalRequest=https.request,originalHttpRequest=http.request;let hops=0;
 https.request=(options,callback)=>{hops++;const request=new EventEmitter();request.end=()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'http://8.8.8.8/downgraded'};queueMicrotask(()=>callback(response));};request.destroy=error=>{if(error)request.emit('error',error);};return request;};
 http.request=https.request;
 try{await assert.rejects(service.broker.execute({actor:OWNER_ACTOR,capability:'network',approved:true,input:{url:'https://8.8.8.8/start',requireHttps:true}}),{code:'NETWORK_SCOPE_DENIED'});assert.equal(hops,1,'HTTPS requirement is checked before a redirected transport request');}
 finally{https.request=originalRequest;http.request=originalHttpRequest;await service.close();}
 console.log('PASS declarative HTTP plugin install, schema, exact host/query, explicit invocation approval, response parsing, duplicate prevention and disable lifecycle (fixture transport)');
} finally {await runtime?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}

// Synthetic model, actual Managed/Core approval continuation. No remote HTTP call.
async function managedHttpScenario(disableBeforeChild=false){
 const {createCetaMeshServices}=await import('../src/app/service-container.js');const {setTimeout:delay}=await import('node:timers/promises');
 const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-managed-http-'));let services,taskId;const originalHttps=https.request;
 try{
  services=createCetaMeshServices({stateDir:path.join(isolated,'state'),dataRoot:path.join(isolated,'data'),resourceRoot:isolated,sourceRoot:isolated});
  const source=path.join(isolated,'plugin');fs.mkdirSync(source);const id='test.managed-http',cap='extension.'+id+'.lookup';
  const manifest={manifestVersion:1,id,name:'Managed HTTP fixture',version:'1.0.0',type:'external-api',entry:'api.json',permissions:['network'],network:{hosts:['8.8.8.8']},scope:{paths:[]},capabilities:[{id:'lookup',requires:['network'],inputSchema:{type:'object',additionalProperties:false,properties:{term:{type:'string'}},required:['term']}}]};
  fs.writeFileSync(path.join(source,'extension.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(source,'api.json'),JSON.stringify({schemaVersion:1,protocol:'http-json-v1',endpoints:[{capability:'lookup',url:'https://8.8.8.8/search',method:'GET',queryKeys:['term'],response:'json'}]}));
  const ext=services.extensionService;const review=await ext.execute({method:'ext.review',params:{sourceDir:source}});await ext.execute({method:'ext.install',params:{sourceDir:source,approval:{approved:true,token:review.review.token}}});await ext.execute({method:'ext.enable',params:{id}});
  let requests=0,models=0,lastTool='';
  https.request=(options,callback)=>{requests++;const request=new EventEmitter();request.end=()=>{const response=Readable.from(['{"value":4217}']);response.statusCode=200;response.headers={};queueMicrotask(()=>callback(response));};request.destroy=error=>{if(error)request.emit('error',error);};return request;};
  const provider='managed-http-fixture';services.modelRegistry.register({id:provider,label:'Synthetic model',defaultModel:'fixture',supportsTools:true,listModels:async()=>[{id:'fixture'}],health:async()=>({}),chat:async()=>({text:'unused'}),stream:async function*(request){
   if(models++===0)yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'lookup',capabilityId:cap,arguments:'{"term":"abc"}'}]}};
   else{const tool=request.messages.filter(row=>row.role==='tool').at(-1);lastTool=tool.content;assert.match(tool.content,/4217/);assert.match(tool.content,/statusCode/);yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'PLUGIN_4217_VERIFIED'}]}}};}
   yield {type:'turn/end',data:{reason:{kind:'completed'}}};}});services.providerSecrets.set({provider,apiKey:'synthetic-only'});
  const project=path.join(isolated,'project');fs.mkdirSync(project);const ws=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Plugin Task fixture'}})).workspace;
  const rt=services.taskService.runtime;let task=rt.create({goal:'Read bounded plugin result',workspaceId:ws.id});taskId=task.id;task=rt.setModelConfig({id:taskId,expectedRev:task.rev,modelProvider:provider,model:'fixture'});services.capabilityService.grantTask(taskId,{capabilities:[cap,'network']});
  await services.desktopUiService.execute({method:'ui.task.start',params:{id:taskId,expectedRev:task.rev,agentProvider:'cetamesh'}});
  async function pending(capability){for(let i=0;i<300;i++){const row=services.capabilityService.broker.approvals.list().find(row=>row.request?.taskId===taskId&&row.request.capability===capability);if(row)return row;await delay(10);}throw Error('No pending '+capability+' '+JSON.stringify({models,lastTool,task:rt.get({id:taskId}).task.progress,evidence:rt.get({id:taskId}).task.executionEvidence?.map(row=>({capability:row.capability,status:row.status,code:row.code})),registered:services.capabilityService.broker.registry.list().filter(row=>row.id===cap)}));}
  const first=await pending(cap);const outer=await services.capabilityService.execute({method:'capability.approval.decide',params:{id:first.id,approve:true}});
  assert.equal(outer.resumePending,true,'Managed must remain waiting and transfer continuation to the concrete approval');
  const second=await pending('network');assert.equal(services.toolExecutionCoordinator.pendingTarget(second.id)?.kind,'agent');
  if(disableBeforeChild){await ext.execute({method:'ext.disable',params:{id}});await assert.rejects(services.capabilityService.execute({method:'capability.approval.decide',params:{id:second.id,approve:true}}),{code:'APPROVAL_EXPIRED'});assert.equal(requests,0,'disabled plugin cannot dispatch its pending child network call');console.log('PASS disabled plugin invalidates pending nested dispatch before transport');return;}
  const completed=await services.capabilityService.execute({method:'capability.approval.decide',params:{id:second.id,approve:true}});assert.equal(completed.turnResumed,true);
  for(let i=0;i<300;i++){task=rt.get({id:taskId}).task;if(task.agentReports?.some(row=>row.text.includes('PLUGIN_4217_VERIFIED')))break;await delay(10);}
  assert.equal(requests,1);assert.equal(models,2);assert.ok(task.agentReports.some(row=>row.text.includes('PLUGIN_4217_VERIFIED')));assert.equal(services.capabilityService.broker.approvals.list().filter(row=>row.request?.taskId===taskId).length,0);
  console.log('PASS Managed plugin wrapper -> linked concrete network approval -> parsed result -> same waiting turn resumed once');
 }finally{https.request=originalHttps;if(services&&taskId){const task=services.taskService.runtime.get({id:taskId}).task;try{await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:taskId,expectedRev:task.rev}});}catch{}}
  if(services){await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}assert.equal(path.dirname(isolated),os.tmpdir());fs.rmSync(isolated,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
await managedHttpScenario();
await managedHttpScenario(true);