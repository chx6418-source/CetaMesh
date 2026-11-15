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
const sandbox=createSuiteSandbox({suiteId:'chat-welcome-ui'}),output=sandbox.root;
let failed=true;
const require=createRequire(path.join(uiRoot,'package.json'));
const {build}=require('esbuild'),WebSocket=require('ws');
const {createChatService}=await import(pathToFileURL(path.join(repo,'src/desktop/chat-service.js')));
const {createDesktopUiService}=await import(pathToFileURL(path.join(repo,'src/desktop/ui-service.js')));
const {terminateSuiteProcessTree}=await import(pathToFileURL(path.join(repo,'src/testing/suite-process.js')));
const {createChatService: createWelcomeChat}=await import(pathToFileURL(path.join(repo,'src/desktop/chat-service.js')));
const welcomeChat=createWelcomeChat({stateDir:path.join(output,'state'),defaults:{},defaultAgentProvider:()=> 'none'});
const session=await welcomeChat.execute({method:'chat.sessions.create',params:{}});
const terminal={status:await welcomeChat.execute({method:'chat.status',params:{id:session.id}}),history:await welcomeChat.execute({method:'chat.history',params:{id:session.id}})};
const active=terminal;await welcomeChat.close();
let server,browser,socket,closeBrowser,browserClosed;
try{
 const bundle=await build({stdin:{resolveDir:uiRoot,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{ChatPage,HarborWorkspaceApp}from'./src/app/HarborApp';import{MemoryRouter}from'react-router';import{useUi}from'./src/stores/ui';import{diagnosticClientFailure}from'./src/app/StartupDiagnostics';import'./src/theme/tokens.css';import'./src/theme/global.css';
 import {AppearanceSettings} from './src/app/AppearanceSettings';import {WindowChrome} from './src/app/WindowChrome';import {Sheet,Dialog} from './src/components/primitives/overlays';import {applyAppearance,readAppearance} from './src/theme/appearance';
 import {WorkspaceSidebar} from './src/app/WorkspaceSidebar';import {useResponsiveSidebar} from './src/app/useResponsiveSidebar';
 const session=${JSON.stringify(session)},active=${JSON.stringify(active)},terminal=${JSON.stringify(terminal)};window.fixture={phase:'active',held:[],calls:[],errors:[],approvals:[],operations:[],approvalRequests:[],heldApprovalLists:[],holdApprovalLists:false};window.addEventListener('error',e=>window.fixture.errors.push(e.message));
 window.lastCaptionAppearance=()=>window.fixture.windowActions?.findLast(row=>row.palette);
 function reply(r){window.fixture.calls.push(r.method);if(r.method==='ui.chat.status'&&window.fixture.customStatus)return window.fixture.customStatus;if(r.method==='ui.chat.history'&&window.fixture.customHistory)return window.fixture.customHistory;if(r.method==='ui.chat.history')return window.fixture.phase==='active'?active.history:terminal.history;if(r.method==='ui.chat.status')return window.fixture.phase==='active'?active.status:terminal.status;if(r.method==='ui.events.next')return{events:[],instanceId:'activity-fixture',cursor:0};if(r.method==='ui.chat.catalog')return{models:[],modelProviders:[],agentProviders:[],modes:['chat'],defaultModelProvider:null,available:true,reason:null};if(r.method==='ui.memory.overview')return{memories:[],total:0,candidates:[]};if(r.method==='ui.approvals.list')return{approvals:window.fixture.approvals,operations:window.fixture.operations,grants:[]};if(r.method.startsWith('app.diagnostics.'))return{report:diagnosticClientFailure('FIXTURE',false),coreAvailable:true};return r.method.includes('limits')?{limits:{}}:r.method.includes('capabilities')?{supported:false,status:'unknown'}:{};}
 window.ipc={postMessage(raw){const r=JSON.parse(raw);
 if(r.method==='app.windowAction'){(window.fixture.windowActions??=[]).push(r.params);const width=Math.round(innerWidth*devicePixelRatio),captionHeight=Math.round(40*devicePixelRatio),height=Math.round(innerHeight*devicePixelRatio)+captionHeight;const frame={id:[width,height,captionHeight,Math.round(devicePixelRatio*96)].join('-'),width,height,captionHeight};setTimeout(()=>window.__cetameshReceive({id:r.id,ok:true,result:{maximized:false,nativeChrome:true,...(window.fixture.captionEnabled?{captionBackdrop:{enabled:true,active:!!window.fixture.captionSurface,frame}}:{})}}),0);return;}
 if(r.method==='app.captionBackdrop'){window.fixture.captionSurface=r.params.surface;(window.fixture.captionRequests??=[]).push(r);if(r.params.surface&&window.fixture.holdCaption){(window.fixture.heldCaption??=[]).push(r);return;}setTimeout(()=>window.__cetameshReceive({id:r.id,ok:true,result:{applied:!!r.params.surface}}),0);return;}
 if(window.fixture.shell&&r.method==='ui.chat.sessions.list'){window.fixture.listRequests=(window.fixture.listRequests||0)+1;setTimeout(()=>window.__cetameshReceive(window.fixture.failList?{id:r.id,ok:false,error:{code:'LIST_FAIL',message:'Controlled list failure'}}:{id:r.id,ok:true,result:{sessions:window.fixture.shellSessions||[]}}),0);return;}
 if(window.fixture.shell&&r.method==='ui.chat.sessions.create'){window.fixture.creates=(window.fixture.creates||0)+1;window.fixture.heldCreates??=[];window.fixture.heldCreates.push(r);return;}
 if(window.fixture.shell){const values={'ui.workspace.list':{workspaces:[],activeId:null},'ui.onboarding.status':{complete:true},'ui.settings.get':{settings:{general:{}},fields:[]},'app.status':{ready:true},'ui.feedback.links':{entries:[],configured:false,message:''}};if(r.method in values){setTimeout(()=>window.__cetameshReceive({id:r.id,ok:true,result:values[r.method]}),0);return;}}
if(r.method==='ui.chat.history'&&window.fixture.phase==='held'){window.fixture.held.push(r);return;}if(r.method==='ui.approvals.decide'){window.fixture.approvalRequests.push(r);return;}setTimeout(()=>{if(r.method==='ui.approvals.list'&&window.fixture.holdApprovalLists){window.fixture.heldApprovalLists.push(r);return;}window.__cetameshReceive({id:r.id,ok:true,result:reply(r)});},r.method==='ui.events.next'?200:0);}};
 const app=createRoot(document.getElementById('root'));window.renderChat=()=>app.render(<main className="harbor-main fixture"><ChatPage key={window.fixture.remount??0} session={window.fixture.noSession?null:window.fixture.selectedSession??session} prepareReady={window.fixture.prepareReady??false} onPrepare={async()=>{window.fixture.preparations=(window.fixture.preparations||0)+1;}} preparationError={window.fixture.preparationError??''} workspaces={[]} activeWorkspaceId={null} onSessionUpdate={()=>{}} onNew={async()=>{}} onNewChat={async()=>{}} onOpenMemory={()=>{}} onConfigureModels={()=>{}} onReviewTask={()=>{}}/></main>);window.renderChat();
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
 function AppearanceFixture(){const appearance=useUi(state=>state.appearance),theme=useUi(state=>state.theme);const[open,setOpen]=React.useState(false),[dialogOpen,setDialogOpen]=React.useState(false);React.useLayoutEffect(()=>{document.documentElement.dataset.theme=theme==='dark'?'dark':'light';applyAppearance(document.documentElement,appearance,theme==='dark');},[appearance,theme]);return <div className="harbor-shell"><WindowChrome/><main className="page-frame page-settings" style={{gridColumn:'1/-1',gridRow:2,padding:28}}><AppearanceSettings theme={theme} onThemeChange={value=>useUi.getState().setTheme(value)}/><button id="open-secondary" onClick={()=>setOpen(true)}>Open secondary panel</button><button id="open-native-dialog" onClick={()=>setDialogOpen(true)}>Open native dialog</button><Sheet open={open} onClose={()=>setOpen(false)} title="Controlled task details"><input aria-label="Controlled detail input"/><button>Controlled action</button>{Array.from({length:30},(_,i)=><p key={i}>Preserved task evidence {i}</p>)}</Sheet><Dialog open={dialogOpen} onClose={()=>setDialogOpen(false)} title="Controlled confirmation"><input aria-label="Controlled confirmation input"/><button>Controlled confirmation action</button></Dialog></main></div>}
 window.renderAppearance=()=>{window.__CETAMESH_NATIVE_CHROME__=true;app.render(<AppearanceFixture/>);};window.readAppearance=readAppearance;
 function RailFixture(){const[page,setPage]=React.useState('chat');const{collapsed,toggle}=useResponsiveSidebar(page);return <div className={'harbor-shell '+(collapsed?'sidebar-collapsed':'')} data-page={page}><WorkspaceSidebar page={page} workspaces={[]} sessions={[]} activeWorkspaceId={null} activeSessionId="" taskCount={2} hostStatus="ready" collapsed={collapsed} onToggle={toggle} onNavigate={setPage} onOpenWorkspace={()=>{}} onOpenSession={()=>{}} onNewSession={()=>{}} onAllSessions={()=>{}} renderSessionActions={()=>null}/><div className="harbor-main"><main className={'page-frame page-'+page}>Controlled page</main></div></div>}
 window.renderRail=()=>app.render(<RailFixture/>);
 window.sampleRail=()=>new Promise(resolve=>{const rows=[],started=performance.now();const tick=()=>{const rail=document.querySelector('.navigation-rail'),sidebar=document.querySelector('.harbor-sidebar'),button=rail.querySelector('[aria-label="Chat"]'),r=rail.getBoundingClientRect(),b=button.getBoundingClientRect();rows.push({width:r.width,center:b.x+b.width/2,railBorder:parseFloat(getComputedStyle(rail).borderRightWidth),sidebarBorder:parseFloat(getComputedStyle(sidebar).borderRightWidth)});performance.now()-started>=260?resolve(rows):requestAnimationFrame(tick);};requestAnimationFrame(tick);});
 window.renderShell=()=>app.render(<MemoryRouter><HarborWorkspaceApp/></MemoryRouter>);
 window.resolveCreation=(fail=false)=>{const r=window.fixture.heldCreates.shift();const created={...session,id:'prepared-local-session',taskId:null,config:{agentProvider:'none',mode:'chat'}};if(!fail)window.fixture.shellSessions=[created];window.__cetameshReceive(fail?{id:r.id,ok:false,error:{code:'CREATE_FAIL',message:'Controlled create failure'}}:{id:r.id,ok:true,result:created});};
 `},bundle:true,write:false,outfile:'fixture.js',format:'iife',platform:'browser',jsx:'automatic',plugins:[{name:'export-production-chat',setup(build){build.onLoad({filter:/[\\/]HarborApp\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {ChatPage,HarborWorkspaceApp};',loader:'tsx',resolveDir:path.dirname(args.path)}));}}]});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><style>'+css+'html,body,#root{height:100%;margin:0}.fixture{height:100%;grid-row:auto;grid-column:auto}</style><div id="root"></div><script>'+js.replaceAll('</script','<\\/script')+'</script>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),profile=path.join(output,'profile');browser=spawn(edge,['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 browserClosed=new Promise(resolve=>browser.once('close',resolve));
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);assert.ok(fs.existsSync(portFile));const[port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 let sequence=0;const pending=new Map();socket.on('message',bytes=>{const r=JSON.parse(String(bytes)),e=pending.get(r.id);if(!e)return;pending.delete(r.id);clearTimeout(e.timer);r.error?e.reject(Error(r.error.message)):e.resolve(r.result);});const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});closeBrowser=()=>rpc('Browser.close');
 const target=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});await rpc('Page.enable',{},sessionId);
 const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(40);}throw Error('Timed out '+expression+' '+JSON.stringify(await evaluate('({text:document.body.innerText,fixture:window.fixture})'),(key,value)=>key==='pixels'||key==='image'?'[redacted presentation data]':value));};
 const capture=async name=>{const r=await rpc('Page.captureScreenshot',{format:'png'},sessionId),bytes=Buffer.from(r.data,'base64');fs.writeFileSync(path.join(output,name+'.png'),bytes);if(process.env.WHALEBRIDGE_UI_CAPTURE_DIR){fs.mkdirSync(process.env.WHALEBRIDGE_UI_CAPTURE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.WHALEBRIDGE_UI_CAPTURE_DIR,name+'.png'),bytes);}};
 await rpc('Page.navigate',{url:'http://127.0.0.1:'+server.address().port},sessionId);await until('typeof window.renderChat==="function"');
 // Confirmed empty histories use the shared Composer; pending/error/task states do not.
 await evaluate('window.fixture.approvals=[];window.fixture.operations=[];window.fixture.customHistory={messages:[],hasMore:false};window.fixture.customStatus={state:"idle",displayText:"",toolActivity:[],routing:{}};window.fixture.selectedSession={...window.fixture.selectedSession,id:"welcome-fixture",taskId:null,config:{agentProvider:"none",mode:"chat"}};window.fixture.remount=(window.fixture.remount||0)+1;window.renderChat()');
 await until('!!document.querySelector(".chat-welcome-heading")');
 await evaluate('window.fixture.operations=[{operationId:"settled-history",approvalId:"settled",status:"completed",decision:"approved"}];window.__cetameshEvent({event:"approval.operation",data:window.fixture.operations[0]})');await delay(120);
 assert.equal(await evaluate('document.querySelector(".approval-operation-history")'),null,'settled operations have no Chat history bar');
 assert.equal(await evaluate('!!document.querySelector(".chat-welcome-heading")'),true,'settled global operation history creates no empty timeline row');
 assert.equal(await evaluate('document.querySelectorAll("textarea[aria-label=输入消息]").length'),1);
 assert.equal(await evaluate('document.querySelector(".conversation-heading")'),null,'no duplicate new-chat heading');
 for(const width of [1280,640]){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false},sessionId);await delay(100);
  const bounds=await evaluate('(()=>{const h=document.querySelector(".chat-welcome-heading").getBoundingClientRect(),c=document.querySelector(".composer-field").getBoundingClientRect();return{gap:c.top-h.bottom,left:c.left,right:c.right,bottom:c.bottom,width:innerWidth}})()');
  assert.ok(bounds.gap>=0&&bounds.gap<50,JSON.stringify(bounds));assert.ok(bounds.left>=0&&bounds.right<=width+1&&bounds.bottom<800,JSON.stringify(bounds));
  await capture('welcome-'+width);
 }
 await evaluate('window.fixtureUi.getState().setChatDraft("welcome-fixture","Preserved welcome draft");window.welcomeInput=document.querySelector("textarea[aria-label=输入消息]");true');
 await until('document.querySelector("textarea[aria-label=输入消息]").value==="Preserved welcome draft"');
 await evaluate('window.fixture.customHistory.messages=[{id:"welcome-first",role:"user",text:"First message",attachments:[],toolActivity:[],at:1}];window.__cetameshEvent({event:"chat.updated",data:{sessionId:"welcome-fixture"}})');
 await until('!!document.querySelector(".chat-message")');
 assert.equal(await evaluate('document.querySelector("textarea[aria-label=输入消息]")===window.welcomeInput'),true,'first message keeps Composer DOM and focus/draft');
 await evaluate('window.leaveChat();window.renderChat()');await until('document.querySelector("textarea[aria-label=输入消息]")?.value==="Preserved welcome draft"');
 await evaluate('window.fixture.noSession=true;window.fixture.remount++;window.renderChat()');await delay(100);
 assert.equal(await evaluate('window.fixture.preparations||0'),0,'session list must finish before preparation');
 await evaluate('window.fixture.prepareReady=true;window.renderChat()');await until('window.fixture.preparations===1');
 await evaluate('window.renderChat()');await delay(100);assert.equal(await evaluate('window.fixture.preparations'),1,'ordinary refresh must not prepare duplicate sessions');
 await evaluate('window.fixture.preparationError="Controlled session creation failure";window.renderChat()');await until('document.body.innerText.includes("Controlled session creation failure")');
 assert.equal(await evaluate('window.fixture.calls.filter(method=>method==="ui.chat.send").length'),0,'welcome initialization never sends a model request');
 console.log('PASS welcome layout, shared Composer identity, draft retention, guarded one-shot preparation and visible failure');

 // Parent read/write retry separation and late creation must preserve navigation.
 await evaluate('window.fixture.customHistory={messages:[],hasMore:false};window.fixture.shell=true;window.fixture.failList=true;window.fixture.noSession=false;window.renderShell()');
 await until('document.body.innerText.includes("Controlled list failure")');
 assert.equal(await evaluate('window.fixture.creates||0'),0,'failed list does not create a replacement history');
 await evaluate('document.querySelector(".chat-welcome-preparing .cm-button").click()');await until('window.fixture.listRequests===2');
 assert.equal(await evaluate('window.fixture.creates||0'),0,'Retry retries the failed read, never creates');
 await evaluate('window.fixture.failList=false;document.querySelector(".chat-welcome-preparing .cm-button").click()');await until('window.fixture.creates===1');
 await evaluate('window.__cetameshEvent({event:"chat.updated",data:{}})');await delay(100);assert.equal(await evaluate('window.fixture.creates'),1,'concurrent refresh never duplicates preparation');
 await evaluate('window.resolveCreation(true)');await until('document.body.innerText.includes("Controlled create failure")');
 await evaluate('window.__cetameshEvent({event:"chat.updated",data:{}})');await delay(100);
 assert.equal(await evaluate('document.querySelector(".chat-welcome-preparing").innerText.includes("Controlled create failure")'),true,'successful empty list refresh retains creation failure and retry');
 await evaluate('document.querySelector(".chat-welcome-preparing .cm-button").click()');await until('window.fixture.creates===2');
 await evaluate('document.querySelector("button[aria-label=关于]").click()');await until('document.querySelector(".page-about")!==null');
 await evaluate('window.resolveCreation()');await delay(100);assert.equal(await evaluate('!!document.querySelector(".page-about")'),true,'late preparation does not hijack navigation '+JSON.stringify(await evaluate('({text:document.body.innerText,errors:window.fixture.errors})')));
 await evaluate('document.querySelector("button[aria-label=Chat]").click()');await until('!!document.querySelector(".chat-welcome-heading")');
 assert.equal(await evaluate('window.fixture.creates'),2,'return to chat reuses the successfully prepared session');
 console.log('PASS real parent initialization: list retry, creation retry, single-flight and late navigation');
 // Real source components, local image decoding/storage and synthetic native IPC.
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
 await evaluate('window.renderAppearance()');await until('document.querySelectorAll(".appearance-scheme").length===8');
 await until('window.fixture.windowActions?.some(row=>row.palette?.length===7)');
 await evaluate('document.querySelectorAll(".appearance-scheme")[1].click()');await until('document.documentElement.dataset.colorScheme==="white"');
 assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--background").trim()'),'#ffffff');
 await until('window.lastCaptionAppearance()?.palette?.[0]==="#fbfbfb"');
 await capture('appearance-white');
 await evaluate('document.querySelectorAll(".appearance-scheme")[2].click()');await until('document.documentElement.dataset.theme==="dark"');
 await until('window.lastCaptionAppearance()?.palette?.[0]==="#090909"');
 await capture('appearance-black');
 await evaluate('document.querySelectorAll(".appearance-scheme")[3].click()');await until('document.documentElement.dataset.colorScheme==="blue"');
 const imported=await evaluate('(async()=>{const canvas=document.createElement("canvas");canvas.width=400;canvas.height=240;const ctx=canvas.getContext("2d");const g=ctx.createLinearGradient(0,0,400,240);g.addColorStop(0,"#47658a");g.addColorStop(1,"#9b7c9d");ctx.fillStyle=g;ctx.fillRect(0,0,400,240);const blob=await new Promise(r=>canvas.toBlob(r,"image/png")),input=document.querySelector("input[type=file]"),transfer=new DataTransfer();transfer.items.add(new File([blob],"owned-background.png",{type:"image/png"}));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');assert.equal(imported,true);
 await until('document.documentElement.dataset.customBackground==="true"');
 assert.equal(await evaluate('!!window.readAppearance().image'),true,'local background is persisted after decoding');
 await capture('appearance-custom-background');
 // Mount the real workspace and Chat together: an import-only appearance
 // fixture cannot catch wallpaper leaking through navigation or a solid
 // composer being pasted onto otherwise transparent content.
 await evaluate('window.wallpaperAppearance=window.readAppearance();window.wallpaperTheme=window.fixtureUi.getState().theme;window.fixture.failList=false;window.renderShell()');
 await until('!!document.querySelector(".chat-welcome-heading") && !!document.querySelector(".navigation-rail")');
 await evaluate('window.fixtureUi.getState().setChatDraft("prepared-local-session","Wallpaper keeps this draft")');
 await until('document.querySelector("textarea[aria-label=输入消息]").value==="Wallpaper keeps this draft"');
 const wallpaperFailures=[];
 for(const [scheme,theme] of [['original','light'],['original','dark'],['white','light'],['black','dark'],['blue','light']]){
  await evaluate(`window.fixtureUi.getState().setAppearance({scheme:${JSON.stringify(scheme)},strength:60,blur:0});window.fixtureUi.getState().setTheme(${JSON.stringify(theme)})`);
  await until(`document.documentElement.dataset.colorScheme===${JSON.stringify(scheme)} && document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
  for(const width of [1280,640]){
   await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false},sessionId);
   await delay(260);
   if(!await evaluate('!!document.querySelector(".workspace-panel")')){
    await evaluate('document.querySelector("[aria-label=展开工作区列表]").click()');
    await until('!!document.querySelector(".workspace-panel")');await delay(230);
   }
   const layers=await evaluate(`(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data);};
    const surface=selector=>{const node=document.querySelector(selector),style=getComputedStyle(node);return {rgba:rgba(style.backgroundColor),blur:style.backdropFilter,rect:node.getBoundingClientRect().toJSON()};};
    return {rail:surface('.navigation-rail'),workspace:surface('.workspace-panel'),page:surface('.page-frame'),composer:surface('.composer-field'),chrome:rgba(getComputedStyle(document.documentElement).getPropertyValue('--background-soft')),pane:surface('.conversation-pane'),dock:surface('.composer-dock'),overflow:document.documentElement.scrollWidth>innerWidth};
   })()`);
   if(layers.rail.rgba.some((value,index)=>Math.abs(value-layers.chrome[index])>1))wallpaperFailures.push({scheme,theme,width,layer:'rail/caption',actual:layers.rail.rgba,expected:layers.chrome});
   for(const [layer,min,max] of [['workspace',.8,.96],['page',.25,.75],['composer',.8,.96]]){
    const alpha=layers[layer].rgba[3]/255;
    if(alpha<min||alpha>max)wallpaperFailures.push({scheme,theme,width,layer,alpha});
   }
   assert.equal(layers.pane.rgba[3]+layers.dock.rgba[3],0,'layout wrappers never multiply the content veil');
   assert.equal(layers.overflow,false,'wallpaper surfaces must not enlarge the viewport');
   assert.equal(layers.rail.rect.width,48,'wallpaper does not resize the permanent rail');
   assert.ok(layers.workspace.rect.right<=width+1,'narrow workspace remains contained');
   assert.ok(layers.composer.rect.left>=0&&layers.composer.rect.right<=width+1,'composer remains contained');
   if(layers.composer.blur==='none')wallpaperFailures.push({scheme,theme,width,layer:'composer blur'});
   await capture(`wallpaper-layered-${scheme}-${theme}-${width}`);
   if(scheme==='original'&&theme==='light'){
    if(width===640){
     await evaluate('document.querySelector("[aria-label=收起工作区列表]").click()');
     await until('!document.querySelector(".workspace-panel")');await delay(230);
     await capture('wallpaper-layered-original-light-640-collapsed');
    }
    // Backdrop filters create stacking contexts. Both the local context menu
    // and the body-portaled model panel must still paint above the wallpaper
    // and accept hits within the viewport.
    for(const [trigger,panel] of [['.composer-context-trigger','.composer-context-options'],['[aria-label="选择模型与推理"]','.chat-model-popover.cm-popover-content']]){
     await evaluate(`document.querySelector(${JSON.stringify(trigger)}).focus();document.querySelector(${JSON.stringify(trigger)}).click()`);
     await until(`!!document.querySelector(${JSON.stringify(panel)})`);await delay(230);
     const menu=await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(panel)}),r=node.getBoundingClientRect(),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1);return {inside:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),alpha:ctx.getImageData(0,0,1,1).data[3]};})()`);
     assert.deepEqual(menu,{inside:true,hit:true,alpha:255},'wallpaper does not clip, obscure or make menus transparent: '+panel+' at '+width);
     await evaluate(`document.querySelector(${JSON.stringify(trigger)}).click()`);
     await until(`!document.querySelector(${JSON.stringify(panel)})`);
    }
   }
  }
 }
 assert.deepEqual(wallpaperFailures,[],'wallpaper requires a caption-matched rail, distinct readable tinted surfaces and a translucent composer');
 await evaluate('window.fixtureUi.getState().setAppearance({image:null})');
 await until('document.documentElement.dataset.customBackground==="false"');
 // The existing surface color transition outlives the attribute change.
 // Observe its settled paint instead of sampling the first animation frame.
 await until('(()=>{const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d");ctx.fillStyle=getComputedStyle(document.querySelector(".composer-field")).backgroundColor;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]===255;})()');
 const restored=await evaluate('(()=>{const composer=document.querySelector(".composer-field"),canvas=document.createElement("canvas"),ctx=canvas.getContext("2d");ctx.fillStyle=getComputedStyle(composer).backgroundColor;ctx.fillRect(0,0,1,1);return{alpha:ctx.getImageData(0,0,1,1).data[3],blur:getComputedStyle(composer).backdropFilter,draft:document.querySelector("textarea[aria-label=输入消息]").value}})()');
 assert.deepEqual(restored,{alpha:255,blur:'none',draft:'Wallpaper keeps this draft'},'removing wallpaper restores the normal surface and preserves the draft');
 assert.equal(await evaluate('window.fixture.calls.filter(method=>method==="ui.chat.send").length'),0,'wallpaper changes never send a model request');
 await evaluate('window.fixtureUi.getState().setAppearance(window.wallpaperAppearance);window.fixtureUi.getState().setTheme(window.wallpaperTheme);window.renderAppearance()');
 await until('!!document.getElementById("open-secondary")');
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
 console.log('PASS production wallpaper layering across five palettes and desktop/narrow windows; native rail tint, retained geometry/draft and clean background removal');
 // The accepted whole-window appearance must wait for a real Host receipt.
 // This controlled Host exposes physical frame geometry; source components
 // still decode the local wallpaper and compose the actual bounded pixels.
 await evaluate('window.fixture.captionEnabled=true;window.fixture.holdCaption=true;window.fixtureUi.getState().setAppearance({...window.wallpaperAppearance,scheme:"original",strength:60,blur:0});window.fixtureUi.getState().setTheme("light");window.__CETAMESH_NATIVE_CHAT_MODES__=true;window.renderShell()');
 await until('window.fixture.heldCaption?.length>0 && !!document.querySelector(".chat-welcome-heading")');
 assert.equal(await evaluate('document.documentElement.dataset.captionWallpaper'),undefined,'an unacknowledged native image never activates the new appearance');
 const pendingCaption=await evaluate('(()=>{const row=window.fixture.heldCaption.at(-1).params.surface,data=Uint8Array.from(atob(row.pixels),c=>c.charCodeAt(0));return{width:row.width,height:row.height,length:data.length,opaque:data.every((n,i)=>i%4!==3||n===255),varied:data.some((n,i)=>i%4===0&&n!==data[0])}})()');
 assert.ok(pendingCaption.width<=1024&&pendingCaption.height<=96);
 assert.equal(pendingCaption.length,pendingCaption.width*pendingCaption.height*4);assert.equal(pendingCaption.opaque,true);assert.equal(pendingCaption.varied,true,'native strip retains wallpaper color variation');
 await evaluate('window.fixture.holdCaption=false;for(const r of window.fixture.heldCaption.splice(0))window.__cetameshReceive({id:r.id,ok:true,result:{applied:true}})');
 await until('document.documentElement.dataset.captionWallpaper==="active"');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".harbor-shell")).borderRadius'),'0px','DWM owns outer window corners: no inner shell cutout may expose the white body');
 const perimeter=await evaluate('(()=>{const bytes=Uint8Array.from(atob(window.fixture.captionSurface.edges),c=>c.charCodeAt(0));return {length:bytes.length,opaque:bytes.every((n,i)=>i%4!==3||n===255),varied:bytes.some((n,i)=>i%4===0&&n!==bytes[0])}})()');
 assert.deepEqual(perimeter,{length:1024*3*4,opaque:true,varied:true},'native perimeter contains bounded opaque wallpaper samples');
 const chromeSeam=await evaluate('(()=>{const row=window.fixture.captionSurface,caption=Uint8Array.from(atob(row.pixels),c=>c.charCodeAt(0)),edges=Uint8Array.from(atob(row.edges),c=>c.charCodeAt(0));return [...caption.slice(0,3)].map((n,i)=>Math.abs(n-edges[i]));})()');
 assert.ok(chromeSeam.every(delta=>delta<=3),'caption and left perimeter share the same frosted tint and cover plane: '+chromeSeam);
 for(const [scheme,theme,width,dpr] of [['original','light',1280,1],['original','dark',1280,1],['white','light',1536,1.25],['black','dark',1536,1.25],['blue','light',640,1.5]]){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:dpr,mobile:false},sessionId);
  await evaluate(`window.fixtureUi.getState().setAppearance({scheme:${JSON.stringify(scheme)}});window.fixtureUi.getState().setTheme(${JSON.stringify(theme)});window.dispatchEvent(new Event('resize'))`);
  await until('document.documentElement.dataset.captionWallpaper==="active" && !!window.fixture.captionSurface');await delay(260);
  const origin=await evaluate('(()=>{const root=document.documentElement,style=getComputedStyle(document.querySelector(".harbor-shell"),"::before"),image=window.fixture.captionSurface;return{height:parseFloat(root.style.getPropertyValue("--native-caption-height")),top:parseFloat(style.top),draft:document.querySelector("textarea[aria-label=输入消息]").value,width:image.width,heightSamples:image.height,overflow:document.documentElement.scrollWidth>innerWidth}})()');
  assert.ok(Math.abs(origin.height-40)<.01&&Math.abs(origin.top+64)<.01,'native/client cover origins align at every emulated DPR');
  assert.equal(origin.draft,'Wallpaper keeps this draft');assert.equal(origin.overflow,false);assert.ok(origin.width<=1024&&origin.heightSamples<=96);
  await capture(`caption-wallpaper-${scheme}-${theme}-${width}`);
 }
 // A late acknowledgement must not resurrect a removed wallpaper.
 await evaluate('window.fixture.holdCaption=true;window.fixtureUi.getState().setAppearance({blur:7})');
 await until('window.fixture.heldCaption.length>0');
 await evaluate('window.fixtureUi.getState().setAppearance({image:null})');
 await until('!document.documentElement.dataset.captionWallpaper && window.fixture.captionSurface===null');
 await evaluate('window.fixture.holdCaption=false;for(const r of window.fixture.heldCaption.splice(0))window.__cetameshReceive({id:r.id,ok:true,result:{applied:true}})');await delay(100);
 assert.equal(await evaluate('document.documentElement.dataset.captionWallpaper'),undefined,'removed background stays removed after a late native reply');
 assert.equal(await evaluate('document.querySelector("textarea[aria-label=输入消息]").value'),'Wallpaper keeps this draft');
 await evaluate('window.fixture.captionEnabled=false;window.fixtureUi.getState().setAppearance(window.wallpaperAppearance);window.fixtureUi.getState().setTheme(window.wallpaperTheme);window.renderAppearance()');
 await until('!!document.getElementById("open-secondary")');
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
 assert.equal(await evaluate('document.documentElement.dataset.captionWallpaper'),undefined,'older/disabled native hosts keep the prior functional appearance');
 console.log('PASS acknowledged native wallpaper activation, bounded opaque pixels, shared DPI origins, old-host fallback, late-reply removal and preserved draft');
 await evaluate('document.getElementById("open-secondary").focus();document.getElementById("open-secondary").click()');await until('document.querySelector(".cm-sheet") && window.lastCaptionAppearance()?.modal===true');await delay(230);
 const detail=await evaluate('(()=>{const node=document.querySelector(".cm-sheet"),r=node.getBoundingClientRect();return{center:Math.abs(r.x+r.width/2-innerWidth/2)<2&&Math.abs(r.y+r.height/2-innerHeight/2)<2,round:parseFloat(getComputedStyle(node).borderTopRightRadius)>=16,scroll:node.scrollHeight>node.clientHeight,inside:node.contains(document.activeElement)}})()');
 assert.deepEqual(detail,{center:true,round:true,scroll:true,inside:true});
 await capture('secondary-centered');
 await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until('!document.querySelector(".cm-sheet") && window.lastCaptionAppearance()?.modal===false');
 assert.equal(await evaluate('document.activeElement.id'),'open-secondary','Escape returns focus to launcher');
 for(const width of [640,360]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:false},sessionId);await delay(50);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'appearance controls fit narrow viewport');await evaluate('document.getElementById("open-secondary").focus();document.getElementById("open-secondary").click()');await until('!!document.querySelector(".cm-sheet")');await delay(220);assert.equal(await evaluate('(()=>{const r=document.querySelector(".cm-sheet").getBoundingClientRect();return r.left>=16&&r.right<=innerWidth-16&&r.top>=16&&r.bottom<=innerHeight-16})()'),true,'secondary panel remains inset on narrow windows');await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until('!document.querySelector(".cm-sheet")');}
 console.log('PASS whole-window palette IPC, white/black schemes, local background, centered scrolling panels, Escape/focus and narrow viewports');
 // Compare actual viewport-corner pixels to the palette sent to the native
 // frame. A rounded full-window mask exposes the undimmed body in these pixels.
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
 const cornerFailures=[];
 for(const [scheme,theme] of [['original','light'],['original','dark'],['white','light'],['black','dark'],['blue','dark']]){
  await evaluate(`window.fixtureUi.getState().setAppearance({scheme:${JSON.stringify(scheme)},image:null});window.fixtureUi.getState().setTheme(${JSON.stringify(theme)})`);
  await until(`document.documentElement.dataset.colorScheme===${JSON.stringify(scheme)}&&document.documentElement.dataset.theme===${JSON.stringify(theme)}&&window.lastCaptionAppearance()?.modal===false`);
  for(const [launcher,selector] of [['open-secondary','.cm-sheet'],['open-native-dialog','dialog[open]']]){
   await evaluate(`document.getElementById(${JSON.stringify(launcher)}).focus();document.getElementById(${JSON.stringify(launcher)}).click()`);
   await until(`!!document.querySelector(${JSON.stringify(selector)})&&window.lastCaptionAppearance()?.modal===true`);await delay(230);
   assert.equal(await evaluate(`parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderTopLeftRadius)>=16`),true,'the panel retains its rounded shape');
   const expected=await evaluate('window.lastCaptionAppearance().palette[0]');
   const {data}=await rpc('Page.captureScreenshot',{format:'png'},sessionId);
   const pixels=await evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/png;base64,')}+${JSON.stringify(data)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [[1,1],[image.width-2,1],[1,image.height-2],[image.width-2,image.height-2]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3));})()`);
   const rgb=[1,3,5].map(offset=>parseInt(expected.slice(offset,offset+2),16));
   if(pixels.some(pixel=>pixel.some((channel,index)=>Math.abs(channel-rgb[index])>1)))cornerFailures.push({scheme,theme,selector,expected,pixels});
   await capture(`modal-corners-${scheme}-${theme}-${launcher}`);
   await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
   await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
   await until(`!document.querySelector(${JSON.stringify(selector)})&&window.lastCaptionAppearance()?.modal===false`);
   assert.equal(await evaluate('document.activeElement.id'),launcher,'Escape restores the original launcher');
  }
 }
 assert.deepEqual(cornerFailures,[],'all four client corners must match the shaded native frame');
 console.log('PASS Sheet and Dialog corner pixels match the native palette in light, dark, white, black and custom schemes');
 // Replay the recorded Chat/Work/Memory navigation with production motion CSS.
 // The content may expand, but the permanent icon rail must never move or gain
 // a divider while that transition is running.
 await evaluate('window.renderRail()');await until('!!document.querySelector(".navigation-rail")');
 const railFailures=[];
 for(const [width,dpr] of [[1550,1],[1280,1.25],[900,1.5]])for(const theme of ['light','dark']){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:dpr,mobile:false},sessionId);
  await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.removeAttribute('style')`);
  const baseline=(await evaluate('window.sampleRail()')).at(-1);
  for(const [page,label] of [['work','Work'],['memory','记忆'],['agents','Agents'],['devices','设备'],['plugins','Plugins'],['settings','Settings'],['about','关于'],['chat','Chat']]){
   await evaluate(`document.querySelector('.navigation-rail [aria-label=${JSON.stringify(label)}]').click()`);
   await until(`document.querySelector('.harbor-shell').dataset.page===${JSON.stringify(page)}`);
   const rows=await evaluate('window.sampleRail()');
   const drift=Math.max(...rows.map(row=>Math.abs(row.center-baseline.center))),widthDrift=Math.max(...rows.map(row=>Math.abs(row.width-baseline.width)));
   if(drift>.5||widthDrift>.5||rows.some(row=>row.railBorder!==0||row.sidebarBorder!==0))railFailures.push({width,dpr,theme,page,drift,widthDrift,borders:rows.at(-1)});
  }
  await capture(`rail-stable-${width}-${theme}`);
 }
 assert.deepEqual(railFailures,[],'permanent rail geometry stays fixed and borderless through every page transition');
 console.log('PASS fixed borderless rail through 48 page transitions in light/dark and desktop/compact viewports at 1/1.25/1.5 DPR');
 assert.deepEqual(await evaluate('window.fixture.errors'),[]);failed=false;
}finally{
 if(socket?.readyState===WebSocket.OPEN){try{await closeBrowser();}catch{console.warn('Owned browser CDP close did not acknowledge; checking process exit.');}socket.terminate();}
 // Browser.close is asynchronous. Await this exact owned child before invoking
 // forced tree cleanup; a fixed 200ms delay races a normal browser shutdown.
 if(browserClosed)await Promise.race([browserClosed,delay(3000)]);
 if(browser?.pid&&browser.exitCode===null&&browser.signalCode===null)await terminateSuiteProcessTree(browser);
 if(server)await new Promise(resolve=>server.close(resolve));finalizeSuiteSandbox({sandbox,failed});
}
