import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createReaWorker} from '../src/reverselab/stdio-worker.js';
import {registerReverseLabSessions} from '../src/reverselab/session.js';

// A real, local MCP process observes the environment and lifecycle boundary.
// It never loads REA, user configuration, a model, or external network services.
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-rea-session-')));
 const entryPath=path.join(root,'fixture.mjs');
 fs.writeFileSync(entryPath,`
import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){
 const request=JSON.parse(line);if(request.id===undefined)continue;
 let result;
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{},prompts:{}},serverInfo:{name:'local-fixture',version:'1.0.0'}};
 else if(request.method==='tools/list')result={tools:[]};
 else if(request.method==='prompts/list')result={prompts:[]};
 else if(request.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(Object.fromEntries(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','PATH','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','CETAMESH_PRIVATE_TEST_SECRET'].map(key=>[key,process.env[key]??null])))}]};
 else throw Error('Unexpected fixture method');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}
`);
 return {root,assets:{nodePath:process.execPath,entryPath,version:'1.0.0'},
  remove(){assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('cm-rea-session-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}

await test('REA child uses its private profile and executable search path, not ambient user configuration',async()=>{
 const f=fixture(),runRoot=path.join(f.root,'run');fs.mkdirSync(runRoot);
 const keys=['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','PATH','CETAMESH_PRIVATE_TEST_SECRET'];
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));let worker;
 try{
  for(const key of keys)process.env[key]=path.join(f.root,'ambient-'+key);
  worker=createReaWorker({assets:f.assets,runRoot});await worker.initialize();
  const response=await worker.callTool('inspect_environment',{}),seen=JSON.parse(response.content[0].text);
  for(const key of ['HOME','USERPROFILE'])assert.equal(seen[key],runRoot,key);
  assert.equal(seen.PATH,path.dirname(process.execPath),'Only the selected runtime belongs on the REA PATH');
  assert.equal(seen.APPDATA,path.join(runRoot,'config'),'Roaming user configuration must stay private');
  assert.equal(seen.LOCALAPPDATA,path.join(runRoot,'cache'),'Local user configuration must stay private');
  if(process.platform==='win32')assert.equal(seen.HOMEDRIVE+seen.HOMEPATH,runRoot,'Windows home must agree with the private profile');
  assert.equal(seen.XDG_CONFIG_HOME,path.join(runRoot,'config'));
  assert.equal(seen.XDG_CACHE_HOME,path.join(runRoot,'cache'));
  assert.equal(seen.XDG_STATE_HOME,path.join(runRoot,'state'));
  assert.equal(seen.CETAMESH_PRIVATE_TEST_SECRET,null,'Ambient credentials must not be inherited');
 }finally{
  for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await worker?.close();f.remove();
 }
});

function sessionFixture(f){
 let definitions,unblock,leases=0,failNext=false;
 let gate=new Promise(resolve=>{unblock=resolve;});
 const config={enabled:true,revision:'fixture-v1',digest:'local-fixture'};
 const service=registerReverseLabSessions({stateDir:path.join(f.root,'state'),
  broker:{registry:{replaceProviderEntries(_owner,entries){definitions=entries;}}},
  engines:{getConfiguration:()=>config,acquire(){leases++;return()=>{leases--;};},
   async verifyConfiguration(){await gate;if(failNext){failNext=false;throw Object.assign(Error('Fixture verification failure'),{code:'FIXTURE_VERIFY_FAILED'});}return{assets:f.assets};}},
  taskRuntime:{get:({id})=>({task:{id,rev:1}}),addArtifact(){}}});
 const invoke=(id,taskId,input={})=>definitions.find(row=>row.id===id).execute({taskId,workspaceId:'fixture-workspace',actor:{kind:'owner',id:'fixture'},input});
 return{service,invoke,release(){unblock();gate=Promise.resolve();},failVerification(){failNext=true;},leases:()=>leases};
}

await test('Concurrent REA opens enforce four workers and release capacity after failure or close',async()=>{
 const f=fixture(),s=sessionFixture(f);
 try{
  const pending=Array.from({length:5},(_,i)=>s.invoke('reverselab.session.open','task-'+i));
  s.release();const results=await Promise.allSettled(pending);
  const opened=results.flatMap((row,i)=>row.status==='fulfilled'?[{...row.value,taskId:'task-'+i}]:[]);
  assert.equal(opened.length,4,'Five simultaneous verifications must not launch a fifth worker');
  assert.deepEqual(results.filter(row=>row.status==='rejected').map(row=>row.reason.code),['REVERSELAB_CAPACITY']);
  assert.deepEqual(s.service.status(),{sessions:4,active:0});assert.equal(s.leases(),0);
  await s.invoke('reverselab.session.close',opened[0].taskId,{sessionId:opened[0].sessionId});
  s.failVerification();await assert.rejects(s.invoke('reverselab.session.open','failed-task'),{code:'FIXTURE_VERIFY_FAILED'});
  assert.equal(s.service.status().sessions,3);assert.equal(s.leases(),0);
  await s.invoke('reverselab.session.open','replacement-task');assert.equal(s.service.status().sessions,4);
 }finally{await s.service.close();f.remove();}
});

await test('Closing REA while verification is pending prevents a late worker launch',async()=>{
 const f=fixture(),s=sessionFixture(f);
 try{
  const pending=s.invoke('reverselab.session.open','closing-task');
  await s.service.close();s.release();
  await assert.rejects(pending,{code:'REVERSELAB_BUSY'});
  assert.deepEqual(s.service.status(),{sessions:0,active:0});assert.equal(s.leases(),0);
  assert.equal(fs.existsSync(path.join(f.root,'state','reverselab','sessions')),false,'Shutdown must not create a late session or process');
 }finally{await s.service.close();f.remove();}
});
