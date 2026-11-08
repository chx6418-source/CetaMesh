// Actual React + isolated Core settings; Chromium is source UI evidence, not installed acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {createTaskService} from '../src/task/service.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createIsolatedTestRunner} from '../src/workspace/isolated-runner.js';
import {createSuiteSandbox,finalizeSuiteSandbox} from '../src/testing/suite-sandbox.js';
import {terminateSuiteProcessTree} from '../src/testing/suite-process.js';
const uiRoot=path.resolve(import.meta.dirname,'../desktop-ui'),require=createRequire(path.join(uiRoot,'package.json'));
const {buildSync}=require('esbuild'),sandbox=createSuiteSandbox({suiteId:'workspace-verification-ui'});
let failed=true,child,socket,server,closeBrowser,capabilityService;
const realNow=Date.now;
try {
 const project=path.join(sandbox.root,'project'),stateDir=path.join(sandbox.root,'state');fs.mkdirSync(project);
 const workspaceService=createWorkspaceService({stateDir});
 const {workspace}=await workspaceService.execute({method:'workspace.create',params:{root:project,name:'Verifier project'}});
 const taskService=createTaskService({stateDir,resolveWorkspace:id=>workspaceService.describeWorkspace(id)});
 capabilityService=createCapabilityService({stateDir,workspaceService,taskRuntime:taskService.runtime,
  isolatedRunner:createIsolatedTestRunner({resolveWorkspace:id=>workspaceService.describeWorkspace(id)})});
 const ui=createDesktopUiService({services:{workspaceService,taskService,capabilityService}}),calls=[];
 const result=buildSync({stdin:{resolveDir:uiRoot,loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WorkspaceVerificationSettings} from './src/app/WorkspaceVerificationSettings';
 window.ipc={postMessage(raw){const request=JSON.parse(raw);fetch('/api',{method:'POST',body:raw}).then(async response=>{const value=await response.json();if(!response.ok)throw value;return value;}).then(result=>window.__cetameshReceive({id:request.id,ok:true,result}),error=>window.__cetameshReceive({id:request.id,ok:false,error}));}};
 window.setField=(label,value)=>{const element=document.querySelector('[aria-label="'+label+'"]'),prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};
 window.click=text=>Array.from(document.querySelectorAll('button')).find(row=>row.textContent.trim()===text)?.click();
 createRoot(document.getElementById('root')).render(<WorkspaceVerificationSettings workspaceId=${JSON.stringify(workspace.id)}/>);
 `},bundle:true,write:false,outfile:path.join(sandbox.root,'verification.js'),platform:'browser',format:'iife',jsx:'automatic'});
 const js=result.outputFiles.find(row=>row.path.endsWith('.js')).text;
 server=http.createServer(async(request,response)=>{if(request.method==='GET'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><div id="root"></div><script>'+js+'</script>');return;}
  try{let body='';for await(const chunk of request)body+=chunk;const data=JSON.parse(body);assert.ok(/^ui\.workspace\.verification\.(get|update|retry)$/.test(data.method));calls.push(data);const value=await ui.execute(data);response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(value));}
  catch(error){response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({code:error.code,message:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');assert.ok(fs.existsSync(edge),'NOT_RUN_ENVIRONMENT Chromium unavailable');
 const profile=path.join(sandbox.root,'profile');child=spawn(edge,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;!fs.existsSync(portFile)&&i<100;i++)await delay(100);assert.ok(fs.existsSync(portFile));
 const [port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 let sequence=0;const pending=new Map();socket.on('message',bytes=>{const value=JSON.parse(String(bytes)),entry=pending.get(value.id);if(!entry)return;pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(Error(value.error.message)):entry.resolve(value.result);});
 const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
 closeBrowser=()=>rpc('Browser.close');const target=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});await rpc('Runtime.enable',{},sessionId);await rpc('Page.enable',{},sessionId);await rpc('Page.navigate',{url:'http://127.0.0.1:'+server.address().port},sessionId);
 const evaluate=async expression=>{const value=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;};
 async function until(expression,label){for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(40);}throw Error('Timed out '+label+' '+await evaluate('document.body.innerText'));}
 const field=async(label,value)=>{await evaluate('window.setField('+JSON.stringify(label)+','+JSON.stringify(value)+')');await delay(50);};
 const click=async text=>{await evaluate('window.click('+JSON.stringify(text)+')');await delay(70);};
 await until('!!document.querySelector("[aria-label=启用写后验证]")','loaded settings');
 assert.equal(await evaluate('document.querySelector("[aria-label=启用写后验证]").checked'),false);
 assert.match(await evaluate('document.body.innerText'),/保存配置不会执行测试/);
 await evaluate('document.querySelector("[aria-label=启用写后验证]").click()');
 await field('测试参数','["test"]');await field('匹配扩展名','.mjs, .js');await field('超时毫秒','30000');await field('每轮检查上限','2');
 await click('保存验证配置');await until('document.body.innerText.includes("配置已保存")','saved configuration');
 assert.equal(workspaceService.readPostWriteVerificationConfig({workspaceId:workspace.id}).enabled,true);
 assert.deepEqual(fs.readdirSync(project),[],'saving configuration never writes or executes project code');
 const sha=value=>createHash('sha256').update(value).digest('hex');
 fs.writeFileSync(path.join(project,'answer.mjs'),'export default 1;\n');
 fs.writeFileSync(path.join(project,'verify.mjs'),"import answer from './answer.mjs';import assert from 'node:assert/strict';assert.equal(answer,2,'UI_IMPORTED_CHECK_FAILURE');\n");
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node verify.mjs'}}));
 let task=taskService.runtime.create({goal:'Suite-owned imported check',workspaceId:workspace.id});task=taskService.runtime.start({id:task.id,expectedRev:task.rev,provider:'fixture-native',sessionId:'ui-native'}).task;
 taskService.runtime.beginExecutionObservation({id:task.id,provider:'fixture-native',sessionId:'ui-native',runId:'ui-run',phase:'user'});
 capabilityService.grantTask(task.id,{capabilities:['filesystem.read','filesystem.write','test.run']});
 const imported=await capabilityService.applyAgentWorkspaceChanges({taskId:task.id,workspaceId:workspace.id,provider:'fixture-native',sessionId:'ui-native',runId:'ui-run',phase:'user',requestId:'ui-import',
  changes:[{action:'write',path:'answer.mjs',content:'export default 3;\n',hash:sha('export default 3;\n'),expectedHash:sha('export default 1;\n')}]});
 await capabilityService.execute({method:'capability.approval.decide',params:{id:imported.approvalId,approve:true}});
 let pendingTest=capabilityService.broker.approvals.list().find(row=>row.request.capability==='test.run');assert.ok(pendingTest);
 await click('重新载入配置');await until('document.body.innerText.includes("待独立测试审批")','actual pending test visible');
 const expiredId=pendingTest.id,expiry=pendingTest.expiresAt;Date.now=()=>expiry+1;
 await click('重新载入配置');await until('!document.body.innerText.includes("待独立测试审批")','expired check no longer falsely pending');
 await evaluate('document.querySelector("[aria-label=验证检查记录] summary").click()');
 await until('document.body.innerText.includes("审批已过期")&&Array.from(document.querySelectorAll("button")).some(row=>row.textContent.trim()==="重新申请检查")','explicit expiry recovery');
 await evaluate('window.click("重新申请检查");window.click("重新申请检查")');
 await until('document.body.innerText.includes("待独立测试审批")','renewal queues fresh approval');
 assert.equal(calls.filter(row=>row.method==='ui.workspace.verification.retry').length,1,'duplicate click sends one Owner retry');
 pendingTest=capabilityService.broker.approvals.list().find(row=>row.request.capability==='test.run');assert.ok(pendingTest);assert.notEqual(pendingTest.id,expiredId);
 assert.equal(taskService.runtime.get({id:task.id}).task.executionEvidence.filter(row=>row.source==='core-test').length,0,'retry never executes project code');
 await capabilityService.execute({method:'capability.approval.decide',params:{id:pendingTest.id,approve:true}});
 await click('重新载入配置');await until('document.body.innerText.includes("测试失败")','actual failed check visible');
 assert.equal(await evaluate('document.body.innerText.includes("待独立测试审批")'),false,'settled result does not retain false pending state');
 await evaluate('document.querySelector("[aria-label=验证检查记录] summary").click()');
 await until('document.body.innerText.includes("UI_IMPORTED_CHECK_FAILURE")','real retained failure diagnostic');
 const saved=workspaceService.readPostWriteVerificationConfig({workspaceId:workspace.id});
 const {configDigest,...concurrent}=saved;
 await workspaceService.execute({method:'workspace.settings',params:{id:workspace.id,patch:{postWriteVerification:{...concurrent,timeoutMs:45000}}}});
 await field('超时毫秒','31000');await click('保存验证配置');await until('document.body.innerText.includes("POST_WRITE_CONFIG_CONFLICT")||document.body.innerText.includes("settings changed")','stale save refused');
 assert.equal(await evaluate('document.querySelector("[aria-label=超时毫秒]").value'),'31000','conflict preserves draft');
 assert.equal(workspaceService.readPostWriteVerificationConfig({workspaceId:workspace.id}).timeoutMs,45000);
 assert.ok(calls.every(row=>!Object.hasOwn(row.params,'approved')&&!Object.hasOwn(row.params,'actor')));
 console.log('PASS actual Chromium + Core: disabled default, save without execution, separately pending imported check, real Node failure diagnostics, stale save refusal and draft retention');
 await closeBrowser();await delay(700);failed=false;
} finally {
 Date.now=realNow;
 if(socket?.readyState===WebSocket.OPEN){try{await closeBrowser();}catch{}socket.terminate();await delay(500);}
 if(child?.pid&&child.exitCode===null&&child.signalCode===null)await terminateSuiteProcessTree(child);
 if(server)await new Promise(resolve=>server.close(resolve));
 await capabilityService?.close();
 finalizeSuiteSandbox({sandbox,failed,keepFailed:failed});
}
