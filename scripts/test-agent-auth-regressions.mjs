import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createAcpProcessLauncher} from '../src/agent/acp-provider-descriptors.js';
import {createConnectionLeases,createAgentRuntimeAuthService} from '../src/agent/runtime-auth-service.js';
import {createRuntimeAuthProfileStore} from '../src/agent/runtime-auth-profile.js';
import {createOpenCodeAuthAdapter} from '../src/agent/auth/opencode.js';
import {createGeminiAuthAdapter} from '../src/agent/auth/gemini.js';
import {createClaudeAuthAdapter,claudeAuthProfile} from '../src/agent/auth/claude.js';
import {createClaudeAgentProvider,createClaudeTaskRunnerLauncher} from '../src/agent/claude-agent-provider.js';
import {runClaudeSdkRunner} from '../src/agent/claude-sdk-runner.js';
import {createNativeAcpRuntime} from '../src/agent/native-acp-runtime.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-auth-regression-'));
const tick=()=>new Promise(r=>setImmediate(r));
const cases=[];const test=async(name,run)=>{try{await run();console.log('PASS '+name);}catch(error){cases.push(name);console.error('FAIL '+name+': '+error.message);}};
const evidence={version:'opencode v2.1.4',target:{executable:process.execPath,argsPrefix:[]},validate(){}};
const cap=adapter=>({...adapter,describe:()=>{const value=adapter.describe();return {...value,methods:value.methods.map(m=>({...m,supported:true}))};}});
function setup(provider='opencode') {
 const leases=createConnectionLeases();const config={provider,enabled:true,authMode:'provider-login',revision:1,providerId:provider==='opencode'?'openai':null,methodId:provider==='opencode'?'chatgpt-headless':null,model:'fixture',runtimePath:process.execPath,nodePath:'',baseUrl:'https://api.openai.com/v1'};
 const configuration={get:()=>({...config,authorizationEpoch:leases.epoch(provider)}),identity:()=>JSON.stringify([config,leases.epoch(provider)]),resolveCredential(){throw Error('Account mode may not resolve API key');}};
 const store=createRuntimeAuthProfileStore({stateDir:path.join(root,crypto.randomUUID()),connectionLeases:leases});
 return {leases,configuration,store};
}
const connections=JSON.stringify([{id:'openai',name:'fixture',connections:[{type:'credential',id:'owned',label:'fixture',method:'oauth'}]}]);
try {
 for(const provider of ['opencode','claude'])for(const passive of [false,true])await test('R1 '+provider+' '+(passive?'passive':'post-login')+' metadata subprocess keeps ownership',async()=>{
  const {leases,configuration,store}=setup(provider);let unknown=!passive,finishStatus;
  const adapter=cap((provider==='opencode'?createOpenCodeAuthAdapter:createClaudeAuthAdapter)({configuration,runtime:async()=>provider==='opencode'?evidence:{...evidence,version:'2.1.308',runtimePath:process.execPath,binaryVerified:true,sdkResourcesVerified:true},transport:{
   start(spec,{onHandle}){const handle={done:Promise.resolve({exitCode:0}),async close(){}};onHandle(handle);return handle;},
   async run(spec,{onHandle}={}){if(!unknown)return {exitCode:0,stdout:provider==='opencode'?connections:JSON.stringify({loggedIn:true,authMethod:'claude.ai',configDirectory:path.join(spec.root,'config')})};const handle={done:new Promise(r=>finishStatus=r),async close(){throw Object.assign(Error('synthetic status exit unknown'),{code:'ACP_CLOSE_UNKNOWN'});}};onHandle?.(handle);throw Object.assign(Error('synthetic status exit unknown'),{code:'ACP_CLOSE_UNKNOWN'});}
  }}));
  const service=createAgentRuntimeAuthService({configuration,connectionLeases:leases,profileStore:store,deadlineMs:50,adapters:{[provider]:adapter}});
  let value=await service.start({provider,expectedRevision:1,methodId:provider==='opencode'?'chatgpt-headless':'claude-subscription'});await tick();await tick();
  if(passive){assert.equal((await service.status({provider,attemptId:value.attemptId})).state,'session-present');unknown=true;value=await service.describe(provider);}
  value=await service.status({provider,attemptId:value.attemptId});assert.equal(value.state,'exit-unconfirmed');
  assert.throws(()=>leases.reserve({provider,kind:'task',expectedEpoch:leases.epoch(provider)}),{code:'AGENT_RUNTIME_BUSY'});
  assert.equal((await service.cancel({provider,attemptId:value.attemptId})).state,'exit-unconfirmed');
  finishStatus({exitCode:0});await tick();await tick();assert.equal((await service.status({provider,attemptId:value.attemptId})).state,'cancelled');await service.close();
 });
 for(const provider of ['opencode','gemini','claude'])await test('R2 '+provider+' Cancel during verification fences launch',async()=>{
  const {leases,configuration,store}=setup(provider);let resolveRuntime,spawns=0;
  const factory={opencode:createOpenCodeAuthAdapter,gemini:createGeminiAuthAdapter,claude:createClaudeAuthAdapter}[provider];
  const adapter=cap(factory({configuration,runtime:()=>new Promise(r=>resolveRuntime=r),transport:{start(spec,{onHandle}){spawns++;let finish;const handle={readable:new PassThrough(),writable:new PassThrough(),done:new Promise(r=>finish=r),async close(){finish({exitCode:0});}};onHandle?.(handle);return handle;}}}));
  const service=createAgentRuntimeAuthService({configuration,connectionLeases:leases,profileStore:store,deadlineMs:50,adapters:{[provider]:adapter}});
  const methodId={opencode:'chatgpt-headless',gemini:'oauth-personal',claude:'claude-subscription'}[provider];
  const starting=service.start({provider,expectedRevision:1,methodId});await tick();const snapshot=await service.describe(provider),cancelled=service.cancel({provider,attemptId:snapshot.attemptId});
  resolveRuntime(provider==='opencode'?evidence:provider==='gemini'?{...evidence,version:'0.65.0',packageIdentity:'fixture',argv:['--acp']}:{version:'2.1.308',runtimePath:process.execPath,binaryVerified:true,sdkResourcesVerified:true,validate(){}});
  await starting;await cancelled;assert.equal(spawns,0);await service.close();
 });
 await test('R1 cancellation is bounded when a subprocess close never settles',async()=>{
  const {leases,configuration,store}=setup();let finish;
  const adapter=cap(createOpenCodeAuthAdapter({configuration,runtime:async()=>evidence,transport:{start(spec,{onHandle}){const h={done:new Promise(r=>finish=r),close:()=>new Promise(()=>{})};onHandle(h);return h;}}}));
  const service=createAgentRuntimeAuthService({configuration,connectionLeases:leases,profileStore:store,deadlineMs:500,exitWaitMs:20,adapters:{opencode:adapter}});
  const auth=await service.start({provider:'opencode',expectedRevision:1,methodId:'chatgpt-headless'});
  assert.equal((await service.cancel({provider:'opencode',attemptId:auth.attemptId})).state,'exit-unconfirmed');
  assert.throws(()=>leases.reserve({provider:'opencode',kind:'task',expectedEpoch:leases.epoch('opencode')}),{code:'AGENT_RUNTIME_BUSY'});
  finish({exitCode:0});await tick();await tick();await service.close();
 });
 await test('R2 runtime discovery owns every helper and fences subsequent launches',async()=>{
  const {configuration}=setup();const controller=new AbortController();let spawns=0,captured=0;
  const runtime=createNativeAcpRuntime({id:'opencode',runtimeConfiguration:configuration,launchFactory:()=>()=>{
   spawns++;const readable=new PassThrough();let finish;const h={readable,done:new Promise(r=>finish=r),async close(){}};
   setImmediate(()=>{controller.abort();readable.end('opencode v2.1.4');finish({exitCode:0});});return h;
  }});
  const result=await runtime.inspect({signal:controller.signal,onHandle(){captured++;}});
  assert.equal(spawns,1);assert.equal(captured,1);assert.equal(result.compatible,false);
 });
 await test('R3 Claude rejects project and unrecognized policy files',async()=>{
  for(const name of ['.claude/settings.local.json','.claude/settings.json','.mcp.json','CLAUDE.md','config/unrecognized-policy.json']){
   const {store}=setup('claude');const owned=store.createGeneration('claude'),profile=claudeAuthProfile(owned,{initialize:true});const file=path.join(owned.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{"hooks":{}}');assert.throws(()=>profile.validate(),{code:'AGENT_RUNTIME_CHANGED'},name);
  }
 });
 await test('R6 exact catalog joins service to real OpenCode adapter; R7 promoted task profile reused',async()=>{
  const {leases,configuration,store}=setup();const adapter=cap(createOpenCodeAuthAdapter({configuration,runtime:async()=>evidence,transport:{start(spec,{onHandle}){const h={done:Promise.resolve({exitCode:0}),async close(){}};onHandle(h);return h;},async run(){return {exitCode:0,stdout:connections};}}}));
  const service=createAgentRuntimeAuthService({configuration,connectionLeases:leases,profileStore:store,deadlineMs:50,adapters:{opencode:adapter}});
  const auth=await service.start({provider:'opencode',expectedRevision:1,methodId:'chatgpt-headless'});await tick();await tick();assert.equal((await service.status({provider:'opencode',attemptId:auth.attemptId})).state,'session-present');
  const promoted=store.current('opencode');let lastEnvironment;
  const launchFactory=spec=>createAcpProcessLauncher({...spec,spawnImpl(command,argv,options){
   lastEnvironment=options.env;const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.stderr=new PassThrough();
   child.stdin.on('data',chunk=>{const q=JSON.parse(String(chunk));child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:1,agentInfo:{name:'OpenCode',version:'2.1.4'}}})+'\n');});
   setImmediate(()=>{if(argv.includes('--version')||argv.includes('--help'))child.stdout.end(argv.includes('--version')?'opencode v2.1.4':'  acp  Start ACP');child.emit('close',0);});return child;
  }});
  const runtime=createNativeAcpRuntime({id:'opencode',runtimeConfiguration:configuration,launchFactory,envSource:{...process.env,CODEX_HOME:'/unowned/codex',Codex_Home:'/unowned/mixed-case',GOOGLE_APPLICATION_CREDENTIALS:'/unowned/google',GOOGLE_CLOUD_ACCESS_TOKEN:'unowned',GEMINI_FORCE_ENCRYPTED_FILE_STORAGE:'true',OPENAI_API_KEY:'unowned'},resolveAuthProfile:provider=>service.taskProfile(provider)});
  const checked=await runtime.inspect();assert.notEqual(checked.reason,null,'public execution gate remains closed');
  assert.equal(lastEnvironment.CODEX_HOME,undefined,'account discovery cannot inherit another runtime profile');
  const taskLease=leases.reserve({provider:'opencode',kind:'task',expectedEpoch:leases.epoch('opencode')});
  const handle=await checked.launch({cwd:root});assert.equal(lastEnvironment.HOME,promoted.root);assert.equal(lastEnvironment.CETAMESH_AGENT_API_KEY,undefined);for(const key of ['CODEX_HOME','Codex_Home','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_ACCESS_TOKEN','GEMINI_FORCE_ENCRYPTED_FILE_STORAGE','OPENAI_API_KEY'])assert.equal(lastEnvironment[key],undefined,'account effective child env: '+key);
  const pointer=path.join(path.dirname(promoted.root),'current.json'),original=fs.readFileSync(pointer),replacement=store.createGeneration('opencode');
  fs.writeFileSync(pointer,JSON.stringify({...JSON.parse(original),generationId:replacement.generationId}));assert.throws(()=>checked.validateRuntime(),{code:'AGENT_RUNTIME_CHANGED'});fs.writeFileSync(pointer,original);
  await handle.close();taskLease.release({exitConfirmed:true});assert.equal(fs.existsSync(promoted.root),true);
  await service.close();
 });
 await test('R7 Claude promoted generation reaches task SDK without API credentials',async()=>{
  const {leases,configuration,store}=setup('claude');const adapter=cap(createClaudeAuthAdapter({runtime:async()=>({version:'2.1.308',runtimePath:process.execPath,binaryVerified:true,sdkResourcesVerified:true,validate(){}}),transport:{
   start(spec,{onHandle}){const h={done:Promise.resolve({exitCode:0}),async close(){}};onHandle(h);return h;},
   async run(spec){return {exitCode:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',configDirectory:path.join(spec.root,'config')})};}
  }}));
  const authService=createAgentRuntimeAuthService({configuration,connectionLeases:leases,profileStore:store,adapters:{claude:adapter}});
  const auth=await authService.start({provider:'claude',expectedRevision:1,methodId:'claude-subscription'});await tick();await tick();assert.equal((await authService.status({provider:'claude',attemptId:auth.attemptId})).state,'session-present');
  const profile=authService.taskProfile('claude'),source=path.join(root,'task-source');fs.mkdirSync(source);let options;
  const provider=createClaudeAgentProvider({taskOptions:{authMode:'provider-login',verifiedRuntime:{verified:true,sdkResourcesVerified:true,binaryVerified:true,runtimePath:'/synthetic/claude',tools:['Read'],security:{mode:'native-permissions',verified:true,nativeSandboxSupported:false,strictIsolationVerified:false,nativeApprovalSupported:true,nativePermissionPolicyVerified:true,allToolsRequireApproval:true,nativeSandboxMode:'none'}},validateRuntime:()=>profile.validate(),resolveTaskWorkspace:async()=>({task:{id:'t',workspaceId:'w'},workspace:{id:'w',root:source}})},
   resolveCredential(){throw Error('Account task resolved API key');},requestNativeApproval:async()=>({outcome:'rejected'}),
   launchSdkRunner:createClaudeTaskRunnerLauncher({authMode:'provider-login',resolveAuthProfile:()=>authService.taskProfile('claude'),validateRuntime:()=>profile.validate(),createRunner:()=>()=>{const readable=new PassThrough(),writable=new PassThrough(),done=runClaudeSdkRunner({input:writable,output:readable,loadSdk:async()=>({query(args){options=args.options;return {async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',session_id:'fixture'};},async interrupt(){}};}})});return {readable,writable,done,async close(){writable.end();await done;}};}})
  });
  const session=await provider.createSession({taskId:'t',workspaceId:'w'});await provider.send({sessionId:session.sessionId,content:'synthetic only'});
  for(let i=0;i<100&&(await provider.status({sessionId:session.sessionId})).running;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(options.env.CLAUDE_CONFIG_DIR,path.join(store.current('claude').root,'config'));assert.equal(options.env.ANTHROPIC_API_KEY,undefined);assert.equal(options.env.ANTHROPIC_BASE_URL,undefined);assert.deepEqual(options.settingSources,[]);assert.deepEqual(options.allowedTools,[]);assert.equal(typeof options.hooks.PreToolUse[0].hooks[0],'function');
  await provider.closeSession({sessionId:session.sessionId});assert.equal(fs.existsSync(profile.root),true);await provider.shutdown();await authService.close();
 });
} finally {fs.rmSync(root,{recursive:true,force:true});}
if(cases.length)throw Error(cases.length+' auth regression cases failed');
