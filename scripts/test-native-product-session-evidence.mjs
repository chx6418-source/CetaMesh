// Deterministic regression for the native acceptance driver's observability.
// No Desktop/model/CLI is started. Transport behavior is preserved in a VM fixture.
import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import {createRequire} from 'node:module';
import * as helper from './helpers/native-product-session.mjs';
const {projectNativeRpcEvidence,nativeRpcObserverSource}=helper;
assert.equal(typeof projectNativeRpcEvidence,'function','native driver must expose safe Core refusal/revision facts');
assert.equal(typeof nativeRpcObserverSource,'function','native driver must observe actual application replies');
const emitted=[],sent=[],transport=raw=>sent.push(raw),ipc={};Object.defineProperty(ipc,'postMessage',{value:transport,writable:false,configurable:false});
const require=createRequire(new URL('../desktop-ui/package.json',import.meta.url)),ts=require('typescript'),source=fs.readFileSync(new URL('../desktop-ui/src/bridge/typed-client.ts',import.meta.url),'utf8');
const module={exports:{}};let timer=0;const timers=new Map();
const context=vm.createContext({exports:module.exports,module,TextEncoder,window:{ipc,setTimeout:callback=>{timers.set(++timer,callback);return timer;},clearTimeout:id=>timers.delete(id),__cetameshTestRpcEvidence:raw=>emitted.push(projectNativeRpcEvidence(JSON.parse(raw)))}});
vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
vm.runInContext(nativeRpcObserverSource(),context);
const params={id:'task-owned',expectedRev:2,goal:'PRIVATE_SOURCE_MUST_NOT_APPEAR',apiKey:'PRIVATE_CREDENTIAL_MUST_NOT_APPEAR'},pause=module.exports.uiCall('ui.task.pause',params),request=JSON.parse(sent.at(-1));
context.window.__cetameshReceive({id:request.id,ok:false,error:{code:'TASK_CONFLICT',message:'C:\\owner\\private-file'}});
await assert.rejects(pause,{code:'TASK_CONFLICT'});assert.deepEqual(JSON.parse(sent[0]).params,params);assert.equal(emitted.length,2,'real bridge facts must work with immutable native IPC');assert.equal(emitted[1].code,'TASK_CONFLICT');assert.equal(emitted[1].expectedRev,2);assert.equal(emitted[1].origin,'application');assert.equal(emitted[1].ok,false);
assert.equal(context.window.ipc.postMessage,transport,'native transport must not be replaced');assert.doesNotMatch(JSON.stringify(emitted),/PRIVATE_|private-file|task-owned|harbor-1/);
assert.equal(projectNativeRpcEvidence({kind:'response',method:'ui.settings.get',password:'do not copy'}),null);
assert.equal(projectNativeRpcEvidence({kind:'response',method:'ui.task.get',code:'C:\\secret',status:'made-up',expectedRev:-1}).code,null);
assert.equal(projectNativeRpcEvidence({kind:'response',method:'ui.task.get',status:'made-up',expectedRev:-1}).expectedRev,null);
// The current reply is observed only when it actually arrives. Earlier running
// state cannot be upgraded into completed or native-rendered proof.
const get=module.exports.uiCall('ui.task.get',{id:'task-owned'}),getRequest=JSON.parse(sent.at(-1));
assert.equal(emitted.at(-1).kind,'request');
context.window.__cetameshReceive({id:getRequest.id,ok:true,result:{task:{id:'task-owned',rev:7,status:'running',execution:{state:'awaiting-review'},goal:'DO_NOT_COPY'}}});await get;
assert.equal(emitted.at(-1).taskRev,7);assert.equal(emitted.at(-1).status,'running');assert.equal(emitted.at(-1).executionState,'awaiting-review');assert.doesNotMatch(JSON.stringify(emitted),/DO_NOT_COPY/);
context.window.__cetameshObserveRpc({kind:'response',id:'native-test-3',origin:'driver',method:'ui.task.get',taskId:'task-owned',taskRev:8,status:'completed',ok:true});
assert.equal(emitted.at(-1).origin,'driver','driver read replies cannot masquerade as rendered application state');
const before=emitted.length;vm.runInContext(nativeRpcObserverSource(),context);const cancel=module.exports.uiCall('ui.task.cancel',{id:'task-owned'}),cancelRequest=JSON.parse(sent.at(-1));assert.equal(emitted.length,before+1,'observer installs once');
// Callback failures stay diagnostic-only and do not swallow actual Core replies.
context.window.__cetameshTestRpcEvidence=()=>{throw Error('fixture observer unavailable');};context.window.__cetameshReceive({id:cancelRequest.id,ok:true,result:{task:{id:'task-owned',status:'cancelled'}}});assert.equal((await cancel).task.status,'cancelled');assert.equal(timers.size,0);
console.log('PASS native acceptance evidence: exact refusal/revision, delayed reply, privacy, origin and transparent transport; Fixture only, zero real model calls');
// Same-method failures, concurrent replies and relaunches must retain exact
// request identity. A CDP failure has no Core result to borrow from history.
const {invokeNativeTestCall,sha256}=helper,driverEvidence={rpcBoundaries:[]},driverPending=new Map();
context.window.__nativeTestCall=(method,input,id)=>new Promise((resolve,reject)=>driverPending.set(id,{method,input,resolve,reject}));
const evaluate=expression=>vm.runInContext(expression,context);
function refuse(id,code,launch=1){const request=driverPending.get(id);driverEvidence.rpcBoundaries.push({kind:'response',origin:'driver',method:request.method,requestRef:sha256(id).slice(0,20),launch,ok:false,code});request.reject(Object.assign(Error(code),{code}));}
const first=invokeNativeTestCall(evaluate,'ui.task.get',{id:'first'},driverEvidence,1),firstId=[...driverPending.keys()].at(-1);refuse(firstId,'TASK_NOT_FOUND');
await assert.rejects(first,error=>error.code==='TASK_NOT_FOUND'&&error.nativeBoundary.requestRef===sha256(firstId).slice(0,20));
await assert.rejects(invokeNativeTestCall(async()=>{throw Error('Native CDP timeout Runtime.evaluate');},'ui.task.get',{id:'second'},driverEvidence,2),error=>!error.code&&!error.nativeBoundary&&/CDP timeout/.test(error.message));
const a=invokeNativeTestCall(evaluate,'ui.task.get',{id:'a'},driverEvidence,2),aId=[...driverPending.keys()].at(-1),b=invokeNativeTestCall(evaluate,'ui.task.get',{id:'b'},driverEvidence,2),bId=[...driverPending.keys()].at(-1);
refuse(bId,'TASK_CONFLICT',2);await assert.rejects(b,error=>error.code==='TASK_CONFLICT'&&error.nativeBoundary.requestRef===sha256(bId).slice(0,20));
refuse(aId,'TASK_NOT_FOUND',2);await assert.rejects(a,error=>error.code==='TASK_NOT_FOUND'&&error.nativeBoundary.requestRef===sha256(aId).slice(0,20));
console.log('PASS native request correlation: stale refusal, transport timeout, relaunch and reverse-order concurrent replies');
