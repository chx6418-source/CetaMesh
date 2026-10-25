import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpProviders, createAcpProcessLauncher, discoverAcpRuntime } from '../src/agent/acp-provider-descriptors.js';
import { acpArgumentsFromHelp, createNativeAcpProfile, openCodeNativePolicy } from '../src/agent/native-acp-runtime.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { createDefaultAgentService } from '../src/agent/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createAgentInstallationDetector } from '../src/agent/installation-discovery.js';
const missing = createAcpProviders({ runtimeResolver: () => null });
assert.deepEqual(missing.map(p=>p.id), ['gemini','opencode','qwen']);
for (const p of missing) { assert.equal((await p.health()).available,false); assert.equal((await p.health()).reason,'not_installed'); }
for (const runtime of [{executable:process.execPath,version:'unknown'}, {executable:process.execPath,version:'1',compatible:true}, {executable:process.execPath,version:'1',compatible:true,securityVerified:true,argv:['--evil']}]) {
 for (const p of createAcpProviders({runtimeResolver:()=>runtime})) assert.equal((await p.health()).taskEligible,false);
}
const forged=createAcpProviders({runtimeResolver:()=>null,taskOptions:{descriptor:{id:'forged',label:'Forged',protocolVersion:1,verifiedRuntime:true,security:{verified:true,mode:'native',nativeSandboxSupported:true,nativeApprovalSupported:true}},launch(){throw Error('Must not launch');},resolveTaskWorkspace(){}}});
assert.deepEqual(forged.map(p=>p.id),['gemini','opencode','qwen']);
for(const p of forged) {assert.equal(p.capabilities().supportsFreshSession,false);await assert.rejects(p.createSession({taskId:'t',workspaceId:'w'}),{code:'PROVIDER_UNAVAILABLE'});}
let resolutions=0;
const inspected=createAcpProviders({runtimeResolver:id=>{resolutions++;return id==='opencode' ? {executable:process.execPath,version:'fixture-version',compatible:true,securityVerified:false} : null;}});
assert.equal(resolutions,3);
assert.equal((await inspected[1].health()).reason,'native_policy_unverified');
assert.equal((await inspected[0].health()).reason,'not_installed');
const verified=createAcpProviders({runtimeResolver:()=>({executable:process.execPath,version:'fixture-version',compatible:true,securityVerified:true,security:{verified:true,mode:'native',nativeSandboxSupported:true,nativeApprovalSupported:true}}),taskOptions:{resolveTaskWorkspace(){throw Error('Health must not create a session');}}});
assert.equal((await verified[1].health()).readyForTask,true);
assert.equal((await verified[2].health()).readyForTask,true);
assert.equal((await verified[0].health()).available,false); // No guessed Gemini launch flags.
const service=createDefaultAgentService({acpOptions:{runtimeResolver:()=>null},codexExecutable:'missing-fixture-cli',zcodeOptions:{desktopDetected:false}});
try {
 const {providers}=await service.execute({method:'agent.list'});
 assert.deepEqual(providers.map(p=>p.id),['dsh','codex','claude','gemini','opencode','qwen','zcode','workbuddy']);
 for(const id of ['claude','gemini','opencode','qwen','workbuddy']) assert.equal(providers.find(p=>p.id===id).available,false);
 await assert.rejects(service.execute({method:'agent.configure',params:{provider:'qwen',settings:{argv:['--evil']}}}), /Unsupported|unsupported/i);
 await assert.rejects(service.execute({method:'agent.sendLocal',params:{provider:'workbuddy'}}),{code:'METHOD_NOT_FOUND'});
} finally {service.close();}
// Desktop client installation is distinct from a usable Agent CLI or native policy.
const refreshRequests=[];
const detectedService=createDefaultAgentService({acpOptions:{runtimeResolver:()=>null},codexExecutable:'missing-fixture-cli',zcodeOptions:{desktopDetected:false},
 installationStatus:async(id,{refresh}={})=>{refreshRequests.push(refresh);return {cliInstalled:false,desktopApp:{installed:true,displayName:id+' Desktop',status:'installed',version:'1.2.3'}};}});
try {
 const {providers}=await detectedService.execute({method:'agent.list',params:{refresh:true}});
 for(const id of ['claude','gemini','opencode','qwen']) {
  const row=providers.find(item=>item.id===id);
  assert.equal(row.installed,true,id+' desktop client must count as installed');
  assert.equal(row.cliInstalled,false);assert.equal(row.available,false);
  assert.equal(row.desktopApp.installed,true);assert.equal(row.desktopApp.displayName,id+' Desktop');
  assert.equal(row.reason,id==='claude'?'runtime_security_unverified':'desktop_cli_missing');
 }
 const ui=createDesktopUiService({services:{agentService:detectedService}});
 const projected=(await ui.execute({method:'ui.agent.list',params:{refresh:true}})).agents;
 assert.deepEqual(refreshRequests.slice(-4),[true,true,true,true],'global refresh must reach every installation detector');
 for(const id of ['claude','gemini','opencode','qwen']) {
  const row=projected.find(item=>item.id===id);assert.equal(row.installed,true);assert.equal(row.cliInstalled,false);
  assert.equal(row.status,'connection-pending');assert.equal(row.desktopApp.displayName,id+' Desktop');assert.equal(row.taskEligible,false);
 }
} finally {detectedService.close();}
const verifiedClaudeService=createDefaultAgentService({acpOptions:{runtimeResolver:()=>null},codexExecutable:'missing-fixture-cli',zcodeOptions:{desktopDetected:false},
 installationStatus:async()=>({cliInstalled:false,desktopApp:{installed:false,status:'not-installed'}}),
 claudeOptions:{taskOptions:{verifiedRuntime:{verified:true,sdkResourcesVerified:true,binaryVerified:true,runtimePath:'/explicit/verified/claude',
  security:{verified:true,mode:'native',nativeSandboxSupported:true,nativeApprovalSupported:true}},resolveTaskWorkspace(){throw Error('Health must not execute a task');}},resolveCredential(){throw Error('Health must not resolve credentials');}}});
try {
 const ui=createDesktopUiService({services:{agentService:verifiedClaudeService}});
 const row=(await ui.execute({method:'ui.agent.list'})).agents.find(item=>item.id==='claude');
 assert.equal(row.available,true,'healthy explicitly verified runtime must survive absent Desktop/PATH metadata');
 assert.equal(row.installed,true);assert.equal(row.cliInstalled,false);assert.equal(row.taskEligible,true);assert.equal(row.status,'ready');
} finally {verifiedClaudeService.close();}
const uncertainService=createDefaultAgentService({acpOptions:{runtimeResolver:()=>null},codexExecutable:'missing-fixture-cli',zcodeOptions:{desktopDetected:false},installationStatus:async()=>{throw Error('fixture access denied');}});
try {
 const ui=createDesktopUiService({services:{agentService:uncertainService}});
 const rows=(await ui.execute({method:'ui.agent.list'})).agents;
 for(const id of ['claude','gemini','opencode','qwen']) {
  const row=rows.find(item=>item.id===id);assert.equal(row.installed,null);assert.notEqual(row.status,'not-installed');
 }
} finally {uncertainService.close();}
// A real synthetic subprocess validates raw pipes, early ownership and observed exit.
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'ACP 空格 fixture '));
try {
 const local=path.join(cwd,'Local App Data');fs.mkdirSync(local);
 let clock=0,storeCalls=0;
 const detection=createAgentInstallationDetector({platform:'win32',env:{LOCALAPPDATA:local},findCli:()=>null,storeQuery:async()=>null,now:()=>clock});
 assert.equal((await detection('gemini')).desktopApp.installed,false);
 const gemini=path.join(local,'Google','Gemini','Gemini.exe');fs.mkdirSync(path.dirname(gemini),{recursive:true});fs.writeFileSync(gemini,'fixture metadata only');
 assert.equal((await detection('gemini')).desktopApp.installed,false,'cache remains bounded until refresh');
 assert.equal((await detection('gemini',{refresh:true})).desktopApp.installed,true,'check connection detects an install without Core restart');
 fs.unlinkSync(gemini);clock=30001;
 assert.equal((await detection('gemini')).desktopApp.installed,false,'cache expiry observes removal');
 const qwen=path.join(local,'Programs','Qwen','Qwen.exe');fs.mkdirSync(qwen,{recursive:true});
 assert.equal((await detection('qwen')).desktopApp.installed,false,'a folder named like a binary is not installation evidence');
 const classicClaude=path.join(local,'Claude');fs.mkdirSync(classicClaude);fs.mkdirSync(path.join(classicClaude,'logs'));
 assert.equal((await detection('claude')).desktopApp.installed,false,'leftover data/log folders must not imply an installed application');
 const storeRoot=path.join(cwd,'Store Claude');fs.mkdirSync(path.join(storeRoot,'app'),{recursive:true});fs.writeFileSync(path.join(storeRoot,'app','claude.exe'),'metadata only');
 const store=createAgentInstallationDetector({platform:'win32',env:{LOCALAPPDATA:local},findCli:()=>null,storeQuery:async()=>{storeCalls++;return {name:'Claude',root:storeRoot,version:'3.6556.2.0'};}});
 const installedStore=await store('claude');assert.equal(installedStore.desktopApp.installed,true);assert.equal(installedStore.desktopApp.version,'3.6556.2.0');assert.equal(installedStore.cliInstalled,false);
 await store('claude');assert.equal(storeCalls,1);await store('claude',{refresh:true});assert.equal(storeCalls,2);
 const denied=createAgentInstallationDetector({platform:'win32',env:{LOCALAPPDATA:local},findCli:()=>{throw Error('denied');},stat(){throw Object.assign(Error('denied'),{code:'EACCES'});},storeQuery:async()=>{throw Error('denied');}});
 assert.equal((await denied('opencode')).desktopApp.installed,null);assert.equal((await denied('claude')).desktopApp.installed,null);assert.equal((await denied('claude')).cliInstalled,null);
 console.log('PASS desktop installation evidence, Store package, forced refresh, cache expiry and unknown access');
 // Failed spawn still has an observed close: cleanup must not retain forever.
 const failed=createAcpProcessLauncher({executable:path.join(cwd,'does-not-exist.exe'),argv:[]})({cwd});
 const failedClose=failed.close();
 const result=await failed.done;await failedClose;
 assert.equal(result.startFailed,true);assert.equal(result.error.code,'PROCESS_START_FAILED');
 let failedStage;
 const absentLaunch=createAcpProcessLauncher({executable:path.join(cwd,'no-agent-runtime.exe'),argv:[]});
 const absentProvider=createAcpAgentProvider({descriptor:{id:'failed-spawn-fixture',label:'Fixture',protocolVersion:1,verifiedRuntime:true,
   security:{verified:true,mode:'native',nativeSandboxSupported:true,nativeApprovalSupported:true}},
   resolveTaskWorkspace:({taskId,workspaceId})=>({task:{id:taskId,workspaceId},workspace:{id:workspaceId,root:cwd}}),
   launch:args=>{failedStage=args.cwd;return absentLaunch(args);}});
 await assert.rejects(absentProvider.createSession({taskId:'t',workspaceId:'w'}),error=>error.code!=='ACP_CLOSE_UNKNOWN');
 assert.equal(fs.existsSync(failedStage),false);await absentProvider.shutdown();
 const fake=new EventEmitter();fake.stdout=new PassThrough();fake.stdin=new PassThrough();fake.stderr=new PassThrough();
 fake.kill=()=>{throw Error('Invalid PID must never be killed');};
 const synthetic=createAcpProcessLauncher({executable:'fixture',argv:[],spawnImpl:()=>fake})({cwd});
 const closing=synthetic.close();let confirmed=false;synthetic.done.then(()=>confirmed=true);
 fake.emit('error',new Error('fixture spawn error'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(confirmed,false);
 fake.emit('close',-1,null);await closing;assert.equal((await synthetic.done).startFailed,true);
 let captured;
 const launch=createAcpProcessLauncher({executable:process.execPath,argv:['-e',"process.stdin.once('data',()=>{process.stdout.write('中文:'+String(process.env.EVIL_SECRET));process.exit(0)})"],envSource:{...process.env,EVIL_SECRET:'must-not-inherit'}});
 const handle=launch({cwd,onHandle:value=>{captured=value;}});
 assert.equal(handle,captured);
 let output='';handle.readable.setEncoding('utf8');handle.readable.on('data',chunk=>output+=chunk);
 handle.writable.write('fixture');
 assert.equal((await handle.done).exitCode,0);await handle.close();assert.equal(output,'中文:undefined');
 const waiting=createAcpProcessLauncher({executable:process.execPath,argv:['-e','setInterval(()=>{},1000)']})({cwd});
 let exited=false;waiting.done.then(()=>{exited=true;});await waiting.close();assert.equal(exited,true);
 const missing=discoverAcpRuntime('cetamesh-nonexistent-acp-fixture');assert.equal(missing,null);
} finally {fs.rmSync(cwd,{recursive:true,force:true});}
console.log('ACP descriptors and eight-provider composition PASS');
// Production configuration must control availability without reading private credentials.
let credentialReads=0;
const disabledConfiguration={get:provider=>({provider,enabled:false,runtimePath:'',nodePath:'',model:'',credentialConfigured:false,executionMode:'native-permissions',revision:0}),identity:()=> 'disabled',resolveCredential(){credentialReads++;throw Error('Health may not read credentials');},configure:()=>({supported:true})};
const disabledConfigured=createAcpProviders({runtimeConfiguration:disabledConfiguration});
for(const item of disabledConfigured) assert.equal((await item.health()).reason,'runtime_disabled');
assert.equal(credentialReads,0);
assert.deepEqual(acpArgumentsFromHelp('gemini','  --experimental-acp  Enable experimental ACP'),['--experimental-acp']);
assert.deepEqual(acpArgumentsFromHelp('gemini','  --acp   Start ACP'),['--acp']);
assert.equal(acpArgumentsFromHelp('gemini','  --acp-unsafe Start something else'),null);
assert.equal(acpArgumentsFromHelp('qwen','  --experimental-acp Start ACP'),null);
assert.deepEqual(acpArgumentsFromHelp('qwen','  --acp  Start ACP'),['--acp']);
assert.throws(()=>openCodeNativePolicy({model:'fixture',baseUrl:'http://example.invalid/v1'}),{code:'AGENT_ENDPOINT_INVALID'});
const profileParent=fs.mkdtempSync(path.join(os.tmpdir(),'native-policy-fixture-'));
try {
 const profile=createNativeAcpProfile({id:'opencode',configuration:{model:'fixture',baseUrl:'https://example.invalid/v1'},profileParent});
 try {
  profile.validate();
  const file=path.join(profile.root,'.config','opencode','opencode.json');
  assert.equal(fs.readFileSync(file,'utf8').includes('{env:CETAMESH_AGENT_API_KEY}'),true);
  fs.writeFileSync(path.join(profile.root,'.config','opencode','opencode.jsonc'),'{"permissions":[{"action":"*","resource":"*","effect":"allow"}]}');
  assert.throws(()=>profile.validate(),{code:'AGENT_RUNTIME_CHANGED'},'additional runtime policy cannot override the owned profile');
  fs.unlinkSync(path.join(profile.root,'.config','opencode','opencode.jsonc'));
  fs.writeFileSync(file,'{}');assert.throws(()=>profile.validate(),{code:'AGENT_RUNTIME_CHANGED'});
  fs.unlinkSync(file);assert.throws(()=>profile.validate(),{code:'AGENT_RUNTIME_CHANGED'},'deleted policy is a runtime identity change');
 } finally {await profile.cleanup();}
 assert.equal(fs.readdirSync(profileParent).length,0);
} finally {fs.rmSync(profileParent,{recursive:true,force:true});}
console.log('PASS configured runtime opt-out, observed ACP flags, private policy profile and tamper rejection');

// Native permission policy is kept in a private disposable profile; it contains
// no credential bytes and cannot inherit user/project hooks or auto-approval.
for (const id of ['gemini', 'qwen']) {
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-policy-profile-'));
 let profile;
 try {
  profile=createNativeAcpProfile({id,configuration:{model:'fixture',baseUrl:'https://example.test/v1'},profileParent:parent});
  const home=id==='gemini'?profile.environment.GEMINI_CLI_HOME:profile.environment.QWEN_HOME;
  assert.equal(typeof home,'string',id+' must explicitly redirect its CLI home');
  assert.ok(home.startsWith(profile.root+path.sep));
  const systemFile=id==='gemini'?profile.environment.GEMINI_CLI_SYSTEM_SETTINGS_PATH:profile.environment.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  const settings=JSON.parse(fs.readFileSync(systemFile,'utf8'));
  assert.equal(settings.security.auth.selectedType,id==='gemini'?'gemini-api-key':'openai');
  if(id==='gemini') {
   assert.equal(settings.admin.secureModeEnabled,true);assert.equal(settings.admin.extensions.enabled,false);
   assert.equal(settings.admin.mcp.enabled,false);assert.equal(settings.hooksConfig.enabled,false);
   assert.ok(profile.argv.includes('--admin-policy'));
   const policy=fs.readFileSync(profile.argv[profile.argv.indexOf('--admin-policy')+1],'utf8');
   assert.match(policy,/decision = "ask_user"/);assert.match(policy,/toolName = "\*"/);
  } else {
   assert.equal(settings.disableAllHooks,true);assert.ok(settings.permissions.ask.includes('read_file'));
   assert.ok(settings.permissions.ask.includes('run_shell_command'));assert.ok(settings.permissions.ask.includes('write_file'));
   assert.ok(settings.permissions.deny.includes('agent'));assert.deepEqual(settings.mcp.excluded,['*']);
   assert.equal(profile.argv.includes('--safe-mode'),false);assert.equal(profile.argv.includes('--bare'),false);
  }
  assert.equal(JSON.stringify(settings).includes('apiKey'),false,'private settings refer to environment credentials only');
  profile.validate();const identity=profile.identity;
  fs.writeFileSync(systemFile,JSON.stringify({...settings,permissions:{allow:['read_file']}}));
  assert.throws(()=>profile.validate(),{code:'AGENT_RUNTIME_CHANGED'},id+' detects replaced policy before execution');
  assert.equal(profile.identity,identity,'policy mutations never mint fresh authority');
 } finally {await profile?.cleanup();assert.deepEqual(fs.readdirSync(parent),[]);fs.rmdirSync(parent);}
}

const nativeEnvRoot=fs.mkdtempSync(path.join(os.tmpdir(),'native-env-fixture-'));
try {
 const handle=createAcpProcessLauncher({executable:process.execPath,argv:['-e','process.stdout.write(process.env.GEMINI_CLI_HOME+"|"+process.env.QWEN_HOME+"|"+process.env.GEMINI_API_KEY+"|"+process.env.OPENAI_API_KEY)'],
  envSource:{...process.env,GEMINI_API_KEY:'unowned-must-not-inherit',OPENAI_API_KEY:'unowned-must-not-inherit'},trustedEnvironment:{GEMINI_CLI_HOME:'private-gemini',QWEN_HOME:'private-qwen',GEMINI_API_KEY:'synthetic-gemini',OPENAI_API_KEY:'synthetic-qwen'}})({cwd:nativeEnvRoot});
 let output='';handle.readable.setEncoding('utf8');handle.readable.on('data',chunk=>output+=chunk);
 try {assert.equal((await handle.done).exitCode,0);assert.equal(output,'private-gemini|private-qwen|synthetic-gemini|synthetic-qwen');}finally{await handle.close();}
 assert.throws(()=>createAcpProcessLauncher({executable:process.execPath,argv:[],trustedEnvironment:{NODE_OPTIONS:'--import=unapproved'}})({cwd:nativeEnvRoot}),{code:'ACP_ENVIRONMENT_INVALID'});
}finally{fs.rmSync(nativeEnvRoot,{recursive:true,force:true});}

for(const [model,credentialConfigured,want] of [['',false,'agent_model_required'],['fixture',false,'agent_credential_required']]) {
 const providers=createAcpProviders({runtimeConfiguration:{get:provider=>({provider,enabled:provider==='opencode',runtimePath:process.execPath,nodePath:'',model,credentialConfigured,baseUrl:'https://example.test/v1'}),identity:()=>model+credentialConfigured,resolveCredential(){throw Error('Health cannot read a credential');}},
  launchFactory(){throw Error('An incomplete explicit setup must not launch a runtime');}});
 try {const health=await providers.find(item=>item.id==='opencode').health();assert.equal(health.reason,want);assert.equal(health.installed,true);assert.equal(health.taskEligible,false);}finally{await Promise.all(providers.map(item=>item.shutdown()));}
}

const corruptConfigured=createAcpProviders({runtimeConfiguration:{get(){throw Object.assign(Error('Malformed saved runtime configuration'),{code:'AGENT_RUNTIME_CONFIG_CORRUPT'});},identity(){throw Error('Must not reset corrupted configuration');},configure(){throw Error('Must not repair implicitly');}}});
for(const item of corruptConfigured){assert.doesNotThrow(()=>item.capabilities());const health=await item.health();assert.equal(health.available,false);assert.equal(health.taskEligible,false);assert.equal(health.reason,'AGENT_RUNTIME_CONFIG_CORRUPT');}
await Promise.all(corruptConfigured.map(item=>item.shutdown()));

assert.deepEqual(acpArgumentsFromHelp('opencode','  --standalone  Run with a private server\n  acp  Start an Agent Client Protocol server'),['acp'],'top-level --standalone is not an ACP flag; actual help skips unknown-flag validation');
assert.deepEqual(acpArgumentsFromHelp('opencode','  acp  Start an Agent Client Protocol server'),['acp'],'OpenCode v2 ACP starts a private server by construction');
const {geminiQwenPackageIdentity}=await import('../src/agent/gemini-qwen-runtime.js');
assert.equal(typeof geminiQwenPackageIdentity,'function','native npm authority must fingerprint loaded chunks and dependencies');
const packageFixture=fs.mkdtempSync(path.join(os.tmpdir(),'native-package-identity-'));
try {
 const moduleRoot=path.join(packageFixture,'node_modules'),packageRoot=path.join(moduleRoot,'@qwen-code','qwen-code'),entry=path.join(packageRoot,'cli-entry.js'),chunk=path.join(packageRoot,'chunks','core.js');
 fs.mkdirSync(path.dirname(chunk),{recursive:true});fs.writeFileSync(entry,'export {};');fs.writeFileSync(chunk,'export const policy="ask";');
 fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'@qwen-code/qwen-code',version:'0.26.1',bin:{qwen:'cli-entry.js'},optionalDependencies:{'native-fixture':'1.0.0'}}));
 const dependency=path.join(moduleRoot,'native-fixture');fs.mkdirSync(dependency);fs.writeFileSync(path.join(dependency,'package.json'),JSON.stringify({name:'native-fixture',version:'1.0.0',main:'index.js'}));fs.writeFileSync(path.join(dependency,'index.js'),'export {};');
 const first=geminiQwenPackageIdentity('qwen',entry);fs.writeFileSync(chunk,'export const policy="allow";');const changedChunk=geminiQwenPackageIdentity('qwen',entry);assert.notEqual(changedChunk,first);
 fs.writeFileSync(path.join(dependency,'index.js'),'export const changed=true;');assert.notEqual(geminiQwenPackageIdentity('qwen',entry),changedChunk,'native dependency changes invalidate consent too');
}finally{fs.rmSync(packageFixture,{recursive:true,force:true});}
