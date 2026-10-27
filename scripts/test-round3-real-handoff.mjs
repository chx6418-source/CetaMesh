// Hybrid acceptance: real Core/Managed + deterministic local model; real Codex CLI/account.
// Never report the local model as a real paid Provider. All writes are disposable fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCetaMeshServices} from '../src/app/service-container.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-round3-real-'));
let services,taskId;
async function idle(assignment){
  const until=Date.now()+120000;
  while(Date.now()<until){const status=await services.agentBroker.status(assignment);if(status.running===false)return;await new Promise(r=>setTimeout(r,100));}
  assert.fail('Executor did not reach confirmed idle');
}
try{
  const project=path.join(root,'project');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'sample.txt'),'4217');
  for(const args of [['init','-q',project],['-C',project,'add','sample.txt'],['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture']])execFileSync('git',args,{stdio:'ignore'});
  services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging')});
  const health=await services.agentBroker.health('codex');assert.equal(health.available,true);assert.equal(health.authenticated,true);
  let modelCalls=0;const observedReceipts=[],toolResponses=[];
  services.modelRegistry.register({id:'round3-local-model',label:'Deterministic acceptance model',supportsTools:true,
    health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('stream expected');},
    stream:async function*(request){
      if(String(request.messages.filter(row=>row.role==='user').at(-1)?.content??'').includes('此回合只确认恢复事实')){
        yield{type:'assistant/message',data:{message:{content:[{type:'text',text:'LOCAL_BOOTSTRAP_ACK_ONLY'}]}}};
        yield{type:'turn/end',data:{reason:{kind:'completed'}}};return;
      }
      const tool=request.messages.filter(row=>row.role==='tool').at(-1);
      if(tool)toolResponses.push(tool.content);
      if(tool?.content?.includes('proof.txt')&&!tool.content.includes('error'))observedReceipts.push(tool.content);
      if(modelCalls++%2===0)yield{type:'assistant/tool-calls',data:{toolCalls:[{id:'new-call-'+modelCalls,capabilityId:'operation.continue',arguments:JSON.stringify({operationRef:'write-proof-once',input:{path:'proof.txt',content:'4217'}})}]}};
      else yield{type:'assistant/message',data:{message:{content:[{type:'text',text:'LOCAL_MANAGED_CONTINUATION_OBSERVED'}]}}};
      yield{type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  services.providerSecrets.set({provider:'round3-local-model',apiKey:'synthetic-local-only'});
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Round3 hybrid acceptance'}})).workspace;
  const security=await services.desktopUiService.execute({method:'ui.agent.security',params:{provider:'codex',workspaceId:workspace.id}});
  const consent=await services.desktopUiService.execute({method:'ui.agent.authorize',params:{provider:'codex',workspaceId:workspace.id,fingerprint:security.fingerprint}});
  await services.capabilityService.execute({method:'capability.approval.decide',params:{id:consent.approvalId,approve:true}});
  let task=services.taskService.runtime.create({workspaceId:workspace.id,goal:'The Owner-planned write-proof-once writes proof.txt once. Preserve it. Read proof.txt and sample.txt; reply HYBRID_REAL_CODEX_4217. Do not rewrite files or repeat completed operations.'});taskId=task.id;
  task=services.taskService.runtime.setModelConfig({id:taskId,expectedRev:task.rev,modelProvider:'round3-local-model',model:'fixture'});
  services.capabilityService.grantTask(taskId);
  await services.capabilityService.execute({method:'capability.operation.prepare',params:{taskId,workspaceId:workspace.id,operationId:'write-proof-once',capability:'filesystem.write',input:{path:'proof.txt',content:'4217'}}});
  const started=await services.desktopUiService.execute({method:'ui.task.start',params:{id:taskId,expectedRev:task.rev,agentProvider:'cetamesh',modelProvider:'round3-local-model',model:'fixture'}});
  await idle(started.task.currentAgent);
  let pending;const approvalDeadline=Date.now()+5000;
  do{pending=services.capabilityService.broker.approvals.list().find(row=>row.request?.taskId===taskId&&row.request.capability==='filesystem.write');if(pending)break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<approvalDeadline);
  assert.ok(pending,'Managed actual source write must await Owner approval: '+JSON.stringify({modelCalls,toolResponses,task:services.taskService.runtime.get({id:taskId}).task.progress}));
  await services.capabilityService.execute({method:'capability.approval.decide',params:{id:pending.id,approve:true}});
  task=services.taskService.runtime.get({id:taskId}).task;await idle(task.currentAgent);
  assert.equal(fs.readFileSync(path.join(project,'proof.txt'),'utf8'),'4217');
  // Explicit Owner test choice of Codex's configured native model namespace.
  const outbound=await services.continuityService.runtime.rollover({taskId,targetProvider:'codex',reason:'provider-switch',modelProvider:'',model:'',reasoningEffort:'',relevantFiles:['proof.txt','sample.txt']});
  assert.equal(outbound.task.id,taskId);await idle(outbound.to);
  const events=[],abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10000);
  try{for await(const event of services.agentBroker.follow({...outbound.to,sinceSequence:0,signal:abort.signal})){events.push(event);if(event.type==='turn/end')break;}}
  finally{clearTimeout(timer);abort.abort();}
  const nativeEvents=[],runAbort=new AbortController(),runTimer=setTimeout(()=>runAbort.abort(),120000);
  try{
    const reader=(async()=>{for await(const event of services.agentBroker.follow({...outbound.to,sinceSequence:events.at(-1).seq,signal:runAbort.signal})){nativeEvents.push(event);if(event.type==='turn/end')break;}})();
    await services.agentBroker.send({...outbound.to,content:'The Handoff is committed. Continue the original goal: use a native read to inspect proof.txt and sample.txt, then reply HYBRID_REAL_CODEX_4217. Do not change files or repeat the completed write.'});
    await reader;
  }finally{clearTimeout(runTimer);runAbort.abort();}
  assert.equal(nativeEvents.at(-1)?.data?.reason?.kind,'completed');
  assert.ok(JSON.stringify(nativeEvents.filter(event=>event.type==='assistant/message')).includes('HYBRID_REAL_CODEX_4217'),'real Codex must inspect and answer the same goal after commit');
  const inbound=await services.continuityService.runtime.rollover({taskId,targetProvider:'cetamesh',reason:'provider-switch',modelProvider:'round3-local-model',model:'fixture',relevantFiles:['proof.txt','sample.txt']});
  assert.equal(inbound.task.id,taskId);await idle(inbound.to);
  const managedAbort=new AbortController(),managedTimer=setTimeout(()=>managedAbort.abort(),10000);let managedCursor=0;
  try{for await(const event of services.agentBroker.follow({...inbound.to,sinceSequence:0,signal:managedAbort.signal})){if(event.type==='turn/end'){managedCursor=event.seq;break;}}}
  finally{clearTimeout(managedTimer);managedAbort.abort();}
  const resumedAbort=new AbortController(),resumedTimer=setTimeout(()=>resumedAbort.abort(),10000);const resumedEvents=[];
  try{
    const reader=(async()=>{for await(const event of services.agentBroker.follow({...inbound.to,sinceSequence:managedCursor,signal:resumedAbort.signal})){resumedEvents.push(event);if(event.type==='turn/end')break;}})();
    await services.agentBroker.send({...inbound.to,content:'Now that the Handoff is committed, continue write-proof-once by its explicit operation reference and verify the prior result.'});
    await reader;
  }finally{clearTimeout(resumedTimer);resumedAbort.abort();}
  assert.equal(resumedEvents.at(-1)?.data?.reason?.kind,'completed');
  assert.ok(observedReceipts.length>=2,'source and replacement Managed must both receive the actual operation result: '+JSON.stringify({modelCalls,toolResponses}));
  const operations=services.capabilityService.broker.operationsForTask({taskId,workspaceId:workspace.id});
  assert.equal(operations.filter(row=>row.operationId==='write-proof-once').length,1);
  assert.equal(services.capabilityService.broker.operationRecordForTask({taskId,workspaceId:workspace.id,operationId:'write-proof-once'}).attemptCount,1,'returning Managed must reuse the receipt, not dispatch a second write');
  assert.equal(fs.readFileSync(path.join(project,'proof.txt'),'utf8'),'4217');
  assert.deepEqual(services.taskService.runtime.get({id:taskId}).task.agentHistory.map(row=>row.provider),['cetamesh','codex','cetamesh']);
  console.log('PASS HYBRID: local-model Managed -> real Codex -> local-model Managed; same Task/Workspace and one proven write dispatch');
}finally{
  if(services&&taskId){const task=services.taskService.runtime.get({id:taskId}).task;if(!['cancelled','completed','failed'].includes(task.status))await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:taskId,expectedRev:task.rev}});}
  if(services){await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('cetamesh-round3-real-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
