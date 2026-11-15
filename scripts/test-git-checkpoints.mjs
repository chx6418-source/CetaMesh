import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {createTaskService} from '../src/task/service.js';
import {workspaceJournalDir,inspectWorkspaceByteTransaction} from '../src/workspace/transaction.js';
import {observeGitMutation} from '../src/workspace/git-index-actions.js';
import {createSuiteSandbox,finalizeSuiteSandbox} from '../src/testing/suite-sandbox.js';

const sandbox=createSuiteSandbox({suiteId:'git-checkpoints'}),root=path.join(sandbox.root,'project'),stateDir=path.join(sandbox.root,'state');
const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
const git=(...args)=>execFileSync('git',['-c','commit.gpgSign=false','-c','core.hooksPath='+path.join(sandbox.root,'no-hooks'),...args],{cwd:root,env,encoding:'utf8',windowsHide:true}).trim();
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let caps,failed=true,ownedJournal,clock=Date.now();const originalRename=fs.renameSync;
try{
 fs.mkdirSync(root);git('init','-q','-b','main');git('config','user.name','Checkpoint Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');
 fs.writeFileSync(path.join(root,'a.txt'),'base\n');fs.writeFileSync(path.join(root,'deleted.txt'),'delete me\n');fs.writeFileSync(path.join(root,'tracked.bin'),Buffer.from([0,1,2]));git('add','.');git('commit','-qm','base');git('branch','target');
 fs.writeFileSync(path.join(root,'a.txt'),'staged\n');git('add','a.txt');fs.writeFileSync(path.join(root,'a.txt'),'working\n');fs.unlinkSync(path.join(root,'deleted.txt'));fs.writeFileSync(path.join(root,'untracked.bin'),Buffer.from([0,255,128,10,0]));
 fs.writeFileSync(path.join(root,'tracked.bin'),Buffer.from([0,3,4]));git('add','tracked.bin');fs.writeFileSync(path.join(root,'tracked.bin'),Buffer.from([0,5,6]));
 // Keep this same-size working edit distinct from the cached index stat even
 // after the fixture restores an older index with a newer filesystem mtime.
 // Otherwise Git's racy-clean optimisation can change porcelain without any
 // content change; every byte/index assertion below remains required.
 const binaryStat=fs.statSync(path.join(root,'tracked.bin'));
 fs.utimesSync(path.join(root,'tracked.bin'),binaryStat.atime,new Date(binaryStat.mtimeMs+2000));
 fs.appendFileSync(path.join(root,'.git','info','exclude'),'\nignored.bin\n');fs.writeFileSync(path.join(root,'ignored.bin'),Buffer.from([0,42,255]));
 const savedIndex=fs.readFileSync(path.join(root,'.git','index')),savedA=fs.readFileSync(path.join(root,'a.txt')),savedBinary=fs.readFileSync(path.join(root,'untracked.bin'));
 const workspace=createWorkspaceService({stateDir,nativeExecutable:process.env.CETAMESH_TEST_WORKSPACE_NATIVE}),{workspace:entry}=await workspace.execute({method:'workspace.create',params:{name:'Checkpoint fixture',root}});
 const tasks=createTaskService({stateDir,resolveWorkspace:id=>workspace.describeWorkspace(id)});
 caps=createCapabilityService({stateDir,workspaceService:workspace,taskRuntime:tasks.runtime,now:()=>clock});const ui=createDesktopUiService({services:{workspaceService:workspace,capabilityService:caps}});
 const call=(action,params={})=>ui.execute({method:'ui.workspace.git.checkpoint.'+action,params:{id:entry.id,...params}});
 const checkpoint=await call('capture',{label:'Before branch switch'});
 const capturedObservation=await observeGitMutation(entry,checkpoint.paths);
 assert.equal(checkpoint.workspaceId,entry.id);assert.equal(checkpoint.paths.length,4);assert.equal(checkpoint.ignoredIncluded,false);assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),savedIndex);
 assert.equal((await call('list')).entries.length,1);assert.equal((await call('preview',{checkpointId:checkpoint.id,path:'untracked.bin'})).binary,true);
 fs.writeFileSync(path.join(root,'outside.txt'),'unrelated new staged bytes\n');git('add','outside.txt');
 await assert.rejects(call('review',{checkpointId:checkpoint.id,mode:'saved'}),{code:'GIT_CHECKPOINT_SCOPE_CHANGED'},'saved full-index restoration must not silently replace unrelated later staged content');
 fs.writeFileSync(path.join(root,'.git','index'),savedIndex);fs.unlinkSync(path.join(root,'outside.txt'));
 const fields=['checkpointId','checkpointSha256','mode','paths','expectedHead','expectedHeadRef','expectedRepositoryIdentity','indexIdentity','expectedHashes','expectedDirtyIdentity','expectedWorkingModes'];
 const params=review=>Object.fromEntries(fields.map(key=>[key,review[key]]));
 const decide=(pending,approve=true)=>caps.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve}});
 const task=tasks.runtime.create({workspaceId:entry.id,goal:'Checkpoint exact grant fixture'});caps.grantTask(task.id,{capabilities:['git.status','git.diff','git.commit','filesystem.read']});
 const agent=(capability,input={})=>caps.broker.execute({actor:caps.principalForTask(task.id),taskId:task.id,workspaceId:entry.id,capability,input,requestId:crypto.randomUUID()});
 await assert.rejects(agent('git.checkpoint.list'),{code:'PERMISSION_DENIED'});caps.grantTask(task.id,{capabilities:['git.checkpoint.list','git.checkpoint.capture','git.checkpoint.preview']});
 assert.equal((await agent('git.checkpoint.list')).result.entries.length,1);await assert.rejects(agent('git.checkpoint.capture'),{code:'OWNER_REQUIRED'});
 await assert.rejects(caps.broker.execute({actor:{kind:'extension',id:'checkpoint-extension',grants:{capabilities:['git.checkpoint.preview'],approvedCapabilities:['git.checkpoint.preview'],workspaceIds:[entry.id],paths:['a.txt']}},workspaceId:entry.id,capability:'git.checkpoint.preview',input:{checkpointId:checkpoint.id,path:'a.txt'}}),{code:'EXTENSION_SCOPE_UNSUPPORTED'});
 await assert.rejects(call('preview',{checkpointId:checkpoint.id,path:'../outside'}),{code:'GIT_CHECKPOINT_PATH_INVALID'});
 fs.writeFileSync(path.join(root,'.env'),'fixture-secret-do-not-copy');await assert.rejects(call('capture'),{code:'SENSITIVE_RESOURCE'});fs.unlinkSync(path.join(root,'.env'));assert.equal((await call('list')).entries.length,1,'failed capture publishes no partial checkpoint');
 const outside=path.join(sandbox.root,'outside'),junction=path.join(root,'linked');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'retain.txt'),'unowned target bytes');fs.symlinkSync(outside,junction,'junction');await assert.rejects(call('capture'),error=>['GIT_PATH_INVALID','BOUNDARY_ESCAPE'].includes(error.code));assert.equal(fs.readFileSync(path.join(outside,'retain.txt'),'utf8'),'unowned target bytes');assert.ok(fs.lstatSync(junction).isSymbolicLink());fs.rmdirSync(junction);assert.equal((await call('list')).entries.length,1);
 await assert.rejects(workspace.execute({method:'workspace.git.checkpoint.capture',params:{id:entry.id}},{signal:AbortSignal.abort()}),{code:'INVOKE_CANCELLED'});assert.equal((await call('list')).entries.length,1);
 let publicationBlocked=false;fs.renameSync=function(from,to){if(String(to).startsWith(path.join(stateDir,'workspace-checkpoints'))&&String(to).endsWith('.json')){publicationBlocked=true;throw Object.assign(new Error('fixture artifact publication failed'),{code:'EIO'});}return originalRename.apply(this,arguments);};
 await assert.rejects(call('capture',{label:'must not become usable'}));fs.renameSync=originalRename;assert.equal(publicationBlocked,true);assert.equal((await call('list')).entries.length,1,'failed atomic publication leaves no usable partial artifact');
 const fresh=await call('review',{checkpointId:checkpoint.id,mode:'saved'});
 await assert.rejects(workspace.execute({method:'workspace.git.checkpoint.restore',params:{id:entry.id,...params(fresh),approved:true}}),{code:'GIT_APPROVAL_REQUIRED'});
 const rejected=await call('restore',params(fresh));await decide(rejected,false);assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),savedIndex);
 const expired=await call('restore',params(fresh));clock+=31*60*1000;await assert.rejects(decide(expired),{code:'APPROVAL_EXPIRED'});assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),savedIndex);
 const stale=await call('restore',params(await call('review',{checkpointId:checkpoint.id,mode:'saved'})));fs.writeFileSync(path.join(root,'a.txt'),'later external edit\n');await assert.rejects(decide(stale),{code:'WORKSPACE_CONFLICT'});assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'later external edit\n');fs.writeFileSync(path.join(root,'a.txt'),savedA);
 const indexReview=await call('review',{checkpointId:checkpoint.id,mode:'saved'});git('add','a.txt');await assert.rejects(call('restore',params(indexReview)),{code:'GIT_INDEX_CHANGED'});fs.writeFileSync(path.join(root,'.git','index'),savedIndex);
 const artifact=path.join(stateDir,'workspace-checkpoints',entry.id,checkpoint.id+'.json'),artifactBytes=fs.readFileSync(artifact),savedArtifact=JSON.parse(artifactBytes);savedArtifact.files[0].bytes=Buffer.from('corrupted').toString('base64');fs.writeFileSync(artifact,JSON.stringify(savedArtifact));await assert.rejects(call('review',{checkpointId:checkpoint.id,mode:'saved'}),{code:'GIT_CHECKPOINT_CORRUPT'});fs.writeFileSync(artifact,artifactBytes);
 const cold=createWorkspaceService({stateDir,nativeExecutable:process.env.CETAMESH_TEST_WORKSPACE_NATIVE});assert.equal((await cold.execute({method:'workspace.git.checkpoint.list',params:{id:entry.id}})).entries[0].id,checkpoint.id);
 console.log('PASS exact grant/Owner capture/extension boundaries, forged approval, rejection, stale file/index, unrelated staged scope, corrupt artifact and cold checkpoint retention');
 async function restore(mode){const review=await call('review',{checkpointId:checkpoint.id,mode});const pending=await call('restore',Object.fromEntries(fields.map(key=>[key,review[key]])));assert.equal(pending.status,'pending');return caps.execute({method:'capability.approval.decide',params:{id:pending.approvalId,approve:true}});}
 const beforeClean=await observeGitMutation(entry,checkpoint.paths);
 assert.equal(beforeClean.index.identity,capturedObservation.index.identity,'fixture must restore the original index bytes before clean');
 assert.deepEqual(beforeClean.status.entries,capturedObservation.status.entries,'fixture must restore the original dirty scope before clean');
 for(const rel of checkpoint.paths)assert.equal(beforeClean.files.get(rel).hash,capturedObservation.files.get(rel).hash,'fixture must restore original bytes: '+rel);
 assert.equal((await restore('head')).status,'completed');assert.equal(git('status','--porcelain'),'');assert.equal(fs.existsSync(path.join(root,'untracked.bin')),false);
 assert.deepEqual(fs.readFileSync(path.join(root,'ignored.bin')),Buffer.from([0,42,255]),'ignored bytes are untouched and never claimed as backed up');
 const switchFields=['paths','targetBranch','mode','expectedHead','expectedHeadRef','expectedTargetHead','indexIdentity','expectedRepositoryIdentity','expectedDirtyIdentity','expectedHashes','expectedWorkingModes'];
 async function switchTo(target){const r=await ui.execute({method:'ui.workspace.git.branch.review',params:{id:entry.id,targetBranch:'refs/heads/'+target,mode:'clean'}});const p=await ui.execute({method:'ui.workspace.git.branch.switch',params:{id:entry.id,...Object.fromEntries(switchFields.map(key=>[key,r[key]]))}});assert.equal(p.status,'pending');return caps.execute({method:'capability.approval.decide',params:{id:p.approvalId,approve:true}});}
 await switchTo('target');await assert.rejects(call('review',{checkpointId:checkpoint.id,mode:'saved'}),{code:'GIT_CHECKPOINT_HEAD_CHANGED'});await switchTo('main');
 assert.equal((await restore('saved')).status,'completed');assert.deepEqual(fs.readFileSync(path.join(root,'a.txt')),savedA);assert.deepEqual(fs.readFileSync(path.join(root,'untracked.bin')),savedBinary);assert.equal(fs.existsSync(path.join(root,'deleted.txt')),false);assert.equal(hash(fs.readFileSync(path.join(root,'.git','index'))),hash(savedIndex));assert.equal(git('show',':a.txt'),'staged');
 assert.deepEqual(fs.readFileSync(path.join(root,'tracked.bin')),Buffer.from([0,5,6]));assert.deepEqual(execFileSync('git',['show',':tracked.bin'],{cwd:root,env,windowsHide:true}),Buffer.from([0,3,4]),'tracked binary index and working payloads remain independent');
 console.log('PASS actual Core/native/Git checkpoint captures tracked, untracked, binary, deletion and independent staged index; separately approved clean/switch/back/restore retains exact bytes');
 const unknown=await call('restore',params(await call('review',{checkpointId:checkpoint.id,mode:'head'})));let blocked=false;
 fs.renameSync=function(from,to){if(to===path.join(root,'.git','index')&&String(from).endsWith('index.lock')){blocked=true;throw Object.assign(new Error('fixture normal index publication interrupted'),{code:'EBUSY'});}return originalRename.apply(this,arguments);};
 await assert.rejects(decide(unknown),{effectStatus:'unknown'});fs.renameSync=originalRename;assert.equal(blocked,true);
 const journal=workspaceJournalDir(root);ownedJournal={path:journal,node:fs.lstatSync(journal,{bigint:true})};const raw=inspectWorkspaceByteTransaction(root);assert.equal(raw.owner.kind,'git-checkpoint-restore');assert.equal(raw.owner.dispatchBinding.capability,'git.checkpoint.restore');assert.equal(raw.invocations.at(-1).state,'closed');assert.equal(git('symbolic-ref','HEAD'),'refs/heads/main');assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),savedIndex);
 assert.equal(caps.broker.gitApprovalReceipt(unknown.approvalId),null,'checkpoint receipt cannot be adopted by branch approval recovery');assert.throws(()=>caps.broker.verifyGitRecoveryBinding(raw.owner.dispatchBinding),{code:'WORKSPACE_RECOVERY_REQUIRED'});
 await assert.rejects(call('capture'),error=>['WORKSPACE_NOT_FOUND','WORKSPACE_RECOVERY_REQUIRED','WORKSPACE_OPERATION_UNCONFIRMED'].includes(error.code));await assert.rejects(ui.execute({method:'ui.workspace.git.branch.review',params:{id:entry.id,targetBranch:'refs/heads/target',mode:'finish-prepared'}}),{code:'WORKSPACE_RECOVERY_REQUIRED'});
 assert.equal(JSON.parse(fs.readFileSync(artifact)).files.find(row=>row.path==='a.txt').bytes,savedA.toString('base64'),'original saved bytes remain retained after partial effect');
 const retained=caps.broker.operationsForTask({taskId:task.id,workspaceId:entry.id});assert.ok(Array.isArray(retained));
 console.log('PASS interrupted normal-index phase retains native preimages, exact closed checkpoint invocation and original artifact; no branch/checkpoint recovery interchange or automatic retry');
 failed=false;
}finally{fs.renameSync=originalRename;await caps?.close();if(!failed&&ownedJournal){const current=fs.lstatSync(ownedJournal.path,{bigint:true});assert.equal(ownedJournal.path,workspaceJournalDir(root));assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===ownedJournal.node.dev&&current.ino===ownedJournal.node.ino);fs.rmSync(ownedJournal.path,{recursive:true});}finalizeSuiteSandbox({sandbox,failed,keepFailed:failed});}
