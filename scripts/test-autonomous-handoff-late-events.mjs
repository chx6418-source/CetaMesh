import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {defineAgentProvider} from '../src/agent/agent-provider.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {OWNER_ACTOR} from '../src/capability/types.js';

const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function until(predicate,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const result=predicate();if(result)return result;await delay(10);}throw Error('Timed out: '+label);}

// Catch permanent source failure and lost terminal events at the real Core boundaries.
// Only model/provider I/O is synthetic; Broker, Follow, Task, policy and Continuity are real.
async function scenario(kind,control='continue'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-handoff-late-'));
 const held=gate(),sourceResults=[],settledResults=[],notices=[],events=[],sent=[];
 let services,taskId,sequence=0,modelCalls=0,terminalHeld=false;
 try{
  const project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'fixture.txt'),'local fixture');
  for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture']])execFileSync('git',args,{stdio:'ignore'});
  const secrets=createProviderSecrets({root:path.join(root,'synthetic-secrets')});
  secrets.set({provider:'local-late-fixture',apiKey:'synthetic-local-only'});
  services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:secrets});
  const auto=services.autonomousHandoff,rt=services.taskService.runtime;
  const schedule=auto.schedule.bind(auto),settle=auto.scheduleSettled.bind(auto);
  auto.schedule=payload=>{const work=schedule(payload);work?.then(result=>sourceResults.push(result));return work;};
  auto.scheduleSettled=payload=>{notices.push(payload);const work=settle(payload);work?.then(result=>settledResults.push({payload,result}));return work;};
  const follow=services.agentBroker.follow.bind(services.agentBroker);
  services.agentBroker.follow=async function*(request){for await(const item of follow(request)){
   const event=item.type==='event'?item.event:item;
   if(kind==='source'&&!terminalHeld&&request.provider==='cetamesh'&&event.type==='turn/end'&&event.data.phase==='user'){
    terminalHeld=true;await held.promise;
   }
   yield item;
  }};
  services.modelRegistry.register({id:'local-late-fixture',label:'Local deterministic fixture',defaultModel:'fixture',supportsTools:true,
   health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>({text:'unused'}),
   stream:async function*(){
    if(modelCalls++===0)yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'choose-worker',capabilityId:'agent.delegate.propose',arguments:JSON.stringify({taskKind:'code',difficulty:1,requiredTools:[],instruction:'Return local fixture evidence.'})}]}};
    else yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Local fixture report; Owner evidence still requires review.'}]}}};
    yield {type:'turn/end',data:{reason:{kind:'completed'}}};
   }});
  services.agentBroker.register(defineAgentProvider({id:'local-worker',label:'Local worker',eventProtocol:'turn-v1',
   capabilityExtras:{workspaceBoundary:'capability-broker',assignment:{taskKinds:['code'],tools:[],maxDifficulty:3}},methods:{
    createSession:async()=>({sessionId:'worker-session'}),health:async()=>({available:true,authenticated:true,sessionCapable:true,toolsAvailable:true}),
    status:async()=>({running:false,queued:0,waitingForApproval:false}),cancel:async()=>({cancelled:true}),closeSession:async()=>({closed:true}),
    async send({sessionId,phase,runId}){
     const requestId='worker-'+(++sequence);sent.push({sessionId,phase,runId});
     events.push({type:'assistant/message',seq:++sequence,data:{requestId,phase,runId,message:{content:[{type:'text',text:'Local worker result.'}]}}});
     events.push({type:'turn/end',seq:++sequence,data:{requestId,phase,runId,reason:{kind:'completed'}}});
     if(kind==='acceptance'&&phase==='user'){terminalHeld=true;await held.promise;}
     return {accepted:true,requestId};
    },
    async *follow({signal,sinceSequence=0}){let cursor=sinceSequence;while(!signal.aborted){const next=events.find(row=>row.seq>cursor);if(next){cursor=next.seq;yield next;}else await delay(10);}}
   }}));
  const ids=services.agentBroker.ids.bind(services.agentBroker);services.agentBroker.ids=()=>ids().filter(id=>['cetamesh','local-worker'].includes(id));
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Late-event fixture'}})).workspace;
  let task=rt.create({goal:'Investigate local event ordering',workspaceId:workspace.id});taskId=task.id;
  task=rt.setModelConfig({id:taskId,expectedRev:task.rev,modelProvider:'local-late-fixture',model:'fixture'});
  task=(await services.capabilityService.execute({method:'capability.delegation.authorize',params:{taskId,expectedRev:task.rev,policy:{expiresAt:Date.now()+(control==='expire'?15000:60000),maxDelegations:1,allowUnknownCost:true}}})).task;
  const started=await services.capabilityService.broker.execute({requestId:'initial-'+kind+'-'+control,actor:OWNER_ACTOR,taskId,workspaceId:workspace.id,capability:'agent.run',input:{agentProvider:'cetamesh',modelProvider:'local-late-fixture',model:'fixture',content:'Use the authorized local worker if appropriate.'}});
  assert.equal(started.result.accepted,true);
  await until(()=>terminalHeld,'held terminal event');
  if(kind==='source'){
   await until(()=>sourceResults.length,'source coordination wait ended');
   assert.equal(rt.get({id:taskId}).task.delegationProposal.state,'proposed','a delayed Follow projection must not permanently fail an unclaimed proposal');
  }else{
   const notice=await until(()=>notices.find(row=>row.provider==='local-worker'),'actual external terminal callback');
   // Stale identities and duplicates must neither replace the genuine queued event nor redispatch.
   await auto.scheduleSettled({...notice,runId:'old-run'});
   await auto.scheduleSettled({...notice,sessionId:'old-session'});
   await auto.scheduleSettled({...notice});await auto.scheduleSettled({...notice});
   // Exceed the production acquisition window; expiry waits for the real policy clock.
   await delay(control==='expire'?Math.max(5200,task.delegationPolicy.expiresAt-Date.now()+25):5200);
  }
  if(control==='revoke')rt.revokeDelegationPolicy({id:taskId,expectedRev:rt.get({id:taskId}).task.rev,actor:OWNER_ACTOR});
  if(control==='replace-run')rt.beginExecutionObservation({id:taskId,provider:'local-worker',sessionId:'worker-session',runId:'replacement-run',phase:'user'});
  if(control==='replace-session')rt.attachAgent({id:taskId,expectedRev:rt.get({id:taskId}).task.rev,provider:'local-worker',sessionId:'replacement-session'});
  const closing=control==='close'?auto.close():null;
  held.release();
  if(control==='close'){
   await closing;await delay(100);
   assert.equal(sent.filter(row=>row.phase==='user').length,kind==='source'?0:1,'close must not dispatch deferred work');
   assert.equal(rt.get({id:taskId}).task.agentHistory.length,kind==='source'?1:2,'close cannot drain an automatic return');
  }else if(['revoke','expire','replace-session'].includes(control)){
   await until(()=>!services.capabilityService.completionBlocker(taskId),'revoked dispatch unwound');await delay(100);
   const current=rt.get({id:taskId}).task;
   assert.ok(['blocked','unknown'].includes(current.delegationProposal.state));
   assert.equal(current.agentHistory.filter(row=>row.provider==='cetamesh').length,1,'changed authorization forbids a Managed return');
   assert.equal(sent.filter(row=>row.phase==='user').length,kind==='source'?0:1);
  }else if(control==='replace-run'){
   await until(()=>sourceResults.some(row=>row.status==='awaiting-result'),'dispatch acceptance settled');await delay(100);
   const current=rt.get({id:taskId}).task;
   assert.equal(current.executionObservation.runId,'replacement-run');
   assert.equal(current.executionObservation.state,'running');
   assert.equal(current.agentHistory.length,2,'the obsolete run cannot trigger a Managed return');
   assert.equal(current.delegationProposal.state,'awaiting-result');
  }else{
   await until(()=>rt.get({id:taskId}).task.delegationProposal.state==='needs-review','independent Managed return');
   const current=rt.get({id:taskId}).task;
   assert.deepEqual(current.agentHistory.map(row=>row.provider),['cetamesh','local-worker','cetamesh']);
   assert.equal(sent.filter(row=>row.phase==='user').length,1,'exactly one external user dispatch');
   assert.equal(services.continuityService.runtime.history({taskId}).rollovers.length,2);
   assert.equal(current.delegationPolicy.used,1);
   assert.notEqual(current.status,'completed','reports without Owner machine criteria remain reviewable');
   assert.equal(services.capabilityService.completionBlocker(taskId),null);
  }
  console.log('PASS real Core late '+kind+' event, '+control+' boundary');
 }finally{
  held.release();
  if(services){
   if(taskId){const task=services.taskService.runtime.get({id:taskId}).task;if(!['completed','failed','cancelled'].includes(task.status))services.taskService.runtime.cancel({id:taskId,expectedRev:task.rev,reason:'fixture cleanup'});}
   await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();
  }
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}
const selected=process.argv[2];
for(const [kind,control] of [['source','continue'],['acceptance','continue'],['source','revoke'],['acceptance','revoke'],['acceptance','expire'],['acceptance','replace-run'],['acceptance','replace-session'],['source','close'],['acceptance','close']]){
 if(!selected||selected===kind+':'+control)await scenario(kind,control);
}
