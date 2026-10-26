import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { validateBinding, validateProfile, sha256 } from './contracts.js';
import { assertOwnedPath, verifyFile } from './paths.js';
const scriptRoot=fileURLToPath(new URL('../../scripts/environment/',import.meta.url));
const fail=(code,message)=>Object.assign(new Error(message),{code});
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function createHyperVBackend({hostRoot,executePowerShell,now=Date.now}={}) {
 if(!hostRoot||!path.isAbsolute(hostRoot))throw fail('INVALID_HOST_ROOT','Absolute trusted host root required');
 const pins=new Map(['hyperv-host.ps1','guest-runner.ps1','guest-ui.ps1','guest-core.ps1'].filter(n=>fs.existsSync(path.join(scriptRoot,n))).map(n=>[n,digest(path.join(scriptRoot,n))]));
 const execute=executePowerShell||((operation,payload,{signal}={})=>new Promise((resolve,reject)=>{
  if(process.platform!=='win32')return resolve({status:'BLOCKED_ENV',reasons:['WINDOWS_REQUIRED']});
  if(signal?.aborted)return reject(fail('CANCELLED','Cancelled before process creation'));
  if(operation!=='preflight' && pins.size!==4)return reject(fail('SCRIPT_MISSING','All bundled guest scripts must exist at trusted host startup'));
  for(const [n,hash] of pins)if(digest(path.join(scriptRoot,n))!==hash)return reject(fail('SCRIPT_CHANGED','Pinned script changed; restart trusted host'));
  const launcher = "$ErrorActionPreference='Stop';$utf8=New-Object Text.UTF8Encoding($false);[Console]::InputEncoding=$utf8;[Console]::OutputEncoding=$utf8;$OutputEncoding=$utf8;$driver=$env:CETAMESH_DRIVER;$root=$env:CETAMESH_HOST_ROOT;$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);if($admin){$targets=@($root,(Split-Path -Parent $driver)) + @(Get-ChildItem -LiteralPath (Split-Path -Parent $driver) -Filter '*.ps1' | ForEach-Object {$_.FullName});foreach($target in $targets){$cursor=[IO.Path]::GetFullPath($target);$leaf=$true;while($cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UNSAFE_PRIVILEGED_REPARSE'};$acl=Get-Acl -LiteralPath $cursor;$owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value};if($owner -notin @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')){throw 'UNSAFE_PRIVILEGED_OWNER'};foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $(if($leaf){852310}else{852032})) -and $sid -notin @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')){throw 'UNSAFE_PRIVILEGED_ACL'}};$next=[IO.Path]::GetDirectoryName($cursor.TrimEnd('\\'));if($next -eq $cursor){break};$cursor=$next;$leaf=$false}}};if((Get-FileHash -LiteralPath $driver -Algorithm SHA256).Hash -ne $env:CETAMESH_DRIVER_HASH){throw 'SCRIPT_CHANGED'};& $driver";
  const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',launcher],{env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules'),CETAMESH_DRIVER:path.join(scriptRoot,'hyperv-host.ps1'),CETAMESH_HOST_ROOT:hostRoot,CETAMESH_DRIVER_HASH:pins.get('hyperv-host.ps1')},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',error='',cancelled=false,overflow=false;
  const abort=()=>{cancelled=true;child.kill();};
  const timer=setTimeout(abort,(['inspect','stop','preflight'].includes(operation)?30000:Math.min(payload.profile?.limits?.timeoutMs||30000,900000)));
  signal?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',b=>{if(output.length+b.length>2*1024*1024){overflow=true;abort();}else output+=b;});
  child.stderr.on('data',b=>{if(error.length<4096)error+=b;});
  child.on('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(cancelled)return reject(fail('EFFECTS_UNKNOWN',overflow?'Output limit exceeded; subprocess exited, VM state unknown':'Subprocess exited after cancellation; Hyper-V provider effects unknown'));try{const result=JSON.parse(output.trim().replace(/^\uFEFF/,''));if(result.error)reject(fail(result.error.code,result.error.message));else if(code!==0)reject(fail('HYPERV_FAILED','Fixed Hyper-V driver failed'));else resolve(result);}catch{reject(fail('HYPERV_INVALID_OUTPUT','Driver exited without a valid bounded JSON result'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...payload,operation,hostRoot,scriptRoot}));
 }));
 const check=(ctx,{allowExpired=false}={})=>{validateBinding(ctx.binding,{now:now(),allowExpired});validateProfile(ctx.profile);if(ctx.binding.profileId!==ctx.profile.id||ctx.binding.profileDigest!==sha256(ctx.profile)||sha256(ctx.binding.limits)!==sha256(ctx.profile.limits))throw fail('PROFILE_MISMATCH','Profile differs from authorized immutable digest');};
 const recordPath=ctx=>assertOwnedPath(hostRoot,`runs/${ctx.binding.runId}/ownership.json`);
 const owned=async ctx=>{
  check(ctx,{allowExpired:true});const saved=readJsonFile(recordPath(ctx));
  if(saved.state!=='created'||JSON.stringify(saved.resources)!==JSON.stringify(ctx.resources)||sha256(saved.binding)!==sha256(ctx.binding))throw fail('OWNERSHIP_MISMATCH','Creation receipt and binding required');
  assertOwnedPath(hostRoot,`runs/${ctx.binding.runId}/vm`,{mustExist:true,directory:true});
  const observed=await execute('inspect',{...ctx,hostRoot});if(observed.owned!==true)throw fail('OWNERSHIP_MISMATCH','Hyper-V identity or disk chain changed');return observed;
 };
 const invoke=async(op,ctx,options={})=>{if(options.signal?.aborted)throw fail('CANCELLED','Cancelled before operation');if(!['stop','inspect','destroyOwned'].includes(op))check(ctx);await owned(ctx);if(options.signal?.aborted)throw fail('CANCELLED','Cancelled during ownership inspection');try{return await execute(op,{...ctx,hostRoot},options);}catch(e){if(e.code==='EFFECTS_UNKNOWN'){try{const stopped=await execute('stop',{...ctx,hostRoot});e.vmStopConfirmed=stopped.state==='Off';}catch{e.vmStopConfirmed=false;}}throw e;}};
 return {
  preflight:ctx=>execute('preflight',{...ctx,hostRoot}),
  async prepare(ctx,options={}) {
   check(ctx);if(options.signal?.aborted)throw fail('CANCELLED','Cancelled before creation');
   const file=recordPath(ctx);if(fs.existsSync(file))throw fail('REPLAY','Run already has an intent; reconcile retained resources');
   const preflight=await execute('preflight',{...ctx,hostRoot},options);if(preflight.status!=='PASS')throw fail('BLOCKED_ENV',JSON.stringify(preflight.reasons));
   await verifyFile(ctx.profile.image.path,{sha256:ctx.profile.image.sha256,maxBytes:ctx.profile.limits.diskGiB*1024**3+64*1024**2});
   if(options.signal?.aborted)throw fail('CANCELLED','Cancelled during preflight');
   const vmDirectory=assertOwnedPath(hostRoot,`runs/${ctx.binding.runId}/vm`);
   const resources={vmId:null,vmName:`CetaMesh-${ctx.binding.environmentId}`,vmDirectory,diskPath:path.join(vmDirectory,'guest.vhdx'),ownerNonce:crypto.randomBytes(32).toString('hex'),runId:ctx.binding.runId,environmentId:ctx.binding.environmentId};
   writeJsonAtomic(file,{state:'intent',binding:ctx.binding,resources});
   try {const result=await execute('prepare',{...ctx,resources,hostRoot},options);if(options.signal?.aborted)throw fail('EFFECTS_UNKNOWN','Creation completed after cancellation; retained');if(!/^[0-9a-f-]{36}$/i.test(result.vmId)||Object.keys(resources).some(k=>k!=='vmId'&&result[k]!==resources[k]))throw fail('EFFECTS_UNKNOWN','Invalid creation receipt');fs.mkdirSync(vmDirectory,{recursive:true});writeJsonAtomic(file,{state:'created',binding:ctx.binding,resources:result});return result;}catch(e){writeJsonAtomic(file,{state:'quarantined',binding:ctx.binding,resources,reason:e.code||'CREATE_UNKNOWN'});throw e;}
  },
  start:(ctx,options)=>invoke('start',ctx,options),
  exec:(ctx,options)=>invoke('exec',ctx,options),
  async copyIn(ctx,options){if(!Array.isArray(ctx.files)||ctx.files.length>ctx.profile.limits.maxEvidenceFiles)throw fail('INVALID_FILES','Bounded file list required');let total=0;for(const f of ctx.files){const sourceRoot=ctx.profile.candidate?.root||hostRoot;assertOwnedPath(sourceRoot,path.relative(sourceRoot,f.source),{mustExist:true});assertOwnedPath(hostRoot,f.relativePath);if(!f.relativePath.startsWith('input/'))throw fail('INVALID_FILES','Only fixed guest input destinations allowed');await verifyFile(f.source,{sha256:f.sha256,bytes:f.bytes,maxBytes:ctx.profile.limits.diskGiB*1024**3});total+=f.bytes;}if(total>ctx.profile.limits.diskGiB*1024**3)throw fail('QUOTA','Input quota exceeded');return invoke('copyIn',ctx,options);},
  async copyOut(ctx,options){const result=await invoke('copyOut',ctx,options);if(result.runId!==ctx.binding.runId||result.environmentId!==ctx.binding.environmentId||!Array.isArray(result.files)||result.files.length>ctx.profile.limits.maxEvidenceFiles)throw fail('EVIDENCE_INVALID','Invalid export receipt');let total=0;const files=[];for(const f of result.files){const expected='runs/'+ctx.binding.runId+'/exports/'+f.path;if(f.relativePath!==expected)throw fail('EVIDENCE_INVALID','Export path differs');const source=assertOwnedPath(hostRoot,expected,{mustExist:true});await verifyFile(source,{...f,maxBytes:ctx.profile.limits.maxEvidenceBytes});total+=f.bytes;files.push({...f,source});}if(total>ctx.profile.limits.maxEvidenceBytes)throw fail('QUOTA','Evidence byte quota exceeded');return {...result,files};},
  capture:(ctx,options)=>invoke('capture',ctx,options),
  inspect:ctx=>owned(ctx),
  async stop(ctx,options){const result=await invoke('stop',ctx,options);if(result.state!=='Off')throw fail('EFFECTS_UNKNOWN','VM stop not confirmed');return result;},
  async destroyOwned(ctx,options){const receipt=ctx.evidenceReceipt;if(receipt?.verified!==true||receipt.runId!==ctx.binding?.runId||receipt.environmentId!==ctx.binding?.environmentId||!Array.isArray(receipt.files)||!receipt.files.length)throw fail('EVIDENCE_REQUIRED','Verified identity-bound evidence receipt required');for(const f of receipt.files)await verifyFile(assertOwnedPath(hostRoot,f.relativePath,{mustExist:true}),f);const state=await owned(ctx);if(state.state!=='Off')throw fail('VM_RUNNING','Stop must be confirmed before removal');const result=await invoke('destroyOwned',ctx,options);writeJsonAtomic(recordPath(ctx),{state:'destroyed',binding:ctx.binding,resources:ctx.resources});return result;}
 };
}
