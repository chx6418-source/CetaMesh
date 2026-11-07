import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createSuiteSandbox,finalizeSuiteSandbox} from '../src/testing/suite-sandbox.js';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createOpenAiCompatibleModelProvider} from '../src/model/index.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
const sandbox=createSuiteSandbox({suiteId:'memory-experience-core'}),root=sandbox.root;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source='export const sum=(a,b)=>a;\n',broken='export const sum=(a,b)=>a-b;\n',fixed='export const sum=(a,b)=>a+b;\n';
const config={enabled:true,tool:'npm',args:['test'],includeExtensions:['.mjs'],timeoutMs:30000,maxRunsPerTurn:2};
const requests=[],decided=new Set();let services,server,taskId,modelFailure,failed=true;
const owner={kind:'user',id:'desktop'},providerId='experience-core-model';
function refs(request){const message=request.messages.find(row=>row.role==='system'&&typeof row.content==='string'&&row.content.startsWith('CetaMesh dynamic context (JSON reference data):\n'));assert.ok(message,'formal Core context reaches the actual model request');return JSON.parse(message.content.slice(message.content.indexOf('\n')+1)).memoryReferences??[];}
async function settle(runId){
 const deadline=Date.now()+40000;
 while(Date.now()<deadline){
  if(modelFailure)throw modelFailure;
  for(const approval of services.capabilityService.broker.approvals.list())if(approval.status==='pending'&&approval.request.taskId===taskId&&!decided.has(approval.id)){
   assert.ok(['filesystem.write','test.run'].includes(approval.request.capability));decided.add(approval.id);
   assert.equal((await services.capabilityService.execute({method:'capability.approval.decide',params:{id:approval.id,approve:true}})).status,'completed');
  }
  const task=services.taskService.runtime.get({id:taskId}).task;
  if(task.executionObservation?.state==='awaiting-review'&&(!runId||task.executionObservation.runId===runId))return task;
  await delay(20);
 }
 throw Error('Owned composed Core run did not settle');
}
async function candidates(sourceTaskId=taskId){return (await services.memoryService.execute({method:'memory.candidates.list'})).candidates.filter(row=>row.experience?.trigger.taskId===sourceTaskId);}
async function close(){if(!services)return;for(const service of [services.chatService,services.agentService,services.managedAgent,services.capabilityService,services.pluginCenterService,services.extensionService,services.channelService,services.bionicService])await service?.close?.();services=null;}
try{
 const project=path.join(root,'project');fs.mkdirSync(project);
 fs.writeFileSync(path.join(project,'sum.mjs'),source);
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node verify.mjs'}}));
 fs.writeFileSync(path.join(project,'verify.mjs'),"import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5,'R09_CURRENT_SOURCE');console.log('R09_VERIFIED');\n");
 for(const args of [['init','-q',project],['-C',project,'config','core.autocrlf','false'],['-C',project,'add','.'],['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','baseline']])execFileSync('git',args,{windowsHide:true,stdio:'ignore'});
 server=http.createServer(async(request,response)=>{try{
  if(request.url==='/v1/models'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  assert.equal(request.url,'/v1/chat/completions');let raw='';for await(const part of request)raw+=part;
  const body=JSON.parse(raw);requests.push(body);const index=requests.length;
  let tool;
  if([1,2,5,6].includes(index)){const content=index===1||index===5?broken:fixed;tool={index:0,id:'experience-write-'+index,type:'function',function:{name:'cap_filesystem_write',arguments:JSON.stringify({path:'sum.mjs',expectedHash:sha(index===1?source:index===5?fixed:broken),content})}};}
  if(index===2)assert.ok(body.messages.some(row=>row.role==='tool'&&row.content.includes('R09_CURRENT_SOURCE')),'actual Node failure reaches the repair inference');
  if(index===3)assert.ok(body.messages.some(row=>row.role==='tool'&&row.content.includes('R09_VERIFIED')),'fresh independent pass reaches final report');
  const delta=tool?{tool_calls:[tool]}:{content:'报告仅引用当前 Core 观察；Owner 验收独立。'};
  response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
 }catch(error){modelFailure=error;response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'Owned fixture failed'}}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const secrets=createProviderSecrets({root:path.join(root,'credentials')});secrets.set({provider:providerId,apiKey:'synthetic-local-only'});
 services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:secrets});
 services.modelRegistry.register(createOpenAiCompatibleModelProvider({id:providerId,label:'Local owned experience fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',defaultModel:'fixture',supportsTools:true,secrets}));
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Experience proof project'}})).workspace;
 await services.workspaceService.execute({method:'workspace.settings',params:{id:workspace.id,patch:{postWriteVerification:config}}});
 const created=await services.desktopUiService.execute({method:'ui.task.create',params:{goal:'修复项目校验，用 Core 实际回执作为条件参考。',workspaceId:workspace.id,agentProvider:'cetamesh',modelProvider:providerId,model:'fixture',requestId:'experience-proof-task',collaboration:{enabled:true,allowUnknownCost:false,prepareNative:false,verification:{editablePaths:['sum.mjs'],testFiles:['verify.mjs']}}}});
 taskId=created.task.id;const task=await settle();assert.equal(requests.length,3);assert.equal(task.acceptance[0].met,false);
 let pending=[];for(let index=0;index<150;index++){pending=await candidates();if(pending.length)break;await delay(20);}
 assert.equal(pending.length,1,'the ordinary composed Core creates the experience candidate after a real settled fail/repair/pass, without direct recorder calls');
 assert.equal(pending[0].experience.trigger.kind,'failure-recovery');assert.equal(pending[0].status,'pending');
 const memory=(await services.memoryService.execute({method:'memory.candidates.confirm',params:{id:pending[0].id,decision:'accept'}})).memory;
 assert.equal(memory.experience.state,'trial');
 let sameSession=task.currentAgent.sessionId;
 await services.agentBroker.send({provider:'cetamesh',sessionId:sameSession,content:'读取项目当前条件参考并报告，不运行工具。',runId:'experience-recall-run'});
 await settle('experience-recall-run');assert.equal(requests.length,4);
 const recalled=refs(requests[3]).find(row=>row.memoryId===memory.id);
 assert.ok(recalled,'actually matching trial experience is present on the real model wire despite the normal Task working-memory reference; actual='+JSON.stringify(refs(requests[3])));
 assert.equal(recalled.provenance.status,'conditional-reference');assert.equal(recalled.experience.meaning,'conditional-reference');assert.equal(recalled.experience.state,'trial');
 assert.match(recalled.excerpt,/条件参考|reference/);assert.ok(Buffer.byteLength(JSON.stringify(refs(requests[3])),'utf8')<=1200);
 assert.equal((await services.memoryService.execute({method:'memory.get',params:{id:memory.id}})).memory.experience.outcomes.length,0,'a report-only run cannot fabricate a machine observation');
 await services.agentBroker.send({provider:'cetamesh',sessionId:sameSession,content:'根据已读取条件参考继续检查：按实际新回执记录观察。',runId:'experience-observation-run'});
 const observationTask=await settle('experience-observation-run');assert.equal(requests.length,7);
 assert.ok(refs(requests[4]).some(row=>row.memoryId===memory.id),'the observation Run really received this reference before its tool operations');
 assert.deepEqual(observationTask.executionEvidence.filter(row=>row.source==='core-test'&&row.runId==='experience-observation-run').map(row=>row.exitCode),[1,0]);
 let observed;for(let index=0;index<150;index++){observed=(await services.memoryService.execute({method:'memory.get',params:{id:memory.id}})).memory;if(observed.experience.outcomes.length)break;await delay(20);}
 assert.equal(observed.experience.outcomes.length,1,'Core records a later actual verified result only for experience it really recalled in this Run');
 assert.equal(observed.experience.outcomes[0].runId,'experience-observation-run');assert.equal(observed.experience.state,'trial','machine observations never promote Owner trial advice');
 for(let index=0;index<300&&(await candidates()).length<2;index++)await delay(20);
 assert.equal((await candidates()).length,2,'an idle settled Run can finish its separate optional candidate write before the next Run starts');
 await services.taskService.execute({method:'task.memory.link',params:{id:taskId,expectedRev:services.taskService.runtime.get({id:taskId}).task.rev,memoryId:memory.id,note:'Owner linked conditional reference'}});
 const proof=await services.workspaceService.collectContentProof(workspace.id,{expectedRoot:project});
 const memoryPacket=services.continuityService.runtime.buildHandoffPacket({taskId,workspaceFacts:{workspaceId:workspace.id,contentProof:proof}});
 const packetReference=memoryPacket.workingMemory.find(row=>row.memoryId===memory.id);
 assert.equal(packetReference.content,memory.content);assert.equal(packetReference.provenance.status,'conditional-reference');assert.equal(packetReference.experience.meaning,'conditional-reference');
 await services.workspaceService.execute({method:'workspace.settings',params:{id:workspace.id,patch:{postWriteVerification:{...config,maxRunsPerTurn:1}}}});
 const changedPacket=services.continuityService.runtime.buildHandoffPacket({taskId,workspaceFacts:{workspaceId:workspace.id,contentProof:proof}});
 const unavailable=changedPacket.workingMemory.find(row=>row.memoryId===memory.id);
 assert.notEqual(unavailable.content,memory.content,'changed conditions omit the reference body without dropping its source identity');assert.match(unavailable.content,/conditional|条件参考/);
 assert.equal(services.taskService.runtime.get({id:taskId}).task.currentAgent.sessionId,sameSession,'checking unavailable optional advice never stops the current executor');
 await services.workspaceService.execute({method:'workspace.settings',params:{id:workspace.id,patch:{postWriteVerification:config}}});
 const handoff=await services.continuityService.runtime.rollover({taskId,reason:'Owner synthetic verification of conditional Memory continuity',targetProvider:'cetamesh',coding:true,modelProvider:providerId,model:'fixture'});
 assert.equal(handoff.taskId,taskId);assert.notEqual(handoff.to.sessionId,sameSession);sameSession=handoff.to.sessionId;
 assert.equal(services.continuityService.runtime.latestPacket({taskId}).packet.workingMemory.find(row=>row.memoryId===memory.id).experience.meaning,'conditional-reference');
 await services.memoryService.execute({method:'memory.experience.transition',params:{id:memory.id,expectedRev:observed.rev,state:'retired'}});
 const beforeRetiredRequest=requests.length;
 await services.agentBroker.send({provider:'cetamesh',sessionId:sameSession,content:'再次报告项目可用参考，不运行工具。',runId:'experience-retired-run'});await settle('experience-retired-run');
 assert.ok(!refs(requests[beforeRetiredRequest]).some(row=>row.memoryId===memory.id),'retired advice is omitted from the actual next request');
 assert.equal((await candidates()).length,2,'report-only later runs cannot duplicate either real recovery candidate');
 const ownerProject=path.join(root,'owner-project');fs.mkdirSync(ownerProject);fs.writeFileSync(path.join(ownerProject,'README.md'),'Owned correction source project.\n');
 const ownerWorkspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:ownerProject,name:'Owner correction source project'}})).workspace;
 const chat=await services.chatService.execute({method:'chat.sessions.create',params:{title:'Owner correction source'}});
 await services.chatService.execute({method:'chat.config.set',params:{id:chat.id,config:{workspaceId:ownerWorkspace.id,agentProvider:'cetamesh',modelProvider:providerId,model:'fixture',reasoning:'off',mode:'chat'}}});
 await services.chatService.execute({method:'chat.send',params:{id:chat.id,text:'更正：这个项目的说明采用简洁中文，保留用户陈述与机器观察的区别。',clientMessageId:'experience-owner-correction'}});
 let ownerTaskId;for(let index=0;index<500;index++){const status=await services.chatService.execute({method:'chat.status',params:{id:chat.id}});if(status.lastState==='error')throw Error('Owned Chat setup failed: '+status.lastErrorCode);ownerTaskId=status.taskId;if(ownerTaskId&&(await candidates(ownerTaskId)).some(row=>row.experience.trigger.kind==='owner-correction'))break;await delay(20);}
 assert.ok(ownerTaskId,'ordinary configured Chat creates its Task through the existing platform route');
 const correction=(await candidates(ownerTaskId)).find(row=>row.experience.trigger.kind==='owner-correction');
 const correctedTask=services.taskService.runtime.get({id:ownerTaskId}).task;
 assert.equal(correctedTask.ownerContext.sessionId,chat.id,'the actual Task Owner source is the linked Chat id, not the Agent Session id');
 assert.ok(correction,'an actual Task-linked Chat correction produces an attributed project candidate');
 assert.equal(correction.experience.trigger.ownerMessageId,'experience-owner-correction');assert.deepEqual(correction.experience.evidence,[]);assert.equal(correction.experience.conditions.tool,null);
 const faultProject=path.join(root,'optional-source-project');fs.mkdirSync(faultProject);fs.writeFileSync(path.join(faultProject,'README.md'),'Owned optional source failure.\n');
 const faultWorkspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:faultProject,name:'Optional source failure'}})).workspace;
 const faultChat=await services.chatService.execute({method:'chat.sessions.create',params:{title:'Optional source failure'}});
 await services.chatService.execute({method:'chat.config.set',params:{id:faultChat.id,config:{workspaceId:faultWorkspace.id,agentProvider:'cetamesh',modelProvider:providerId,model:'fixture',mode:'chat'}}});
 const originalOwnerSource=services.chatService.ownerSourceForTaskRun,originalSchedule=services.autonomousHandoff.scheduleSettled;
 const settled=[];let sourceErrors=0;
 services.chatService.ownerSourceForTaskRun=request=>{if(request.chatId===faultChat.id){sourceErrors++;throw Object.assign(Error('Owned optional source read failure'),{code:'EIO'});}return originalOwnerSource(request);};
 services.autonomousHandoff.scheduleSettled=payload=>{settled.push(payload);return originalSchedule(payload);};
 try{
  await services.chatService.execute({method:'chat.send',params:{id:faultChat.id,text:'报告当前项目状态，不运行工具。',clientMessageId:'experience-optional-source-failure'}});
  let faultTask;for(let index=0;index<300;index++){const status=await services.chatService.execute({method:'chat.status',params:{id:faultChat.id}});if(status.taskId){faultTask=services.taskService.runtime.get({id:status.taskId}).task;if(faultTask.executionObservation?.state==='awaiting-review'&&settled.some(row=>row.taskId===faultTask.id))break;}await delay(20);}
  assert.equal(sourceErrors,1);assert.equal(faultTask.executionObservation.state,'awaiting-review');
  assert.equal(settled.filter(row=>row.taskId===faultTask.id).length,1,'optional Owner source EIO cannot skip or duplicate the existing settled handoff workflow');
  assert.deepEqual(await candidates(faultTask.id),[],'unavailable Owner source is never replaced with guessed model text');
 }finally{services.chatService.ownerSourceForTaskRun=originalOwnerSource;services.autonomousHandoff.scheduleSettled=originalSchedule;}
 assert.equal(services.taskService.runtime.get({id:taskId}).task.acceptance[0].met,false);
 const beforeRestart=services.taskService.runtime.get({id:taskId}).task.executionEvidence;
 const beforeMemory=(await services.memoryService.execute({method:'memory.get',params:{id:memory.id}})).memory;
 const candidateIds=(await candidates()).map(row=>row.id).sort(),requestsBeforeRestart=requests.length;
 await close();services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:secrets});
 assert.deepEqual((await services.memoryService.execute({method:'memory.get',params:{id:memory.id}})).memory,beforeMemory);
 assert.deepEqual((await candidates()).map(row=>row.id).sort(),candidateIds);assert.deepEqual(services.taskService.runtime.get({id:taskId}).task.executionEvidence,beforeRestart);
 assert.equal(requests.length,requestsBeforeRestart,'Core restart never replays model requests or tool operations to recreate learned advice');
 console.log('PASS composed Task learning, actual conditional recall/observations, unchanged semantic acceptance, Owner Chat source, formal fresh-Session handoff, inapplicable-body omission and restart without replay');
 failed=false;
}finally{await close();if(server)await new Promise(resolve=>server.close(resolve));finalizeSuiteSandbox({sandbox,failed,keepFailed:failed});}
