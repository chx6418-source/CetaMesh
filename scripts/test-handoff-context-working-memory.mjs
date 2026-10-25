// Production composition regression with synthetic providers. No real API or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { OWNER_ACTOR } from '../src/capability/types.js';
const checks = [];
async function check(name, run) {
  try { await run(); checks.push({name, passed:true}); console.log('PASS HANDOFF ' + name); }
  catch (error) { checks.push({name, passed:false, code:error.code, message:error.message}); console.error('FAIL HANDOFF ' + name + '\n' + error.stack); }
}
async function waitFor(read, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
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
  const diagnosticEvents = [];
  const services = createCetaMeshServices({stateDir:path.join(root,'state'), dataRoot:path.join(root,'data'),
    log: entry => diagnosticEvents.push(String(entry))});
  const requests = [], remoteRequests = [], remote = new Map();
  let readOnce = false, readEmitted = false, holdCreate = null, turnScopedFollow = false, continuation = false;
  services.modelRegistry.register({id:'fix-fixture',label:'Synthetic model',defaultModel:'fixture-model',supportsTools:true,
    listModels:async()=>[{id:'fixture-model'}], health:async()=>({available:true,configured:true}),
    chat:async()=>({text:'synthetic result'}),
    stream:async function*(request) {
      requests.push(structuredClone({...request, signal:undefined}));
      if (readOnce && !readEmitted) { readEmitted=true; yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'read-proof',capabilityId:'filesystem.read',arguments:'{"path":"proof.txt"}'}]}}; }
      else yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Synthetic answer; no completion claim.'}]}}};
      yield {type:'turn/end',data:{reason:{kind:'completed'},...(continuation ? {modelContinuation:{profile:'deepseek-chat-v1',providerId:'fix-fixture',model:'fixture-model',reasoningContent:'private opaque continuation'}} : {})}};
    }});
  services.providerSecrets.set({provider:'fix-fixture',apiKey:'synthetic-not-a-real-key'});
  function emit(s,type,data) { s.events.push({seq:++s.seq,type,data:{sessionId:s.id,...data}}); for(const wake of [...s.waiters]) wake(); }
  const target = defineAgentProvider({id:'repair-fixture',label:'Synthetic Agent',eventProtocol:'dsh-session-events',
    capabilityExtras:{workspaceBoundary:'capability-broker',requiresSessionCleanup:true}, methods:{
      async createSession() { if(holdCreate) await holdCreate; const id='remote-'+(remote.size+1); remote.set(id,{id,events:[],seq:0,waiters:new Set(),running:false,closed:false}); return {sessionId:id}; },
      async send({sessionId,content,phase,runId}) { const s=remote.get(sessionId); const requestId='remote-request-'+(remoteRequests.length+1); remoteRequests.push({sessionId,content,requestId,phase,runId}); s.running=true;
        setTimeout(()=>{if(s.closed)return;emit(s,'turn/start',{requestId});emit(s,'assistant/message',{requestId,message:{content:[{type:'text',text:'Bootstrap or user acknowledgement; not completed work.'}]}});s.running=false;emit(s,'turn/end',{requestId,reason:{kind:'completed'}});},0);
        return {accepted:true,requestId}; },
      async status({sessionId}) { const s=remote.get(sessionId); return {running:s?.running===true,queued:0,waitingForApproval:false}; },
      async cancel({sessionId}) { const s=remote.get(sessionId); if(s)s.running=false; return {cancelRequested:true,stopped:true}; },
      async closeSession({sessionId}) {const s=remote.get(sessionId);if(s){s.closed=true;for(const w of [...s.waiters])w();}return{closed:true};},
      async health(){return{available:true,authenticated:true,sessionCapable:true,toolsAvailable:true};},
      async *follow({sessionId,signal,sinceSequence=0}) {const s=remote.get(sessionId);let cursor=sinceSequence;while(!signal?.aborted){for(const e of s.events.filter(e=>e.seq>cursor)){cursor=e.seq;yield structuredClone(e);if(signal?.aborted)return;if(turnScopedFollow && e.type==='turn/end')return;}if(s.closed)return;await new Promise(resolve=>{const wake=()=>{s.waiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};s.waiters.add(wake);signal?.addEventListener('abort',wake,{once:true});if(signal?.aborted||s.events.some(e=>e.seq>cursor))wake();});}},
      async selectModel(){return{selected:true};}
    }});
  services.agentBroker.register(target);
  // This fixture's synthetic Model is explicitly zero-cost; production has no
  // such claim and automatic paid selection correctly abstains there.
  const originalCapabilities = services.agentBroker.capabilities.bind(services.agentBroker);
  services.agentBroker.capabilities = id => ({ ...originalCapabilities(id),
    ...(id === 'cetamesh' ? { assignment: { taskKinds: ['code'], tools: [], maxDifficulty: 3,
      estimatedCost: { amount: 0, currency: 'USD', source: 'synthetic-fixture',
        agentProvider: 'cetamesh', modelProvider: 'fix-fixture', model: 'fixture-model' },
      estimatedLatencyMs: 1 } } : {}) });
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
  try {await run({services,chat,session,ws,root,requests,remoteRequests,diagnosticEvents,send,config,getTask,status,
    enableContinuation:()=>{continuation=true;},enableRead:()=>{readOnce=true;readEmitted=false;},useTurnScopedFollow:()=>{turnScopedFollow=true;},hold:promise=>{holdCreate=promise;}});}
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
await check('standalone provider first turn records a checkpoint without stale revision conflict',()=>fixture(async f=>{
  const task=f.services.taskService.runtime.create({goal:'Standalone first Agent report',workspaceId:f.ws.id});
  const sent=await f.services.capabilityService.broker.execute({
    actor:{kind:'owner',id:'desktop'},requestId:'standalone-report-revision',capability:'agent.run',
    taskId:task.id,workspaceId:f.ws.id,
    input:{agentProvider:'repair-fixture',content:'Analyze and report without changing files'},
    reason:'isolated Agent report revision regression'
  });
  assert.equal(sent.status,'completed');
  const report=await waitFor(()=>f.services.taskService.runtime.get({id:task.id}).task,
    row=>row.agentReports?.some(x=>x.verified===false),'standalone Agent report');
  assert.ok(report.agentReports.some(row=>row.verified===false),'report must retain unverified status');
  const checkpoint=await waitFor(()=>f.services.taskService.runtime.get({id:task.id}).task.checkpoint,
    row=>row?.summary?.includes('Bootstrap or user acknowledgement'),'standalone initial checkpoint');
  assert.ok(checkpoint.summary.startsWith('[Unverified Agent report]'));
  assert.ok(!f.diagnosticEvents.some(event=>event.includes('Capability agent.run follow-retrying')),
    'a successful initial Agent completion must not cause a hidden Task revision retry');
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
  await f.config('repair-fixture');
  assert.equal(f.remoteRequests.at(-1).phase,'bootstrap','Core must identify internal recovery runs explicitly');
  assert.ok(f.remoteRequests.at(-1).runId,'Core recovery must have a stable run identity');
  await f.config('cetamesh');await new Promise(r=>setTimeout(r,40));task=await f.getTask();
  assert.equal(task.checkpoint.summary,'Verified baseline.');assert.equal(task.checkpoint.nextAction,'Run isolated tests.');
  assert.ok(!task.completedWork.some(row=>/acknowledgement/.test(row.text)));
}));
await check('Task working Memory is recorded, scoped, idempotent and restart-readable',()=>fixture(async f=>{
  f.enableRead();await f.config('cetamesh');await f.send('Read proof.txt and describe the project.');const task=await f.getTask();
  const principal={kind:'user',id:'desktop'};
  const read=()=>f.services.memoryService.runtime.list({principal,scope:'task:'+task.id,types:['working']});
  const page=await waitFor(read,r=>r.memories.length>0,'working memory');
  assert.equal(page.memories.length,1);assert.ok(page.memories[0].content.includes('filesystem.read'));
  const workingState=JSON.parse(page.memories[0].content);
  assert.ok(Number.isInteger(workingState.taskRevision),'working state must identify the source Task version');
  assert.ok(workingState.evidence.some(row=>row.runId && row.phase==='user'),'tool evidence must preserve Core run provenance');
  assert.ok(!f.services.capabilityService.principalForTask(task.id).grants.capabilities.includes('memory.write'),'write permission must not be broadened');
  assert.ok(f.services.taskService.runtime.get({id:task.id}).task.memoryRefs.some(r=>r.memoryId===page.memories[0].id));
  await f.send('Acknowledge only.');assert.equal(read().memories[0].id,page.memories[0].id);
  const {createMemoryService}=await import('../src/memory/service.js');
  const reopened=createMemoryService({stateDir:path.join(f.root,'state')});
  assert.equal(reopened.runtime.get({principal,id:page.memories[0].id}).memory.scope,'task:'+task.id);
}));
await check('reused Task Agent Session retains distinct reports for each completed turn',()=>fixture(async f=>{
  await f.config('cetamesh');
  await f.send('Analyze the first defect.');
  const first=await waitFor(f.getTask,t=>t.agentReports?.length===1,'first Task Agent report');
  const sourceSession=first.currentAgent.sessionId;
  await new Promise(resolve=>setTimeout(resolve,30));
  await f.send('Continue and analyze a different defect.');
  const second=await waitFor(f.getTask,t=>t.agentReports?.length===2,'second Task Agent report');
  assert.equal(second.currentAgent.sessionId,sourceSession,'the second turn must reuse the same Agent Session');
  assert.equal(new Set(second.agentReports.map(row=>row.eventId)).size,2,'each turn must have a unique report identity');
  assert.equal(second.status,'running','successfully completed turns must not block the Task');
}));
await check('DSH-style turn-scoped Follow never replays first turn when a Session is reused',()=>fixture(async f=>{
  f.useTurnScopedFollow();
  await f.config('repair-fixture');
  await f.send('Analyze first code area.');
  const first=await waitFor(f.getTask,t=>t.agentReports?.length===1,'first DSH-style Task report');
  const sessionId=first.currentAgent.sessionId;
  await new Promise(resolve=>setTimeout(resolve,40));
  await f.send('Analyze the next code area.');
  const second=await waitFor(f.getTask,t=>t.agentReports?.length===2,'second DSH-style Task report');
  assert.equal(second.currentAgent.sessionId,sessionId,'Task must reuse the existing external Session');
  assert.equal(new Set(second.agentReports.map(row=>row.eventId)).size,2,'both accepted turns need distinct reports');
  assert.equal(f.remoteRequests.filter(row=>row.sessionId===sessionId).length,2,'both turns must have been sent to one Session');
}));
await check('DSH-style Follow retains both quickly queued Task turns from one Agent Session',()=>fixture(async f=>{
  f.useTurnScopedFollow();
  const task=f.services.taskService.runtime.create({goal:'Run two bounded queued Agent instructions',workspaceId:f.ws.id});
  const run=(n)=>f.services.capabilityService.broker.execute({
    requestId:'queued-follow-'+n,actor:OWNER_ACTOR,taskId:task.id,workspaceId:f.ws.id,
    capability:'agent.run',input:{agentProvider:'repair-fixture',content:'Analyze queued part '+n},reason:'test queued Task Follow'});
  const [first,second]=await Promise.all([run('first'),run('second')]);
  assert.equal(first.status,'completed');assert.equal(second.status,'completed');
  assert.equal(first.result.sessionId,second.result.sessionId,'queued requests must use the same Task Agent Session');
  const observed=await waitFor(()=>f.services.taskService.runtime.get({id:task.id}).task,
    row=>row.agentReports?.length===2,'two independently recorded queued Agent turns');
  assert.equal(new Set(observed.agentReports.map(row=>row.eventId)).size,2);
  assert.equal(observed.status,'running');
}));
await check('lost Agent Follow blocks a running Task for explicit recovery instead of leaking a writer lease',()=>fixture(async f=>{
  f.services.agentBroker.register(defineAgentProvider({id:'lost-follow-fixture',label:'Disconnected synthetic Agent',
    eventProtocol:'agent-turn-events-v1',capabilityExtras:{workspaceBoundary:'capability-broker'},
    methods:{
      async createSession(){return {sessionId:'lost-follow-session'};},
      async send(){return {accepted:true,requestId:'lost-follow-request'};},
      async status(){return {running:false,queued:0,waitingForApproval:false};},
      async cancel(){return {cancelRequested:true,stopped:true};},
      async closeSession(){return {closed:true};},
      async health(){return {available:true,authenticated:true,sessionCapable:true};},
      async *follow(){ /* Native stream ended without a terminal event. */ }
    }}));
  const task=f.services.taskService.runtime.create({goal:'Verify interrupted Agent Follow',workspaceId:f.ws.id});
  const accepted=await f.services.capabilityService.broker.execute({actor:OWNER_ACTOR,
    requestId:'lost-follow-run',capability:'agent.run',taskId:task.id,workspaceId:f.ws.id,
    input:{agentProvider:'lost-follow-fixture',content:'Perform one task'},reason:'Synthetic Follow outage'});
  assert.equal(accepted.status,'completed');
  const blocked=await waitFor(()=>f.services.taskService.runtime.get({id:task.id}).task,
    row=>row.status==='blocked','Follow exhaustion reconciliation',11500);
  assert.match(blocked.progress.note,/needs-reconciliation/);
  assert.equal(blocked.currentAgent?.sessionId,'lost-follow-session');
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
await check('checkpoint partial updates retain omitted fields',()=>fixture(async f=>{
  const runtime=f.services.taskService.runtime;
  let task=runtime.create({goal:'Keep structured progress',workspaceId:f.ws.id});
  task=runtime.setCheckpoint({id:task.id,expectedRev:task.rev,summary:'Verified source',nextAction:'Run regression'});
  task=runtime.setCheckpoint({id:task.id,expectedRev:task.rev,summary:'Verified updated source'});
  assert.equal(task.checkpoint.nextAction,'Run regression','omission must not erase pending work');
  task=runtime.setCheckpoint({id:task.id,expectedRev:task.rev,nextAction:'Inspect result'});
  assert.equal(task.checkpoint.summary,'Verified updated source','partial update must retain summary');
}));
await check('native identities reused by another Session retain distinct reports and evidence',()=>fixture(async f=>{
  const runtime=f.services.taskService.runtime;
  let task=runtime.create({goal:'Stable Task source identities',workspaceId:f.ws.id});
  for(const sessionId of ['native-one','native-two']) {
    task=runtime.start({id:task.id,expectedRev:task.rev,provider:'repair-fixture',sessionId}).task;
    task=runtime.recordAgentReport({id:task.id,expectedRev:task.rev,provider:'repair-fixture',sessionId,eventId:'report:turn-1',text:'Session-local report'});
    task=runtime.recordToolOutcome({id:task.id,provider:'repair-fixture',sessionId,eventId:'tool-1',capability:'filesystem.read',status:'completed'}).task;
  }
  assert.equal(task.agentReports.length,2,'Session-local turn ID was mistaken for Task-wide duplicate');
  assert.equal(task.executionEvidence.length,2,'Session-local tool ID was mistaken for Task-wide duplicate');
  const same=runtime.recordAgentReport({id:task.id,expectedRev:task.rev,provider:'repair-fixture',sessionId:'native-two',eventId:'report:turn-1',text:'Session-local report'});
  assert.equal(same.rev,task.rev,'same source event must remain idempotent');
}));
await check('internal phases never become Task reports, tool evidence or checkpoints',()=>fixture(async f=>{
  const runtime=f.services.taskService.runtime;
  let task=runtime.create({goal:'Reject internal phase projections',workspaceId:f.ws.id});
  task=runtime.start({id:task.id,expectedRev:task.rev,provider:'repair-fixture',sessionId:'phase-source'}).task;
  const original=f.services.agentBroker.follow;
  let consumed=false;
  f.services.agentBroker.follow=async function*() {
    try {
      const base={phase:'bootstrap',runId:'internal-run',requestId:'internal-request'};
      yield {seq:1,type:'assistant/message',data:{...base,message:{content:[{type:'text',text:'Arbitrary internal response without acknowledgement keywords'}]}}};
      yield {seq:2,type:'tool/result',data:{...base,eventId:'internal-tool',capability:'filesystem.read',status:'completed'}};
      yield {seq:3,type:'turn/end',data:{...base,reason:{kind:'completed'}}};
    } finally {consumed=true;}
  };
  try {
    f.services.capabilityService.trackTaskAgent({taskId:task.id,provider:'repair-fixture',sessionId:'phase-source'});
    await waitFor(()=>consumed,Boolean,'internal phase consumption');
    const current=runtime.get({id:task.id}).task;
    assert.equal(current.agentReports?.length??0,0,'internal reply must not become user work evidence');
    assert.equal(current.executionEvidence?.length??0,0,'internal tool must not become user work evidence');
    assert.equal(current.checkpoint,null,'internal reply must not initialize a checkpoint');
  } finally {f.services.agentBroker.follow=original;}
}));
await check('Chat reuses private model continuation without exposing it in public history',()=>fixture(async f=>{
  f.enableContinuation();
  await f.send('First ordinary model question.');
  await f.send('A follow-up model question.');
  const prior=f.requests.at(-1).messages.find(row=>row.role==='assistant');
  assert.equal(prior?.modelContinuation?.reasoningContent,'private opaque continuation','next model request lost required continuation');
  const history=await f.chat.execute({method:'chat.history',params:{id:f.session.id}});
  assert.ok(!JSON.stringify(history).includes('private opaque continuation'),'public Chat history leaked protocol-private metadata');
}));
await check('handoff fails before switching when Owner constraints would be omitted',()=>fixture(async f=>{
  await f.config('cetamesh');
  await f.send('Initial scoped task.');
  await f.send('Only edit module A. '+('A'.repeat(700))+' Do not modify module B.');
  const before=await f.getTask();
  await assert.rejects(f.config('repair-fixture'),error=>error.code==='TASK_CONTEXT_REVIEW_REQUIRED');
  const after=await f.getTask();
  assert.deepEqual(after.currentAgent,before.currentAgent,'context preflight must preserve source execution ownership');
  assert.equal(f.remoteRequests.length,0,'target must not receive incomplete Owner context');
}));
await check('configuration lock covers asynchronous Workspace validation before mutation',()=>fixture(async f=>{
  const original=f.services.workspaceService.describeWorkspace;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.services.workspaceService.describeWorkspace=async id=>{await gate;return original(id);};
  const changing=f.chat.execute({method:'chat.config.set',params:{id:f.session.id,config:{workspaceId:f.ws.id,reasoning:'high'}}});
  try {
    await assert.rejects(f.chat.execute({method:'chat.send',params:{id:f.session.id,text:'must wait'}}),error=>error.code==='CONFIG_BUSY');
    await assert.rejects(f.config('cetamesh'),error=>error.code==='CONFIG_BUSY');
  } finally {release();await changing;f.services.workspaceService.describeWorkspace=original;}
}));
await check('handoff includes linked authorized Memory excerpts and omits unlinked or deleted records',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze the scoped task.');
  const runtime=f.services.taskService.runtime;
  const memory=f.services.memoryService.runtime;
  const principal={kind:'user',id:'desktop'};
  let task=await f.getTask();
  const linked=memory.create({principal,type:'working',scope:'task:'+task.id,content:'LINKED-WORKING-FINGERPRINT'});
  memory.create({principal,type:'working',scope:'task:'+task.id,content:'UNLINKED-SAME-SCOPE-SECRET'});
  memory.create({principal,type:'working',scope:'task:other-task',content:'UNLINKED-OTHER-TASK-SECRET'});
  runtime.linkMemory({id:task.id,expectedRev:task.rev,memoryId:linked.id,scope:linked.scope,type:linked.type,authorizedBy:'user:desktop'});
  task=runtime.get({id:task.id}).task;
  const approved=memory.create({principal,type:'user',scope:'user:desktop',content:'EXPLICIT-USER-MEMORY-FINGERPRINT'});
  memory.create({principal,type:'user',scope:'user:desktop',content:'UNLINKED-USER-SCOPE-SECRET'});
  runtime.linkMemory({id:task.id,expectedRev:task.rev,memoryId:approved.id,scope:approved.scope,type:approved.type,authorizedBy:'user:desktop'});
  await f.config('repair-fixture');
  const prompt=f.remoteRequests.at(-1).content;
  assert.ok(prompt.includes('LINKED-WORKING-FINGERPRINT'),'external Agent received only IDs rather than the linked working fact');
  assert.ok(prompt.includes('EXPLICIT-USER-MEMORY-FINGERPRINT'),'explicit cross-scope authorization must remain exact-ID readable');
  assert.ok(!prompt.includes('UNLINKED-USER-SCOPE-SECRET'));
  assert.ok(!prompt.includes('UNLINKED-SAME-SCOPE-SECRET'));
  assert.ok(!prompt.includes('UNLINKED-OTHER-TASK-SECRET'));
  memory.remove({principal,id:linked.id,expectedRev:linked.rev});
  const packet=f.services.continuityService.runtime.buildHandoffPacket({taskId:task.id,sequence:99});
  assert.ok(!JSON.stringify(packet.workingMemory).includes('LINKED-WORKING-FINGERPRINT'),'deleted Memory must not be revived from an old summary');
}));
await check('Memory excerpt budget preflight preserves the source Agent',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze this scoped task.');
  const runtime=f.services.taskService.runtime;
  const memory=f.services.memoryService.runtime;
  let task=await f.getTask();
  for(let i=0;i<4;i++) {
    const row=memory.create({principal:{kind:'user',id:'desktop'},type:'working',scope:'task:'+task.id,content:'Linked state '+i});
    task=runtime.linkMemory({id:task.id,expectedRev:task.rev,memoryId:row.id,scope:row.scope,type:row.type,authorizedBy:'user:desktop'});
  }
  const before=task.currentAgent;
  await assert.rejects(f.config('repair-fixture'),error=>error.code==='HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED');
  assert.deepEqual((await f.getTask()).currentAgent,before);
  assert.equal(f.remoteRequests.length,0);
}));
await check('oversized individual Memory is refused before packet truncation or source stop',()=>fixture(async f=>{
  await f.config('cetamesh');await f.send('Analyze bounded memory transfer.');
  const runtime=f.services.taskService.runtime, memory=f.services.memoryService.runtime;
  let task=await f.getTask();
  const row=memory.create({principal:{kind:'user',id:'desktop'},type:'working',scope:'task:'+task.id,content:'bounded source'});
  runtime.linkMemory({id:task.id,expectedRev:task.rev,memoryId:row.id,scope:row.scope,type:row.type,authorizedBy:'user:desktop'});
  const original=memory.get;
  // A legacy/adapter record larger than the packet contract must fail safely.
  memory.get=args=>{const result=original(args);return args.id===row.id ? {memory:{...result.memory,content:'X'.repeat(5000)}} : result;};
  try {
    await assert.rejects(f.config('repair-fixture'),error=>error.code==='HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED');
    assert.deepEqual((await f.getTask()).currentAgent,task.currentAgent);
    assert.equal(f.remoteRequests.length,0);
  } finally {memory.get=original;}
}));
console.log('HANDOFF_RESULTS '+JSON.stringify(checks));
assert.equal(checks.filter(c=>!c.passed).length,0,'handoff/context/working-memory regressions failed');

