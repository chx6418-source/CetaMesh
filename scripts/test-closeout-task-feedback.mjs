import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createToolExecutionCoordinator} from '../src/model/tool-execution.js';
import {validateSchema,schemaFailureDetail} from '../src/model/input-schema.js';
import {createManagedAgentProvider} from '../src/agent/managed-agent-provider.js';
import {createWorkspaceService} from '../src/workspace/index.js';
import {createTaskService} from '../src/task/index.js';
import {createCapabilityService} from '../src/capability/service.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-closeout-feedback-'));const failures=[];
async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+e.message);}}
try{
 await check('authorized Managed orchestrator receives bounded delegation guidance without granting unavailable tools',async()=>{
  for(const enabled of [false,true]){
   let captured;const principal={taskId:'t',workspaceId:'w',actor:{kind:'agent',id:'task:t',grants:{taskIds:['t'],workspaceIds:['w'],capabilities:[]}}};
   const managed=createManagedAgentProvider({modelRuntime:{chat:async()=>({})},taskPrincipalResolver:()=>principal,
    buildProductTurnContext:()=>({context:'{}',manifest:enabled?['agent.delegate.candidates','agent.delegate.propose'].map(id=>({id})):[]}),
    toolExecutionCoordinator:{run:async r=>{captured=r.messages;return {status:'completed',text:'Settled',messages:r.messages};}}});
   try{const session=await managed.provider.createSession({});const accepted=await managed.provider.send({sessionId:session.sessionId,content:'请交给 Codex 执行'});
    for await(const e of managed.provider.follow({sessionId:session.sessionId})){if(e.type==='turn/end'&&e.data.requestId===accepted.requestId)break;}
    const guidance=captured.some(m=>m.role==='system'&&m.content.includes('If canPropose is true'));
    assert.equal(guidance,enabled,'only an authorized delegation manifest may enable guidance');
   }finally{await managed.close();}
  }
 });
 await check('schema failure exposes field and constraint to model and UI, then bounded correction executes once',async()=>{
  let turns=0,executions=0;const activity=[];let correction;
  const c=createToolExecutionCoordinator({stateDir:root,modelRuntime:{chat:async r=>{
   turns++;if(turns===2)correction=JSON.parse(r.messages.findLast(m=>m.role==='tool').content);
   return turns<3?{toolCalls:[{id:'write-'+turns,capabilityId:'filesystem.write',arguments:{path:'task.md',content:turns===1?42:'verified correction'}}]}:{text:'done'};
  }},capabilityBroker:{execute:async()=>{executions++;return {status:'completed',result:{written:true}};}}});
  const result=await c.run({actor:{kind:'owner',id:'owner'},sessionId:'s',turnId:'t',messages:[],manifest:[{id:'filesystem.write',description:'Write a scoped task package',inputSchema:{type:'object',additionalProperties:false,required:['path','content'],properties:{path:{type:'string'},content:{type:'string'}}}}],onActivity:a=>activity.push(a)});
  assert.equal(result.status,'completed');assert.equal(executions,1);assert.equal(turns,3);assert.equal(correction.code,'TOOL_ARGUMENTS_INVALID');assert.deepEqual(correction.validation,{path:'$.content',reason:'expected string'});assert.ok(activity.some(a=>a.summary?.includes('$.content')));
 });
 await check('provider-supplied validation lookalike cannot leak its error detail',async()=>{
  const c=createToolExecutionCoordinator({modelRuntime:{chat:async()=>({toolCalls:[{id:'read',capabilityId:'read',arguments:{}}]})},maxCycles:1,capabilityBroker:{execute:async()=>{throw Object.assign(Error('private-secret'),{code:'TOOL_ARGUMENTS_INVALID',validation:{path:'private-secret',reason:'private-secret'}});}}});
  const result=await c.run({actor:{kind:'owner',id:'owner'},sessionId:'s',turnId:'t2',messages:[],manifest:[{id:'read',description:'Read fixture',inputSchema:{type:'object',properties:{}}}]});assert.ok(!JSON.stringify(result).includes('private-secret'));
 });
 await check('dynamic caller-owned keys never enter trusted validation diagnostics',()=>{
  for(const additionalProperties of [true,{type:'string',maxLength:5}]){
   try{validateSchema({type:'object',properties:{input:{type:'object',additionalProperties}}},{input:{SYNTHETIC_PRIVATE_TOKEN:'x'.repeat(65537)}});assert.fail('reject');}
   catch(e){assert.equal(e.code,'TOOL_ARGUMENTS_INVALID');const detail=schemaFailureDetail(e);assert.equal(detail.path,'$.input');assert.ok(!JSON.stringify(detail).includes('PRIVATE_TOKEN'));}
  }
 });
 await check('Task details contain bounded operation objects, never original request bodies',async()=>{
  const row={id:'task',goal:'Recover',workspaceId:'ws',status:'blocked',progress:{percent:0,note:'needs-reconciliation'},rev:1};
  const ui=createDesktopUiService({services:{taskService:{execute:async()=>({task:row})},capabilityService:{broker:{operationsForTask:()=>[{operationId:'op',capability:'filesystem.write',status:'outcome-unknown',executorId:'task:task',continuationInput:{content:'private-secret'}}]}}}});
  const dto=(await ui.execute({method:'ui.task.get',params:{id:'task'}})).task;
  assert.equal(dto.recovery.operations[0].operationId,'op');assert.equal(dto.recovery.operations[0].status,'outcome-unknown');assert.ok(!JSON.stringify(dto).includes('private-secret'));
 });
 await check('read-only recovery inspection verifies current postimage and flags changed effects without replay',async()=>{
  const stateDir=path.join(root,'recovery'),project=path.join(root,'project');fs.mkdirSync(project);
  const ws=createWorkspaceService({stateDir}),tasks=createTaskService({stateDir});const workspace=(await ws.execute({method:'workspace.create',params:{root:project,name:'Recovery fixture'}})).workspace;
  const task=tasks.runtime.create({goal:'Recover',workspaceId:workspace.id});
  const cap=createCapabilityService({stateDir,workspaceService:ws,taskRuntime:tasks.runtime});
  try{
   await cap.broker.execute({actor:OWNER_ACTOR,approved:true,taskId:task.id,workspaceId:workspace.id,operationId:'write-receipt',capability:'filesystem.write',input:{path:'result.txt',content:'verified'}});
   const ui=createDesktopUiService({services:{taskService:tasks,workspaceService:ws,capabilityService:cap}});
   const plain=await ui.execute({method:'ui.workspace.version',params:{id:workspace.id}});assert.equal(plain.isRepo,false);
   execFileSync('git',['init','-q',project]);
   const git=await ui.execute({method:'ui.workspace.version',params:{id:workspace.id}});assert.equal(git.isRepo,true);assert.ok(git.changes.some(row=>row.path==='result.txt'));
   const before=tasks.runtime.get({id:task.id}).task.rev;
   const read=()=>ui.execute({method:'ui.task.recovery.inspect',params:{id:task.id}});
   const first=await read();assert.equal(first.operations[0].verified,true);assert.equal(first.operations[0].capability,'filesystem.write');
   fs.writeFileSync(path.join(project,'result.txt'),'changed by another actor');
   const changed=await read();assert.equal(changed.operations[0].verified,false);assert.equal(changed.operations[0].code,'OPERATION_RESULT_STALE');
   assert.equal(fs.readFileSync(path.join(project,'result.txt'),'utf8'),'changed by another actor');assert.equal(tasks.runtime.get({id:task.id}).task.rev,before,'inspection never resumes or alters task');
  }finally{await cap.close();}
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
assert.equal(failures.length,0,failures.join('; '));
