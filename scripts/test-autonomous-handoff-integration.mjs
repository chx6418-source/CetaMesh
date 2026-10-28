import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {defineAgentProvider} from '../src/agent/agent-provider.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {createProviderSecrets} from '../src/providers/secrets.js';

async function scenario(machineContract) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-auto-handoff-integration-'));
 let services,taskId;
 const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 try {
  const project=path.join(root,'project');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'input.txt'),'fixture');
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({private:true,scripts:{test:'node verify.mjs'}}));
  fs.writeFileSync(path.join(project,'verify.mjs'),machineContract
   ? 'import fs from "node:fs";import assert from "node:assert/strict";assert.equal(fs.readFileSync("新增目录/结果.txt","utf8"),"4217");'
   : 'process.stdout.write("FIXTURE_VERIFICATION_OK\\n");');
  for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture']])execFileSync('git',args,{stdio:'ignore'});
  const credentialService=createProviderSecrets({root:path.join(root,'isolated-credential-service')});
  credentialService.set({provider:'automatic-fixture-model',apiKey:'synthetic-local-only'});
  services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:credentialService});
  assert.equal(services.providerSecrets,credentialService);
  let modelCalls=0,verificationCalls=0;
  services.modelRegistry.register({id:'automatic-fixture-model',label:'Deterministic local model',defaultModel:'fixture',supportsTools:true,
   health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>({text:'unused'}),
   stream:async function*(request){
    let call=null;
    if(modelCalls++===0)call={id:'model-choice',capabilityId:'agent.delegate.propose',arguments:JSON.stringify({taskKind:'code',difficulty:2,requiredTools:[],instruction:'Complete the remaining fixture work.'})};
    else if(request.messages.filter(row=>row.role==='user').at(-1)?.content?.startsWith('Independently verify')) {
     const step=verificationCalls++;
     if(step===0)call={id:'verify-diff',capabilityId:'git.diff',arguments:'{}'};
     if(step===1)call={id:'verify-test',capabilityId:'operation.continue',arguments:JSON.stringify({operationRef:'fixture-verification'})};
    }
    if(call)yield {type:'assistant/tool-calls',data:{toolCalls:[call]}};
    else yield {type:'assistant/message',data:{message:{content:[{type:'text',text:machineContract&&request.messages.filter(row=>row.role==='user').at(-1)?.content?.startsWith('Independently verify')?'Long verified report '+'.'.repeat(3000):'Fixture report only; actual evidence is authoritative.'}]}}};
    // Simulated high context must not let normal context rollover steal the delegation boundary.
    yield {type:'turn/end',data:{usage:{inputTokens:120000,outputTokens:5},reason:{kind:'completed'}}};
   }});
  const events=[],sent=[];let sequence=0;
  const fixture=defineAgentProvider({id:'coding-fixture',label:'Isolated coding fixture',eventProtocol:'turn-v1',
   capabilityExtras:{workspaceBoundary:'capability-broker',assignment:{taskKinds:['code'],tools:[],maxDifficulty:3}},
   methods:{
    async createSession(){return {sessionId:'fixture-target-session'};},
    async send({sessionId,content,phase,runId}) {
     const requestId='fixture-'+(++sequence);sent.push({sessionId,content,phase});
     if(phase==='user'&&machineContract) {
      const receipt=await services.capabilityService.applyAgentWorkspaceChanges({taskId,workspaceId:workspace.id,provider:'coding-fixture',sessionId,runId,phase,requestId:'fixture-import-'+runId,
       changes:[{action:'write',path:'新增目录/结果.txt',expectedHash:null,content:'4217',hash:hash('4217')}],summary:'Create the one Owner-scoped fixture file'});
      if(receipt.status==='pending') {
       const until=Date.now()+10000;let imported;
       do {imported=services.capabilityService.workspaceImportStatus(receipt.approvalId);if(imported?.status!=='pending')break;await delay(10);}while(Date.now()<until);
       assert.equal(imported?.status,'completed','fixture must use actual approved Core import');
      }else assert.equal(receipt.status,'completed');
     }
     if(phase==='user')events.push({type:'assistant/message',seq:++sequence,data:{requestId,phase,runId,message:{content:[{type:'text',text:'FIXTURE_RESULT: verify independently.'}]}}});
     events.push({type:'turn/end',seq:++sequence,data:{requestId,phase,runId,reason:{kind:'completed'}}});return {accepted:true,requestId};
    },
    async status(){return {running:false,queued:0,waitingForApproval:false};},
    async health(){return {available:true,installed:true,authenticated:true,sessionCapable:true,toolsAvailable:true};},
    async cancel(){return {cancelled:true};},async closeSession(){return {closed:true};},
    async *follow({signal,sinceSequence=0}){let cursor=sinceSequence;while(!signal?.aborted){const next=events.find(row=>row.seq>cursor);if(next){cursor=next.seq;yield next;continue;}await delay(10);}}
   }});
  services.agentBroker.register(fixture);
  const realIds=services.agentBroker.ids.bind(services.agentBroker);
  services.agentBroker.ids=()=>realIds().filter(id=>['cetamesh','coding-fixture'].includes(id));
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Automatic handoff fixture'}})).workspace;
  const rt=services.taskService.runtime;let task=rt.create({goal:'Implement a bounded coding change',workspaceId:workspace.id,acceptanceCriteria:['The fixed verification script passes and only the declared file is created.']});taskId=task.id;
  task=rt.setModelConfig({id:task.id,expectedRev:task.rev,modelProvider:'automatic-fixture-model',model:'fixture'});
  services.capabilityService.grantTask(task.id);
  services.capabilityService.grantTask(task.id,{capabilities:[...services.capabilityService.principalForTask(task.id).grants.capabilities,'test.run']});
  await services.capabilityService.execute({method:'capability.operation.prepare',params:{taskId,workspaceId:workspace.id,operationId:'fixture-verification',capability:'test.run',input:{tool:'npm',args:['test'],timeoutMs:30000}}});
  const verification=machineContract?{kind:'code-tests',operationId:'fixture-verification',acceptanceIds:task.acceptance.map(row=>row.id),allowedPaths:['新增目录/结果.txt'],unchangedFiles:['package.json','verify.mjs'].map(file=>({path:file,sha256:hash(fs.readFileSync(path.join(project,file)))}))}:null;
  task=(await services.capabilityService.execute({method:'capability.delegation.authorize',params:{taskId,expectedRev:task.rev,policy:{expiresAt:Date.now()+60000,maxDelegations:1,allowUnknownCost:true,verification}}})).task;
  const started=await services.capabilityService.broker.execute({requestId:'auto-initial-turn',actor:OWNER_ACTOR,taskId,workspaceId:workspace.id,capability:'agent.run',input:{agentProvider:'cetamesh',modelProvider:'automatic-fixture-model',model:'fixture',content:'Implement a bounded coding change and choose an appropriate executor if needed.'}});
  assert.equal(started.result.accepted,true);
  const deadline=Date.now()+20000;let current;
  while(Date.now()<deadline) {
   for(const approval of services.capabilityService.broker.approvals.list())if(approval.request?.taskId===taskId&&['test.run','workspace.apply'].includes(approval.request.capability))await services.capabilityService.execute({method:'capability.approval.decide',params:{id:approval.id,approve:true}});
   current=rt.get({id:taskId}).task;if(['needs-review','verified','unknown','blocked'].includes(current.delegationProposal?.state))break;await delay(25);
  }
  assert.equal(current.delegationProposal?.state,machineContract?'verified':'needs-review',JSON.stringify({proposal:current.delegationProposal,status:current.status}));
  assert.equal(current.executionEvidence.findLast(row=>row.capability==='test.run'&&row.source==='core-test')?.exitCode,0);
  assert.ok(modelCalls>=5);assert.equal(sent.filter(row=>row.phase==='user').length,1);assert.match(sent.find(row=>row.phase==='user').content,/remaining fixture work/);
  assert.deepEqual(current.agentHistory.map(row=>row.provider),['cetamesh','coding-fixture','cetamesh']);
  assert.equal(services.continuityService.runtime.history({taskId}).rollovers.length,2);
  if(machineContract) {
   assert.equal(current.status,'completed');
   assert.ok(current.result.summary.length<=2000,'bounded delivery summary respects the existing Task contract');
   assert.ok(current.agentReports.some(row=>row.provider==='cetamesh'&&row.text.length>3000),'the longer original report remains retained');
   assert.equal(current.executionEvidence.findLast(row=>row.capability==='git.diff').hasChanges,false,'actual Broker diff excludes untracked files; Core import hashes must supply change proof');
   assert.equal(fs.readFileSync(path.join(project,'新增目录','结果.txt'),'utf8'),'4217');
  }else assert.notEqual(current.status,'completed','a model report cannot complete a Task without a machine contract');
  console.log('PASS actual Core/Continuity with high-context fixture Agents; '+(machineContract?'new-file-only import and independent tests satisfy Owner machine criteria':'unverified report retains review'));
 }finally {
  if(services&&taskId){const task=services.taskService.runtime.get({id:taskId}).task;if(task.currentAgent)try{await services.agentBroker.cancel(task.currentAgent);}catch{}
   if(!['cancelled','completed','failed'].includes(task.status))try{services.taskService.runtime.cancel({id:task.id,expectedRev:task.rev,reason:'fixture cleanup'});}catch{}}
  if(services){await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}
await scenario(false);
await scenario(true);
