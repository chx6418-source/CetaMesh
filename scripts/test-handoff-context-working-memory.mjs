// Production composition regression with synthetic providers. No real API or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createTaskRuntime } from '../src/task/runtime.js';
const checks = [];
async function check(name, run) {
  try { await run(); checks.push({name, passed:true}); console.log('PASS HANDOFF ' + name); }
  catch (error) { checks.push({name, passed:false, code:error.code, message:error.message}); console.error('FAIL HANDOFF ' + name + '\n' + error.stack); }
}
async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 5000;
  do { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 10)); } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
async function fixture(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-handoff-fix-')));
  const workspaceRoot = path.join(root, 'workspace'); fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'proof.txt'), 'verified fixture bytes');
  for (const args of [['init', workspaceRoot], ['-C', workspaceRoot, 'add', 'proof.txt'],
    ['-C', workspaceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, {encoding:'utf8'});
    assert.equal(result.status, 0, 'isolated Git fixture: ' + result.stderr);
  }
  const services = createCetaMeshServices({stateDir:path.join(root,'state'), dataRoot:path.join(root,'data')});
  const requests = [], remoteRequests = [], remote = new Map();
  let readOnce = false, readEmitted = false, holdCreate = null;
  services.modelRegistry.register({id:'fix-fixture',label:'Synthetic model',defaultModel:'fixture-model',supportsTools:true,
    listModels:async()=>[{id:'fixture-model'}], health:async()=>({available:true,configured:true}),
    chat:async()=>({text:'synthetic result'}),
    stream:async function*(request) {
      requests.push(structuredClone({...request, signal:undefined}));
      if (readOnce && !readEmitted) { readEmitted=true; yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'read-proof',capabilityId:'filesystem.read',arguments:'{"path":"proof.txt"}'}]}}; }
      else yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Synthetic answer; no completion claim.'}]}}};
      yield {type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  services.providerSecrets.set({provider:'fix-fixture',apiKey:'synthetic-not-a-real-key'});
  function emit(s,type,data) { s.events.push({seq:++s.seq,type,data:{sessionId:s.id,...data}}); for(const wake of [...s.waiters]) wake(); }
  const target = defineAgentProvider({id:'repair-fixture',label:'Synthetic Agent',eventProtocol:'dsh-session-events',
    capabilityExtras:{workspaceBoundary:'capability-broker',requiresSessionCleanup:true}, methods:{
      async createSession() { if(holdCreate) await holdCreate; const id='remote-'+(remote.size+1); remote.set(id,{id,events:[],seq:0,waiters:new Set(),running:false,closed:false}); return {sessionId:id}; },
      async send({sessionId,content}) { const s=remote.get(sessionId); const requestId='remote-request-'+(remoteRequests.length+1); remoteRequests.push({sessionId,content,requestId}); s.running=true;
        setTimeout(()=>{if(s.closed)return;emit(s,'turn/start',{requestId});emit(s,'assistant/message',{requestId,message:{content:[{type:'text',text:'Bootstrap or user acknowledgement; not completed work.'}]}});s.running=false;emit(s,'turn/end',{requestId,reason:{kind:'completed'}});},0);
        return {accepted:true,requestId}; },
      async status({sessionId}) { const s=remote.get(sessionId); return {running:s?.running===true,queued:0,waitingForApproval:false}; },
      async cancel({sessionId}) { const s=remote.get(sessionId); if(s)s.running=false; return {cancelRequested:true,stopped:true}; },
      async closeSession({sessionId}) {const s=remote.get(sessionId);if(s){s.closed=true;for(const w of [...s.waiters])w();}return{closed:true};},
      async health(){return{available:true,authenticated:true,sessionCapable:true};},
      async *follow({sessionId,signal,sinceSequence=0}) {const s=remote.get(sessionId);let cursor=sinceSequence;while(!signal?.aborted){for(const e of s.events.filter(e=>e.seq>cursor)){cursor=e.seq;yield structuredClone(e);if(signal?.aborted)return;}if(s.closed)return;await new Promise(resolve=>{const wake=()=>{s.waiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};s.waiters.add(wake);signal?.addEventListener('abort',wake,{once:true});if(signal?.aborted||s.events.some(e=>e.seq>cursor))wake();});}},
      async selectModel(){return{selected:true};}
    }});
  services.agentBroker.register(target);
  const {createChatService} = await import('../src/desktop/chat-service.js');
  const {createDesktopPlatformRuntime} = await import('../src/desktop/platform-runtime.js');
  const ws = (await services.workspaceService.execute({method:'workspace.create',params:{name:'Handoff fixture',root:workspaceRoot}})).workspace;
  let chat;
  const platform = createDesktopPlatformRuntime({capabilityService:services.capabilityService,workspaceService:services.workspaceService,
    taskRuntime:services.taskService.runtime,agentBroker:services.agentBroker,modelRuntime:services.modelRuntime,
    continuityRuntime:services.continuityService.runtime,
    prepareTaskContext: args => chat.prepareTaskContext?.(args)});
  chat=createChatService({stateDir:path.join(root,'test-chat'),defaults:{},modelRuntime:services.modelRuntime,
    agentProviders:services.agentService.listProviders(),agentExecute:r=>services.agentService.execute(r),agentFollow:r=>services.agentBroker.follow(r),
    platformRoute:r=>platform.route(r),resolveWorkspace:id=>services.workspaceService.describeWorkspace(id),
    resolveTask:id=>services.taskService.runtime.get({id}).task,handoffTask:r=>services.continuityService.runtime.rollover(r),
    recordOwnerContext:args=>services.taskService.runtime.recordOwnerContext?.(args),
    router:{classify:()=>({decision:{class:'project',route:'agent',agentIntent:true,capabilityIntent:false}})} });
  const session=await chat.execute({method:'chat.sessions.create',params:{}});
  await chat.execute({method:'chat.config.set',params:{id:session.id,config:{mode:'chat',workspaceId:ws.id,modelProvider:'fix-fixture',model:'fixture-model'}}});
  const status=()=>chat.execute({method:'chat.status',params:{id:session.id}});
  const send=async text=>{await chat.execute({method:'chat.send',params:{id:session.id,text}});const result=await waitFor(status,s=>!s.turn,'Chat terminal');assert.notEqual(result.lastState,'error',result.lastError);return result;};
  const config=agentProvider=>chat.execute({method:'chat.config.set',params:{id:session.id,config:{agentProvider}}});
  const getTask=async()=>services.taskService.runtime.get({id:(await status()).taskId}).task;
  try {await run({services,chat,session,ws,root,requests,remoteRequests,send,config,getTask,status,
    enableRead:()=>{readOnce=true;readEmitted=false;},hold:promise=>{holdCreate=promise;}});}
  finally {chat.close();for(const s of remote.values()){s.closed=true;for(const w of [...s.waiters])w();}await services.close?.();fs.rmSync(root,{recursive:true,force:true});}
}
await check('first Model-to-Agent dispatch includes bounded Owner context',()=>fixture(async f=>{
  await f.send('Only modify A. Do not modify B. Write tests before implementation.');
  await f.config('cetamesh');await f.send('Start now.');
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes('Do not modify B'),'new Agent lost prior Owner constraint');
}));
await check('ordinary short answer preserves checkpoint and next action',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze this project.');let task=await f.getTask();
  f.services.taskService.runtime.setCheckpoint({id:task.id,expectedRev:task.rev,summary:'Confirmed source location; no edits yet.',nextAction:'Add a failing regression test.'});
  await f.send('Acknowledge only.');task=await f.getTask();
  assert.equal(task.checkpoint.summary,'Confirmed source location; no edits yet.');
  assert.equal(task.checkpoint.nextAction,'Add a failing regression test.');
  assert.ok(task.agentReports?.some(row => row.text.includes('Synthetic answer') && row.verified === false),
    'unverified Agent report must be persisted separately from a verified checkpoint');
  assert.ok(!task.completedWork.some(row=>/Synthetic answer/.test(row.text)),'unverified answer was counted as completed work');
}));
await check('first unverified Agent response is recorded without a stale Task revision',()=>fixture(async f=>{
  await f.config('cetamesh');
  await f.send('Analyze this project.');
  const task=await f.getTask();
  assert.ok(task.agentReports?.some(row=>row.verified===false && row.text.includes('Synthetic answer')),
    'the Agent report must be recorded without upgrading it to verified work');
  const checkpoint=await waitFor(()=>f.services.taskService.runtime.get({id:task.id}).task.checkpoint,
    value=>value?.summary?.includes('Synthetic answer'),'unverified fallback checkpoint');
  assert.ok(checkpoint.summary.startsWith('[Unverified Agent report]'),
    'unverified checkpoint must state its evidence class');
  assert.ok(!f.services.taskService.runtime.get({id:task.id}).task.completedWork
    .some(row=>row.text.includes('Synthetic answer')),'unverified report is not completed work');
}));
await check('automatic policy may switch the actual assigned Agent',()=>fixture(async f=>{
  await f.chat.execute({method:'chat.config.set',params:{id:f.session.id,config:{mode:'smart'}}});
  await f.send('Analyze this project.');const before=await f.getTask();
  await f.config('repair-fixture');const after=await f.getTask();
  assert.equal(after.id,before.id);assert.equal(after.currentAgent.provider,'repair-fixture');
}));
await check('committed Work handoff is authoritative on the next Chat send',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze this project.');const before=await f.getTask();
  await f.services.desktopUiService.execute({method:'ui.task.handoff',params:{id:before.id,targetProvider:'repair-fixture'}});
  const handoffs=f.services.continuityService.runtime.history({taskId:before.id}).total;
  await f.send('Continue the same Task.');const after=await f.getTask();
  assert.equal(after.currentAgent.provider,'repair-fixture');
  assert.equal(f.services.continuityService.runtime.history({taskId:before.id}).total,handoffs,'Chat silently switched back');
}));
await check('two handoffs preserve checkpoint and pending action',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze this project.');let task=await f.getTask();
  f.services.taskService.runtime.setCheckpoint({id:task.id,expectedRev:task.rev,summary:'Verified baseline.',nextAction:'Run isolated tests.'});
  await f.config('repair-fixture');await f.config('cetamesh');await new Promise(r=>setTimeout(r,40));task=await f.getTask();
  assert.equal(task.checkpoint.summary,'Verified baseline.');assert.equal(task.checkpoint.nextAction,'Run isolated tests.');
  assert.ok(!task.completedWork.some(row=>/acknowledgement/.test(row.text)));
}));
await check('Task working Memory is recorded, scoped, idempotent and restart-readable',()=>fixture(async f=>{
  f.enableRead();await f.config('cetamesh');await f.send('Read proof.txt and describe the project.');const task=await f.getTask();
  const principal={kind:'user',id:'desktop'};
  const read=()=>f.services.memoryService.runtime.list({principal,scope:'task:'+task.id,types:['working']});
  const page=await waitFor(read,r=>r.memories.length>0,'working memory');
  assert.equal(page.memories.length,1);assert.ok(page.memories[0].content.includes('filesystem.read'));
  assert.ok(!f.services.capabilityService.principalForTask(task.id).grants.capabilities.includes('memory.write'),'write permission must not be broadened');
  assert.ok(f.services.taskService.runtime.get({id:task.id}).task.memoryRefs.some(r=>r.memoryId===page.memories[0].id));
  await f.send('Acknowledge only.');assert.equal(read().memories[0].id,page.memories[0].id);
  const {createMemoryService}=await import('../src/memory/service.js');
  const reopened=createMemoryService({stateDir:path.join(f.root,'state')});
  assert.equal(reopened.runtime.get({principal,id:page.memories[0].id}).memory.scope,'task:'+task.id);
}));
await check('disabled Memory never auto-records working rows',()=>fixture(async f=>{
  await f.services.settingsService.execute({method:'settings.update',params:{section:'memory',values:{enabled:false}}});
  f.enableRead();await f.config('cetamesh');await f.send('Read proof.txt.');const task=await f.getTask();
  assert.equal(f.services.memoryService.runtime.list({principal:{kind:'user',id:'desktop'},scope:'task:'+task.id,types:['working']}).memories.length,0);
}));
await check('Owner context survives Task Store reopening',()=>fixture(async f=>{
  await f.send('Do not modify B.');await f.config('cetamesh');await f.send('Start now.');const task=await f.getTask();
  const reopened=createTaskRuntime({stateDir:path.join(f.root,'state')});
  assert.ok(JSON.stringify(reopened.get({id:task.id}).task.ownerContext).includes('Do not modify B.'));
}));
await check('Agent handoff excludes concurrent Chat sends',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze this project.');let release;f.hold(new Promise(r=>{release=r;}));
  const switching=f.config('repair-fixture');await new Promise(r=>setTimeout(r,20));
  try {await assert.rejects(f.chat.execute({method:'chat.send',params:{id:f.session.id,text:'Must wait for configuration.'}}),e=>e.code==='CONFIG_BUSY');}
  finally {release();await switching;}
}));
console.log('HANDOFF_RESULTS '+JSON.stringify(checks));
assert.equal(checks.filter(c=>!c.passed).length,0,'handoff/context/working-memory regressions failed');
