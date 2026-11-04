import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/storage/json-file.js';
import { createRuntimeFailureRegistry, projectRuntimeFailures, RUNTIME_FAILURE_CODES } from '../src/product/runtime-failures.js';
const modulePath=new URL('../src/product/startup-diagnostics.js',import.meta.url);
assert.ok(fs.existsSync(modulePath),'unified diagnostics must provide a bounded real service check runner');
const {runDiagnosticChecks,createStartupDiagnostics,preflightCriticalStorage}=await import(modulePath);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-startup-'));
try{
 const checks=await runDiagnosticChecks([
  {id:'core',stage:'core',critical:true,run:()=>true},
  {id:'optional',stage:'extensions',critical:false,run:()=>{throw Error('secret=must-not-leak private content');}},
  {id:'timeout',stage:'core',critical:true,run:()=>new Promise(()=>{})}
 ],{perCheckMs:30,totalMs:200});
 assert.equal(checks[0].status,'PASS');assert.equal(checks[1].status,'DEGRADED');assert.equal(checks[2].status,'BLOCKED');
 assert.equal(checks[2].timedOut,true);assert.equal(checks[1].timedOut,false);assert.doesNotMatch(JSON.stringify(checks),/must-not-leak|private content/);
 fs.mkdirSync(path.join(temp,'tasks'),{recursive:true});const taskFile=path.join(temp,'tasks/tasks.json');
 fs.writeFileSync(taskFile,'{"schemaVersion":1,"revision":1,"tasks":"corrupt-shape"}');
 const original=fs.readFileSync(taskFile);const preflight=await preflightCriticalStorage({stateDir:temp});
 assert.equal(preflight.status,'BLOCKED');assert.ok(preflight.checks.some(c=>c.code==='STORAGE_INVALID'));
 assert.deepEqual(fs.readFileSync(taskFile),original,'startup selfcheck never overwrites damaged data');
 fs.unlinkSync(taskFile);
 fs.mkdirSync(path.join(temp,'continuity'),{recursive:true});
 fs.writeFileSync(path.join(temp,'continuity/rollovers.json'),JSON.stringify({schemaVersion:2,rollovers:[],automaticBudgets:{}}));
 assert.equal((await preflightCriticalStorage({stateDir:temp})).status,'PASS','valid existing Continuity v2 history must remain usable');
 fs.mkdirSync(path.join(temp,'capability'),{recursive:true});const fp='a'.repeat(64);
 const alias=Object.fromEntries([['op',{status:'completed',fingerprint:fp}],['operation-request:'+fp,{operationKey:'op',fingerprint:fp}]]);
 fs.writeFileSync(path.join(temp,'capability/dispatches.json'),JSON.stringify(alias));
 assert.equal((await preflightCriticalStorage({stateDir:temp})).status,'PASS','stable logical operation request aliases are not malformed executions');
 fs.unlinkSync(path.join(temp,'capability/dispatches.json'));
 const transactions=path.join(temp,'continuity/transactions');fs.mkdirSync(transactions,{recursive:true});
 const transactionFile=path.join(transactions,'startup-fixture.json');
 for(const state of ['reconciled','committed','rolled-back','failed','prepared']){
  writeJsonAtomic(transactionFile,{taskId:'startup-fixture',sequence:1,state,...(state==='reconciled'?{reconciledAt:Date.now()}:{})});
  const bytes=fs.readFileSync(transactionFile),result=await preflightCriticalStorage({stateDir:temp});
  assert.equal(result.status,'PASS',`existing Continuity transaction state ${state} is valid`);
  assert.equal(result.unconfirmedEffects,state==='prepared','only an unresolved prepared transaction requires reconciliation');
  assert.deepEqual(fs.readFileSync(transactionFile),bytes,'read-only preflight preserves transaction bytes');
 }
 writeJsonAtomic(transactionFile,{taskId:'startup-fixture',sequence:1,state:'unrecognized'});
 assert.equal((await preflightCriticalStorage({stateDir:temp})).status,'BLOCKED','unknown transaction states remain rejected');
 fs.unlinkSync(transactionFile);
 for (const journal of ['requests', 'dispatches']) {
  const file=path.join(temp,'capability',journal+'.json');
  const prior=fs.existsSync(file)?fs.readFileSync(file):null;
  writeJsonAtomic(file,{'owner-reviewed':{taskId:'startup-fixture',workspaceId:'workspace-fixture',status:'reconciled',
   resolution:'owner-reviewed-no-replay',at:Date.now()}});
  const bytes=fs.readFileSync(file);
  assert.equal((await preflightCriticalStorage({stateDir:temp})).status,'PASS',`${journal} Owner-reviewed history must survive Core restart`);
  assert.deepEqual(fs.readFileSync(file),bytes,'startup validates without rewriting reviewed operation evidence');
  writeJsonAtomic(file,{'owner-reviewed':{status:'pretend-completed'}});
  assert.equal((await preflightCriticalStorage({stateDir:temp})).status,'BLOCKED','unrecognized operation status remains blocked');
  if(prior)fs.writeFileSync(file,prior);else fs.unlinkSync(file);
 }
 let enabledReads=0;const {createMeshService}=await import('../src/mesh/service.js');
 const deferred=createMeshService({stateDir:path.join(temp,'deferred'),autoRestore:false,isEnabled:()=>{enabledReads++;return false;}});
 await new Promise(r=>setTimeout(r,0));assert.equal(enabledReads,0,'no eager transport restoration before startup admission');await deferred.restoreTransport();assert.ok(enabledReads>0);await deferred.close();
 let runs=0;
 const diagnostics=createStartupDiagnostics({stateDir:temp,aboutInfo:()=>({version:'1.0.0-rc.2',runtime:{platform:process.platform,node:process.versions.node},build:{commit:'a'.repeat(40)}}),
  releaseConfig:{website:'https://example.com',feedback:{paths:{bug:'/feedback'}}},checks:()=>[{id:'core',stage:'core',critical:true,run:async()=>{runs++;await new Promise(r=>setTimeout(r,20));return true;}}]});
 const [a,b]=await Promise.all([diagnostics.run('manual'),diagnostics.run('manual')]);assert.equal(a.id,b.id);assert.equal(runs,1,'repeat selfcheck joins current read-only run');
 assert.equal(a.status,'PASS');assert.equal(a.persisted,true);assert.ok(a.feedback.url.startsWith('https://example.com/feedback'));
 const history=diagnostics.history();assert.equal(history.length,1);assert.equal(diagnostics.read(a.id).id,a.id);
 assert.throws(()=>diagnostics.read('../settings/settings.json'),/invalid|report/i);
 for(let i=0;i<23;i++)await diagnostics.run('manual');assert.equal(diagnostics.history().length,20,'local diagnostics retention bounded by count');
 assert.ok(Buffer.byteLength(JSON.stringify(a))<65536);assert.doesNotMatch(JSON.stringify(a),/secret|chatBody|must-not-leak|C:\\\\Users/);
 const reportPath=path.join(temp,'diagnostics',a.id+'.json');
 fs.writeFileSync(reportPath,JSON.stringify({...a,checks:[{id:'core',stage:'core',status:'PASS',code:'CHECK_OK',reason:'API_KEY_PLAINTEXT_PRIVATE',remediation:'SECRET_PRIVATE_BODY',durationMs:1}],chat:'PRIVATE_CHAT_BODY'}));
 const reread=diagnostics.read(a.id);assert.doesNotMatch(JSON.stringify(reread),/API_KEY_PLAINTEXT|SECRET_PRIVATE|PRIVATE_CHAT/,'disk reports are re-projected before display/export');
 diagnostics.close();
 const safeFailure={at:'2026-11-04T00:00:00.000Z',code:'SESSION_TRANSPORT_UNKNOWN',source:'task',
  taskId:'task_m0123456_123456789a',blockingTaskId:null,requestId:'11111111-2222-4333-8444-555555555555',
  correlationId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',failureStage:'unknown'};
 const failureDiagnostics=createStartupDiagnostics({stateDir:path.join(temp,'runtime-failures'),runtimeFailures:()=>[
  {...safeFailure,message:'PRIVATE_DIAGNOSTIC_PROMPT',path:'C:/private',apiKey:'sk-private-canary'}]});
 const failureReport=await failureDiagnostics.run('manual');
 assert.deepEqual(failureReport.runtimeFailures,[safeFailure],'protected report retains only exact bounded fault identities');
 assert.deepEqual(failureDiagnostics.read(failureReport.id).runtimeFailures,[safeFailure],'correlation evidence survives re-read/export projection');
 assert.doesNotMatch(JSON.stringify(failureReport),/PRIVATE_DIAGNOSTIC_PROMPT|C:\/private|sk-private-canary/);
 failureDiagnostics.close();
 const runtimeFailures=createRuntimeFailureRegistry();
 const rejected=Object.assign(new Error('PRIVATE_DIAGNOSTIC_PROMPT C:/private sk-private-canary'),{code:'SESSION_TRANSPORT_UNKNOWN'});
 const {createDesktopIpcRuntime:makeFailureRuntime}=await import('../src/app/ipc-runtime.js');
 const failureRuntime=makeFailureRuntime({services:{runtimeFailures,desktopUiService:{execute:async()=>{throw rejected;}}}});
 await assert.rejects(failureRuntime.dispatch({method:'ui.task.resume',params:{id:safeFailure.taskId,requestId:safeFailure.requestId,text:'PRIVATE_DIAGNOSTIC_PROMPT'}}),error=>error===rejected);
 assert.equal(runtimeFailures.list()[0].taskId,safeFailure.taskId);
 assert.equal(runtimeFailures.list()[0].requestId,safeFailure.requestId);
 assert.equal(runtimeFailures.list()[0].code,safeFailure.code);
 assert.match(runtimeFailures.list()[0].correlationId,/^[a-f0-9-]{36}$/);
 const brokenOptionalDiagnostics=makeFailureRuntime({services:{runtimeFailures:{record(){throw Error('diagnostic write unavailable');}},
  desktopUiService:{execute:async()=>{throw rejected;}}}});
 await assert.rejects(brokenOptionalDiagnostics.dispatch({method:'ui.task.resume',params:{id:safeFailure.taskId}}),error=>error===rejected,
  'optional diagnostic errors preserve the original execution failure');
 assert.doesNotMatch(JSON.stringify(runtimeFailures.list()),/PRIVATE_DIAGNOSTIC_PROMPT|C:\/private|sk-private-canary/);
 const unknownIdentity=runtimeFailures.record({source:'task',code:'PRIVATE_RAW_ERROR_CANARY',requestId:'sk-private-canary C:/private',taskId:'PRIVATE_DIAGNOSTIC_PROMPT'});
 assert.equal(unknownIdentity.code,'RUNTIME_FAILURE');assert.equal(unknownIdentity.taskId,null);
 assert.match(unknownIdentity.requestId,/^sha256:[a-f0-9]{64}$/);
 assert.deepEqual(projectRuntimeFailures([{...safeFailure,code:'PRIVATE_RAW_ERROR_CANARY'}]),[]);
 const badIds=projectRuntimeFailures([{...safeFailure,taskId:'C:/private',requestId:'sk-private-canary'}])[0];
 assert.equal(badIds.taskId,null);assert.equal(badIds.requestId,null);
 let rows=runtimeFailures.list();
 const live=createStartupDiagnostics({stateDir:path.join(temp,'live-failures'),runtimeFailures:()=>rows});
 const first=await live.run('manual');rows=[safeFailure];
 const refreshed=live.status().report;
 assert.notEqual(first.id,refreshed.id,'new failure metadata persists even when health codes are unchanged');
 assert.deepEqual(live.read(refreshed.id).runtimeFailures,[safeFailure]);live.close();
 for(let i=0;i<30;i++)runtimeFailures.record({source:'task',code:'TASK_WORKSPACE_BUSY',requestId:crypto.randomUUID()});
 assert.equal(runtimeFailures.list().length,20);
 // Keep the independent Rust export allowlist in conformance with Core.
 const native=fs.readFileSync(new URL('../desktop-shell/src/startup_diagnostics.rs',import.meta.url),'utf8');
 const nativeCodes=native.slice(native.indexOf('fn runtime_failure_code'),native.indexOf('fn runtime_task_id'));
 for(const code of RUNTIME_FAILURE_CODES)assert.ok(nativeCodes.includes('"'+code+'"'),'native export recognizes '+code);
 const {bootstrapCetaMesh}=await import('../src/app/bootstrap.js');
 const {serviceDiagnosticChecks}=await import('../src/app/diagnostic-checks.js');
 const state=path.join(temp,'actual-core/state');const app=bootstrapCetaMesh({stateDir:state,dataRoot:path.dirname(state),config:{}});
 try{
  const actual=await runDiagnosticChecks(serviceDiagnosticChecks(app.services,{light:true}));
  assert.deepEqual(actual.filter(c=>c.status==='BLOCKED'),[],JSON.stringify(actual));
  assert.ok(actual.find(c=>c.id==='capability'&&c.status==='PASS'),'real Broker must deny untrusted actor before executor');
  assert.ok(actual.find(c=>c.id==='tasks'&&c.status==='PASS'));
  assert.ok(actual.find(c=>c.id==='memory'&&c.status==='PASS'));
 }finally{await app.lifecycle.stop();}
 const {probeNativeIpc}=await import('../src/app/diagnostic-ipc.js');const net=await import('node:net');
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\cetamesh-diag-stalled-'+crypto.randomUUID():path.join(temp,'stalled.sock');
 const accepted=new Set(),stalled=net.createServer(socket=>{accepted.add(socket);socket.on('close',()=>accepted.delete(socket));});await new Promise(resolve=>stalled.listen(endpoint,resolve));
 try{const timed=await runDiagnosticChecks([{id:'uiIpc',stage:'transport',critical:true,run:()=>probeNativeIpc({pipeName:endpoint,token:'0'.repeat(64),timeoutMs:30})}]);assert.equal(timed[0].timedOut,true,'connected but stalled real pipe must be reported as timeout');}
 finally{for(const socket of accepted)socket.destroy();await new Promise(resolve=>stalled.close(resolve));}
 const plugin=serviceDiagnosticChecks({extensionService:{execute:async()=>({extensions:[{id:'crashed',status:'disabled_due_to_crash',runtimeState:'crashed',loaded:false}]})}}).find(c=>c.id==='plugins');
 assert.equal((await runDiagnosticChecks([plugin]))[0].status,'DEGRADED','actual extension crash shape cannot be reported ready');
 const {createCapabilityBroker}=await import('../src/capability/broker.js');
 let effects=0;const broker=createCapabilityBroker();broker.register({id:'filesystem.read',permission:'filesystem.read',risk:'low',effect:'read-only',execute:()=>{effects++;}});
 assert.equal(typeof broker.setExecutionGuard,'function','existing Broker gates background dispatch as well as UI');broker.setExecutionGuard(()=>{throw Object.assign(Error('blocked'),{code:'CORE_DIAGNOSTICS_BLOCKED'});});
 await assert.rejects(broker.execute({actor:{kind:'owner',id:'test'},capability:'filesystem.read',input:{path:'unused'}}),e=>e.code==='CORE_DIAGNOSTICS_BLOCKED');assert.equal(effects,0);
 const {createDesktopIpcRuntime}=await import('../src/app/ipc-runtime.js');
 let dispatched=0;const blockedRuntime=createDesktopIpcRuntime({services:{diagnostics:{blocked:()=>true,execute:()=>({report:{status:'BLOCKED'}})},chatService:{execute:()=>{dispatched++;return {};}}}});
 await assert.rejects(async()=>blockedRuntime.dispatch({method:'chat.send'}),e=>e.code==='CORE_DIAGNOSTICS_BLOCKED');assert.equal(dispatched,0);
 assert.equal((await blockedRuntime.dispatch({method:'ui.diagnostics.status'})).report.status,'BLOCKED');
 console.log('PASS bounded timeout/failure separation, critical gate, read-only corrupt preservation, local feedback and report retention');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
