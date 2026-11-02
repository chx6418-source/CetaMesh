import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readFile,writeFile} from '../src/workspace/tools.js';
import {projectProductContext} from '../src/context/product-context.js';
import {createTaskService} from '../src/task/service.js';
import {createSimulationProjectBridge} from '../src/simulation/project-bridge.js';
// Low-level Workspace tools require the already canonical filesystem identity.
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cm-simulation-project-')));
try {
  fs.writeFileSync(path.join(root,'hash-fixture.txt'),Buffer.from('\uFEFF完整原始字节\r\n','utf8'));
  const read=readFile(root,'hash-fixture.txt');
  assert.equal(read.expectedHash,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'hash-fixture.txt'))).digest('hex'));
  assert.notEqual(read.expectedHash,crypto.createHash('sha256').update(read.content).digest('hex'),'baseline is raw bytes, not decoded text');
  const modelSchema=projectProductContext({capabilities:{manifest:[{id:'filesystem.write',description:'Write the reviewed file',available:true,availability:'available',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'},expectedHash:{type:['string','null']}},required:['path','content'],additionalProperties:false}}]}}).manifest[0].inputSchema;
  assert.deepEqual(modelSchema.properties.expectedHash.type,['string','null']);assert.ok(modelSchema.required.includes('expectedHash'));
  writeFile(root,'hash-fixture.txt','reviewed write\n',{expectedHash:read.expectedHash});
  assert.throws(()=>writeFile(root,'hash-fixture.txt','stale write\n',{expectedHash:read.expectedHash}),{code:'WORKSPACE_CONFLICT'});
  assert.equal(readFile(root,'hash-fixture.txt',{maxBytes:3}).expectedHash,null,'partial content must not masquerade as a full-file preimage');
  const workspace={id:'ws-one',root,name:'Fixture'};
  const tasks=createTaskService({stateDir:root,resolveWorkspace:id=>id===workspace.id?workspace:null});
  let starts=0;const grants=[];
  const bridge=createSimulationProjectBridge({taskService:tasks,workspaceService:{describeWorkspace:id=>id===workspace.id?workspace:null,execute:async()=>({git:{isRepo:false},worktrees:[]})},
    capabilityService:{broker:{execute:async()=>{throw Error('Non-Git fixture should not create a Worktree');}},
      principalForTask:id=>({taskId:id,grants:{capabilities:['filesystem.read','filesystem.write','git.diff']}}),
      grantTask:(id,input)=>{grants.push({id,...input});return {grants:{capabilities:input?.capabilities??[]}};}},
    taskUi:async(method,params)=>{starts++;assert.equal(method,'ui.task.start');assert.equal(params.modelProvider,'selected-provider');assert.equal(params.model,'selected-model');return {task:tasks.runtime.get({id:params.id}).task};}});
  const room={id:'room-one',workspaceId:'ws-one',goal:'Write a small tested component',tasks:[]};
  const result=await bridge.create({room,requestId:'intent-one',acceptanceCriteria:['Actual tests must pass']});
  assert.equal(result.task.status,'queued');assert.equal(starts,0);
  assert.equal((await bridge.create({room,requestId:'intent-one',acceptanceCriteria:['Actual tests must pass']})).task.id,result.task.id);
  await assert.rejects(bridge.create({room,requestId:'intent-one',goal:'Different intent'}));
  await assert.rejects(bridge.create({room:{...room,workspaceId:null},requestId:'missing'}),{code:'SIMULATION_WORKSPACE_REQUIRED'});
  await assert.rejects(bridge.start({room,taskId:result.task.id}),{code:'SIMULATION_TASK_SCOPE_DENIED'});
  const linked={...room,tasks:[{taskId:result.task.id}]};
  const observed=await bridge.refresh({room:linked,taskId:result.task.id});
  assert.equal(observed.task.id,result.task.id);assert.equal(observed.verification.status,'NEEDS_REVIEW');
  assert.notEqual(observed.stage,'delivered');
  await bridge.start({room:{...linked,modelProvider:'selected-provider',model:'selected-model'},taskId:result.task.id});
  assert.equal(starts,1);
  assert.equal(grants.length,0,'starting a project must not silently expand requestable capabilities');
  const selectedRoom={...linked,modelProvider:'selected-provider',model:'selected-model'};
  await bridge.start({room:selectedRoom,taskId:result.task.id,allowProjectTests:true});
  assert.equal(grants.at(-1).id,result.task.id);assert.ok(grants.at(-1).capabilities.includes('test.run'));
  assert.deepEqual(grants.at(-1).capabilities.filter(x=>x!=='test.run'),['filesystem.read','filesystem.write','git.diff']);
  await bridge.start({room:selectedRoom,taskId:result.task.id,allowProjectTests:false});
  assert.ok(!grants.at(-1).capabilities.includes('test.run'),'explicit withdrawal removes only the Task test request capability');
  const grantCount=grants.length,startCount=starts;
  await assert.rejects(bridge.start({room:selectedRoom,taskId:result.task.id,allowProjectTests:'true'}),{code:'SIMULATION_INPUT_INVALID'});
  assert.equal(grants.length,grantCount);assert.equal(starts,startCount);
  let releaseStart,notifyStarted;
  const entered=new Promise(resolve=>{notifyStarted=resolve;}),held=new Promise(resolve=>{releaseStart=resolve;});
  const concurrentBridge=createSimulationProjectBridge({taskService:tasks,
    workspaceService:{describeWorkspace:()=>workspace,execute:async()=>({git:{isRepo:false},worktrees:[]})},
    capabilityService:{principalForTask:()=>({grants:{capabilities:['filesystem.read']}}),grantTask:()=>({grants:{capabilities:[]}})},
    taskUi:async()=>{notifyStarted();await held;return {};}});
  const firstStart=concurrentBridge.start({room:selectedRoom,taskId:result.task.id,allowProjectTests:true});
  await entered;
  const releaseTimer=setTimeout(releaseStart,20);
  try { await assert.rejects(concurrentBridge.start({room:selectedRoom,taskId:result.task.id,allowProjectTests:false}),{code:'SIMULATION_START_CONFLICT'}); }
  finally {clearTimeout(releaseTimer);releaseStart();await firstStart;}
  await assert.rejects(bridge.create({room:{...room,id:'other-room'},requestId:'new-room-intent',acceptanceCriteria:['Different acceptance']}),{code:'SIMULATION_TASK_PLAN_CONFLICT'});
  const originalVerify=tasks.runtime.verifyOutcome;
  tasks.runtime.verifyOutcome=async()=>{const t=tasks.runtime.get({id:result.task.id}).task;tasks.runtime.update({id:t.id,expectedRev:t.rev,goal:'Owner changed the goal'});return {status:'VERIFIED',kind:'code',evidenceEventIds:['stale'],reasons:[]};};
  await assert.rejects(bridge.refresh({room:linked,taskId:result.task.id}),{code:'SIMULATION_TASK_CHANGED'});
  tasks.runtime.verifyOutcome=originalVerify;
  console.log('PASS Simulation project creates real queued Tasks, preserves request identity and requires real outcome evidence.');
} finally {fs.rmSync(root,{recursive:true,force:true});}
