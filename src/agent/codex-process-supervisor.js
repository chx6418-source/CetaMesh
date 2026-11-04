import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isSea} from 'node:sea';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';

const SCHEMA='CETAMESH_AGENT_SUPERVISOR_V1';
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
