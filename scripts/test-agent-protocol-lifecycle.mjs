import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';
import { cleanupStagingWorkspace } from '../src/workspace/staging.js';
import { createAgentService } from '../src/agent/service.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(),'agent-lifecycle-'));
const tick = () => new Promise(resolve=>setTimeout(resolve,10));
const peers=[];
const descriptor={id:'lifecycle',label:'Lifecycle',protocolVersion:1,verifiedRuntime:true,security:{verified:true,mode:'native',nativeSandboxSupported:true,nativeApprovalSupported:true}};
function launch() {
 const readable=new PassThrough(),writable=new PassThrough(); let exit;
 const done=new Promise(resolve=>{exit=resolve;});
 const peer={readable,writable,closed:0,send(value){readable.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');}};
 writable.on('data',data=>{for(const line of String(data).trim().split('\n')) {const frame=JSON.parse(line); if(frame.method==='initialize')peer.send({id:frame.id,result:{protocolVersion:1}}); if(frame.method==='session/new')peer.send({id:frame.id,result:{sessionId:'native'}}); if(frame.method==='session/prompt')peer.prompt=frame;}});
 peers.push(peer); return {readable,writable,done,async close(){peer.closed++;exit({code:0});}};
}
function provider(extra={}) {return createAcpAgentProvider({descriptor,launch,resolveTaskWorkspace:async({taskId,workspaceId})=>({task:{id:taskId,workspaceId},workspace:{id:workspaceId,root}}),...extra});}
try {
 const timeoutInput=new PassThrough(),timeoutOutput=new PassThrough();
 const timed=createJsonRpcTransport({readable:timeoutInput,writable:timeoutOutput,framing:'acp-v1-jsonl'});
 await assert.rejects(timed.request('fixture',{}, {timeoutMs:5}),{code:'RPC_TIMEOUT'});
 await timed.close(); assert.equal(timeoutInput.listenerCount('data'),0);
 const p=provider(); const sessions=await Promise.all([p.createSession({taskId:'t',workspaceId:'w'}),p.createSession({taskId:'t',workspaceId:'w'})]);
 await p.send({...sessions[0],content:'running'});
 assert.equal(typeof p.shutdown,'function','ACP must expose awaitable owned-session shutdown');
 await p.shutdown();
 await assert.rejects(p.status({sessionId:'nonexistent-reconnect'}),{code:'SESSION_NOT_FOUND'});
 assert.ok(peers.every(peer=>peer.closed===1));
 assert.ok(sessions.every(session=>!fs.existsSync(session.cwd)));
 await assert.rejects(p.createSession({taskId:'t',workspaceId:'w'}),{code:'PROVIDER_SHUTTING_DOWN'});
 const q=provider(); const session=await q.createSession({taskId:'t',workspaceId:'w'}); const peer=peers.at(-1);
 await q.send({...session,content:'cancel'}); await tick(); await q.cancel(session);
 peer.send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'late'}}}});
 assert.equal((await q.status(session)).state,'unknown');
 peer.send({id:peer.prompt.id,result:{stopReason:'cancelled'}}); await tick();
 peer.send({id:peer.prompt.id,result:{stopReason:'end_turn'}}); await tick();
 const events=q.follow(session); assert.equal((await events.next()).value.event.type,'turn/start'); assert.equal((await events.next()).value.event.data.reason.kind,'aborted'); await events.return();
 await q.shutdown();

 for (const failure of ['malformed','half-frame','exit','stdin']) {
   const runtime=provider(), opened=await runtime.createSession({taskId:'t',workspaceId:'w'}), transport=peers.at(-1);
   await runtime.send({...opened,content:failure}); await tick();
   if (failure==='malformed') transport.readable.write('{broken}\n');
   if (failure==='half-frame') {transport.readable.write('{"jsonrpc":');transport.readable.end();}
   if (failure==='exit') transport.readable.end();
   if (failure==='stdin') transport.writable.destroy();
   await tick(); assert.equal((await runtime.status(opened)).state,'unknown',failure);
   const follow=runtime.follow(opened); await follow.next(); const terminal=(await follow.next()).value.event;
   assert.equal(terminal.type,'turn/end'); assert.equal(terminal.data.reason.kind,'error'); await follow.return();
   await runtime.shutdown(); assert.equal(transport.readable.listenerCount('data'),0);
 }
 let releaseApproval;
 const approval=provider({requestNativeApproval:()=>new Promise(resolve=>{releaseApproval=resolve;})});
 const waiting=await approval.createSession({taskId:'t',workspaceId:'w'}), approvalPeer=peers.at(-1);
 await approval.send({...waiting,content:'approval'}); await tick();
 approvalPeer.send({id:'approval',method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:'c',kind:'execute',rawInput:{command:'fixture'}},options:[{optionId:'yes',kind:'allow_once'}]}});
 await tick(); assert.equal((await approval.status(waiting)).state,'waiting');
 await approval.shutdown(); releaseApproval({outcome:'approved',optionId:'yes'}); await tick();
 assert.equal(approvalPeer.readable.listenerCount('data'),0);
 let bind, bindingStarted;
 const bindingSeen=new Promise(resolve=>{bindingStarted=resolve;});
 const pending=provider({resolveTaskWorkspace:()=>new Promise(resolve=>{bind=resolve;bindingStarted();})});
 const creating=pending.createSession({taskId:'t',workspaceId:'w'});
 await bindingSeen;
 const rejected=assert.rejects(creating,{code:'PROVIDER_SHUTTING_DOWN'});
 const closing=pending.shutdown(); bind({}); await rejected; await closing;
 let failExit=true;
 const uncertain=provider({launch:args=>{const handle=launch(args); const close=handle.close; return {...handle,close:()=>failExit?Promise.reject(Object.assign(new Error('unconfirmed'),{code:'EXIT_UNKNOWN'})):close()};}});
 const retained=await uncertain.createSession({taskId:'t',workspaceId:'w'});
 await assert.rejects(uncertain.shutdown(),{code:'ACP_CLOSE_UNKNOWN'});
 assert.equal((await uncertain.status(retained)).state,'unknown'); assert.equal(fs.existsSync(retained.cwd),true);
 failExit=false; await uncertain.shutdown(); assert.equal(fs.existsSync(retained.cwd),false);
 let cleanupAttempts=0;
 const locked=provider({cleanupStage:stage=>{if(++cleanupAttempts===1)throw Object.assign(new Error('fixture lock'),{code:'EPERM'});cleanupStagingWorkspace(stage);}});
 const lockedSession=await locked.createSession({taskId:'t',workspaceId:'w'}), lockedPeer=peers.at(-1);
 await locked.send({...lockedSession,content:'cleanup lock'}); await tick();
 const lockedEvents=locked.follow(lockedSession); assert.equal((await lockedEvents.next()).value.event.type,'turn/start');
 await assert.rejects(locked.closeSession(lockedSession),{code:'EPERM'});
 assert.equal((await locked.status(lockedSession)).state,'unknown'); assert.equal(fs.existsSync(lockedSession.cwd),true);
 assert.equal(lockedPeer.closed,1); assert.equal(lockedPeer.readable.listenerCount('data'),0);
 assert.equal((await lockedEvents.next()).value.event.type,'turn/end'); assert.equal((await lockedEvents.next()).done,true);
 await locked.closeSession(lockedSession); assert.equal(cleanupAttempts,2); assert.equal(lockedPeer.closed,1);
 assert.equal(fs.existsSync(lockedSession.cwd),false); await assert.rejects(locked.status(lockedSession),{code:'SESSION_NOT_FOUND'});
 await locked.shutdown();
 // Service contract is protocol agnostic: every registered owned provider is awaited in parallel.
 const releases=[],started=[];
 const providers=['dsh','codex','claude','workbuddy','acp'].map(id=>({id,shutdown(){started.push(id);return new Promise(resolve=>releases.push(resolve));}}));
 const service=createAgentService({broker:{require(){},registry:{list:()=>providers},close(){}}});
 let closed=false; const serviceClosing=service.close().then(()=>{closed=true;}); await tick();
 assert.equal(started.length,5); assert.equal(closed,false); releases.forEach(resolve=>resolve()); await serviceClosing;
 const broken=createAgentService({broker:{require(){},registry:{list:()=>[{id:'unconfirmed',shutdown:async()=>{throw Object.assign(new Error('unknown'),{code:'EXIT_UNKNOWN'});}}]},close(){}}});
 await assert.rejects(broken.close(),error=>error.code==='PROVIDER_CLOSE_UNKNOWN'&&error.results[0].state==='unknown');
 console.log('PASS agent protocol lifecycle');
} finally {fs.rmSync(root,{recursive:true,force:true});}
