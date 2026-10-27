import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../src/task/store.js';
import { createCapabilityBroker } from '../src/capability/broker.js';
import { createCapabilityPolicy } from '../src/capability/policy.js';
import { createCapabilityApproval } from '../src/capability/approval.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';
import { requestFingerprint } from '../src/capability/approval.js';
import { createCapabilityService } from '../src/capability/service.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-approval-'));
try {
  const store = createTaskStore({stateDir:root});
  store.insert({id:'task',goal:'fixture',requirements:[],status:'running',workspaceId:'ws',rev:1,
    currentAgent:{provider:'fixture',sessionId:'session'},agentHistory:[],artifacts:[]});
  const grants={capabilities:['fixture.write'],taskIds:['task'],workspaceIds:['ws']};
  const actor={kind:'agent',id:'fixture',grants,assignment:store.get('task').currentAgent,assignmentRevision:store.get('task').authorizationRevision??store.get('task').rev};
  let calls=0;
  const make=()=>{
    const broker=createCapabilityBroker({stateDir:root,
      policy:createCapabilityPolicy({resolveTask:id=>store.get(id),resolveWorkspace:()=>({id:'ws'}),resolveGrants:()=>grants}),
      approval:createCapabilityApproval({stateDir:root})});
    broker.register({id:'fixture.write',permission:'filesystem.write',risk:'high',workspace:true,execute:()=>++calls});
    return broker;
  };
  const broker=make();
  const pending=await broker.execute({requestId:'request-1',actor,capability:'fixture.write',taskId:'task',workspaceId:'ws',input:{text:'one'}});
  for(let n=0;n<4;n++)store.update('task',store.get('task').rev,t=>({...t,progress:{percent:n,note:'waiting approval'}}));
  const result=await make().decide({id:pending.approvalId,approve:true,actor:{kind:'owner',id:'desktop'}});
  assert.equal(result.status,'completed','COMM-01 progress must not invalidate approved authority, including restart');
  assert.equal(calls,1);
  const pending2=await broker.execute({requestId:'request-2',actor,capability:'fixture.write',taskId:'task',workspaceId:'ws',input:{text:'two'}});
  store.update('task',store.get('task').rev,t=>({...t,currentAgent:{provider:'fixture',sessionId:'replacement'}}));
  await assert.rejects(broker.decide({id:pending2.approvalId,approve:true,actor:{kind:'owner',id:'desktop'}}),{code:'APPROVAL_EXPIRED'});
  assert.equal(calls,1);
  console.log('PASS COMM-01 stable authority across progress/restart, assignment change rejected');

  function scenario(name, {validate} = {}) {
    const stateDir=path.join(root,name);
    let taskStore=createTaskStore({stateDir});
    taskStore.insert({id:'task',goal:'fixture',requirements:[],status:'running',workspaceId:'ws',rev:1,
      currentAgent:{provider:'fixture',sessionId:'session'},agentHistory:[],artifacts:[]});
    let currentGrants={capabilities:['fixture.write'],taskIds:['task'],workspaceIds:['ws']};
    const agent={kind:'agent',id:'fixture',grants:structuredClone(currentGrants),assignment:taskStore.get('task').currentAgent,assignmentRevision:taskStore.get('task').authorizationRevision??taskStore.get('task').rev};
    let effects=0;
    const createBroker=()=>{
      const value=createCapabilityBroker({stateDir,policy:createCapabilityPolicy({resolveTask:id=>taskStore.get(id),
        resolveWorkspace:()=>({id:'ws'}),resolveGrants:()=>currentGrants}),approval:createCapabilityApproval({stateDir})});
      value.register({id:'fixture.write',permission:'filesystem.write',risk:'high',workspace:true,
        ...(validate?{validate}:{}),execute:()=>++effects});
      return value;
    };
    const boundary=createBroker();
    return {stateDir,broker:boundary,effects:()=>effects,
      update:patch=>taskStore.update('task',taskStore.get('task').rev,t=>({...t,...patch})),
      grants:value=>{currentGrants=value;},
      restart:()=>{taskStore=createTaskStore({stateDir});return createBroker();},
      pending:()=>boundary.execute({requestId:'request',actor:agent,capability:'fixture.write',taskId:'task',workspaceId:'ws',input:{text:'approved bytes'}})};
  }
  const owner={kind:'owner',id:'desktop'};
  for(const status of ['cancelled','completed','failed','paused','blocked']) {
    const f=scenario('terminal-'+status),p=await f.pending();f.update({status});
    await assert.rejects(f.restart().decide({id:p.approvalId,approve:true,actor:owner}),{code:'TASK_NOT_AUTHORIZED'});
    assert.equal(f.effects(),0);
  }
  console.log('PASS COMM-01 cancelled, terminal, paused and blocked Task authority rejected after restart');
  {
    const f=scenario('workspace'),p=await f.pending();f.update({workspaceId:'other'});
    await assert.rejects(f.restart().decide({id:p.approvalId,approve:true,actor:owner}),{code:'WORKSPACE_RECONCILIATION_REQUIRED'});
    assert.equal(f.effects(),0);
  }
  {
    const f=scenario('grants'),p=await f.pending();f.grants({capabilities:[],taskIds:['task'],workspaceIds:['ws']});
    await assert.rejects(f.restart().decide({id:p.approvalId,approve:true,actor:owner}),{code:'PERMISSION_DENIED'});
    assert.equal(f.effects(),0);
  }
  {
    const f=scenario('tamper'),p=await f.pending();const row=f.broker.approvals.get(p.approvalId);
    await assert.rejects(f.broker.execute({...row.request,approvalId:p.approvalId,input:{text:'unapproved bytes'}}),{code:'APPROVAL_MISMATCH'});
    f.broker.approvals.cancel(p.approvalId);
    await assert.rejects(f.broker.decide({id:p.approvalId,approve:true,actor:owner}),{code:'APPROVAL_ALREADY_DECIDED'});
    assert.equal(f.effects(),0);
  }
  console.log('PASS COMM-01 Workspace drift, current grant revocation, input tamper and cancelled approval all deny effects');
  {
    const f=scenario('old-binding'),p=await f.pending();
    const file=path.join(f.stateDir,'capability','approvals.json'),rows=readJsonFile(file);
    rows[0].request.approvalBinding={version:1,taskRev:1,workspaceId:'ws',provider:'fixture',sessionId:'session'};
    rows[0].fingerprint=requestFingerprint(rows[0].request);writeJsonAtomic(file,rows);
    await assert.rejects(f.restart().decide({id:p.approvalId,approve:true,actor:owner}),{code:'APPROVAL_EXPIRED'});
    assert.equal(f.effects(),0);
  }
  {
    const f=scenario('away-back'),p=await f.pending();
    const original=f.broker.approvals.get(p.approvalId).request.approvalBinding.authorizationRevision;
    f.update({currentAgent:{provider:'fixture',sessionId:'other'}});
    f.restart();
    f.update({currentAgent:{provider:'fixture',sessionId:'session'}});
    const restored=f.restart();
    await assert.rejects(restored.decide({id:p.approvalId,approve:true,actor:owner}),{code:'APPROVAL_EXPIRED'});
    assert.equal(f.effects(),0);
    assert.ok(original>0);
  }
  console.log('PASS COMM-01 persisted v1 approvals and assignment away/back cannot revive authority');
  {
    let release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    let hold=false;
    const f=scenario('validate-grants-race',{validate:async()=>{if(hold){entered();await gate;}}});
    const p=await f.pending();hold=true;
    const decision=f.broker.decide({id:p.approvalId,approve:true,actor:owner});
    await started;f.grants({capabilities:[],taskIds:['task'],workspaceIds:['ws']});release();
    await assert.rejects(decision,{code:'PERMISSION_DENIED'});
    assert.equal(f.effects(),0,'grant revocation during async validation must block actual dispatch');
  }
  {
    let release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    let hold=false;
    const f=scenario('validate-task-race',{validate:async()=>{if(hold){entered();await gate;}}});
    const p=await f.pending();hold=true;
    const decision=f.broker.decide({id:p.approvalId,approve:true,actor:owner});
    await started;f.update({status:'cancelled'});release();
    await assert.rejects(decision,{code:'TASK_NOT_AUTHORIZED'});
    assert.equal(f.effects(),0,'Task cancellation during async validation must block dispatch');
  }
  {
    let release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    let hold=false;
    const f=scenario('validate-abort-race',{validate:async()=>{if(hold){entered();await gate;}}});
    const p=await f.pending();hold=true;const controller=new AbortController();
    const decision=f.broker.decide({id:p.approvalId,approve:true,actor:owner},{signal:controller.signal});
    await started;controller.abort();release();
    await assert.rejects(decision,{code:'INVOKE_CANCELLED'});
    await Promise.resolve();
    assert.equal(f.effects(),0,'abort during async validation must not execute a late effect');
  }
  console.log('PASS COMM-01 grant and AbortSignal races during asynchronous validation block dispatch');
  {
    const service=createCapabilityService({stateDir:path.join(root,'resume-cancel')});
    let reached,release;
    const resumed=new Promise(resolve=>{reached=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    let continuationAborted=false;
    service.broker.register({id:'fixture.resume',permission:'publish',risk:'high',execute:()=>({completed:true})});
    service.setApprovalDecisionListener(async (decision,context={})=>{
      const signal=decision.signal??context.signal;
      reached();
      await new Promise((resolve,reject)=>{
        const abort=()=>{continuationAborted=true;reject(Object.assign(new Error('Continuation cancelled'),{code:'INVOKE_CANCEL_UNCONFIRMED',effectStatus:'unknown'}));};
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
        gate.then(resolve).finally(()=>signal?.removeEventListener('abort',abort));
      });
      return {resumed:true};
    });
    try {
      const p=await service.broker.execute({actor:owner,capability:'fixture.resume',input:{}});
      const accepted=await service.execute({method:'capability.approval.decide',params:{id:p.approvalId,approve:true,defer:true}});
      await resumed;
      await service.execute({method:'capability.operation.cancel',params:{id:accepted.operationId}});
      await delay(20);
      assert.equal(continuationAborted,true,'operation cancellation must reach post-tool continuation handler');
      const row=await service.execute({method:'capability.operation.get',params:{id:accepted.operationId}});
      assert.equal(row.status,'unknown');
    } finally {release();await service.close();}
    console.log('PASS COMM-02 operation cancellation reaches post-tool continuation handler');
  }
  {
    const stateDir=path.join(root,'real-resume-state'),workspaceRoot=path.join(root,'real-resume-workspace');
    fs.mkdirSync(workspaceRoot);
    const core=createCetaMeshServices({stateDir,dataRoot:path.join(root,'real-resume-data')});
    let inference=0,reachedGate=false,observedAbort=false;
    let release;
    const cleanupGate=new Promise(resolve=>{release=resolve;});
    async function waitFor(read,predicate) {
      const deadline=Date.now()+5000;let value;
      while(Date.now()<deadline){value=await read();if(predicate(value))return value;await delay(5);}
      assert.fail('Production approval continuation did not reach expected state: '+JSON.stringify(value));
    }
    core.modelRegistry.register({id:'cancel-resume',label:'Synthetic cancellation model',defaultModel:'fixture',supportsTools:true,
      health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>({text:'unused'}),
      stream:async function*(request){
        inference++;
        if(inference===1)yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'write-once',capabilityId:'filesystem.write',arguments:JSON.stringify({path:'proof.txt',content:'approved once'})}]}};
        else {
          reachedGate=true;
          await new Promise((resolve,reject)=>{
            const abort=()=>{observedAbort=true;reject(Object.assign(new Error('Model continuation cancelled'),{code:'INVOKE_CANCELLED'}));};
            request.signal.addEventListener('abort',abort,{once:true});
            if(request.signal.aborted)abort();
            cleanupGate.then(resolve).finally(()=>request.signal.removeEventListener('abort',abort));
          });
          yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'must not appear after cancellation'}]}}};
        }
        yield {type:'turn/end',data:{reason:{kind:'completed'}}};
      }});
    core.providerSecrets.set({provider:'cancel-resume',apiKey:'synthetic-not-a-real-key'});
    try {
      const ws=(await core.workspaceService.execute({method:'workspace.create',params:{name:'cancel fixture',root:workspaceRoot}})).workspace;
      const ui=core.desktopUiService;
      const session=await ui.execute({method:'ui.chat.sessions.create',params:{title:'cancel continuation'}});
      await ui.execute({method:'ui.chat.config.set',params:{id:session.id,config:{mode:'chat',workspaceId:ws.id,modelProvider:'cancel-resume',model:'fixture',agentProvider:'cetamesh'}}});
      await ui.execute({method:'ui.chat.send',params:{id:session.id,text:'Write proof in the isolated fixture.'}});
      const rows=await waitFor(()=>core.capabilityService.broker.approvals.list(),rows=>rows.length===1);
      const accepted=await ui.execute({method:'ui.approvals.decide',params:{id:rows[0].id,approve:true}});
      await waitFor(()=>reachedGate,Boolean);
      assert.equal(fs.readFileSync(path.join(workspaceRoot,'proof.txt'),'utf8'),'approved once');
      await ui.execute({method:'ui.approvals.cancel',params:{id:accepted.operationId}});
      await waitFor(()=>observedAbort,Boolean);
      const result=await waitFor(()=>ui.execute({method:'ui.approvals.operation',params:{id:accepted.operationId}}),op=>['failed','unknown','cancelled'].includes(op.status));
      assert.notEqual(result.status,'completed');
      assert.equal(inference,2);
      const replay=await ui.execute({method:'ui.approvals.decide',params:{id:rows[0].id,approve:true}});
      assert.equal(replay.operationId,accepted.operationId);
      assert.equal(inference,2,'cancelled continuation and approved effect may not be replayed');
      console.log('PASS COMM-02 actual production ManagedAgent resumed Model receives operation cancellation without replay');
    } finally {
      release();await core.chatService.close();await core.managedAgent.close();await core.capabilityService.close();core.agentBroker.close();await core.integrationService.close();
    }
  }
} finally {fs.rmSync(root,{recursive:true,force:true});}
