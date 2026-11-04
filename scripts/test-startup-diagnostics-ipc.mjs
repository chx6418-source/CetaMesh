import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {dataCall,resolveDataPipeName} from '../src/control/data-ipc.js';
import {writeJsonAtomic,writeTextAtomic} from '../src/storage/json-file.js';
const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-startup-ipc-'));
const evidence=[];
function rpc(pipe,token,method,params={},version=1){return new Promise((resolve,reject)=>{
 const id=crypto.randomUUID(),socket=net.createConnection(pipe);let bytes=Buffer.alloc(0),sent=false,done=false;
 const timer=setTimeout(()=>finish(Error('RPC_TIMEOUT')),2500);
 function finish(error,result){if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(result);}
 socket.on('error',finish);socket.on('close',()=>{if(!done)finish(Error('RPC_CLOSED'));});
 socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4){const n=bytes.readUInt32LE(0);if(n>1024*1024)return finish(Error('FRAME_TOO_LARGE'));if(bytes.length<4+n)return;const frame=JSON.parse(bytes.subarray(4,4+n));bytes=bytes.subarray(4+n);
  if(!sent){assert.equal(frame.event,'core.ready');sent=true;const payload=Buffer.from(JSON.stringify({version,id,method,params,role:'console',authToken:token}));const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);socket.write(Buffer.concat([header,payload]));}
  else if(frame.id===id)finish(null,frame);
 }});
});}
async function scenario(name,damage,{packagedFixture=false,seaDirectory=null}={}){
 const blocked=Boolean(damage&&!damage.valid);
 const data=path.join(temp,name),state=path.join(data,'state');fs.mkdirSync(state,{recursive:true});const token=crypto.randomBytes(32).toString('hex');
 if(damage){fs.mkdirSync(path.dirname(path.join(state,damage.file)),{recursive:true});fs.writeFileSync(path.join(state,damage.file),damage.bytes);}
 const pipe=process.platform==='win32'?`\\\\.\\pipe\\cetamesh-diag-${crypto.randomUUID()}`:path.join(data,'ui.sock');
 let executable=process.execPath,entry=path.join(root,'src/core-entry.js'),resourceRoot=root,args=[entry,'--worker'];
 const fixtureBuild={version:'1.0.0-rc.2',buildId:'1.0.0-rc.2-build4242+abcdef0.DEV',commit:'a'.repeat(40)};
 if(packagedFixture){
  const install=path.join(temp,name+'-install');resourceRoot=path.join(install,'resources');fs.mkdirSync(resourceRoot,{recursive:true});
  writeJsonAtomic(path.join(install,'build-info.json'),fixtureBuild);
  writeJsonAtomic(path.join(install,'release-manifest.json'),{...fixtureBuild,channel:'dev',buildNumber:4242});
  writeJsonAtomic(path.join(data,'build-info.json'),{version:'0.0.0',buildId:'MUTABLE_DATA_LOOKALIKE',commit:'b'.repeat(40)});
  if(seaDirectory){
   executable=path.join(install,'WhaleBridgeCore.exe');fs.copyFileSync(path.join(seaDirectory,'WhaleBridgeCore.exe'),executable);
   fs.cpSync(path.join(seaDirectory,'resources'),resourceRoot,{recursive:true});args=['--worker'];
  }else{
   entry=path.join(temp,name+'-entry.mjs');
   writeTextAtomic(entry,`import {runCoreWorker} from ${JSON.stringify(new URL('../src/app/core-worker.js',import.meta.url).href)};\nimport {createAppPaths} from ${JSON.stringify(new URL('../src/app-paths.js',import.meta.url).href)};\nawait runCoreWorker({paths:createAppPaths(process.env,{packaged:true,execPath:${JSON.stringify(path.join(install,'WhaleBridgeCore.exe'))}})});\n`);
   args=[entry];
  }
 }
 const worker=spawn(executable,args,{cwd:data,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,WHALEBRIDGE_DATA_DIR:data,WHALEBRIDGE_RESOURCE_DIR:resourceRoot,WHALEBRIDGE_UI_PIPE:pipe,WHALEBRIDGE_UI_AUTH_TOKEN:token,WHALEBRIDGE_SUPERVISED:'1'}});
 let logs='';worker.stdout.on('data',b=>{logs+=b;});worker.stderr.on('data',b=>{logs+=b;});
 try{
  const deadline=Date.now()+20000;let response;
  while(Date.now()<deadline){if(worker.exitCode!==null)throw Error('Core exited before handshake: '+logs);try{response=await rpc(pipe,token,'ui.diagnostics.status');if(response.result?.report)break;}catch(e){if(!['ENOENT','ECONNREFUSED','RPC_TIMEOUT','RPC_CLOSED'].includes(e.code??e.message))throw e;}await new Promise(r=>setTimeout(r,75));}
  assert.ok(response?.result?.report,'real diagnostics IPC must answer within bound: '+logs);
  const report=response.result.report;evidence.push({scenario:name,report});
  assert.equal(report.status,blocked?'BLOCKED':'DEGRADED',JSON.stringify(report));
  if(damage)assert.equal(fs.readFileSync(path.join(state,damage.file),'utf8'),damage.bytes,'startup preserves existing journal and corrupt-store bytes');
  if(packagedFixture){
   assert.equal(report.product.version,fixtureBuild.version,'diagnostic-only Core reports the installed version while storage is blocked');
   assert.equal(report.product.build.buildId,fixtureBuild.buildId);
   assert.equal(report.product.build.commit,fixtureBuild.commit,'mutable data metadata cannot replace the installed identity');
  }
  const wrong=await rpc(pipe,'0'.repeat(64),'ui.diagnostics.status');assert.equal(wrong.error?.code,'IPC_AUTH_DENIED');
  const protocol=await rpc(pipe,token,'core.ping',{},2);assert.equal(protocol.error?.code,'UNSUPPORTED_VERSION');
  const normal=await rpc(pipe,token,'ui.chat.sessions.list');assert.equal(normal.ok,!blocked);
  if(blocked){assert.equal(normal.error?.code,'CORE_DIAGNOSTICS_BLOCKED');assert.equal(fs.readFileSync(path.join(state,damage.file),'utf8'),damage.bytes);assert.equal(fs.existsSync(path.join(state,'chat')) ,false);}
  else{
   assert.ok(report.checks.some(c=>c.id==='uiIpc'&&c.status==='PASS'));
   assert.ok(report.checks.some(c=>c.id==='dataIpc'&&c.status==='PASS'));
   for(const id of ['tasks','memory','workspace','capability','approval','journal'])assert.equal(report.checks.find(c=>c.id===id)?.status,'PASS',JSON.stringify(report));
   const synthetic=await rpc(pipe,token,'task.create',{goal:'Isolated diagnostic correlation fixture'});
   assert.equal(synthetic.ok,true);
   const taskId=synthetic.result.id,requestId=crypto.randomUUID();
   const denied=await rpc(pipe,token,'ui.task.start',{id:taskId,expectedRev:synthetic.result.rev,requestId});
   assert.equal(denied.error?.code,'TASK_WORKSPACE_REQUIRED','missing Workspace fails before Agent creation');
   const correlated=await rpc(pipe,token,'ui.diagnostics.status');
   const fault=correlated.result.report.runtimeFailures.find(row=>row.requestId===requestId);
   assert.equal(fault?.code,'TASK_WORKSPACE_REQUIRED');assert.equal(fault.taskId,taskId);
   assert.match(fault.correlationId,/^[a-f0-9-]{36}$/);
   const persisted=await rpc(pipe,token,'ui.diagnostics.read',{id:correlated.result.report.id});
   assert.deepEqual(persisted.result.report.runtimeFailures,correlated.result.report.runtimeFailures);
   const serviceToken=fs.readFileSync(path.join(state,'agent-token'),'utf8').trim();
   assert.equal((await dataCall({path:'/api/status',token:'wrong',pipeName:resolveDataPipeName({dataRoot:data})})).status,401);
   assert.equal((await dataCall({path:'/api/status',token:serviceToken,pipeName:resolveDataPipeName({dataRoot:data})})).json.ready,true);
   fs.mkdirSync(path.join(state,'tasks'),{recursive:true});const file=path.join(state,'tasks/tasks.json');fs.writeFileSync(file,'{"damaged":');
   const blocked=await rpc(pipe,token,'ui.diagnostics.run');assert.equal(blocked.result.report.status,'BLOCKED');assert.equal((await rpc(pipe,token,'ui.chat.sessions.list')).error.code,'CORE_DIAGNOSTICS_BLOCKED');
   assert.equal(fs.readFileSync(file,'utf8'),'{"damaged":');fs.unlinkSync(file);
   const restored=await rpc(pipe,token,'ui.diagnostics.run');assert.equal(restored.result.report.status,'DEGRADED');assert.equal((await rpc(pipe,token,'ui.chat.sessions.list')).ok,true);evidence.push({scenario:'recheck-after-repair-same-core',report:restored.result.report});
  }
  const list=await rpc(pipe,token,'ui.diagnostics.history');assert.ok(list.result.reports.length>=1);
  const bad=await rpc(pipe,token,'ui.diagnostics.read',{id:'../settings/settings.json'});assert.equal(bad.ok,false);
  console.log('PASS real Core named-pipe '+name+' auth/version/gate, original data preserved');
 }finally{
  worker.stdin.end();const exit=once(worker,'exit');await Promise.race([exit,new Promise((_,reject)=>setTimeout(()=>reject(Error('owned Core shutdown timeout')),7000).unref())]);
  assert.equal(fs.existsSync(path.join(state,'.core-owner.lock')),false,'owned Core clean shutdown releases existing lease');
 }
}
try{
 await scenario('normal-offline');
 await scenario('reconciled-history',{file:'continuity/transactions/reconciled.json',bytes:'{"taskId":"reconciled-fixture","sequence":1,"state":"reconciled","reconciledAt":1}',valid:true});
 await scenario('task-corruption',{file:'tasks/tasks.json',bytes:'{"schemaVersion":1,"revision":1,"tasks":"invalid"}'});
 await scenario('workspace-corruption',{file:'workspaces.json',bytes:'{"version":1,"workspaces":"invalid","pending":[],"activity":[]}'});
 await scenario('policy-storage-corruption',{file:'capability/approvals.json',bytes:'{"invalid":"policy"}'});
 await scenario('settings-corruption',{file:'settings/settings.json',bytes:'{"schemaVersion":1,"revision":1,"settings":"invalid"}'});
 await scenario('packaged-blocked-identity',{file:'continuity/transactions/broken.json',bytes:'{"taskId":"broken","sequence":1,"state":"invalid"}'},{packagedFixture:true});
 if(process.env.CETAMESH_STARTUP_SEA_DIR){
  const options={packagedFixture:true,seaDirectory:path.resolve(process.env.CETAMESH_STARTUP_SEA_DIR)};
  await scenario('packaged-sea-blocked-identity',{file:'continuity/transactions/broken.json',bytes:'{"taskId":"broken","sequence":1,"state":"invalid"}'},options);
  await scenario('packaged-sea-reconciled-history',{file:'continuity/transactions/reconciled.json',bytes:'{"taskId":"reconciled-fixture","sequence":1,"state":"reconciled","reconciledAt":1}',valid:true},options);
 }
 if(process.env.CETAMESH_STARTUP_EVIDENCE_DIR){fs.mkdirSync(process.env.CETAMESH_STARTUP_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CETAMESH_STARTUP_EVIDENCE_DIR,'real-core-ipc.json'),JSON.stringify({generatedAt:new Date().toISOString(),transport:'real-authenticated-native-and-data-pipe',evidence},null,2));}
}finally{fs.rmSync(temp,{recursive:true,force:true});}
