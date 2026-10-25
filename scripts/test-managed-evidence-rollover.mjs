import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createManagedAgentProvider} from '../src/agent/managed-agent-provider.js';
import {createToolEvidenceStore} from '../src/context/tool-evidence.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'managed-evidence-'));
try{
 const evidenceStore=createToolEvidenceStore({stateDir:dir});
 const principal={taskId:'t',workspaceId:'w',actor:{kind:'agent',id:'a',grants:{taskIds:['t'],workspaceIds:['w'],capabilities:['filesystem.read','context.evidence.read']}}};
 let calls=0;let receipt;
 const runtime=createManagedAgentProvider({evidenceStore,taskPrincipalResolver:()=>principal,onUsage:row=>{receipt=row;},
  modelRuntime:{chat:async request=>{
   calls++;
   assert.ok(request.messages.some(m=>m.content==='GOAL: preserve approval and unfinished work'));
   if(calls===1)return{text:JSON.stringify({capability:'filesystem.read',input:{path:'file.txt'}})};
   const ref=JSON.parse(request.messages.at(-1).content);assert.equal(ref.result.representation,'stored-tool-evidence');assert.equal(ref.result.incomplete,true);
   return{text:JSON.stringify({final:'Need to retrieve omitted evidence before claiming completion'})};
  }},capabilityExecutor:async()=>({status:'completed',result:{content:'x'.repeat(600000)+'TAIL'}})});
 const {sessionId}=await runtime.provider.createSession({});const sent=await runtime.provider.send({sessionId,content:'GOAL: preserve approval and unfinished work'});
 for await(const event of runtime.provider.follow({sessionId}))if(event.type==='turn/end'&&event.data.requestId===sent.requestId){assert.equal(event.data.reason.kind,'completed',JSON.stringify(event.data.reason));break;}
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(calls,2);assert.equal(receipt.taskId,'t');assert.equal(receipt.turnId,sent.requestId);assert.equal(receipt.sessionId,sessionId);
 await runtime.close();console.log('managed evidence rollover: >512KiB tool body, goals and task-bound receipt retained');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
