import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';
for (const scenario of ['cancel', 'error']) {
let resumes=0; const receipts=[];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-pending-usage-'));
let target;
const service=createChatService({onUsage:payload=>receipts.push(payload),stateDir:dir,defaults:{model:'fixture'},api:{},
 modelRuntime:{defaultProviderId:()=> 'fixture',resolveProvider:id=>({id}),supportsToolCalling:()=>true},
 toolExecutionCoordinator:{
  run:async request=>{target={kind:'chat',sessionId:request.sessionId,turnId:request.turnId};return {status:'pending',approvalId:'a',usage:{inputTokens:10,outputTokens:2,totalTokens:12}};},
  pendingTarget:()=>target,
  resumeApproval:async()=>{ if(++resumes>1) throw Object.assign(new Error('fixture failure'),{code:'FIXTURE_FAILED',usage:{inputTokens:40,totalTokens:48,accountingComplete:false}}); return {status:'pending',approvalId:'b',usage:{inputTokens:30,outputTokens:5,totalTokens:35}}; },
  cancelSession:()=>({cancelled:1})}
});
try {
 const session=await service.execute({method:'chat.sessions.create',params:{}});
 await service.execute({method:'chat.send',params:{id:session.id,text:'Two approvals then cancel'}});
 const deadline=Date.now()+3000;
 while((await service.execute({method:'chat.status',params:{id:session.id}})).turn?.state !== 'waiting-approval') {
  assert.ok(Date.now()<deadline,'must reach approval'); await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.equal((await service.resumeApproval({approvalId:'a',decisionResult:{status:'completed'}})).pending,true);
 if(scenario==='cancel') await service.execute({method:'chat.stop',params:{id:session.id}});
 else assert.equal((await service.resumeApproval({approvalId:'b',decisionResult:{status:'completed'}})).resumed,false);
 const history=await service.execute({method:'chat.history',params:{id:session.id}});
 assert.equal(receipts.length,1,'one durable accounting callback per completed/cancelled/failed turn');
 assert.equal(receipts[0].sessionId,session.id);
 assert.equal(receipts[0].taskId,null,'do not infer task attribution at callback time');
 assert.ok(receipts[0].turnId);
 assert.equal(receipts[0].providerId,'fixture');
 assert.equal(receipts[0].model,null,'provider default is unknown until receipt identifies it');
 assert.equal(receipts[0].usage.totalTokens,scenario==='cancel'?35:48);
 assert.equal(history.messages.at(-1).usage.inputTokens,scenario==='cancel'?30:40);
 assert.equal(history.messages.at(-1).usage.totalTokens,scenario==='cancel'?35:48);
 if(scenario==='error') assert.equal(history.messages.at(-1).usage.accountingComplete,false);
 console.log(`pending Chat cumulative usage preserved on ${scenario}`);
} finally {service.close();fs.rmSync(dir,{recursive:true,force:true});}

}

// Plain streaming has no coordinator receipt: bill the provider's resolved model,
// not a request alias or the unknown provider-default selection.
const { createUsageLedger } = await import('../src/model/usage-ledger.js');
for (const requested of [null, 'requested-alias']) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-stream-usage-'));
 const billed=[];
 const ledger=createUsageLedger({file:path.join(dir,'usage.json'),pricingResolver:({providerId,model})=>({providerId,model:'actual-fixture',currency:'USD',source:'fixture',version:'v1',inputPerMillion:2,outputPerMillion:4,cacheReadPerMillion:2,cacheWritePerMillion:2})});
 const chat=createChatService({stateDir:dir,defaults:{model:'fixture-default'},onUsage:row=>{billed.push(row);ledger.record(row);},
  modelRuntime:{defaultProviderId:()=> 'fixture',resolveProvider:id=>({id}),supportsToolCalling:()=>false,
   async *stream(){yield {type:'turn/start',data:{}};yield {type:'turn/end',data:{reason:{kind:'completed'},requestedModel:requested??'provider-default',resolvedModel:'actual-fixture',usage:{inputTokens:100,outputTokens:20,requestCount:1}}};}}
 });
 try {
  const session=await chat.execute({method:'chat.sessions.create',params:{}});
  if(requested) await chat.execute({method:'chat.config.set',params:{id:session.id,config:{model:requested}}});
  await chat.execute({method:'chat.send',params:{id:session.id,text:'fixture'}});
  const deadline=Date.now()+3000;
  while(!billed.length){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}
  assert.equal(billed[0].model,'actual-fixture');
  assert.equal(ledger.summary({sessionId:session.id}).cost.amount,0.00028);
 } finally {chat.close();fs.rmSync(dir,{recursive:true,force:true});}
}
console.log('plain Chat bills verified resolved model rather than request/default alias PASS');
