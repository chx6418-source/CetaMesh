import assert from 'node:assert/strict';
import {createManagedAgentProvider} from '../src/agent/managed-agent-provider.js';
for (const scenario of ['cancel','error']) {
let resumes=0;
const principal={taskId:'t',workspaceId:'w',actor:{kind:'agent',id:'a',grants:{taskIds:['t'],workspaceIds:['w'],capabilities:[]}}};
let target; const observed=[];
const runtime=createManagedAgentProvider({taskPrincipalResolver:()=>principal,modelRuntime:{chat:async()=>{throw Error('fixture must not infer directly');}},
 onTurnEnd:event=>{ observed.push(event); if(observed.length > 1) throw new Error('SECRET_ACCOUNTING_CALLBACK_DETAIL'); },toolExecutionCoordinator:{
 run:async request=>{target={kind:'agent',sessionId:request.sessionId,turnId:request.turnId};return {status:'pending',approvalId:'a',usage:{inputTokens:10,totalTokens:12}};},
 pendingTarget:()=>target,resumeApproval:async()=>{ if(++resumes>1) throw Object.assign(new Error('fixture failure'),{code:'FIXTURE_FAILED',usage:{inputTokens:40,totalTokens:48,accountingComplete:false}}); return {status:'pending',approvalId:'b',usage:{inputTokens:30,totalTokens:35}}; },cancelSession:()=>({cancelled:1})}
});
const {sessionId}=await runtime.provider.createSession({});
const ack=await runtime.provider.send({sessionId,content:'Two approvals then cancel'});
for await(const event of runtime.provider.follow({sessionId})) if(event.type==='turn/end'&&event.data.requestId===ack.requestId) break;
assert.equal((await runtime.resumeApproval({approvalId:'a',decisionResult:{status:'completed'}})).pending,true);
assert.equal((await runtime.provider.contextUsage({sessionId})).tokenUsage.inputTokens,30);
assert.equal(observed.at(-1).usage.inputTokens,30,'pending resumed inference reaches accounting callback');
assert.equal(observed.at(-1).outcome,'waiting');
const diagnostic = await runtime.provider.status({sessionId});
assert.equal(diagnostic.accountingWarning?.code,'TURN_ACCOUNTING_FAILED');
assert.equal(JSON.stringify(diagnostic).includes('SECRET_ACCOUNTING_CALLBACK_DETAIL'),false);
if(scenario==='cancel') await runtime.provider.cancel({sessionId});
else {
 assert.equal((await runtime.resumeApproval({approvalId:'b',decisionResult:{status:'completed'}})).resumed,false);
 assert.equal(observed.at(-1).usage.inputTokens,40);
 assert.equal(observed.at(-1).outcome,'failed');
 assert.equal(observed.at(-1).usage.accountingComplete,false);
}
assert.equal((await runtime.provider.contextUsage({sessionId})).tokenUsage.totalTokens,scenario==='cancel'?35:48);
console.log('pending Managed Agent cumulative usage preserved');

}
