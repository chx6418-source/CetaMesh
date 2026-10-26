import {createAcpProcessLauncher} from '../acp-provider-descriptors.js';
import {agentProviderError as fault} from '../agent-provider.js';
// Internal-only fixed-command transport. Neither options nor stdout are an IPC DTO.
export function createAuthTransport({launchFactory=createAcpProcessLauncher}={}) {
 function start(spec,{onHandle,signal,assertCurrent}={}) {
  assertAuthLaunch({signal,assertCurrent});
  const launch=launchFactory({executable:spec.executable,argv:spec.argv,envSource:Object.fromEntries(['PATH','PATHEXT','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','LANG','LC_ALL','TZ'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),trustedEnvironment:spec.environment});
  return launch({cwd:spec.root,onHandle});
 }
 return Object.freeze({start,async run(spec,ownership={}) {
  const handle=start(spec,ownership);let bytes=0,overflow=false,output=[],timer;
  const receive=chunk=>{bytes+=chunk.length;if(bytes>65536)overflow=true;else output.push(Buffer.from(chunk));};
  handle.readable.on('data',receive);
  try {
   const result=await Promise.race([handle.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('AGENT_AUTH_STATUS_FAILED','Authentication status timed out')),15000);})]);
   if(overflow||result.startFailed||result.exitCode!==0)throw fault('AGENT_AUTH_STATUS_FAILED','Authentication status is unavailable');
   return {exitCode:0,stdout:Buffer.concat(output).toString('utf8')};
  } finally {clearTimeout(timer);handle.readable.off('data',receive);output=[];await handle.close();}
 }});
}
export async function authCommand(runtime,profile,argv) {
 await runtime.validate?.();profile.validate();
 return {executable:runtime.target?.executable ?? runtime.runtimePath,argv:[...(runtime.target?.argsPrefix??[]),...argv],root:profile.root,environment:profile.environment};
}

export function assertAuthLaunch({signal,assertCurrent}={}) {
 if(signal?.aborted)throw fault('AGENT_AUTH_CANCELLED','Authentication was cancelled before launch');
 assertCurrent?.();
}
