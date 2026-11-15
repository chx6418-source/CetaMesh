import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createAgentOsHost, signAgentOsGrant} from '../src/agentos/host.js';
import {prepareAgentOsRuntime} from './agentos/prepare-runtime.mjs';
import {pathToFileURL} from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-agentos-adapter-'));
try {
 const key=crypto.randomBytes(32).toString('hex');
 const claims={operationId:'test-operation',taskId:'task-one',workspaceId:'workspace-one'};
 const token=signAgentOsGrant(claims,key),[body,signature]=token.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),claims);
 assert.equal(signature,crypto.createHmac('sha256',key).update(body).digest('base64url'));
 // A managed host may close its request pipe before its process exits.
 // Exercise the real OS pipe: a stream error must reject the call, not crash Core.
 const brokenRoot=path.join(root,'broken-host');fs.mkdirSync(path.join(brokenRoot,'server','managed'),{recursive:true});
 fs.writeFileSync(path.join(brokenRoot,'server','managed','stdio.mjs'),
  "import fs from 'node:fs'; fs.closeSync(0); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{ready:true}})+'\\n'); setTimeout(()=>{},10000);");
 const broken=createAgentOsHost({root:brokenRoot,nodePath:process.execPath,home:path.join(root,'broken-home'),sessionKey:key});
 try {
  await broken.hello();
  await assert.rejects(broken.request({payload:'x'.repeat(128*1024)}),{code:'AGENTOS_HOST_DISCONNECTED'});
 }finally{await broken.close();}
 console.log('PASS closed managed input pipe rejects without crashing the caller');
 if(process.env.CETAMESH_TEST_AGENTOS_ROOT){
  if(!fs.existsSync(path.join(process.env.CETAMESH_TEST_AGENTOS_ROOT,'cetamesh-adaptation.json'))){
   const prepared=prepareAgentOsRuntime({source:process.env.CETAMESH_TEST_AGENTOS_ROOT,output:path.join(root,'prepared')});
   const {createDockerBackend}=await import(pathToFileURL(path.join(prepared,'server','backends','docker.js')));
   const calls=[];
   const backend=createDockerBackend({whichImpl:()=>process.execPath,runImpl:async args=>{calls.push(args);return {code:0,stdout:'local'};},runOkImpl:async args=>{calls.push(args);return {code:0,stdout:''};}});
   await backend.create({id:'test-owned',memMb:128},{image:'existing:local'});
   assert.equal(calls.some(args=>args[1]==='pull'),false,'An existing image must not trigger a download');
   assert.ok(calls.some(args=>args.includes('--pull')&&args.includes('never')));
  }
  const host=createAgentOsHost({root:process.env.CETAMESH_TEST_AGENTOS_ROOT,nodePath:process.execPath,
   home:path.join(root,'managed'),sessionKey:key});
  try {
   assert.equal((await host.hello()).protocol,'cetamesh.agentos.managed.v1');
   const input={},operationId=crypto.randomUUID(),contextRef='task-one:workspace-one';
   const grant={namespace:'cetamesh-managed',operationId,contextRef,capability:'agentos.env.list',
    taskId:'task-one',workspaceId:'workspace-one',scopeId:'scope-one',environmentId:null,
    inputDigest:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    expiresAt:Date.now()+30000,limits:{maxOutputBytes:16384,maxTimeoutMs:30000,maxMemoryMb:2048,maxDiskGb:20}};
   const request={operationId,contextRef,capability:grant.capability,input,grant:signAgentOsGrant(grant,key)};
   const result=await host.request(request);
   assert.equal(result.ok,true);assert.deepEqual(result.result.environments,[]);
   const rejected=await host.request({...request,grant:request.grant+'corrupt'});
   assert.equal(rejected.ok,false);assert.equal(rejected.code,'APPROVAL_REQUIRED');
   const foreign={...grant,operationId:crypto.randomUUID(),capability:'agentos.env.status',environmentId:'foreign-env',
    inputDigest:crypto.createHash('sha256').update(JSON.stringify({id:'foreign-env'})).digest('hex')};
   assert.equal((await host.request({operationId:foreign.operationId,contextRef,capability:foreign.capability,
    input:{id:'foreign-env'},grant:signAgentOsGrant(foreign,key)})).code,'SCOPE_DENIED');
   console.log('PASS actual AgentOS managed process, signed scoped request, invalid signature and foreign environment refusal');
  } finally {await host.close();}
 } else console.log('NOT_TESTED real AgentOS process: CETAMESH_TEST_AGENTOS_ROOT not set');
} finally {fs.rmSync(root,{recursive:true,force:true});}
