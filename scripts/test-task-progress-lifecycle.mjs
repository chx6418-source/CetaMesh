import { createApprovalOperations } from '../src/capability/operations.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createDshAgentProvider } from '../src/agent/dsh-agent-provider.js';
import { createStagedDshAgentProvider } from '../src/agent/staged-dsh-agent-provider.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createCapabilityService } from '../src/capability/service.js';
const failures=[];
async function check(name, run) { try { await run(); console.log('PASS',name); } catch(error) { failures.push(name); console.error('FAIL',name,error.stack); } }
await check('early DSH Follow retains authoritative Core provenance before prompt acknowledgement',async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-dsh-early-'));const source=path.join(root,'workspace');fs.mkdirSync(source);
const rt=createTaskRuntime({stateDir:root});let t=rt.create({goal:'Analyze the supplied prompt',workspaceId:'w'});let requestId,wake;const prompted=new Promise(r=>wake=r);
const api={async callEndpoint(endpoint,args){
 if(endpoint==='session/create')return{sessionId:'dsh-s'};
 if(endpoint==='session/list')return{items:[{sessionId:'dsh-s',running:false,projections:{values:{}}}]};
 if(endpoint==='session/prompt'){requestId=args.request.requestId;wake();await new Promise(r=>setTimeout(r,100));return{};}
 return{};
},async *openRemoteStream(){await prompted;yield{type:'snapshot',cursor:0,records:[],hasMore:false};
 for(const [i,e] of [{type:'turn/start'},{type:'assistant/message',data:{message:{content:[{type:'text',text:'A legitimate no-tool report.'}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}}].entries())yield{type:'event',event:{seq:i+1,...e,data:{...e.data,requestId,turn:'native-t'}}};
}};
const native=createDshAgentProvider({api});const provider=createStagedDshAgentProvider({provider:native,stagingRoot:path.join(root,'stage'),resolveTaskWorkspace:()=>({task:rt.get({id:t.id}).task,workspace:{id:'w',root:source}}),applyChanges:()=>{throw new Error('no changes expected');}});
const registry=createAgentProviderRegistry({providers:[provider]});const broker=createAgentBroker({registry});const cap=createCapabilityService({taskRuntime:rt,agentBroker:broker});
try{const s=await broker.createSession('dsh',{taskId:t.id,workspaceId:'w'});t=rt.start({id:t.id,expectedRev:t.rev,provider:'dsh',sessionId:s.sessionId}).task;
 await broker.send({provider:'dsh',sessionId:s.sessionId,runId:'core-r',content:'analyze'});await new Promise(r=>setTimeout(r,50));t=rt.get({id:t.id}).task;
 assert.equal(t.executionObservation.state,'awaiting-review');assert.equal(t.agentReports[0].runId,'core-r');assert.equal(t.agentReports[0].phase,'user');assert.equal(cap.completionBlocker(t.id),null);
}finally{await cap.close();await provider.shutdown();fs.rmSync(root,{recursive:true,force:true});}

});
await check('known native busy rejection preserves the actual current run and Follow obligation',async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-native-busy-'));const source=path.join(root,'workspace');fs.mkdirSync(source);const rt=createTaskRuntime({stateDir:root});let t=rt.create({goal:'analysis',workspaceId:'w'});const input=new PassThrough(),output=new PassThrough();let closed;const done=new Promise(r=>closed=r);let buffer='',promptId;
input.on('data',chunk=>{buffer+=chunk;let nl;while((nl=buffer.indexOf('\n'))>=0){const req=JSON.parse(buffer.slice(0,nl));buffer=buffer.slice(nl+1);if(!req.id)continue;if(req.method==='session/prompt'){promptId=req.id;continue;}const result=req.method==='initialize'?{protocolVersion:1}:req.method==='session/new'?{sessionId:'native'}:{};output.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');}});
const provider=createAcpAgentProvider({descriptor:{id:'fixture',label:'Fixture',protocolVersion:1,verifiedRuntime:true,security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true}},stagingRoot:path.join(root,'stage'),resolveTaskWorkspace:()=>({task:rt.get({id:t.id}).task,workspace:{id:'w',root:source}}),launch:()=>({readable:output,writable:input,done,close:async()=>closed({exitCode:0})})});
const registry=createAgentProviderRegistry({providers:[provider]});const broker=createAgentBroker({registry});const cap=createCapabilityService({taskRuntime:rt,agentBroker:broker});
try{const scope=broker.describeExecutionSecurity('fixture','w');broker.authorizeExecution('fixture','w',scope.fingerprint);const s=await broker.createSession('fixture',{taskId:t.id,workspaceId:'w'});t=rt.start({id:t.id,expectedRev:t.rev,provider:'fixture',sessionId:s.sessionId}).task;await broker.send({...t.currentAgent,runId:'run-1',content:'analysis'});
await assert.rejects(broker.send({...t.currentAgent,runId:'rejected-run-2',content:'more work'}),{code:'TURN_BUSY'});
output.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Legitimate settled analysis'}}}})+'\n');output.write(JSON.stringify({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})+'\n');await new Promise(r=>setTimeout(r,20));t=rt.get({id:t.id}).task;assert.equal(t.executionObservation.runId,'run-1');assert.equal(t.executionObservation.state,'awaiting-review');assert.equal(t.agentReports[0].runId,'run-1');assert.equal(cap.completionBlocker(t.id),null);
}finally{await cap.close();await provider.shutdown();fs.rmSync(root,{recursive:true,force:true});}

});
for (const mismatch of ['taskId','sessionId','turnId','unknown']) await check(`continuation settlement does not accept ${mismatch} successor`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuation-fence-'));
  const request={taskId:'task',origin:{sessionId:'session',turnId:'turn'}};
  const other=structuredClone(request);if(mismatch==='taskId')other.taskId='other';else if(mismatch!=='unknown')other.origin[mismatch]='other';
  const approvals={a:{status:'pending',request},b:{status:'pending',request:other}};
  const operations=createApprovalOperations({stateDir:root,getApproval:id=>approvals[id],execute:async({id})=>{
    if(id==='a')return{status:'completed',turnResumed:true,resumePending:true,resumeApprovalId:'b'};
    if(mismatch==='unknown')throw Object.assign(new Error('effect unknown'),{effectStatus:'unknown'});
    return{status:'completed',turnResumed:true,resumePending:false};
  }});
  try {operations.submit({id:'a',approve:true});await new Promise(r=>setImmediate(r));assert.equal(operations.get('approval:a').status,'waiting');
    operations.submit({id:'b',approve:true});await new Promise(r=>setImmediate(r));assert.equal(operations.get('approval:a').status,'waiting');
    await operations.close();
    const restarted=createApprovalOperations({stateDir:root,getApproval:id=>approvals[id],execute:async()=>({})});
    assert.equal(restarted.get('approval:a').status,'unknown');await restarted.close();
  }finally{await operations.close();fs.rmSync(root,{recursive:true,force:true});}
});
assert.equal(failures.length,0,failures.join('; '));
