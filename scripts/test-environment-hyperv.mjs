import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { sha256 } from '../src/environment/contracts.js';
import { createHyperVBackend } from '../src/environment/hyperv-backend.js';
// Windows TEMP may use an 8.3 alias; .NET GetFullPath expands it before
// ownership comparison, so fixture resources must use the same canonical root.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-hyperv-')));
const profile={version:1,id:'fixture',backend:'hyper-v',mode:'lifecycle-fixture',network:'offline',image:{id:'win',path:path.join(root,'base.vhdx'),sha256:crypto.createHash('sha256').update('image').digest('hex'),source:'owner-approved-local-image',windowsBuild:'26100',architecture:'x64'},candidate:null,guestCredentialFile:path.join(root,'credential.xml'),limits:{cpuCount:2,memoryMiB:4096,diskGiB:64,timeoutMs:900000,maxEvidenceBytes:67108864,maxEvidenceFiles:128},packIds:['W01'],retainedLimit:1};
const binding={version:1,actor:{kind:'owner',id:'owner'},taskId:'task',attemptId:'attempt',runId:crypto.randomUUID(),environmentId:crypto.randomUUID(),workspaceId:'workspace',capability:'environment.test',expiresAt:Date.now()+900000,profileId:profile.id,profileDigest:sha256(profile),limits:profile.limits};
try {
 // Exercise the actual subprocess result boundary on every OS. A launcher guard
 // refusal must never become a passing VM check or hide an unknown driver error.
 const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');
 const originalSpawn=childProcess.spawn;
 let launchResult,launchCode=1;
 childProcess.spawn=()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.kill=()=>true;child.stdin=new EventEmitter();child.stdin.end=input=>queueMicrotask(()=>{
   const result=typeof launchResult==='function'?launchResult(JSON.parse(input)):launchResult;
   child.stdout.emit('data',Buffer.from(typeof result==='string'?result:JSON.stringify(result)));
   child.emit('close',launchCode);
  });return child;
 };
 syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'win32',configurable:true});
 try {
  const realBoundary=createHyperVBackend({hostRoot:root});
  for(const reason of ['HOST_ROOT_MISSING','UNSAFE_PRIVILEGED_OWNER','UNSAFE_PRIVILEGED_ACL','UNSAFE_PRIVILEGED_REPARSE']) {
   launchResult={error:{code:'HYPERV_LAUNCH_REJECTED',reason,message:'Trusted launcher rejected execution'}};
   const blocked=await realBoundary.preflight({});
   assert.equal(blocked.status,'BLOCKED_ENV');assert.deepEqual(blocked.reasons,[reason]);
   assert.equal(blocked.readOnly,true);assert.equal(blocked.executed,false);
   assert.equal(blocked.observations.permissions.trustedAcl,'UNSAFE_OR_MISSING');
   await assert.rejects(realBoundary.prepare({binding,profile}),{code:'BLOCKED_ENV'},'unsafe launcher must never create a VM');
   assert.equal(fs.existsSync(path.join(root,'runs',binding.runId,'ownership.json')),false);
  }
  for(const error of [{code:'HYPERV_LAUNCH_REJECTED',reason:'LAUNCH_FAILED'}, {code:'HYPERV_OPERATION_FAILED',message:'driver defect'}, {code:'SCRIPT_CHANGED',message:'pin mismatch'}]) {
   launchResult={error};await assert.rejects(realBoundary.preflight({}),{code:error.code});
  }
  fs.writeFileSync(profile.image.path,'image');
  const rejectedBinding={...binding,runId:crypto.randomUUID(),environmentId:crypto.randomUUID()};
  launchResult=input=>input.operation==='preflight'?{status:'PASS'}:{error:{code:'HYPERV_LAUNCH_REJECTED',reason:'UNSAFE_PRIVILEGED_ACL'}};
  launchCode=0;
  await assert.rejects(realBoundary.prepare({binding:rejectedBinding,profile}),{code:'HYPERV_LAUNCH_REJECTED'},'mutation refuses the guard failure instead of treating it as a preflight report');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runs',rejectedBinding.runId,'ownership.json'),'utf8')).state,'quarantined');
  launchCode=1;
  launchResult='not JSON';await assert.rejects(realBoundary.preflight({}),{code:'HYPERV_INVALID_OUTPUT'});
  launchResult={status:'PASS'};await assert.rejects(realBoundary.preflight({}),{code:'HYPERV_FAILED'});
  launchCode=0;launchResult={status:'BLOCKED_ENV',readOnly:true,reasons:['APPROVED_PROFILE_REQUIRED'],observations:{os:{build:'fixture'}}};
  assert.deepEqual(await realBoundary.preflight({}),launchResult,'valid driver observations pass through unchanged');
 } finally {childProcess.spawn=originalSpawn;syncBuiltinESMExports();Object.defineProperty(process,'platform',originalPlatform);}
 fs.writeFileSync(profile.image.path,'image');
 let calls=[];
 const backend=createHyperVBackend({hostRoot:root, executePowerShell:async(op,p)=>{calls.push(op); if(op==='preflight')return {status:'PASS'}; if(op==='prepare')return {...p.resources,vmId:crypto.randomUUID()}; if(op==='inspect')return {owned:true,state:'Off'}; if(op==='stop')return {owned:true,state:'Off'}; return {status:'PASS'};}});
 assert.equal((await backend.preflight({})).status,'PASS');
 await assert.rejects(backend.start({resources:{vmId:crypto.randomUUID()}}));
 const ctx={binding,profile};ctx.resources=await backend.prepare(ctx);
 assert.ok(fs.existsSync(path.join(root,'runs',binding.runId,'ownership.json')));
 await assert.rejects(backend.prepare(ctx));
 await backend.start(ctx);
 await assert.rejects(backend.start({...ctx,resources:{...ctx.resources,ownerNonce:'foreign'}}));
 await assert.rejects(backend.destroyOwned({...ctx,evidenceReceipt:{verified:true}}));
 assert.equal((await backend.stop(ctx)).state,'Off');
 const abort=new AbortController();abort.abort();
 await assert.rejects(backend.start(ctx,{signal:abort.signal}));
 assert.equal(calls.filter(x=>x==='prepare').length,1);
 const unsafe=createHyperVBackend({hostRoot:root,executePowerShell:async()=>({owned:false,state:'Off'})});
 await assert.rejects(unsafe.start(ctx));
 const unknownStop=createHyperVBackend({hostRoot:root,executePowerShell:async(op)=>op==='inspect'?{owned:true,state:'Running'}:{state:'Running'}});
 await assert.rejects(unknownStop.stop(ctx),{code:'EFFECTS_UNKNOWN'});
 const failedExport=createHyperVBackend({hostRoot:root,executePowerShell:async(op)=>{if(op==='inspect')return {owned:true,state:'Off'};throw Object.assign(new Error('export failed'),{code:'EXPORT_FAILED'});}});
 await assert.rejects(failedExport.copyOut(ctx),{code:'EXPORT_FAILED'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runs',binding.runId,'ownership.json'),'utf8')).state,'created');
 const lateBinding={...binding,runId:crypto.randomUUID(),environmentId:crypto.randomUUID()};const lateAbort=new AbortController();
 const late=createHyperVBackend({hostRoot:root,executePowerShell:async(op,p)=>{if(op==='preflight')return {status:'PASS'};lateAbort.abort();return {...p.resources,vmId:crypto.randomUUID()};}});
 await assert.rejects(late.prepare({binding:lateBinding,profile},{signal:lateAbort.signal}),{code:'EFFECTS_UNKNOWN'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runs',lateBinding.runId,'ownership.json'),'utf8')).state,'quarantined');
 let confirmed=false;const cancelExec=createHyperVBackend({hostRoot:root,executePowerShell:async(op)=>{if(op==='inspect')return {owned:true,state:'Running'};if(op==='stop'){confirmed=true;return {state:'Off'};}throw Object.assign(new Error('subprocess exited'),{code:'EFFECTS_UNKNOWN'});}});
 await assert.rejects(cancelExec.exec(ctx),e=>e.code==='EFFECTS_UNKNOWN'&&e.vmStopConfirmed===true);assert.equal(confirmed,true);
 const exportDir=path.join(root,'runs',binding.runId,'exports');fs.mkdirSync(exportDir,{recursive:true});fs.writeFileSync(path.join(exportDir,'report.json'),'{}');
 const receiptFile={path:'report.json',relativePath:'runs/'+binding.runId+'/exports/report.json',bytes:2,sha256:sha256('{}')};
 const exporting=createHyperVBackend({hostRoot:root,executePowerShell:async(op)=>op==='inspect'?{owned:true,state:'Off'}:{runId:binding.runId,environmentId:binding.environmentId,files:[receiptFile]}});
 assert.equal((await exporting.copyOut(ctx)).files[0].source,path.join(exportDir,'report.json'));
 await backend.destroyOwned({...ctx,evidenceReceipt:{verified:true,runId:binding.runId,environmentId:binding.environmentId,files:[receiptFile]}});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runs',binding.runId,'ownership.json'),'utf8')).state,'destroyed');
 if(process.platform==='win32') {
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=path.resolve('scripts/environment/hyperv-host.ps1');
  const parse=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',"$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:CetaMeshTestScript,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}"],{env:{...process.env,CetaMeshTestScript:script},encoding:'utf8'});
  assert.equal(parse.status,0,parse.stderr);
  const preflight=await createHyperVBackend({hostRoot:root}).preflight({});
  assert.ok(['PASS','BLOCKED_ENV'].includes(preflight.status));
  assert.equal(preflight.readOnly,true);
  if(preflight.executed===false) {
   assert.equal(preflight.status,'BLOCKED_ENV');
   assert.equal(preflight.observations.permissions.trustedAcl,'UNSAFE_OR_MISSING');
   assert.equal(preflight.reasons.length,1);
   assert.ok(['HOST_ROOT_MISSING','UNSAFE_PRIVILEGED_OWNER','UNSAFE_PRIVILEGED_ACL','UNSAFE_PRIVILEGED_REPARSE'].includes(preflight.reasons[0]));
  } else {
  assert.equal(typeof preflight.observations.os.build,'string');
  assert.equal(typeof preflight.observations.memory.availableBytes,'number');
  assert.equal(preflight.observations.memory.hostReserveBytes,2*1024**3);
  assert.equal(typeof preflight.observations.permissions.elevated,'boolean');
  assert.ok(['SUPPORTED','MASKED_BY_HYPERVISOR','UNSUPPORTED','UNKNOWN'].includes(preflight.observations.virtualization.status));
  assert.ok(Object.hasOwn(preflight.observations,'storage'));
  assert.ok(Object.hasOwn(preflight.observations,'network'));
  assert.ok(Object.hasOwn(preflight.observations,'existingResources'));
  assert.ok(!JSON.stringify(preflight.observations).includes('vmName'));
  }
  const extractDefinitions=value=>{
   const normalized=value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
   const entry=normalized.indexOf('\ntry {\n $raw=');
   assert.ok(entry>=0,'Driver entrypoint marker must exist before extracting pure function fixtures');
   return normalized.slice(0,entry);
  };
  const scriptText=fs.readFileSync(script,'utf8');
  const source=extractDefinitions(scriptText);
  assert.equal(extractDefinitions('\uFEFF'+scriptText.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\n/g,'\r\n')),source,'CRLF/BOM checkouts must extract the same functions without running the entrypoint');
  const fixtureFile=path.join(root,'driver-fixture.ps1');
  const fixture=String.raw`param([string]$Root)
`+source+String.raw`
function Get-VM {param($Id) return $script:fakeVm}
function Get-VMHardDiskDrive {param($VM) return [pscustomobject]@{Path=$script:r.diskPath}}
function Get-VHD {param($Path) return [pscustomobject]@{ParentPath=$script:parent;VhdType='Fixed';Size=1GB}}
function Get-VMSnapshot {param($VM) return @()}
function Get-VMNetworkAdapter {param($VM) return @()}
$r=[pscustomobject]@{vmId=[guid]::NewGuid();vmName='owned';ownerNonce='nonce';runId='fixture';environmentId='env';vmDirectory=(Join-Path $Root 'runs\fixture\vm');diskPath=(Join-Path $Root 'runs\fixture\vm\guest.vhdx')}
if($r.vmDirectory -cne [IO.Path]::GetFullPath($r.vmDirectory) -or $r.diskPath -cne [IO.Path]::GetFullPath($r.diskPath)){throw 'Fixture paths differ from Windows canonical paths'}
$p=[pscustomobject]@{hostRoot=$Root;resources=$r;binding=[pscustomobject]@{runId='fixture';environmentId='env'};profile=[pscustomobject]@{limits=[pscustomobject]@{diskGiB=64}}}
$fakeVm=[pscustomobject]@{Name='owned';Notes='CetaMesh:nonce:fixture:env';Path=$r.vmDirectory;State='Off'}
$parent=$null
[void](Inspect-Owned $p)
$ownedDirectory=$r.vmDirectory
$r.vmDirectory=Join-Path $Root 'runs\foreign\vm'
$denied=$false;try{[void](Inspect-Owned $p)}catch{if($_.Exception.Message -eq 'OWNERSHIP_PATH_MISMATCH'){$denied=$true}else{throw}}
if(-not $denied){throw 'Foreign ownership path accepted'}
$r.vmDirectory=$ownedDirectory
[void](Inspect-Owned $p)
$fakeVm.Notes='foreign'
$denied=$false;try{[void](Inspect-Owned $p)}catch{$denied=$true};if(-not $denied){throw 'foreign nonce accepted'}
$fakeVm.Notes='CetaMesh:nonce:fixture:env';$parent='foreign-base.vhdx'
$denied=$false;try{[void](Inspect-Owned $p)}catch{$denied=$true};if(-not $denied){throw 'foreign disk parent accepted'}
function Get-CimInstance {param($ClassName)
 switch($ClassName){
 'Win32_OperatingSystem' {return [pscustomobject]@{Caption='Fixture Windows';BuildNumber='26100';Version='10.0';OSArchitecture='64-bit';OperatingSystemSKU=48;FreePhysicalMemory=8388608;TotalVisibleMemorySize=16777216}}
 'Win32_ComputerSystem' {return [pscustomobject]@{HypervisorPresent=$script:hypervisor;NumberOfLogicalProcessors=4}}
 'Win32_Processor' {return [pscustomobject]@{VirtualizationFirmwareEnabled=$false;SecondLevelAddressTranslationExtensions=$false;VMMonitorModeExtensions=$false}}
 }
}
function Get-Service {param($Name) return [pscustomobject]@{Status='Running'}}
function Get-VMSwitch {return @()}
$hypervisor=$true
$pre=Run-Operation ([pscustomobject]@{operation='preflight';hostRoot=$Root})
if($pre.observations.virtualization.status -ne 'MASKED_BY_HYPERVISOR' -or $pre.reasons -contains 'CPU_VIRTUALIZATION_UNAVAILABLE'){throw 'Masked CPU flags incorrectly blocked'}
if($pre.observations.memory.hostReserveBytes -ne 2GB){throw 'Incorrect host reserve'}
$hypervisor=$false
$pre=Run-Operation ([pscustomobject]@{operation='preflight';hostRoot=$Root})
if($pre.observations.virtualization.status -ne 'UNSUPPORTED'){throw 'Absent CPU virtualization incorrectly accepted'}
$badAclParent=$Root;$badOwner=$false;$aclRights=64
function Get-Acl {param($LiteralPath)
 $sid=if($LiteralPath -eq $script:badAclParent){'S-1-1-0'}else{'S-1-5-32-544'}
 $owner=if($script:badOwner -and $LiteralPath -eq $script:badAclParent){'S-1-1-0'}elseif($script:ownerOverride -and $LiteralPath -eq $script:badAclParent){$script:ownerOverride}else{'S-1-5-32-544'}
 return [pscustomobject]@{Owner=$owner;Access=@([pscustomobject]@{IdentityReference=(New-Object Security.Principal.SecurityIdentifier($sid));AccessControlType='Allow';FileSystemRights=$script:aclRights})}
}
$denied=$false;try{Assert-Acl (Join-Path $Root 'base.vhdx')}catch{if($_.Exception.Message -eq 'UNSAFE_PRIVILEGED_ACL'){$denied=$true}else{throw}}
if(-not $denied){throw 'Writable ancestor accepted despite protected leaf ACL'}
$aclRights=4
Assert-Acl (Join-Path $Root 'base.vhdx')
$ownerOverride='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
Assert-Acl (Join-Path $Root 'base.vhdx')
$ownerOverride=$null;$badAclParent=Join-Path $Root 'base.vhdx';$aclRights=2
$denied=$false;try{Assert-Acl $badAclParent}catch{if($_.Exception.Message -eq 'UNSAFE_PRIVILEGED_ACL'){$denied=$true}else{throw}}
if(-not $denied){throw 'Unprivileged leaf write accepted'}
$badAclParent=$Root;$aclRights=64;$badOwner=$true
$denied=$false;try{Assert-Acl (Join-Path $Root 'base.vhdx')}catch{if($_.Exception.Message -eq 'UNSAFE_PRIVILEGED_OWNER'){$denied=$true}else{throw}}
if(-not $denied){throw 'Unprivileged ancestor owner accepted'}
function Assert-Acl {param($Target)}
function Remove-VM {param($VM,[switch]$Force) $script:fakeVm=$null}
function Remove-Item {param($LiteralPath,[switch]$Recurse,[switch]$Force)}
$parent=$null;$p | Add-Member -NotePropertyName operation -NotePropertyValue 'destroyOwned'
$p | Add-Member -NotePropertyName evidenceReceipt -NotePropertyValue ([pscustomobject]@{verified=$true;runId='fixture';environmentId='env'})
[void][IO.Directory]::CreateDirectory($r.vmDirectory)
$denied=$false;try{[void](Run-Operation $p)}catch{if($_.Exception.Message -eq 'REMOVE_UNKNOWN'){$denied=$true}else{throw}}
if(-not $denied){throw 'Cleanup succeeded with owned directory still present'}
$fakeVm=[pscustomobject]@{Name='owned';Notes='CetaMesh:nonce:fixture:env';Path=$r.vmDirectory;State='Off'}
$p.profile.limits | Add-Member -NotePropertyName maxEvidenceFiles -NotePropertyValue 8
$p.profile.limits | Add-Member -NotePropertyName maxEvidenceBytes -NotePropertyValue 1024
$p.profile | Add-Member -NotePropertyName guestCredentialFile -NotePropertyValue 'fixture.xml'
function Import-Clixml {param($LiteralPath) return New-Object Management.Automation.PSCredential('fixture',(New-Object Security.SecureString))}
function New-PSSession {param($VMId,$Credential) return [pscustomobject]@{Id='fixture'}}
function Remove-PSSession {param($Session)}
function Invoke-Command {param($Session,$ArgumentList,$ScriptBlock) return @([pscustomobject]@{path='report.json';bytes=0;sha256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'})}
$p.operation='capture'
[void](Run-Operation $p)
$exportPath=Join-Path $Root 'runs\fixture\exports'
if(Test-Path -LiteralPath $exportPath){throw 'Capture created export destination'}
$p.operation='copyOut'
[void](Run-Operation $p)
if(-not (Test-Path -LiteralPath $exportPath)){throw 'CopyOut did not create export destination'}
Write-Output 'Actual PowerShell ownership, CPU masking, cleanup and capture-copyOut fixtures PASS'
`;
  fs.writeFileSync(fixtureFile,fixture);
  const fixtures=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixtureFile,'-Root',root],{env:{...process.env,PSModulePath:path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')},encoding:'utf8'});
  assert.equal(fixtures.status,0,fixtures.stdout+fixtures.stderr);
  assert.equal(fixtures.stderr.trim(),'','Function fixtures must not silently ignore PowerShell errors');
  console.log(fixtures.stdout.trim());
  console.log('Real read-only preflight: '+JSON.stringify(preflight));
 }
 console.log('Hyper-V fixture ownership, persisted intent, replay, cancellation and prerequisites PASS (no VM executed)');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
