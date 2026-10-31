import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {dataCall,resolveDataPipeName} from '../src/control/data-ipc.js';
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
async function scenario(name,damage){
 const data=path.join(temp,name),state=path.join(data,'state');fs.mkdirSync(state,{recursive:true});const token=crypto.randomBytes(32).toString('hex');
 if(damage){fs.mkdirSync(path.dirname(path.join(state,damage.file)),{recursive:true});fs.writeFileSync(path.join(state,damage.file),damage.bytes);}
 const pipe=process.platform==='win32'?`\\\\.\\pipe\\cetamesh-diag-${crypto.randomUUID()}`:path.join(data,'ui.sock');
 const worker=spawn(process.execPath,[path.join(root,'src/core-entry.js'),'--worker'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,WHALEBRIDGE_DATA_DIR:data,WHALEBRIDGE_RESOURCE_DIR:root,WHALEBRIDGE_UI_PIPE:pipe,WHALEBRIDGE_UI_AUTH_TOKEN:token,WHALEBRIDGE_SUPERVISED:'1'}});
 let logs='';worker.stdout.on('data',b=>{logs+=b;});worker.stderr.on('data',b=>{logs+=b;});
 try{
  const deadline=Date.now()+20000;let response;
  while(Date.now()<deadline){if(worker.exitCode!==null)throw Error('Core exited before handshake: '+logs);try{response=await rpc(pipe,token,'ui.diagnostics.status');if(response.result?.report)break;}catch(e){if(!['ENOENT','ECONNREFUSED','RPC_TIMEOUT','RPC_CLOSED'].includes(e.code??e.message))throw e;}await new Promise(r=>setTimeout(r,75));}
  assert.ok(response?.result?.report,'real diagnostics IPC must answer within bound: '+logs);
  const report=response.result.report;evidence.push({scenario:name,report});
  assert.equal(report.status,damage?'BLOCKED':'DEGRADED',JSON.stringify(report));
  const wrong=await rpc(pipe,'0'.repeat(64),'ui.diagnostics.status');assert.equal(wrong.error?.code,'IPC_AUTH_DENIED');
  const protocol=await rpc(pipe,token,'core.ping',{},2);assert.equal(protocol.error?.code,'UNSUPPORTED_VERSION');
  const normal=await rpc(pipe,token,'ui.chat.sessions.list');assert.equal(normal.ok,!damage);
  if(damage){assert.equal(normal.error?.code,'CORE_DIAGNOSTICS_BLOCKED');assert.equal(fs.readFileSync(path.join(state,damage.file),'utf8'),damage.bytes);assert.equal(fs.existsSync(path.join(state,'chat')) ,false);}
  else{
   assert.ok(report.checks.some(c=>c.id==='uiIpc'&&c.status==='PASS'));
   assert.ok(report.checks.some(c=>c.id==='dataIpc'&&c.status==='PASS'));
   for(const id of ['tasks','memory','workspace','capability','approval','journal'])assert.equal(report.checks.find(c=>c.id===id)?.status,'PASS',JSON.stringify(report));
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
 await scenario('task-corruption',{file:'tasks/tasks.json',bytes:'{"schemaVersion":1,"revision":1,"tasks":"invalid"}'});
 await scenario('workspace-corruption',{file:'workspaces.json',bytes:'{"version":1,"workspaces":"invalid","pending":[],"activity":[]}'});
 await scenario('policy-storage-corruption',{file:'capability/approvals.json',bytes:'{"invalid":"policy"}'});
 await scenario('settings-corruption',{file:'settings/settings.json',bytes:'{"schemaVersion":1,"revision":1,"settings":"invalid"}'});
 if(process.env.CETAMESH_STARTUP_EVIDENCE_DIR){fs.mkdirSync(process.env.CETAMESH_STARTUP_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CETAMESH_STARTUP_EVIDENCE_DIR,'real-core-ipc.json'),JSON.stringify({generatedAt:new Date().toISOString(),transport:'real-authenticated-native-and-data-pipe',evidence},null,2));}
}finally{fs.rmSync(temp,{recursive:true,force:true});}
