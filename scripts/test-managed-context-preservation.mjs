import assert from 'node:assert/strict';
import { createManagedAgentProvider } from '../src/agent/managed-agent-provider.js';
const principal = { taskId:'t', workspaceId:'w', actor:{kind:'agent',id:'a',grants:{taskIds:['t'],workspaceIds:['w'],capabilities:['filesystem.read']}}};
let calls=0;
const runtime = createManagedAgentProvider({taskPrincipalResolver:()=>principal,
 modelRuntime:{chat:async request => {
   if (++calls === 1) return {text:JSON.stringify({capability:'filesystem.read',input:{path:'x'}})};
   const reference = JSON.parse(request.messages.at(-1).content);
   assert.equal(reference.result.result.content.endsWith('FINAL_EVIDENCE'), true);
   return {text:JSON.stringify({final:'Evidence retained'})};
 }}, capabilityExecutor: async()=>({status:'completed',result:{content:'x'.repeat(70000)+'FINAL_EVIDENCE'}})});
const {sessionId}=await runtime.provider.createSession({});
const accepted=await runtime.provider.send({sessionId,content:'Keep evidence'});
for await (const event of runtime.provider.follow({sessionId})) {
 if(event.type==='turn/end' && event.data.requestId===accepted.requestId) {
  assert.equal(event.data.reason.kind,'completed',JSON.stringify(event.data.reason)); break;
 }
}
assert.equal(calls,2);
console.log('managed context preservation passed');
