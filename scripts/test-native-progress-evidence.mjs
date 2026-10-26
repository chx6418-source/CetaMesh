import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { runClaudeSdkRunner } from '../src/agent/claude-sdk-runner.js';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { createTaskService } from '../src/task/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createCapabilityService } from '../src/capability/service.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-progress-'));const source=path.join(root,'workspace');fs.mkdirSync(source);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');const failures=[];
async function check(name,run){try{await run();console.log('PASS',name);}catch(e){failures.push(name);console.error('FAIL',name,e.stack);}}
try{
 await check('actual ACP result has current Core run and output digest, activity alone does not',async()=>{
  const input=new PassThrough(),output=new PassThrough();let closed;const done=new Promise(r=>closed=r);let buffer='';
  input.on('data',chunk=>{buffer+=chunk;let nl;while((nl=buffer.indexOf('\n'))>=0){const text=buffer.slice(0,nl);buffer=buffer.slice(nl+1);if(!text)continue;const req=JSON.parse(text);if(!req.id)continue;let result={};
   if(req.method==='initialize')result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
   if(req.method==='session/new')result={sessionId:'native'};
   if(req.method==='session/prompt'){
    for(const update of [{sessionUpdate:'tool_call_update',toolCallId:'activity-only',kind:'read',status:'completed'},
     {sessionUpdate:'tool_call_update',toolCallId:'actual-read',kind:'read',status:'completed',rawOutput:{text:'actual source bytes'}},
     {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Finished source review.'}}])output.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native',update}})+'\n');
    result={stopReason:'end_turn'};
   } output.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
  }});
  const provider=createAcpAgentProvider({descriptor:{id:'fixture',label:'Fixture',protocolVersion:1,verifiedRuntime:true,security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true}},
   stagingRoot:path.join(root,'staging'),resolveTaskWorkspace:()=>({task:{id:'t',workspaceId:'w'},workspace:{id:'w',root:source}}),
   launch:()=>({readable:output,writable:input,done,close:async()=>{closed({exitCode:0});}})});
  try{const session=await provider.createSession({taskId:'t',workspaceId:'w'});await provider.send({sessionId:session.sessionId,content:'read',runId:'core-run',phase:'user'});const events=[];for await(const row of provider.follow({sessionId:session.sessionId})){events.push(row.event);if(row.event.type==='turn/end')break;}
   assert.ok(events.every(e=>e.data.runId==='core-run'&&e.data.phase==='user'),'Core run identity covers start, result and terminal');
   const results=events.filter(e=>e.type==='tool/result');assert.equal(results.length,1);assert.equal(results[0].data.capability,'fixture.native.read');assert.equal(results[0].data.source,'native-result');assert.equal(results[0].data.resultSha256,hash(JSON.stringify({text:'actual source bytes'})));assert.equal(JSON.stringify(results).includes('actual source bytes'),false);
  }finally{await provider.shutdown();}
 });
 await check('Claude actual SDK tool result is correlated to approved invocation, not invented activity',async()=>{
  const input=new PassThrough(),output=new PassThrough(),updates=[];
  const done=runClaudeSdkRunner({input,output,loadSdk:async()=>({query({options}){return {async *[Symbol.asyncIterator](){
    const hook=options.hooks.PreToolUse[0].hooks[0];const decision=await hook({hook_event_name:'PreToolUse',tool_name:'Read',tool_input:{file_path:'sample.txt'},tool_use_id:'sdk-tool'},'sdk-tool',{signal:new AbortController().signal});assert.equal(decision.hookSpecificOutput.permissionDecision,'allow');
    yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'sdk-tool',content:'actual SDK source',is_error:false},{type:'tool_result',tool_use_id:'unapproved',content:'forged result'}]}};
    yield {type:'result',subtype:'success',session_id:'native-session'};
  },async interrupt(){}};}})});
  const client=createJsonRpcTransport({readable:output,writable:input,framing:'acp-v1-jsonl',onRequest:async()=>({outcome:{outcome:'selected',optionId:'allow'}}),onNotification:(method,params)=>{if(method==='session/update')updates.push(params.update);}});
  try{await client.request('initialize',{credential:'synthetic-private',runtimePath:'/verified',cwd:'/fixture',tools:['Read']});const session=await client.request('session/new',{cwd:'/fixture',mcpServers:[]});await client.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'read'}]},{timeoutMs:0});
   const results=updates.filter(row=>row.sessionUpdate==='tool_call_update'&&row.rawOutput!==undefined);assert.equal(results.length,1);assert.equal(results[0].toolCallId,'sdk-tool');assert.deepEqual(results[0].rawOutput,{content:'actual SDK source',isError:false});
  }finally{input.end();await done;await client.close();}
 });
 await check('approved real workspace import records final content hash, not pending or stale import',async()=>{
  const ws=createWorkspaceService({stateDir:path.join(root,'state')});const workspace=(await ws.execute({method:'workspace.create',params:{root:source,name:'test'}})).workspace;
  const ts=createTaskService({stateDir:path.join(root,'task-state')});const rt=ts.runtime;let t=rt.create({goal:'import fixture',workspaceId:workspace.id});t=rt.start({id:t.id,expectedRev:t.rev,provider:'fixture',sessionId:'s'}).task;
  if(rt.beginExecutionObservation)t=rt.beginExecutionObservation({id:t.id,...t.currentAgent,runId:'run',phase:'user'});
  const cap=createCapabilityService({workspaceService:ws,taskRuntime:rt});cap.grantTask(t.id,{capabilities:['filesystem.write']});
  try{const content='approved bytes';const changes=[{action:'write',path:'result.txt',content,expectedHash:null,hash:hash(content)}];const pending=await cap.applyAgentWorkspaceChanges({taskId:t.id,workspaceId:workspace.id,...t.currentAgent,runId:'run',phase:'user',requestId:'import-1',changes});
   assert.equal(pending.status,'pending');assert.equal(rt.get({id:t.id}).task.executionEvidence.length,0);assert.equal(fs.existsSync(path.join(source,'result.txt')),false);
   const result=await cap.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:true}});assert.equal(result.status,'completed');assert.equal(fs.readFileSync(path.join(source,'result.txt'),'utf8'),content);
   const evidence=rt.get({id:t.id}).task.executionEvidence;assert.equal(evidence.length,1);assert.equal(evidence[0].source,'core-import');assert.equal(evidence[0].runId,'run');assert.equal(evidence[0].changes[0].sha256,hash(content));assert.equal(evidence[0].changes[0].path,'result.txt');
   await assert.rejects(cap.applyAgentWorkspaceChanges({taskId:t.id,workspaceId:workspace.id,...t.currentAgent,runId:'old',phase:'user',requestId:'stale',changes:[{action:'write',path:'stale.txt',content:'stale',expectedHash:null,hash:hash('stale')}]}),{code:'AGENT_ASSIGNMENT_EXPIRED'});
   t=rt.observeExecution({id:t.id,...t.currentAgent,runId:'run',phase:'user',state:'awaiting-review'});
   const ui=createDesktopUiService({services:{taskService:ts,capabilityService:cap,agentBroker:{status:async()=>({running:false,lastRunStatus:'completed'})}}});
   fs.writeFileSync(path.join(source,'result.txt'),'changed after import');
   await assert.rejects(ui.execute({method:'ui.task.complete',params:{id:t.id,expectedRev:t.rev,reviewed:true,summary:'Review actual file'}}),{code:'TASK_IMPORT_CHANGED'});
   fs.writeFileSync(path.join(source,'result.txt'),content);
   const accepted=await ui.execute({method:'ui.task.complete',params:{id:t.id,expectedRev:t.rev,reviewed:true,summary:'Review actual file'}});assert.equal(accepted.task.status,'completed');

  }finally{await cap.close();}
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
assert.equal(failures.length,0,failures.join('; '));
