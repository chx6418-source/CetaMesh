import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexAppServerProvider, CODEX_APP_SERVER_SCHEMA_VERSION } from '../src/agent/codex-app-server-provider.js';
import { createCodexProviderRouter } from '../src/agent/codex-provider-router.js';
import { createAgentService } from '../src/agent/service.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
const tick=()=>new Promise(r=>setTimeout(r,15));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-app-fixture-'));
const peers=[];
const security={verified:true,mode:'native',nativeSandboxSupported:true,nativeApprovalSupported:true,
 inheritedExtensionsDisabled:true,sandbox:'read-only',approvalPolicy:'on-request'};
const taskOptions={verifiedRuntime:{verified:true,version:CODEX_APP_SERVER_SCHEMA_VERSION,security},
 resolveTaskWorkspace:async({taskId,workspaceId})=>({task:{id:taskId,workspaceId},workspace:{id:workspaceId,root}})};
function launch(binding = {}) {
 const readable=new PassThrough(),writable=new PassThrough(); let finish;
 const done=new Promise(r=>{finish=r;});
 const q={frames:[],responses:[],raw(value){readable.write(value);},send(value){readable.write(JSON.stringify(value)+'\n');},reply(f,result){this.send({id:f.id,result});},turn:0};
 writable.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){
  const f=JSON.parse(line); assert.equal(Object.hasOwn(f,'jsonrpc'),false);q.frames.push(f);
  if(!f.method){q.responses.push(f);continue;}
  if(f.method==='initialize') q.reply(f,{userAgent:'fixture'});
  if(f.method==='thread/start') q.reply(f,{thread:{id:'native-thread'}});
  if(f.method==='thread/resume') q.reply(f,{thread:{id:'native-thread'}});
  if(f.method==='turn/start'){q.turn++;q.reply(f,{turn:{id:`turn-${q.turn}`,status:'inProgress'}});}
  if(f.method==='turn/interrupt'){q.reply(f,{});q.send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:`turn-${q.turn}`,status:'interrupted'}}});}
 }});peers.push(q);
 const handle={readable,writable,done,close:async()=>{q.closes=(q.closes ?? 0)+1;finish({code:0});}};
 q.handle=handle;q.cwd=binding.cwd;binding.onHandle?.(handle);
 return handle;
}
try {
 const regressionFailures=[];
 async function regression(name,check) {try {await check();}catch(error){regressionFailures.push(new Error(name,{cause:error}));}}
 await regression('S1 descriptor override must not bypass pinned runtime',async()=>{
  for(const runtime of [undefined,{verified:true,version:'wrong-version',security}]) {
   const injected=createCodexAppServerProvider({launch,taskOptions:{resolveTaskWorkspace:taskOptions.resolveTaskWorkspace,
    verifiedRuntime:runtime,descriptor:{id:'codex',label:'Injected',protocolVersion:1,verifiedRuntime:true,security}}});
   assert.equal((await injected.health()).available,false);
  }
 });
 await regression('Q2 selected transport readiness/security',async()=>{
  const native=createCodexAppServerProvider({launch,taskOptions});
  const unavailable=createCodexAppServerProvider();
  let healthParams;
  const legacy={eventProtocol:'legacy',capabilities:()=>({security:{fingerprint:'exec-policy'},available:true}),health:async params=>{healthParams=params;return {available:true,taskEligible:true};}};
  const legacyRouter=createCodexProviderRouter({legacyProvider:legacy});
  const refresh={refresh:true};await legacyRouter.health(refresh);assert.equal(healthParams,refresh);
  const blocked=createCodexProviderRouter({legacyProvider:legacy,appServerProvider:unavailable,rolloutEnabled:true});
  assert.equal((await blocked.health()).available,false);
  assert.deepEqual(blocked.capabilities().security,unavailable.capabilities().security);
  const ready=createCodexProviderRouter({legacyProvider:{...legacy,health:async()=>({available:false})},appServerProvider:native,rolloutEnabled:true});
  assert.equal((await ready.health()).taskEligible,true);
  assert.deepEqual(ready.capabilities().security,security);
  assert.equal(ready.eventProtocol,native.eventProtocol);
 });
 await regression('Q1 service configure and close preserve lifecycle',async()=>{
  for(const rolloutEnabled of [false,true]) {
   let configured=0,shutdown=0,closed=0;
   const legacy={id:'codex',eventProtocol:'legacy',capabilities:()=>({}),health:async()=>({available:true}),
    createSession:async()=>({sessionId:'legacy-owned'}),configure:settings=>{configured++;return settings;},
    closeSession:async()=>{closed++;return {closed:true};},shutdown:async()=>{shutdown++;}};
   const native=createCodexAppServerProvider({launch,taskOptions});
   const router=createCodexProviderRouter({legacyProvider:legacy,appServerProvider:native,rolloutEnabled});
   const session=await router.createSession({taskId:'t',workspaceId:'w'});
   const registry=createAgentProviderRegistry({providers:[router]});
   const service=createAgentService({broker:createAgentBroker({registry})});
   try {
    assert.deepEqual(await service.execute({method:'agent.configure',params:{provider:'codex',settings:{enabled:true}}}),{enabled:true});
    service.close();await tick();await tick();
    assert.equal(configured,1);assert.equal(shutdown,1);
    if(rolloutEnabled) {assert.equal(fs.existsSync(session.cwd),false);await assert.rejects(native.status(session),{code:'SESSION_NOT_FOUND'});}
    else assert.equal(closed,1);
   } finally {if(rolloutEnabled && fs.existsSync(session.cwd)) await native.closeSession(session);}
  }
  let release,closedPending=0,legacyStopped=0;
  const delayed={capabilities:()=>({}),health:async()=>({}),
   createSession:()=>new Promise(resolve=>{release=resolve;}),
   closeSession:async()=>{closedPending++;},shutdown:async()=>{legacyStopped++;}};
  const delayedRouter=createCodexProviderRouter({legacyProvider:delayed});
  const creation=delayedRouter.createSession({taskId:'t',workspaceId:'w'});
  const shutdown=delayedRouter.shutdown();release({sessionId:'pending-session'});
  await creation;await shutdown;
  assert.equal(closedPending,1);assert.equal(legacyStopped,1);
 });
 if(regressionFailures.length) throw new AggregateError(regressionFailures,regressionFailures.map(e=>e.message).join('; '));
 const callbackProvider=createCodexAppServerProvider({launch,taskOptions});
 const callbackSession=await callbackProvider.createSession({taskId:'t',workspaceId:'w'});
 const callbackPeer=peers.at(-1);await callbackProvider.closeSession(callbackSession);
 assert.ok(callbackPeer.closes>0);assert.equal(fs.existsSync(callbackSession.cwd),false);
 let failedPeer,confirmFailedExit;
 const afterCallbackThrow=createCodexAppServerProvider({taskOptions,launch:binding=>{
  const handle=launch();failedPeer=peers.at(-1);failedPeer.cwd=binding.cwd;
  const done=new Promise(resolve=>{confirmFailedExit=resolve;});
  binding.onHandle({...handle,done});
  throw Object.assign(new Error('fixture launcher failure'),{code:'FIXTURE_LAUNCH_FAILED'});
 }});
 let launchRejected=false;
 const failedCreation=assert.rejects(afterCallbackThrow.createSession({taskId:'t',workspaceId:'w'}),{code:'FIXTURE_LAUNCH_FAILED'}).then(()=>{launchRejected=true;});
 await tick();assert.ok(failedPeer.closes>0);assert.equal(launchRejected,false);
 assert.equal(fs.existsSync(failedPeer.cwd),true);
 confirmFailedExit({code:0});await failedCreation;
 assert.ok(failedPeer.closes>0);assert.equal(fs.existsSync(failedPeer.cwd),false);
 let retainedPeer,canConfirm=false,releaseExit;
 const retainedProvider=createCodexAppServerProvider({taskOptions,launch:binding=>{
  const handle=launch();retainedPeer=peers.at(-1);retainedPeer.cwd=binding.cwd;
  const done=new Promise(resolve=>{releaseExit=resolve;});
  const owned={...handle,done,async close(){retainedPeer.closes=(retainedPeer.closes ?? 0)+1;
   if(!canConfirm) throw Object.assign(new Error('fixture exit unconfirmed'),{code:'FIXTURE_CLOSE_UNKNOWN'});
   await handle.close();releaseExit({code:0});}};
  binding.onHandle(owned);throw Object.assign(new Error('fixture failure after ownership'),{code:'FIXTURE_LAUNCH_FAILED'});
 }});
 let retainedFailure;
 try {await retainedProvider.createSession({taskId:'t',workspaceId:'w'});assert.fail('Expected retained creation failure');}catch(error){retainedFailure=error;}
 assert.equal(retainedFailure.code,'ACP_CLOSE_UNKNOWN');assert.ok(retainedFailure.sessionId);
 assert.ok(retainedPeer.closes>0);assert.equal(fs.existsSync(retainedPeer.cwd),true);
 canConfirm=true;await retainedProvider.closeSession({sessionId:retainedFailure.sessionId});
 assert.equal(fs.existsSync(retainedPeer.cwd),false);
 // A native snapshot failure must never acquire the old exec post-exit proof on rollback.
 const recoveryHome=fs.mkdtempSync(path.join(os.tmpdir(),'codex-native-recovery-'));
 let nativeCore,restarted,nativeSession,nativePeer,allowNativeExit=false;
 const snapshotProvider=createCodexAppServerProvider({taskOptions:{...taskOptions,
  resolveTaskWorkspace:({taskId,workspaceId})=>({task:nativeCore.taskService.runtime.get({id:taskId}).task,
   workspace:nativeCore.workspaceService.describeWorkspace(workspaceId)})},launch:binding=>{
  const raw=launch();nativePeer=peers.at(-1);nativePeer.cwd=binding.cwd;
  const owned={...raw,async close(){if(!allowNativeExit)throw Object.assign(new Error('fixture native exit unconfirmed'),{code:'FIXTURE_CLOSE_UNKNOWN'});await raw.close();}};
  binding.onHandle(owned);return owned;
 }});
 try {
  const dirs={stateDir:path.join(recoveryHome,'state'),dataRoot:path.join(recoveryHome,'data')};
  nativeCore=createCetaMeshServices({...dirs,agentCodexRouterOptions:{rolloutEnabled:true,appServerProvider:snapshotProvider}});
  const source=path.join(recoveryHome,'workspace');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'proof.txt'),'unchanged');
  const {workspace}=await nativeCore.workspaceService.execute({method:'workspace.create',params:{root:source,name:'native snapshot fixture'}});
  let task=nativeCore.taskService.runtime.create({goal:'native snapshot failure must remain blocked',workspaceId:workspace.id});
  const router=nativeCore.agentService.getProvider('codex');
  nativeSession=await router.createSession({taskId:task.id,workspaceId:workspace.id});
  task=nativeCore.taskService.runtime.start({id:task.id,expectedRev:task.rev,provider:'codex',sessionId:nativeSession.sessionId}).task;
  nativeCore.capabilityService.trackTaskAgent({taskId:task.id,provider:'codex',sessionId:nativeSession.sessionId});
  await router.send({...nativeSession,content:'fixture native snapshot failure'});await tick();
  assert.ok(path.resolve(nativeSession.cwd).startsWith(path.resolve(os.tmpdir())+path.sep));
  assert.notEqual(path.resolve(nativeSession.cwd),path.resolve(source));
  fs.rmSync(nativeSession.cwd,{recursive:true,force:true});
  nativePeer.send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn-1',status:'completed'}}});
  for(let i=0;i<100;i++){task=nativeCore.taskService.runtime.get({id:task.id}).task;if(task.status==='blocked')break;await tick();}
  assert.equal(task.status,'blocked');
  const nativeNote=task.progress.note;
  const stream=snapshotProvider.follow(nativeSession);await stream.next();const terminal=(await stream.next()).value;await stream.return();
  const terminalCode=terminal.event.data.reason.error.code;
  const nativeStatus=await snapshotProvider.status(nativeSession);
  restarted=createCetaMeshServices(dirs);
  const persisted=restarted.taskService.runtime.get({id:task.id}).task;
  assert.equal(persisted.progress.note,nativeNote,'real Task projection persists native error across Core restart');
  await assert.rejects(restarted.desktopUiService.execute({method:'ui.task.cancel',params:{id:persisted.id,expectedRev:persisted.rev}}),{code:'SESSION_TRANSPORT_UNKNOWN'});
  assert.equal(restarted.taskService.runtime.get({id:task.id}).task.status,'blocked');
  assert.equal(nativeNote,'ACP_STAGING_READ_FAILED');assert.equal(terminalCode,nativeNote);assert.equal(nativeStatus.errorCode,nativeNote);
  assert.equal(fs.readFileSync(path.join(source,'proof.txt'),'utf8'),'unchanged');
 } finally {
  allowNativeExit=true;if(nativeSession)await nativeCore.agentService.getProvider('codex').closeSession(nativeSession);
  for(const core of [nativeCore,restarted])if(core){core.chatService.close();await core.capabilityService.close();await core.agentService.close();}
  fs.rmSync(recoveryHome,{recursive:true,force:true});
 }
 assert.equal((await createCodexAppServerProvider().health()).available,false);
 const unsupported=createCodexAppServerProvider({launch,taskOptions:{...taskOptions,verifiedRuntime:{...taskOptions.verifiedRuntime,security:{...security,nativeSandboxSupported:false}}}});
 await assert.rejects(unsupported.createSession({taskId:'t',workspaceId:'w'}),{code:'PROVIDER_UNAVAILABLE'});
 let approve;
 const p=createCodexAppServerProvider({launch,taskOptions,requestNativeApproval:()=>new Promise(r=>{approve=r;})});
 const s=await p.createSession({taskId:'t',workspaceId:'w'}),q=peers.at(-1);
 assert.deepEqual(q.frames.slice(0,3).map(f=>f.method),['initialize','initialized','thread/start']);
 assert.equal(q.frames[2].params.sandbox,'read-only'); assert.notEqual(q.frames[2].params.cwd,root);
 await p.send({...s,content:'hello'});await tick();
 q.send({method:'item/agentMessage/delta',params:{threadId:'native-thread',turnId:'wrong',itemId:'i',delta:'BAD'}});
 q.send({method:'item/agentMessage/delta',params:{threadId:'native-thread',turnId:'turn-1',itemId:'i',delta:'你好'}});
 q.send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn-1',status:'completed'}}});await tick();
 const events=p.follow(s),rows=[];for(let i=0;i<4;i++)rows.push((await events.next()).value);await events.return();
 assert.deepEqual(rows.map(x=>x.event.type),['turn/start','assistant/chunk','assistant/message','turn/end']);
 assert.equal(rows[1].event.data.chunk.text,'你好');
 assert.equal((await p.resume(s)).resumed,true);
 await assert.rejects(p.resume({...s,workspaceId:'wrong'}),{code:'TASK_WORKSPACE_MISMATCH'});
 await p.send({...s,content:'second'});await tick();
 q.send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',turnId:'turn-2',itemId:'tool',startedAtMs:1,command:'fixture'}});await tick();
 assert.equal(typeof approve,'function');await p.cancel(s);await tick();approve({outcome:'approved',optionId:'accept'});await tick();
 assert.equal(q.responses.find(x=>x.id===900).result.decision,'decline');
 assert.equal((await p.status(s)).lastRunStatus,'cancelled');
 await p.send({...s,content:'approval-success'});await tick();
 q.send({id:901,method:'item/fileChange/requestApproval',params:{threadId:'native-thread',turnId:'turn-3',itemId:'edit',startedAtMs:2}});await tick();
 approve({outcome:'approved',optionId:'accept'});await tick();
 assert.equal(q.responses.find(x=>x.id===901).result.decision,'accept');
 for(const type of ['commandExecution','fileChange']) q.send({method:'item/completed',params:{threadId:'native-thread',turnId:'turn-3',item:{id:type,type,status:'failed'}}});
 await tick();
 const toolEvents=p.follow({...s,sinceSequence:rows.at(-1).seq});let failedTools=0;
 while(failedTools<2) {const row=(await toolEvents.next()).value;if(row.event.type==='tool/activity'){assert.equal(row.event.data.activity.status,'failed');failedTools++;}}
 await toolEvents.return();
 q.send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn-3',status:'failed',error:{message:'secret-output'}}}});await tick();
 assert.equal((await p.status(s)).lastRunStatus,'failed');
 await p.closeSession(s);assert.equal(fs.existsSync(s.cwd),false);
 await assert.rejects(p.resume(s),{code:'SESSION_NOT_FOUND'});
 const broken=createCodexAppServerProvider({launch,taskOptions});
 const bs=await broken.createSession({taskId:'t',workspaceId:'w'});
 await broken.send({...bs,content:'malformed-stream'});await tick();
 peers.at(-1).raw('{bad}\n');await tick();
 assert.equal((await broken.status(bs)).running,false);
 await broken.closeSession(bs);
 const missing=createCodexAppServerProvider({taskOptions,launch:()=>{
  const h=launch(),peer=peers.at(-1),reply=peer.reply;
  peer.reply=function(f,result){return reply.call(this,f,f.method==='thread/start'?{thread:{}}:result);};return h;
 }});
 await assert.rejects(missing.createSession({taskId:'t',workspaceId:'w'}));
 const calls=[];
 const legacy={eventProtocol:'legacy',capabilities:()=>({}),health:async()=>({available:true}),createSession:async()=>({sessionId:'old'}),send:async()=>calls.push('exec')};
 const app={createSession:async()=>({sessionId:'new'}),send:async()=>calls.push('app')};
 const router=createCodexProviderRouter({legacyProvider:legacy,appServerProvider:app,resolveTransport:id=>id==='historical'?'exec':null});
 assert.equal(router.id,'codex');await router.createSession({taskId:'t',workspaceId:'w'});await router.send({sessionId:'old'});await router.send({sessionId:'historical'});
 await assert.rejects(router.resume({sessionId:'unproven'}),{code:'SESSION_TRANSPORT_UNKNOWN'});
 await assert.rejects(router.send({sessionId:'old',workspaceId:'other'}),{code:'TASK_WORKSPACE_MISMATCH'});
 const enabled=createCodexProviderRouter({legacyProvider:legacy,appServerProvider:app,rolloutEnabled:true});
 await enabled.createSession({});await enabled.send({sessionId:'new'});assert.deepEqual(calls,['exec','exec','app']);
 console.log('Codex pinned schema lifecycle, cancellation approval race, resume binding, legacy router PASS');
} finally {fs.rmSync(root,{recursive:true,force:true});}
