import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createApprovalOperations} from '../src/capability/operations.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {createDesktopIpcRuntime} from '../src/app/ipc-runtime.js';
import {startIpcProtocol} from '../src/control/ipc-protocol.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {readJsonFile,writeJsonAtomic} from '../src/storage/json-file.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'comm-approval-operations-'));
const services=[];
const gates=[];
const realNow=Date.now;
async function until(read, done) {
  const deadline=realNow()+3000;
  while(realNow()<deadline) {const value=await read();if(done(value))return value;await delay(5);}
  assert.fail('Operation failed to reach expected state');
}
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});gates.push(()=>resolve({}));return {promise,resolve};}
async function fixture(name) {
  const stateDir=path.join(root,name),capabilityService=createCapabilityService({stateDir});
  services.push(capabilityService);
  const gate=deferred();let effects=0,entered=0;
  capabilityService.broker.register({id:'fixture.blocked',permission:'publish',risk:'high',
    execute:async()=>{entered++;await gate.promise;effects++;return {proof:'finished'};}});
  const ui=createDesktopUiService({services:{capabilityService}});
  const pending=await capabilityService.broker.execute({actor:OWNER_ACTOR,capability:'fixture.blocked',input:{}});
  return {stateDir,capabilityService,ui,pending,gate,effects:()=>effects,entered:()=>entered};
}
const operation=(f,id)=>f.ui.execute({method:'ui.approvals.operation',params:{id}});
try {
  const long=await fixture('long');
  const runtime=createDesktopIpcRuntime({services:{desktopUiService:long.ui,capabilityService:long.capabilityService}});
  const input=new PassThrough(),output=new PassThrough();const chunks=[];
  output.on('data',chunk=>chunks.push(Buffer.from(chunk)));
  const protocol=startIpcProtocol({input,output,dispatch:runtime.dispatch,dispatchTimeoutMs:100});
  const disconnected=protocol.done.then(()=>null,error=>error);
  const body=Buffer.from(JSON.stringify({version:1,id:'decision',method:'control.execute',params:{method:'ui.approvals.decide',params:{id:long.pending.approvalId,approve:true}}}));
  const frame=Buffer.alloc(4+body.length);frame.writeUInt32LE(body.length);body.copy(frame,4);input.write(frame);
  await until(()=>long.entered(),v=>v===1);
  let bytes=Buffer.concat(chunks),frames=[];
  while(bytes.length>=4) {const n=bytes.readUInt32LE(0);if(bytes.length<4+n)break;frames.push(JSON.parse(bytes.subarray(4,4+n)));bytes=bytes.subarray(4+n);}
  const ack=frames.find(f=>f.id==='decision');
  assert.equal(ack?.result?.status,'accepted','RPC returns acceptance while real tool remains blocked');
  const id=ack.result.operationId;
  assert.equal(long.effects(),0);
  // Advance logical wall time only. This is not a claim of 61 seconds real elapsed time.
  Date.now=()=>realNow()+61000;
  try {assert.equal((await operation(long,id)).status,'running');} finally {Date.now=realNow;}
  const duplicate=await long.ui.execute({method:'ui.approvals.decide',params:{id:long.pending.approvalId,approve:true}});
  assert.equal(duplicate.operationId,id);
  assert.equal(long.entered(),1,'duplicate submission never redispatches');
  await assert.rejects(long.ui.execute({method:'ui.approvals.decide',params:{id:long.pending.approvalId,approve:false}}),{code:'REQUEST_ID_CONFLICT'});
  await delay(150); // Exceed this real transport's 100 ms dispatch timeout while work is gated.
  assert.equal((await operation(long,id)).status,'running');
  assert.equal(long.effects(),0);
  output.destroy(new Error('synthetic RPC disconnection'));
  await disconnected;
  assert.equal((await operation(long,id)).status,'running','disconnect cannot cancel durable accepted operation');
  long.gate.resolve();
  assert.equal((await until(()=>operation(long,id),r=>r.status==='completed')).decision,'approved');
  assert.equal(long.effects(),1);
  assert.equal((await long.ui.execute({method:'ui.approvals.decide',params:{id:long.pending.approvalId,approve:true}})).operationId,id);
  assert.equal(long.entered(),1);
  console.log('PASS COMM02 blocked tool acceptance, logical +61 seconds, RPC disconnect, dedup and final once-only completion');

  let dispatched=0;
  const before=createApprovalOperations({stateDir:path.join(root,'pre-cancel'),getApproval:()=>({status:'pending'}),execute:async()=>{dispatched++;return {};}});
  const beforeAck=before.submit({id:'pre',approve:true});
  before.cancel(beforeAck.operationId);
  assert.equal((await until(()=>before.get(beforeAck.operationId),r=>r.status==='cancelled')).code,'INVOKE_CANCELLED');
  assert.equal(dispatched,0);await before.close();
  console.log('PASS COMM02 cancellation before dispatch performs no work');

  const after=await fixture('post-cancel');
  const afterAck=await after.ui.execute({method:'ui.approvals.decide',params:{id:after.pending.approvalId,approve:true}});
  await until(()=>after.entered(),v=>v===1);
  const cancelled=await after.ui.execute({method:'ui.approvals.cancel',params:{id:afterAck.operationId}});
  assert.equal(cancelled.cancelRequested,true);
  const unknown=await until(()=>operation(after,afterAck.operationId),r=>r.status==='unknown');
  assert.equal(unknown.code,'INVOKE_CANCEL_UNCONFIRMED');
  assert.equal(after.effects(),0);
  after.gate.resolve();await until(()=>after.effects(),n=>n===1);
  assert.equal((await operation(after,afterAck.operationId)).status,'unknown','unconfirmed effect must never be labelled cancelled');
  assert.equal((await after.ui.execute({method:'ui.approvals.decide',params:{id:after.pending.approvalId,approve:true}})).status,'unknown');
  assert.equal(after.entered(),1,'unknown outcome may not be replayed');
  console.log('PASS COMM02 cancellation after dispatch preserves unknown outcome and never fakes cancellation');

  const crashDir=path.join(root,'crash'), recoveredDir=path.join(root,'recovered');
  const crashGate=deferred();let replayed=0;
  const crash=createApprovalOperations({stateDir:crashDir,getApproval:()=>({status:'pending'}),execute:()=>crashGate.promise});
  const crashAck=crash.submit({id:'restart',approve:true});
  await until(()=>crash.get(crashAck.operationId),r=>r.status==='running');
  writeJsonAtomic(path.join(recoveredDir,'capability','operations.json'),readJsonFile(path.join(crashDir,'capability','operations.json')));
  const recovered=createApprovalOperations({stateDir:recoveredDir,getApproval:()=>({status:'pending'}),execute:async()=>{replayed++;return {};}});
  assert.equal(recovered.get(crashAck.operationId).status,'unknown');
  assert.equal(recovered.get(crashAck.operationId).code,'CORE_RESTART_RECONCILIATION_REQUIRED');
  assert.equal(recovered.submit({id:'restart',approve:true}).status,'unknown');
  assert.equal(replayed,0);
  crashGate.resolve({});await crash.close();await recovered.close();
  console.log('PASS COMM02 restart of persisted in-flight operation requires reconciliation and never replays');
} finally {
  Date.now=realNow;
  for(const release of gates)release();
  for(const service of services)await service.close();
  fs.rmSync(root,{recursive:true,force:true});
}
