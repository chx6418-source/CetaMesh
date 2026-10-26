import assert from 'node:assert/strict';
import { TEST_PACK_VERSION, TEST_PACKS, selectTestPacks, evaluateGuestReport } from '../src/environment/test-packs.js';
const binding = {version:1,actor:{kind:'owner',id:'desktop'},runId:'12345678-1234-4234-8234-123456789012',environmentId:'22345678-1234-4234-8234-123456789012',taskId:'task',attemptId:'attempt',workspaceId:'workspace',capability:'environment.test',expiresAt:Date.now()+60000,profileId:'offline',profileDigest:'a'.repeat(64),limits:{cpuCount:1,memoryMiB:4096,diskGiB:32,timeoutMs:10000,maxEvidenceBytes:4096,maxEvidenceFiles:8}};
const report = () => ({schemaVersion:1,...binding,startedAt:100,endedAt:200,guest:{windowsBuild:'26100',architecture:'AMD64'},evidence:[],checks:TEST_PACKS[0].requiredChecks.map(id=>({packId:'W01',id,status:'PASS',layer:'Windows VM E2E',code:'OBSERVED',observations:{actual:true,files:2,installerSha256:'a'.repeat(64),pid:42,coreSha256:'b'.repeat(64),commit:'c'.repeat(40),version:'1'},startedAt:110,endedAt:190,exitCode:0}))});
assert.equal(TEST_PACK_VERSION,1);
assert.equal(TEST_PACKS.length,7);
assert.throws(()=>selectTestPacks(['W99']));
assert.throws(()=>selectTestPacks(['W01','W01']));
const evaluate = value => evaluateGuestReport(value,{binding,packIds:['W01']});
assert.equal(evaluate(report()).status,'PASS');
for(const mutate of [r=>r.checks.pop(),r=>r.checks.push(r.checks[0]),r=>r.runId='foreign',r=>r.checks[0].endedAt=NaN,r=>r.checks[0].exitCode=1,r=>r.checks[0].observations={},r=>r.checks[0].observations={actual:true},r=>r.checks[0].layer='Integration',r=>r.endedAt=0]) { const r=report();mutate(r);assert.notEqual(evaluate(r).status,'PASS'); }
const blocked=report();blocked.checks[0].status='BLOCKED_ENV';assert.equal(evaluate(blocked).status,'BLOCKED_ENV');
const w03={...report(),checks:TEST_PACKS[2].requiredChecks.map(id=>({...report().checks[0],packId:'W03',id}))};
assert.notEqual(evaluateGuestReport(w03,{binding,packIds:['W03']}).status,'PASS');
console.log('PASS environment packs: malformed, duplicate, identity, time, exit, observation and GUI proof gates');

// Parse without executing Guest code or touching the host desktop.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
for(const name of ['guest-runner.ps1','guest-ui.ps1','guest-core.ps1','hyperv-host.ps1']) {
  const bytes=fs.readFileSync(new URL(`./environment/${name}`,import.meta.url));
  assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf',`${name}: Windows PowerShell 5.1 requires a UTF-8 BOM for non-ASCII script literals`);
}
if(process.platform==='win32') {
  const parsed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Get-ChildItem scripts/environment/guest-*.ps1 | ForEach-Object { $t=$null;$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};Write-Output $_.Name }"],{encoding:'utf8',timeout:20000});
  assert.equal(parsed.status,0,parsed.stderr || parsed.stdout);
  assert.match(parsed.stdout,/guest-runner.ps1/);assert.match(parsed.stdout,/guest-ui.ps1/);assert.match(parsed.stdout,/guest-core.ps1/);
}
const runner=fs.readFileSync(new URL('./environment/guest-runner.ps1',import.meta.url),'utf8');
assert.ok(runner.indexOf('GUEST_GUARD_REJECTED') < runner.indexOf('New-Item'));
assert.match(runner,/Win32_ComputerSystemProduct/);
assert.match(runner,/LogonType Interactive/);
assert.doesNotMatch(runner,/AutoAdminLogon|Enable-WindowsOptionalFeature/);
console.log('PASS Guest scripts: Windows PowerShell parser and guard/interactive contract');


const unknownReport={...report(),checks:TEST_PACKS[5].requiredChecks.map(id=>({...report().checks[0],packId:'W06',id,layer:'Integration',observations:id==='cancel-owned'?{actual:true,pid:4,startedAt:'2026-01-01T00:00:00Z',exitConfirmed:true}:id==='crash-restart'?{actual:true,oldPid:4,newPid:5,taskId:'child',persistenceRead:true}:{actual:true,attemptId:'a',replayed:false,reconciliationRequired:true}}))};
assert.notEqual(evaluateGuestReport(unknownReport,{binding,packIds:['W06']}).status,'PASS','unknown outcome needs persisted unknown state and actual redispatch refusal');
Object.assign(unknownReport.checks[2].observations,{attemptState:'unknown',taskStatus:'blocked',rejectionCode:'NEEDS_RECONCILIATION'});
assert.equal(evaluateGuestReport(unknownReport,{binding,packIds:['W06']}).status,'PASS');
for(const key of ['attemptState','taskStatus','rejectionCode']){const copy=structuredClone(unknownReport);delete copy.checks[2].observations[key];assert.notEqual(evaluateGuestReport(copy,{binding,packIds:['W06']}).status,'PASS');}
console.log('PASS unknown Attempt proof requires persisted state plus rejected redispatch');
for(const id of ['managed-tool-roundtrip','task-progress','cancel-propagation','real-provider']) assert.ok(TEST_PACKS[4].requiredChecks.includes(id),`W05 requires ${id}`);
const managedReport={...report(),checks:TEST_PACKS[4].requiredChecks.map(id=>({...report().checks[0],packId:'W05',id,layer:id==='real-provider'?'Real Provider E2E':'Integration',status:id==='real-provider'?'NOT_RUN':'PASS',observations:id==='managed-tool-roundtrip'?{actual:true,capability:'filesystem.read',callId:'real-call',resultMatched:true,rounds:2,actualContentObserved:true,provider:'synthetic-loopback'}:id==='task-progress'?{actual:true,taskId:'child',taskStatus:'running',executionEvidence:1,progressObserved:true,completed:false}:id==='cancel-propagation'?{actual:true,taskId:'child',taskStatus:'cancelled',modelConnectionClosed:true,cancelRequestedAt:120,connectionClosedAt:130}:{}}))};
assert.equal(evaluateGuestReport(managedReport,{binding,packIds:['W05']}).status,'NOT_RUN','external Provider must remain unverified after managed checks pass');
for(const [index,key] of [[0,'resultMatched'],[0,'actualContentObserved'],[1,'progressObserved'],[2,'modelConnectionClosed']]){const copy=structuredClone(managedReport);delete copy.checks[index].observations[key];assert.equal(evaluateGuestReport(copy,{binding,packIds:['W05']}).packs[0].checks[index].status,'INCONCLUSIVE');}
console.log('PASS managed tool proof and independent external Provider status');

const misclassified={...w03,checks:w03.checks.map(c=>({...c,status:'BLOCKED_ENV',code:'GUI_EXITED',observations:{actual:false}}))};
assert.equal(evaluateGuestReport(misclassified,{binding,packIds:['W03']}).status,'FAIL','Guest product failure cannot become environment skip');
if(process.platform==='win32') {
  // Execute only the AST-extracted pure classifier, never the Guest entry script or its probes.
  const classified=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/environment/guest-core.ps1'),[ref]$t,[ref]$e);$f=$a.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-GuestFailureStatus'},$true);if(-not $f){throw 'classifier missing'};. ([scriptblock]::Create($f.Extent.Text));$out=@{};@('GUI_EXITED','ONBOARDING_STEP4_STALLED','ONBOARDING_STILL_VISIBLE','UIA_FLOW_TIMEOUT','INSTALL_FAILED','CORE_PING_FAILED','UIA_DEPENDENCY_MISSING','INTERACTIVE_SESSION_MISSING','UIA_TREE_UNOBSERVABLE','SCREENSHOT_WINDOW_NOT_FOREGROUND','UI_RESULT_MISSING','INSTALL_TIMEOUT_UNKNOWN_OUTCOME','GUEST_OPERATION_UNCLASSIFIED')|ForEach-Object{$out[$_]=Get-GuestFailureStatus $_};$out|ConvertTo-Json -Compress"],{encoding:'utf8',timeout:20000});
  assert.equal(classified.status,0,classified.stderr);
  const outcomes=JSON.parse(classified.stdout.trim());
  for(const code of ['GUI_EXITED','ONBOARDING_STEP4_STALLED','ONBOARDING_STILL_VISIBLE','UIA_FLOW_TIMEOUT','INSTALL_FAILED','CORE_PING_FAILED']) assert.equal(outcomes[code],'FAIL',code);
  for(const code of ['UIA_DEPENDENCY_MISSING','INTERACTIVE_SESSION_MISSING']) assert.equal(outcomes[code],'BLOCKED_ENV',code);
  for(const code of ['UIA_TREE_UNOBSERVABLE','SCREENSHOT_WINDOW_NOT_FOREGROUND','UI_RESULT_MISSING','INSTALL_TIMEOUT_UNKNOWN_OUTCOME','GUEST_OPERATION_UNCLASSIFIED']) assert.equal(outcomes[code],'INCONCLUSIVE',code);
}
for(const code of ['GUI_EXITED','GUI_LAUNCH_FAILED','GUI_WINDOW_UNAVAILABLE','ONBOARDING_STEP4_STALLED','ONBOARDING_STILL_VISIBLE','UIA_FLOW_TIMEOUT']){const copy=structuredClone(misclassified);copy.checks[0].code=code;assert.equal(evaluateGuestReport(copy,{binding,packIds:['W03']}).packs[0].checks[0].status,'FAIL',code);}
console.log('PASS pure Guest failure classification: product FAIL, prerequisite BLOCKED_ENV, missing evidence INCONCLUSIVE');
// Real production IPC framing against only AST-extracted reader functions; no SEA or Guest bootstrap.
if(process.platform==='win32') {
  const {default:net}=await import('node:net');
  const {spawn}=await import('node:child_process');
  const {startIpcProtocol}=await import('../src/control/ipc-protocol.js');
  const pipeName=`cetamesh-guest-reader-${process.pid}-${Date.now()}`;
  const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));startIpcProtocol({input:socket,output:socket,dispatch:()=>({}),authenticate:r=>r.role==='console'&&r.authToken==='a'.repeat(64)}).done.catch(()=>{});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+pipeName,resolve);});
  try {
    const command="$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/environment/guest-core.ps1'),[ref]$t,[ref]$e);foreach($name in @('Read-Exact','Call-Core')){$f=$a.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(-not $f){throw 'function missing'};. ([scriptblock]::Create($f.Extent.Text))};function Now {[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()};$deadline=(Now)+15000;$pipeName=$env:CETAMESH_FIXTURE_PIPE;$token='a'*64;$ping=Call-Core 'core.ping';$denied=Call-Core 'core.ping' @{} $true;@{pong=$ping.result.status;denied=$denied.error.code}|ConvertTo-Json -Compress";
    const result=await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,CETAMESH_FIXTURE_PIPE:pipeName},windowsHide:true});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Guest IPC fixture timeout'));},20000);child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});
    assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{pong:'pong',denied:'IPC_AUTH_DENIED'});
  } finally {for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  console.log('PASS extracted Guest IPC reader against production core.ready/pong/auth-denied frames');
}
