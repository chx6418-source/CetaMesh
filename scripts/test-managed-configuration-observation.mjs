import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createSuiteSandbox,finalizeSuiteSandbox} from '../src/testing/suite-sandbox.js';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {createOpenAiCompatibleModelProvider} from '../src/model/index.js';
import {createManagedAgentProvider} from '../src/agent/managed-agent-provider.js';
const sandbox=createSuiteSandbox({suiteId:'managed-configuration-observation'}),root=sandbox.root;
let services,server,leafFailure,failed=true;const requests=[],decided=new Set();
const provider='owned-managed-configuration',model='o3-owned';
const close=async()=>{if(!services)return;for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','extensionService'])await services[name]?.close?.();services=null;};
try{
 const project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'proof.txt'),'before');
 server=http.createServer(async(request,response)=>{try{
  if(request.url==='/v1/models'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:model}]}));return;}
  assert.equal(request.url,'/v1/chat/completions');let raw='';for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);assert.equal(body.model,model);assert.equal(body.reasoning_effort,'high','the actual adapter wire carries the selected effort');
  const index=requests.length;let tool;
  if(index===1)tool={index:0,id:'observed-approved-write',type:'function',function:{name:'cap_filesystem_write',arguments:JSON.stringify({path:'proof.txt',expectedHash:createHash('sha256').update('before').digest('hex'),content:'approved'})}};
  else if(index===2)tool={index:0,id:'observed-source-read',type:'function',function:{name:'cap_filesystem_read',arguments:'{"path":"proof.txt"}'}};
  else assert.equal(index,3);
  response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({model:'o3-owned-response',choices:[{index:0,delta:tool?{tool_calls:[tool]}:{content:'The approved write and read returned.'},finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
 }catch(error){leafFailure=error;response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'Owned configuration fixture failed'}}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const secrets=createProviderSecrets({root:path.join(root,'credentials')});secrets.set({provider,apiKey:'owned-synthetic-configuration-only'});
 const options={stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),providerSecrets:secrets,deferOptionalStart:true};
 services=createCetaMeshServices(options);
 const register=()=>services.modelRegistry.register(createOpenAiCompatibleModelProvider({id:provider,label:'Owned configuration model',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',defaultModel:model,supportsTools:true,supportsReasoning:true,reasoningParam:'reasoning_effort',secrets}));register();
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Managed observed configuration'}})).workspace;
 const chat=await services.chatService.execute({method:'chat.sessions.create',params:{title:'Managed real wire configuration'}});
 await services.chatService.execute({method:'chat.config.set',params:{id:chat.id,config:{agentProvider:'cetamesh',workspaceId:workspace.id,modelProvider:provider,model,reasoning:'high',mode:'chat'}}});
 await services.chatService.execute({method:'chat.send',params:{id:chat.id,text:'Update proof.txt through the controlled tool and read it back.',clientMessageId:'managed-configuration-owner'}});
 let status,taskId;
 for(let i=0;i<1500;i++){
  if(leafFailure)throw leafFailure;
  status=await services.chatService.execute({method:'chat.status',params:{id:chat.id}});taskId=status.taskId;
  for(const approval of services.capabilityService.broker.approvals.list())if(approval.status==='pending'&&approval.request.taskId===taskId&&!decided.has(approval.id)){
   assert.equal(approval.request.capability,'filesystem.write');decided.add(approval.id);
   assert.equal((await services.capabilityService.execute({method:'capability.approval.decide',params:{id:approval.id,approve:true}})).status,'completed');
  }
  if(!status.turn&&requests.length>=3)break;await delay(10);
 }
 if(leafFailure)throw leafFailure;assert.ok(taskId);assert.equal(status.turn,null);assert.equal(status.lastState,'idle',JSON.stringify({code:status.lastErrorCode,reason:(await services.managedAgent.provider.status({sessionId:services.taskService.runtime.get({id:taskId}).task.currentAgent.sessionId})).lastReason}));assert.equal(requests.length,3);assert.equal(decided.size,1);
 assert.equal(fs.readFileSync(path.join(project,'proof.txt'),'utf8'),'approved');
 const task=services.taskService.runtime.get({id:taskId}).task;assert.equal(task.executionObservation.state,'awaiting-review');assert.notEqual(task.status,'completed');assert.ok(!task.acceptance.some(row=>row.met));
 const history=await services.chatService.execute({method:'chat.history',params:{id:chat.id}}),last=history.messages.findLast(row=>row.role==='assistant');
 const observed=last.configurationObservations??[];
 assert.equal(observed.length,3,'each real Managed HTTP request remains observable after approval continuation and Chat finalize');
 for(const row of observed){assert.equal(row.providerId,provider);assert.equal(row.requested.model,model);assert.equal(row.requested.reasoning,'high');assert.equal(row.effective.model,model);assert.equal(row.effective.reasoning,'high');assert.equal(row.response.model,'o3-owned-response');assert.equal(row.stage,'response');assert.equal(row.source.effective,'wire-projection');}
 assert.equal(new Set(observed.map(row=>row.requestId)).size,3);assert.equal(status.configurationObservation.requestId,observed.at(-1).requestId);
 const follow=[];for await(const event of services.agentBroker.follow(task.currentAgent)){follow.push(event);if(event.type==='turn/end'&&event.data.reason.kind==='completed')break;}
 const configEvents=follow.filter(row=>row.type==='model/configuration');assert.ok(configEvents.length>=6,'real serialized/response observations travel on existing Agent Follow');
 assert.ok(configEvents.every(row=>row.data.runId===task.executionObservation.runId));
 assert.ok(!JSON.stringify([last,status,configEvents]).includes('owned-synthetic-configuration-only'),'no raw credentials appear in configuration observations');
 const before=JSON.stringify(observed),requestCount=requests.length;await close();services=createCetaMeshServices(options);register();
 const reloaded=(await services.chatService.execute({method:'chat.history',params:{id:chat.id}})).messages.findLast(row=>row.role==='assistant');
 assert.equal(JSON.stringify(reloaded.configurationObservations),before);assert.equal(requests.length,requestCount);
 console.log(JSON.stringify({fixture:'managed-real-wire-configuration',requests:requests.length,approvals:decided.size,retainedObservations:observed.length,actualAgentEvents:configEvents.length,restartWithoutReplay:true,realAccount:false}));
 // A deliberately delayed adapter callback is a lifecycle control, separate
 // from the actual HTTP evidence above. It cannot attach old data to a new Run.
 const callbacks=[],releases=[];
 const controlled=createManagedAgentProvider({
  modelRuntime:{resolveProvider:()=>({configurationControl:{observation:'wire-v1'}}),chat:request=>new Promise(resolve=>{callbacks.push(request.onConfiguration);releases.push(resolve);})},
  capabilityExecutor:()=>{throw Error('No tool is requested by this lifecycle control');},
  taskPrincipalResolver:()=>({taskId:'owned-configuration-task',workspaceId:'owned-configuration-workspace',actor:{kind:'agent',id:'owned-configuration-agent',grants:{taskIds:['owned-configuration-task'],workspaceIds:['owned-configuration-workspace'],capabilities:['filesystem.read']}}})
 });
 const owned=await controlled.provider.createSession({modelProvider:provider,model});
 async function throughEnd(ack,sinceSequence=0){const rows=[];for await(const event of controlled.provider.follow({sessionId:owned.sessionId,sinceSequence})){rows.push(event);if(event.type==='turn/end'&&event.data.requestId===ack.requestId)break;}return rows;}
 try{
  const first=await controlled.provider.send({sessionId:owned.sessionId,content:'First lifecycle turn'});
  for(let i=0;i<100&&!callbacks[0];i++)await delay(5);assert.equal(typeof callbacks[0],'function');
  callbacks[0](observed[0]);releases[0]({text:'{"final":"First controlled response"}'});
  const firstRows=await throughEnd(first),cursor=firstRows.at(-1).seq;
  assert.equal(firstRows.filter(row=>row.type==='model/configuration').length,1);
  const second=await controlled.provider.send({sessionId:owned.sessionId,content:'Second lifecycle turn'});
  for(let i=0;i<100&&!callbacks[1];i++)await delay(5);assert.equal(typeof callbacks[1],'function');
  callbacks[0](observed[0]);callbacks[1](observed[1]);releases[1]({text:'{"final":"Second controlled response"}'});
  const secondRows=await throughEnd(second,cursor),current=secondRows.filter(row=>row.type==='model/configuration');
  assert.equal(current.length,1,'a late previous-turn callback produces no new event');
  assert.equal(current[0].data.requestId,second.requestId);assert.equal(current[0].data.configurationObservation.requestId,observed[1].requestId);
  await controlled.close();callbacks[1](observed[1]);
  const all=await throughEnd(second);assert.equal(all.filter(row=>row.type==='model/configuration').length,2,'closed runtimes ignore retained adapter callbacks');
 }finally{for(const resolve of releases)resolve({text:'{"final":"Fixture cleanup"}'});await controlled.close();}
 console.log('Managed configuration lifecycle: old-turn and closed-runtime callbacks are ignored; legacy data-only requests remain covered by test-managed-agent-provider.');failed=false;
}finally{await close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}finalizeSuiteSandbox({sandbox,failed,keepFailed:failed});}
