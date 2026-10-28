// Real native product test session. No replacement bridge, renderer authority or model fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {createCetaMeshServices} from '../../src/app/service-container.js';
import {createProviderSecrets} from '../../src/providers/secrets.js';
import {createSuiteSandbox,finalizeSuiteSandbox,registerSuiteSecret} from '../../src/testing/suite-sandbox.js';
import {terminateSuiteProcessTree} from '../../src/testing/suite-process.js';
import {readJsonFile,writeJsonAtomic} from '../../src/storage/json-file.js';

export const nativeGoal='请把本项目加法实现的修复委派给一个合适且可用的外部开发协作者；你负责选择、交接，并在对方返回后独立查看差异、运行现有 npm test 和交付核验结果。仅允许修改 math.mjs，保持 verify.mjs 与 package.json 不变。需要首次授权时通过本任务审批处理。';
export const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
export async function until(read,accept,label,timeout=30000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await read();if(accept(last))return last;await delay(100);}throw Error(label+' timed out');}

export async function openNativeProduct({packagedDir,provider='deepseek-official',model='deepseek-flash',shellOverride=null,onReady=()=>{}}){
 const sandbox=createSuiteSandbox({suiteId:'real-native-product'}),root=sandbox.root,app=path.join(root,'app'),data=path.join(root,'data'),project=path.join(root,'project');
 let seeder,child,socket,connected=false,sequence=0,secretPresent=false,closed=false,desktopClosed=null,launchError=null;
 const pending=new Map(),evidence={host:'native WebView2',fixture:false,provider,model,startedAt:new Date().toISOString(),actions:[],approvals:[],uiCalls:{}};
 function task(){const doc=readJsonFile(path.join(data,'state','tasks','tasks.json'),{missing:{tasks:[]}});return doc.tasks.find(row=>row.goal===nativeGoal);}
 function rpc(method,params={}){return new Promise((resolve,reject)=>{if(!socket||socket.readyState!==WebSocket.OPEN)return reject(Error('Native CDP closed'));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Native CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
 async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Native UI action failed: '+String(r.exceptionDetails.exception?.description??r.exceptionDetails.text).slice(0,400));return r.result?.value;}
 async function call(method,params={}){assert.ok(['app.ping','app.status','ui.task.get','ui.task.overview','ui.approvals.list','ui.task.cancel','ui.memory.overview','app.windowAction'].includes(method),'test driver must not create Tasks or grant authority by RPC');if(method==='app.windowAction')assert.equal(params.action,'close');return evaluate('window.__nativeTestCall('+JSON.stringify(method)+','+JSON.stringify(params)+')');}
 async function click(label){await until(()=>evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled)'),Boolean,'native button '+label);await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled).click()');evidence.actions.push(label);await delay(150);}
 async function fill(label,value){await evaluate('(()=>{const e=Array.from(document.querySelectorAll("textarea,input")).find(e=>e.getAttribute("aria-label")==='+JSON.stringify(label)+');if(!e)throw Error("missing field");Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');evidence.actions.push('填写 '+label);await delay(100);}
 async function capture(file){const r=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(file,Buffer.from(r.data,'base64'));}
 async function stopNative(){
   if(connected&&child?.pid&&child.exitCode===null&&child.signalCode===null){try{await call('app.windowAction',{action:'close'});await Promise.race([desktopClosed,delay(7000)]);}catch(error){evidence.gracefulCloseCode=error.code??'NATIVE_CLOSE_INTERRUPTED';}}
   if(socket){socket.close();socket.terminate();for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error('Native session closed'));}pending.clear();}
   if(child?.pid&&child.exitCode===null&&child.signalCode===null){await terminateSuiteProcessTree(child);await Promise.race([desktopClosed,delay(5000).then(()=>{throw Error('Owned Desktop close event unconfirmed');})]);}
   evidence.desktopExited=!child?.pid||child.exitCode!==null||child.signalCode!==null;
   assert.equal(evidence.desktopExited,true,'owned Desktop exit must be confirmed before removing profile');
   connected=false;
 }
 async function close({failed=false}={}){if(closed)return;closed=true;try{
   const current=task();if(connected&&current&&!['completed','failed','cancelled'].includes(current.status)){try{await call('ui.task.cancel',{id:current.id,expectedRev:current.rev});}catch(error){evidence.cancelCleanupCode=error.code??'CANCEL_UNCONFIRMED';}}
   await stopNative();
  }finally{
   const keyFile=path.join(data,'state','provider-keys.json');if(secretPresent){fs.rmSync(keyFile,{force:true});evidence.temporaryCredentialRemoved=!fs.existsSync(keyFile);}
   // No archive of raw profile/credentials. Persisted synthetic Task/evidence is exported separately.
   if(!child?.pid||child.exitCode!==null||child.signalCode!==null){for(let i=0;;i++){try{finalizeSuiteSandbox({sandbox,failed});break;}catch(error){if(i>=60)throw error;await delay(250);}}evidence.temporaryRootRemoved=!fs.existsSync(root);}
   evidence.finishedAt=new Date().toISOString();evidence.elapsedMs=Date.parse(evidence.finishedAt)-Date.parse(evidence.startedAt);
  }}
 try{
  const manifest=readJsonFile(path.join(packagedDir,'release-manifest.json'));evidence.sourceCommit=manifest.sourceCommit;evidence.buildId=manifest.buildId;evidence.channel=manifest.channel;evidence.dirtySourceTree=manifest.dirtySourceTree;
  const shellSource=shellOverride??path.join(packagedDir,'WhaleBridge.exe'),coreSource=path.join(packagedDir,'payload','WhaleBridgeCore.exe');
  for(const [relative,file]of [['WhaleBridge.exe',shellSource],['payload/WhaleBridgeCore.exe',coreSource]]){const expected=manifest.artifacts.find(row=>row.path===relative);assert.ok(expected);if(!shellOverride||relative!=='WhaleBridge.exe')assert.equal(sha256(fs.readFileSync(file)),expected.sha256,'packaged artifact must match its manifest');}
  fs.mkdirSync(app);fs.cpSync(path.join(packagedDir,'payload'),app,{recursive:true});fs.copyFileSync(shellSource,path.join(app,'WhaleBridge.exe'));fs.mkdirSync(project);
  const files={'math.mjs':'export const add=(a,b)=>a-b;\n','verify.mjs':"import assert from 'node:assert/strict';import {add} from './math.mjs';assert.equal(add(3,4),7);assert.equal(add(-2,5),3);console.log('REAL_UI_VERIFIED_5281');\n",'package.json':JSON.stringify({name:'cm-real-ui-project',private:true,type:'module',scripts:{test:'node verify.mjs'}})+'\n'};
  for(const [file,content]of Object.entries(files))fs.writeFileSync(path.join(project,file),content);
  for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','synthetic baseline']])execFileSync('git',args,{stdio:'ignore',windowsHide:true});
  evidence.originalCodeSha256=sha256(fs.readFileSync(path.join(project,'math.mjs')));
  evidence.protectedFiles=Object.fromEntries(['verify.mjs','package.json'].map(file=>[file,sha256(fs.readFileSync(path.join(project,file)))]));
  const existing=createProviderSecrets({root:process.env.CETAMESH_TEST_PROVIDER_DATA_ROOT||path.join(process.env.LOCALAPPDATA||os.homedir(),'WhaleBridge')});
  // Actual Core is a separate executable: seed only the required existing Provider credential through its existing store.
  registerSuiteSecret({sandbox,file:path.join(data,'state','provider-keys.json')});secretPresent=true;
  createProviderSecrets({root:data}).set(existing.raw(provider));
  seeder=createCetaMeshServices({stateDir:path.join(data,'state'),dataRoot:data});
  await seeder.workspaceService.execute({method:'workspace.create',params:{root:project,name:'真实原生入口验收'}});
  await seeder.settingsService.execute({method:'settings.update',params:{section:'models',values:{provider,defaultModel:model}}});
  await seeder.settingsService.execute({method:'settings.update',params:{section:'general',values:{confirmOnExit:false}}});
  for(const stepId of ['welcome','provider','connection','model'])await seeder.desktopUiService.execute({method:'ui.onboarding.completeStep',params:{stepId,data:{provider,model}}});
  await seeder.desktopUiService.execute({method:'ui.onboarding.finish',params:{}});
  await seeder.autonomousHandoff.close();await seeder.chatService.close();await seeder.agentService.close();await seeder.managedAgent.close();await seeder.capabilityService.close();await seeder.extensionService.close();seeder=null;
  writeJsonAtomic(path.join(data,'state','desktop-ui.json'),{closeBehavior:'quit'});
  assert.equal(task(),undefined,'configuration seeding must not precreate any Task');
  async function startNative(){
  const executable=path.join(app,'WhaleBridge.exe');evidence.desktopSha256=sha256(fs.readFileSync(executable));evidence.coreSha256=sha256(fs.readFileSync(path.join(app,'WhaleBridgeCore.exe')));
  const staleEndpoint=findPort(path.join(data,'webview2'));if(staleEndpoint)fs.rmSync(staleEndpoint);
  child=spawn(executable,['--ui=v2','--data-dir',data],{cwd:app,stdio:'ignore',windowsHide:false,env:{...process.env,WHALEBRIDGE_DATA_DIR:data,WHALEBRIDGE_CORE_EXE:path.join(app,'WhaleBridgeCore.exe'),WHALEBRIDGE_CORE_MODE:'packaged',WHALEBRIDGE_INSTANCE_SUFFIX:'native-test-'+sandbox.runId,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --disable-background-networking'}});
  desktopClosed=new Promise(resolve=>{child.once('close',()=>resolve());child.once('error',error=>{launchError=error;resolve();});});
  function findPort(dir,depth=0){if(depth>4||!fs.existsSync(dir))return null;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isFile()&&entry.name==='DevToolsActivePort')return file;if(entry.isDirectory()){const match=findPort(file,depth+1);if(match)return match;}}return null;}
  const portFile=await until(()=>{if(launchError)throw launchError;if(child.exitCode!==null)throw Error('Native Desktop exited before WebView readiness');return findPort(path.join(data,'webview2'));},Boolean,'owned WebView2 debug endpoint',45000);
  const port=Number(fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/)[0]);assert.ok(Number.isInteger(port)&&port>0&&port<65536);
  const target=await until(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1000)})).json()).find(row=>row.type==='page'&&row.url.startsWith('https://cetamesh.localhost'));}catch{return null;}},Boolean,'production WebView2 page',20000);
  const address=new URL(target.webSocketDebuggerUrl);assert.equal(address.hostname,'127.0.0.1');assert.equal(Number(address.port),port);
  socket=new WebSocket(target.webSocketDebuggerUrl,{handshakeTimeout:10000});await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  socket.on('message',buffer=>{const message=JSON.parse(String(buffer));if(message.method==='Page.javascriptDialogOpening'){const expected=message.params.type==='confirm'&&message.params.message.startsWith('取消任务“')&&message.params.message.includes(nativeGoal.slice(0,30));if(!expected){evidence.unexpectedDialogs??=[];evidence.unexpectedDialogs.push({type:message.params.type,message:String(message.params.message).slice(0,200)});}void rpc('Page.handleJavaScriptDialog',{accept:expected}).catch(error=>{evidence.dialogError=error.message;});}if(message.id&&pending.has(message.id)){const row=pending.get(message.id);pending.delete(message.id);clearTimeout(row.timer);message.error?row.reject(Error(message.error.message)):row.resolve(message.result);}});
  await rpc('Runtime.enable');await rpc('Page.enable');
  await until(()=>evaluate('typeof window.ipc?.postMessage==="function"&&typeof window.__cetameshReceive==="function"'),Boolean,'production native bridge');
  await evaluate('(()=>{const original=window.__cetameshReceive,pending=new Map();window.__cetameshReceive=m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Error(m.error?.code+": "+m.error?.message));}else original(m);};window.__nativeTestCall=(method,params)=>new Promise((resolve,reject)=>{const id="native-test-"+crypto.randomUUID();pending.set(id,{resolve,reject});window.ipc.postMessage(JSON.stringify({id,method,params}));});})()');connected=true;
  evidence.nativePing=await call('app.ping');assert.equal(evidence.nativePing.host,'webview2');await until(()=>call('app.status'),row=>row.ready===true,'real Core EXE readiness');
  evidence.desktopPid=child.pid;evidence.origin=await evaluate('location.origin');evidence.userAgent=await evaluate('navigator.userAgent');
  evidence.launches??=[];evidence.launches.push({desktopPid:child.pid,origin:evidence.origin});
  if(evidence.launches.length===1)await onReady({executable,pid:child.pid,data,project,root,evidence});
  }
  await startNative();
  return {root,data,project,app,evidence,task,rpc,evaluate,call,click,fill,capture,close,restart:async()=>{await stopNative();socket=null;connected=false;launchError=null;await startNative();}};
 }catch(error){try{if(seeder){const results=await Promise.allSettled([seeder.autonomousHandoff.close(),seeder.chatService.close(),seeder.agentService.close(),seeder.managedAgent.close(),seeder.capabilityService.close(),seeder.extensionService.close()]);if(results.some(row=>row.status==='rejected'))evidence.seederCloseFailed=true;}}finally{try{await close({failed:true});}catch(cleanupError){evidence.cleanupFailure={code:cleanupError.code??cleanupError.name,message:String(cleanupError.message).slice(0,300)};}}error.nativeEvidence=evidence;throw error;}
}