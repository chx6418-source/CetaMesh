import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpProviders, createAcpProcessLauncher, discoverAcpRuntime } from '../src/agent/acp-provider-descriptors.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { createDefaultAgentService } from '../src/agent/service.js';
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
// A real synthetic subprocess validates raw pipes, early ownership and observed exit.
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'ACP 空格 fixture '));
try {
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
