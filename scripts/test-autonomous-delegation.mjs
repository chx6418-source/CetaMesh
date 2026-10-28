import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createToolExecutionCoordinator } from '../src/model/tool-execution.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-autonomous-delegation-'));
let now=1700000000000;
try {
 const runtime=createTaskRuntime({stateDir:root,now:()=>now});
 const task=runtime.create({goal:'Implement a bounded coding task',workspaceId:'workspace-a'});
 assert.throws(()=>runtime.setDelegationPolicy({id:task.id,expectedRev:task.rev,actor:{kind:'agent',id:'task:'+task.id},
  policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}}),{code:'PERMISSION_DENIED'});
 const configured=runtime.setDelegationPolicy({id:task.id,expectedRev:task.rev,actor:{kind:'owner',id:'desktop'},
  policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}});
 const running=runtime.start({id:task.id,expectedRev:configured.rev,provider:'cetamesh',sessionId:'managed-a'}).task;
 const observed=runtime.beginExecutionObservation({id:task.id,provider:'cetamesh',sessionId:'managed-a',runId:'run-a',phase:'user'});
 const request={id:task.id,actor:{kind:'agent',id:'task:'+task.id,assignment:{provider:'cetamesh',sessionId:'managed-a'},
  assignmentRevision:observed.authorizationRevision},provider:'cetamesh',sessionId:'managed-a',runId:'run-a',requestId:'proposal-a',
  intent:{taskKind:'code',difficulty:2,requiredTools:['filesystem.read'],instruction:'Complete the remaining coding task.'}};
 assert.throws(()=>runtime.recordDelegationProposal({...request,sessionId:'stale-session'}),{code:'AGENT_ASSIGNMENT_EXPIRED'});
 const proposed=runtime.recordDelegationProposal(request);
 assert.equal(proposed.delegationProposal.state,'proposed');
 assert.equal(runtime.recordDelegationProposal(request).delegationProposal.requestId,'proposal-a');
 assert.throws(()=>runtime.recordDelegationProposal({...request,requestId:'proposal-b'}),{code:'DELEGATION_ALREADY_PROPOSED'});
 assert.throws(()=>runtime.claimDelegationProposal({id:task.id,requestId:'proposal-a',selectedProvider:'codex'}),{code:'DELEGATION_TURN_NOT_COMPLETE'});
 const stalePolicyTask=runtime.create({goal:'Policy must bind the chosen model',workspaceId:'workspace-b'});
 const stalePolicy=runtime.setDelegationPolicy({id:stalePolicyTask.id,expectedRev:stalePolicyTask.rev,actor:{kind:'owner',id:'desktop'},
  policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}});
 const modelChanged=runtime.setModelConfig({id:stalePolicyTask.id,expectedRev:stalePolicy.rev,modelProvider:'changed',model:'new-model'});
 runtime.start({id:stalePolicyTask.id,expectedRev:modelChanged.rev,provider:'cetamesh',sessionId:'changed-session'});
 const changedObs=runtime.beginExecutionObservation({id:stalePolicyTask.id,provider:'cetamesh',sessionId:'changed-session',runId:'changed-run',phase:'user'});
 assert.throws(()=>runtime.recordDelegationProposal({id:stalePolicyTask.id,actor:{kind:'agent',id:'task:'+stalePolicyTask.id,
  assignment:{provider:'cetamesh',sessionId:'changed-session'},assignmentRevision:changedObs.authorizationRevision},
  provider:'cetamesh',sessionId:'changed-session',runId:'changed-run',requestId:'changed-proposal',intent:request.intent}),{code:'DELEGATION_POLICY_DENIED'});
 runtime.observeExecution({id:task.id,provider:'cetamesh',sessionId:'managed-a',runId:'run-a',phase:'user',state:'awaiting-review'});
 const claimed=runtime.claimDelegationProposal({id:task.id,requestId:'proposal-a',selectedProvider:'codex'});
 assert.equal(claimed.delegationProposal.state,'dispatching');
 assert.throws(()=>runtime.claimDelegationProposal({id:task.id,requestId:'proposal-a',selectedProvider:'codex'}),{code:'DELEGATION_ALREADY_CLAIMED'});
 const restarted=createTaskRuntime({stateDir:root,now:()=>now});
 assert.equal(restarted.get({id:task.id}).task.delegationProposal.state,'dispatching','dispatch intent survives restart');
 restarted.recoverInterrupted();
 assert.equal(restarted.get({id:task.id}).task.status,'blocked','restart requires recovery, never replay');
 assert.throws(()=>restarted.claimDelegationProposal({id:task.id,requestId:'proposal-a',selectedProvider:'codex'}));
 const revocable=runtime.create({goal:'Revoke bounded authority',workspaceId:'workspace-revocation'});
 const revocablePolicy=runtime.setDelegationPolicy({id:revocable.id,expectedRev:revocable.rev,actor:{kind:'owner',id:'desktop'},policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}});
 assert.throws(()=>runtime.revokeDelegationPolicy({id:revocable.id,expectedRev:revocablePolicy.rev,actor:{kind:'agent',id:'task:'+revocable.id}}),{code:'PERMISSION_DENIED'});
 const revoked=runtime.revokeDelegationPolicy({id:revocable.id,expectedRev:revocablePolicy.rev,actor:{kind:'owner',id:'desktop'}});
 assert.equal(revoked.delegationPolicy.revokedAt,now,'revocation persists without granting replacement authority');
 const historical=runtime.create({goal:'Historical evidence cannot authorize current automatic delivery',workspaceId:'history-workspace',acceptanceCriteria:['Owner review is still required']});
 let past=runtime.setAcceptance({id:historical.id,expectedRev:historical.rev,acceptanceId:historical.acceptance[0].id,met:true});
 past=runtime.setDelegationPolicy({id:past.id,expectedRev:past.rev,actor:{kind:'owner',id:'desktop'},policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}});
 past=runtime.start({id:past.id,expectedRev:past.rev,provider:'cetamesh',sessionId:'new-current-session'}).task;
 for(const row of [{eventId:'historical-diff',capability:'git.diff',hasChanges:true},{eventId:'historical-test',capability:'test.run',exitCode:0}])runtime.recordToolOutcome({id:past.id,provider:'cetamesh',sessionId:'new-current-session',runId:'old-run',phase:'user',status:'completed',...row});
 const currentObservation=runtime.beginExecutionObservation({id:past.id,provider:'cetamesh',sessionId:'new-current-session',runId:'new-current-run',phase:'user'});
 runtime.recordDelegationProposal({id:past.id,actor:{kind:'agent',id:'task:'+past.id,assignment:{provider:'cetamesh',sessionId:'new-current-session'},assignmentRevision:currentObservation.authorizationRevision},provider:'cetamesh',sessionId:'new-current-session',runId:'new-current-run',requestId:'history-proposal',intent:{taskKind:'code',difficulty:1,requiredTools:[],instruction:'Use current evidence only'}});
 runtime.observeExecution({id:past.id,provider:'cetamesh',sessionId:'new-current-session',runId:'new-current-run',phase:'user',state:'awaiting-review'});
 runtime.claimDelegationProposal({id:past.id,requestId:'history-proposal',selectedProvider:'external-fixture'});
 assert.deepEqual((await runtime.verifyDelegationOutcome({id:past.id})).reasons,['OWNER_MACHINE_VERIFICATION_NOT_CONFIGURED'],'pre-met acceptance and old passing tests cannot authorize automatic completion without a machine contract');
 console.log('PASS Owner-scoped delegation proposal, current-run fence, single claim and crash recovery');
 const {createAutonomousHandoff}=await import('../src/continuity/autonomous-handoff.js');
 const flow=createTaskRuntime({stateDir:path.join(root,'flow'),now:()=>now});
 const flowTask=flow.create({goal:'Code a verified change',workspaceId:'workspace-flow'});
 const flowPolicy=flow.setDelegationPolicy({id:flowTask.id,expectedRev:flowTask.rev,actor:{kind:'owner',id:'desktop'},
  policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}});
 flow.start({id:flowTask.id,expectedRev:flowPolicy.rev,provider:'cetamesh',sessionId:'source-session'});
 const flowObserved=flow.beginExecutionObservation({id:flowTask.id,provider:'cetamesh',sessionId:'source-session',runId:'flow-run',phase:'user'});
 flow.recordDelegationProposal({id:flowTask.id,actor:{kind:'agent',id:'task:'+flowTask.id,
  assignment:{provider:'cetamesh',sessionId:'source-session'},assignmentRevision:flowObserved.authorizationRevision},
  provider:'cetamesh',sessionId:'source-session',runId:'flow-run',requestId:'flow-proposal',
  intent:{taskKind:'code',difficulty:2,requiredTools:['filesystem.read'],instruction:'Implement the remaining change.'}});
 flow.observeExecution({id:flowTask.id,provider:'cetamesh',sessionId:'source-session',runId:'flow-run',phase:'user',state:'awaiting-review'});
 const events=[];
 const fakeBroker={ids:()=>['cetamesh','coding-adapter'],health:async()=>({available:true,authenticated:true,
  sessionCapable:true,toolsAvailable:true}),capabilities:()=>({workspaceBoundary:'native-staged',
  assignment:{taskKinds:['code'],tools:['filesystem.read'],maxDifficulty:3}}),assertExecutionConsent:()=>{}};
 const auto=createAutonomousHandoff({taskRuntime:flow,agentBroker:fakeBroker,now:()=>now,
  capabilityService:{completionBlocker:()=>null,broker:{execute:async request=>{events.push(['dispatch',request]);return {status:'completed',result:{accepted:true}};}}},
  continuityRuntime:{rollover:async request=>{events.push(['handoff',request]);const current=flow.get({id:flowTask.id}).task;
   flow.attachAgent({id:flowTask.id,expectedRev:current.rev,provider:request.targetProvider,sessionId:'destination-session'});
   return {to:{provider:request.targetProvider,sessionId:'destination-session'}};}}});
 const result=await auto.processCompletedTurn({provider:'cetamesh',sessionId:'source-session',runId:'flow-run',phase:'user',outcome:'completed'});
 assert.equal(result.status,'awaiting-result');assert.equal(result.provider,'coding-adapter');
 assert.equal(flow.get({id:flowTask.id}).task.currentAgent.provider,'coding-adapter');
 assert.equal(flow.get({id:flowTask.id}).task.delegationProposal.state,'awaiting-result');
 assert.deepEqual(events.map(row=>row[0]),['handoff','dispatch']);
 assert.equal(events[0][1].automatic,true,'reuse existing bounded Continuity handoff');
 assert.match(events[1][1].input.content,/Code a verified change/,'target receives the Owner goal');
 assert.match(events[1][1].input.content,/Implement the remaining change/,'target receives bounded delegation suggestion');
 assert.match(events[1][1].input.content,/untrusted/i,'model suggestion is explicitly non-authoritative');
 await auto.processCompletedTurn({provider:'cetamesh',sessionId:'source-session',runId:'flow-run',phase:'user',outcome:'completed'});
 assert.equal(events.length,2,'duplicate completion never redispatches');
 console.log('PASS deterministic eligible Agent selection and durable one-time handoff and dispatch');
 const raceRt=createTaskRuntime({stateDir:path.join(root,'race'),now:()=>now});
 const raceTask=raceRt.create({goal:'Original goal',workspaceId:'race-workspace'});
 const racePolicy=raceRt.setDelegationPolicy({id:raceTask.id,expectedRev:raceTask.rev,actor:{kind:'owner',id:'desktop'},
  policy:{expiresAt:now+60000,maxDelegations:1,allowUnknownCost:true}});
 raceRt.start({id:raceTask.id,expectedRev:racePolicy.rev,provider:'cetamesh',sessionId:'race-source'});
 const raceObs=raceRt.beginExecutionObservation({id:raceTask.id,provider:'cetamesh',sessionId:'race-source',runId:'race-run',phase:'user'});
 raceRt.recordDelegationProposal({id:raceTask.id,actor:{kind:'agent',id:'task:'+raceTask.id,assignment:{provider:'cetamesh',sessionId:'race-source'},
  assignmentRevision:raceObs.authorizationRevision},provider:'cetamesh',sessionId:'race-source',runId:'race-run',requestId:'race-proposal',intent:request.intent});
 raceRt.observeExecution({id:raceTask.id,provider:'cetamesh',sessionId:'race-source',runId:'race-run',phase:'user',state:'awaiting-review'});
 let probes=0,raceHandoffs=0;
 const raceBroker={...fakeBroker,health:async()=>{if(++probes===2){const current=raceRt.get({id:raceTask.id}).task;
  raceRt.update({id:raceTask.id,expectedRev:current.rev,goal:'Changed after claim'});}return {available:true,authenticated:true,sessionCapable:true,toolsAvailable:true};}};
 const raceAuto=createAutonomousHandoff({taskRuntime:raceRt,agentBroker:raceBroker,now:()=>now,
  capabilityService:{completionBlocker:()=>null,broker:{execute:async()=>{throw Error('must not dispatch');}}},
  continuityRuntime:{rollover:async()=>{raceHandoffs++;throw Error('must not hand off');}}});
 const raceResult=await raceAuto.processCompletedTurn({provider:'cetamesh',sessionId:'race-source',runId:'race-run',phase:'user',outcome:'completed'});
 assert.equal(raceResult.status,'unknown');assert.equal(raceHandoffs,0,'changed Owner goal must stop before handoff');
 const project=path.join(root,'project');fs.mkdirSync(project);
 const services=createCetaMeshServices({stateDir:path.join(root,'integrated-state'),dataRoot:path.join(root,'integrated-data')});
 try {
  services.agentBroker.register(defineAgentProvider({id:'discoverable-fixture',label:'Discovery test',
   capabilityExtras:{workspaceBoundary:'capability-broker',assignment:{taskKinds:['code'],tools:['filesystem.read'],maxDifficulty:3}},
   methods:{async health(){return {available:true,authenticated:true,sessionCapable:true,toolsAvailable:true};},
    async createSession(){},async send(){},async status(){return {running:false};},async cancel(){},async closeSession(){},async *follow(){}}}));
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Delegation fixture'}})).workspace;
  const rt=services.taskService.runtime;
  const item=rt.create({goal:'Implement the requested task',workspaceId:workspace.id});
  const authorized=await services.capabilityService.execute({method:'capability.delegation.authorize',params:{taskId:item.id,
    expectedRev:item.rev,policy:{expiresAt:Date.now()+60000,maxDelegations:1,allowUnknownCost:true}}});
  const started=rt.start({id:item.id,expectedRev:authorized.task.rev,provider:'cetamesh',sessionId:'managed-integrated'}).task;
  rt.beginExecutionObservation({id:item.id,provider:'cetamesh',sessionId:'managed-integrated',runId:'trusted-run',phase:'user'});
  const actor=services.capabilityService.principalForTask(item.id);
  assert.ok(actor.grants.capabilities.includes('agent.delegate.propose'),'Owner policy enables a bounded proposal');
  const discovered=await services.capabilityService.broker.execute({actor,taskId:item.id,workspaceId:workspace.id,capability:'agent.delegate.candidates',input:{taskKind:'code',difficulty:2,requiredTools:['filesystem.read']}});
  assert.equal(discovered.result.canPropose,true);assert.equal(discovered.result.nextAction,'propose-matching-needs');assert.equal(discovered.result.candidates.find(row=>row.provider==='discoverable-fixture').proposalEligible,true);
  assert.ok(discovered.result.candidates.some(row=>row.provider==='discoverable-fixture'),'model can discover actual eligible capability matches');
  const call={actor,taskId:item.id,workspaceId:workspace.id,capability:'agent.delegate.propose',requestId:'proposal-tool',
   input:{taskKind:'code',difficulty:2,requiredTools:['filesystem.read'],instruction:'Perform remaining implementation.'}};
  await assert.rejects(services.capabilityService.broker.execute(call),{code:'DELEGATION_RUN_MISMATCH'});
  await assert.rejects(services.capabilityService.broker.execute({...call,origin:{targetKind:'agent',sessionId:'managed-integrated',runId:'forged-run',phase:'user'}}),{code:'DELEGATION_RUN_MISMATCH'});
  await assert.rejects(services.capabilityService.broker.execute({...call,requestId:'no-candidate',input:{...call.input,requiredTools:['nonexistent.tool']},origin:{targetKind:'agent',sessionId:'managed-integrated',runId:'trusted-run',phase:'user'}}),{code:'DELEGATION_NO_ELIGIBLE_AGENT'});
  assert.equal(rt.get({id:item.id}).task.delegationProposal??null,null,'unmatched proposal is not queued as accepted');
  const result=await services.capabilityService.broker.execute({...call,origin:{targetKind:'agent',sessionId:'managed-integrated',runId:'trusted-run',phase:'user'}});
  assert.equal(result.status,'completed');assert.equal(result.result.proposed,true);
  assert.equal(rt.get({id:item.id}).task.currentAgent.sessionId,'managed-integrated','proposal never initiates a handoff');
  assert.equal(rt.get({id:item.id}).task.delegationProposal.state,'proposed');
  const next=rt.create({goal:'Implement a different bounded task',workspaceId:workspace.id});
  const nextPolicy=await services.capabilityService.execute({method:'capability.delegation.authorize',params:{taskId:next.id,
    expectedRev:next.rev,policy:{expiresAt:Date.now()+60000,maxDelegations:1,allowUnknownCost:true}}});
  rt.start({id:next.id,expectedRev:nextPolicy.task.rev,provider:'cetamesh',sessionId:'managed-tool'});
  rt.beginExecutionObservation({id:next.id,provider:'cetamesh',sessionId:'managed-tool',runId:'trusted-run-2',phase:'user'});
  let turns=0;
  const modelRuntime={supportsToolCalling:()=>true,chat:async()=>turns++===0
    ? {toolCalls:[{id:'model-proposal',capabilityId:'agent.delegate.propose',arguments:{taskKind:'code',difficulty:2,
       requiredTools:['filesystem.read'],instruction:'Implement the remaining task.'}}]}
    : {text:'Delegation proposed.',toolCalls:[]}};
  const coordinator=createToolExecutionCoordinator({modelRuntime,capabilityBroker:services.capabilityService.broker});
  await coordinator.run({actor:services.capabilityService.principalForTask(next.id),providerId:'fixture',sessionId:'managed-tool',
    turnId:'model-turn-2',runId:'trusted-run-2',phase:'user',targetKind:'agent',scope:{taskId:next.id,workspaceId:workspace.id},
    messages:[{role:'user',content:'Implement the requested task'}],
    manifest:services.capabilityService.broker.list().filter(row=>row.id==='agent.delegate.propose')});
  assert.equal(rt.get({id:next.id}).task.delegationProposal?.runId,'trusted-run-2','model tool coordinator retains the Core run identity');
  for(const id of [item.id,next.id])rt.cancel({id,expectedRev:rt.get({id}).task.rev,reason:'prior fixture completed'});
  let lost=rt.create({goal:'Do not silently recreate a committed target',workspaceId:workspace.id});
  lost=rt.setDelegationPolicy({id:lost.id,expectedRev:lost.rev,actor:{kind:'owner',id:'desktop'},policy:{expiresAt:Date.now()+60000,maxDelegations:1,allowUnknownCost:true}});
  lost=rt.start({id:lost.id,expectedRev:lost.rev,provider:'cetamesh',sessionId:'lost-source'}).task;
  rt.beginExecutionObservation({id:lost.id,provider:'cetamesh',sessionId:'lost-source',runId:'lost-run',phase:'user'});
  services.capabilityService.grantTask(lost.id);
  rt.recordDelegationProposal({id:lost.id,actor:services.capabilityService.principalForTask(lost.id),provider:'cetamesh',sessionId:'lost-source',runId:'lost-run',requestId:'lost-proposal',intent:{taskKind:'code',difficulty:1,requiredTools:[],instruction:'Continue within the original task'}});
  rt.observeExecution({id:lost.id,provider:'cetamesh',sessionId:'lost-source',runId:'lost-run',phase:'user',state:'awaiting-review'});
  const lostClaim=rt.claimDelegationProposal({id:lost.id,requestId:'lost-proposal',selectedProvider:'discoverable-fixture'});
  rt.attachAgent({id:lost.id,expectedRev:lostClaim.rev,provider:'discoverable-fixture',sessionId:'missing-target'});
  rt.recordDelegationTarget({id:lost.id,requestId:'lost-proposal',selectedProvider:'discoverable-fixture',sessionId:'missing-target'});
  const actualStatus=services.agentBroker.status.bind(services.agentBroker);let replacementCreated=false;
  const actualCreate=services.agentBroker.createSession.bind(services.agentBroker);
  services.agentBroker.status=async assignment=>{if(assignment.sessionId==='missing-target')throw Object.assign(Error('missing'),{code:'SESSION_NOT_FOUND'});return actualStatus(assignment);};
  services.agentBroker.createSession=async(...args)=>{replacementCreated=true;return actualCreate(...args);};
  await assert.rejects(services.capabilityService.broker.execute({requestId:'lost-dispatch',actor:{kind:'owner',id:'desktop'},taskId:lost.id,workspaceId:workspace.id,
   capability:'agent.run',input:{agentProvider:'discoverable-fixture',content:lost.goal,delegationRequestId:'lost-proposal',delegationDirection:'outbound'}}),{code:'DELEGATION_TARGET_LOST'});
  assert.equal(replacementCreated,false,'automatic handoff cannot replace a missing committed target behind Continuity');
  services.agentBroker.status=actualStatus;services.agentBroker.createSession=actualCreate;

 } finally {await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}
 console.log('PASS Owner-bound Broker proposal and trusted user-turn identity');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
