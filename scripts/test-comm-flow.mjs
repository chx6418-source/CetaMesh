import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplicationLifecycle } from '../src/app/lifecycle.js';
import { createDesktopUiEventBus, createDesktopUiService } from '../src/desktop/ui-service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'comm-flow-'));
let failed=0;
async function check(name, run){try{await run();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+' '+e.stack);}}
async function wait(read, test){for(let i=0;i<300;i++){const value=await read();if(test(value))return value;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');}
await check('COMM-02 waiting twice retains independent Task Follow until real completion',async()=>{
  const runtime=createTaskRuntime({stateDir:path.join(root,'follow')});
  let task=runtime.create({goal:'three user turns',workspaceId:'ws'});
  task=runtime.attachAgent({id:task.id,expectedRev:task.rev,provider:'fixture',sessionId:'session'}).task;
  runtime.start({id:task.id,expectedRev:task.rev});
  let seq=0;
  const broker={capabilities:()=>({workspaceBoundary:'capability-broker'}),async *follow(){
    yield {type:'turn/end',seq:++seq,data:{requestId:'request',reason:{kind:'waiting'}}};
    yield {type:'turn/end',seq:++seq,data:{requestId:'request',reason:{kind:'waiting'}}};
    yield {type:'assistant/message',seq:++seq,data:{requestId:'request',message:{content:[{type:'text',text:'final verified transport report'}]}}};
    yield {type:'turn/end',seq:++seq,data:{requestId:'request',reason:{kind:'completed'}}};
  }};
  const svc=createCapabilityService({stateDir:path.join(root,'follow-cap'),taskRuntime:runtime,agentBroker:broker});
  svc.trackTaskAgent({taskId:task.id,provider:'fixture',sessionId:'session'});
  await new Promise(r=>setTimeout(r,30));
  try{assert.equal(runtime.get({id:task.id}).task.agentReports.length,1);}finally{await svc.close();}
});
await check('COMM-06 awaited idempotent reverse shutdown before owner release',async()=>{
  const order=[];const lifecycle=createApplicationLifecycle({handlerTimeoutMs:40});
  lifecycle.register(()=>order.push('owner'));
  lifecycle.register(async()=>{await new Promise(r=>setTimeout(r,10));order.push('child');});
  const first=lifecycle.stop();assert.equal(lifecycle.stop(),first);
  await first;assert.deepEqual(order,['child','owner']);
});
await check('COMM-07 UTF8 byte-budget pagination and explicit slow-consumer gap',async()=>{
  const bus=createDesktopUiEventBus({maxEvents:30});
  for(let n=0;n<12;n++)bus.publish('chat.streaming',{sessionId:'s',requestId:'r',delta:'中'.repeat(32000)});
  let cursor=0,total=0;
  while(total<12){const page=await bus.next({after:cursor,waitMs:0});
    assert.ok(Buffer.byteLength(JSON.stringify({version:1,id:'x'.repeat(200),result:page}))<1024*1024);
    assert.ok(page.cursor>cursor);cursor=page.cursor;total+=page.events.length;}
  assert.equal(total,12);
  const small=createDesktopUiEventBus({maxEvents:2});for(let n=0;n<4;n++)small.publish('task.updated',{taskId:'t'});
  assert.equal((await small.next({after:1,waitMs:0})).reset,true);
});
await check('COMM-12 commit identity survives whitelist; Channel DTO removes secrets',async()=>{
  const bus=createDesktopUiEventBus();bus.publish('chat.updated',{sessionId:'s',requestId:'r',turnId:'turn',messageId:'m',historyRevision:3,token:'secret'});
  assert.equal(bus.publish('channel.delivery',{accountId:'a',channelId:'qq',messageId:'m',status:'sent',raw:{token:'private'},accessToken:'secret'}),true);
  const page=await bus.next({waitMs:0});assert.equal(page.events[0].data.historyRevision,3);
  assert.equal(page.events[0].data.messageId,'m');assert.doesNotMatch(JSON.stringify(page),/secret|private|accessToken/);
});
await check('COMM-04 production UI decision responds while effect remains owned/queryable',async()=>{
  const svc=createCapabilityService({stateDir:path.join(root,'operations')});let calls=0,release;
  const gate=new Promise(r=>{release=r;});
  svc.broker.register({id:'fixture.long',permission:'publish',risk:'high',execute:async()=>{calls++;await gate;return{done:true};}});
  const pending=await svc.broker.execute({actor:{kind:'owner',id:'desktop'},capability:'fixture.long',requestId:'long-once'});
  const ui=createDesktopUiService({services:{capabilityService:svc}});
  const response=await ui.execute({method:'ui.approvals.decide',params:{id:pending.approvalId,approve:true}});
  assert.equal(response.status,'accepted');assert.ok(response.operationId);
  const repeated=await ui.execute({method:'ui.approvals.decide',params:{id:pending.approvalId,approve:true}});
  assert.equal(repeated.operationId,response.operationId);
  await assert.rejects(ui.execute({method:'ui.approvals.decide',params:{id:pending.approvalId,approve:false}}),{code:'REQUEST_ID_CONFLICT'});
  await wait(()=>svc.execute({method:'capability.operation.get',params:{id:response.operationId}}),r=>r.status==='running');
  assert.equal(calls,1);release();
  await wait(()=>ui.execute({method:'ui.approvals.operation',params:{id:response.operationId}}),r=>r.status==='completed');
  assert.equal(calls,1);await svc.close();
});
fs.rmSync(root,{recursive:true,force:true});if(failed)process.exitCode=1;
