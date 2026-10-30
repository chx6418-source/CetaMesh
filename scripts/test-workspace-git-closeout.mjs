import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createStagingWorkspace,collectStagedChanges,refreshStagingBaseline,cleanupStagingWorkspace} from '../src/workspace/staging.js';
import {commitScopedPaths} from '../src/workspace/scoped-git-commit.js';
import {gitStatus,gitHead,gitCommit} from '../src/workspace/tools.js';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createTaskRuntime} from '../src/task/runtime.js';
import {createContinuityRuntime} from '../src/continuity/runtime.js';
import {createAgentBroker} from '../src/agent/broker.js';
import {createAgentProviderRegistry} from '../src/agent/registry.js';
import {normalizePacket} from '../src/continuity/types.js';
// Match Workspace service roots, including Windows 8.3 Temp aliases.
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cm-git-closeout-')));
const env={...process.env}; for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath='+path.join(root,'no-hooks'),'-c','commit.gpgSign=false',...args],{cwd,env,encoding:'utf8',windowsHide:true}).trim();
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
let passed=0,failed=0;
async function check(name,run){try{await run();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+error.stack);}}
function repo(name){const dir=path.join(root,name);fs.mkdirSync(dir);git(dir,'init','-q');git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');for(const file of ['a.txt','b.txt','user.txt'])fs.writeFileSync(path.join(dir,file),'base '+file);git(dir,'add','.');git(dir,'commit','-qm','base');return dir;}
async function service(dir,name){const svc=createWorkspaceService({stateDir:path.join(root,'state-'+name)});const {workspace}=await svc.execute({method:'workspace.create',params:{root:dir,name}});return {svc,id:workspace.id};}
async function stage(dir,name,extra={}){return createStagingWorkspace({taskId:name,workspaceId:'project',sourceRoot:dir,stagingRoot:path.join(root,'stages'),...extra});}
try{
await check('Git discovery reports actual branch HEAD and scoped untracked changes',async()=>{
 const dir=repo('discovery');fs.writeFileSync(path.join(dir,'untracked.txt'),'keep');const status=await gitStatus(dir,{completeFiles:true});assert.equal(status.headSha,git(dir,'rev-parse','HEAD'));assert.equal(status.repoRoot,fs.realpathSync.native(dir));assert.ok(status.entries.some(r=>r.path==='untracked.txt'));
});
await check('isolated snapshots preserve original dirty and untracked content',async()=>{
 const dir=repo('dirty');fs.writeFileSync(path.join(dir,'a.txt'),'user dirty');fs.writeFileSync(path.join(dir,'loose.txt'),'user loose');const before=git(dir,'status','--porcelain');const first=await stage(dir,'first'),second=await stage(dir,'second');assert.notEqual(first.root,second.root);assert.equal(fs.readFileSync(path.join(first.root,'a.txt'),'utf8'),'user dirty');assert.ok(!fs.existsSync(path.join(first.root,'.git')));assert.equal(git(dir,'status','--porcelain'),before);cleanupStagingWorkspace(first);cleanupStagingWorkspace(second);assert.equal(fs.readFileSync(path.join(dir,'loose.txt'),'utf8'),'user loose');
});
await check('two isolated executors import different paths without overwriting unrelated changes',async()=>{
 const dir=repo('disjoint');const {svc,id}=await service(dir,'disjoint');const first=await stage(dir,'first'),second=await stage(dir,'second');fs.writeFileSync(path.join(first.root,'a.txt'),'agent A');fs.writeFileSync(path.join(second.root,'b.txt'),'agent B');svc.applyChanges({id,changes:collectStagedChanges(first).changes});refreshStagingBaseline(first);svc.applyChanges({id,changes:collectStagedChanges(second).changes});refreshStagingBaseline(second);assert.equal(fs.readFileSync(path.join(dir,'a.txt'),'utf8'),'agent A');assert.equal(fs.readFileSync(path.join(dir,'b.txt'),'utf8'),'agent B');assert.deepEqual(collectStagedChanges(second).changes,[]);assert.equal(fs.readFileSync(path.join(second.root,'a.txt'),'utf8'),'base a.txt','unrelated stale snapshot is not silently replaced');cleanupStagingWorkspace(first);cleanupStagingWorkspace(second);
});
await check('same-file executor conflict is rejected with original accepted content retained',async()=>{
 const dir=repo('conflict');const {svc,id}=await service(dir,'conflict');const first=await stage(dir,'one'),second=await stage(dir,'two');fs.writeFileSync(path.join(first.root,'a.txt'),'first result');fs.writeFileSync(path.join(second.root,'a.txt'),'second result');svc.applyChanges({id,changes:collectStagedChanges(first).changes});assert.throws(()=>collectStagedChanges(second),e=>e.code==='WORKSPACE_RECONCILIATION_REQUIRED');assert.equal(fs.readFileSync(path.join(dir,'a.txt'),'utf8'),'first result');
});
await check('exact authorized commit preserves unrelated staged dirty and untracked work',async()=>{
 const dir=repo('commit');const {svc,id}=await service(dir,'commit');const head=git(dir,'rev-parse','HEAD');fs.writeFileSync(path.join(dir,'user.txt'),'user staged');git(dir,'add','user.txt');fs.writeFileSync(path.join(dir,'user.txt'),'user unstaged');fs.writeFileSync(path.join(dir,'loose.txt'),'user untracked');fs.writeFileSync(path.join(dir,'a.txt'),'agent owned');const stagedBefore=git(dir,'show',':user.txt');
 const request=await svc.execute({method:'workspace.git.commit',params:{id,message:'owned change',paths:['a.txt'],expectedHead:head,expectedHashes:{'a.txt':hash('agent owned')}}});assert.equal(request.status,'pending');assert.equal(git(dir,'rev-parse','HEAD'),head);
 const result=await svc.execute({method:'workspace.pending.decide',params:{requestId:request.requestId,approve:true}});assert.equal(result.committed,true);assert.match(result.sha,/^[a-f0-9]{40}$/);assert.deepEqual(git(dir,'diff-tree','--no-commit-id','--name-only','-r',result.sha).split('\n'),['a.txt']);assert.equal(git(dir,'show',':user.txt'),stagedBefore);assert.equal(fs.readFileSync(path.join(dir,'user.txt'),'utf8'),'user unstaged');assert.equal(fs.readFileSync(path.join(dir,'loose.txt'),'utf8'),'user untracked');assert.equal(git(dir,'diff','--cached','--name-only'),'user.txt');
});
await check('stale hash or HEAD and missing path authorization reject before commit',async()=>{
 const dir=repo('rejection');const head=git(dir,'rev-parse','HEAD');fs.writeFileSync(path.join(dir,'a.txt'),'changed');await assert.rejects(gitCommit(dir,{message:'unscoped'}),e=>e.code==='COMMIT_PATHS_REQUIRED');await assert.rejects(gitCommit(dir,{message:'stale',paths:['a.txt'],expectedHead:head,expectedHashes:{'a.txt':hash('wrong')}}),e=>e.code==='WORKSPACE_CONFLICT');assert.equal(git(dir,'rev-parse','HEAD'),head);assert.equal(git(dir,'diff','--cached','--name-only'),'');
});
await check('non-Git directory retains hash staging without initializing Git',async()=>{
 const dir=path.join(root,'plain');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'plain.txt'),'base');const {svc,id}=await service(dir,'plain');const copy=await stage(dir,'plain');fs.writeFileSync(path.join(copy.root,'plain.txt'),'result');svc.applyChanges({id,changes:collectStagedChanges(copy).changes});refreshStagingBaseline(copy);assert.equal((await gitStatus(dir)).isRepo,false);assert.ok(!fs.existsSync(path.join(dir,'.git')));assert.equal(fs.readFileSync(path.join(dir,'plain.txt'),'utf8'),'result');cleanupStagingWorkspace(copy);
});
await check('staging version identity survives bounded attempt and handoff references',async()=>{
 const dir=repo('version');const copy=await stage(dir,'task-version',{attemptId:'attempt-one',executorId:'codex:session-one'});assert.ok(copy.versionContext);assert.equal(copy.versionContext.baselineHead,git(dir,'rev-parse','HEAD'));assert.equal(copy.versionContext.attemptId,'attempt-one');const packet=normalizePacket({taskId:'task-version',attemptId:'attempt-one',previousAgent:{provider:'codex',sessionId:'session-one'},versionContext:copy.versionContext});assert.equal(packet.versionContext.snapshotId,path.basename(copy.root));assert.equal(packet.versionContext.executorId,'codex:session-one');cleanupStagingWorkspace(copy);
});
await check('Task attachment persists executor version identity into actual handoff and resume prompt',async()=>{
 const dir=repo('task-version');const stateDir=path.join(root,'task-version-state');const tasks=createTaskRuntime({stateDir});let task=tasks.create({goal:'retain exact version',workspaceId:'project'});const copy=await stage(dir,task.id,{executorId:'codex:session-one'});
 task=tasks.attachAgent({id:task.id,expectedRev:task.rev,provider:'codex',sessionId:'session-one',versionContext:copy.versionContext}).task;
 assert.equal(task.currentAgent.versionContext?.snapshotId,path.basename(copy.root));
 const reopened=createTaskRuntime({stateDir});const continuity=createContinuityRuntime({taskRuntime:reopened,agentBroker:createAgentBroker({registry:createAgentProviderRegistry()}),stateDir});
 const packet=continuity.buildHandoffPacket({taskId:task.id,reason:'manual',sequence:1});assert.equal(packet.versionContext.baselineHead,git(dir,'rev-parse','HEAD'));assert.ok(continuity.renderResumePrompt(packet).includes(copy.versionContext.snapshotId));assert.equal(packet.versionContext.attemptId,null);
});
await check('cleanup retains unimported executor output for review',async()=>{
 const dir=repo('retain-output');const copy=await stage(dir,'pending');fs.writeFileSync(path.join(copy.root,'a.txt'),'unreviewed output');const result=cleanupStagingWorkspace(copy);assert.equal(result.removed,false);assert.equal(result.reason,'unimported-changes');assert.equal(fs.readFileSync(path.join(copy.root,'a.txt'),'utf8'),'unreviewed output');
});
await check('temporary index bytes must match authorized content even after transient file replacement',async()=>{
 const dir=repo('index-race');const head=git(dir,'rev-parse','HEAD');fs.writeFileSync(path.join(dir,'a.txt'),'authorized bytes');
 const run=async(cwd,args,options={})=>{if(args[0]==='add')fs.writeFileSync(path.join(dir,'a.txt'),'UNAUTHORIZED TRANSIENT CONTENT');
  const stdout=execFileSync('git',['--literal-pathspecs','-c','core.hooksPath='+path.join(root,'no-hooks'),'-c','commit.gpgSign=false',...args],{cwd,env:{...env,...(options.indexFile?{GIT_INDEX_FILE:options.indexFile}:{})},encoding:'utf8',windowsHide:true});
  if(args[0]==='add')fs.writeFileSync(path.join(dir,'a.txt'),'authorized bytes');return {stdout};};
 await assert.rejects(commitScopedPaths(dir,{message:'must reject staged race',paths:['a.txt'],expectedHead:head,expectedHashes:{'a.txt':hash('authorized bytes')}},{gitRun:run,gitStatus}),e=>e.code==='WORKSPACE_CONFLICT');assert.equal(git(dir,'rev-parse','HEAD'),head);
});
await check('ordinary directory staging still works when Git is absent from PATH',async()=>{
 const dir=path.join(root,'gitless');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'a.txt'),'plain');const old=process.env.PATH;
 try{process.env.PATH='';const copy=await stage(dir,'gitless');assert.equal(fs.readFileSync(path.join(copy.root,'a.txt'),'utf8'),'plain');cleanupStagingWorkspace(copy);}finally{process.env.PATH=old;}
});
await check('pending merge or rebase cannot be bypassed by a scoped commit',async()=>{
 const dir=repo('merge-fence'),head=git(dir,'rev-parse','HEAD');fs.writeFileSync(path.join(dir,'a.txt'),'owned');
 fs.writeFileSync(path.join(dir,'.git','MERGE_HEAD'),head+'\n');
 await assert.rejects(gitCommit(dir,{message:'blocked',paths:['a.txt'],expectedHead:head,expectedHashes:{'a.txt':hash('owned')}}),e=>e.code==='GIT_OPERATION_IN_PROGRESS');
 assert.equal(git(dir,'rev-parse','HEAD'),head);
});
await check('destructive and remote Git verbs have no executable Workspace route',async()=>{
 const dir=repo('denials');const {svc,id}=await service(dir,'denials');for(const verb of ['push','merge','reset','clean','worktree.remove','branch.delete'])await assert.rejects(svc.execute({method:'workspace.git.'+verb,params:{id}}),e=>e.code==='METHOD_NOT_FOUND');
});
}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
console.log(`Git closeout: ${passed} PASS / ${failed} FAIL`);if(failed)process.exitCode=1;
