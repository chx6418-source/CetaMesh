import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {terminateProcessTree,waitForChildClose} from '../extension/process-tree.js';
import {capabilityError} from '../capability/types.js';

export function signAgentOsGrant(claims,key){
  const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body+'.'+crypto.createHmac('sha256',key).update(body).digest('base64url');
}
// Fixed managed entry only: never the unmanaged MCP root opt-in or a model command.
export function createAgentOsHost({root,nodePath,home,sessionKey}){
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const systemRoot=process.env.SystemRoot??'C:\\Windows';
  const child=spawn(nodePath,[path.join(root,'server','managed','stdio.mjs')],{
    cwd:home,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:systemRoot,
      PATH:process.platform==='win32'?[path.dirname(nodePath),path.join(systemRoot,'System32'),
        path.join(process.env.ProgramFiles??'C:\\Program Files','Docker','Docker','resources','bin'),
        path.join(process.env.ProgramFiles??'C:\\Program Files','qemu')].join(';'):'/usr/bin:/bin',
      TEMP:home,TMP:home,HOME:home,USERPROFILE:home,
      AGENTOS_HOME:path.join(path.dirname(home),'unmanaged-disabled'),
      CETAMESH_AGENTOS_MANAGED_HOME:home,CETAMESH_AGENTOS_SESSION_KEY:sessionKey}});
  let next=0,buffer=Buffer.alloc(0),closed=false,closing=null;
  const pending=new Map();
  const failAll=code=>{for(const job of pending.values())job.finish(capabilityError(code,'AgentOS managed transport unavailable; verify outstanding operations.'));};
  child.stderr.on('data',()=>{}); // Do not forward host paths or private backend diagnostics to Agents.
  child.on('error',()=>failAll('AGENTOS_HOST_UNAVAILABLE'));
  child.on('close',()=>{closed=true;failAll('AGENTOS_HOST_DISCONNECTED');});
  child.stdin.on('error',()=>{failAll('AGENTOS_HOST_DISCONNECTED');stopAfterFailure();});
  child.stdout.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>1024*1024){failAll('AGENTOS_FRAME_LIMIT');stopAfterFailure();return;}
    let index;
    while((index=buffer.indexOf(10))>=0){
      const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);
      try{const frame=JSON.parse(line.toString('utf8'));
        if(frame.jsonrpc!=='2.0'||!pending.has(frame.id))throw Error('Unexpected response');
        const job=pending.get(frame.id);
        if(frame.error)job.finish(capabilityError('AGENTOS_PROTOCOL_ERROR','Managed host refused the protocol request.'));
        else job.finish(null,frame.result);
      }catch{failAll('AGENTOS_PROTOCOL_ERROR');stopAfterFailure();return;}
    }
  });
  function call(method,params,timeoutMs=30000,signal){
    return new Promise((resolve,reject)=>{
      if(closed||closing||signal?.aborted)return reject(capabilityError('AGENTOS_HOST_UNAVAILABLE','Managed host is not available.'));
      const id=++next,frame=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      if(frame.length>256*1024)return reject(capabilityError('AGENTOS_FRAME_LIMIT','Managed request exceeds its wire limit.'));
      let timer;
      const finish=(error,result)=>{if(!pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>{finish(capabilityError('AGENTOS_OUTCOME_UNKNOWN','Cancellation does not prove the Guest operation stopped.'));stopAfterFailure();};
      pending.set(id,{finish});
      timer=setTimeout(()=>{finish(capabilityError('AGENTOS_OUTCOME_UNKNOWN','Guest operation timed out; do not replay.'));stopAfterFailure();},timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdin.write(frame,error=>{if(error)finish(capabilityError('AGENTOS_HOST_DISCONNECTED','Managed request delivery failed.'));});
    });
  }
  // Retain the rejected close promise for explicit shutdown/recovery; never create an unhandled rejection.
  function stopAfterFailure(){void close().catch(()=>{});}
  function close(){
    if(closing)return closing;
    closing=(async()=>{
      child.stdin.end();
      if(!await waitForChildClose(child,1000)){await terminateProcessTree(child);
        if(!await waitForChildClose(child,2000))throw capabilityError('AGENTOS_STOP_UNCONFIRMED','Managed host exit is unconfirmed.');}
      closed=true;failAll('AGENTOS_HOST_DISCONNECTED');
    })();return closing;
  }
  return {get pid(){return child.pid;},get stopped(){return closed;},hello:()=>call('managed/hello',{}),
    request:(request,{signal,timeoutMs=60000}={})=>call('managed/request',request,timeoutMs,signal),close};
}
