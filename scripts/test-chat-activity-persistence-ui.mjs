import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
const repo=path.resolve(import.meta.dirname,'..');
const uiRoot=path.join(repo,'desktop-ui');
const sandbox=createSuiteSandbox({suiteId:'chat-activity-persistence-ui'}),output=sandbox.root;
let failed=true;
const require=createRequire(path.join(uiRoot,'package.json'));
const {build}=require('esbuild'),WebSocket=require('ws');
const {createChatService}=await import(pathToFileURL(path.join(repo,'src/desktop/chat-service.js')));
const {createDesktopUiService}=await import(pathToFileURL(path.join(repo,'src/desktop/ui-service.js')));
const {terminateSuiteProcessTree}=await import(pathToFileURL(path.join(repo,'src/testing/suite-process.js')));
let finish;const gate=new Promise(resolve=>finish=resolve);
const service=createChatService({stateDir:path.join(output,'state'),defaults:{model:'fixture'},api:{},modelRuntime:{defaultProviderId:()=> 'fixture',resolveProvider:id=>({id}),isRegistered:()=>true,supportsToolCalling:()=>false,stream:async function*(){yield{type:'turn/start',data:{}};yield{type:'tool/activity',data:{activity:{id:'receipt-1',capability:'filesystem.read',status:'running',summary:'Safe public read',durationMs:3}}};yield{type:'assistant/chunk',data:{chunk:{type:'text-delta',text:'Public progress from the controlled stream.'}}};await gate;yield{type:'tool/activity',data:{activity:{id:'receipt-1',capability:'filesystem.read',status:'completed',summary:'Safe public read',durationMs:5}}};yield{type:'turn/end',data:{reason:{kind:'completed'}}};}}});
const ui=createDesktopUiService({services:{chatService:service}}),call=(method,params)=>ui.execute({method,params});
const session=await call('ui.chat.sessions.create',{});await service.execute({method:'chat.send',params:{id:session.id,text:'Read the controlled fixture'}});await delay(10);
const active={status:await call('ui.chat.status',{id:session.id}),history:await call('ui.chat.history',{id:session.id})};finish();await delay(10);
const terminal={status:await call('ui.chat.status',{id:session.id}),history:await call('ui.chat.history',{id:session.id})};await service.close();
assert.equal(active.status.toolActivity.length,1);assert.equal(terminal.history.messages.at(-1).toolActivity.length,1);
let server,browser,socket,closeBrowser,browserClosed;
try{
 const bundle=await build({stdin:{resolveDir:uiRoot,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{ChatPage}from'./src/app/HarborApp';import{useUi}from'./src/stores/ui';import{diagnosticClientFailure}from'./src/app/StartupDiagnostics';import'./src/theme/tokens.css';import'./src/theme/global.css';
 const session=${JSON.stringify(session)},active=${JSON.stringify(active)},terminal=${JSON.stringify(terminal)};window.fixture={phase:'active',held:[],calls:[],errors:[],approvals:[],operations:[],approvalRequests:[],heldApprovalLists:[],holdApprovalLists:false};window.addEventListener('error',e=>window.fixture.errors.push(e.message));
 function reply(r){window.fixture.calls.push(r.method);if(r.method==='ui.chat.history'&&window.fixture.customHistory)return window.fixture.customHistory;if(r.method==='ui.chat.history')return window.fixture.phase==='active'?active.history:terminal.history;if(r.method==='ui.chat.status')return window.fixture.phase==='active'?active.status:terminal.status;if(r.method==='ui.events.next')return{events:[],instanceId:'activity-fixture',cursor:0};if(r.method==='ui.chat.catalog')return{models:[],modelProviders:[],agentProviders:[],modes:['chat'],defaultModelProvider:null,available:true,reason:null};if(r.method==='ui.memory.overview')return{memories:[],total:0,candidates:[]};if(r.method==='ui.approvals.list')return{approvals:window.fixture.approvals,operations:window.fixture.operations,grants:[]};if(r.method.startsWith('app.diagnostics.'))return{report:diagnosticClientFailure('FIXTURE',false),coreAvailable:true};return r.method.includes('limits')?{limits:{}}:r.method.includes('capabilities')?{supported:false,status:'unknown'}:{};}
 window.ipc={postMessage(raw){const r=JSON.parse(raw);if(r.method==='ui.chat.history'&&window.fixture.phase==='held'){window.fixture.held.push(r);return;}if(r.method==='ui.approvals.decide'){window.fixture.approvalRequests.push(r);return;}setTimeout(()=>{if(r.method==='ui.approvals.list'&&window.fixture.holdApprovalLists){window.fixture.heldApprovalLists.push(r);return;}window.__cetameshReceive({id:r.id,ok:true,result:reply(r)});},r.method==='ui.events.next'?200:0);}};
 const app=createRoot(document.getElementById('root'));window.renderChat=()=>app.render(<main className="harbor-main fixture"><ChatPage key={window.fixture.remount??0} session={window.fixture.selectedSession??session} workspaces={[]} activeWorkspaceId={null} onSessionUpdate={()=>{}} onNew={async()=>{}} onNewChat={async()=>{}} onOpenMemory={()=>{}} onConfigureModels={()=>{}} onReviewTask={()=>{}}/></main>);window.renderChat();
 window.finish=()=>{window.fixture.phase='held';window.__cetameshEvent({event:'chat.updated',data:{sessionId:session.id}});window.__cetameshEvent({event:'task.updated',data:{}});};
 window.release=()=>{window.fixture.phase='terminal';for(const r of window.fixture.held.splice(0))window.__cetameshReceive({id:r.id,ok:true,result:terminal.history});};
 window.startApprovals=()=>{window.fixture.approvals=['a','b'].map(id=>({id,title:'Controlled approval '+id,capability:'filesystem.write',status:'pending',createdAt:1,expiresAt:9999999999999,summary:'Exact owned fixture '+id,risk:'high',taskId:null}));window.__cetameshEvent({event:'approval.pending',data:{approvalId:'a'}});};
 window.failSubmission=()=>{const r=window.fixture.approvalRequests.at(-1);window.__cetameshReceive({id:r.id,ok:false,error:{code:'CONTROLLED_TRANSPORT_FAILURE',message:'Controlled approval submission failed'}});};
 window.holdAcceptedSubmission=()=>{const r=window.fixture.approvalRequests.at(-1),op={operationId:'approval:'+r.params.id,approvalId:r.params.id,status:'running',decision:'approved',code:null,turnResumed:false,resumePending:false};window.fixture.operations=[op];window.fixture.approvals=window.fixture.approvals.filter(a=>a.id!==r.params.id);window.fixture.acceptedSubmission={id:r.id,ok:true,result:{...op,status:'accepted'}};};
 window.releaseAcceptedSubmission=()=>{window.__cetameshReceive(window.fixture.acceptedSubmission);window.fixture.acceptedSubmission=null;};
 window.acceptSubmission=()=>{window.holdAcceptedSubmission();window.releaseAcceptedSubmission();};
 window.failOperation=(status='failed',diagnostic={code:'CONTROLLED_ASYNC_FAILURE'})=>{window.fixture.operations[0]={...window.fixture.operations[0],status,...diagnostic};window.__cetameshEvent({event:'approval.operation',data:window.fixture.operations[0]});};
 window.switchChat=()=>{window.fixture.selectedSession={...session,id:'second-controlled-chat',title:'Second controlled chat'};window.renderChat();};
 window.manyOperations=()=>{window.fixture.operations=Array.from({length:100},(_,index)=>({operationId:'bounded-history-'+index,approvalId:'past-'+index,status:'failed',decision:'approved',code:'CONTROLLED_HISTORY_FAILURE'}));window.__cetameshEvent({event:'approval.operation',data:{operationId:'bounded-history-99'}});};
 window.resetApprovals=()=>{window.fixture.operations=[];window.fixture.selectedSession=session;window.fixture.remount++;window.startApprovals();window.renderChat();};
 window.releaseApprovalLists=()=>{window.fixture.holdApprovalLists=false;for(const r of window.fixture.heldApprovalLists.splice(0))window.__cetameshReceive({id:r.id,ok:true,result:reply(r)});};
 window.leaveChat=()=>app.render(<main className="fixture">Controlled Settings page</main>);
 window.releaseScrollHistory=()=>{window.fixture.phase='terminal';for(const r of window.fixture.held.splice(0))window.__cetameshReceive({id:r.id,ok:true,result:reply(r)});};
 window.fixtureUi=useUi;
 `},bundle:true,write:false,outfile:'fixture.js',format:'iife',platform:'browser',jsx:'automatic',plugins:[{name:'export-production-chat',setup(build){build.onLoad({filter:/[\\/]HarborApp\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {ChatPage};',loader:'tsx',resolveDir:path.dirname(args.path)}));}}]});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><style>'+css+'html,body,#root{height:100%;margin:0}.fixture{height:100%;grid-row:auto;grid-column:auto}</style><div id="root"></div><script>'+js.replaceAll('</script','<\\/script')+'</script>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),profile=path.join(output,'profile');browser=spawn(edge,['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 browserClosed=new Promise(resolve=>browser.once('close',resolve));
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);assert.ok(fs.existsSync(portFile));const[port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 let sequence=0;const pending=new Map();socket.on('message',bytes=>{const r=JSON.parse(String(bytes)),e=pending.get(r.id);if(!e)return;pending.delete(r.id);clearTimeout(e.timer);r.error?e.reject(Error(r.error.message)):e.resolve(r.result);});const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});closeBrowser=()=>rpc('Browser.close');
 const target=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});await rpc('Page.enable',{},sessionId);
 const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(40);}throw Error('Timed out '+expression+' '+JSON.stringify(await evaluate('({text:document.body.innerText,fixture:window.fixture})')));};
 const capture=async name=>{const r=await rpc('Page.captureScreenshot',{format:'png'},sessionId);fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
 await rpc('Page.navigate',{url:'http://127.0.0.1:'+server.address().port},sessionId);await until('document.querySelectorAll(".chat-activity-card").length===1');await capture('before');const before=await evaluate('document.querySelectorAll(".chat-activity-card").length');
 await evaluate('window.finish()');await until('window.fixture.held.length>0');await delay(120);const held=await evaluate('document.querySelectorAll(".chat-activity-card").length');await capture('held');
 await evaluate('window.release()');await until('document.querySelectorAll(".chat-activity-card").length===1');const after=await evaluate('document.querySelectorAll(".chat-activity-card").length');
 await evaluate('window.fixture.remount=1;window.renderChat()');await until('document.querySelectorAll(".chat-activity-card").length===1');const remount=await evaluate('document.querySelectorAll(".chat-activity-card").length');
 await evaluate('window.startApprovals()');await until('document.querySelectorAll(".approval-card").length===2');
 const approvalA='[...document.querySelectorAll(".approval-card")].find(el=>el.innerText.includes("Controlled approval a"))';
 await evaluate(approvalA+'.querySelectorAll("button")[1].click()');await until('window.fixture.approvalRequests.length===1');
 assert.equal(await evaluate(approvalA+'.querySelectorAll("button")[1].disabled'),true,'only the submitted approval must disable its decision buttons while awaiting its exact reply');
 assert.equal(await evaluate('[...document.querySelectorAll(".approval-card")].find(el=>el.innerText.includes("Controlled approval b")).querySelectorAll("button")[1].disabled'),false,'another approval remains actionable');
 await evaluate('window.failSubmission()');await until('document.body.innerText.includes("Controlled approval submission failed")');
 assert.equal(await evaluate('document.querySelectorAll(".approval-card").length'),2,'submission failure preserves both exact approvals');
 await until(approvalA+'.querySelectorAll("button")[1].disabled===false');await evaluate(approvalA+'.querySelectorAll("button")[1].click()');await until('window.fixture.approvalRequests.length===2');
 await evaluate('window.fixture.holdApprovalLists=true;window.acceptSubmission()');await until('document.querySelector(".approval-operation-row .status-accepted")&&window.fixture.heldApprovalLists.length>0');
 assert.equal(await evaluate('document.querySelectorAll(".approval-operation-row").length'),1,'an acknowledgement seeds an operation not yet observed through the inbox');
 await evaluate('window.releaseApprovalLists()');await until('document.querySelectorAll(".approval-card").length===1&&document.body.innerText.includes("执行中")');
 assert.equal(await evaluate('document.body.innerText.includes("Controlled approval b")'),true,'accepting a never removes b');
 await evaluate('window.failOperation()');await until('document.body.innerText.includes("CONTROLLED_ASYNC_FAILURE")');
 assert.equal(await evaluate('window.fixture.approvalRequests.length'),2,'an async operation failure is observed, never replayed');
 await evaluate('window.fixture.remount=2;window.renderChat()');await until('document.body.innerText.includes("CONTROLLED_ASYNC_FAILURE")&&document.querySelectorAll(".approval-card").length===1');
 const approvalB='[...document.querySelectorAll(".approval-card")].find(el=>el.innerText.includes("Controlled approval b"))';
 await evaluate(approvalB+'.querySelectorAll("button")[1].click()');await until('window.fixture.approvalRequests.length===3');
 await evaluate('window.switchChat()');await until('document.body.innerText.includes("Second controlled chat")');
 await evaluate('window.failSubmission()');await until(approvalB+'.querySelectorAll("button")[1].disabled===false');
 assert.equal(await evaluate(approvalB+'.innerText.includes("Controlled approval submission failed")'),true,'the exact global approval retains its uncertain submission when the selected Chat changes');
 assert.equal(await evaluate(approvalB+'.querySelectorAll("button")[0].disabled'),true,'an unconfirmed decision keeps same-decision retry after switching Chat');
 await evaluate('window.manyOperations()');await until('document.body.innerText.includes("bounded-history-99")');
 assert.equal(await evaluate('document.querySelectorAll(".approval-operation-row").length'),40,'large approval histories initially mount a bounded page');
 await evaluate('[...document.querySelectorAll("button")].find(el=>el.innerText.includes("再显示40项")).click()');
 await until('document.querySelectorAll(".approval-operation-row").length===80');
 assert.equal(await evaluate('window.fixture.approvalRequests.length'),3,'expanding history never repeats a decision');
 const delayedAcknowledgements=[];
 const operationA='[...document.querySelectorAll(".approval-operation-row")].find(el=>el.querySelector("small")?.textContent.startsWith("approval:a"))';
 for(const scenario of [
  {selection:'switched',status:'failed',diagnostic:{resumeError:'CONTROLLED_RESUME_FAILURE'},message:'CONTROLLED_RESUME_FAILURE'},
  {selection:'unchanged',status:'unknown',diagnostic:{code:'CORE_RESTART_RECONCILIATION_REQUIRED'},message:'CORE_RESTART_RECONCILIATION_REQUIRED'}
 ]){
  await evaluate('window.resetApprovals()');await until('document.querySelectorAll(".approval-card").length===2&&document.querySelectorAll(".approval-operation-row").length===0');
  const firstRequest=await evaluate('window.fixture.approvalRequests.length');
  await evaluate(approvalA+'.querySelectorAll("button")[1].click()');await until('window.fixture.approvalRequests.length==='+String(firstRequest+1));
  await evaluate('window.holdAcceptedSubmission()');
  if(scenario.selection==='switched'){await evaluate('window.switchChat()');await until('document.body.innerText.includes("Second controlled chat")');}
  await evaluate('window.failOperation('+JSON.stringify(scenario.status)+','+JSON.stringify(scenario.diagnostic)+')');
  await until(operationA+'?.querySelector(".status-'+scenario.status+'")&&'+operationA+'?.innerText.includes('+JSON.stringify(scenario.message)+')');
  // No later successful list read may repair and hide a stale ACK overwrite.
  await evaluate('window.fixture.holdApprovalLists=true;window.releaseAcceptedSubmission()');
  if(scenario.selection==='unchanged')await until('window.fixture.heldApprovalLists.length>0');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const observation=await evaluate('({status:'+operationA+'?.querySelector(".approval-operation-status")?.className,diagnostic:'+operationA+'?.querySelector("small")?.textContent,stopButtons:'+operationA+'?.querySelectorAll("button").length,otherApprovalEnabled:'+approvalB+'?.querySelectorAll("button")[1].disabled===false})');
  await evaluate(approvalB+'.querySelectorAll("button")[1].click()');await until('window.fixture.approvalRequests.length==='+String(firstRequest+2));
  await evaluate('window.failSubmission()');await until(approvalB+'.querySelectorAll("button")[1].disabled===false');
  await evaluate('window.releaseApprovalLists();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const decisions=await evaluate('window.fixture.approvalRequests.slice('+firstRequest+').map(r=>({id:r.params.id,approve:r.params.approve}))');
  delayedAcknowledgements.push({selection:scenario.selection,...observation,decisions});
 }
 await evaluate('window.fixture.approvals=[];window.fixture.operations=[];window.fixture.phase="terminal";window.fixture.customHistory={messages:Array.from({length:80},(_,i)=>({id:"scroll-"+i,role:"assistant",text:"阅读位置 "+i+" · "+"保留原始消息内容。".repeat(12),at:1,attachments:[],toolActivity:[]})),hasMore:false};window.fixture.remount=100;window.renderChat()');
 await until('document.querySelector(".virtual-scroll")?.scrollHeight>2000');await delay(200);
 await evaluate('const n=document.querySelector(".virtual-scroll");n.scrollTop=500;n.dispatchEvent(new Event("scroll",{bubbles:true}))');await delay(150);
 const readingAnchor=await evaluate('(()=>{const n=document.querySelector(".virtual-scroll"),top=n.getBoundingClientRect().top;const row=[...n.querySelectorAll("[data-virtual-key]")].find(r=>r.getBoundingClientRect().bottom>top+1);return{key:row.dataset.virtualKey,offset:row.getBoundingClientRect().top-top}})()');
 await evaluate('window.fixture.remount=101;window.renderChat()');
 await until('Array.from(document.querySelectorAll("[data-virtual-key]")).some(r=>r.dataset.virtualKey==='+JSON.stringify(readingAnchor.key)+')');await delay(200);
 await until('(()=>{const row=Array.from(document.querySelectorAll("[data-virtual-key]")).find(r=>r.dataset.virtualKey==='+JSON.stringify(readingAnchor.key)+');return row&&Math.abs(row.getBoundingClientRect().top-document.querySelector(".virtual-scroll").getBoundingClientRect().top-('+readingAnchor.offset+'))<3})()');
 const restoredAnchor=await evaluate('(()=>{const row=Array.from(document.querySelectorAll("[data-virtual-key]")).find(r=>r.dataset.virtualKey==='+JSON.stringify(readingAnchor.key)+');return row.getBoundingClientRect().top-document.querySelector(".virtual-scroll").getBoundingClientRect().top})()');
 assert.ok(Math.abs(restoredAnchor-readingAnchor.offset)<3,'ordinary Chat preserves visible message anchor after page remount '+JSON.stringify({readingAnchor,restoredAnchor}));
 const visibleAnchor='(()=>{const n=document.querySelector(".virtual-scroll"),top=n.getBoundingClientRect().top;const row=[...n.querySelectorAll("[data-virtual-key]")].find(r=>r.getBoundingClientRect().bottom>top+1);return{key:row.dataset.virtualKey,offset:row.getBoundingClientRect().top-top}})()';
 const expectAnchor=async(anchor)=>{
  await until('(()=>{const n=document.querySelector(".virtual-scroll"),row=n&&[...n.querySelectorAll("[data-virtual-key]")].find(r=>r.dataset.virtualKey==='+JSON.stringify(anchor.key)+');return row&&Math.abs(row.getBoundingClientRect().top-n.getBoundingClientRect().top-('+anchor.offset+'))<3})()');
  await delay(150);
  const actual=await evaluate(visibleAnchor);
  assert.equal(actual.key,anchor.key,'the same message remains visible after layout settles');
  assert.ok(Math.abs(actual.offset-anchor.offset)<3,JSON.stringify({anchor,actual}));
 };
 const leaveChat=async()=>{await evaluate('window.leaveChat()');await until('document.body.innerText.includes("Controlled Settings page")');};
 // Unmount for another page, then return with delayed history. Leaving that
 // loading page must neither replace the saved position nor accept its late reply.
 await leaveChat();
 const savedSession=await evaluate('Object.keys(window.fixtureUi.getState().chatViewports).find(id=>window.fixtureUi.getState().chatViewports[id].anchor?.key==='+JSON.stringify(readingAnchor.key)+')');
 assert.ok(savedSession);
 const savedViewport=await evaluate('window.fixtureUi.getState().chatViewports['+JSON.stringify(savedSession)+']');
 await evaluate('window.fixture.phase="held";window.renderChat()');await until('window.fixture.held.length>0');
 await leaveChat();
 assert.deepEqual(await evaluate('window.fixtureUi.getState().chatViewports['+JSON.stringify(savedSession)+']'),savedViewport,'an unloaded history cannot overwrite a reading position');
 await evaluate('window.releaseScrollHistory();window.renderChat()');await expectAnchor(readingAnchor);
 // A new session has its own bottom-follow state; returning to the old one
 // must not inherit it. Vary row heights to exercise real virtual measurements.
 await leaveChat();
 await evaluate('window.fixture.originalScrollSession=window.fixture.selectedSession;window.fixture.selectedSession={...window.fixture.selectedSession,id:"independent-scroll-session"};window.fixture.remount++;window.renderChat()');
 const atBottom='(()=>{const n=document.querySelector(".virtual-scroll");return n&&n.scrollHeight>2000&&n.scrollHeight-n.scrollTop-n.clientHeight<3})()';
 await until(atBottom);
 await evaluate('(()=>{const n=document.querySelector(".virtual-scroll");n.scrollTop=1100;n.dispatchEvent(new Event("scroll",{bubbles:true}));})()');await delay(150);
 const secondAnchor=await evaluate(visibleAnchor);
 await leaveChat();
 await evaluate('window.fixture.selectedSession=window.fixture.originalScrollSession;window.fixture.remount++;window.renderChat()');await expectAnchor(readingAnchor);
 await leaveChat();
 await evaluate('window.fixture.selectedSession={...window.fixture.originalScrollSession,id:"independent-scroll-session"};window.fixture.remount++;window.renderChat()');await expectAnchor(secondAnchor);
 // Messages arriving while reading older text must not pull the reader down.
 await leaveChat();
 await evaluate('window.fixture.customHistory.messages.push({id:"scroll-arrived",role:"assistant",text:"New message while away "+"bounded text ".repeat(40),at:2,attachments:[],toolActivity:[]});window.renderChat()');await expectAnchor(secondAnchor);
 // Conversely, a user who left at the bottom should follow the latest reply.
 await evaluate('(async()=>{const n=document.querySelector(".virtual-scroll");let stable=0;for(let step=0;step<30;step++){n.scrollTop=n.scrollHeight;n.dispatchEvent(new Event("scroll",{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));stable=n.scrollHeight-n.scrollTop-n.clientHeight<3?stable+1:0;if(stable===3)return;}})()');await until(atBottom);
 await leaveChat();
 await evaluate('window.fixture.customHistory.messages.push({id:"scroll-latest",role:"assistant",text:"Latest reply "+"variable height ".repeat(60),at:3,attachments:[],toolActivity:[]});window.renderChat()');await until(atBottom);
 assert.equal(await evaluate('Array.from(document.querySelectorAll("[data-virtual-key]")).some(row=>row.dataset.virtualKey==="message:scroll-latest")'),true,'returning at the bottom includes the latest message');
 const scrollRetention={immediateRemount:true,pageReturn:true,lateHistoryIgnored:true,loadingExitPreservesPosition:true,independentSessions:true,readingAnchor,secondAnchor,newMessagesPreserveReading:true,bottomFollowsLatest:true};
 console.log('Chat viewport regression: '+JSON.stringify(scrollRetention));
 const facts={scope:'Production ChatPage and bridge in Chromium, actual Chat/DTO snapshots, controlled history/approval transport; no native WebView2',before,whileHistoryHeld:held,afterHistoryRelease:after,afterRemount:remount,approvalSubmissionFailureRetained:true,exactApprovalRetryCount:2,asyncFailureRestored:true,switchedApprovalFailureRetained:true,delayedAcknowledgements,scrollRetention,errors:await evaluate('window.fixture.errors')};fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify(facts));console.log('Evidence: '+path.join(output,'results.json'));assert.equal(held,1,'Activity card must survive terminal status while durable history is pending');
 assert.deepEqual(delayedAcknowledgements,[
  {selection:'switched',status:'approval-operation-status status-failed',diagnostic:'approval:a · CONTROLLED_RESUME_FAILURE',stopButtons:0,otherApprovalEnabled:true,decisions:[{id:'a',approve:true},{id:'b',approve:true}]},
  {selection:'unchanged',status:'approval-operation-status status-unknown',diagnostic:'approval:a · CORE_RESTART_RECONCILIATION_REQUIRED',stopButtons:0,otherApprovalEnabled:true,decisions:[{id:'a',approve:true},{id:'b',approve:true}]}
 ],'A delayed accepted acknowledgement must preserve the already observed final operation, diagnostic and stop state across either Chat selection');
 assert.equal(await evaluate('window.fixture.calls.filter(method=>method==="ui.approvals.cancel").length'),0,'observing or releasing an acknowledgement never submits a stop/effect command');failed=false;
}finally{
 if(socket?.readyState===WebSocket.OPEN){try{await closeBrowser();}catch{console.warn('Owned browser CDP close did not acknowledge; checking process exit.');}socket.terminate();}
 // Browser.close is asynchronous. Await this exact owned child before invoking
 // forced tree cleanup; a fixed 200ms delay races a normal browser shutdown.
 if(browserClosed)await Promise.race([browserClosed,delay(3000)]);
 if(browser?.pid&&browser.exitCode===null&&browser.signalCode===null)await terminateSuiteProcessTree(browser);
 if(server)await new Promise(resolve=>server.close(resolve));finalizeSuiteSandbox({sandbox,failed});
}
