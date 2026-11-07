import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {defineAgentProvider} from '../src/agent/agent-provider.js';
import {acceptanceHash} from './helpers/autonomous-handoff-acceptance.mjs';
import {readRecoveryParent,requireRecoveryExtensionApproval,createLinkedRecoveryJournal,continueLinkedRecoveryJournal} from './helpers/subscription-recovery-budget.mjs';
import {recoveryFileHashes,createReadonlyWaitObserver,requireRecoveryCheckpoint,pauseRecoveryTaskUi,resumeRecoveryTaskUi,releaseExistingRecoveryTaskUi,rebindRecoveryExecutionConsentUi} from './helpers/real-recovery-observation.mjs';
import {checkOwnedCodexObservation} from './helpers/owned-codex-observer-fixture.mjs';

if(process.env.CETAMESH_TEST_OBSERVER_SHAPE_ONLY==='1'){
  console.log(JSON.stringify({observerShape:await checkOwnedCodexObservation()}));process.exit(0);
}

const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-recovery-preparation-'));
let services,taskId,decisionPromise,readyPid,waitChild,phase='wait',step=0,done=false;
const evidence={nativeModelCalls:0,nativeDispatches:0,syntheticManaged:true,dispatches:[],api:[],guardChecks:0};
const guard=fn=>{fn();evidence.guardChecks++;};
const read=()=>services.taskService.runtime.get({id:taskId}).task;
async function until(fn,predicate,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(predicate(value))return value;await delay(40);}throw Error('Preparation timeout: '+label);}
try{
  evidence.observerShape=await checkOwnedCodexObservation();
  // Linked-ledger fixture proves cumulative counts and fail-closed approval. It
  // is deliberately separate from the real retained Main evidence and quota.
  const parentRoot=path.join(root,'fixture-main');fs.mkdirSync(parentRoot);
  const rows=[{sequence:1,kind:'limits',maxDispatches:6,maxUserTurns:3},{sequence:2,kind:'user-turn-reserved',userTurn:1}];
  for(const [index,[provider,phase]]of [['cetamesh','user'],['codex','bootstrap'],['codex','user'],['cetamesh','bootstrap'],['cetamesh','user']].entries()){
    rows.push({sequence:rows.length+1,kind:'dispatch-reserved',dispatch:index+1,provider,phase});rows.push({sequence:rows.length+1,kind:'dispatch-reply',dispatch:index+1,accepted:true});}
  fs.writeFileSync(path.join(parentRoot,'dispatch-budget.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  fs.writeFileSync(path.join(parentRoot,'acceptance-evidence.json'),JSON.stringify({verified:true,taskStatus:'completed',verifiersRetained:true,changedSourceFilesDuringRun:[],
    limits:{dispatches:5,userTurns:1,maxDispatches:6,maxUserTurns:3},subscriptionFingerprint:'a'.repeat(64),project:path.join(root,'fixture-project')}));
  const parent=readRecoveryParent(path.join(parentRoot,'acceptance-evidence.json'));
  const approvalFile=path.join(root,'fixture-approval.json'),approval={approved:false,kind:'codex-subscription-pause-resume-budget-v1',maxDispatches:8,maxUserTurns:3,
    previousMaxDispatches:6,parentEvidenceSha256:parent.evidenceSha256,parentJournalSha256:parent.journalSha256,project:parent.evidence.project,
    ownerApprovalReference:'Synthetic guard-only approval, never a real acceptance authorization',allowPaidApi:false,scope:'same-project-read-sum-pause-resume-no-writes'};
  fs.writeFileSync(approvalFile,JSON.stringify(approval));guard(()=>assert.throws(()=>requireRecoveryExtensionApproval(approvalFile,parent),{code:'RECOVERY_BUDGET_APPROVAL_REQUIRED'}));
  approval.approved=true;fs.writeFileSync(approvalFile,JSON.stringify(approval));
  const allowed=requireRecoveryExtensionApproval(approvalFile,parent),linkedRoot=parentRoot+'-pause-resume';
  const journal=createLinkedRecoveryJournal(linkedRoot,{parent,approval:allowed});
  guard(()=>assert.equal(journal.snapshot().dispatches,5));journal.reserveUserTurn();
  const sixth=journal.reserveDispatch({provider:'codex',sessionId:'fixture-6',phase:'user'});
  journal.append({kind:'dispatch-reply',dispatch:sixth,accepted:true});journal.close();
  const prefix=fs.readFileSync(journal.file),prefixSha256=acceptanceHash(prefix),failedEvidenceSha256=acceptanceHash('fixture failure evidence');
  const continuation={parent,approval:allowed,expectedPrefixSha256:prefixSha256,failedEvidenceSha256,expectedPreviousSessionId:'fixture-6'};
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,{...continuation,expectedPrefixSha256:'0'.repeat(64)})));
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,{...continuation,approval:{...allowed,sha256:'0'.repeat(64)}})));
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,{...continuation,expectedPreviousSessionId:'another-task-session'})));
  const fixtureLock=path.join(linkedRoot,'linked-dispatch-writer.lock'),fixtureLockBytes='controlled existing writer';
  fs.writeFileSync(fixtureLock,fixtureLockBytes,{flag:'wx'});
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,continuation),{code:'EEXIST'}));
  assert.equal(fs.readFileSync(fixtureLock,'utf8'),fixtureLockBytes);fs.unlinkSync(fixtureLock);
  guard(()=>assert.equal(acceptanceHash(fs.readFileSync(journal.file)),prefixSha256));
  let resumedJournal=continueLinkedRecoveryJournal(linkedRoot,continuation);
  guard(()=>assert.deepEqual(resumedJournal.snapshot(),{dispatches:6,userTurns:2,maxDispatches:8,maxUserTurns:3,baseDispatches:5,baseUserTurns:1}));
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,continuation)));
  const secondPrefix=fs.readFileSync(journal.file),secondFailureSha256=acceptanceHash('fixture attempt two consent failure');
  resumedJournal.close();
  const thirdContinuation={...continuation,attempt:3,expectedPrefixSha256:acceptanceHash(secondPrefix),
    originalFailedEvidenceSha256:failedEvidenceSha256,failedEvidenceSha256:secondFailureSha256};
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,{...thirdContinuation,originalFailedEvidenceSha256:'0'.repeat(64)})));
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,{...thirdContinuation,attempt:4})));
  resumedJournal=continueLinkedRecoveryJournal(linkedRoot,thirdContinuation);
  guard(()=>assert.deepEqual(resumedJournal.snapshot(),{dispatches:6,userTurns:2,maxDispatches:8,maxUserTurns:3,baseDispatches:5,baseUserTurns:1}));
  guard(()=>assert.equal(fs.readFileSync(journal.file).subarray(0,secondPrefix.length).equals(secondPrefix),true));
  const seventh=resumedJournal.reserveDispatch({provider:'codex',sessionId:'fixture-7',phase:'user'});assert.equal(seventh,7);
  resumedJournal.append({kind:'dispatch-reply',dispatch:seventh,accepted:true});
  guard(()=>assert.equal(resumedJournal.snapshot().userTurns,2));
  resumedJournal.reserveUserTurn();resumedJournal.reserveDispatch({provider:'codex',sessionId:'fixture-8',phase:'bootstrap'});
  guard(()=>assert.throws(()=>resumedJournal.reserveDispatch({provider:'codex',sessionId:'no-ninth'}),{code:'ACCEPTANCE_DISPATCH_LIMIT'}));
  guard(()=>assert.equal(fs.readFileSync(journal.file).subarray(0,prefix.length).equals(prefix),true));
  guard(()=>assert.equal(resumedJournal.retainedPrefix.lines.length,5));
  guard(()=>assert.throws(()=>resumedJournal.reserveUserTurn(),{code:'ACCEPTANCE_USER_TURN_LIMIT'}));
  guard(()=>assert.deepEqual(resumedJournal.snapshot(),{dispatches:8,userTurns:3,maxDispatches:8,maxUserTurns:3,baseDispatches:5,baseUserTurns:1}));
  guard(()=>assert.throws(()=>createLinkedRecoveryJournal(linkedRoot,{parent,approval:allowed})));resumedJournal.assertParentUnchanged();resumedJournal.close();
  guard(()=>assert.throws(()=>continueLinkedRecoveryJournal(linkedRoot,continuation)));
  for(const [command,expected]of [['Get-Content -Raw -LiteralPath sum.js','read-sum'],['Start-Sleep -Seconds 30','wait-30s'],
    ['powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"','wait-30s'],['Start-Sleep -Seconds 31',null],['Get-Content -Raw -LiteralPath ../secret',null],['Start-Sleep -Seconds 30; whoami',null]]){
    const observer=createReadonlyWaitObserver();observer.accept(JSON.stringify({type:'item.started',item:{type:'command_execution',id:'fixture',command}})+'\n');
    guard(()=>assert.equal(observer.facts.commands[0].classification,expected));guard(()=>assert.equal(observer.facts.unexpected,expected===null));}

  // Actual Core/Owner/UI APIs with a controlled real Node wait in the synthetic
  // model leaf. No workspace command permission, external account or native
  // stop receipt is fabricated. Native receipt verification remains opt-in.
  const project=path.join(root,'project');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'sum.js'),'exports.sum=(a,b)=>a+b;\n');
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({private:true}));
  const baseline=recoveryFileHashes(project),secrets=createProviderSecrets({root:path.join(root,'data')});secrets.set({provider:'pause-fixture-model',apiKey:'synthetic-local-only'});
  const options={stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),sourceRoot:root,resourceRoot:root,providerSecrets:secrets};
  let securityRevision='fixture-v1';
  const consentFixture=defineAgentProvider({id:'recovery-consent-fixture',label:'Consent lifecycle fixture; no process/model',
    capabilityExtras:{workspaceBoundary:'native-staged',security:{mode:'native',nativeSandboxSupported:true,nativeSandboxMode:'fixture-only',strictIsolationVerified:false}},
    methods:{async createSession(){throw Error('The consent fixture must never create a Session');},async send(){throw Error('The consent fixture must never send');}}});
  const startCore=()=>{
  services=createCetaMeshServices(options);
  services.agentBroker.register({...consentFixture,capabilities:()=>({...consentFixture.capabilities(),security:{...consentFixture.capabilities().security,identity:securityRevision}})});
  const send=services.agentBroker.send.bind(services.agentBroker);services.agentBroker.send=async(r,...rest)=>{assert.equal(r.provider,'cetamesh');evidence.dispatches.push({provider:r.provider,phase:r.phase||'user'});return send(r,...rest);};
  services.modelRegistry.register({id:'pause-fixture-model',label:'Synthetic pause fixture',defaultModel:'fixture',supportsTools:true,
    health:async()=>({configured:true,available:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('Stream only');},
    stream:async function*(request){const tool=(id,capabilityId,input)=>({type:'assistant/tool-calls',data:{toolCalls:[{id,capabilityId,arguments:JSON.stringify(input)}]}});
      const result=id=>JSON.parse(request.messages.filter(row=>row.role==='tool').findLast(row=>row.tool_call_id===id).content);
      if(phase==='wait'){
        if(step++===0)yield tool('dry-read','filesystem.read',{path:'sum.js'});
        else{assert.equal(result('dry-read').status,'completed');
          waitChild=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',windowsHide:true});
          decisionPromise=new Promise((resolve,reject)=>{waitChild.once('error',reject);waitChild.once('close',(code,signal)=>resolve({code,signal}));});
          await new Promise((resolve,reject)=>{waitChild.once('spawn',()=>{readyPid=waitChild.pid;resolve();});waitChild.once('error',reject);});
          const aborted=()=>waitChild.kill();request.signal.addEventListener('abort',aborted,{once:true});
          try{if(request.signal.aborted)aborted();await decisionPromise;}finally{request.signal.removeEventListener('abort',aborted);}
          if(request.signal.aborted)throw Object.assign(Error('Synthetic wait cancelled'),{code:'ABORTED'});
          throw Error('Owner missed the controlled wait; this fixture must not silently pass');}
      }else if(step++===0)yield tool('fresh-read','filesystem.read',{path:'sum.js'});
      else{assert.equal(result('fresh-read').status,'completed');done=true;yield{type:'assistant/message',data:{message:{content:[{type:'text',text:'READ_ONLY_RESUME_OBSERVED'}]}}};}
      yield{type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  };
  startCore();
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Controlled pause/resume preparation'}})).workspace;
  const originalScope=await services.desktopUiService.execute({method:'ui.agent.security',params:{provider:consentFixture.id,workspaceId:workspace.id}});
  const originalConsent=await services.desktopUiService.execute({method:'ui.agent.authorize',params:{provider:consentFixture.id,workspaceId:workspace.id,fingerprint:originalScope.fingerprint}});
  await services.capabilityService.execute({method:'capability.approval.decide',params:{id:originalConsent.approvalId,approve:true}});
  assert.equal(services.agentBroker.assertExecutionConsent(consentFixture.id,{workspaceId:workspace.id}).authorized,true);
  const created=services.taskService.runtime.create({goal:'Read the fixture and enter the specifically approved controlled wait',workspaceId:workspace.id});taskId=created.id;
  services.capabilityService.grantTask(taskId,{capabilities:['filesystem.read','operation.read']});
  const checkpoint=read().checkpoint;assert.equal(checkpoint,null,'Match the actual failed native Task: no historical checkpoint was ever set');
  await services.desktopUiService.execute({method:'ui.task.start',params:{id:taskId,expectedRev:read().rev,agentProvider:'cetamesh',modelProvider:'pause-fixture-model',model:'fixture'}});
  await until(()=>readyPid,value=>Number.isSafeInteger(value)&&value>0,'owned Node wait readiness');
  evidence.waitPidObserved=true;const before=read();evidence.api.push({method:'ui.task.pause',taskId});
  const beforeRefusal=evidence.dispatches.length;
  await assert.rejects(()=>releaseExistingRecoveryTaskUi(services,taskId,{...before.currentAgent,runId:before.executionObservation.runId}),{code:'TASK_RECOVERY_NOT_REQUIRED'});
  assert.equal(evidence.dispatches.length,beforeRefusal,'A real Core recovery refusal must consume no send');
  assert.equal(read().status,'running');evidence.liveRecoveryRefused=true;
  const paused=await pauseRecoveryTaskUi(services,taskId,'Cancel only the controlled fixture wait and pause its Task');
  assert.equal(paused.task.status,'paused');assert.deepEqual(read().checkpoint,checkpoint);
  const cancelled=await decisionPromise;evidence.controlledWaitDecision=cancelled;
  let processAlive=false;try{process.kill(readyPid,0);processAlive=true;}catch{}assert.equal(processAlive,false,'The owned Node wait must actually stop');
  assert.deepEqual(recoveryFileHashes(project),baseline);
  // Reload the same persisted Task/Core store, then exercise the exact formal
  // release route used before dispatch seven. The original goal stays intact.
  for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','pluginCenterService','extensionService','channelService','bionicService'])await services[name]?.close();
  services=null;startCore();
  assert.throws(()=>services.agentBroker.assertExecutionConsent(consentFixture.id,{workspaceId:workspace.id}),{code:'AGENT_SECURITY_CONFIRMATION_REQUIRED'});
  const beforeRebind=evidence.dispatches.length;
  securityRevision='fixture-changed-policy';
  await assert.rejects(()=>rebindRecoveryExecutionConsentUi(services,{provider:consentFixture.id,workspaceId:workspace.id,previousApprovalId:originalConsent.approvalId}),{code:'AGENT_SECURITY_POLICY_CHANGED'});
  assert.equal(services.capabilityService.broker.approvals.list().length,0,'A changed policy must not request or approve another scope');
  securityRevision='fixture-v1';
  const rebound=await rebindRecoveryExecutionConsentUi(services,{provider:consentFixture.id,workspaceId:workspace.id,previousApprovalId:originalConsent.approvalId});
  assert.equal(rebound.fingerprint,originalScope.fingerprint);assert.notEqual(rebound.approvalId,originalConsent.approvalId);
  assert.equal(services.agentBroker.assertExecutionConsent(consentFixture.id,{workspaceId:workspace.id}).authorized,true);
  assert.equal(evidence.dispatches.length,beforeRebind);evidence.consentReboundWithZeroSends=true;
  assert.equal(read().id,taskId);assert.equal(read().goal,before.goal);assert.deepEqual(read().checkpoint,checkpoint);
  const preflightCount=evidence.dispatches.length;
  const released=await releaseExistingRecoveryTaskUi(services,taskId,{...before.currentAgent,runId:before.executionObservation.runId},()=>assert.deepEqual(recoveryFileHashes(project),baseline));
  assert.equal(evidence.dispatches.length,preflightCount,'Formal inspect/release must not dispatch');
  evidence.reloadedCore={taskId,stopped:released.preview.session.stopped,reviewOperationIds:released.preview.reviewOperationIds,releaseStatus:released.task.status,modelSendsDuringPreflight:0};
  step=0;readyPid=null;
  await services.desktopUiService.execute({method:'ui.task.resume',params:{id:taskId,expectedRev:read().rev,requestId:'dry-continue-original-owner-two'}});
  await until(()=>readyPid,value=>Number.isSafeInteger(value)&&value>0,'continued original goal wait');
  assert.equal(read().goal,before.goal);assert.deepEqual(read().checkpoint,checkpoint);
  await pauseRecoveryTaskUi(services,taskId,'Pause only the continued original approved controlled wait');
  await decisionPromise;assert.deepEqual(recoveryFileHashes(project),baseline);
  evidence.originalGoalContinued=true;
  phase='resume';step=0;evidence.api.push({method:'ui.task.reconcile',action:'resume',taskId});
  const resumed=await resumeRecoveryTaskUi(services,taskId,'cetamesh','Read only sum.js now and report. Do not repeat the wait or request another test.','dry-explicit-read-resume');
  assert.equal(resumed.task.id,taskId);await until(()=>({done,current:read()}),value=>value.done&&value.current.executionObservation?.state==='awaiting-review','fresh readonly report');
  evidence.emptyCheckpointTransition=requireRecoveryCheckpoint(read(),checkpoint);
  assert.equal(evidence.emptyCheckpointTransition.kind,'new-unverified-agent-report');
  assert.ok(read().agentHistory.some(row=>row.sessionId===before.currentAgent.sessionId));
  assert.deepEqual(recoveryFileHashes(project),baseline);
  // Also verify an established Owner checkpoint through another controlled
  // readonly turn; Core must retain it rather than replacing it with the report.
  await pauseRecoveryTaskUi(services,taskId,'Pause the synthetic readonly report before checking retained Owner context');
  await services.taskService.execute({method:'task.checkpoint.set',params:{id:taskId,expectedRev:read().rev,summary:'Established Owner checkpoint must survive the next synthetic report',nextAction:'Read only sum.js'}});
  const establishedCheckpoint=read().checkpoint;step=0;done=false;
  await resumeRecoveryTaskUi(services,taskId,'cetamesh','Read only sum.js and report again; retain the established Owner context.','dry-established-checkpoint-read');
  await until(()=>({done,current:read()}),value=>value.done&&value.current.executionObservation?.state==='awaiting-review','report retaining established Owner checkpoint');
  assert.equal(requireRecoveryCheckpoint(read(),establishedCheckpoint).kind,'retained-historical-checkpoint');
  evidence.establishedCheckpointRetained=true;
  // A real accepted Managed dispatch followed by a controlled harness failure
  // retains the same request ownership fence as the private native attempt.
  const fenceProject=path.join(root,'fence-project');fs.mkdirSync(fenceProject);fs.writeFileSync(path.join(fenceProject,'sum.js'),'exports.sum=(a,b)=>a+b;\n');
  const fenceWorkspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:fenceProject,name:'Failed-dispatch ownership fixture'}})).workspace;
  services.modelRegistry.register({id:'recovery-fence-model',label:'Synthetic aborted provisioning only',defaultModel:'fixture',supportsTools:true,
    health:async()=>({configured:true,available:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('Stream only');},
    stream:async function*(request){await new Promise(resolve=>{if(request.signal.aborted)resolve();else request.signal.addEventListener('abort',resolve,{once:true});});
      throw Object.assign(Error('Owned synthetic provisioning stopped'),{code:'ABORTED'});}});
  const normalSend=services.agentBroker.send.bind(services.agentBroker);let injected=false;
  services.agentBroker.send=async(request,...rest)=>{const result=await normalSend(request,...rest);
    if(!injected&&request.phase!=='bootstrap'){injected=true;throw Object.assign(Error('Controlled observation failure after acceptance'),{code:'RECOVERY_OBSERVATION_UNAVAILABLE'});}return result;};
  const fenceRequestId='recovery-fence-fixture-create';
  await assert.rejects(()=>services.desktopUiService.execute({method:'ui.task.create',params:{workspaceId:fenceWorkspace.id,agentProvider:'cetamesh',modelProvider:'recovery-fence-model',model:'fixture',goal:'No tools; await this controlled cancellation only',requestId:fenceRequestId}}),{code:'RECOVERY_OBSERVATION_UNAVAILABLE'});
  services.agentBroker.send=normalSend;
  const fenced=services.taskService.runtime.list({limit:100}).tasks.find(row=>row.createRequest?.id===fenceRequestId);assert.ok(fenced);
  const fenceSends=evidence.dispatches.length;
  const fencePreview=await services.desktopUiService.execute({method:'ui.task.recovery.inspect',params:{id:fenced.id,automatic:true}});
  assert.equal(fencePreview.canRelease,true);assert.deepEqual(fencePreview.blockers,[]);
  assert.deepEqual(fencePreview.reviewOperationIds,['request:'+fenceRequestId]);
  const fenceRev=services.taskService.runtime.get({id:fenced.id}).task.rev;
  await assert.rejects(()=>releaseExistingRecoveryTaskUi(services,fenced.id,{...fenced.currentAgent,runId:fenced.executionObservation.runId},()=>{},async()=>{},['request:another-instruction']),{code:'RECOVERY_OPERATION_SCOPE_CHANGED'});
  assert.equal(services.taskService.runtime.get({id:fenced.id}).task.rev,fenceRev,'A mismatched retained request must not be released');
  const fenceReleased=await releaseExistingRecoveryTaskUi(services,fenced.id,{...fenced.currentAgent,runId:fenced.executionObservation.runId},()=>{},async()=>{},['request:'+fenceRequestId]);
  assert.equal(fenceReleased.task.status,'paused');assert.equal(evidence.dispatches.length,fenceSends);
  evidence.exactFailedRequestReleasedWithZeroSends=true;evidence.passed=true;
  console.log('PASS linked quota refuses resets/ninth send and actual Core pauses its owned Node wait, preserves Task/checkpoint and resumes a fresh synthetic readonly report');
}finally{
  if(services){if(taskId){try{const current=read();if(!['cancelled','completed','failed'].includes(current.status))await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:taskId,expectedRev:current.rev}});}catch(error){evidence.cleanupCode=error.code||error.name;}}
    for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','pluginCenterService','extensionService','channelService','bionicService'])await services[name]?.close();}
  if(waitChild&&waitChild.exitCode===null)waitChild.kill();if(decisionPromise)await decisionPromise;
  if(process.env.CETAMESH_RECOVERY_PREPARATION_EVIDENCE_DIR){const folder=path.resolve(process.env.CETAMESH_RECOVERY_PREPARATION_EVIDENCE_DIR);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'pause-resume-core-dry-run.json'),JSON.stringify(evidence,null,2)+'\n');}
  console.log(JSON.stringify({recoveryPreparationEvidence:evidence}));assert.ok(path.basename(root).startsWith('cm-recovery-preparation-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
