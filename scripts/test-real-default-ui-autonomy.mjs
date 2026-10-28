// Real product entrance: production HarborApp -> authenticated native Core pipe -> real model/CLI.
// The browser host adapter replaces only WebView2 message transport; no model or Agent fixture.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';import WebSocket from 'ws';
import {redactText} from '../src/logging/redact.js';
import {createCetaMeshServices} from '../src/app/service-container.js';import {createDesktopIpcRuntime} from '../src/app/ipc-runtime.js';import {createProviderSecrets} from '../src/providers/secrets.js';import {terminateSuiteProcessTree} from '../src/testing/suite-process.js';
if(process.env.WHALEBRIDGE_TEST_REAL_MANAGED!=='1'||process.env.WHALEBRIDGE_TEST_REAL_CODEX!=='1'){console.log('NOT_RUN_ENVIRONMENT: real Managed/Codex opt-in required');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-real-default-ui-')),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const evidence={fixture:false,entrance:'production HarborApp Tasks form',host:'isolated headless Edge host adapter, not native WebView2',transport:'authenticated production length-prefixed Named Pipe',modelRequests:0,proposalCalls:0,modelToolCalls:[],uiCalls:{},approvals:[],actions:[],diagnostics:[],candidateResults:[],startedAt:new Date().toISOString()};
let services,ipc,child,socket,taskId,rpc,sessionId,closing=false;const connections=new Set();
async function waitFor(read,test,label,timeout=30000){const until=Date.now()+timeout;let value;while(Date.now()<until){value=await read();if(test(value))return value;await delay(100);}throw Error(label+' timed out');}
try{
 const existing=createProviderSecrets({root:process.env.CETAMESH_TEST_PROVIDER_DATA_ROOT||path.join(process.env.LOCALAPPDATA||os.homedir(),'WhaleBridge')});
 const credentials=Object.freeze({list:()=>existing.list(),raw:p=>existing.raw(p)});
 services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:credentials,log:message=>{if(message.startsWith('Automatic delegation state: '))evidence.diagnostics.push(message.slice('Automatic delegation state: '.length));}});
 const provider=process.env.CETAMESH_TEST_MANAGED_PROVIDER||'deepseek-official',model=process.env.CETAMESH_TEST_MANAGED_MODEL||services.modelRegistry.require(provider).defaultModel;
 if(!services.modelRuntime.listProviders().find(row=>row.id===provider)?.hasKey)throw Object.assign(Error('Configured model credential service unavailable'),{code:'ENVIRONMENT_MISSING'});
 evidence.modelProvider=provider;evidence.model=model;
 const brokerExecute=services.capabilityService.broker.execute;services.capabilityService.broker.execute=async function(request,...args){const result=await brokerExecute.call(this,request,...args);if(request.capability==='agent.delegate.candidates')evidence.candidateResults.push(result.result);return result;};
 const original=services.modelRuntime.stream;services.modelRuntime.stream=async function*(request){evidence.modelRequests++;for await(const event of original(request)){if(event.type==='assistant/tool-calls'){for(const call of event.data?.toolCalls??[])evidence.modelToolCalls.push({capability:call.capabilityId,...(['agent.delegate.candidates','agent.delegate.propose'].includes(call.capabilityId)?{input:JSON.parse(call.arguments)}:{})});evidence.proposalCalls+=(event.data?.toolCalls??[]).filter(row=>row.capabilityId==='agent.delegate.propose').length;}yield event;}};
 const initial=await services.agentBroker.health('codex');evidence.coldCodex={available:initial.available,authenticated:initial.authenticated,compatible:initial.compatible,sandboxCapable:initial.sandboxCapable,toolsAvailable:initial.toolsAvailable,supportsReadinessCheck:services.agentBroker.capabilities('codex').supportsReadinessCheck};
 if(initial.available!==true||initial.authenticated!==true)throw Object.assign(Error('Installed native provider is not currently authenticated/launchable'),{code:'ENVIRONMENT_MISSING'});
 const project=path.join(root,'project');fs.mkdirSync(project);
 const files={'math.mjs':'export const add=(a,b)=>a-b;\n','verify.mjs':"import assert from 'node:assert/strict';import {add} from './math.mjs';assert.equal(add(3,4),7);assert.equal(add(-2,5),3);console.log('REAL_UI_VERIFIED_5281');\n",'package.json':JSON.stringify({name:'cm-real-ui-project',private:true,type:'module',scripts:{test:'node verify.mjs'}})+'\n'};
 for(const [file,content]of Object.entries(files))fs.writeFileSync(path.join(project,file),content);
 for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','synthetic baseline']])execFileSync('git',args,{stdio:'ignore'});
 const protectedHashes=Object.fromEntries(['verify.mjs','package.json'].map(file=>[file,hash(fs.readFileSync(path.join(project,file)))]));
 await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'真实默认入口验收'}});
 await services.settingsService.execute({method:'settings.update',params:{section:'models',values:{provider,defaultModel:model}}});
 // Preconfigured application setup, not task/policy/operation setup. Actual model use is verified below.
 for(const stepId of ['welcome','provider','connection','model'])await services.desktopUiService.execute({method:'ui.onboarding.completeStep',params:{stepId,data:{provider,model}}});
 await services.desktopUiService.execute({method:'ui.onboarding.finish',params:{}});
 const pipeName='\\\\.\\pipe\\cm-round5-real-ui-'+process.pid+'-'+crypto.randomBytes(6).toString('hex'),authToken=crypto.randomBytes(32).toString('hex');
 ipc=createDesktopIpcRuntime({services,pipeName,processRef:{env:{WHALEBRIDGE_UI_AUTH_TOKEN:authToken},once(){},exit(){throw Error('owned Core pipe failed');}}});
 const server=ipc.start();await new Promise((resolve,reject)=>{if(server.listening)resolve();else{server.once('listening',resolve);server.once('error',reject);}});
 function nativeCall(method,params){return new Promise((resolve,reject)=>{const conn=net.connect(pipeName);connections.add(conn);const id=crypto.randomUUID();let buffer=Buffer.alloc(0);const timer=setTimeout(()=>finish(Error('Core pipe request timed out: '+method)),30000);
  function finish(error,result){clearTimeout(timer);connections.delete(conn);conn.destroy();error?reject(error):resolve(result);}
  conn.once('error',finish);conn.once('connect',()=>{const payload=Buffer.from(JSON.stringify({version:1,id,method,params,role:'console',authToken}));const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);conn.write(Buffer.concat([header,payload]));});
  conn.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const n=buffer.readUInt32LE(0);if(n>1024*1024)return finish(Error('Core response limit'));if(buffer.length<4+n)return;const reply=JSON.parse(buffer.subarray(4,4+n).toString());buffer=buffer.subarray(4+n);if(reply.id===id){if(reply.ok)finish(null,reply.result);else finish(Object.assign(Error(reply.error.message),{code:reply.error.code}));return;}}});});}
 const uiRoot=fileURLToPath(new URL('../desktop-ui/',import.meta.url)),require=createRequire(uiRoot+'package.json');const {build}=require('esbuild');
 const bundle=await build({stdin:{resolveDir:uiRoot,loader:'tsx',contents:"import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router';import{HarborApp}from'./src/app/HarborApp';createRoot(document.getElementById('root')).render(<BrowserRouter><HarborApp/></BrowserRouter>);"},bundle:true,write:false,minify:true,outfile:'bundle.js',format:'iife',platform:'browser',jsx:'automatic',loader:{'.svg':'dataurl','.woff2':'dataurl'}});
 const css=['theme/tokens.css','theme/global.css','app/harbor.css','theme/motion.css'].map(f=>fs.readFileSync(path.join(uiRoot,'src',f),'utf8')).join('\n')+'\n'+bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
 const html=path.join(root,'product.html');fs.writeFileSync(html,'<!doctype html><meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+bundle.outputFiles.find(f=>f.path.endsWith('.js')).text+'</script>');
 const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),profile=path.join(root,'browser-profile');
 child=spawn(edge,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true,env:{...process.env,TEMP:profile,TMP:profile}});
 let launchError;child.on('error',e=>{launchError=e;});await waitFor(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),Boolean,'browser ready');if(launchError)throw launchError;
 const [port,browserPath]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);assert.match(port,/^\d+$/);assert.match(browserPath,/^\/devtools\/browser\/[a-z0-9-]+$/i);
 socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let seq=0;const pending=new Map();
 rpc=(method,params={},sid)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},10000);pending.set(id,response=>{clearTimeout(timer);response.error?reject(Error(response.error.message)):resolve(response.result);});socket.send(JSON.stringify({id,method,params,sessionId:sid}));});
 socket.on('message',async data=>{const message=JSON.parse(String(data));if(message.id){const done=pending.get(message.id);if(done){pending.delete(message.id);done(message);}return;}
  if(message.method!=='Runtime.bindingCalled'||closing)return;
  let request;try{request=JSON.parse(message.params.payload);evidence.uiCalls[request.method]=(evidence.uiCalls[request.method]||0)+1;let result;
   if(request.method==='app.status')result={ready:true,needsAttention:false};else if(request.method==='app.ping')result={host:'webview2',ready:true};else if(request.method==='app.setWindowBehavior')result={updated:true};else if(request.method.startsWith('ui.'))result=await nativeCall(request.method,request.params||{});else throw Object.assign(Error('Host method outside acceptance scope'),{code:'HOST_UNSUPPORTED'});
   if(!closing)await rpc('Runtime.evaluate',{expression:'window.__cetameshReceive('+JSON.stringify({id:request.id,ok:true,result})+')'},message.sessionId);
  }catch(error){if(request&&!closing)try{await rpc('Runtime.evaluate',{expression:'window.__cetameshReceive('+JSON.stringify({id:request.id,ok:false,error:{code:error.code||'ACCEPTANCE_HOST_ERROR',message:String(error.message).slice(0,500)}})+')'},message.sessionId);}catch{}}
 });
 const target=await rpc('Target.createTarget',{url:'about:blank'});({sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true}));await rpc('Runtime.enable',{},sessionId);await rpc('Runtime.addBinding',{name:'__cmNativePost'},sessionId);await rpc('Page.enable',{},sessionId);
 await rpc('Page.addScriptToEvaluateOnNewDocument',{source:"window.ipc={postMessage:message=>window.__cmNativePost(message)};"},sessionId);await rpc('Page.navigate',{url:pathToFileURL(html).href+'?page=work'},sessionId);
 async function evaluate(expression){const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(result.exceptionDetails)throw Error('Product UI action failed: '+redactText(result.exceptionDetails.exception?.description||result.exceptionDetails.text).slice(0,500));return result.result?.value;}
 async function click(label){await waitFor(()=>evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled)'),Boolean,'button '+label);await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled).click()');evidence.actions.push(label);await delay(150);}
 async function fill(label,value){evidence.actions.push('填写 '+label);await evaluate('(()=>{const e=document.querySelector("textarea[aria-label=\\"'+label+'\\"]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');await delay(80);}
 // Non-executing preference probe in the same production form; no extra Task/model/CLI is started.
 await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'codex'}}});
 await click('新建任务');
 await waitFor(()=>evaluate('(()=>{const label=Array.from(document.querySelectorAll("label")).find(e=>e.textContent.includes("允许按需协作"));const box=label?.querySelector("input");return !!box&&box.disabled&&!box.checked;})()'),Boolean,'configured native default disables Managed-only cooperation');
 evidence.nativeDefaultPreferenceChecked=true;evidence.preferenceProbeActions=evidence.actions.splice(0);
 await evaluate('Array.from(document.querySelectorAll("button")).find(e=>e.getAttribute("aria-label")==="关闭侧栏").click()');await waitFor(()=>evaluate('!Array.from(document.querySelectorAll("textarea")).some(e=>e.getAttribute("aria-label")==="任务目标")'),Boolean,'preference sheet closed');
 await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:'auto'}}});
 await click('新建任务');await waitFor(()=>evaluate('!!document.querySelector("textarea[aria-label=\\"任务目标\\"]")'),Boolean,'goal form');
 await fill('任务目标','请把本项目加法实现的修复委派给一个合适且可用的外部开发协作者；你负责选择、交接，并在对方返回后独立查看差异、运行现有 npm test 和交付核验结果。仅允许修改 math.mjs，保持 verify.mjs 与 package.json 不变。需要首次授权时通过本任务审批处理。');
 await evaluate('Array.from(document.querySelectorAll("summary")).find(e=>e.textContent.includes("协作与验收设置")).click()');evidence.actions.push('展开协作与验收设置');await delay(150);
 for(const text of ['允许费用未知','以现有项目测试']){evidence.actions.push('选择 '+text);await evaluate('Array.from(document.querySelectorAll("label")).find(e=>e.textContent.includes('+JSON.stringify(text)+')).querySelector("input").click()');}
 await delay(100);await fill('允许修改的文件','math.mjs');await fill('已有验收文件','verify.mjs');await click('开始任务');
 let current;const approved=new Set(),until=Date.now()+600000;
 while(Date.now()<until){
  current=services.taskService.runtime.list({limit:100}).tasks.find(row=>row.goal.includes('外部开发协作者'));if(current)taskId=current.id;
  for(const approval of services.capabilityService.broker.approvals.list()){
   const request=approval.request;if(!taskId||request.taskId!==taskId||approved.has(approval.id))continue;
   if(request.capability==='agent.execution.authorize'){assert.equal(request.input.provider,'codex');assert.ok(request.input.delegationRequestId);assert.match(request.reason,/不能拦截直接 OS/);}
   else if(request.capability==='workspace.apply'){assert.deepEqual(request.input.changes.map(row=>row.path),['math.mjs']);assert.equal(request.input.changes[0].action,'write');}
   else if(request.capability==='test.run'){assert.equal(request.input.tool,'npm');assert.deepEqual(request.input.args,['test']);}
   else throw Error('Unexpected approval '+request.capability);
   for(const[file,expected]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.join(project,file))),expected);
   const title=request.capability==='agent.execution.authorize'?'确认外部 Agent 的原生执行范围':request.capability==='workspace.apply'?'导入工作区改动':'运行项目测试';
   await waitFor(()=>evaluate('Array.from(document.querySelectorAll(".approval-card")).some(e=>e.textContent.includes('+JSON.stringify(title)+'))'),Boolean,'product Task approval '+title);
   await evaluate('(()=>{const e=Array.from(document.querySelectorAll(".approval-card")).find(e=>e.textContent.includes('+JSON.stringify(title)+'));Array.from(e.querySelectorAll("button")).find(b=>b.textContent.trim()==="批准一次").click();})()');
   evidence.approvals.push({capability:request.capability,title});approved.add(approval.id);await delay(300);
  }
  if(current?.executionObservation?.state==='awaiting-review'&&!current.delegationProposal)break;
  if(current&&(['completed','failed','cancelled','blocked'].includes(current.status)||['needs-review','unknown','blocked'].includes(current.delegationProposal?.state)))break;
  await delay(100);
 }
 assert.ok(current,'production form must create a Task');evidence.policy=current.delegationPolicy?{allowUnknownCost:current.delegationPolicy.allowUnknownCost,prepareNative:current.delegationPolicy.prepareNative,expiresAt:current.delegationPolicy.expiresAt,used:current.delegationPolicy.used}:null;const liveHealth=await services.agentBroker.health('codex');evidence.finalCodexHealth={available:liveHealth.available,reason:liveHealth.reason,authenticated:liveHealth.authenticated,compatible:liveHealth.compatible,sessionCapable:liveHealth.sessionCapable,sandboxCapable:liveHealth.sandboxCapable,toolsAvailable:liveHealth.toolsAvailable,taskEligible:liveHealth.taskEligible};evidence.taskId=taskId;evidence.taskStatus=current.status;evidence.delegationState=current.delegationProposal?.state;evidence.history=current.agentHistory.map(row=>row.provider);evidence.selectedProvider=current.delegationProposal?.selectedProvider;evidence.progress=current.progress.note;
 evidence.externalReport=redactText((current.agentReports??[]).filter(row=>row.provider==='codex').at(-1)?.text??'').slice(0,6000);
 evidence.toolEvidence=(current.executionEvidence??[]).map(row=>({capability:row.capability,status:row.status,source:row.source??null,exitCode:row.exitCode??null,resultSha256:row.resultSha256??null}));
 assert.ok(evidence.uiCalls['ui.task.create']);assert.ok(evidence.uiCalls['ui.approvals.decide']);assert.ok(evidence.modelRequests>0&&evidence.proposalCalls>0,'real model must make generic delegation proposal');
 assert.deepEqual(evidence.history,['cetamesh','codex','cetamesh']);assert.equal(current.status,'completed');assert.equal(current.delegationProposal.state,'verified');
 assert.equal(evidence.approvals.filter(row=>row.capability==='agent.execution.authorize').length,1,'cold readiness approval must occur in the product');
 for(const[file,expected]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.join(project,file))),expected);
 assert.deepEqual(execFileSync('git',['-C',project,'diff','--name-only'],{encoding:'utf8'}).trim().split(/\r?\n/),['math.mjs']);assert.match(execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8'}),/REAL_UI_VERIFIED_5281/);
 assert.equal(current.executionEvidence.findLast(row=>row.capability==='test.run'&&row.source==='core-test')?.exitCode,0);
 await waitFor(()=>evaluate('document.body.textContent.includes("机器验收通过")'),Boolean,'authoritative completed UI');
 evidence.resultShownInUi=true;evidence.fileVerified=true;evidence.protectedFiles=protectedHashes;evidence.resultSha256=hash(fs.readFileSync(path.join(project,'math.mjs')));evidence.verification=current.delegationProposal.verification;
 if(process.env.CETAMESH_TEST_SCREENSHOT){const capture=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);fs.writeFileSync(process.env.CETAMESH_TEST_SCREENSHOT,Buffer.from(capture.data,'base64'));}
 console.log('PASS REAL UI: default Tasks form -> real Managed choice -> Owner cold native consent -> real Codex -> import -> independent Core npm test -> verified UI delivery');
}catch(error){evidence.failure={code:error.code||error.name||'ACCEPTANCE_FAILED',message:String(error.message).slice(0,800)};process.exitCode=error.code==='ENVIRONMENT_MISSING'?77:1;}
finally{
 evidence.finishedAt=new Date().toISOString();evidence.elapsedMs=Date.parse(evidence.finishedAt)-Date.parse(evidence.startedAt);closing=true;
 if(services&&taskId)try{const t=services.taskService.runtime.get({id:taskId}).task;if(!['completed','failed','cancelled'].includes(t.status))await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:taskId,expectedRev:t.rev}});}catch(e){evidence.cleanupTaskCode=e.code||'CLEANUP_FAILED';}
 if(socket?.readyState===WebSocket.OPEN){try{await rpc('Browser.close');}catch{}await delay(1000);}if(socket&&socket.readyState!==WebSocket.CLOSED)socket.terminate();
 if(child?.pid&&child.exitCode===null&&child.signalCode===null)await terminateSuiteProcessTree(child);evidence.browserExited=!child?.pid||child.exitCode!==null||child.signalCode!==null;
 for(const conn of connections)conn.destroy();if(ipc)await ipc.stop();
 if(services){await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}
 for(let n=0;;n++)try{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('cm-real-default-ui-'));fs.rmSync(root,{recursive:true,force:true});evidence.temporaryRootRemoved=!fs.existsSync(root);break;}catch(error){if(n>=100)throw error;await delay(250);}
 console.log(JSON.stringify({acceptanceEvidence:evidence}));if(process.env.CETAMESH_TEST_EVIDENCE_FILE)fs.writeFileSync(process.env.CETAMESH_TEST_EVIDENCE_FILE,JSON.stringify(evidence,null,2)+'\n');
}