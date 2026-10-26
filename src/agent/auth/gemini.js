import path from 'node:path';
import {createGeminiQwenProfile} from '../gemini-qwen-runtime.js';
import {describeRuntimeAuth} from '../runtime-auth-capabilities.js';
import {createJsonRpcTransport} from '../protocol/json-rpc-transport.js';
import {createAuthTransport,authCommand,assertAuthLaunch} from './transport.js';
import {agentProviderError as fault} from '../agent-provider.js';
export function geminiAuthProfile(owned,{initialize=true}={}) {
 const privateProfile=createGeminiQwenProfile({id:'gemini',ownedRoot:owned.root,initialize,configuration:{authMode:'provider-login'}});
 return {...privateProfile,authDirectory:path.join(owned.root,'.gemini'),validate(){owned.validate();privateProfile.validate();}};
}
export function createGeminiAuthAdapter({runtime,transport=createAuthTransport()}={}) {
 return Object.freeze({timeoutMs:300000,describe:()=>describeRuntimeAuth({provider:'gemini'}),
  async start({profile:owned,signal,onHandle,onEvent,assertCurrent}) {
   const evidence=await runtime({signal,assertCurrent,onHandle});
   if(evidence?.version!=='0.65.0'||!evidence.packageIdentity||!Array.isArray(evidence.argv))throw fault('AGENT_AUTH_UNSUPPORTED','Gemini 0.65.0 package and ACP contract required');
   const profile=geminiAuthProfile(owned);
   const command=await authCommand(evidence,profile,[...evidence.argv,...profile.argv]);assertAuthLaunch({signal,assertCurrent});
   const handle=transport.start(command,{onHandle,signal,assertCurrent});
   const rpc=createJsonRpcTransport({readable:handle.readable,writable:handle.writable,framing:'acp-v1-jsonl'});
   // ACP stdin is protocol-only. NO_BROWSER manual-code stdin is not supported.
   const work=(async()=>{
    try {
     const initialized=await rpc.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'CetaMesh',version:'1'}},{signal,timeoutMs:15000});
     if(initialized?.protocolVersion!==1||initialized.agentInfo?.name!=='gemini-cli'||initialized.agentInfo?.version!=='0.65.0'||!initialized.authMethods?.some(method=>method.id==='oauth-personal'))throw fault('AGENT_AUTH_UNSUPPORTED','Pinned Gemini authentication not advertised');
     onEvent?.({state:'awaiting-user'});
     await rpc.request('authenticate',{methodId:'oauth-personal'},{signal,timeoutMs:300000});
     profile.validate();
    } finally {await rpc.close();await handle.close();}
   })();
   // Process ownership is reported immediately; authentication failure is not
   // arbitrary provider output. The service still requires metadata evidence.
   work.catch(()=>{});return handle;
  },
  async inspect() {
   // Gemini 0.65.0 offers no documented offline status DTO. Do not read tokens,
   // call authenticate during refresh, or claim session presence from a file.
   return {state:'no-session',reason:'gemini_auth_status_unverified'};
  }
 });
}
