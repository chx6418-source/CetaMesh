import fs from 'node:fs';
import path from 'node:path';
import {writeJsonAtomic} from '../../storage/json-file.js';
import {claudeProfileEnvironment} from '../claude-runtime.js';
import {describeRuntimeAuth} from '../runtime-auth-capabilities.js';
import {createAuthTransport,authCommand,assertAuthLaunch} from './transport.js';
import {agentProviderError as fault} from '../agent-provider.js';
const POLICY={forceLoginMethod:'claudeai',disableAllHooks:true,hooks:{},enabledPlugins:{},extraKnownMarketplaces:{},enableAllProjectMcpServers:false};
export function claudeAuthProfile(owned,{initialize=false}={}) {
 owned.validate();for(const part of ['home','roaming','local','temp','config'])fs.mkdirSync(path.join(owned.root,part),{recursive:true,mode:0o700});
 const file=path.join(owned.root,'config','settings.json');if(initialize)writeJsonAtomic(file,POLICY);
 return {root:owned.root,environment:claudeProfileEnvironment(owned.root,{}),validate(){
  owned.validate();try {
   if(fs.lstatSync(file).isSymbolicLink()||fs.readFileSync(file,'utf8')!==JSON.stringify(POLICY,null,2)+'\n')throw Error('Changed policy');
   // Only the provider's known file-backed account records are mutable. Never
   // read their contents; every other file (including project policies) fails closed.
   const files=new Set(['.owned.json','config/settings.json','config/.credentials.json','config/.claude.json']);
   const dirs=new Set(['home','roaming','local','temp','config']);
   const visit=(dir,prefix='')=>{for(const name of fs.readdirSync(dir)){
    const relative=prefix+name,absolute=path.join(dir,name),stat=fs.lstatSync(absolute);
    if(stat.isDirectory()){if(!dirs.has(relative))throw Error('Unapproved directory');visit(absolute,relative+'/');}
    else if(!files.has(relative)||!stat.isFile()||stat.isSymbolicLink())throw Error('Unapproved file');
   }};visit(owned.root);
  }catch{throw fault('AGENT_RUNTIME_CHANGED','Claude private authentication policy changed');}
 }};
}
export function claudeAuthStatus(value,profile) {
 if(value?.loggedIn!==true||value.authMethod!=='claude.ai'||typeof value.configDirectory!=='string')return {state:'no-session'};
 try {
  const expected=fs.realpathSync(path.join(profile.root,'config'));
  if(fs.lstatSync(value.configDirectory).isSymbolicLink()||fs.realpathSync(value.configDirectory)!==expected)return {state:'no-session'};
  return {state:'session-present'};
 }catch{return {state:'no-session'};}
}
export function createClaudeAuthAdapter({runtime,transport=createAuthTransport()}={}) {
 async function verified(ownership){const evidence=await runtime(ownership);if(evidence?.version!=='2.1.308'||evidence.binaryVerified!==true||evidence.sdkResourcesVerified!==true)throw fault('AGENT_AUTH_UNSUPPORTED','Claude CLI 2.1.308 and SDK 0.3.308 authentication contract required');return evidence;}
 return Object.freeze({taskProfile:owned=>claudeAuthProfile(owned),describe:()=>describeRuntimeAuth({provider:'claude'}),
  async start({profile:owned,methodId='claude-subscription',onHandle,onEvent,signal,assertCurrent}) {
   if(methodId!=='claude-subscription')throw fault('AGENT_AUTH_UNSUPPORTED','Only isolated Claude subscription login is supported');
   const evidence=await verified({signal,assertCurrent,onHandle}),profile=claudeAuthProfile(owned,{initialize:true});
   const command=await authCommand(evidence,profile,['auth','login']);assertAuthLaunch({signal,assertCurrent});
   const handle=transport.start(command,{onHandle,signal,assertCurrent});onEvent?.({state:'awaiting-user'});return handle;
  },
  async inspect({profile:owned,signal,assertCurrent,onHandle}) {
   if(!owned)return {state:'no-session'};
   const evidence=await verified({signal,assertCurrent,onHandle}),profile=claudeAuthProfile(owned),command=await authCommand(evidence,profile,['auth','status']);assertAuthLaunch({signal,assertCurrent});
   const result=await transport.run(command,{signal,assertCurrent,onHandle});
   profile.validate();if(result.exitCode!==0)return {state:'no-session'};
   try{return claudeAuthStatus(JSON.parse(result.stdout),profile);}catch{return {state:'no-session'};}
  }
 });
}
