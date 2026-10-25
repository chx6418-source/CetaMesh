import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';
import { createClaudeAgentProvider, claudeRunnerLaunchSpec } from '../src/agent/claude-agent-provider.js';
import { runClaudeSdkRunner } from '../src/agent/claude-sdk-runner.js';
// Production configuration must produce actionable readiness without injected security flags.
const configuredModule = await import('../src/agent/claude-agent-provider.js');
assert.equal(typeof configuredModule.createConfiguredClaudeAgentProvider,'function','configured Claude production factory must be exported');
const runtimeFs=await import('node:fs'), runtimeOs=await import('node:os'), runtimePath=await import('node:path');
const configuredRoot=runtimeFs.mkdtempSync(runtimePath.join(runtimeOs.tmpdir(),'claude-configured-'));
const {createAgentRuntimeConfiguration}=await import('../src/agent/runtime-configuration.js');
const configuredSecrets=new Map();
let credentialReads=0;
const runtimeConfiguration=createAgentRuntimeConfiguration({stateDir:configuredRoot,providerSecrets:{
  list:()=>[...configuredSecrets].map(([provider,value])=>({provider,configured:true,baseUrl:value.baseUrl,updatedAt:value.revision,hint:'fixture'})),
  set:value=>configuredSecrets.set(value.provider,{...value,revision:String(Date.now())}),
  raw:provider=>{credentialReads++;return configuredSecrets.get(provider);}
}});
try {
  const production=configuredModule.createConfiguredClaudeAgentProvider({runtimeConfiguration,
    resourceRoot:runtimePath.join(configuredRoot,'absent-resource'),
    taskOptions:{resolveTaskWorkspace:async()=>{throw Error('health cannot bind Task');}},
    requestNativeApproval:async()=>({outcome:'rejected'})});
  production.configure({runtimePath:runtimePath.join(configuredRoot,'missing',process.platform==='win32'?'claude.exe':'claude'),model:'owner-model',apiKey:'fixture-private-key'});
  const missing=await production.health();
  assert.equal(missing.installed,false);assert.equal(missing.compatible,false);
  assert.equal(missing.taskEligible,false);assert.equal(missing.reason,'claude_code_not_found');
  assert.equal(missing.runtimeConfiguration.model,'owner-model');
  assert.equal(missing.authConfigured,true);assert.equal(credentialReads,0,'health never resolves private credentials');
  assert.equal(JSON.stringify(missing).includes('fixture-private-key'),false);
  production.configure({runtimePath:runtimePath.join(configuredRoot,'claude-desktop.exe')});
  assert.equal((await production.health()).reason,'claude_code_path_unsupported','a GUI path never becomes a CLI');
  production.configure({enabled:false});
  assert.equal((await production.health()).reason,'disabled');
  assert.equal(production.capabilities().security.nativeSandboxSupported,false);
  await production.shutdown();
} finally {runtimeFs.rmSync(configuredRoot,{recursive:true,force:true});}
console.log('Claude configured missing-runtime and private health contract PASS');


// Corrupt optional configuration must not prevent registry/list startup or overwrite evidence.
const corruptRoot=runtimeFs.mkdtempSync(runtimePath.join(runtimeOs.tmpdir(),'claude-corrupt-config-'));
const corruptFile=runtimePath.join(corruptRoot,'agent-runtimes.json');runtimeFs.writeFileSync(corruptFile,'{broken');
let corruptService;
try {
  const corruptConfiguration=createAgentRuntimeConfiguration({stateDir:corruptRoot});
  const corruptProvider=configuredModule.createConfiguredClaudeAgentProvider({runtimeConfiguration:corruptConfiguration,
    taskOptions:{resolveTaskWorkspace:async()=>{throw Error('corrupt configuration must never bind Task');}}});
  const {createAgentProviderRegistry}=await import('../src/agent/registry.js');
  const {createAgentBroker}=await import('../src/agent/broker.js');
  const {createAgentService}=await import('../src/agent/service.js');
  const {defineAgentProvider}=await import('../src/agent/agent-provider.js');
  const unaffected=defineAgentProvider({id:'fixture',label:'Unaffected',methods:{health:async()=>({available:true})}});
  corruptService=createAgentService({broker:createAgentBroker({registry:createAgentProviderRegistry({providers:[corruptProvider,unaffected]})}),installationStatus:async()=>null});
  assert.doesNotThrow(()=>corruptService.listProviders(),'optional Claude configuration cannot break composition-time provider enumeration');
  const listed=await corruptService.execute({method:'agent.list'});
  assert.equal(listed.providers.find(entry=>entry.id==='claude').reason,'AGENT_RUNTIME_CONFIG_CORRUPT');
  assert.equal(listed.providers.find(entry=>entry.id==='fixture').available,true);
  const corruptHealth=await corruptService.execute({method:'agent.health',params:{provider:'claude'}});
  assert.equal(corruptHealth.available,false);assert.equal(corruptHealth.taskEligible,false);
  assert.equal(corruptHealth.reason,'AGENT_RUNTIME_CONFIG_CORRUPT');
  assert.equal(corruptHealth.sessionCapable,false);assert.equal(corruptHealth.authentication,'unknown');
  assert.equal(corruptHealth.runtimeConfiguration,null);assert.equal(corruptHealth.capabilities.security.verified,false);
  await assert.rejects(corruptProvider.createSession({taskId:'fixture',workspaceId:'fixture'}),error=>error.code==='AGENT_RUNTIME_CONFIG_CORRUPT');
  assert.throws(()=>corruptProvider.configure({enabled:false}),error=>error.code==='AGENT_RUNTIME_CONFIG_CORRUPT');
  assert.equal(runtimeFs.readFileSync(corruptFile,'utf8'),'{broken','failed health/configure/launch must preserve malformed bytes');
}finally{await corruptService?.close();runtimeFs.rmSync(corruptRoot,{recursive:true,force:true});}
console.log('Claude corrupt optional configuration containment and preservation PASS');

// Native probes are the only mocked boundary: headers, hashes, config, staging and routing stay real.
const nativeBoundary=await import('node:child_process'), {mock:runtimeMock}=await import('node:test');
const {syncBuiltinESMExports}=await import('node:module'), {EventEmitter:ProbeEmitter}=await import('node:events');
const {createClaudeRuntimeVerifier}=await import('../src/agent/claude-runtime.js');
const probeRoot=runtimeFs.mkdtempSync(runtimePath.join(runtimeOs.tmpdir(),'claude-native-fixture-'));
const nativeBinary=runtimePath.join(probeRoot,process.platform==='win32'?'claude.exe':'claude');
const nativeBytes=Buffer.alloc(256);
if(process.platform==='win32') {nativeBytes.write('MZ');nativeBytes.writeUInt32LE(64,60);nativeBytes.writeUInt32LE(0x4550,64);nativeBytes.writeUInt16LE(0x8664,68);nativeBytes.writeUInt16LE(0x20b,88);nativeBytes.writeUInt16LE(3,156);}
else nativeBytes.set([0x7f,0x45,0x4c,0x46]);
runtimeFs.writeFileSync(nativeBinary,nativeBytes);
const auditedSdkSource=process.env.WHALEBRIDGE_TEST_CLAUDE_SDK_SOURCE;
const auditedSdkBytes=auditedSdkSource ? await (await import('./claude-sdk-resource.mjs')).compileClaudeSdkResource(auditedSdkSource) : null;
const nativeLaunches=[],nativeChildren=[];
let probeVersion='2.1.76 (Claude Code)',nativeOptions,nativeExercise;
const nativeSpawn=runtimeMock.method(nativeBoundary.default,'spawn',(command,args,options)=>{
  assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
  assert.equal(options.env.ANTHROPIC_API_KEY,undefined,'keys must not appear in runner or probe process creation');
  assert.equal(options.env.ANTHROPIC_AUTH_TOKEN,undefined);
  assert.notEqual(options.env.HOME,process.env.HOME);assert.notEqual(options.env.USERPROFILE,process.env.USERPROFILE);
  assert.ok(options.env.HOME.startsWith(options.cwd)||options.env.HOME.includes('cetamesh-claude-profile-'));
  const child=new ProbeEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.emit('close',null,'SIGTERM');return true;};
  nativeLaunches.push({command,args,options,child});
  if(args.includes('--agent-sdk-runner')) {
    const done=runClaudeSdkRunner({input:child.stdin,output:child.stdout,loadSdk:async()=>({query({options}) {
      nativeOptions=options;
      return {async *[Symbol.asyncIterator]() {if(nativeExercise)await nativeExercise(options);yield {type:'result',subtype:'success',session_id:'configured-native-id'};},async interrupt(){}};
    }})});
    done.then(()=>child.emit('close',0,null));nativeChildren.push(child);
  } else {
    assert.equal(command,nativeBinary);
    assert.ok(args.length===1&&['--version','--help'].includes(args[0]));
    queueMicrotask(()=>{child.stdout.write(args[0]==='--version'?probeVersion:
      'Claude Code --print --input-format --output-format --permission-mode --setting-sources --strict-mcp-config --tools --settings');child.emit('close',0,null);});
  }
  return child;
});
syncBuiltinESMExports();
try {
  const verifier=createClaudeRuntimeVerifier({resourceRoot:runtimePath.join(probeRoot,'missing-sdk')});
  const noSdk=await verifier.inspect(nativeBinary);
  assert.equal(noSdk.installed,true);assert.equal(noSdk.compatible,true);assert.equal(noSdk.reason,'claude_sdk_resource_unverified');
  assert.equal(nativeLaunches.length,2);assert.equal(credentialReads,0);
  assert.ok(nativeLaunches.every(launch=>!runtimeFs.existsSync(launch.options.cwd)),'closed probes remove only their owned profiles');
  const gui=runtimePath.join(probeRoot,'claude-desktop.exe');runtimeFs.writeFileSync(gui,nativeBytes);
  assert.equal((await verifier.inspect(gui)).reason,'claude_code_path_unsupported');assert.equal(nativeLaunches.length,2);
  if(process.platform==='win32') {
    const guiRoot=runtimePath.join(probeRoot,'desktop-client');runtimeFs.mkdirSync(guiRoot);const guiBinary=runtimePath.join(guiRoot,'claude.exe');
    const guiBytes=Buffer.from(nativeBytes);guiBytes.writeUInt16LE(2,156);runtimeFs.writeFileSync(guiBinary,guiBytes);
    assert.equal((await verifier.inspect(guiBinary)).reason,'claude_code_binary_invalid','GUI PE subsystem must be rejected before executing even a renamed Claude app');
    assert.equal(nativeLaunches.length,2);
  }
  nativeBytes[100]^=1;runtimeFs.writeFileSync(nativeBinary,nativeBytes);probeVersion='3.6556.2.0';
  assert.equal((await verifier.inspect(nativeBinary)).reason,'claude_code_identity_unverified');
  assert.equal(nativeLaunches.length,3,'desktop version output cannot enter the SDK path');
  probeVersion='2.1.76 (Claude Code)';nativeBytes[100]^=1;runtimeFs.writeFileSync(nativeBinary,nativeBytes);

  // Positive configured execution uses exact audited build bytes only when explicitly available.
  const sdkSource=auditedSdkSource;
  if(sdkSource) {
    const {CLAUDE_SDK_RESOURCE_FILE}=await import('../src/agent/claude-sdk-resource.js');
    const resourceRoot=runtimePath.join(probeRoot,'resources'),sdkFile=runtimePath.join(resourceRoot,CLAUDE_SDK_RESOURCE_FILE);
    runtimeFs.mkdirSync(runtimePath.dirname(sdkFile),{recursive:true});runtimeFs.writeFileSync(sdkFile,auditedSdkBytes);
    const stateRoot=runtimePath.join(probeRoot,'state');runtimeFs.mkdirSync(stateRoot);
    const sourceRoot=runtimePath.join(probeRoot,'workspace');runtimeFs.mkdirSync(sourceRoot);runtimeFs.writeFileSync(runtimePath.join(sourceRoot,'README.md'),'owned fixture');
    const secretStore=new Map();let secretReads=0,taskBindings=0;
    const configuration=createAgentRuntimeConfiguration({stateDir:stateRoot,providerSecrets:{
      list:()=>[...secretStore].map(([provider,value])=>({provider,configured:true,baseUrl:value.baseUrl,updatedAt:value.revision,hint:'fixture'})),
      set:value=>secretStore.set(value.provider,{...value,revision:cryptoFixture.randomUUID()}),
      raw:provider=>{assert.ok(taskBindings>0,'private credential read follows Task binding');secretReads++;return secretStore.get(provider);}
    }});
    const {default:cryptoFixture}=await import('node:crypto');
    let configuredApproval=async()=>({outcome:'rejected'});
    const configured=configuredModule.createConfiguredClaudeAgentProvider({runtimeConfiguration:configuration,resourceRoot,
      requestNativeApproval:(...args)=>configuredApproval(...args),taskOptions:{stagingRoot:runtimePath.join(probeRoot,'stages'),
        resolveTaskWorkspace:async()=>{taskBindings++;return {task:{id:'configured-task',workspaceId:'configured-workspace'},workspace:{id:'configured-workspace',root:sourceRoot}};}}});
    configured.configure({runtimePath:nativeBinary,model:'selected-model',baseUrl:'https://claude.example.test',apiKey:'configured-private-key'});
    const healthy=await configured.health();assert.equal(healthy.available,true);assert.equal(healthy.taskEligible,true);assert.equal(secretReads,0);
    assert.equal(healthy.sessionCapable,true);assert.equal(healthy.authConfigured,true);assert.equal(healthy.authVerified,false);
    assert.equal(healthy.authentication,'configured-unverified');assert.equal(healthy.authenticated,null);
    assert.equal(configured.capabilities().security.mode,'native-permissions');assert.equal(configured.capabilities().security.nativeSandboxSupported,false);
    const originalSecurity=configured.capabilities().security.configurationIdentity;
    const session=await configured.createSession({taskId:'configured-task',workspaceId:'configured-workspace'});
    assert.equal(secretReads,1);assert.notEqual(session.cwd,sourceRoot);
    const firstChild=nativeChildren.at(-1),firstProfile=nativeLaunches.at(-1).options.env.USERPROFILE;
    assert.equal(runtimeFs.existsSync(firstProfile),true);
    assert.equal((await configured.send({sessionId:session.sessionId,content:'fixture'})).accepted,true);
    for(let i=0;i<100&&(await configured.status({sessionId:session.sessionId})).running;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal((await configured.status({sessionId:session.sessionId})).lastRunStatus,'completed');
    assert.equal(nativeOptions.model,'selected-model');assert.equal(nativeOptions.env.ANTHROPIC_BASE_URL,'https://claude.example.test');
    assert.equal(nativeOptions.env.ANTHROPIC_API_KEY,'configured-private-key');assert.equal(nativeOptions.env.USERPROFILE,firstProfile);
    assert.deepEqual(nativeOptions.tools,['Read','Glob','Grep','Edit','Write','Bash']);
    assert.throws(()=>configured.configure({model:'replacement-model'}),error=>error.code==='AGENT_RUNTIME_BUSY');
    configuration.configure('claude',{model:'replacement-model'});
    await assert.rejects(configured.send({sessionId:session.sessionId,content:'must not reroute'}),error=>error.code==='AGENT_RUNTIME_CHANGED');
    await configured.health();assert.notEqual(configured.capabilities().security.configurationIdentity,originalSecurity);
    const second=await configured.createSession({taskId:'configured-task',workspaceId:'configured-workspace'});
    const secondChild=nativeChildren.at(-1);
    assert.notEqual(second.sessionId,session.sessionId);assert.equal(nativeChildren.length,2);
    await assert.rejects(configured.send({sessionId:session.sessionId,content:'still old'}),error=>error.code==='AGENT_RUNTIME_CHANGED');
    let approvalSeen,approvalAnswer,observedGate;
    const seen=new Promise(resolve=>{approvalSeen=resolve;}),answer=new Promise(resolve=>{approvalAnswer=resolve;});
    configuredApproval=async request=>{approvalSeen();return answer;};
    nativeExercise=async options=>{observedGate=await options.hooks.PreToolUse[0].hooks[0](
      {hook_event_name:'PreToolUse',tool_name:'Read',tool_input:{file_path:'README.md'},tool_use_id:'pending-config-change'},'pending-config-change',{});};
    await configured.send({sessionId:second.sessionId,content:'wait for configured approval'});await seen;
    assert.throws(()=>configured.configure({baseUrl:'https://new-claude.example.test',apiKey:'rotated-private-key'}),error=>error.code==='AGENT_RUNTIME_BUSY');
    configuration.configure('claude',{baseUrl:'https://new-claude.example.test',apiKey:'rotated-private-key'});
    approvalAnswer({outcome:'approved',optionId:'allow'});
    for(let i=0;i<100&&(await configured.status({sessionId:second.sessionId})).running;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(observedGate.hookSpecificOutput.permissionDecision,'deny','changing credential scope revokes an outstanding native approval');
    assert.equal((await configured.status({sessionId:second.sessionId})).state,'unknown');
    nativeExercise=null;
    const third=await configured.createSession({taskId:'configured-task',workspaceId:'configured-workspace'}),thirdChild=nativeChildren.at(-1);
    // File replacement invalidates a bound runtime even when its config has not changed.
    nativeBytes[101]^=1;runtimeFs.writeFileSync(nativeBinary,nativeBytes);
    await assert.rejects(configured.send({sessionId:third.sessionId,content:'tampered native'}),error=>error.code==='AGENT_RUNTIME_CHANGED');
    // Closing waits for actual runner close and keeps its profile while the process is unconfirmed.
    const closeFirst=configured.closeSession({sessionId:session.sessionId});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(runtimeFs.existsSync(firstProfile),true);
    firstChild.stdin.end();await closeFirst;assert.equal(runtimeFs.existsSync(firstProfile),false);
    secondChild.stdin.end();await configured.closeSession({sessionId:second.sessionId});
    thirdChild.stdin.end();await configured.closeSession({sessionId:third.sessionId});await configured.shutdown();
    assert.ok(!JSON.stringify(nativeLaunches.map(({command,args})=>({command,args}))).includes('configured-private-key'));
    console.log('Claude configured SDK/binary fingerprint, private bootstrap and owned-profile lifecycle fixture PASS');
  } else console.log('Claude configured positive SDK fixture NOT_RUN_ENVIRONMENT: set WHALEBRIDGE_TEST_CLAUDE_SDK_SOURCE to exact audited SDK source');
} finally {
  for(const child of nativeChildren)child.stdin.end();
  nativeSpawn.mock.restore();syncBuiltinESMExports();runtimeFs.rmSync(probeRoot,{recursive:true,force:true});
}
console.log('Claude native-code identity, bounded probe and missing SDK fixture PASS');


const provider = createClaudeAgentProvider({ launchSdkRunner: () => { throw Error('must not launch'); } });
assert.equal((await provider.health()).available, false);
assert.equal(provider.capabilities().supported.send, false);
assert.equal(provider.capabilities().security.nativeSandboxSupported, false);
assert.deepEqual(claudeRunnerLaunchSpec({ executable: 'Core.exe', sea: true }).args, ['--agent-sdk-runner', 'claude']);
assert.deepEqual(claudeRunnerLaunchSpec({ executable: 'node', sea: false, entry: '/core-entry.js' }).args, ['/core-entry.js', '--agent-sdk-runner', 'claude']);
// Model selection stays in the private configuration DTO; omitted model stays omitted.
const modelFixture=await createPermissionFixture({model:'fixture/claude:model'});
try {assert.equal((await modelFixture.turn(async options=>{
  assert.equal(options.model,'fixture/claude:model');
})).outcome,'completed');}finally{await modelFixture.close();}

// Windows native-permissions must be explicit and cannot claim OS isolation.
const permissionSecurity={mode:'native-permissions',verified:true,nativeSandboxSupported:false,
  strictIsolationVerified:false,nativeApprovalSupported:true,nativePermissionPolicyVerified:true,
  allToolsRequireApproval:true,nativeSandboxMode:'none'};
const configuredProvider=security=>createClaudeAgentProvider({
  launchSdkRunner:()=>{throw Error('health must not launch');},resolveCredential:async()=> 'fixture-only',
  requestNativeApproval:async()=>({outcome:'rejected'}),
  taskOptions:{credentialRef:'fixture',verifiedRuntime:{verified:true,sdkResourcesVerified:true,binaryVerified:true,
    runtimePath:'/verified/claude',tools:['Read'],security},resolveTaskWorkspace:async()=>({})}});
assert.equal((await configuredProvider(permissionSecurity).health()).available,true);
for(const change of [{nativePermissionPolicyVerified:false},{allToolsRequireApproval:false},
  {nativeSandboxSupported:true},{strictIsolationVerified:true},{nativeSandboxMode:'unverified'},
  {nativeApprovalSupported:false},{mode:'native'}]) {
  assert.equal((await configuredProvider({...permissionSecurity,...change}).health()).available,false);
}


// Explicit endpoint + owned environment must reach the native process without profile credentials.
const {createClaudeOwnedProfile}=await import('../src/agent/claude-runtime.js');
const nativeProfile=createClaudeOwnedProfile();
const endpointFixture=await createPermissionFixture({baseUrl:'https://claude.example.test/v1',profileRoot:nativeProfile.root,executionMode:'native-permissions'});
try {await endpointFixture.turn(async options=>{
  assert.equal(options.env.ANTHROPIC_BASE_URL,'https://claude.example.test/v1');
  assert.equal(options.env.HOME,runtimePath.join(nativeProfile.root,'home'));
  assert.equal(options.env.USERPROFILE,options.env.HOME);
  assert.equal(options.env.APPDATA,runtimePath.join(nativeProfile.root,'roaming'));
  assert.equal(options.env.LOCALAPPDATA,runtimePath.join(nativeProfile.root,'local'));
  assert.equal(options.env.CLAUDE_CONFIG_DIR,runtimePath.join(nativeProfile.root,'config'));
  assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.ANTHROPIC_AUTH_TOKEN,undefined);
  assert.deepEqual(options.sandbox,{enabled:false});
});}finally{await endpointFixture.close();nativeProfile.cleanup();}

// SDK0.3.308 PreToolUse gates default-auto-approved tools as well as explicit asks.
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; };
async function createPermissionFixture({tools=['Read','Bash'],model,baseUrl,profileRoot,executionMode,onPermission=async()=>({approved:true})}={}) {
  const input=new PassThrough(),output=new PassThrough(),requests=[];
  let exercise,failure;
  const done=runClaudeSdkRunner({input,output,loadSdk:async()=>({query({options}) {
    return {async *[Symbol.asyncIterator]() {
      try {await exercise(options);}catch(error){failure=error;throw error;}
      yield {type:'result',subtype:'success',session_id:'hook-fixture'};
    },async interrupt(){}};
  }})});
  const client=createJsonRpcTransport({readable:output,writable:input,framing:'acp-v1-jsonl',
    onRequest:async(method,params)=>{requests.push({method,params});return onPermission(method,params);}});
  await client.request('initialize',{credential:'hook-fixture-private',runtimePath:'/verified',cwd:'/fixture',tools,...(model === undefined ? {} : {model}),...(baseUrl === undefined ? {} : {baseUrl}),...(profileRoot === undefined ? {} : {profileRoot}),...(executionMode === undefined ? {} : {executionMode})});
  return {client,input,output,requests,async turn(run,{sessionId}={}) {
    exercise=run;failure=null;
    const result=await client.request(sessionId?'session/prompt':'turn',sessionId?
      {sessionId,prompt:[{type:'text',text:'fixture'}]}:{prompt:'fixture'},{timeoutMs:0});
    if(failure)throw failure;return result;
  },async close(){input.end();await done;client.close();}};
}
function allToolHook(options) {
  assert.equal(options.hooks?.PreToolUse?.length,1,'every tool needs a registered PreToolUse gate');
  assert.equal(options.hooks.PreToolUse[0].matcher,undefined,'the host gate must include every tool');
  assert.equal(options.hooks.PreToolUse[0].hooks.length,1);
  return options.hooks.PreToolUse[0].hooks[0];
}
const hookCall=(hook,tool,input,id,signal=new AbortController().signal)=>hook(
  {hook_event_name:'PreToolUse',tool_name:tool,tool_input:input,tool_use_id:id},id,{signal});
const allowedFixture=await createPermissionFixture();
try {
  assert.equal((await allowedFixture.turn(async options=>{
    const hook=allToolHook(options),original={file_path:'/fixture/README.md',offset:3,limit:7};
    const allowed=await hookCall(hook,'Read',original,'read-1');
    assert.equal(allowed.hookSpecificOutput.permissionDecision,'allow');
    assert.deepEqual(allowed.hookSpecificOutput.updatedInput,original);
    assert.notEqual(allowed.hookSpecificOutput.updatedInput,original,'execution uses the approved snapshot');
    const repeated=await options.canUseTool('Read',{...original},{toolUseID:'read-1',signal:new AbortController().signal});
    assert.equal(repeated.behavior,'allow');assert.deepEqual(repeated.updatedInput,original);
    assert.equal(allowedFixture.requests.length,1,'canUseTool must reuse the same call approval');
    assert.equal((await options.canUseTool('Read',{...original,limit:8},{toolUseID:'read-1'})).behavior,'deny');
    assert.equal((await hookCall(hook,'Bash',{command:'echo safe'},'read-1')).hookSpecificOutput.permissionDecision,'deny');
    assert.equal((await hookCall(hook,'Write',{file_path:'/fixture/no',content:'x'},'write-1')).hookSpecificOutput.permissionDecision,'deny');
    assert.equal((await options.canUseTool('Read',original,{toolUseID:'no-hook'})).behavior,'deny','missing hook cannot become a second approval route');
    assert.equal((await hookCall(hook,'Read',original,undefined)).hookSpecificOutput.permissionDecision,'deny');
    assert.equal((await hook({hook_event_name:'PreToolUse',tool_name:'Read',tool_input:original,tool_use_id:'input-id'},'callback-id',{})).hookSpecificOutput.permissionDecision,'deny');
    assert.equal(allowedFixture.requests.length,1,'invalid calls must not prompt');
    await hookCall(hook,'Read',original,'read-2');
    assert.equal(allowedFixture.requests.length,2,'distinct IDs need fresh approval for identical input');
    assert.deepEqual(options.tools,['Read','Bash']);assert.deepEqual(options.allowedTools,[]);
    assert.deepEqual(options.settingSources,[]);assert.deepEqual(options.mcpServers,{});assert.deepEqual(options.plugins,[]);
    assert.equal(options.strictMcpConfig,true);assert.equal(options.permissionMode,'default');
  })).outcome,'completed');
  assert.equal(allowedFixture.requests[0].method,'permission');
  assert.deepEqual(allowedFixture.requests[0].params.input,{file_path:'/fixture/README.md',offset:3,limit:7});
  await allowedFixture.turn(async options=>{
    const args={file_path:'/fixture/README.md',offset:3,limit:7};
    assert.equal((await options.canUseTool('Read',args,{toolUseID:'read-1'})).behavior,'deny','an earlier turn grants no authority');
    assert.equal((await hookCall(allToolHook(options),'Read',args,'read-1')).hookSpecificOutput.permissionDecision,'allow');
    assert.equal(allowedFixture.requests.length,3,'a new turn needs a fresh approval');
  });
}finally{await allowedFixture.close();}

// A single approved ID admits one hook and one matching SDK permission stage, never a replay.
const replayFixture=await createPermissionFixture();
try {await replayFixture.turn(async options=>{
  const hook=allToolHook(options);
  assert.equal((await hookCall(hook,'Write',{file_path:'/fixture/no',content:'x'},'invalid-first')).hookSpecificOutput.permissionDecision,'deny');
  assert.equal((await hookCall(hook,'Bash',{command:'echo replay'},'invalid-first')).hookSpecificOutput.permissionDecision,'deny','a previously denied hook ID cannot be reused for a replacement call');
  for(const [tool,input,id] of [['Bash',{command:'echo fixture'},'duplicate-bash'],['Read',{file_path:'/fixture/a'},'duplicate-read']]) {
    assert.equal((await hookCall(hook,tool,input,id)).hookSpecificOutput.permissionDecision,'allow');
    assert.equal((await hookCall(hook,tool,input,id)).hookSpecificOutput.permissionDecision,'deny','a repeated PreToolUse ID must revoke its earlier authorization');
    assert.equal((await options.canUseTool(tool,input,{toolUseID:id})).behavior,'deny','duplicate hooks cannot leave a usable second-stage authorization');
  }
  assert.equal(replayFixture.requests.length,2,'replayed hooks cannot request replacement approval');
  const input={command:'echo second stage'};
  assert.equal((await hookCall(hook,'Bash',input,'second-stage')).hookSpecificOutput.permissionDecision,'allow');
  assert.equal((await options.canUseTool('Bash',input,{toolUseID:'second-stage'})).behavior,'allow');
  assert.equal((await options.canUseTool('Bash',input,{toolUseID:'second-stage'})).behavior,'deny','the matching second stage is consumed once');
  assert.equal(replayFixture.requests.length,3);
});}finally{await replayFixture.close();}
const replaySeen=deferred(),replayAnswer=deferred();
const pendingReplayFixture=await createPermissionFixture({onPermission:async()=>{replaySeen.resolve();return replayAnswer.promise;}});
try {await pendingReplayFixture.turn(async options=>{
  const hook=allToolHook(options),input={command:'echo pending fixture'};
  const first=hookCall(hook,'Bash',input,'pending-replay');await replaySeen.promise;
  assert.equal((await hookCall(hook,'Bash',input,'pending-replay')).hookSpecificOutput.permissionDecision,'deny');
  assert.equal((await first).hookSpecificOutput.permissionDecision,'deny','duplicate hook revokes an in-flight Owner request');
  replayAnswer.resolve({approved:true});
  assert.equal((await options.canUseTool('Bash',input,{toolUseID:'pending-replay'})).behavior,'deny');
  assert.equal(pendingReplayFixture.requests.length,1);
});}finally{replayAnswer.resolve({approved:true});await pendingReplayFixture.close();}
console.log('Claude native hook ID replay and second-stage consumption PASS');

const deniedFixture=await createPermissionFixture({onPermission:async()=>({approved:false})});
try {await deniedFixture.turn(async options=>{
  const hook=allToolHook(options),args={command:'fixture-only'};
  assert.equal((await hookCall(hook,'Bash',args,'denied-1')).hookSpecificOutput.permissionDecision,'deny');
  assert.equal((await options.canUseTool('Bash',args,{toolUseID:'denied-1'})).behavior,'deny');
  assert.equal(deniedFixture.requests.length,1);
});}finally{await deniedFixture.close();}
const snapshotSeen=deferred(),snapshotAnswer=deferred();
const snapshotFixture=await createPermissionFixture({onPermission:async()=>{snapshotSeen.resolve();return snapshotAnswer.promise;}});
try {assert.equal((await snapshotFixture.turn(async options=>{
  const args={file_path:'/fixture/approved.md',nested:{value:1}};
  const pending=hookCall(allToolHook(options),'Read',args,'snapshot-1');
  await snapshotSeen.promise;args.file_path='/fixture/changed.md';args.nested.value=2;snapshotAnswer.resolve({approved:true});
  assert.deepEqual((await pending).hookSpecificOutput.updatedInput,{file_path:'/fixture/approved.md',nested:{value:1}});
  assert.equal((await options.canUseTool('Read',args,{toolUseID:'snapshot-1'})).behavior,'deny');
})).outcome,'completed');}finally{await snapshotFixture.close();}
let acpSelectedOption='allow';
const acpFixture=await createPermissionFixture({onPermission:async()=>({outcome:{outcome:'selected',optionId:acpSelectedOption}})});
try {
  const {sessionId}=await acpFixture.client.request('session/new',{cwd:'/fixture'});
  assert.equal((await acpFixture.turn(async options=>{
    assert.equal((await hookCall(allToolHook(options),'Read',{file_path:'/fixture/a'},'sdk-call-1')).hookSpecificOutput.permissionDecision,'allow');
    assert.equal((await options.canUseTool('Read',{file_path:'/fixture/a'},{toolUseID:'sdk-call-1'})).behavior,'allow');
  },{sessionId})).stopReason,'end_turn');
  assert.equal(acpFixture.requests.length,1);assert.equal(acpFixture.requests[0].method,'session/request_permission');
  assert.equal(acpFixture.requests[0].params.toolCall.toolCallId,'sdk-call-1');
  assert.deepEqual(acpFixture.requests[0].params.toolCall.rawInput,{file_path:'/fixture/a'});
  assert.deepEqual(acpFixture.requests[0].params.options.map(option=>option.kind),['allow_once','reject_once']);
  acpSelectedOption='allow_always';
  await acpFixture.turn(async options=>{
    const args={file_path:'/fixture/b'};
    assert.equal((await hookCall(allToolHook(options),'Read',args,'never-always')).hookSpecificOutput.permissionDecision,'deny');
    assert.equal((await options.canUseTool('Read',args,{toolUseID:'never-always'})).behavior,'deny');
    assert.equal(acpFixture.requests.length,2);
  },{sessionId});
}finally{await acpFixture.close();}
const signalSeen=deferred(),signalAnswer=deferred();
const signalFixture=await createPermissionFixture({onPermission:async()=>{signalSeen.resolve();return signalAnswer.promise;}});
try {await signalFixture.turn(async options=>{
  const signal=new AbortController(),args={command:'fixture-only'};
  const pending=hookCall(allToolHook(options),'Bash',args,'signal-1',signal.signal);
  await signalSeen.promise;signal.abort();assert.equal((await pending).hookSpecificOutput.permissionDecision,'deny');
  signalAnswer.resolve({approved:true});assert.equal((await options.canUseTool('Bash',args,{toolUseID:'signal-1'})).behavior,'deny');
});}finally{signalAnswer.resolve({approved:true});await signalFixture.close();}
// A transport close must abort an outstanding hook even if its host answer arrives late.
const disconnectSeen=deferred(),disconnectAnswer=deferred(),disconnectDecision=deferred();
const disconnectFixture=await createPermissionFixture({onPermission:async()=>{disconnectSeen.resolve();return disconnectAnswer.promise;}});
try {
  const pending=disconnectFixture.turn(async options=>{
    disconnectDecision.resolve(await hookCall(allToolHook(options),'Read',{file_path:'/fixture/a'},'disconnect-1'));
  }).catch(error=>error);
  await disconnectSeen.promise;disconnectFixture.output.destroy();
  assert.equal((await disconnectDecision.promise).hookSpecificOutput.permissionDecision,'deny');
  disconnectAnswer.resolve({approved:true});
  assert.ok((await pending) instanceof Error);
  assert.equal(disconnectFixture.requests.length,1);
}finally{disconnectAnswer.resolve({approved:true});await disconnectFixture.close();}

console.log('Claude all-tool hook snapshot and once-only approval contract PASS');

const input = new PassThrough(), output = new PassThrough();
let loads = 0, captured, interrupted = 0;
const events = [];
const runner = runClaudeSdkRunner({ input, output, loadSdk: async () => { loads++; return { query({ prompt, options }) {
  captured = { prompt, options };
  return { async *[Symbol.asyncIterator]() {
    const permission = await options.canUseTool('Bash', { command: 'echo unsafe' });
    assert.equal(permission.behavior, 'deny');
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '中文\nnext' } } };
    yield { type: 'result', subtype: 'success', session_id: 'native-1' };
  }, async interrupt() { interrupted++; } };
} }; } });
const client = createJsonRpcTransport({ readable: output, writable: input, framing: 'acp-v1-jsonl', onNotification(method, params) { events.push([method, params]); }, onRequest: async () => ({ approved: false }) });
assert.equal(loads, 0);
await assert.rejects(client.request('initialize', {}));
assert.equal(loads, 0);
for(const baseUrl of ['http://claude.example.test','https://user:secret@claude.example.test','https://claude.example.test/?key=private','https://claude.example.test/#fragment','']) {
  await assert.rejects(client.request('initialize',{credential:'fixture-secret',runtimePath:'/verified/claude',cwd:'/workspace',tools:[],baseUrl}));
  assert.equal(loads,0,'invalid endpoint must fail before SDK loading');
}
for(const model of ['', '  ', ' padded', 'line\nbreak', 'x'.repeat(257), null, 7]) {
  await assert.rejects(client.request('initialize',{credential:'fixture-secret',runtimePath:'/verified/claude',cwd:'/workspace',tools:[],model}));
  assert.equal(loads,0,'invalid model must fail before SDK loading');
}

await client.request('initialize', { credential: 'fixture-secret', runtimePath: '/verified/claude', cwd: '/workspace', tools: [] });
assert.equal(loads, 1);
await client.request('turn', { prompt: 'hello', resume: 'native-1' }, { timeoutMs: 0 });
assert.equal(captured.options.env.ANTHROPIC_API_KEY, 'fixture-secret');
assert.deepEqual(Object.keys(captured.options.env), ['ANTHROPIC_API_KEY']);
assert.deepEqual(captured.options.settingSources, []);
assert.deepEqual(captured.options.mcpServers, {});
assert.equal(captured.options.resume, 'native-1');
assert.equal(Object.hasOwn(captured.options,'model'),false);
assert.equal(captured.options.pathToClaudeCodeExecutable, '/verified/claude');
assert.ok(events.some(([,p]) => p.text === '中文\nnext'));
assert.ok(!JSON.stringify(events).includes('fixture-secret'));
await client.request('shutdown');
input.end();
await runner;
client.close();
console.log('Claude guarded provider and SDK runner contract PASS');
// Internal ACP-shaped facade reuses the shared staging/import and permission lifecycle.
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const source = mkdtempSync(join(tmpdir(), 'claude-fixture-'));
let fixtureOptions, closedHandle = false;
const live = createClaudeAgentProvider({
  taskOptions: { credentialRef: 'ref-only', verifiedRuntime: { verified: true, sdkResourcesVerified: true, binaryVerified: true,
    runtimePath:'/verified/claude', model:'fixture-live-model', tools:[], security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true} },
    resolveTaskWorkspace: async () => ({task:{id:'t',workspaceId:'w'},workspace:{id:'w',root:source}}) },
  resolveCredential: async ref => { assert.equal(ref, 'ref-only'); return 'private-fixture-key'; },
  async launchSdkRunner(binding) {
    assert.notEqual(binding.cwd, source);
    const readable = new PassThrough(), writable = new PassThrough();
    const done = runClaudeSdkRunner({input:writable,output:readable,loadSdk:async()=>({query({options}) {
      fixtureOptions = options;
      return {async *[Symbol.asyncIterator]() { yield {type:'result',subtype:'success',session_id:'native-reuse'}; },async interrupt() {}};
    }})});
    return {readable,writable,done,async close(){closedHandle=true;writable.end();await done;}};
  }
});
try {
  assert.equal((await live.health()).available, true);
  const session = await live.createSession({taskId:'t',workspaceId:'w'});
  const sent = await live.send({sessionId:session.sessionId,content:'first'});
  assert.equal(sent.accepted,true);
  for (let i=0;i<100 && (await live.status({sessionId:session.sessionId})).running;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal((await live.status({sessionId:session.sessionId})).lastRunStatus,'completed');
  await live.send({sessionId:session.sessionId,content:'second'});
  for (let i=0;i<100 && (await live.status({sessionId:session.sessionId})).running;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(fixtureOptions.resume,'native-reuse');
  assert.equal(fixtureOptions.model,'fixture-live-model');
  await live.closeSession({sessionId:session.sessionId});
  assert.equal(closedHandle,true);
} finally { rmSync(source,{recursive:true,force:true}); }
// Cancellation while native approval is waiting must settle and suppress late output.
const cancelIn = new PassThrough(), cancelOut = new PassThrough();
let approvalStarted;
const approvalSeen = new Promise(resolve => {approvalStarted=resolve;});
let releaseApproval;
const cancelEvents=[];
const cancelRunner=runClaudeSdkRunner({input:cancelIn,output:cancelOut,loadSdk:async()=>({query({options}) {
  return {async *[Symbol.asyncIterator]() {
    const args={command:'fixture-only'};
    const result=await hookCall(allToolHook(options),'Bash',args,'cancel-1');
    assert.equal(result.hookSpecificOutput.permissionDecision,'deny');
    assert.equal((await options.canUseTool('Bash',args,{toolUseID:'cancel-1'})).behavior,'deny');
    yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'late'}}};
  }, async interrupt() {}};
}})});
const cancelClient=createJsonRpcTransport({readable:cancelOut,writable:cancelIn,framing:'acp-v1-jsonl',
  onRequest:async()=>{approvalStarted();return new Promise(resolve=>{releaseApproval=resolve;});},
  onNotification:(_,p)=>cancelEvents.push(p)});
await cancelClient.request('initialize',{credential:'not-public',runtimePath:'/verified',cwd:'/fixture',tools:['Bash']});
const pendingTurn=cancelClient.request('turn',{prompt:'wait'},{timeoutMs:0});
await approvalSeen;
await cancelClient.request('cancel');
assert.equal((await pendingTurn).outcome,'cancelled');
releaseApproval({approved:true});
assert.deepEqual(cancelEvents,[]);
await cancelClient.request('shutdown');cancelIn.end();await cancelRunner;cancelClient.close();

// Missing optional SDK returns a fixed RPC failure and leaves process supervision intact.
const absentIn=new PassThrough(),absentOut=new PassThrough();
const absentRunner=runClaudeSdkRunner({input:absentIn,output:absentOut});
const absentClient=createJsonRpcTransport({readable:absentOut,writable:absentIn,framing:'acp-v1-jsonl'});
await assert.rejects(absentClient.request('initialize',{credential:'never-log',runtimePath:'/verified',cwd:'/fixture',tools:[]}),e=>e.code==='RPC_REMOTE_ERROR'&&!e.message.includes('never-log'));
await absentClient.request('shutdown');absentIn.end();await absentRunner;absentClient.close();
// A failed secret bootstrap must transfer handle ownership before it can fail.
const { existsSync } = await import('node:fs');
for (const closeRejects of [true, false]) {
  const root=mkdtempSync(join(tmpdir(),'claude-bootstrap-'));
  let stage, finishExit, safeToStop=false, closeCalls=0;
  const done=new Promise(resolve=>{finishExit=resolve;});
  let peer;
  const broken=createClaudeAgentProvider({taskOptions:{credentialRef:'fixture',verifiedRuntime:{verified:true,sdkResourcesVerified:true,binaryVerified:true,
    runtimePath:'/verified',security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true}},
    resolveTaskWorkspace:async()=>({task:{id:'t',workspaceId:'w'},workspace:{id:'w',root}})},resolveCredential:async()=> 'private',
    async launchSdkRunner(binding){stage=binding.cwd;const readable=new PassThrough(),writable=new PassThrough();
      peer=createJsonRpcTransport({readable:writable,writable:readable,framing:'acp-v1-jsonl',onRequest:async()=>{throw Error('bootstrap fixture');}});
      return {readable,writable,done,async close(){closeCalls++;if(closeRejects&&!safeToStop)throw Error('fixture close refused');}};
    }});
  try {
    const failure=await broken.createSession({taskId:'t',workspaceId:'w'}).then(()=>null,e=>e);
    assert.equal(failure?.code,'ACP_CLOSE_UNKNOWN');
    assert.equal(typeof failure.sessionId,'string');
    assert.equal(existsSync(stage),true,'staging must survive unconfirmed exit');
    safeToStop=true;finishExit();
    await broken.closeSession({sessionId:failure.sessionId});
    assert.equal(existsSync(stage),false);assert.ok(closeCalls>=2);
  } finally {peer?.close();finishExit();rmSync(root,{recursive:true,force:true});}
}
const { verifyClaudeSdkBytes } = await import('../src/agent/claude-sdk-resource.js');
assert.throws(()=>verifyClaudeSdkBytes(Buffer.from('untrusted')), /CLAUDE_SDK_RESOURCE_UNVERIFIED/);
const { compileClaudeSdkResource }=await import('./claude-sdk-resource.mjs');
const staticSdk=join(process.cwd(),'.superpowers/sdd/2026-10-22-agent-expansion-plan/claude-sdk-static/package');
if (existsSync(join(staticSdk,'sdk.mjs'))) {
  // Static write:false only: neither SDK module evaluation nor vendor process execution.
  const bytes=await compileClaudeSdkResource(staticSdk);
  assert.equal(verifyClaudeSdkBytes(bytes),bytes);
  const tampered=Buffer.from(bytes);tampered[0]^=1;
  assert.throws(()=>verifyClaudeSdkBytes(tampered),/CLAUDE_SDK_RESOURCE_UNVERIFIED/);
  console.log('Official SDK0.3.308 static resource bytes verified (SDK not executed)');
}
const {loadClaudeSdkResource}=await import('../src/agent/claude-sdk-resource.js');
await assert.rejects(loadClaudeSdkResource({resourceRoot:join(tmpdir(),'absent-claude-resource')}),e=>e.code==='CLAUDE_SDK_RESOURCE_UNVERIFIED');
assert.equal(captured.options.strictMcpConfig,true);
if(existsSync(join(staticSdk,'sdk.mjs'))) {
  const {mkdirSync,writeFileSync}=await import('node:fs');
  const {CLAUDE_SDK_RESOURCE_FILE}=await import('../src/agent/claude-sdk-resource.js');
  const fixtureRoot=mkdtempSync(join(tmpdir(),'claude-resource-fixture-'));
  try {
    const file=join(fixtureRoot,CLAUDE_SDK_RESOURCE_FILE);
    mkdirSync(join(fixtureRoot,'agent-sdk'),{recursive:true});
    writeFileSync(file,await compileClaudeSdkResource(staticSdk));
    const official=await loadClaudeSdkResource({resourceRoot:fixtureRoot});
    assert.equal(typeof official.query,'function');
    // Module evaluation only: no query, CLI, credential, account or model call.
  } finally {rmSync(fixtureRoot,{recursive:true,force:true});}
}
const { createClaudeSdkRunnerLauncher } = await import('../src/agent/claude-agent-provider.js');
const {EventEmitter}=await import('node:events');
let spawnArguments;
const fakeChild=new EventEmitter();fakeChild.stdout=new PassThrough();fakeChild.stdin=new PassThrough();fakeChild.stderr=new PassThrough();
const fakeLaunch=createClaudeSdkRunnerLauncher({executable:'C:/Product/Core.exe',sea:true,entry:'must-not-run.js',
  envSource:{PATH:'fixture-path',ANTHROPIC_API_KEY:'must-not-inherit',NODE_OPTIONS:'--inspect'},
  spawnImpl:(...args)=>{spawnArguments=args;return fakeChild;}});
let observedHandle;
const fakeHandle=await fakeLaunch({cwd:'C:/staging',onHandle:handle=>{observedHandle=handle;}});
assert.equal(observedHandle,fakeHandle);
assert.deepEqual(spawnArguments[1],['--agent-sdk-runner','claude']);
assert.equal(spawnArguments[0],'C:/Product/Core.exe');
assert.equal(spawnArguments[2].shell,false);
assert.equal(spawnArguments[2].env.ANTHROPIC_API_KEY,undefined);
assert.equal(spawnArguments[2].env.NODE_OPTIONS,undefined);
fakeChild.emit('close',0,null);await fakeHandle.close();await fakeHandle.done;
const runnerCwd=mkdtempSync(join(tmpdir(),'claude-source-runner-'));
try {
  const actual=await createClaudeSdkRunnerLauncher()({cwd:runnerCwd});
  let raw='';actual.readable.on('data',chunk=>{raw+=chunk.toString();});
  const connection=createJsonRpcTransport({readable:actual.readable,writable:actual.writable,framing:'acp-v1-jsonl'});
  await assert.rejects(connection.request('initialize',{credential:'source-fixture-only',runtimePath:'/not-launched',cwd:runnerCwd,tools:[]}),e=>e.code==='RPC_REMOTE_ERROR');
  actual.writable.end();
  assert.equal((await actual.done).exitCode,0);
  await actual.close();connection.close();
  assert.ok(!raw.includes('source-fixture-only'));
  assert.ok(raw.split('\n').filter(Boolean).every(line=>JSON.parse(line).jsonrpc==='2.0'));
  const {readdirSync}=await import('node:fs');assert.deepEqual(readdirSync(runnerCwd),[]);
}finally{rmSync(runnerCwd,{recursive:true,force:true});}
