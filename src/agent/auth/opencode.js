import {createNativeAcpProfile} from '../native-acp-runtime.js';
import {OPENCODE_LOGIN_SELECTIONS} from '../runtime-service-presets.js';
import {describeRuntimeAuth} from '../runtime-auth-capabilities.js';
import {createAuthTransport,authCommand,assertAuthLaunch} from './transport.js';
import {agentProviderError as fault} from '../agent-provider.js';
export function openCodeAuthStatus(value,providerId) {
 if(!Array.isArray(value)||value.length>64)return {state:'no-session'};
 const rows=value.filter(row=>row?.id===providerId);
 if(rows.length!==1||!Array.isArray(rows[0].connections))return {state:'no-session'};
 const connections=rows[0].connections;
 // No active-account field exists. Multiple credentials or env-only evidence
 // cannot identify the session created by this isolated generation's flow.
 if(connections.length!==1)return {state:'no-session'};
 const connection=connections[0];
 return {state:connection?.type==='credential'&&connection.method==='oauth'&&typeof connection.id==='string'&&connection.id.length<=256&&connection.status===undefined?'session-present':'no-session'};
}
export function createOpenCodeAuthAdapter({configuration,runtime,transport=createAuthTransport()}={}) {
 function profile(owned,initialize=false) {
  const config=configuration.get('opencode');
  if(config.authMode!=='provider-login'||!OPENCODE_LOGIN_SELECTIONS.some(p=>p.providerId===config.providerId&&p.methodId===config.methodId))throw fault('AGENT_AUTH_UNSUPPORTED','Select a source-verified native login method');
  const privateProfile=createNativeAcpProfile({id:'opencode',configuration:config,ownedRoot:owned.root,initialize});
  return {...privateProfile,validate(){owned.validate();privateProfile.validate();}};
 }
 async function verified(ownership){const evidence=await runtime(ownership);if(evidence?.version!=='opencode v2.1.4'||!evidence.target)throw fault('AGENT_AUTH_UNSUPPORTED','OpenCode 2.1.4 native authentication contract required');return evidence;}
 return Object.freeze({taskProfile:owned=>profile(owned),describe:()=>describeRuntimeAuth({provider:'opencode'}),
  async start({profile:owned,methodId,onHandle,onEvent,signal,assertCurrent}) {
   const config=configuration.get('opencode');
   if(methodId!==config.methodId||!OPENCODE_LOGIN_SELECTIONS.some(p=>p.providerId===config.providerId&&p.methodId===methodId))throw fault('AGENT_AUTH_UNSUPPORTED','Unsupported OpenCode login method');
   const evidence=await verified({signal,assertCurrent,onHandle}),privateProfile=profile(owned,true);
   const command=await authCommand(evidence,privateProfile,['auth','login',config.providerId,'--method',methodId,'--standalone']);assertAuthLaunch({signal,assertCurrent});
   const handle=transport.start(command,{onHandle,signal,assertCurrent});
   onEvent?.({state:'awaiting-user'});return handle;
  },
  async inspect({profile:owned,signal,assertCurrent,onHandle}) {
   if(!owned)return {state:'no-session'};
   const evidence=await verified({signal,assertCurrent,onHandle}),privateProfile=profile(owned),command=await authCommand(evidence,privateProfile,['auth','list','--standalone','--format','json']);assertAuthLaunch({signal,assertCurrent});
   const result=await transport.run(command,{signal,assertCurrent,onHandle});
   privateProfile.validate();if(result.exitCode!==0)return {state:'no-session'};
   try{return openCodeAuthStatus(JSON.parse(result.stdout),configuration.get('opencode').providerId);}catch{return {state:'no-session'};}
  }
 });
}
