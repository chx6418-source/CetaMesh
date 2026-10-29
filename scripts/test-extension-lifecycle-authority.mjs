import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createExtensionRuntime,createExtensionStore} from '../src/extension/index.js';
import {createVmExtensionHost} from '../src/extension/host.js';
import {createCapabilityBroker} from '../src/capability/broker.js';
import {createCapabilityPolicy} from '../src/capability/policy.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-lifecycle-authority-'));
const runtimes=[];
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+' '+error.code+' '+error.stack);}}
function source(id,permissions,code,extra={}){
 const dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'extension.json'),JSON.stringify({manifestVersion:1,id,name:id,version:'1.0.0',type:'tool',entry:'index.js',permissions,scope:{workspace:'ws',paths:['src']},network:{hosts:[]},capabilities:[{id:'run',inputSchema:{type:'object',properties:{value:{type:'string'}},additionalProperties:false},requires:permissions}],...extra}));
 fs.writeFileSync(path.join(dir,'index.js'),code);return dir;
}
function setup({vm=false}={}){
 const seen=[];const task={id:'task',workspaceId:'ws',status:'running'};
 const broker=createCapabilityBroker({stateDir:fs.mkdtempSync(path.join(root,'broker-')),policy:createCapabilityPolicy({resolveTask:id=>id==='task'?task:null})});
 broker.register({id:'memory.read',permission:'memory.read',risk:'low',effect:'read-only',execute:r=>{seen.push(r);return {value:r.input.value};}});
 const runtime=createExtensionRuntime({store:createExtensionStore({stateDir:fs.mkdtempSync(path.join(root,'store-'))}),capabilityBroker:broker,monitorIntervalMs:0,...(vm?{isTrustedVmExtension:()=>true}:{})});runtimes.push(runtime);
 return {runtime,broker,seen};
}
function install(runtime,dir){const review=runtime.review({sourceDir:dir});const result=runtime.install({sourceDir:dir,approval:{approved:true,token:review.review.token}});runtime.enable({id:result.entry.id});return result.entry;}
function request(id,operationId='parent-op'){return {actor:{kind:'owner',id:'desktop'},capability:'extension.'+id+'.run',taskId:'task',workspaceId:'ws',attemptId:'attempt-1',operationId,input:{value:'hello'}};}
try{
 await test('real process reverse invocation preserves original Task Actor Attempt and logical operation',async()=>{
  const {runtime,broker,seen}=setup();install(runtime,source('fixture.authority',['memory.read'],'module.exports.handlers={run:(input,ctx)=>ctx.memory.read(input)};'));
  const result=await broker.execute(request('fixture.authority'));
  assert.equal(result.result.result.value,'hello');assert.equal(seen.length,1);
  assert.equal(seen[0].actor.kind,'owner');assert.equal(seen[0].taskId,'task');assert.equal(seen[0].attemptId,'attempt-1');assert.equal(seen[0].constrainedActor.id,'fixture.authority');assert.ok(seen[0].operationId.startsWith('plugin:'));
 });
 await test('disable fences new invocations before asynchronous worker shutdown',async()=>{
  const {runtime}=setup();install(runtime,source('fixture.disable',[],'module.exports.handlers={run:input=>input};'));
  const stopping=runtime.disable({id:'fixture.disable'});
  await assert.rejects(runtime.invoke({id:'fixture.disable',capability:'run',input:{value:'late'}}),{code:'EXTENSION_DISABLED'});await stopping;
 });
 await test('trusted VM shutdown aborts active invocation and rejects subsequent ingress',async()=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});let aborted=false;
  const host=createVmExtensionHost({manifest:{id:'fixture.vm',entry:'index.js',permissions:['memory.read'],capabilities:[{id:'run'}]},source:'module.exports.handlers={run:(input,ctx)=>ctx.memory.read(input)};',capabilityExecutor:(_c,_i,{signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});})});
  const pending=host.invoke('run',{});const observed=pending.catch(error=>error);await ready;
  assert.equal(typeof host.shutdown,'function');await host.shutdown();const error=await observed;assert.equal(error.effectStatus,'unknown');assert.equal(aborted,true);assert.equal(host.available(),false);await assert.rejects(host.invoke('run',{}),{code:'PROVIDER_UNAVAILABLE'});
 });
 await test('worker bootstrap cannot request capabilities outside an invocation',async()=>{
  const {runtime,seen}=setup();install(runtime,source('fixture.bootstrap',['memory.read'],'memory.read({value:"bootstrap"}).catch(()=>{});module.exports.handlers={run:input=>input};'));
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(seen.length,0);await runtime.disable({id:'fixture.bootstrap'});
 });
 await test('enable cannot race an unfinished uninstall shutdown',async()=>{
  const {runtime}=setup();install(runtime,source('fixture.uninstall',[],'module.exports.handlers={run:input=>input};'));
  const stopping=runtime.uninstall({id:'fixture.uninstall'});assert.throws(()=>runtime.enable({id:'fixture.uninstall'}),{code:'EXTENSION_UPDATE_IN_PROGRESS'});await stopping;
 });
 await test('workflow to tool delegation retains original actor and rejects undeclared input and transitive authority',async()=>{
  const {runtime,broker,seen}=setup();
  install(runtime,source('fixture.target',['memory.read'],'module.exports.handlers={run:(input,ctx)=>ctx.memory.read(input)};'));
  const delegated='extension.fixture.target.run';
  install(runtime,source('fixture.workflow',['extension.invoke','memory.read'],'module.exports.handlers={run:(input,ctx)=>ctx.plugins.invoke("extension.fixture.target.run",input)};',{type:'workflow',delegates:[{capability:delegated,inputSchema:{type:'object',properties:{value:{type:'string',enum:['hello']}},required:['value'],additionalProperties:false}}]}));
  const result=await broker.execute(request('fixture.workflow','chain-one'));
  assert.equal(result.result.result.result.value,'hello');assert.equal(seen[0].actor.id,'desktop');assert.equal(seen[0].attemptId,'attempt-1');
  await assert.rejects(broker.execute({...request('fixture.workflow','chain-bad'),input:{value:'escape'}}));assert.equal(seen.length,1);
  install(runtime,source('fixture.limited',['extension.invoke'],'module.exports.handlers={run:(input,ctx)=>ctx.plugins.invoke("extension.fixture.target.run",input)};',{type:'workflow',delegates:[{capability:delegated,inputSchema:{type:'object',additionalProperties:true}}]}));
  await assert.rejects(broker.execute(request('fixture.limited','chain-limited')),{code:'PERMISSION_DENIED'});assert.equal(seen.length,1);
  await runtime.disable({id:'fixture.target'});await assert.rejects(broker.execute(request('fixture.workflow','chain-disabled')));assert.equal(seen.length,1);
 });
}finally{await Promise.all(runtimes.map(runtime=>runtime.close()));fs.rmSync(root,{recursive:true,force:true});}
console.log(`${passed} PASS / ${failed} FAIL`);if(failed)process.exitCode=1;
