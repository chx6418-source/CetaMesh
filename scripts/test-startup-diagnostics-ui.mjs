import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'../desktop-ui');
const require=createRequire(path.join(root,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const vite=await createServer({configFile:false,root,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'});
globalThis.window={setTimeout,clearTimeout};
try{
 const {validDiagnosticsState,diagnosticClientFailure,DiagnosticsReportView,DiagnosticsPanel,boundedDiagnosticsRead}=await vite.ssrLoadModule('/src/app/StartupDiagnostics.tsx');
 assert.equal(typeof validDiagnosticsState,'function','startup gate validates actual host report contract before mounting Core pages');
 assert.equal(validDiagnosticsState({report:null,coreAvailable:true}),false);
 assert.equal(validDiagnosticsState({report:{status:'PASS',checks:[]},coreAvailable:true}),false);
 const report=diagnosticClientFailure('DIAGNOSTICS_IPC_UNAVAILABLE',false);
 assert.equal(report.status,'BLOCKED');assert.equal(report.unconfirmedEffects,null);
 assert.equal(validDiagnosticsState({coreAvailable:true,report:{...report,status:'PASS'}}),false,'aggregate PASS cannot mask a BLOCKED check');
 await assert.rejects(()=>boundedDiagnosticsRead(()=>new Promise(()=>{}),15),{code:'DIAGNOSTICS_TIMEOUT'});
 await assert.rejects(()=>boundedDiagnosticsRead(async()=>({report:null,coreAvailable:true}),15),{code:'DIAGNOSTICS_CONTRACT_INVALID'});
 const {diagnosticsClient}=await vite.ssrLoadModule('/src/bridge/typed-client.ts');
 const bridgeTimers=[],bridgeCalls=[];const originalSetTimeout=window.setTimeout,originalClearTimeout=window.clearTimeout;
 window.setTimeout=(_handler,ms)=>{bridgeTimers.push(ms);return 1;};window.clearTimeout=()=>{};
 window.ipc={postMessage(raw){const call=JSON.parse(raw);bridgeCalls.push(call);queueMicrotask(()=>window.__cetameshReceive({id:call.id,ok:true,result:call.method==='app.diagnostics.export'?{exported:true}:{report,coreAvailable:false}}));}};
 try{await diagnosticsClient.export('11111111-1111-4111-8111-111111111111');await diagnosticsClient.status();
  assert.equal(bridgeTimers[0],300000,'native report Save dialog keeps the existing bounded human selector deadline');
  assert.equal(bridgeTimers[1],32000,'read-only status keeps the ordinary RPC deadline');
  assert.deepEqual(bridgeCalls.map(call=>({method:call.method,params:call.params})),[{method:'app.diagnostics.export',params:{id:'11111111-1111-4111-8111-111111111111'}},{method:'app.diagnostics.status',params:{}}]);
 }finally{window.setTimeout=originalSetTimeout;window.clearTimeout=originalClearTimeout;delete window.ipc;}
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const html=renderToStaticMarkup(React.createElement(DiagnosticsReportView,{report}));
 assert.match(html,/尚未确认/);assert.match(html,/DIAGNOSTICS_IPC_UNAVAILABLE/);
 assert.doesNotMatch(html,/API Key|token=|\/api\/send/);
 const multiReport={...report,checks:[report.checks[0],{...report.checks[0],id:'ipc.second',code:'SECOND_ERROR'}]};
 const panelHtml=renderToStaticMarkup(React.createElement(DiagnosticsPanel,{state:{report:multiReport,coreAvailable:false}}));
 assert.match(panelHtml,/value="DIAGNOSTICS_IPC_UNAVAILABLE, SECOND_ERROR"/,'single-line code display uses readable separators');

 console.log('PASS diagnostic contract validation and truthful blocked unknown-effect presentation');
}finally{await vite.close();delete globalThis.window;}
import fs from 'node:fs';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {createSuiteSandbox,finalizeSuiteSandbox} from '../src/testing/suite-sandbox.js';
import {terminateSuiteProcessTree} from '../src/testing/suite-process.js';
const sandbox=createSuiteSandbox({suiteId:'startup-diagnostics-ui'});
const evidence=process.env.CETAMESH_STARTUP_UI_EVIDENCE_DIR?path.resolve(process.env.CETAMESH_STARTUP_UI_EVIDENCE_DIR):null;
let browser,server,socket,closeBrowser,failed=true;
try{
 const {buildSync}=require('esbuild');
 const aliases=Object.fromEntries(Object.keys(require(path.join(root,'package.json')).dependencies).map(name=>[name,path.join(root,'node_modules',name)]));
 const bundle=buildSync({stdin:{resolveDir:root,loader:'tsx',contents:`
  import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
  import{StartupDiagnosticsBoundary,DiagnosticsStatusEntry,DiagnosticsEntry,FeedbackDeveloperButton}from'./src/app/StartupDiagnostics';
  import{chatClient,bridge}from'./src/bridge/typed-client';
  import{Dialog,Sheet}from'./src/components/primitives/overlays';import{Select}from'./src/components/primitives/inputs';
  import'./src/theme/tokens.css';import'./src/theme/global.css';import'./src/app/harbor.css';
  window.fixtureCalls=[];window.fixtureErrors=[];window.fixture={state:'pending',hold:false,feedbackFails:false,exportFails:false};
  window.addEventListener('error',event=>window.fixtureErrors.push(event.message));
  window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason)));
  const base={schemaVersion:1,id:'11111111-1111-4111-8111-111111111111',generatedAt:'2026-10-31T14:00:00Z',trigger:'startup',product:{version:'fixture',shellVersion:'fixture',build:{buildId:'fixture',commit:'1'.repeat(40),buildTime:null},runtime:{platform:'win32',arch:'x64',node:'24'}},unconfirmedEffects:false,feedback:{configured:true,url:'https://example.invalid/feedback'},retention:{maxReports:20,maxAgeDays:14,maxBytes:65536},persisted:true};
  const check=(status,code)=>({id:'ipc.ui',stage:'transport',status,code,reason:status==='PASS'?'实际响应契约已核对（受控界面夹具）':'本机连接未取得有效响应（受控界面夹具）',remediation:'保留数据并重新检查。',timedOut:code==='IPC_TIMEOUT',durationMs:16});
  function report(){const mode=window.fixture.state;if(mode==='invalid')return{};if(mode==='pending')return{report:{...base,status:'BLOCKED',checks:[check('BLOCKED','STARTUP_CHECKS_PENDING')]},coreAvailable:false};if(mode==='blocked')return{report:{...base,status:'BLOCKED',checks:[check('BLOCKED','IPC_TIMEOUT'),...(window.fixture.extraIssue?[check('BLOCKED','SECOND_ERROR')]:[])],unconfirmedEffects:null},coreAvailable:false};return{report:{...base,status:mode==='degraded'?'DEGRADED':'PASS',checks:mode==='degraded'?[check('PASS','RPC_HANDSHAKE_OK'),{...check('DEGRADED','MCP_OFFLINE'),id:'mcp.runtime',stage:'extensions'}]:[check('PASS','RPC_HANDSHAKE_OK')]},coreAvailable:true};}
  window.ipc={postMessage(raw){const request=JSON.parse(raw);if(request.method!=='ui.events.next')window.fixtureCalls.push(request);const respond=result=>window.__cetameshReceive({id:request.id,ok:true,result});const reject=()=>window.__cetameshReceive({id:request.id,ok:false,error:{code:'FIXTURE_ERROR',message:'Synthetic failure, report must remain'}});
   if(request.method==='ui.events.next'){setTimeout(()=>respond({instanceId:'diagnostic-fixture',cursor:0,events:[]}),200);return;}
   if(request.method==='app.diagnostics.status'||request.method==='app.diagnostics.run'){const captured=report();if(window.fixture.hold){window.releaseCheck=()=>respond(captured);return;}setTimeout(()=>respond(captured),30);return;}
   if(request.method==='app.diagnostics.history'){respond({reports:[{...base,id:'22222222-2222-4222-8222-222222222222',status:'BLOCKED',checks:[check('BLOCKED','STORAGE_CORRUPT')]}]});return;}
   if(request.method==='app.diagnostics.read'){respond({report:{...base,id:request.params.id,status:'BLOCKED',trigger:'manual',checks:[check('BLOCKED','STORAGE_CORRUPT')]}});return;}
   if(request.method==='app.diagnostics.feedback'){if(window.fixture.feedbackFails)reject();else respond({opened:false,url:base.feedback.url});return;}
   if(request.method==='app.diagnostics.export'){if(window.fixture.exportFails)reject();else respond({exported:true});return;}
   if(request.method==='ui.chat.sessions.list'){respond({sessions:[]});return;}
   if(request.method==='app.windowAction'){respond({maximized:false,nativeChrome:true});return;}
   reject();
  }};
  window.event=(ready)=>window.__cetameshEvent({event:'core.status',data:{ready}});
  function Normal(){const[draft,setDraft]=useState('unsaved local draft'),[modal,setModal]=useState(false),[sheet,setSheet]=useState(false),[modalDraft,setModalDraft]=useState('unsaved modal draft'),[sheetDraft,setSheetDraft]=useState('unsaved drawer draft');useEffect(()=>{void chatClient.sessions.list();},[]);return <div id="normal-app"><DiagnosticsStatusEntry/><h1>本地聊天</h1><textarea aria-label="保留的输入" value={draft} onChange={event=>setDraft(event.target.value)}/><DiagnosticsEntry/><FeedbackDeveloperButton/><button onClick={()=>setModal(true)}>打开正常对话框</button><button onClick={()=>setSheet(true)}>打开正常侧栏</button><Dialog open={modal} title="正常任务对话框" onClose={()=>{window.normalDialogCloses=(window.normalDialogCloses||0)+1;setModal(false);}}><textarea aria-label="对话框未保存说明" value={modalDraft} onChange={event=>setModalDraft(event.target.value)}/></Dialog><Sheet open={sheet} title="正常任务侧栏" onClose={()=>{window.normalSheetCloses=(window.normalSheetCloses||0)+1;setSheet(false);}}><textarea aria-label="侧栏未保存说明" value={sheetDraft} onChange={event=>setSheetDraft(event.target.value)}/><Select label="正常侧栏选择" value="one" onChange={()=>{}}><option value="one">正常选项一</option><option value="two">正常选项二</option></Select></Sheet></div>;}
  createRoot(document.getElementById('root')).render(<StartupDiagnosticsBoundary><Normal/></StartupDiagnosticsBoundary>);
 `},bundle:true,write:false,outdir:path.join(sandbox.root,'bundle'),format:'iife',platform:'browser',jsx:'automatic',alias:aliases});
 const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css=bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
 server=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end('<!doctype html><html lang="zh-CN" data-theme="light" data-window-chrome="native"><meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+js+'</script></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');assert.ok(fs.existsSync(edge),'actual Chromium required for diagnostic UI acceptance');
 const profile=path.join(sandbox.root,'profile');browser=spawn(edge,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;!fs.existsSync(portFile)&&i<100;i++)await delay(100);assert.ok(fs.existsSync(portFile),'owned browser starts');
 const[port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 let sequence=0;const pending=new Map();socket.on('message',bytes=>{const data=JSON.parse(String(bytes)),entry=pending.get(data.id);if(!entry)return;pending.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(Error(data.error.message)):entry.resolve(data.result);});
 const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
 closeBrowser=()=>rpc('Browser.close');const target=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});await rpc('Runtime.enable',{},sessionId);await rpc('Page.enable',{},sessionId);
 await rpc('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false},sessionId);await rpc('Page.navigate',{url:'http://127.0.0.1:'+server.address().port},sessionId);
 const evaluate=async expression=>{const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;};
 const until=async(expression,label)=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(35);}throw Error('Timed out '+label+' '+await evaluate('document.body.innerText'));};
 async function click(text,scope='document'){const selector=`[...${scope}.querySelectorAll('button')].find(row=>row.checkVisibility()&&row.textContent.trim()===${JSON.stringify(text)})`;await until(`${selector}&&!(${selector}).disabled`,"action ready "+text);const point=await evaluate(`(()=>{const row=${selector};if(!row)throw Error('Missing button '+${JSON.stringify(text)});row.scrollIntoView({block:'center'});const r=row.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,disabled:row.disabled};})()`);assert.equal(point.disabled,false,text+' is actionable');await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1},sessionId);await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1},sessionId);}
 async function focusDiagnosticAction(){
  // A disconnect starts a real asynchronous recheck. Its disabled primary
  // button cannot receive focus; feedback remains available during that check.
  await until('document.querySelector(".diagnostics-blocked .diagnostics-actions button:not([disabled])")?.checkVisibility()','enabled diagnostic action');
  const focus=await evaluate('(()=>{const target=document.querySelector(".diagnostics-blocked .diagnostics-actions button:not([disabled])");target.focus();return{targetFocused:document.activeElement===target,inDiagnostics:!!document.activeElement.closest(".diagnostics-blocked"),documentFocused:document.hasFocus(),targetDisabled:target.disabled,targetLabel:target.textContent.trim(),targetInert:!!target.closest("[inert]"),modalCount:document.querySelectorAll("dialog:modal").length};})()');
  assert.equal(focus.targetDisabled,false);assert.equal(focus.targetInert,false);assert.equal(focus.modalCount,0);
  assert.equal(focus.inDiagnostics,true,'enabled diagnostic actions receive focus after normal UI suspension: '+JSON.stringify(focus));
  assert.equal(focus.targetFocused,true,'focus must reach the specific intended diagnostic action: '+JSON.stringify(focus));
  return focus;
 }
 async function releaseDisconnectCheck(){
  await evaluate('window.fixture.hold=false;window.releaseCheck();delete window.releaseCheck');
  await until('document.querySelector("input[aria-label=诊断错误代码]")?.value==="IPC_TIMEOUT"&&!document.querySelector(".diagnostics-blocked .diagnostics-actions button").disabled','disconnect report settled and recheck available');
 }
 const shots=[];async function shot(name){if(!evidence)return;fs.mkdirSync(evidence,{recursive:true});await delay(400);const result=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(result.data,'base64'));shots.push(name+'.png');}
 await until('!!window.fixtureCalls&&window.fixtureCalls.some(row=>row.method==="app.diagnostics.status")','first actual host request');
 assert.equal(await evaluate('!!document.querySelector("#normal-app")'),false,'normal UI never initializes before startup readiness');assert.equal(await evaluate('window.fixtureCalls.filter(row=>row.method==="ui.chat.sessions.list").length'),0);
 await evaluate('window.fixture.state="blocked"');await until('document.querySelector("input[aria-label=诊断错误代码]")?.value==="IPC_TIMEOUT"','true BLOCKED report');assert.equal(await evaluate('!!document.querySelector("#normal-app")'),false);assert.match(await evaluate('document.body.innerText'),/尚未确认/);await shot('ui-blocked-core-offline');
 await click('反馈开发者');await until('document.body.innerText.includes("无法打开浏览器")','browser failure explanation');assert.equal(await evaluate('document.querySelector("input[aria-label=官方反馈地址]").value'),'https://example.invalid/feedback');
 await evaluate('window.fixture.exportFails=true');await click('导出诊断报告');await until('document.body.innerText.includes("报告导出失败")','failed export retains report');assert.equal(await evaluate('document.querySelector("input[aria-label=诊断错误代码]").value'),'IPC_TIMEOUT');
 await evaluate('window.fixture.exportFails=false');await click('导出诊断报告');await until('document.body.innerText.includes("已导出")','explicit native export action');
 await evaluate('window.fixture.state="degraded"');await click('重新完整检查');await until('!!document.querySelector("#normal-app")&&!!document.querySelector(".diagnostics-status-bar")','optional failure admits local UI');assert.equal(await evaluate('window.fixtureCalls.filter(row=>row.method==="ui.chat.sessions.list").length'),1);
 await shot('ui-degraded-local-chat');await click('查看原因');await until('document.querySelector("[role=dialog]")?.checkVisibility()','diagnostic sheet');await shot('ui-degraded-diagnostic-sheet');
 await click('历史诊断');await until('!!document.querySelector(".diagnostics-history")','historical report control');
 await click('当前检查');await until('!!document.querySelector(".cm-select-options [role=option]")','history picker');assert.match(await evaluate('document.querySelector(".cm-select-options").innerText'),/已阻止工作模式/,'history options use readable date/status labels rather than opaque ids');await evaluate('[...document.querySelectorAll("[role=option]")].find(row=>row.textContent.includes("已阻止工作模式")).click()');await until('document.querySelector("input[aria-label=诊断错误代码]")?.value==="STORAGE_CORRUPT"','read selected historical report');
 assert.equal(await evaluate('document.querySelector("#normal-app textarea").value'),'unsaved local draft','report browsing does not lose local input');
 await evaluate('window.fixture.feedbackFails=true');await click('反馈开发者','document.querySelector("[role=dialog]")');await until('document.body.innerText.includes("无法打开浏览器")','feedback invocation failure visible');assert.equal(await evaluate('document.querySelector("input[aria-label=诊断错误代码]").value'),'STORAGE_CORRUPT','feedback failure preserves selected report');
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);await until('!document.querySelector("[role=dialog]")?.checkVisibility()','sheet closes');
 await evaluate('window.fixture.state="blocked";window.event(false)');await until('!!document.querySelector(".diagnostics-blocked")','runtime Core disconnect freezes normal UI');assert.equal(await evaluate('document.querySelector(".startup-normal").inert'),true);assert.equal(await evaluate('document.querySelector("#normal-app textarea").value'),'unsaved local draft');await shot('ui-runtime-disconnected');
 await evaluate('window.fixture.state="pass"');await click('重新完整检查');await until('!document.querySelector(".diagnostics-blocked")&&document.querySelector("#normal-app")?.checkVisibility()','recheck restores same application');assert.equal(await evaluate('window.fixtureCalls.filter(row=>row.method==="ui.chat.sessions.list").length'),1,'runtime recovery reuses mounted app rather than creating duplicate task requests');assert.equal(await evaluate('document.querySelector("#normal-app textarea").value'),'unsaved local draft');assert.equal(await evaluate('!!document.querySelector(".diagnostics-status-bar")'),false,'normal PASS report stays hidden');
 await click('打开正常对话框');await until('document.querySelector("dialog[aria-label=正常任务对话框]")?.matches(":modal")','real native modal opened');
 await evaluate('document.querySelector("textarea[aria-label=对话框未保存说明]").focus()');await rpc('Input.insertText',{text:' user edit'},sessionId);
 const modalDraft=await evaluate('document.querySelector("textarea[aria-label=对话框未保存说明]").value');
 await evaluate('window.fixture.hold=true;delete window.releaseCheck;window.fixture.state="blocked";window.event(false)');await until('!!document.querySelector(".diagnostics-blocked")&&typeof window.releaseCheck==="function"','runtime block while modal is open and recheck pending');await shot('ui-runtime-modal-block');
 assert.equal(await evaluate('document.querySelector("dialog[aria-label=正常任务对话框]").open'),false,'a normal native top-layer modal must release the document when Core is blocked');
 assert.equal(await evaluate('window.normalDialogCloses||0'),0,'suspension is not a user cancellation');
 assert.equal(await evaluate('document.querySelector(".diagnostics-blocked .diagnostics-actions button").disabled'),true,'in-flight recheck remains disabled rather than bypassing its guard');
 assert.equal((await focusDiagnosticAction()).targetLabel,'反馈开发者','feedback stays keyboard-accessible while the recheck is pending');
 await releaseDisconnectCheck();assert.equal((await focusDiagnosticAction()).targetLabel,'重新完整检查','settled primary action can receive focus too');
 await evaluate('window.fixture.state="pass"');await click('重新完整检查');await until('document.querySelector("dialog[aria-label=正常任务对话框]")?.matches(":modal")','still-open normal modal restored after healthy recheck');assert.equal(await evaluate('document.querySelector("textarea[aria-label=对话框未保存说明]").value'),modalDraft);assert.equal(await evaluate('window.normalDialogCloses||0'),0);
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);await until('!document.querySelector("dialog[aria-label=正常任务对话框]").open','user can close restored modal');
 await click('打开正常侧栏');await until('document.querySelector("aside[aria-label=正常任务侧栏]")?.checkVisibility()','normal drawer opened');await delay(250);await click('正常选项一');await until('document.querySelector("[role=listbox][aria-label=正常侧栏选择]")?.checkVisibility()','normal drawer Select opened');
 await evaluate('window.fixture.hold=true;delete window.releaseCheck;window.fixture.state="blocked";window.event(false)');await until('!!document.querySelector(".diagnostics-blocked")&&typeof window.releaseCheck==="function"','runtime block while drawer is open and recheck pending');
 assert.equal(await evaluate('document.querySelector("aside[aria-label=正常任务侧栏]").closest(".cm-sheet-layer").inert'),true,'suspended drawer cannot retain its document focus trap');
 assert.equal((await focusDiagnosticAction()).targetLabel,'反馈开发者');const firstDiagnosticFocus=await evaluate('document.activeElement.textContent');await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);assert.equal(await evaluate('!!document.activeElement.closest(".diagnostics-blocked")'),true);assert.notEqual(await evaluate('document.activeElement.textContent'),firstDiagnosticFocus,'hidden normal drawer must not eat diagnostic Tab navigation');
 assert.equal(await evaluate('window.normalSheetCloses||0'),0);await shot('ui-runtime-drawer-block');
 await releaseDisconnectCheck();assert.equal((await focusDiagnosticAction()).targetLabel,'重新完整检查');
 await evaluate('window.fixture.state="pass"');await click('重新完整检查');await until('document.querySelector("aside[aria-label=正常任务侧栏]")?.checkVisibility()','normal drawer restored');assert.equal(await evaluate('document.querySelector("textarea[aria-label=侧栏未保存说明]").value'),'unsaved drawer draft');assert.equal(await evaluate('document.querySelector("button[aria-label=正常侧栏选择]").getAttribute("aria-expanded")'),'false','normal Select stays closed after suspension');
 await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);await until('!document.querySelector("aside[aria-label=正常任务侧栏]")?.checkVisibility()','user can close restored drawer');
 await evaluate('window.fixture.hold=true;delete window.releaseCheck;window.__cetameshEvent({event:"core.restarted",data:{}})');await until('typeof window.releaseCheck==="function"','held previous healthy reply');
 await evaluate('window.fixture.state="blocked";window.event(false);window.fixture.hold=false;window.releaseCheck()');await delay(150);assert.equal(await evaluate('!!document.querySelector(".diagnostics-blocked")'),true,'a late previous PASS must not override a newer Core disconnect');
 await until('document.querySelector("input[aria-label=诊断错误代码]")?.value==="IPC_TIMEOUT"','fresh recheck follows stale held reply');
 await evaluate('window.fixture.extraIssue=true;Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.copiedErrorCodes=value;}}})');await click('重新完整检查');await until('document.querySelector("input[aria-label=诊断错误代码]")?.value==="IPC_TIMEOUT, SECOND_ERROR"','multi-code display stays readable');await click('复制错误代码');await until('window.copiedErrorCodes==="IPC_TIMEOUT\\nSECOND_ERROR"','copied codes preserve newline separation');
 await evaluate('window.fixture.state="invalid";window.event(false)');await until('document.querySelector("input[aria-label=诊断错误代码]")?.value==="DIAGNOSTICS_CONTRACT_INVALID"','invalid host contract fails closed');
 const calls=await evaluate('window.fixtureCalls.map(row=>({method:row.method,params:row.params}))');assert.ok(calls.every(row=>!/(chat.send|task.start|mcp.manage|plugin.*install|qq.*send)/i.test(row.method)));assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);assert.deepEqual(await evaluate('window.fixtureErrors'),[]);
 const coverage=["initial Core pages withheld","bounded startup pending poll","blocked failure page","unknown effect state","browser open failure","configured URL fallback","export failure retains report","explicit export action","degraded local UI admitted","history report read","readable history labels","feedback failure retains selected report","runtime normal UI inert","recovery without remount","late PASS response fence","invalid host contract","copy preserves code newlines","no external task or message effects","no horizontal overflow or React errors","native top-layer Dialog suspended","Dialog draft and open intent restored","normal Sheet made inert","diagnostic Tab navigation untrapped","Sheet draft and open intent restored","Select stays closed after suspension","human Save dialog deadline","ordinary status deadline","aggregate report status consistency","bounded read timeout distinction","single-line code display separators"];
 if(evidence)fs.writeFileSync(path.join(evidence,'ui-evidence.json'),JSON.stringify({scope:'Actual React/typed bridge rendering with explicitly synthetic host replies; not native Core communication evidence',checks:coverage.length,coverage,passed:true,screenshots:shots,calls},null,2));
 console.log('PASS real Chromium diagnostic gate: pending/blocked/degraded/recovered states, runtime draft retention, modal/drawer suspension, history, explicit export and feedback failure; no model/message/task effects');
 failed=false;
}finally{
 if(closeBrowser)await closeBrowser().catch(()=>{});if(socket)socket.close();if(browser)await terminateSuiteProcessTree(browser,{timeoutMs:5000}).catch(()=>{});if(server)await new Promise(resolve=>server.close(resolve));finalizeSuiteSandbox({sandbox,failed,keepFailed:failed});
}
