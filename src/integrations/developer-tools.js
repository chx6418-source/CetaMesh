import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {capabilityError} from '../capability/types.js';
import {validateSchema} from '../model/input-schema.js';
import {redactText} from '../logging/redact.js';
import {validateFetchUrl} from '../safe-fetch.js';
import {FORGE_ACTIONS,FORGE_WRITE_ACTIONS,forgeInputSchema} from './forge-adapter.js';

const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const unavailable=()=>{throw capabilityError('PROVIDER_UNAVAILABLE','No real executor is configured for this developer tool');};
const operationRequired=request=>{
  if(!['owner','agent'].includes(request.actor?.kind)||!request.taskId||!request.workspaceId||typeof request.operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.operationId))throw capabilityError('FORGE_OPERATION_REQUIRED','A durable Task and Workspace operation identity is required for writes');
};
function boundedLog(value,maxBytes=16000){
  // Bound input before regex work. A truncated PEM still hides its full suffix.
  let text=String(value??'').slice(0,Math.min(262144,maxBytes*4));
  text=text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,'[REDACTED:privateKey]');
  text=redactText(text).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'[REDACTED]');
  const bytes=Buffer.from(text);if(bytes.length<=maxBytes)return text;
  return new TextDecoder('utf-8',{fatal:false}).decode(bytes.subarray(0,Math.max(0,maxBytes-3))).replace(/\uFFFD$/,'');
}

/** Register on the existing Broker. Filesystem, search, git and test.run keep
 * their existing executors and permission boundaries; this module never creates
 * a second broker or accepts arbitrary shell commands. Call only from trusted Core. */
export function registerDeveloperCapabilities({broker,forgeAdapters=[],terminalCommands=[],resolveWorkspace,openBrowser=null,readLogs=null}={}){
  if(!broker?.register||!broker?.registry||!Array.isArray(forgeAdapters)||!Array.isArray(terminalCommands))throw capabilityError('INVALID_PARAMS','Existing Broker and trusted tool configuration required');
  const registered=[];
  const add=entry=>{broker.register({...entry,category:'developer',catalogOwner:'developer-tools'});registered.push(entry.id);};
  registered.push(...registerForgeCapabilities({broker,forgeAdapters}).registered);
  const commandMap=new Map();
  for(const item of terminalCommands){
    if(!item||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id)||commandMap.has(item.id)||typeof item.file!=='string'||!path.isAbsolute(item.file)||!Array.isArray(item.args)||item.args.length>40||item.args.some(arg=>typeof arg!=='string'||arg.length>2048||arg.includes('\0'))
      ||/\.(?:cmd|bat)$/i.test(item.file)||/^(?:cmd|powershell|pwsh|bash|sh|wscript|cscript)(?:\.exe)?$/i.test(path.basename(item.file)))throw capabilityError('INVALID_PARAMS','Terminal commands require a fixed executable and fixed arguments, without a shell');
    commandMap.set(item.id,{file:item.file,args:[...item.args]});
  }
  const terminalInput=schema({command:{type:'string',minLength:1,maxLength:64}},['command']);
  const validateTerminal=request=>{
    validateSchema(terminalInput,request.input);operationRequired(request);
    if(!commandMap.has(request.input.command))throw capabilityError('DEVELOPER_COMMAND_DENIED','Command is not in the Owner configured allowlist');
    const root=resolveWorkspace?.(request.workspaceId)?.root;
    if(typeof root!=='string'||!path.isAbsolute(root)||!fs.statSync(root).isDirectory())throw capabilityError('WORKSPACE_NOT_FOUND','Authorized Workspace root is unavailable');
    return fs.realpathSync(root);
  };
  add({id:'developer.terminal.run',provider:'core',permission:'test.run',risk:'high',effect:'non-idempotent',descriptorVersion:'developer-terminal-v1',workspace:true,requiresTask:true,
    available:commandMap.size>0&&typeof resolveWorkspace==='function',description:'Run an Owner allowlisted executable with fixed arguments in the authorized Workspace.',inputSchema:terminalInput,validate:validateTerminal,
    execute:request=>new Promise((resolve,reject)=>{
      const cwd=validateTerminal(request),command=commandMap.get(request.input.command);
      const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','LANG'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
      execFile(command.file,command.args,{cwd,env,shell:false,windowsHide:true,timeout:30000,maxBuffer:65536,signal:request.signal},(error,stdout,stderr)=>{
        if(error&&(error.name==='AbortError'||error.killed||error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))return reject(capabilityError('DEVELOPER_PROCESS_INTERRUPTED','Allowlisted process interrupted; verify its effects before retrying'));
        if(error&&typeof error.code!=='number')return reject(capabilityError('DEVELOPER_PROCESS_FAILED','Allowlisted process could not complete'));
        resolve({command:request.input.command,exitCode:error?.code??0,stdout:boundedLog(stdout),stderr:boundedLog(stderr)});
      });
    }),retainOperationResult:result=>({command:result.command,exitCode:result.exitCode})});
  const browserInput=schema({url:{type:'string',minLength:1,maxLength:2048}},['url']);
  async function validateBrowser(request){
    validateSchema(browserInput,request.input);if(typeof openBrowser!=='function')unavailable();
    let parsed;try{parsed=await validateFetchUrl(request.input.url);}catch{throw capabilityError('DEVELOPER_URL_DENIED','Only public HTTP(S) browser destinations are allowed');}
    if(parsed.url.search||parsed.url.hash)throw capabilityError('DEVELOPER_URL_DENIED','Browser destinations must not contain query data or fragments');
    return parsed.url.href;
  }
  add({id:'developer.browser.open',provider:'core',permission:'network',risk:'high',effect:'non-idempotent',descriptorVersion:'developer-browser-v1',
    available:typeof openBrowser==='function',description:'Open a public URL through a real configured browser executor.',inputSchema:browserInput,
    validate:validateBrowser,execute:async request=>{
      const url=await validateBrowser(request),result=await openBrowser({url,signal:request.signal});
      if(!result||result.opened!==true||result.url!==url||typeof result.title!=='string'||typeof result.visibleText!=='string'
        ||result.screenshot?.mimeType!=='image/jpeg'||typeof result.screenshot.base64!=='string'||result.screenshot.base64.length>2*1024*1024
        ||!/^[A-Za-z0-9+/]+=*$/.test(result.screenshot.base64))throw capabilityError('DEVELOPER_BROWSER_RESULT_INVALID','Configured browser executor returned an invalid bounded capture');
      const bytes=Buffer.from(result.screenshot.base64,'base64');
      return {opened:true,url,title:boundedLog(result.title,240),visibleText:boundedLog(result.visibleText,16000),screenshot:{mimeType:'image/jpeg',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),quality:55},imageDelivery:'not-forwarded',
        blockedRequests:Number.isSafeInteger(result.blockedRequests)&&result.blockedRequests>=0?result.blockedRequests:0,isolation:'temporary-profile; page scripts disabled; same-origin requests; not an OS network sandbox'};
    }});
  const logsInput=schema({maxBytes:{type:'integer',minimum:1,maximum:16000}});
  add({id:'developer.logs.read',provider:'core',permission:'log',risk:'medium',effect:'read-only',available:typeof readLogs==='function',
    description:'Read a bounded, scrubbed log excerpt from the configured log reader.',inputSchema:logsInput,
    validate(request){validateSchema(logsInput,request.input);if(typeof readLogs!=='function')unavailable();},
    execute:async request=>{validateSchema(logsInput,request.input);if(typeof readLogs!=='function')unavailable();const maxBytes=request.input.maxBytes??8000;return {text:boundedLog(await readLogs({maxBytes,signal:request.signal}),maxBytes),maxBytes};}});
  return {registered,reused:['filesystem.read','filesystem.write','filesystem.search','git.status','git.diff','test.run'].filter(id=>broker.registry.has(id))};
}

/** Config changes atomically replace only this provider's descriptors. Pending
 * approvals bind the config hash and cannot survive a scope/credential change. */
export function registerForgeCapabilities({broker,forgeAdapters=[],replace=false}={}){
  const registered=[];
  for(const adapter of forgeAdapters){
    if(!['github','gitcode'].includes(adapter?.provider)||typeof adapter.validate!=='function'||typeof adapter.execute!=='function')throw capabilityError('INVALID_PARAMS','Trusted Forge adapter required');
    const entries=[];
    for(const action of FORGE_ACTIONS){
      const write=FORGE_WRITE_ACTIONS.includes(action),id=`forge.${adapter.provider}.${action}`;
      entries.push({id,catalogOwner:`forge-${adapter.provider}`,category:'developer',provider:adapter.provider,permission:'network',risk:write?'high':'medium',effect:write?'non-idempotent':'read-only',descriptorVersion:adapter.descriptorVersion??'forge-v1',
        available:adapter.available(action),workspace:write,requiresTask:write,description:`${adapter.provider}: ${action}; exact configured repository and action scope.`,inputSchema:forgeInputSchema(action),
        validate(request){adapter.validate(action,request.input);if(write)operationRequired(request);},
        execute:request=>adapter.execute(action,request.input,{signal:request.signal}),
        ...(write?{retainOperationResult:result=>structuredClone(result)}:{})});
    }
    if(replace)broker.registry.replaceProviderEntries(`forge-${adapter.provider}`,entries);
    else for(const entry of entries)broker.register(entry);
    registered.push(...entries.map(entry=>entry.id));
  }
  return {registered};
}
