import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProcess } from './cli-agent-process.js';
import { createJsonRpcTransport } from './protocol/json-rpc-transport.js';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { agentProviderError as fault } from './agent-provider.js';
import { createGeminiQwenProfile, geminiQwenPackageIdentity, knownGeminiQwenRuntime, GEMINI_QWEN_POLICY_VERSION, GEMINI_QWEN_SNAPSHOT_EXCLUDED_PATHS } from './gemini-qwen-runtime.js';

// OpenCode 2 uses a different configuration schema from 1.x. These fields and
// the ACP private-server lifecycle are documented at opencode.ai/v2/docs/{config,
// permissions,policies,providers,agents,plugins} and /v2/docs/cli/acp.
const POLICY_VERSION = 'opencode-2.1.4-cetamesh-ask-v1';
const allAsk = () => [{ action: '*', resource: '*', effect: 'ask' }];
export const ACP_SNAPSHOT_EXCLUDED_PATHS = Object.freeze(['opencode.json','opencode.jsonc','.opencode','.agents','.claude','AGENTS.md']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function bytesIdentity(file) {
  const canonical = fs.realpathSync(file), fd = fs.openSync(canonical,'r');
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile() || before.size > 512*1024*1024) throw fault('ACP_RUNTIME_INVALID','Agent runtime must be a bounded regular file');
    const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
    let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));
    const after=fs.fstatSync(fd);
    if(before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) throw fault('AGENT_RUNTIME_CHANGED','Agent binary changed while being checked');
    return {path:canonical,sha256:hash.digest('hex')};
  } finally {fs.closeSync(fd);}
}

export function openCodeNativePolicy({ model, baseUrl, allowLoopbackHttpForTests=false } = {}) {
  if (typeof model !== 'string' || !model || /[\x00-\x1f{}]/.test(model) || model.length > 256) throw fault('AGENT_MODEL_REQUIRED','Configure an OpenCode model');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw fault('AGENT_ENDPOINT_INVALID','Configure an Agent API endpoint'); }
  if ((endpoint.protocol!=='https:' && !(allowLoopbackHttpForTests && endpoint.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || /[{}]/.test(baseUrl)) throw fault('AGENT_ENDPOINT_INVALID','Invalid Agent API endpoint');
  return {
    model:'cetamesh/'+model,default_agent:'cetamesh',update:'disable',snapshots:false,formatter:false,
    warming:false,permissions:allAsk(),
    agents:{cetamesh:{mode:'primary',description:'CetaMesh task agent',permissions:allAsk()},
      build:{disabled:true},plan:{disabled:true},general:{disabled:true},explore:{disabled:true}},
    plugins:[],mcp:{servers:{}},skills:[],commands:{},instructions:[],references:{},
    policies:[{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'cetamesh',effect:'allow'},
      {action:'integration.use',resource:'plugin:*',effect:'deny'},{action:'integration.use',resource:'mcp:*',effect:'deny'},{action:'integration.use',resource:'skill:*',effect:'deny'},
      {action:'tool.use',resource:'execute:*',effect:'deny'},{action:'tool.use',resource:'subagent:*',effect:'deny'},{action:'tool.use',resource:'skill:*',effect:'deny'}],
    providers:{cetamesh:{name:'CetaMesh configured endpoint',package:'@opencode/ai/providers/openai-compatible',
      env:['CETAMESH_AGENT_API_KEY'],settings:{baseURL:baseUrl,apiKey:'{env:CETAMESH_AGENT_API_KEY}'},
      models:{[model]:{name:model,limit:{context:32768,output:4096}}}}}
  };
}

/** A private disposable profile. Its files contain policy and a secret reference only. */
export function createNativeAcpProfile({id,configuration,profileParent=os.tmpdir(),allowLoopbackHttpForTests=false} = {}) {
  if(id==='gemini' || id==='qwen') return createGeminiQwenProfile({id,configuration,profileParent,allowLoopbackHttpForTests});
  const selectedPolicy=id==='opencode' ? openCodeNativePolicy({model:configuration.model || 'health-probe',baseUrl:configuration.baseUrl,allowLoopbackHttpForTests}) : null;
  const root = fs.mkdtempSync(path.join(profileParent,'cetamesh-'+id+'-'));
  const environment={HOME:root,USERPROFILE:root,APPDATA:path.join(root,'app'),LOCALAPPDATA:path.join(root,'local'),
    PROGRAMDATA:path.join(root,'system'),HOMEDRIVE:path.parse(root).root.slice(0,2),HOMEPATH:root.slice(2),
    TEMP:path.join(root,'tmp'),TMP:path.join(root,'tmp'),TMPDIR:path.join(root,'tmp'),
    XDG_CONFIG_HOME:path.join(root,'.config'),XDG_DATA_HOME:path.join(root,'.local','share'),
    XDG_STATE_HOME:path.join(root,'.local','state'),XDG_CACHE_HOME:path.join(root,'.cache')};
  for(const directory of [environment.APPDATA,environment.LOCALAPPDATA,environment.PROGRAMDATA,environment.TEMP]) fs.mkdirSync(directory,{recursive:true});
  let policy=null,files=[];
  if(id==='opencode') {
    policy=selectedPolicy;
    // System configuration has highest file precedence. Global mirrors it for
    // supported layouts; project config and integrations are independently excluded.
    files=[path.join(root,'.config','opencode','opencode.json'),path.join(root,'system','opencode','opencode.json')];
    for(const file of files) writeJsonAtomic(file,policy);
    Object.assign(environment,{OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_PURE:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',
      OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_LOG_LEVEL:'error'});
  }
  const identity=digest(JSON.stringify({policyVersion:POLICY_VERSION,policy}));
  return {root,environment,identity,validate(){
    try {
      for(const file of files) if(digest(JSON.stringify(readJsonFile(file,{maxBytes:1048576})))!==digest(JSON.stringify(policy))
        || fs.readdirSync(path.dirname(file)).some(name=>name!==path.basename(file))) throw new Error('Policy content changed');
    } catch {
      // Missing, malformed, replaced and additional policy files all invalidate authority.
      throw fault('AGENT_RUNTIME_CHANGED','Native runtime policy changed; close the session and check the connection again');
    }
  },async cleanup(){await fs.promises.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}};
}
/** Match only a flag actually advertised by the installed requested CLI. */
export function acpArgumentsFromHelp(id,help) {
  // OpenCode2 ACP owns a private server by construction. --standalone is a
  // different command's flag and actual ACP validation rejects it.
  if(id==='opencode') return /^\s+acp\s+/m.test(help) ? ['acp'] : null;
  if(id==='gemini') {
    if(/(?:^|[\s,])--acp(?:[\s,=]|$)/m.test(help)) return ['--acp'];
    if(/(?:^|[\s,])--experimental-acp(?:[\s,=]|$)/m.test(help)) return ['--experimental-acp'];
  }
  if(id==='qwen' && /(?:^|[\s,])--acp(?:[\s,=]|$)/m.test(help)) return ['--acp'];
  return null;
}

/** Production discovery never consults desktop-client accounts or user CLI profiles. */
export function createNativeAcpRuntime({id,runtimeConfiguration,launchFactory,envSource=process.env,profileParent,allowLoopbackHttpForTests=false} = {}) {
  const policyVersion=id==='opencode'?POLICY_VERSION:GEMINI_QWEN_POLICY_VERSION;
  let cached=null,pending=null;
  const profiles=new Set();
  function current() {
    const configuration=runtimeConfiguration.get(id),configurationIdentity=runtimeConfiguration.identity(id);
    if(!configuration.enabled) return {configuration,configurationIdentity,reason:'runtime_disabled'};
    const cli=new CliAgentProcess({name:id,executable:configuration.runtimePath || undefined,
      nodeExecutable:configuration.nodePath || process.execPath,envSource});
    if(!cli.health().available) return {configuration,configurationIdentity,reason:'not_installed'};
    const target=cli.launchTarget();
    const packageIdentity=id==='gemini' || id==='qwen'?geminiQwenPackageIdentity(id,target.argsPrefix[0]):null;
    const identity=digest(JSON.stringify({configurationIdentity,packageIdentity,binary:bytesIdentity(target.executable),
      prefix:target.argsPrefix.map(value=>({argument:value,...(fs.existsSync(value)?{file:bytesIdentity(value)}:{})})),policyVersion}));
    return {configuration,configurationIdentity,target,identity,packageIdentity,executable:cli.executable()};
  }
  function validateIdentity(expected) {
    let state;
    try { state=current(); } catch { throw fault('AGENT_RUNTIME_CHANGED','Native runtime changed; close the session and check the connection again'); }
    if(state.identity!==expected) throw fault('AGENT_RUNTIME_CHANGED','Native runtime or configuration changed; close the session and check the connection again');
  }
  async function inspect() {
    let state;
    try { state=current(); } catch { return {reason:'runtime_detection_failed',compatible:false}; }
    if(state.reason) return {...state,compatible:false};
    if(!state.configuration.model) return {...state,reason:'agent_model_required',compatible:false};
    if(!state.configuration.credentialConfigured) return {...state,reason:'agent_credential_required',compatible:false};
    if(cached?.identity===state.identity) return cached;
    if(pending) {await pending;return inspect();}
    pending=(async()=>{
      let profile,handle,rpc;
      try {
        profile=createNativeAcpProfile({id,configuration:state.configuration,profileParent,allowLoopbackHttpForTests});
        const probe=async args=>{
          const owned=launchFactory({executable:state.target.executable,argv:[...state.target.argsPrefix,...args],envSource,
            trustedEnvironment:profile.environment})({cwd:profile.root});
          handle=owned;
          const chunks=[];let bytes=0,overflow=false,timer;
          const receive=chunk=>{const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>1048576)overflow=true;else chunks.push(buffer);};
          owned.readable.on('data',receive);
          try {
            const result=await Promise.race([owned.done,new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),5000);})]);
            return {status:!result.timedOut && !overflow && !result.startFailed ? result.exitCode : null,stdout:Buffer.concat(chunks).toString('utf8')};
          } finally {clearTimeout(timer);owned.readable.off('data',receive);await owned.close();handle=null;}
        };
        const versionProbe=await probe(['--version']),helpProbe=await probe(['--help']);
        const version=versionProbe.status===0 ? String(versionProbe.stdout).trim().split(/\r?\n/)[0].slice(0,200) : null;
        const argv=helpProbe.status===0 ? acpArgumentsFromHelp(id,String(helpProbe.stdout)) : null;
        if(!version || !argv) return {...state,version,reason:!version?'acp_version_unverified':'acp_launch_unverified',compatible:false};
        handle=launchFactory({executable:state.target.executable,argv:[...state.target.argsPrefix,...argv,...profile.argv??[]],envSource,trustedEnvironment:profile.environment})({cwd:profile.root});
        rpc=createJsonRpcTransport({readable:handle.readable,writable:handle.writable,framing:'acp-v1-jsonl'});
        const initialized=await rpc.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'CetaMesh',version:'1'}},{timeoutMs:15000});
        if(initialized?.protocolVersion!==1) return {...state,version,reason:'acp_version_unverified',compatible:false};
        profile.validate();
        const knownOpenCode=id==='opencode' && process.platform==='win32' && initialized.agentInfo?.name==='OpenCode'
          && initialized.agentInfo.version==='2.1.4' && /^opencode v2\.1\.4$/i.test(version);
        const known=knownOpenCode || (id==='qwen' && Boolean(state.packageIdentity) && knownGeminiQwenRuntime(id,version,initialized));
        const security=known ? {mode:'native-permissions',verified:true,nativeSandboxSupported:false,strictIsolationVerified:false,
          nativeApprovalSupported:true,nativePermissionPolicyVerified:true,allToolsRequireApproval:true,nativeSandboxMode:'none',
          nativeApprovalPolicy:'host-approval-every-tool',identity:digest(state.identity+profile.identity),policyVersion,
          securityLimitations:['No OS sandbox. Approved commands can access host files and network.','External plugins, skills, MCP and subagents are disabled.']} : undefined;
        const result={...state,version,argv,compatible:true,security,securityVerified:known,
          authMethods:Array.isArray(initialized.authMethods)?initialized.authMethods.map(item=>String(item.id).slice(0,80)):[],
          reason:!known?(id==='gemini' && knownGeminiQwenRuntime(id,version,initialized)?'native_input_unverified':'native_policy_unverified'):!state.configuration.model?'agent_model_required':!state.configuration.credentialConfigured?'agent_credential_required':null,
          validateRuntime:()=>{validateIdentity(state.identity);for(const active of profiles)active.validate();},snapshotExcludedPaths:id==='opencode'?ACP_SNAPSHOT_EXCLUDED_PATHS:GEMINI_QWEN_SNAPSHOT_EXCLUDED_PATHS};
        result.launch=async args=>{
          validateIdentity(state.identity);
          const credential=runtimeConfiguration.resolveCredential(id);
          if(!credential?.apiKey || credential.baseUrl!==state.configuration.baseUrl) throw fault('AGENT_CREDENTIAL_REQUIRED','Configure this Agent credential');
          const launchProfile=createNativeAcpProfile({id,configuration:state.configuration,profileParent,allowLoopbackHttpForTests});
          let owned;
          try {
            const launch=launchFactory({executable:state.target.executable,argv:[...state.target.argsPrefix,...argv,...launchProfile.argv??[]],envSource,
              trustedEnvironment:{...launchProfile.environment,[id==='qwen'?'OPENAI_API_KEY':id==='gemini'?'GEMINI_API_KEY':'CETAMESH_AGENT_API_KEY']:credential.apiKey}});
            let wrapped;
            const wrap=handle=>{
              if(wrapped)return wrapped;
              const close=handle.close.bind(handle);
              wrapped={...handle,async close(){await close();await launchProfile.cleanup();profiles.delete(launchProfile);}};
              args.onHandle?.(wrapped);return wrapped;
            };
            profiles.add(launchProfile);
            owned=launch({...args,onHandle:wrap});
            return wrap(owned);
          } catch(error) {if(!owned){await launchProfile.cleanup();profiles.delete(launchProfile);}throw error;}
        };
        validateIdentity(state.identity);cached=result;return result;
      } catch(error) {return {...state,compatible:false,reason:error?.code==='AGENT_RUNTIME_CHANGED'?'runtime_changed':'acp_initialize_failed'};}
      finally {
        await rpc?.close();
        if(handle) await handle.close();
        await profile?.cleanup();
      }
    })();
    try{return await pending;}finally{pending=null;}
  }
  return {inspect,configuration:()=>runtimeConfiguration.get(id),configure:input=>{cached=null;return runtimeConfiguration.configure(id,input);}};
}
