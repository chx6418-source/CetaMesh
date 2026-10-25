import assert from 'node:assert/strict';
import {createManagedAgentProvider} from '../src/agent/managed-agent-provider.js';
const principal={taskId:'t',workspaceId:'w',actor:{kind:'agent',id:'a',grants:{taskIds:['t'],workspaceIds:['w'],capabilities:['clock.now']}}};
async function run(options){
 const receipts=[];const runtime=createManagedAgentProvider({...options,taskPrincipalResolver:()=>principal,onUsage:r=>receipts.push(structuredClone(r))});
 const {sessionId}=await runtime.provider.createSession({model:'requested-alias',modelProvider:'p'});
 const sent=await runtime.provider.send({sessionId,content:'do two steps'});let terminal;
 for await(const event of runtime.provider.follow({sessionId}))if(event.type==='turn/end'&&event.data.requestId===sent.requestId){terminal=event.data;break;}
 await runtime.close();return{terminal,receipts};
}
let calls=0;
const failed=await run({capabilityExecutor:async()=>({status:'completed',result:{time:'now'}}),modelRuntime:{chat:async()=>{
 if(++calls===1)return{text:JSON.stringify({capability:'clock.now',input:{}}),resolvedModel:'actual-snapshot',usage:{prompt_tokens:10,completion_tokens:2}};
 throw Object.assign(new Error('transport'),{code:'TRANSPORT_FAILED'});
}}});
assert.equal(failed.terminal.usage.requestCount,2);
assert.equal(failed.terminal.usage.accountingComplete,false);
assert.equal(failed.terminal.usage.requests[0].model,'actual-snapshot');
assert.equal(failed.terminal.usage.requests[1].inputTokens,null);
assert.equal(failed.receipts[0].usage.requestCount,1,'persist first successful request before next transport');
assert.equal(failed.receipts[0].model,'actual-snapshot');
const partial=await run({toolExecutionCoordinator:{run:async()=>({status:'unsupported'})},modelRuntime:{chat:async()=>{},async *stream(){
 yield{type:'assistant/message',data:{message:{content:'partial',usage:{input_tokens:12,output_tokens:3}},resolvedModel:'actual-stream'}};
 throw Object.assign(new Error('stream transport'),{code:'STREAM_FAILED'});
}}});
assert.equal(partial.terminal.usage.requestCount,1);
assert.equal(partial.terminal.usage.inputTokens,12);
assert.equal(partial.terminal.usage.outputTokens,3);
assert.equal(partial.terminal.usage.accountingComplete,false);
assert.equal(partial.terminal.usage.requests[0].model,'actual-stream');
console.log('Managed failed request accounting: prior+unknown transport and partial stream retained');
