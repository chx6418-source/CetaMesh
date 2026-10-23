import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliAgentProcess, createMinimalAgentEnv } from './cli-agent-process.js';
import { createAcpAgentProvider } from './acp-agent-provider.js';
import { agentProviderError } from './agent-provider.js';

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
export function createAcpProcessLauncher({executable,argv,spawnImpl=spawn,envSource=process.env} = {}) {
  return ({cwd,onHandle}) => {
    const child=spawnImpl(executable,[...argv],{cwd,env:createMinimalAgentEnv(envSource),shell:false,windowsHide:true,
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
            killer.once('error',()=>child.kill());
          } else {try {process.kill(-child.pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}}
        }
        await done;
      }};
    onHandle?.(handle);
    return handle;
  };
}

export function createAcpProviders({runtimeResolver=discoverAcpRuntime,launchFactory=createAcpProcessLauncher,taskOptions={},nativeApprovalBridge,log} = {}) {
  return ACP_PROVIDER_DESCRIPTORS.map(spec=>{
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
