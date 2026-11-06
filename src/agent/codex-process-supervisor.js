import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isSea} from 'node:sea';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';

const SCHEMA='CETAMESH_AGENT_SUPERVISOR_V1';
let hostBootObservation;

/** Read only kernel startup metadata, never infer shutdown from a missing PID.
 * Sleep/hibernate retain the kernel boot; unsupported or inconsistent probes fail
 * closed. A Core cannot survive a real reboot, so a successful observation is
 * stable for this process lifetime. Machine identity is hashed before stdout.
 */
export function probeCodexHostBoot() {
  if (hostBootObservation) return hostBootObservation;
  if (process.platform !== 'win32' || !path.win32.isAbsolute(process.env.SystemRoot ?? '')) return null;
  const command = "$ErrorActionPreference='Stop';"
    + "$os=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime;"
    + "$event=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12} -MaxEvents 1;"
    + "[xml]$xml=$event.ToXml();$data=@{};foreach($item in $xml.Event.EventData.Data){$data[$item.Name]=$item.InnerText};"
    + "$start=[DateTimeOffset]::Parse($data['StartTime']);"
    + "if($start.UtcDateTime.Ticks -ne $os.LastBootUpTime.ToUniversalTime().Ticks -or $data['BootMode'] -ne '0'){exit 2};"
    + "$kind=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Boot';Id=27} -MaxEvents 1;"
    + "[xml]$kindXml=$kind.ToXml();$bootType=($kindXml.Event.EventData.Data|Where-Object {$_.Name -eq 'BootType'}).InnerText;"
    + "if($bootType -ne '0' -or [Math]::Abs(($kind.TimeCreated.ToUniversalTime()-$start.UtcDateTime).TotalSeconds) -gt 120){exit 4};"
    + "$machine=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid;"
    + "if([string]::IsNullOrWhiteSpace($machine)){exit 3};"
    + "$sha=[Security.Cryptography.SHA256]::Create();"
    + "$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($machine)))).Replace('-','').ToLowerInvariant();"
    + "@{kind='windows-kernel-boot-v1';hostId=$hash;bootedAt=$start.ToUnixTimeMilliseconds();eventRecordId=$event.RecordId;bootMode=0;bootType=0}|ConvertTo-Json -Compress";
  try {
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, timeout: 8000, maxBuffer: 8192,
        // PowerShell 7's inherited module path can break Windows PowerShell
        // autoloading. User module overrides are not trusted OS evidence.
        env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } });
    if (result.error || result.status !== 0) return null;
    const value = JSON.parse(result.stdout);
    const estimatedBoot = Date.now() - os.uptime() * 1000;
    if (value.kind !== 'windows-kernel-boot-v1' || !/^[a-f0-9]{64}$/.test(value.hostId)
      || !Number.isSafeInteger(value.bootedAt) || value.bootedAt <= 0
      || !Number.isSafeInteger(value.eventRecordId) || value.eventRecordId <= 0 || value.bootMode !== 0 || value.bootType !== 0
      || Math.abs(value.bootedAt - estimatedBoot) > 120_000) return null;
    hostBootObservation = Object.freeze(value);
    return hostBootObservation;
  } catch { return null; }
}
function unavailable(){return Object.assign(new Error('A compatible owned-process supervisor is required'),{code:'AGENT_SUPERVISOR_UNAVAILABLE'});}
function supervisorPath(override){
  const target=override??(isSea()?path.join(path.dirname(process.execPath),'WhaleBridge.exe')
    :path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../desktop-shell/target/debug/whalebridge-desktop.exe'));
  try {
    if(!path.isAbsolute(target))throw unavailable();
    const stat=fs.statSync(target);
    if(!stat.isFile()||stat.size>256*1024*1024||!fs.readFileSync(target).includes(Buffer.from(SCHEMA)))throw unavailable();
    return target;
  }catch{throw unavailable();}
}

/** Fixed native entrypoint; metadata and receipts stay outside the model's staging copy. */
export function prepareCodexOwnedLaunch({stateDir,supervisorExecutable,executable,args,cwd,sessionId}={}){
  const helper=supervisorPath(supervisorExecutable);
  if(!path.isAbsolute(stateDir??'')||!path.isAbsolute(executable??'')||!path.isAbsolute(cwd??'')
    ||!Array.isArray(args)||args.some(value=>typeof value!=='string'||value.includes('\0')))throw unavailable();
  const base=path.join(stateDir,'agent','codex-supervisor');
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  if(fs.readdirSync(base).length>=4096)throw Object.assign(new Error('Owned process evidence capacity reached'),{code:'AGENT_SESSION_LIMIT'});
  const nonce=crypto.randomBytes(32).toString('hex');
  const directory=path.join(base,nonce);fs.mkdirSync(directory,{mode:0o700});
  const binding=crypto.createHash('sha256').update(JSON.stringify([sessionId,executable,args,cwd,nonce])).digest('hex');
  const config={schema:SCHEMA,nonce,binding,executable,args,cwd};
  const raw=JSON.stringify(config);
  if(Buffer.byteLength(raw)>65536)throw unavailable();
  const configFile=path.join(directory,'launch.json');
  fs.writeFileSync(configFile,raw,{flag:'wx',mode:0o600});
  const receiptFile=path.join(directory,'receipt.json');
  function receipt(){
    try {
      const row=readJsonFile(receiptFile,{maxBytes:4096});
      return row?.schema===SCHEMA&&row.nonce===nonce&&row.binding===binding&&row.state==='job-empty'
        &&Number.isInteger(row.exitCode)&&row.exitCode>=0&&row.exitCode<=0xffffffff?row:null;
    }catch{return null;}
  }
  return {executable:helper,args:['--agent-supervisor='+configFile],receipt,
    async terminate(){
      writeJsonAtomic(path.join(directory,'control.json'),{schema:SCHEMA,nonce,action:'stop'});
      const deadline=Date.now()+4000;
      do {if(receipt())return true;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
      return false;
    }};
}
