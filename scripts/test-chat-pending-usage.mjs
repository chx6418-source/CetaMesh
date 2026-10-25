import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';
for (const scenario of ['cancel', 'error']) {
let resumes=0;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-pending-usage-'));
let target;
const service=createChatService({stateDir:dir,defaults:{model:'fixture'},api:{},
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
 assert.equal(history.messages.at(-1).usage.inputTokens,scenario==='cancel'?30:40);
 assert.equal(history.messages.at(-1).usage.totalTokens,scenario==='cancel'?35:48);
 if(scenario==='error') assert.equal(history.messages.at(-1).usage.accountingComplete,false);
 console.log(`pending Chat cumulative usage preserved on ${scenario}`);
} finally {service.close();fs.rmSync(dir,{recursive:true,force:true});}

}
