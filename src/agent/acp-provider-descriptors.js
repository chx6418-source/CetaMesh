import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliAgentProcess, createMinimalAgentEnv } from './cli-agent-process.js';
import { createAcpAgentProvider } from './acp-agent-provider.js';
import { agentProviderError } from './agent-provider.js';
import { createNativeAcpRuntime } from './native-acp-runtime.js';

// Official command descriptions are not installed-version or native-policy evidence.
export const ACP_PROVIDER_DESCRIPTORS = Object.freeze([
  Object.freeze({id:'gemini',label:'Gemini',argv:null,source:'https://geminicli.com/docs/cli/acp/'}),
  Object.freeze({id:'opencode',label:'OpenCode',argv:Object.freeze(['acp']),source:'https://opencode.ai/docs/acp/'}),
  Object.freeze({id:'qwen',label:'Qwen Code',argv:Object.freeze(['--acp']),source:'https://qwenlm.github.io/qwen-code-docs/en/users/features/acp/'})
]);

/** Bounded discovery only; published documentation never authorizes local execution. */
export function discoverAcpRuntime(id) {
  const cli = new CliAgentProcess({name:id});
  const detected = cli.health();
  if (!detected.available) return null;
  const probe = cli.version({timeoutMs:3000});
  return {executable:detected.executable,version:probe.version,compatible:false,securityVerified:false,
    reason:probe.available ? 'acp_version_unverified' : probe.reason ?? 'acp_version_unverified'};
}

/** Raw pipes; done means observed process close, never signal delivery. */
export function createAcpProcessLauncher({executable,argv,spawnImpl=spawn,envSource=process.env,trustedEnvironment} = {}) {
  return ({cwd,onHandle}) => {
    const allowed=new Set(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','HOMEDRIVE','HOMEPATH','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','OPENCODE_CONFIG_CONTENT','OPENCODE_CONFIG_DIR','OPENCODE_DISABLE_PROJECT_CONFIG','OPENCODE_PURE','OPENCODE_DISABLE_EXTERNAL_SKILLS','OPENCODE_DISABLE_AUTOUPDATE','OPENCODE_DISABLE_MODELS_FETCH','OPENCODE_LOG_LEVEL','CETAMESH_AGENT_API_KEY','GEMINI_CLI_HOME','GEMINI_CLI_NO_RELAUNCH','GEMINI_CLI_SYSTEM_SETTINGS_PATH','GEMINI_CLI_SYSTEM_DEFAULTS_PATH','GEMINI_CLI_TRUST_WORKSPACE','GOOGLE_GEMINI_BASE_URL','GEMINI_API_KEY','QWEN_HOME','QWEN_CODE_SYSTEM_SETTINGS_PATH','QWEN_CODE_SYSTEM_DEFAULTS_PATH','QWEN_CODE_DISABLE_WORKFLOWS','NO_BROWSER','OPENAI_BASE_URL','OPENAI_API_KEY']);
    const overrides=typeof trustedEnvironment==='function' ? trustedEnvironment() : trustedEnvironment ?? {};
    if(Object.entries(overrides).some(([key,value])=>!allowed.has(key) || typeof value!=='string' || /[\0]/.test(value))) throw agentProviderError('ACP_ENVIRONMENT_INVALID','Unsupported trusted runtime environment');
    const child=spawnImpl(executable,[...argv],{cwd,env:{...createMinimalAgentEnv(envSource),...overrides},shell:false,windowsHide:true,
      detached:process.platform !== 'win32',stdio:['pipe','pipe','pipe']});
    let stderr=Buffer.alloc(0), exited=false, startError=null;
    const done=new Promise(resolve=>{
      // Spawn error identifies startup failure; only close confirms no owned process remains.
      child.on('error',()=>{startError={code:'PROCESS_START_FAILED',message:'ACP 运行时启动失败'};});
      child.once('close',(code,signal)=>{exited=true; resolve({exitCode:code,signal,startFailed:Boolean(startError),...(startError ? {error:startError} : {})});});
    });
    // Never retain raw diagnostics or credentials; the rolling ring is at most 64 KiB.
    child.stderr?.on('data',chunk=>{
      const safe='[REDACTED_RUNTIME_DIAGNOSTIC]'; // Whole-chunk redaction also covers credentials split across chunks.
      stderr=Buffer.concat([stderr,Buffer.from(safe)]).subarray(-65536);
    });
    const handle={readable:child.stdout,writable:child.stdin,done,
      async close(){
        if(!exited && Number.isInteger(child.pid) && child.pid > 0) {
          if(process.platform==='win32' && Number.isInteger(child.pid)) {
            const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',env:createMinimalAgentEnv()});
            await new Promise((resolve,reject)=>{killer.once('error',()=>{child.kill();reject(agentProviderError('ACP_CLOSE_UNKNOWN','ACP process tree termination could not be started'));});killer.once('close',code=>code===0 || exited ? resolve() : reject(agentProviderError('ACP_CLOSE_UNKNOWN','ACP process tree exit was not confirmed')));});
          } else {try {process.kill(-child.pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}}
        }
        await done;
      }};
    onHandle?.(handle);
    return handle;
  };
}

export function createAcpProviders({runtimeResolver=discoverAcpRuntime,launchFactory=createAcpProcessLauncher,taskOptions={},nativeApprovalBridge,runtimeConfiguration,runtimeOptions={},log} = {}) {
  return ACP_PROVIDER_DESCRIPTORS.map(spec=>{
    if(runtimeConfiguration) return configuredProvider(spec,{runtimeConfiguration,launchFactory,taskOptions,nativeApprovalBridge,runtimeOptions,log});
    let runtime;
    try {runtime=runtimeResolver(spec.id);} catch(error) {runtime={reason:'runtime_detection_failed'};}
    const commandVerified=typeof runtime?.executable==='string' && path.isAbsolute(runtime.executable)
      && !/\.(?:cmd|bat|ps1)$/i.test(runtime.executable) && Array.isArray(spec.argv) && (!runtime?.argv || JSON.stringify(runtime.argv)===JSON.stringify(spec.argv));
    const versionVerified=runtime?.compatible===true && typeof runtime.version==='string' && Boolean(runtime.version);
    const security=runtime?.security;
    const nativeVerified=runtime?.securityVerified===true && security?.verified===true && security.mode==='native'
      && security.nativeSandboxSupported===true && security.nativeApprovalSupported===true;
    const verified=Boolean(runtime?.executable && commandVerified && versionVerified && nativeVerified);
    const reason=!runtime?.executable ? runtime?.reason ?? 'not_installed' : !commandVerified ? 'acp_launch_unverified'
      : !versionVerified ? runtime.reason ?? 'acp_version_unverified' : !nativeVerified ? 'native_policy_unverified'
      : typeof taskOptions.resolveTaskWorkspace!=='function' ? 'task_binding_unavailable' : null;
    const provider=createAcpAgentProvider({descriptor:{id:spec.id,label:spec.label,protocolVersion:1,verifiedRuntime:verified,security},
      launch:verified ? launchFactory({executable:runtime.executable,argv:spec.argv}) : undefined,
      resolveTaskWorkspace:taskOptions.resolveTaskWorkspace,applyChanges:taskOptions.applyChanges,
      approvalStatus:taskOptions.approvalStatus,cancelApproval:taskOptions.cancelApproval,
      requestNativeApproval:nativeApprovalBridge,log});
    return Object.freeze({...provider,configure(settings={}) {
      if(Object.keys(settings).length) throw agentProviderError('INVALID_PARAMS','Unsupported ACP setting');
      return {provider:spec.id,supported:false,reason:'CONFIGURATION_UNSUPPORTED'};
    },capabilities(){return {...provider.capabilities(),available:!reason,reason,version:runtime?.version??null,displayName:spec.label};},
    async health(){const health=await provider.health();return {...health,available:!reason && health.available,
      readyForTask:!reason && health.taskEligible,taskEligible:!reason && health.taskEligible,installed:Boolean(runtime?.executable),
      compatible:versionVerified,version:runtime?.version??null,reason:reason ?? health.reason};}});
  });
}


function configuredProvider(spec,{runtimeConfiguration,launchFactory,taskOptions,nativeApprovalBridge,runtimeOptions,log}) {
  const discovery=createNativeAcpRuntime({id:spec.id,runtimeConfiguration,launchFactory,...runtimeOptions});
  let provider=null,runtime=null,reason='runtime_not_checked',pending=null,creating=0,shuttingDown=false;
  const sessions=new Map();
  const effectiveReason=detected=>detected.reason ?? (typeof nativeApprovalBridge!=='function'?'native_approval_unavailable'
    :typeof taskOptions.resolveTaskWorkspace!=='function'?'task_binding_unavailable':null);
  async function refresh() {
    if(shuttingDown)throw agentProviderError('PROVIDER_SHUTTING_DOWN','ACP provider is shutting down');
    if(pending) return pending;
    pending=(async()=>{
      const detected=await discovery.inspect();
      if(runtime?.identity===detected.identity && provider) {reason=effectiveReason(detected);return;}
      // A replacement policy cannot inherit the previous sessions or Owner consent.
      if(sessions.size || creating) {reason='runtime_changed';return;}
      if(provider) await provider.shutdown();
      runtime=detected;
      reason=effectiveReason(detected);
      provider=createAcpAgentProvider({descriptor:{id:spec.id,label:spec.label,protocolVersion:1,
        verifiedRuntime:!reason && detected.compatible===true && detected.securityVerified===true,security:detected.security},
        launch:detected.launch,validateRuntime:detected.validateRuntime,
        snapshotExcludedPaths:detected.snapshotExcludedPaths,stagingRoot:taskOptions.stagingRoot,
        excludedRoots:taskOptions.excludedRoots,listWorkspaceRoots:taskOptions.listWorkspaceRoots,
        resolveTaskWorkspace:taskOptions.resolveTaskWorkspace,applyChanges:taskOptions.applyChanges,
        approvalStatus:taskOptions.approvalStatus,cancelApproval:taskOptions.cancelApproval,
        requestNativeApproval:typeof nativeApprovalBridge==='function' ? async(request,options)=>{await detected.validateRuntime();const result=await nativeApprovalBridge(request,options);await detected.validateRuntime();return result;} : undefined,log});
    })();
    try{await pending;}finally{pending=null;}
  }
  const forSession=params=>sessions.get(params?.sessionId) ?? provider;
  const placeholder=createAcpAgentProvider({descriptor:{id:spec.id,label:spec.label,protocolVersion:1,verifiedRuntime:false}});
  const wrapper={...placeholder,
    capabilities(){
      let unavailable=reason;
      try{discovery.configuration();}catch(error){unavailable=error?.code==='AGENT_RUNTIME_CONFIG_CORRUPT'?'AGENT_RUNTIME_CONFIG_CORRUPT':'runtime_detection_failed';}
      return {...(provider ?? placeholder).capabilities(),available:!unavailable,reason:unavailable,version:runtime?.version??null,displayName:spec.label};
    },
    async health(){
      let configuration;
      try{configuration=discovery.configuration();}catch(error){
        reason=error?.code==='AGENT_RUNTIME_CONFIG_CORRUPT'?'AGENT_RUNTIME_CONFIG_CORRUPT':'runtime_detection_failed';
        return {...await placeholder.health(),available:false,taskEligible:false,readyForTask:false,sessionCapable:false,
          installed:runtime?.executable?true:null,compatible:false,protocolVerified:false,authConfigured:false,authVerified:false,
          authentication:'unknown',reason};
      }
      await refresh();const health=await provider.health();return {...health,available:!reason && health.available,
        taskEligible:!reason && health.taskEligible,readyForTask:!reason && health.taskEligible,
        sessionCapable:runtime?.compatible===true && runtime?.securityVerified===true,
        installed:Boolean(runtime?.executable),compatible:runtime?.compatible===true,version:runtime?.version??null,
        reason:reason ?? health.reason,protocolVerified:runtime?.compatible===true,
        authConfigured:configuration.credentialConfigured===true,authVerified:false,
        authentication:configuration.credentialConfigured?'configured-unverified':'not-configured',runtimeConfiguration:configuration};
    },
    configure(settings={}){if(sessions.size || creating)throw agentProviderError('AGENT_RUNTIME_BUSY','Close Agent sessions before changing runtime configuration');return discovery.configure(settings);},
    async createSession(params){if(shuttingDown)throw agentProviderError('PROVIDER_SHUTTING_DOWN','ACP provider is shutting down');if(reason || !provider)throw agentProviderError('PROVIDER_UNAVAILABLE','Check the configured ACP connection first');
      // Runtime refresh belongs to health. Never swap policy after Broker consent was checked.
      await runtime.validateRuntime();creating++;try{const result=await provider.createSession(params);sessions.set(result.sessionId,provider);return result;}catch(error){if(typeof error?.sessionId==='string' && error.sessionId)sessions.set(error.sessionId,provider);throw error;}finally{creating--;}},
    async closeSession(params){const target=forSession(params);const result=await target.closeSession(params);sessions.delete(params.sessionId);return result;},
    async shutdown(){shuttingDown=true;await pending;await Promise.all([...new Set([provider,...sessions.values()])].filter(Boolean).map(item=>item.shutdown()));sessions.clear();}
  };
  for(const name of ['send','cancel','status','contextUsage','resume','selectModel','archiveSession','nativeCheckpoint','nativeHandoff']) wrapper[name]=params=>{
    const target=forSession(params);if(!target)throw agentProviderError('PROVIDER_UNAVAILABLE','Check the Agent connection first');return target[name](params);};
  wrapper.follow=async function*(params){const target=forSession(params);if(!target)throw agentProviderError('SESSION_NOT_FOUND','ACP session unavailable');yield* target.follow(params);};
  return Object.freeze(wrapper);
}
