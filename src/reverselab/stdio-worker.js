import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {terminateProcessTree,waitForChildClose} from '../extension/process-tree.js';
import {reverseLabError} from './engine-assets.js';

export function createReaWorker({assets,runRoot,signal,timeoutMs=120000}){
  signal?.throwIfAborted();
  const rawProtocolPath=path.join(runRoot,'mcp-stdout.jsonl');
  const fd=fs.openSync(rawProtocolPath,'wx',0o600);
  let child,rawBytes=0,diagnostic='',closed=false,closing=null,rawError=null;
  const ioFailure=new AbortController(),requestSignal=AbortSignal.any([ioFailure.signal,...(signal?[signal]:[])]);
  const raw=data=>{
    rawBytes+=data.length;
    try{
      if(rawBytes>64*1024*1024)throw reverseLabError('REVERSELAB_OUTPUT_LIMIT','MCP wire output exceeded the 64 MiB run budget.');
      fs.writeSync(fd,data);
    }catch(error){rawError=error.code==='REVERSELAB_OUTPUT_LIMIT'?error:reverseLabError('REVERSELAB_TRANSCRIPT_IO','Unable to retain original MCP output ('+String(error.code??'IO_ERROR')+').');
      ioFailure.abort(rawError);}
  };
  // The SDK merges its default environment before ours, including Windows user directories and PATH.
  const homeDrive=process.platform==='win32'?path.parse(runRoot).root.replace(/[\\/]$/,''):'';
  const transport=new StdioClientTransport({command:assets.nodePath,args:[assets.entryPath,'mcp'],cwd:runRoot,
    stderr:'pipe',env:{SYSTEMROOT:process.env.SystemRoot??'C:\\Windows',PATH:path.dirname(assets.nodePath),
      TEMP:runRoot,TMP:runRoot,HOME:runRoot,USERPROFILE:runRoot,
      APPDATA:path.join(runRoot,'config'),LOCALAPPDATA:path.join(runRoot,'cache'),HOMEDRIVE:homeDrive,HOMEPATH:runRoot.slice(homeDrive.length),
      XDG_CONFIG_HOME:path.join(runRoot,'config'),XDG_CACHE_HOME:path.join(runRoot,'cache'),
      XDG_STATE_HOME:path.join(runRoot,'state'),REA_MCP_INPUT_SCHEMA_PROFILE:'full',REA_LOG_LEVEL:'error'}});
  const start=transport.start.bind(transport);
  transport.start=async()=>{const pending=start();child=transport._process;child?.stdout.on('data',raw);await pending;};
  transport.stderr?.on('data',data=>{diagnostic=(diagnostic+data.toString()).slice(-32768);});
  const client=new Client({name:'CetaMesh-ReverseLab',version:'0.1.0'},{capabilities:{}});
  const worker={
    get pid(){return child?.pid??null;},rawProtocolPath,
    async initialize(){
      try{
        await client.connect(transport,{timeout:Math.min(timeoutMs,30000),signal:requestSignal});
        if(rawError)throw rawError;
        if(client.getServerVersion()?.version!==assets.version)throw reverseLabError('REVERSELAB_ENGINE_VERSION','REA handshake version differs from approved assets.');
        requestSignal.throwIfAborted();return worker;
      }catch(error){await worker.close();throw rawError??error;}
    },
    async listTools(cursor){const result=await client.listTools(cursor?{cursor}:{}, {signal:requestSignal,timeout:timeoutMs});if(rawError)throw rawError;return result;},
    async listPrompts(cursor){const result=await client.listPrompts(cursor?{cursor}:{}, {signal:requestSignal,timeout:timeoutMs});if(rawError)throw rawError;return result;},
    async getPrompt(name,args){const result=await client.getPrompt({name,arguments:args},{signal:requestSignal,timeout:timeoutMs});if(rawError)throw rawError;return result;},
    async callTool(name,input){requestSignal.throwIfAborted();if(rawError)throw rawError;
      const result=await client.callTool({name,arguments:input},undefined,{signal:requestSignal,timeout:timeoutMs});if(rawError)throw rawError;return result;},
    close(){
      if(closed)return Promise.resolve();
      if(closing)return closing;
      closing=(async()=>{
        let failure;
        try{await client.close();}catch(error){failure=error;}
        if(child&&!await waitForChildClose(child,1000)){
          await terminateProcessTree(child);
          if(!await waitForChildClose(child,2000))throw reverseLabError('REVERSELAB_STOP_UNCONFIRMED','REA process exit is not confirmed; retained for cleanup retry.');
        }
        child?.stdout.removeListener('data',raw);
        try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);closed=true;}
        fs.writeFileSync(path.join(runRoot,'engine-stderr.txt'),diagnostic,{flag:'wx',mode:0o600});
        if(rawError)throw rawError;
        if(failure&&child?.exitCode===null)throw failure;
      })().finally(()=>{closing=null;});
      return closing;
    }
  };
  return worker;
}
