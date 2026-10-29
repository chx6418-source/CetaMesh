import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { createAgentEventBuffer } from '../src/agent/protocol/agent-event-buffer.js';
import { createAgentPermissionBridge } from '../src/agent/protocol/agent-permission-bridge.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { cleanupStagingWorkspace } from '../src/workspace/staging.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fixture-'));
const descriptor = { id: 'fixture', label: 'Fixture', protocolVersion: 1, verifiedRuntime: true,
  security: { mode: 'native', verified: true, nativeSandboxSupported: true, nativeApprovalSupported: true,
    nativeSandboxMode: 'fixture', nativeApprovalPolicy: 'fixture', identity: 'fixture-v1' } };
const peers = [];
function launch(args = {}) {
  const readable = new PassThrough(), writable = new PassThrough();
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const peer = { readable, writable, cwd:args.cwd, frames: [], responses: [], prompt: null, stop() { complete({code: 0}); },
    send(value) { readable.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); },
    reply(frame, result) { this.send({ id: frame.id, result }); } };
  writable.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const frame = JSON.parse(line); peer.frames.push(frame);
      if (!frame.method) { peer.responses.push(frame); continue; }
      if (frame.method === 'initialize') peer.reply(frame, {protocolVersion: 1, agentCapabilities: {}});
      if (frame.method === 'session/new') peer.reply(frame, {sessionId: 'same-native-id'});
      if (frame.method === 'session/prompt') peer.prompt = frame;
    }
  });
  peers.push(peer);
  return {readable, writable, done, close: async () => { peer.stop(); }};
}
const binding = async ({taskId, workspaceId}) => ({task:{id:taskId, workspaceId}, workspace:{id:workspaceId, root}});
function provider(extra = {}) { return createAcpAgentProvider({descriptor, launch, resolveTaskWorkspace:binding, ...extra}); }
try {
  const permissionSecurity={mode:'native-permissions',verified:true,nativeSandboxSupported:false,strictIsolationVerified:false,nativeApprovalSupported:true,nativePermissionPolicyVerified:true,allToolsRequireApproval:true,nativeSandboxMode:'none'};
  const permissionProvider=provider({descriptor:{...descriptor,security:permissionSecurity},requestNativeApproval:async()=>({outcome:'rejected'})});
  assert.equal((await permissionProvider.health()).taskEligible,true,'verified explicit native permissions must be usable without claiming OS sandbox');
  const permissionSession=await permissionProvider.createSession({taskId:'permissions',workspaceId:'w'});
  await permissionProvider.closeSession(permissionSession);
  const unbridged=provider({descriptor:{...descriptor,security:permissionSecurity}});
  assert.equal((await unbridged.health()).taskEligible,false,'native permission mode requires actual host approval bridge');
  let runtimeCurrent=true, runtimeChecks=0;
  const validated=provider({validateRuntime:async()=>{runtimeChecks++;if(!runtimeCurrent)throw Object.assign(new Error('Changed runtime'),{code:'AGENT_RUNTIME_CHANGED'});}});
  const validatedSession=await validated.createSession({taskId:'validated',workspaceId:'w'});
  assert.equal(runtimeChecks,2,'runtime validation surrounds staging and launch');
  runtimeCurrent=false;
  await assert.rejects(validated.send({sessionId:validatedSession.sessionId,content:'must not execute'}),{code:'AGENT_RUNTIME_CHANGED'});
  assert.equal((await validated.status(validatedSession)).running,false);
  await validated.closeSession(validatedSession);
  const snapshotSource=path.join(root,'snapshot-source'), nested=path.join(snapshotSource,'nested-project');
  fs.mkdirSync(nested,{recursive:true});
  fs.writeFileSync(path.join(snapshotSource,'visible.txt'),'visible');
  fs.writeFileSync(path.join(nested,'other-project.txt'),'separate workspace');
  fs.writeFileSync(path.join(snapshotSource,'opencode.json'),'untrusted runtime config');
  const snapshotProvider=provider({stagingRoot:path.join(root,'owned-stages'),snapshotExcludedPaths:['opencode.json'],
    listWorkspaceRoots:async()=>[{root:nested}],resolveTaskWorkspace:async({taskId,workspaceId})=>({task:{id:taskId,workspaceId},workspace:{id:workspaceId,root:snapshotSource}})});
  const snapshotSession=await snapshotProvider.createSession({taskId:'snapshot',workspaceId:'w'});
  assert.equal(fs.readFileSync(path.join(snapshotSession.cwd,'visible.txt'),'utf8'),'visible');
  assert.equal(fs.existsSync(path.join(snapshotSession.cwd,'nested-project','other-project.txt')),false,'registered nested workspace never enters native staging');
  assert.equal(fs.existsSync(path.join(snapshotSession.cwd,'opencode.json')),false,'trusted runtime policy files are excluded from project snapshot');
  const ownedStageRoot=fs.realpathSync.native(path.join(root,'owned-stages'));
  const stagedCwd=fs.realpathSync.native(snapshotSession.cwd);
  const insideOwnedStage=candidate=>{
    const relative=path.relative(ownedStageRoot,candidate);
    return !!relative && relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.equal(insideOwnedStage(ownedStageRoot),false,'staging root itself is not a session directory');
  assert.equal(insideOwnedStage(path.dirname(ownedStageRoot)),false,'staging parent is outside');
  assert.equal(insideOwnedStage(path.join(path.dirname(ownedStageRoot),'owned-stages-neighbor')),false,'adjacent directory is outside');
  assert.equal(insideOwnedStage(fs.realpathSync.native(snapshotSource)),false,'actual Workspace outside staging is rejected');
  assert.ok(insideOwnedStage(stagedCwd),
    `owned staging root is honored: expected ${ownedStageRoot}, got ${stagedCwd}`);
  await snapshotProvider.closeSession(snapshotSession);
  const invalidSnapshot=provider({snapshotExcludedPaths:['../outside']});
  await assert.rejects(invalidSnapshot.createSession({taskId:'bad-policy',workspaceId:'w'}),{code:'ACP_SNAPSHOT_POLICY_INVALID'});
  const overlappingStage=provider({stagingRoot:nested,listWorkspaceRoots:async()=>[nested]});
  const beforeOverlap=peers.length;
  await assert.rejects(overlappingStage.createSession({taskId:'bad-stage',workspaceId:'w'}),{code:'STAGING_ROOT_OVERLAPS_WORKSPACE'});
  assert.equal(peers.length,beforeOverlap,'stage overlap fails before launching a runtime');
  const buffer = createAgentEventBuffer(); const active=buffer.follow();
  for(let seq=1;seq<=1025;seq++) {
    buffer.push({seq,event:{type:seq===1025?'turn/end':'assistant/chunk'}});
    assert.equal((await active.next()).value.seq,seq);
  }
  await active.return();
  await assert.rejects(buffer.follow().next(),{code:'AGENT_EVENT_CURSOR_EXPIRED'});
  await assert.rejects(buffer.follow({sinceSequence:512}).next(),{code:'AGENT_EVENT_CURSOR_EXPIRED'});
  const retained=buffer.follow({sinceSequence:513}); assert.equal((await retained.next()).value.seq,514); await retained.return();
  const lag=createAgentEventBuffer({limit:2}), lagging=lag.follow(); lag.push({seq:1}); await lagging.next();
  lag.push({seq:2}); lag.push({seq:3}); lag.push({seq:4});
  await assert.rejects(lagging.next(),{code:'AGENT_EVENT_CURSOR_EXPIRED'}); buffer.close(); lag.close();
  const denied = createAgentPermissionBridge({provider:'p',sessionId:'s',workspaceId:'w',taskId:'t'});
  assert.deepEqual(await denied.request({sessionId:'s',options:[{optionId:'yes',kind:'allow_once'}]}), {outcome:{outcome:'cancelled'}});
  const unavailable = provider({descriptor:{...descriptor,verifiedRuntime:false}});
  assert.equal((await unavailable.health()).taskEligible, false);
  await assert.rejects(unavailable.createSession({taskId:'t',workspaceId:'w'}), {code:'PROVIDER_UNAVAILABLE'});
  const brokerProvider=provider(), broker=createAgentBroker({registry:createAgentProviderRegistry({providers:[brokerProvider]})});
  const consent=broker.describeExecutionSecurity('fixture','w'); broker.authorizeExecution('fixture','w',consent.fingerprint);
  const bs=await broker.createSession('fixture',{taskId:'t',workspaceId:'w'});
  assert.equal(brokerProvider.capabilities().workspaceBoundary,'native-staged');
  assert.equal(brokerProvider.capabilities().supportsFreshSession,true);
  await broker.closeSession({provider:'fixture',sessionId:bs.sessionId});
  const ub=createAgentBroker({registry:createAgentProviderRegistry({providers:[unavailable]})});
  ub.authorizeExecution('fixture','w',ub.describeExecutionSecurity('fixture','w').fingerprint);
  assert.equal(unavailable.capabilities().workspaceBoundary,'unsupported');
  assert.equal(unavailable.capabilities().supportsFreshSession,false);
  await assert.rejects(ub.createSession('fixture',{taskId:'t',workspaceId:'w'}),{code:'PROVIDER_UNAVAILABLE'});
  const p = provider(); const session = await p.createSession({taskId:'t',workspaceId:'w',cwd:'C:\\forged'});
  const peer = peers.at(-1);
  assert.deepEqual(peer.frames.slice(0,2).map(x=>x.method), ['initialize','session/new']);
  assert.deepEqual(peer.frames[0].params.clientCapabilities, {});
  assert.notEqual(peer.frames[1].params.cwd, 'C:\\forged');
  const sent = await p.send({sessionId:session.sessionId,content:'hello'}); await tick();
  peer.send({method:'session/update',params:{sessionId:'same-native-id',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好'}}}});
  await tick(); peer.reply(peer.prompt,{stopReason:'end_turn'}); await tick();
  const events = p.follow({sessionId:session.sessionId});
  assert.equal((await events.next()).value.event.type,'turn/start');
  const chunk = (await events.next()).value.event;
  assert.equal(chunk.type,'assistant/chunk'); assert.equal(chunk.data.chunk.type,'text-delta');
  assert.equal((await events.next()).value.event.type,'assistant/message');
  assert.equal((await events.next()).value.event.type,'turn/end'); await events.return();
  assert.equal((await p.status({sessionId:session.sessionId})).running,false);
  assert.equal((await p.contextUsage({sessionId:session.sessionId})).available,false);
  assert.ok(sent.turnId);
  await p.closeSession({sessionId:session.sessionId});
  assert.equal(fs.existsSync(session.cwd),false);

  const limited = provider(); const opened = [];
  for (let i=0;i<16;i++) opened.push(await limited.createSession({taskId:'t',workspaceId:'w'}));
  await assert.rejects(limited.createSession({taskId:'t',workspaceId:'w'}),{code:'AGENT_SESSION_LIMIT'});
  for (const row of opened) await limited.closeSession(row);
  const forged = provider({resolveTaskWorkspace:async()=>({task:{id:'different',workspaceId:'w'},workspace:{id:'w',root}})});
  await assert.rejects(forged.createSession({taskId:'t',workspaceId:'w'}),{code:'TASK_WORKSPACE_MISMATCH'});
  const mismatch = provider({launch:async args=>{
    const handle = launch(args), q=peers.at(-1), original=q.reply;
    q.reply = (frame,result)=>original.call(q,frame,frame.method==='initialize'?{protocolVersion:2}:result);
    return handle;
  }});
  await assert.rejects(mismatch.createSession({taskId:'t',workspaceId:'w'}),{code:'ACP_VERSION_UNSUPPORTED'});

  let approved, approvalBinding, nativeApprovalCalls=0;
  const ap = provider({requestNativeApproval:args=>{nativeApprovalCalls++;approvalBinding=args;return new Promise(resolve=>{approved=resolve;});}});
  const as = await ap.createSession({taskId:'t',workspaceId:'w'}), aq=peers.at(-1);
  await ap.send({sessionId:as.sessionId,content:'permission'}); await tick();
  const permission={sessionId:'same-native-id',toolCall:{toolCallId:'call',kind:'execute',rawInput:{command:'fixture'}},options:[{optionId:'allow',kind:'allow_once'}]};
  aq.send({id:'native-approval',method:'session/request_permission',params:permission}); await tick();
  assert.equal(approvalBinding.taskId,'t'); assert.equal(approvalBinding.workspaceId,'w');
  assert.equal(approvalBinding.sessionId,as.sessionId); assert.match(approvalBinding.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal((await ap.status(as)).state,'waiting');
  const cancel = await ap.cancel(as); assert.equal(cancel.cancelRequested,true); assert.equal(cancel.cancelled,false);
  await tick(); assert.deepEqual(aq.responses.at(-1).result,{outcome:{outcome:'cancelled'}});
  aq.send({id:'after-cancel',method:'session/request_permission',params:permission}); await tick();
  assert.equal(nativeApprovalCalls,1);
  assert.deepEqual(aq.responses.find(row=>row.id==='after-cancel')?.result,{outcome:{outcome:'cancelled'}});
  approved({outcome:'approved',optionId:'allow'}); await tick();
  assert.equal((await ap.status(as)).running,true);
  aq.reply(aq.prompt,{stopReason:'cancelled'}); await tick();
  assert.equal((await ap.status(as)).lastRunStatus,'cancelled');
  await ap.closeSession(as);

  let release;
  const bridge=createAgentPermissionBridge({provider:'p',sessionId:'platform',nativeSessionId:'native',workspaceId:'w',taskId:'t',
    requestNativeApproval:()=>new Promise(resolve=>{release=resolve;})});
  const req={...permission,sessionId:'native'};
  const awaiting=bridge.request(req); await tick(); bridge.invalidate('call');
  assert.deepEqual(await awaiting,{outcome:{outcome:'cancelled'}});
  release({outcome:'approved',optionId:'allow'});
  assert.deepEqual(await bridge.request({...req,workspaceId:'forged'}),{outcome:{outcome:'cancelled'}});
  bridge.close();
  let approvalCalls=0;
  const queued=createAgentPermissionBridge({provider:'p',sessionId:'native',workspaceId:'w',taskId:'t',
    requestNativeApproval:async()=>{approvalCalls++;return {outcome:'approved',optionId:'allow'};}});
  const queuedResult=queued.request({...permission,sessionId:'native'}); queued.cancel();
  assert.deepEqual(await queuedResult,{outcome:{outcome:'cancelled'}}); assert.equal(approvalCalls,0);
  assert.deepEqual(await queued.request({...permission,sessionId:'native'}),{outcome:{outcome:'selected',optionId:'allow'}});
  queued.close();

  const exited=provider(), es=await exited.createSession({taskId:'t',workspaceId:'w'}), eq=peers.at(-1);
  await exited.send({sessionId:es.sessionId,content:'exit'}); await tick(); eq.stop(); await tick();
  assert.equal((await exited.status(es)).state,'unknown');
  eq.send({method:'session/update',params:{sessionId:'same-native-id',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'late'}}}});
  await assert.rejects(exited.send({sessionId:es.sessionId,content:'no replay'}),{code:'TURN_BUSY'});
  const eit=exited.follow(es); assert.equal((await eit.next()).value.event.type,'turn/start');
  assert.equal((await eit.next()).value.event.data.reason.kind,'error'); await eit.return();
  await exited.closeSession(es);

  let malformedStops=0;
  const malformed=provider({launch:async args=>{
    const handle=launch(args), original=handle.close;
    return {...handle,close:async()=>{malformedStops++;await original();}};
  }});
  const ms=await malformed.createSession({taskId:'t',workspaceId:'w'}), mq=peers.at(-1);
  await malformed.send({sessionId:ms.sessionId,content:'malformed'}); await tick();
  mq.readable.write('{bad json}\n'); await tick();
  assert.equal(malformedStops,1); assert.equal((await malformed.status(ms)).state,'unknown');
  await malformed.closeSession(ms);

  let failClose = true;
  const failure=provider({launch:async args=>{
    const handle=launch(args); const original=handle.close;
    return {...handle,close:async()=>{if(failClose) throw new Error('fixture stop failed'); await original();}};
  }});
  const fsession=await failure.createSession({taskId:'t',workspaceId:'w'});
  await failure.send({sessionId:fsession.sessionId,content:'working'}); await tick();
  await assert.rejects(failure.closeSession(fsession),{code:'ACP_CLOSE_UNKNOWN'});
  assert.equal(fs.existsSync(fsession.cwd),true);
  assert.equal((await failure.status(fsession)).state,'unknown');
  const fi=failure.follow(fsession); await fi.next();
  assert.equal((await fi.next()).value.event.data.reason.kind,'error'); await fi.return();
  failClose=false; await failure.closeSession(fsession); assert.equal(fs.existsSync(fsession.cwd),false);

  const notExit=provider({launch:async args=>{
    const handle=launch(args); return {...handle,close:async()=>{}};
  }});
  const ns=await notExit.createSession({taskId:'t',workspaceId:'w'}), nq=peers.at(-1);
  await notExit.send({sessionId:ns.sessionId,content:'pending close'}); await tick();
  let settled=false;
  const closing=notExit.closeSession(ns).then(result=>{settled=true;return result;});
  await tick(); assert.equal(settled,false); assert.equal(fs.existsSync(ns.cwd),true);
  nq.stop(); await closing; assert.equal(fs.existsSync(ns.cwd),false);

  const rpcCancelled=provider(), rs=await rpcCancelled.createSession({taskId:'t',workspaceId:'w'}), rq=peers.at(-1);
  await rpcCancelled.send({sessionId:rs.sessionId,content:'remote cancellation'}); await tick();
  rq.send({id:rq.prompt.id,error:{code:-32800,message:'Cancelled'}}); await tick();
  assert.equal((await rpcCancelled.status(rs)).lastRunStatus,'cancelled'); await rpcCancelled.closeSession(rs);

  const symlink=provider(), ls=await symlink.createSession({taskId:'t',workspaceId:'w'}), lq=peers.at(-1);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'acp-outside-'));
  try {
    fs.writeFileSync(path.join(outside,'outside.txt'),'secret');
    fs.symlinkSync(outside,path.join(ls.cwd,'escape'),'junction');
    await symlink.send({sessionId:ls.sessionId,content:'link'}); await tick();
    lq.reply(lq.prompt,{stopReason:'end_turn'}); await tick();
    assert.equal((await symlink.status(ls)).lastRunStatus,'completed');
    assert.equal(fs.readFileSync(path.join(outside,'outside.txt'),'utf8'),'secret');
    await symlink.closeSession(ls);
  } finally { fs.rmSync(outside,{recursive:true,force:true}); }

  const other=provider({descriptor:{...descriptor,id:'other'}}), o1=await other.createSession({taskId:'t',workspaceId:'w'});
  const one=provider(), o2=await one.createSession({taskId:'t',workspaceId:'w'});
  assert.notEqual(o1.sessionId,o2.sessionId); await other.closeSession(o1); await one.closeSession(o2);

  for (const mode of ['completed','denied','conflict','snapshot']) {
    fs.writeFileSync(path.join(root,'result.txt'),'old'); let imports=0;
    const ip=provider({applyChanges:async args=>{
      imports++; assert.equal(args.taskId,'t'); assert.equal(args.workspaceId,'w');
      if(mode==='completed') { for (const change of args.changes) fs.writeFileSync(path.join(root,change.path),change.content); return {status:'completed'}; }
      return {status:'rejected'};
    }});
    const is=await ip.createSession({taskId:'t',workspaceId:'w'}), iq=peers.at(-1);
    await ip.send({sessionId:is.sessionId,content:'edit'}); await tick();
    fs.writeFileSync(path.join(is.cwd,'result.txt'),'new');
    if(mode==='conflict') fs.writeFileSync(path.join(root,'result.txt'),'concurrent');
    if(mode==='snapshot') fs.rmSync(is.cwd,{recursive:true,force:true});
    iq.reply(iq.prompt,{stopReason:'end_turn'}); await tick();
    const state=await ip.status(is);
    assert.equal(state.lastRunStatus,mode==='completed'?'completed':'failed');
    assert.equal(imports,['conflict','snapshot'].includes(mode)?0:1);
    await ip.closeSession(is);
  }
  let importCancelled=null;
  const pendingImport=provider({applyChanges:async()=>({status:'pending',approvalId:'import-id'}),
    approvalStatus:()=>({status:'pending'}),cancelApproval:async id=>{importCancelled=id;}});
  const ps=await pendingImport.createSession({taskId:'t',workspaceId:'w'}), pq=peers.at(-1);
  await pendingImport.send({sessionId:ps.sessionId,content:'pending import'}); await tick();
  fs.writeFileSync(path.join(ps.cwd,'result.txt'),'pending'); pq.reply(pq.prompt,{stopReason:'end_turn'}); await tick();
  assert.equal((await pendingImport.status(ps)).waitingForApproval,true);
  await pendingImport.cancel(ps); await tick(); assert.equal(importCancelled,'import-id');
  assert.equal((await pendingImport.status(ps)).lastRunStatus,'cancelled'); await pendingImport.closeSession(ps);
  for(const mode of ['waiting','creation-race']) {
    let importStarted, returnPending; const revoked=[]; const approvals=new Map();
    const started=new Promise(resolve=>{importStarted=resolve;});
    const racing=provider({applyChanges:async()=>{
      importStarted();
      if(mode==='creation-race') await new Promise(resolve=>{returnPending=resolve;});
      approvals.set(mode,'pending'); return {status:'pending',approvalId:mode};
    },approvalStatus:id=>({status:approvals.get(id)}),cancelApproval:async id=>{revoked.push(id);approvals.set(id,'cancelled');}});
    const ds=await racing.createSession({taskId:'t',workspaceId:'w'}), dq=peers.at(-1);
    await racing.send({sessionId:ds.sessionId,content:'disconnect import'}); await tick();
    fs.writeFileSync(path.join(ds.cwd,'result.txt'),'pending disconnect'); dq.reply(dq.prompt,{stopReason:'end_turn'});
    await started; await tick(); dq.stop(); await tick();
    if(mode==='creation-race') { returnPending(); await tick(); }
    assert.deepEqual(revoked,[mode]); assert.equal(approvals.get(mode),'cancelled');
    await racing.closeSession(ds); assert.deepEqual(revoked,[mode]);
  }
  let revocations=0, retryStops=0, retryCleanup=null;
  const retry=provider({applyChanges:async()=>({status:'pending',approvalId:'retry-id'}),approvalStatus:()=>({status:'pending'}),
    cleanupStage:stage=>{retryCleanup=cleanupStagingWorkspace(stage);return retryCleanup;},
    cancelApproval:async id=>{assert.equal(id,'retry-id');revocations++;if(revocations===1)throw new Error('transient revocation failure');},
    launch:async args=>{const handle=launch(args),original=handle.close;return {...handle,close:async()=>{retryStops++;await original();}};}});
  const retrySession=await retry.createSession({taskId:'t',workspaceId:'w'}), retryPeer=peers.at(-1);
  await retry.send({sessionId:retrySession.sessionId,content:'retry revocation'}); await tick();
  fs.writeFileSync(path.join(retrySession.cwd,'result.txt'),'retry'); retryPeer.reply(retryPeer.prompt,{stopReason:'end_turn'}); await tick();
  await assert.rejects(retry.closeSession(retrySession),{code:'ACP_CLOSE_UNKNOWN'});
  assert.equal(retryStops,1); assert.equal(revocations,1); assert.equal(fs.existsSync(retrySession.cwd),true);
  assert.equal((await retry.status(retrySession)).approvalId,'retry-id');
  await retry.closeSession(retrySession); assert.equal(revocations,2); assert.equal(retryStops,1);
  assert.equal(fs.existsSync(retrySession.cwd),true,'confirmed cancellation retains unimported output for Owner review');
  assert.deepEqual(retryCleanup,{removed:false,reason:'unimported-changes'});
  assert.equal(fs.readFileSync(path.join(retrySession.cwd,'result.txt'),'utf8'),'retry','retained output must remain intact after approval revocation');

  let bootstrapFail=true, bootstrapArgs;
  const bootstrap=provider({launch:async args=>{
    bootstrapArgs=args; const handle=launch(args),original=handle.close;
    const owned={...handle,close:async()=>{if(bootstrapFail)throw new Error('bootstrap stop failed');await original();}};
    args.onHandle(owned); throw Object.assign(new Error('bootstrap failed'),{code:'FIXTURE_BOOTSTRAP_FAILED'});
  }});
  let bootstrapError;
  try { await bootstrap.createSession({taskId:'t',workspaceId:'w'}); } catch(error) {bootstrapError=error;}
  assert.equal(bootstrapError.code,'ACP_CLOSE_UNKNOWN'); assert.ok(bootstrapError.sessionId);
  assert.equal(fs.existsSync(bootstrapArgs.cwd),true);
  assert.equal((await bootstrap.status({sessionId:bootstrapError.sessionId})).state,'unknown');
  bootstrapFail=false; await bootstrap.closeSession({sessionId:bootstrapError.sessionId});
  assert.equal(fs.existsSync(bootstrapArgs.cwd),false);

  let nonexitArgs;
  const bootstrapNonexit=provider({launch:async args=>{
    nonexitArgs=args; const handle=launch(args),owned={...handle,close:async()=>{}};
    args.onHandle(owned); throw Object.assign(new Error('bootstrap failed'),{code:'FIXTURE_BOOTSTRAP_FAILED'});
  }});
  let bootSettled=false;
  const bootCreating=bootstrapNonexit.createSession({taskId:'t',workspaceId:'w'}).catch(error=>{bootSettled=true;return error;});
  await tick(); assert.equal(bootSettled,false); assert.equal(fs.existsSync(nonexitArgs.cwd),true);
  peers.at(-1).stop(); assert.equal((await bootCreating).code,'FIXTURE_BOOTSTRAP_FAILED');
  assert.equal(fs.existsSync(nonexitArgs.cwd),false);
  console.log('ACP fixture contract PASS');
} finally {
  // Fixture-owned paths only; synthetic supervisors have no OS child to outlive these streams.
  for (const peer of peers) {
    peer.stop(); peer.readable.destroy(); peer.writable.destroy();
    if (peer.cwd) fs.rmSync(peer.cwd,{recursive:true,force:true});
  }
  fs.rmSync(root,{recursive:true,force:true});
}
