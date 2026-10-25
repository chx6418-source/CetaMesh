import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createToolEvidenceStore,evidenceBinding} from '../src/context/tool-evidence.js';
import {createToolExecutionCoordinator} from '../src/model/tool-execution.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-evidence-execution-'));
try {
 const evidenceStore=createToolEvidenceStore({stateDir:dir});
 const actor={kind:'agent',id:'a'};const scope={taskId:'t',workspaceId:'w'};
 let calls=0; let reference;let summaryBytes=0;const receipts=[];
 const coordinator=createToolExecutionCoordinator({stateDir:dir,evidenceStore,onUsage:row=>receipts.push(row),
  modelRuntime:{chat:async request=>{
   calls++;
   if(calls===1)return {toolCalls:[{id:'native-1',capabilityId:'filesystem.read',arguments:{}}],modelContinuation:{opaque:'must-preserve'}};
   if(calls===2){
    const output=request.messages.at(-1); assert.equal(output.tool_call_id,'native-1');
    const summary=JSON.parse(output.content); assert.equal(summary.representation,'stored-tool-evidence'); assert.equal(summary.incomplete,true);
    assert.ok(output.content.length<12000); summaryBytes=Buffer.byteLength(output.content); reference=summary.evidence;
    assert.deepEqual(request.messages.at(-2).modelContinuation,{opaque:'must-preserve'});
    return {toolCalls:[{id:'native-2',capabilityId:'context.evidence.read',arguments:{id:reference.id,offset:reference.chars-120,limit:120}}]};
   }
   assert.match(request.messages.at(-1).content,/END-EVIDENCE/);return {text:'Verified final page'};
  }},
  capabilityBroker:{execute:async request=>request.capability==='filesystem.read'
   ? {status:'completed',result:{text:'x'.repeat(600000)+'END-EVIDENCE',token:'sk-secret-never-store'}}
   : {status:'completed',result:evidenceStore.read({...request.input,binding:evidenceBinding({actor:request.actor,sessionId:request.origin.sessionId,scope:{taskId:request.taskId,workspaceId:request.workspaceId}}),authorizeSource:()=>true})}}
 });
 const result=await coordinator.run({actor,scope,sessionId:'s',turnId:'turn',messages:[{role:'user',content:'Retain original goal and unfinished work'}],manifest:['filesystem.read','context.evidence.read'].map(id=>({id,description:id,inputSchema:{type:'object',additionalProperties:true}}))});
 assert.equal(result.status,'completed');assert.equal(calls,3);assert.equal(receipts.length,3);assert.equal(receipts[0].taskId,'t');assert.equal(receipts[0].turnId,'turn');assert.equal(receipts[0].usage.requestCount,1);assert.equal(result.messages[0].content,'Retain original goal and unfinished work');
 const saved=fs.readFileSync(path.join(dir,'model','tool-evidence',reference.id+'.json'),'utf8');assert.equal(saved.includes('sk-secret-never-store'),false);
 console.log('tool evidence execution: native IDs/full output/retrieval/sanitization passed');
 console.log(JSON.stringify({fixture:'native-tool-evidence',storedSanitizedBytes:reference.bytes,summaryBytes,retrievedPages:1,retrievedChars:120,sha256:reference.sha256,providerCalls:calls,liveProvider:false}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
