import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {projectMessageBudget} from '../src/context/message-budget.js';
import {createToolEvidenceStore} from '../src/context/tool-evidence.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-evidence-'));
try{
 const evidenceStore=createToolEvidenceStore({stateDir:dir});const binding={actorKind:'agent',actorId:'a',sessionId:'s',taskId:'t',workspaceId:'w'};
 const messages=[{role:'user',content:'GOAL, DECISION, APPROVAL, UNFINISHED'},{role:'assistant',modelContinuation:{signed:'native'},tool_calls:[{id:'a',function:{name:'cap_filesystem_read',arguments:'{"path":"file.txt"}'}}]},{role:'tool',tool_call_id:'a',content:JSON.stringify({status:'completed',result:{content:'x'.repeat(600000)+'FULL-END'}})},{role:'assistant',tool_calls:[{id:'pending',function:{name:'cap_filesystem_read',arguments:'{"path":"next.txt"}'}}]}];
 const result=projectMessageBudget(messages,{evidenceStore,binding,canRetrieveEvidence:true});
 assert.ok(result.bytes<512*1024);assert.deepEqual(result.messages[0],messages[0]);assert.deepEqual(result.messages[1],messages[1]);assert.deepEqual(result.messages[3],messages[3]);assert.equal(result.messages[2].tool_call_id,'a');
 const ref=JSON.parse(result.messages[2].content);assert.equal(ref.representation,'stored-tool-evidence');
 assert.equal(evidenceStore.read({binding,id:ref.evidence.id,offset:ref.evidence.chars-20,limit:20,authorizeSource:()=>true}).content.endsWith('FULL-END"}}'),true);
 assert.equal(messages[2].content.length>600000,true);
 assert.throws(()=>projectMessageBudget(messages,{evidenceStore,binding,canRetrieveEvidence:false}),{code:'CONTEXT_BUDGET_EXCEEDED'});
 console.log('evidence context budget: safe backed rollover/native associations/uncompleted call preserved');
 console.log(JSON.stringify({fixture:'history-rollover',originalMessageBytes:Buffer.byteLength(JSON.stringify(messages)),projectedMessageBytes:result.bytes,configuredTransportLimitBytes:result.maxBytes,compactedToolResults:result.compactions.length,retainedMessages:result.messages.length,liveProvider:false}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
