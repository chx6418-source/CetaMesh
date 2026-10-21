// Opt-in actual Codex + production Chat assembly. Synthetic large Workspace only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-codex-chat-snapshot-'));
const project=path.join(root,'中文 large workspace');fs.mkdirSync(project);
const sample='export const answer = 1107;\n';fs.writeFileSync(path.join(project,'sample.ts'),sample);
const count=1481,total=153831110-Buffer.byteLength(sample),size=Math.floor(total/count);
const assets=path.join(project,'synthetic-assets');fs.mkdirSync(assets);
for(let i=0;i<count;i++){
 const fd=fs.openSync(path.join(assets,'asset-'+i+'.dat'),'wx');
 try{fs.ftruncateSync(fd,i===count-1?total-size*(count-1):size);}finally{fs.closeSync(fd);}
}
const observed=[];
function observe(operation,file,error){
 const value=String(file??'');if(!value.startsWith(path.join(root,'staging')+path.sep)||observed.length>=30)return;
 const row={operation,code:error?.code??null,syscall:error?.syscall??null,pathHash:crypto.createHash('sha256').update(value).digest('hex')};
 observed.push(row);console.log('SNAPSHOT_FS_OBSERVED '+JSON.stringify(row));
}
const read=fs.readFileSync,enumerate=fs.readdirSync,real=fs.realpathSync.native;
fs.readFileSync=function(file,...args){try{return read.call(fs,file,...args);}catch(error){observe('read',file,error);throw error;}};
fs.readdirSync=function(file,...args){try{return enumerate.call(fs,file,...args);}catch(error){observe('enumerate',file,error);throw error;}};
fs.realpathSync.native=function(file,...args){try{return real.call(fs.realpathSync,file,...args);}catch(error){observe('realpath',file,error);throw error;}};
let services,taskId,child,ui;
const sea=process.env.CETAMESH_SNAPSHOT_SEA;
const token=crypto.randomBytes(32).toString('hex'),pipe='\\\\.\\pipe\\CetaMesh-snapshot-'+crypto.randomUUID();
async function rpc(method,params={}){return new Promise((resolve,reject)=>{const socket=net.connect(pipe);let buf=Buffer.alloc(0);socket.setTimeout(8000,()=>socket.destroy(Error('IPC timeout')));socket.on('error',reject);socket.on('connect',()=>{const body=Buffer.from(JSON.stringify({version:1,id:crypto.randomUUID(),role:'console',authToken:token,method,params})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));});socket.on('data',part=>{buf=Buffer.concat([buf,part]);while(buf.length>=4&&buf.length>=buf.readUInt32LE()+4){const n=buf.readUInt32LE(),value=JSON.parse(buf.subarray(4,n+4));buf=buf.subarray(n+4);if(value.event)continue;socket.destroy();value.ok?resolve(value.result):reject(Object.assign(Error(value.error?.message),{code:value.error?.code}));}});});}
async function stopSea(){if(child&&child.exitCode===null){const done=once(child,'close');child.stdin.end();await done;}}
try{
 if(sea){
  assert.equal(path.isAbsolute(sea),true);assert.ok(fs.existsSync(sea));
  const env={...process.env};for(const k of Object.keys(env))if(k.toUpperCase()==='PATH')delete env[k];
  child=spawn(sea,['--worker','--data-dir',path.join(root,'profile')],{cwd:root,windowsHide:true,stdio:['pipe','ignore','ignore'],env:{...env,PATH:path.join(process.env.SystemRoot,'System32'),WHALEBRIDGE_UI_PIPE:pipe,WHALEBRIDGE_UI_AUTH_TOKEN:token,WHALEBRIDGE_SUPERVISED:'1'}});
  for(let i=0;i<100;i++){try{await rpc('core.ping');break;}catch(error){if(i===99)throw error;await new Promise(r=>setTimeout(r,100));}}
  ui=rpc;
  await rpc('continuity.policy.set',{policy:{autoRollover:false}});
 }else{
  services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging')});
  const policy=services.continuityService.runtime.setPolicy({autoRollover:false});assert.equal(policy.policy.autoRollover,false);
  ui=(method,params={})=>services.desktopUiService.execute({method,params});
 }
 const health=await ui('ui.agent.health',{provider:'codex',refresh:true});
 assert.equal(health.installed,true,'Native Codex must be actually installed');assert.equal(health.authenticated,true);
 const workspace=await ui('ui.workspace.create',{name:'large disposable fixture',root:project});
 const scope=await ui('ui.agent.security',{provider:'codex',workspaceId:workspace.id});
 assert.equal(scope.security.mode,'native');assert.equal(scope.security.strictIsolationVerified,false);
 const approval=await ui('ui.agent.authorize',{provider:'codex',workspaceId:workspace.id,fingerprint:scope.fingerprint});
 const accepted=await ui('ui.approvals.decide',{id:approval.approvalId,approve:true});
 assert.equal(accepted.status,'accepted');assert.equal(typeof accepted.operationId,'string');
 let authorizationOperation;const authorizationDeadline=Date.now()+15000;
 do{
  authorizationOperation=await ui('ui.approvals.operation',{id:accepted.operationId});
  if(['completed','failed','unknown','cancelled'].includes(authorizationOperation.status))break;
  await new Promise(resolve=>setTimeout(resolve,20));
 }while(Date.now()<authorizationDeadline);
 assert.equal(authorizationOperation.status,'completed',JSON.stringify(authorizationOperation));
 assert.equal(authorizationOperation.decision,'approved');
 const session=await ui('ui.chat.sessions.create',{title:'large synthetic Chat Native acceptance'});
 await ui('ui.chat.config.set',{id:session.id,config:{mode:'smart',workspaceId:workspace.id,agentProvider:'codex',modelProvider:'',model:''}});
 for(const [index,request] of [
  ['1','Reply SNAPSHOT_HELLO_OK only. Do not call tools, run commands, or modify files.'],
  ['2','Read sample.ts and reply SNAPSHOT_ANALYSIS_1107. Do not modify any files.'],
  ['3','Reply SNAPSHOT_THIRD_OK only. Do not call tools or modify files.']
 ]){
  await ui('ui.chat.send',{id:session.id,text:request,clientMessageId:'large-native-'+index});
  let status;const deadline=Date.now()+120000;
  do{status=await ui('ui.chat.status',{id:session.id});if(!['starting','streaming','recovering','cancelling'].includes(status.state))break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
  taskId=status.taskId;
  assert.ok(!['starting','streaming','recovering','cancelling'].includes(status.state),'Native Chat must finish within its deadline');
  assert.equal(status.errorCode,null,'Native Chat terminal must not contain snapshot or execution errors');
  const history=await ui('ui.chat.history',{id:session.id});const answer=history.messages.at(-1);
  assert.equal(answer.role,'assistant');
  assert.equal(answer.errorCode,undefined,JSON.stringify({code:answer.errorCode,observed}));
  const expected=index==='1'?'SNAPSHOT_HELLO_OK':index==='2'?'SNAPSHOT_ANALYSIS_1107':'SNAPSHOT_THIRD_OK';
  assert.ok(answer.text.includes(expected),'native answer must contain this turn marker');
  assert.notEqual(answer.agentActivity?.status,'running','formal message must not remain generating');
  assert.equal((await ui('ui.task.get',{id:taskId})).task.status,'running');
 }
 assert.equal(fs.readFileSync(path.join(project,'sample.ts'),'utf8'),sample);
 assert.equal((await ui('ui.approvals.list')).approvals.length,0,'read-only turns do not request import');
 console.log((sea?'VERIFIED_RELEASE_INTEGRATION SEA no system Node; ':'')+'VERIFIED_REAL_E2E Native Codex + production Chat (automatic rollover explicitly disabled in isolated fixture), 1482 synthetic files/153831110 bytes, three turns, streaming/formal terminal, no source write or import; filesystem failures='+observed.length);
}finally{
 fs.readFileSync=read;fs.readdirSync=enumerate;fs.realpathSync.native=real;
 if(child){
  try{if(taskId){const task=(await rpc('ui.task.get',{id:taskId})).task;if(!['cancelled','completed','failed'].includes(task.status))await rpc('ui.task.cancel',{id:taskId,expectedRev:task.rev});}}finally{await stopSea();}
 }
 if(services){
  if(taskId){
   const deadline=Date.now()+90000;
   while(services.continuityService.runtime.isInFlight(taskId)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
   assert.equal(services.continuityService.runtime.isInFlight(taskId),false,'disposable Handoff must settle before fixture cancellation');
   const row=services.taskService.runtime.get({id:taskId}).task;
   if(!['cancelled','completed','failed'].includes(row.status))await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:row.id,expectedRev:row.rev}});
  }
  services.chatService.close();await services.capabilityService.close();await services.agentService.close();await services.managedAgent.close();
 }
 if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('cetamesh-codex-chat-snapshot-'))throw Error('fixture cleanup boundary');
 fs.rmSync(root,{recursive:true,force:true});
}
