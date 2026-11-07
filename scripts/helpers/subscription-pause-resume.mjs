// Existing real-recovery harness extension; real execution remains separately gated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../../src/app/service-container.js';
import {assertRecoveryAccount} from '../real-recovery-account-guard.mjs';
import {acceptanceHash, assertCodexSubscriptionRoute} from './autonomous-handoff-acceptance.mjs';
import {readRecoveryParent, requireRecoveryExtensionApproval, createLinkedRecoveryJournal, continueLinkedRecoveryJournal} from './subscription-recovery-budget.mjs';
import {recoveryFileHashes, nativeOutputDigests, requireCurrentNativeRead, createOwnedCodexProcessObserver,
  pauseRecoveryTaskUi, resumeRecoveryTaskUi, releaseExistingRecoveryTaskUi, rebindRecoveryExecutionConsentUi} from './real-recovery-observation.mjs';

const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
const sourceRoot = path.resolve(import.meta.dirname, '../..');
const sourceFiles = ['src/agent/codex-agent-provider.js','src/agent/cli-agent-process.js','src/agent/broker.js',
  'src/desktop/ui-service.js','src/desktop/platform-runtime.js','src/desktop/task-recovery.js','src/agent/session-recovery.js',
  'src/task/runtime.js','src/capability/service.js','scripts/test-real-agent-recovery.mjs',
  'scripts/real-recovery-account-guard.mjs','scripts/helpers/subscription-pause-resume.mjs',
  'scripts/helpers/subscription-recovery-budget.mjs','scripts/helpers/real-recovery-observation.mjs'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file,acceptanceHash(fs.readFileSync(path.join(sourceRoot,file)))]));
const firstInstruction='Read only sum.js using exactly Get-Content -Raw -LiteralPath sum.js in the staged Workspace. '
  +'After the successful read, execute exactly Start-Sleep -Seconds 30 as a second separate native command, so the Owner can pause that wait. '
  +'Use only those two commands. Do not change files, run project code or tests, install, use network, delegate, or access other paths. '
  +'After any later explicit resume, follow the new read-only instruction and never repeat the wait.';
function boundedJson(file) {
  const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1024*1024);
  const bytes=fs.readFileSync(file);return{value:JSON.parse(bytes.toString('utf8')),sha256:acceptanceHash(bytes)};
}

export async function runSubscriptionPauseResumeAcceptance() {
  // The old six-send approval is insufficient. Nothing below this gate creates
  // Core, probes an account, constructs a session or sends a model instruction.
  if (process.env.WHALEBRIDGE_TEST_REAL_CODEX !== '1' || process.env.CETAMESH_TEST_RECOVERY_BUDGET_EXTENSION !== '8-total-3-user'
    || !process.env.CETAMESH_TEST_RECOVERY_PARENT_EVIDENCE || !process.env.CETAMESH_TEST_RECOVERY_APPROVAL_FILE) {
    console.log('NOT_RUN_ENVIRONMENT: separate Owner approval for the eight-total-send continuation is required'); process.exitCode = 77; return;
  }
  let parent, approval;
  try { parent = readRecoveryParent(process.env.CETAMESH_TEST_RECOVERY_PARENT_EVIDENCE);
    approval = requireRecoveryExtensionApproval(process.env.CETAMESH_TEST_RECOVERY_APPROVAL_FILE,parent); }
  catch(error) { console.log('NOT_RUN_ENVIRONMENT: '+(error.code || 'RECOVERY_BUDGET_APPROVAL_REQUIRED')); process.exitCode = 77; return; }
  const continuing=process.env.CETAMESH_TEST_RECOVERY_CONTINUE_EXISTING==='1';
  const attempt=continuing?Number(process.env.CETAMESH_TEST_RECOVERY_CONTINUE_ATTEMPT||'2'):1;
  if(continuing&&(![2,3].includes(attempt)||(attempt===3&&!/^[a-f0-9]{64}$/.test(process.env.CETAMESH_TEST_RECOVERY_PREVIOUS_ATTEMPT_SHA256||'')))){
    console.log('NOT_RUN_ENVIRONMENT: explicit attempt three and its exact retained failure SHA are required');process.exitCode=77;return;
  }
  if(continuing&&(!/^[a-f0-9]{64}$/.test(process.env.CETAMESH_TEST_RECOVERY_FAILED_EVIDENCE_SHA256||'')
    ||!/^[a-f0-9]{64}$/.test(process.env.CETAMESH_TEST_RECOVERY_LINKED_PREFIX_SHA256||''))){
    console.log('NOT_RUN_ENVIRONMENT: exact reviewed failed evidence and old journal prefix pins are required');process.exitCode=77;return;
  }
  const project = path.resolve(parent.evidence.project);
  assert.equal(project,path.resolve(process.env.LOCALAPPDATA,'Temp','cm-auto-handoff-20261107'));
  assert.equal(fs.lstatSync(project).isSymbolicLink(),false);
  const baseline = recoveryFileHashes(project);
  assert.deepEqual(Object.keys(baseline),['package.json','sum.js','verify.cjs']);
  assert.equal(baseline['sum.js'],parent.evidence.finalSumHash);
  for(const [file,hash] of Object.entries(parent.evidence.protectedHashes))assert.equal(baseline[file],hash);
  const mainTaskStoreFile=path.join(parent.root,'core-state','tasks','tasks.json');
  const mainTaskStoreHash=acceptanceHash(fs.readFileSync(mainTaskStoreFile));
  const root = path.join(path.dirname(parent.root),path.basename(parent.root)+'-pause-resume');
  const failedEvidenceFile=path.join(root,'pause-resume-evidence.json');let original;
  if(continuing){
    const failed=boundedJson(failedEvidenceFile);
    assert.equal(failed.sha256,process.env.CETAMESH_TEST_RECOVERY_FAILED_EVIDENCE_SHA256);
    assert.equal(failed.value.kind,'real-subscription-readonly-pause-resume');assert.equal(failed.value.verified,false);
    assert.equal(failed.value.failure?.code,'RECOVERY_OBSERVATION_UNAVAILABLE');assert.equal(failed.value.immutableInputsRetained,true);
    assert.equal(failed.value.parentEvidenceSha256,parent.evidenceSha256);assert.equal(failed.value.parentJournalSha256,parent.journalSha256);
    assert.equal(failed.value.project,project);assert.equal(failed.value.root,root);assert.deepEqual(failed.value.baseline,baseline);
    assert.deepEqual(failed.value.limits,{dispatches:6,userTurns:2,maxDispatches:8,maxUserTurns:3,baseDispatches:5,baseUserTurns:1});
    assert.equal(failed.value.mainTaskStoreFile,mainTaskStoreFile);assert.equal(failed.value.mainTaskStoreHash,mainTaskStoreHash);
    const store=boundedJson(path.join(root,'core','state','tasks','tasks.json'));
    assert.equal(store.value.tasks.length,1);const priorTask=store.value.tasks[0];
    assert.equal(priorTask.workspaceId,failed.value.workspaceId);assert.equal(priorTask.goal,firstInstruction);
    assert.equal(priorTask.createRequest?.id,'subscription-pause-initial');assert.equal(priorTask.status,'blocked');
    assert.equal(priorTask.currentAgent?.provider,'codex');assert.ok(priorTask.currentAgent.sessionId);
    assert.ok(priorTask.executionObservation?.runId);assert.equal(priorTask.checkpoint,null);
    const originalConsent=failed.value.approvals.filter(row=>row.capability==='agent.execution.authorize');assert.equal(originalConsent.length,1);
    original={failedEvidenceSha256:failed.sha256,task:priorTask,taskStoreSha256:store.sha256,originalApprovalId:originalConsent[0].id};
    if(attempt===3){
      const previousFile=path.join(root,'pause-resume-attempt-2-evidence.json'),previous=boundedJson(previousFile),value=previous.value;
      assert.equal(previous.sha256,process.env.CETAMESH_TEST_RECOVERY_PREVIOUS_ATTEMPT_SHA256);
      assert.equal(value.kind,'real-subscription-readonly-pause-resume');assert.equal(value.attempt,2);assert.equal(value.verified,false);
      assert.equal(value.failure?.code,'AGENT_SECURITY_CONFIRMATION_REQUIRED');assert.equal(value.immutableInputsRetained,true);
      assert.equal(value.formalPreflight,undefined);assert.deepEqual(value.approvals,[]);assert.deepEqual(value.limits,failed.value.limits);
      assert.equal(value.parentEvidenceSha256,parent.evidenceSha256);assert.equal(value.parentJournalSha256,parent.journalSha256);
      assert.equal(value.project,project);assert.equal(value.root,root);assert.deepEqual(value.baseline,baseline);
      assert.equal(value.mainTaskStoreFile,mainTaskStoreFile);assert.equal(value.mainTaskStoreHash,mainTaskStoreHash);
      assert.equal(value.continuedFrom.failedEvidenceFile,failedEvidenceFile);assert.equal(value.continuedFrom.failedEvidenceSha256,failed.sha256);
      assert.equal(value.continuedFrom.originalTaskId,priorTask.id);assert.equal(value.continuedFrom.originalRunId,priorTask.executionObservation.runId);
      assert.equal(value.continuedFrom.originalGoalSha256,acceptanceHash(priorTask.goal));assert.deepEqual(value.continuedFrom.originalCreateRequest,priorTask.createRequest);
      assert.equal(value.continuedFrom.originalCheckpoint,null);assert.deepEqual(value.changedSourceFilesDuringRun,[]);assert.deepEqual(value.changedMainSourceFilesDuringRun,[]);
      original.previousAttempt={file:previousFile,sha256:previous.sha256,attempt:2,failureCode:value.failure.code};
    }
    assert.equal(fs.existsSync(path.join(root,`pause-resume-attempt-${attempt}-evidence.json`)),false,'An existing attempt must never be overwritten or retried');
  }
  const budget = continuing?continueLinkedRecoveryJournal(root,{parent,approval,
    expectedPrefixSha256:process.env.CETAMESH_TEST_RECOVERY_LINKED_PREFIX_SHA256,failedEvidenceSha256:original.previousAttempt?.sha256||original.failedEvidenceSha256,
    originalFailedEvidenceSha256:original.failedEvidenceSha256,attempt,expectedPreviousSessionId:original.task.currentAgent.sessionId})
    :createLinkedRecoveryJournal(root,{parent,approval});
  const evidenceFile=path.join(root,continuing?`pause-resume-attempt-${attempt}-evidence.json`:'pause-resume-evidence.json');
  let evidenceFd;try{evidenceFd=fs.openSync(evidenceFile,'wx');}catch(error){budget.close();throw error;}
  const evidence = {kind:'real-subscription-readonly-pause-resume',nativeDesktop:false,realCodex:true,
    parentEvidenceFile:parent.evidenceFile,parentEvidenceSha256:parent.evidenceSha256,parentJournalSha256:parent.journalSha256,
    project,root,attempt,baseline,mainTaskStoreFile,mainTaskStoreHash,paidModelApiAllowed:false,verified:false,limits:budget.snapshot(),observations:[],approvals:[],
    ...(original?{continuedFrom:{failedEvidenceFile,failedEvidenceSha256:original.failedEvidenceSha256,retainedPrefix:budget.retainedPrefix,
      originalTaskId:original.task.id,originalRunId:original.task.executionObservation.runId,originalTaskStoreSha256:original.taskStoreSha256,
      originalCreateRequest:original.task.createRequest,originalGoalSha256:acceptanceHash(original.task.goal),originalCheckpoint:original.task.checkpoint,continuedUserTurn:2,
      ...(original.previousAttempt?{previousAttempt:original.previousAttempt}:{})}}:{})};
  const save = () => {evidence.limits=budget.snapshot();const bytes=Buffer.from(JSON.stringify(evidence,null,2)+'\n');
    fs.ftruncateSync(evidenceFd,0);let offset=0;while(offset<bytes.length)offset+=fs.writeSync(evidenceFd,bytes,offset,bytes.length-offset,offset);fs.fsyncSync(evidenceFd);};
  let services, taskId=original?.task.id, observer, processObserver, dispatchEnabled=false, phase = 'read-and-wait', checkpoint, initialAssignment, initialRunId;
  const task = () => services.taskService.runtime.get({id:taskId}).task;
  const ui = (method,params) => services.desktopUiService.execute({method,params});
  const immutableInputs = () => {
    assert.deepEqual(recoveryFileHashes(project),baseline,'No project file or original verification may change');
    budget.assertParentUnchanged();
    if(original)assert.equal(acceptanceHash(fs.readFileSync(failedEvidenceFile)),original.failedEvidenceSha256,'The first failed evidence is immutable');
    if(original?.previousAttempt)assert.equal(acceptanceHash(fs.readFileSync(original.previousAttempt.file)),original.previousAttempt.sha256,'The second failed evidence is immutable');
    assert.equal(acceptanceHash(fs.readFileSync(mainTaskStoreFile)),mainTaskStoreHash,'The original completed Main Task store must remain untouched');
  };
  const noEffects = () => {immutableInputs();
    const pending=services?.capabilityService.broker.approvals.list()??[];
    if(pending.length)fail('RECOVERY_PENDING_APPROVAL','No write, import, test, network or extra native approval is authorized');
  };
  async function until(read,predicate,label,timeout=180000) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){noEffects();if(observer?.facts.unexpected)fail('RECOVERY_UNAPPROVED_COMMAND','A command outside the exact readonly/wait allowlist was observed');
      const value=await read();if(predicate(value))return value;await delay(75);}
    fail('RECOVERY_ACCEPTANCE_TIMEOUT',label+' did not settle; no retry is authorized');
  }
  try {
    evidence.sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8',windowsHide:true}).trim();
    evidence.sourceDirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:sourceRoot,encoding:'utf8',windowsHide:true}).trim());
    evidence.sourceHashes=sourceHashes();
    evidence.mainSourceHashes=Object.fromEntries(Object.keys(parent.evidence.sourceHashes).map(file=>[file,acceptanceHash(fs.readFileSync(path.join(sourceRoot,file)))]));
    evidence.changedMainSourceFiles=Object.keys(evidence.mainSourceHashes).filter(file=>evidence.mainSourceHashes[file]!==parent.evidence.sourceHashes[file]);
    assert.deepEqual(evidence.changedMainSourceFiles,[],'The verified Main source manifest must stay exact for this continuation');
    const home=process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(),'.codex');
    // Reuse the existing account guard in memory; never copy or publish credentials.
    const bounded=file=>{const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=256*1024);return fs.readFileSync(file,'utf8');};
    assertRecoveryAccount({auth:JSON.parse(bounded(path.join(home,'auth.json'))),
      config:bounded(path.join(home,'config.toml')),environment:process.env});
    const providerSecrets=Object.freeze({list:()=>[],raw:()=>fail('PAID_API_FORBIDDEN','No paid Model Provider credential source exists')});
    services=createCetaMeshServices({stateDir:path.join(root,'core','state'),dataRoot:path.join(root,'core','data'),
      agentStagingRoot:path.join(root,'core','staging'),providerSecrets,deferOptionalStart:true,log:()=>{}});
    services.modelRuntime.chat=async()=>fail('PAID_API_FORBIDDEN','No Managed model is authorized');
    services.modelRuntime.stream=async function*(){fail('PAID_API_FORBIDDEN','No Managed model is authorized');};
    processObserver=createOwnedCodexProcessObserver({stagingRoot:path.join(root,'core','staging')});
    const send=services.agentBroker.send.bind(services.agentBroker);
    services.agentBroker.send=async(request,...rest)=>{
      if(!dispatchEnabled)fail('RECOVERY_PREFLIGHT_DISPATCH_FORBIDDEN','No dispatch is authorized before formal Core recovery has settled');
      const dispatch=budget.reserveDispatch(request);save();
      const health=await services.agentBroker.health('codex');
      assert.equal(assertCodexSubscriptionRoute(health,services.agentBroker.capabilities('codex')),parent.evidence.subscriptionFingerprint,
        'Only the same actual subscription account/route is authorized');
      processObserver.beforeSend(request,phase);
      let result;try{result=await send(request,...rest);}catch(error){budget.append({kind:'dispatch-failed',dispatch,code:error.code||error.name});throw error;}
      budget.append({kind:'dispatch-reply',dispatch,accepted:result?.accepted===true});
      if(request.phase!=='bootstrap')observer=processObserver.capture(request).observer;
      return result;
    };
    const workspace=original?services.workspaceService.describeWorkspace(original.task.workspaceId)
      :(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Same-project readonly cancellation acceptance'}})).workspace;
    assert.ok(workspace);assert.equal(fs.realpathSync(workspace.root),fs.realpathSync(project));
    evidence.workspaceId=workspace.id;
    evidence.workspaceIdentity=original?'Retained failed-attempt Core, same persisted Task and Workspace; no new registration or ID override'
      :'New isolated Core registration of the same canonical project root; no ID override or original-store mutation';
    const health=await services.agentBroker.health('codex');
    assert.equal(health.available,true);assert.equal(health.authenticated,true);
    evidence.subscriptionFingerprint=assertCodexSubscriptionRoute(health,services.agentBroker.capabilities('codex'));
    assert.equal(evidence.subscriptionFingerprint,parent.evidence.subscriptionFingerprint);
    const scope=await ui('ui.agent.security',{provider:'codex',workspaceId:workspace.id});
    assert.equal(scope.security.mode,'native');assert.equal(scope.security.strictIsolationVerified,false);
    assert.equal(scope.security.nativeSandboxMode,'windows-unelevated/workspace-write');
    if(!original){
    const consent=await ui('ui.agent.authorize',{provider:'codex',workspaceId:workspace.id,fingerprint:scope.fingerprint});
    const request=services.capabilityService.broker.approvals.get(consent.approvalId).request;
    assert.equal(request.capability,'agent.execution.authorize');assert.equal(request.workspaceId,workspace.id);
    assert.equal(request.input.provider,'codex');assert.equal(request.input.fingerprint,scope.fingerprint);
    await services.capabilityService.execute({method:'capability.approval.decide',params:{id:consent.approvalId,approve:true}});
    evidence.approvals.push({id:consent.approvalId,capability:'agent.execution.authorize'});
    }
    const content=fs.readFileSync(path.join(project,'sum.js'),'utf8'),digests=nativeOutputDigests(content);
    if(original){
      immutableInputs();assert.equal(task().id,original.task.id);assert.equal(task().workspaceId,workspace.id);
      assert.equal(task().goal,original.task.goal);assert.deepEqual(task().createRequest,original.task.createRequest);
      assert.deepEqual(task().checkpoint,original.task.checkpoint);
      const priorAssignment={...original.task.currentAgent,runId:original.task.executionObservation.runId};
      const released=await releaseExistingRecoveryTaskUi(services,taskId,priorAssignment,noEffects,async()=>{
        const proof=await services.agentBroker.require('codex').verifyStoppedTask({taskId,workspaceId:workspace.id,sessionId:priorAssignment.sessionId});
        evidence.originalStopReceipt=proof;save();
        assert.equal(proof.stopped,true);assert.equal(proof.taskId,taskId);assert.equal(proof.workspaceId,workspace.id);
        assert.equal(proof.sessionId,priorAssignment.sessionId);assert.equal(proof.runId,priorAssignment.runId);
        assert.ok(['process-tree-exit','supervisor-close'].includes(proof.evidence));
        evidence.currentCoreConsent=await rebindRecoveryExecutionConsentUi(services,{provider:'codex',workspaceId:workspace.id,
          previousApprovalId:original.originalApprovalId,beforeApprove:async approval=>{
            budget.append({kind:'owner-consent-rebind-approval',attempt,...approval});
            evidence.approvals.push({id:approval.approvalId,capability:approval.capability,previousApprovalId:approval.previousApprovalId,fingerprint:approval.fingerprint});save();
          }});
      },['request:'+original.task.createRequest.id]);
      evidence.formalPreflight=released.preview;save();
      assert.equal(budget.snapshot().dispatches,6);assert.equal(budget.snapshot().userTurns,2);
      budget.append({kind:'continue-original-owner-instruction',userTurn:2,taskId,goalSha256:acceptanceHash(original.task.goal),
        originalRunId:priorAssignment.runId,originalCreateRequestSha256:acceptanceHash(JSON.stringify(original.task.createRequest))});
      dispatchEnabled=true;
      const continued=await ui('ui.task.resume',{id:taskId,expectedRev:task().rev,requestId:'subscription-pause-continue-existing-owner-two'});
      assert.equal(continued.task.id,taskId);assert.equal(task().goal,original.task.goal);
      checkpoint=original.task.checkpoint;assert.deepEqual(task().checkpoint,checkpoint);
    }else{
    budget.reserveUserTurn();
    dispatchEnabled=true;
    const created=await ui('ui.task.create',{workspaceId:workspace.id,agentProvider:'codex',goal:firstInstruction,requestId:'subscription-pause-initial'});
    taskId=created.task.id;assert.notEqual(taskId,parent.evidence.taskId);
    await services.taskService.execute({method:'task.checkpoint.set',params:{id:taskId,expectedRev:task().rev,
      summary:'Owner readonly pause/resume acceptance; original completed Main Task and all source files remain unchanged.',
      nextAction:'After verified stop, only a new explicit sum.js read is permitted; never repeat the 30 second wait.'}});
    checkpoint=task().checkpoint;
    }
    initialAssignment=task().currentAgent;initialRunId=task().executionObservation.runId;
    evidence.taskId=taskId;evidence.checkpointBeforePause=checkpoint;evidence.checkpointOrigin=original?'Original failed Task checkpoint (null retained)':'Created by the first pause/resume acceptance attempt';save();
    await until(async()=>({current:task(),wait:observer?.facts.wait}),value=>{
      if(!value.wait||value.wait.completed)return false;
      try{return requireCurrentNativeRead(value.current,digests).length>0;}catch{return false;}
    },'actual source read and exact live 30-second wait');
    assert.equal((await services.agentBroker.status(initialAssignment)).running,true);
    evidence.observations.push({phase:'before-pause',taskId,runId:initialRunId,readProof:requireCurrentNativeRead(task(),digests),commands:observer.facts.commands});
    const paused=await pauseRecoveryTaskUi(services,taskId,'Owner cancels only this confirmed readonly wait and pauses the same Task');
    assert.equal(paused.task.status,'paused');assert.equal(task().id,taskId);
    const proof=await services.agentBroker.require('codex').verifyStoppedTask({taskId,workspaceId:workspace.id,sessionId:initialAssignment.sessionId});
    assert.equal(proof.stopped,true);assert.equal(proof.runId,initialRunId);assert.ok(['process-tree-exit','supervisor-close'].includes(proof.evidence));
    assert.equal((await services.agentBroker.status(initialAssignment)).running,false);noEffects();
    evidence.stopReceipt=proof;evidence.pausedTask={id:taskId,status:task().status,checkpoint:task().checkpoint,history:task().agentHistory};
    assert.deepEqual(task().checkpoint,checkpoint);
    const historyBefore=task().agentHistory.map(row=>({provider:row.provider,sessionId:row.sessionId}));
    if(continuing&&budget.snapshot().dispatches!==7)fail('RECOVERY_FINAL_READ_BUDGET_UNAVAILABLE','The original readonly stage must settle at exactly dispatch seven before reserving user instruction three');
    phase='resume-read';budget.reserveUserTurn();
    budget.append({kind:'explicit-new-owner-instruction',userTurn:3,taskId,scope:'read-sum-only-no-wait'});save();
    const resumed=await resumeRecoveryTaskUi(services,taskId,'codex','New Owner instruction: read only sum.js once using exactly Get-Content -Raw -LiteralPath sum.js in the staging Workspace, then report its actual contents and finish. Do not wait again, change files, run project code or tests, install, use network, delegate or access other paths.','subscription-pause-explicit-resume');
    assert.equal(resumed.task.id,taskId);
    const settled=await until(()=>task(),value=>value.executionObservation?.state==='awaiting-review'||['blocked','failed','cancelled'].includes(value.status),'fresh readonly resume');
    assert.equal(settled.executionObservation.state,'awaiting-review');assert.notEqual(settled.executionObservation.runId,initialRunId);
    assert.deepEqual(settled.checkpoint,checkpoint);
    assert.deepEqual(settled.agentHistory.slice(0,historyBefore.length).map(row=>({provider:row.provider,sessionId:row.sessionId})),historyBefore);
    evidence.resumedReadProof=requireCurrentNativeRead(settled,digests);assert.equal(observer.facts.wait,null);
    assert.ok(settled.agentReports.some(row=>row.runId===settled.executionObservation.runId&&row.provider==='codex'&&row.text.includes('sum.js')));
    noEffects();
    const completed=await ui('ui.task.complete',{id:taskId,expectedRev:settled.rev,reviewed:true,
      summary:'Owner verified the same Task pause, exact owned native stop receipt, unchanged project, retained checkpoint/history and fresh actual sum.js read after an explicit resume; no writes, test or wait replay.'});
    assert.equal(completed.task.status,'completed');evidence.taskId=taskId;evidence.taskStatus='completed';evidence.verified=true;
    console.log('PASS real subscription readonly Task pause, owned process-tree stop, explicit same-Task resume and current read; original Main evidence unchanged');
  }catch(error){evidence.failure={code:String(error.code||error.name||'RECOVERY_ACCEPTANCE_FAILED').slice(0,120)};
    if(error.recoveryPreview)evidence.formalPreflight=error.recoveryPreview;process.exitCode=1;}
  finally{
    if(services){
      if(!taskId&&!original){try{const store=boundedJson(path.join(root,'core','state','tasks','tasks.json'));
        const owned=store.value.tasks.filter(row=>row.createRequest?.id==='subscription-pause-initial'&&row.goal===firstInstruction&&row.workspaceId===evidence.workspaceId);
        if(owned.length===1){taskId=owned[0].id;evidence.taskId=taskId;}}catch{/* Keep all failed startup evidence if no exact Task binding can be recovered. */}}
      if(taskId){try{const current=task();if(current.status==='running')await ui('ui.task.pause',{id:taskId,expectedRev:current.rev,reason:'Stop only the owned failed acceptance run; retain its Task and evidence'});}catch(error){evidence.cleanupCode=error.code||error.name;}}
      for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','pluginCenterService','extensionService','channelService','bionicService'])
        try{await services[name]?.close();}catch(error){(evidence.closeFailures||=[]).push({service:name,code:error.code||error.name});evidence.verified=false;process.exitCode=1;}
    }
    processObserver?.restore();
    try{noEffects();evidence.immutableInputsRetained=true;}catch{evidence.immutableInputsRetained=false;evidence.verified=false;process.exitCode=1;}
    if(evidence.sourceHashes){evidence.sourceHashesAfter=sourceHashes();evidence.changedSourceFilesDuringRun=sourceFiles.filter(file=>evidence.sourceHashes[file]!==evidence.sourceHashesAfter[file]);if(evidence.changedSourceFilesDuringRun.length){evidence.verified=false;process.exitCode=1;}}
    if(evidence.mainSourceHashes){evidence.mainSourceHashesAfter=Object.fromEntries(Object.keys(evidence.mainSourceHashes).map(file=>[file,acceptanceHash(fs.readFileSync(path.join(sourceRoot,file)))]));
      evidence.changedMainSourceFilesDuringRun=Object.keys(evidence.mainSourceHashes).filter(file=>evidence.mainSourceHashes[file]!==evidence.mainSourceHashesAfter[file]);
      if(evidence.changedMainSourceFilesDuringRun.length){evidence.verified=false;process.exitCode=1;}}
    evidence.artifactsRetained=true;save();fs.closeSync(evidenceFd);budget.close();console.log(JSON.stringify({recoveryEvidenceFile:evidenceFile,verified:evidence.verified,limits:evidence.limits}));
  }
}
