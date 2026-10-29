import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkspaceService} from '../src/workspace/index.js';
import {createMemoryService} from '../src/memory/index.js';
import {createTaskService} from '../src/task/index.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createDesktopPlatformRuntime} from '../src/desktop/platform-runtime.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {validateSchema} from '../src/model/input-schema.js';
import {classifyTask} from '../src/router/smart-router.js';
import {taskModelForAgent} from '../src/agent/task-model-selection.js';
import {explicitDelegationTarget} from '../src/desktop/explicit-delegation.js';
import {createToolExecutionCoordinator} from '../src/model/tool-execution.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-chat-codex-'));
let failures=0,cleanup=()=>{};
async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+': '+e.message);}finally{cleanup();}}
try {
 const workspaceService=createWorkspaceService({stateDir:path.join(root,'state')});
 fs.mkdirSync(path.join(root,'project'));
 const {workspace}=await workspaceService.execute({method:'workspace.create',params:{root:path.join(root,'project'),name:'Isolated Extension packages'}});
 const taskService=createTaskService({stateDir:path.join(root,'state')}); const rt=taskService.runtime;
 cleanup=()=>{for(const t of rt.list().tasks??[])if(!['completed','cancelled','failed'].includes(t.status))rt.cancel({id:t.id,expectedRev:t.rev});};
 const calls=[];let seq=0,available=true;
 const broker={ids:()=>['cetamesh','codex'],health:async()=>({available,installed:true,authenticated:true,sessionCapable:true,compatible:true,sandboxCapable:true,toolsAvailable:true}),
 capabilities:()=>({workspaceBoundary:'capability-broker',assignment:{taskKinds:['code'],tools:[],maxDifficulty:3}}),
 createSession:async(provider,options)=>{calls.push({provider,options});return {sessionId:'session-'+ ++seq};},
 send:async()=>({accepted:true}),status:async()=>({active:false}),assertExecutionConsent:()=>{},closeSession:async()=>{}};
 const cap=createCapabilityService({stateDir:path.join(root,'state'),workspaceService,taskRuntime:rt,agentBroker:broker,memoryService:createMemoryService({stateDir:path.join(root,'state')})});
 const make=()=>rt.create({goal:'Create Extension task packages and hand them to Codex',workspaceId:workspace.id});
 await check('Managed model binding does not become Codex authorization',async()=>{
  let t=make();t=rt.setModelConfig({id:t.id,expectedRev:t.rev,agentProvider:'cetamesh',modelProvider:'deepseek-official',model:'deepseek-flash'});
  await cap.broker.execute({actor:OWNER_ACTOR,taskId:t.id,workspaceId:workspace.id,capability:'agent.run',input:{agentProvider:'codex',content:t.goal}});
  assert.equal(calls.at(-1).options.modelProvider,undefined);assert.equal(calls.at(-1).options.model,undefined);
  rt.cancel({id:t.id,expectedRev:rt.get({id:t.id}).task.rev});
 });
 await check('explicit Codex model selection is preserved, not silently stripped',async()=>{
  let t=make();await cap.broker.execute({actor:OWNER_ACTOR,taskId:t.id,workspaceId:workspace.id,capability:'agent.run',input:{agentProvider:'codex',modelProvider:'explicit-native',model:'chosen-model',content:t.goal}});
  assert.equal(calls.at(-1).options.modelProvider,'explicit-native');assert.equal(calls.at(-1).options.model,'chosen-model');
  rt.cancel({id:t.id,expectedRev:rt.get({id:t.id}).task.rev});
 });
 await check('model scope survives reload and legacy ambiguous history fails closed',()=>{
  let t=make();t=rt.setModelConfig({id:t.id,expectedRev:t.rev,agentProvider:'cetamesh',modelProvider:'deepseek-official',model:'deepseek-flash'});
  const reloaded=createTaskService({stateDir:path.join(root,'state')}).runtime.get({id:t.id}).task;
  assert.equal(reloaded.modelConfig.agentProvider,'cetamesh');assert.equal(taskModelForAgent(reloaded,'codex').modelProvider,undefined);
  assert.equal(taskModelForAgent(reloaded,'cetamesh').model,'deepseek-flash');
  assert.deepEqual(taskModelForAgent({modelConfig:{model:'ambiguous'},agentHistory:[{provider:'a'},{provider:'b'}]},'b'),{});
 });
 await check('new-file null hash advertised by write schema is valid; wrong types denied',()=>{
  const schema=cap.broker.registry.require('filesystem.write').inputSchema;
  validateSchema(schema,{path:'tasks/EXT-01.md',content:'Independent task package',expectedHash:null});
  for(const value of [42,{},[]])assert.throws(()=>validateSchema(schema,{path:'x',content:'x',expectedHash:value}),{code:'TOOL_ARGUMENTS_INVALID'});
 });
 await check('nullable schema retains enum constraints',()=>{
  assert.throws(()=>validateSchema({type:['string','null'],enum:['approved']},null),{code:'TOOL_ARGUMENTS_INVALID'});
 });
 await check('tool error code reaches activity without leaking raw failure text',async()=>{
  const activity=[];const c=createToolExecutionCoordinator({stateDir:path.join(root,'tools'),modelRuntime:{chat:async()=>({toolCalls:[{id:'write',capabilityId:'filesystem.write',arguments:{path:'x',content:'x'}}]})},capabilityBroker:{execute:async()=>{throw Object.assign(new Error('private failure detail'),{code:'OPERATION_LINK_REQUIRED',effectStatus:'unknown'});}}});
  const result=await c.run({actor:{kind:'agent',id:'agent'},sessionId:'s',turnId:'t',scope:{taskId:'t',workspaceId:'w'},messages:[],manifest:[{id:'filesystem.write',description:'Write a scoped file',inputSchema:{type:'object',additionalProperties:true}}],onActivity:a=>activity.push(a)});
  assert.equal(result.status,'partial');assert.equal(activity.at(-1).summary,'OPERATION_LINK_REQUIRED');assert.ok(!JSON.stringify(activity).includes('private failure detail'));
 });
 await check('persisted capability renders the tool name instead of call UUID',async()=>{
  const ui=createDesktopUiService({services:{chatService:{execute:async()=>({messages:[{id:'m',role:'assistant',toolActivity:[{id:'uuid:call',capability:'filesystem.write',status:'failed',summary:'OPERATION_LINK_REQUIRED'}]}]})}}});
  const m=(await ui.execute({method:'ui.chat.history',params:{id:'s'}})).messages[0];assert.equal(m.toolActivity[0].label,'filesystem.write');
 });
 await check('explicit Chinese delegation is an Agent task, not ordinary model chat',()=>{
  assert.equal(classifyTask({text:'交给codex',hasWorkspaceContext:true}).agentIntent,true);
  assert.equal(classifyTask({text:'解释“交给codex”是什么意思',hasWorkspaceContext:true}).agentIntent,false);
  assert.equal(classifyTask({text:'不要交给codex',hasWorkspaceContext:true}).agentIntent,false);
  assert.equal(explicitDelegationTarget('把 GIT-QQ-BRIDGE 工作区的「插件（Extension）开发」拆分为可独立执行的任务包，交给 Codex 执行。'),'codex');
  assert.equal(explicitDelegationTarget('文档说：交给codex'),null);
 });
 await check('Chat explicit Codex request does not dispatch Managed or pass its model',async()=>{
  const runtime=createDesktopPlatformRuntime({capabilityService:cap,workspaceService,taskRuntime:rt,agentBroker:broker});
  const record={id:'chat',config:{workspaceId:workspace.id,modelProvider:'deepseek-official',model:'deepseek-flash',agentProvider:null}};
  const text='把工作区的插件开发拆分为任务包，交给 Codex 执行。';
  const result=await runtime.route({decision:{agentIntent:true,agentEnabled:true},record,text,requestId:'explicit-chat'});
  assert.equal(result.provider,'codex');assert.equal(calls.at(-1).options.modelProvider,undefined);
  rt.cancel({id:record.taskId,expectedRev:rt.get({id:record.taskId}).task.rev});
 });
 await check('verified unavailable preflight on Resume does not invent uncertain effects',async()=>{
  let t=make();t=rt.attachAgent({id:t.id,expectedRev:t.rev,provider:'codex',sessionId:'paused'}).task;t=rt.start({id:t.id,expectedRev:t.rev}).task;t=rt.pause({id:t.id,expectedRev:t.rev}).task;
  // Eligibility changes only at the authoritative Capability preflight, after UI selection.
  let checks=0;broker.health=async()=>({available:++checks===1,installed:true,authenticated:true,sessionCapable:true,compatible:true});
  const ui=createDesktopUiService({services:{taskService,capabilityService:cap,agentBroker:broker,workspaceService}});
  await assert.rejects(ui.execute({method:'ui.task.resume',params:{id:t.id,expectedRev:t.rev,provider:'codex'}}),{code:'PROVIDER_UNAVAILABLE'});assert.equal(checks,2,'must reach trusted Capability preflight');
  const after=rt.get({id:t.id}).task;assert.notEqual(after.status,'running');assert.doesNotMatch(after.progress.note,/needs-reconciliation/);
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
if(failures)process.exitCode=1;
