// Owner UI configuration adapter over the existing config.json primitive.
// Legacy configuration is evidence, never implicit connector authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseConfigText,atomicWriteConfig} from './loader.js';
import {redactText} from '../logging/redact.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const MISSING=hash('CetaMesh config.json missing');
const MAX_BYTES=1024*1024;
function safeParents(target){
  for(let current=path.resolve(target);;current=path.dirname(current)){
    try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())fail('ONEBOT_CONFIG_UNSAFE');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(current)===current)break;
  }
}
function endpoint(value,protocols){
  if(typeof value!=='string'||value.length>2000||/[\x00-\x20]/.test(value))fail('ONEBOT_CONFIG_INVALID');
  if(!value)return '';
  let url;try{url=new URL(value);}catch{fail('ONEBOT_CONFIG_INVALID');}
  if(!protocols.includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)fail('ONEBOT_CONFIG_INVALID');
  return url.href.replace(/\/$/,'');
}
const publicEndpoint=(value,protocols)=>{try{return endpoint(value??'',protocols);}catch{return '';}};

export function createOneBotConfiguration({configFile,stateDir,config={},health=async()=>({}),beforeChange=async()=>{}}={}){
  const file=path.resolve(configFile),backups=path.join(stateDir,'config-backups'),lock=path.join(stateDir,'onebot-config.lock');
  function snapshot(){
    safeParents(path.dirname(file));let fd;
    try{
      const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)fail('ONEBOT_CONFIG_UNSAFE');
      if(stat.size>MAX_BYTES)fail('ONEBOT_CONFIG_UNAVAILABLE');
      fd=fs.openSync(file,'r');const opened=fs.fstatSync(fd);
      if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.nlink!==1||opened.size>MAX_BYTES)fail('ONEBOT_CONFIG_UNSAFE');
      const bytes=Buffer.alloc(opened.size+1);let count=0,got;
      while(count<bytes.length&&(got=fs.readSync(fd,bytes,count,bytes.length-count,null))>0)count+=got;
      if(count!==opened.size)fail('ONEBOT_CONFIG_CONFLICT');
      const content=bytes.subarray(0,count),raw=parseConfigText(content.toString('utf8'));
      return {raw,bytes:content,sourceHash:hash(content)};
    }catch(error){
      if(error.code==='ENOENT')return {raw:{},bytes:null,sourceHash:MISSING};
      if(String(error.code).startsWith('ONEBOT_'))throw error;
      fail('ONEBOT_CONFIG_UNAVAILABLE');
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function describe(s){const value=object(s.raw.onebot)?s.raw.onebot:{};return {
    enabled:value.enabled===true,httpUrl:publicEndpoint(value.httpUrl,['http:','https:']),wsUrl:publicEndpoint(value.wsUrl,['ws:','wss:']),
    accessTokenConfigured:typeof value.accessToken==='string'&&value.accessToken.length>0,
    httpAccessTokenConfigured:typeof value.httpAccessToken==='string'&&value.httpAccessToken.length>0,
    sourceHash:s.sourceHash,legacyPresent:object(s.raw.snowluma)
  };}
  async function get(){
    const s=snapshot();let raw;
    try{raw=await health();}catch(error){raw={state:'unavailable',ready:false,connected:false,authenticated:false,error};}
    const secrets=[s.raw.onebot?.accessToken,s.raw.onebot?.httpAccessToken,s.raw.snowluma?.accessToken,s.raw.snowluma?.httpAccessToken].filter(v=>typeof v==='string'&&v);
    const safe=value=>{let text=String(value??'');for(const secret of secrets)text=text.replaceAll(secret,'[REDACTED]');return redactText(text).slice(0,300);};
    const projected={};
    for(const field of ['installed','configured','connected','authenticated','ready','running','canSend'])projected[field]=typeof raw?.[field]==='boolean'?raw[field]:null;
    projected.state=/^[a-z-]{1,40}$/.test(raw?.state??'')?raw.state:'unavailable';
    projected.accountId=/^\d{1,20}$/.test(String(raw?.accountId??''))?String(raw.accountId):null;
    const error=raw?.error??raw?.lastError;
    if(error)projected.error={code:/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'ONEBOT_CONNECTION_FAILED',message:safe(typeof error==='string'?error:error.message)};
    return {configuration:describe(s),health:projected};
  }
  function checkParams(input,allowed){if(!object(input)||Object.keys(input).some(key=>!allowed.includes(key)))fail('ONEBOT_CONFIG_INVALID');}
  function cas(s,expected){if(typeof expected!=='string'||expected!==s.sourceHash)fail('ONEBOT_CONFIG_CONFLICT');}
  // Core's existing state-owner lease excludes a second live Core. This local
  // lock also serializes Owner requests; only a verifiably dead PID is recovered.
  function readLock(){
    let fd;try{
      const stat=fs.lstatSync(lock);
      if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.size>4096)fail('ONEBOT_CONFIG_BUSY');
      fd=fs.openSync(lock,'r');const opened=fs.fstatSync(fd);
      if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.nlink!==1||opened.size!==stat.size)fail('ONEBOT_CONFIG_BUSY');
      const buffer=Buffer.alloc(4097);const count=fs.readSync(fd,buffer,0,buffer.length,0);
      if(count!==stat.size)fail('ONEBOT_CONFIG_BUSY');const bytes=buffer.subarray(0,count);
      const value=JSON.parse(bytes.toString('utf8'));
      if(value.version!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||!/^[a-f0-9-]{36}$/.test(value.nonce??''))fail('ONEBOT_CONFIG_BUSY');
      return {bytes,value,ino:opened.ino,dev:opened.dev};
    }catch{fail('ONEBOT_CONFIG_BUSY');}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function takeLock(){
    const nonce=crypto.randomUUID();let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')fail('ONEBOT_CONFIG_BUSY');
      const stale=readLock();let dead=false;
      try{process.kill(stale.value.pid,0);}catch(error){dead=error.code==='ESRCH';}
      if(!dead)fail('ONEBOT_CONFIG_BUSY');
      safeParents(backups);fs.mkdirSync(backups,{recursive:true});
      if(fs.readdirSync(backups).length>=50)fail('ONEBOT_BACKUP_LIMIT');
      const latest=readLock();
      if(latest.ino!==stale.ino||latest.dev!==stale.dev||!latest.bytes.equals(stale.bytes))fail('ONEBOT_CONFIG_BUSY');
      // Preserve the orphan as evidence. Never age out an alive/unverifiable lock.
      fs.renameSync(lock,path.join(backups,'onebot-orphan-lock-'+crypto.randomUUID()+'.json'));
      try{fd=fs.openSync(lock,'wx',0o600);}catch{fail('ONEBOT_CONFIG_BUSY');}
    }
    try{fs.writeFileSync(fd,JSON.stringify({version:1,pid:process.pid,nonce}));fs.fsyncSync(fd);}
    catch(error){fs.closeSync(fd);throw error;}
    return {fd,nonce};
  }
  async function mutate(expected,make){
    safeParents(stateDir);fs.mkdirSync(stateDir,{recursive:true});const owned=takeLock();
    try{
      const s=snapshot();cas(s,expected);const change=make(s);
      const stopped=await beforeChange();
      if(stopped?.stopped===false||stopped?.ok===false)fail('ONEBOT_CONNECTOR_BUSY');
      cas(snapshot(),expected);
      let backup;
      if(s.bytes){
        safeParents(backups);fs.mkdirSync(backups,{recursive:true});
        const id='onebot-config-'+s.sourceHash+'.json',target=path.join(backups,id);
        if(fs.existsSync(target)){
          const st=fs.lstatSync(target);if(st.isSymbolicLink()||!st.isFile()||st.nlink!==1||st.size!==s.bytes.length||hash(fs.readFileSync(target))!==s.sourceHash)fail('ONEBOT_CONFIG_UNSAFE');
        }else{
          const names=fs.readdirSync(backups);if(names.length>=50)fail('ONEBOT_BACKUP_LIMIT');
          const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,s.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        }
        backup={id,sha256:s.sourceHash};
      }
      atomicWriteConfig(file,{...s.raw,onebot:change});
      config.onebot={...change};
      return {...await get(),...(backup?{backup}:{})};
    }finally{
      fs.closeSync(owned.fd);
      // A replaced/unverifiable lock belongs to another recovery attempt. Leave it intact.
      if(fs.existsSync(lock)&&readLock().value.nonce===owned.nonce)fs.unlinkSync(lock);
    }
  }
  return {
    get,
    async preview(){const s=snapshot(),old=object(s.raw.snowluma)?s.raw.snowluma:{};return {
      legacyPresent:object(s.raw.snowluma),sourceHash:s.sourceHash,
      candidate:{httpUrl:publicEndpoint(old.httpUrl,['http:','https:']),wsUrl:publicEndpoint(old.wsUrl,['ws:','wss:'])},
      legacyTokenPresent:!!(old.accessToken||old.httpAccessToken),hasCurrentConfig:object(s.raw.onebot)&&Object.keys(s.raw.onebot).length>0,requiresTokenEntry:true
    };},
    async configure(input){
      checkParams(input,['expectedSourceHash','enabled','httpUrl','wsUrl','accessToken','httpAccessToken','clearAccessToken','clearHttpAccessToken']);
      if(typeof input.enabled!=='boolean')fail('ONEBOT_CONFIG_INVALID');
      const httpUrl=endpoint(input.httpUrl??'',['http:','https:']),wsUrl=endpoint(input.wsUrl??'',['ws:','wss:']);
      if(input.enabled&&(!httpUrl||!wsUrl))fail('ONEBOT_CONFIG_INVALID');
      for(const key of ['clearAccessToken','clearHttpAccessToken'])if(input[key]!==undefined&&typeof input[key]!=='boolean')fail('ONEBOT_CONFIG_INVALID');
      for(const key of ['accessToken','httpAccessToken'])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>512||/[\x00-\x1f]/.test(input[key])))fail('ONEBOT_CONFIG_INVALID');
      return mutate(input.expectedSourceHash,s=>{
        const previous=object(s.raw.onebot)?s.raw.onebot:{};
        const token=(key,clear,urlChanged)=>input[clear]===true?'':input[key]?input[key]:urlChanged?'':typeof previous[key]==='string'?previous[key]:'';
        return {enabled:input.enabled,httpUrl,wsUrl,
          accessToken:token('accessToken','clearAccessToken',wsUrl!==previous.wsUrl),
          httpAccessToken:token('httpAccessToken','clearHttpAccessToken',httpUrl!==previous.httpUrl)};
      });
    },
    async migrate(input){
      checkParams(input,['confirm','expectedSourceHash']);if(input.confirm!==true)fail('ONEBOT_MIGRATION_CONFIRM_REQUIRED');
      return mutate(input.expectedSourceHash,s=>{
        if(object(s.raw.onebot)&&Object.keys(s.raw.onebot).length)fail('ONEBOT_ALREADY_CONFIGURED');
        if(!object(s.raw.snowluma))fail('ONEBOT_LEGACY_CONFIG_MISSING');
        return {enabled:false,httpUrl:publicEndpoint(s.raw.snowluma.httpUrl,['http:','https:']),wsUrl:publicEndpoint(s.raw.snowluma.wsUrl,['ws:','wss:']),accessToken:'',httpAccessToken:''};
      });
    }
  };
}
