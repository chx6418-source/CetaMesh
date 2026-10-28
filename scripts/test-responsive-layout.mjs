// Real Chromium layout measurements using production CSS and SettingsLayout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { Script } from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ configFile:false, root:uiRoot, optimizeDeps:{noDiscovery:true,include:[]}, server:{middlewareMode:true}, appType:'custom', logLevel:'error' });
const sandbox = createSuiteSandbox({suiteId:'responsive-layout'});
let failed = true;
try {
  const { SettingsLayout } = await vite.ssrLoadModule('/src/app/SettingsLayout.tsx');
  const fields = '<section class="settings-section"><div class="settings-section-main"><h2>常规行为</h2><div class="settings-fields"><div class="setting-row"><div class="setting-copy"><strong>启动时最小化</strong><small>启动时最小化到托盘</small></div><button class="setting-switch" aria-label="启动时最小化"><span></span></button></div></div><div class="settings-save"><small>更改后点击保存生效</small><button class="cm-button">保存设置</button></div></div></section>';
  const settings = renderToStaticMarkup(React.createElement(SettingsLayout, {items:[{id:'general',label:'常规'},{id:'models',label:'模型'},{id:'extensions',label:'插件与 MCP'}],selected:'general',onChange(){}}, React.createElement('div',{dangerouslySetInnerHTML:{__html:fields}})));
  const css = ['theme/tokens.css','theme/global.css','app/harbor.css','app/status-presentation.css','app/workspace-sidebar.css','app/settings-layout.css','app/reference-viewer.css'].map(file=>{
    if(process.env.WHALEBRIDGE_LAYOUT_BASELINE==='1') {
      const original=spawnSync('git',['show','HEAD:desktop-ui/src/'+file],{encoding:'utf8'});
      assert.equal(original.status,0,original.stderr);return original.stdout;
    }
    return fs.readFileSync(path.join(uiRoot,'src',file),'utf8');
  }).join('\n');
  const agent = '<div class="agent-grid"><article class="cm-card agent-card"><h3>DSH</h3><p>连接状态与配置</p><div style="height:500px">展开的配置表单</div><button class="cm-button">检查连接</button></article><article class="cm-card agent-card" id="short-agent"><h3>Codex</h3><p>已就绪</p><small>'+('long-provider-version-'.repeat(9))+'</small><button class="cm-button">检查连接</button></article></div>';
  const about = '<header class="page-heading"><div><h1>关于 CetaMesh</h1></div></header><div class="about-facts"><div class="cm-surface"><strong>1.0.0-rc.2</strong><span>'+('very-long-build-id-'.repeat(15))+'</span></div><div class="cm-surface"><strong>开发者</strong></div><div class="cm-surface"><strong>软件更新</strong></div></div>';
  const plugins = '<header class="page-heading"><div><h1>Plugins</h1></div><button class="cm-button">添加插件</button></header><div class="row plugins-controls"><label class="cm-search"><input class="cm-input" placeholder="搜索插件、集成或开发者"></label><div class="cm-tabs"><button>插件中心</button><button>集成 3</button><button>MCP 5</button></div></div>';
  const cases=[];
  for (const width of [480,640,900,1100,1600]) for(const page of ['agents','settings','about','plugins']) cases.push({width,page,dock:false});
  cases.push({width:1600,page:'agents',dock:true},{width:1600,page:'plugins',dock:true},{width:1600,page:'settings',dock:true});
  const fixture = path.join(sandbox.root,'layout.html');
  const { buildSync } = require('esbuild');
  const sidebarBundle=buildSync({stdin:{resolveDir:uiRoot,loader:'tsx',contents:`
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkspaceSidebar} from './src/app/WorkspaceSidebar';
    import {useResponsiveSidebar} from './src/app/useResponsiveSidebar';
    function Fixture(){const [page,setPage]=useState('chat');const {collapsed,toggle}=useResponsiveSidebar(page);
      return <div className={'harbor-shell '+(collapsed?'sidebar-collapsed':'')} data-page={page}>
        <WorkspaceSidebar page={page} workspaces={[{id:'fixture',name:'项目',status:'ready'}]} sessions={[]} activeWorkspaceId="fixture" activeSessionId="" taskCount={0} hostStatus="ready" collapsed={collapsed} onToggle={toggle} onNavigate={setPage} onOpenWorkspace={()=>{}} onOpenSession={()=>{}} onNewSession={()=>{}} onAllSessions={()=>{}} renderSessionActions={()=>null}/>
        <main className="harbor-main" id="content">Page content</main></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `},bundle:true,write:false,minify:true,format:'iife',platform:'browser',jsx:'automatic'}).outputFiles[0].text;
  async function measureLayouts(data) {
    const results=[];
    let closedReferenceRestores=false;
    for(const entry of data.cases) {
      const iframe=document.createElement('iframe');
      iframe.style.width=entry.width+'px';iframe.style.height='900px';document.body.append(iframe);
      const collapsed=entry.page==='settings'||entry.width<=1100;
      const content=entry.page==='settings'?data.settings:entry.page==='agents'?data.agent:entry.page==='about'?data.about:data.plugins;
      const markup='<!doctype html><meta charset="utf-8"><style>'+data.css+'</style>'
        +'<div class="harbor-shell '+(collapsed?'sidebar-collapsed':'')+'"><aside class="harbor-sidebar"></aside><div class="harbor-main">'
        +'<div class="reference-layout '+(entry.dock?'has-viewer':entry.width-(collapsed?56:316)<640?'narrow show-viewer':'')+'" style="--viewer-width:650px"><div class="reference-chat">'
        +'<main class="page-frame page-'+entry.page+'"><div class="content-page '+entry.page+'-page">'+content+'</div></main></div>'
        +(entry.dock?'<div></div><aside></aside>':'')+'</div></div></div>';
      const doc=iframe.contentDocument;doc.open();doc.write(markup);doc.close();
      const frame=doc.querySelector('.page-frame');const page=doc.querySelector('.content-page');const card=doc.querySelector('#short-agent');
      const controls=[...doc.querySelectorAll('button,input')];
      results.push({...entry,visible:frame.getClientRects().length>0&&frame.clientWidth>100,frameWidth:frame.clientWidth,overflow:frame.scrollWidth-frame.clientWidth,
        pageOffset:page.getBoundingClientRect().left-frame.getBoundingClientRect().left,
        shortHeight:card?.getBoundingClientRect().height,cardWidth:card?.getBoundingClientRect().width,
        controlsInside:controls.every(x=>x.getBoundingClientRect().right<=frame.getBoundingClientRect().right+1)});
      if(entry.width===480&&entry.page==='about') {
        const layout=doc.querySelector('.reference-layout');layout.classList.add('has-viewer');
        const hidden=frame.getClientRects().length===0;
        layout.classList.remove('has-viewer');closedReferenceRestores=hidden&&frame.clientWidth>100;
      }
      iframe.remove();
    }
    const iframe=document.createElement('iframe');iframe.style.width='800px';iframe.style.height='800px';document.body.append(iframe);
    const doc=iframe.contentDocument;doc.open();
    doc.write('<!doctype html><style>'+data.css+'</style><div id="root"></div>');doc.close();
    const queries=[];const matchMedia=iframe.contentWindow.matchMedia.bind(iframe.contentWindow);
    iframe.contentWindow.matchMedia=query=>{const media=matchMedia(query);queries.push(media);return media;};
    const wait=()=>new Promise(resolve=>setTimeout(resolve,150));
    // Assign executable source through textContent, without HTML parsing or closing-tag escapes.
    const script=doc.createElement('script');script.textContent=data.sidebarBundle;doc.body.append(script);
    await wait();
    const panel=()=>doc.getElementById('workspace-panel');
    const contentLeft=()=>doc.getElementById('content')?.getBoundingClientRect().left;
    const checks={initial:!panel()&&contentLeft()===56};
    doc.querySelector('[aria-label="展开工作区列表"]')?.click();await wait();checks.open=!!panel();
    doc.querySelector('[aria-label="Plugins"]')?.click();await wait();checks.navigate=doc.querySelector('[data-page="plugins"]')!==null&&!panel()&&contentLeft()===56;
    iframe.style.width='1280px';await wait();doc.querySelector('[aria-label="展开工作区列表"]')?.click();await wait();checks.wide=!!panel()&&contentLeft()===316;
    iframe.style.width='900px';
    // Headless virtual time does not schedule compositor-driven media change events.
    // Deliver that event explicitly; matches still comes from the actual resized viewport.
    for(const media of queries)media.dispatchEvent(new iframe.contentWindow.Event('change'));
    await wait();checks.resize=!panel()&&contentLeft()===56;
    iframe.remove();
    document.getElementById('result').textContent=encodeURIComponent(JSON.stringify({rows:results,sidebar:checks,closedReferenceRestores}));
  }
  const code='('+measureLayouts.toString()+')('+JSON.stringify({css,settings,agent,about,plugins,cases,sidebarBundle}).replaceAll('<','\\u003c')+').catch(error=>document.getElementById("result").textContent="ERROR:"+error.message);';
  new Script(code);
  fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>'+code+'</script>');
  const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');
  // Recent Edge launchers can exit successfully without emitting --dump-dom.
  // Observe the real page via this run's private DevTools endpoint instead.
  const profile=path.join(sandbox.root,'profile');
  const child=spawn(edge,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
    '--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  let launchError,socket,encoded='';
  child.on('error',error=>{launchError=error;});
  try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let attempt=0;!fs.existsSync(portFile)&&attempt<100&&!launchError;attempt++)await delay(100);
    assert.equal(launchError,undefined,launchError?.message);
    assert.ok(fs.existsSync(portFile),'owned browser exposes its temporary debugging endpoint');
    const [port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);
    assert.match(port,/^\d+$/);assert.ok(Number(port)>0&&Number(port)<65536);
    assert.match(browserPath,/^\/devtools\/browser\/[a-z0-9-]+$/i);
    socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.terminate();reject(Error('owned browser connection timed out'));},3000);
      socket.once('open',()=>{clearTimeout(timer);resolve();});
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    let sequence=0;const pending=new Map();
    socket.on('message',data=>{const response=JSON.parse(String(data));pending.get(response.id)?.(response);});
    const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser RPC timed out: '+method));},5000);
      pending.set(id,response=>{clearTimeout(timer);pending.delete(id);response.error?reject(Error(response.error.message)):resolve(response.result);});
      socket.send(JSON.stringify({id,method,params,sessionId}));
    });
    const {targetId}=await rpc('Target.createTarget',{url:pathToFileURL(fixture).href});
    const {sessionId}=await rpc('Target.attachToTarget',{targetId,flatten:true});
    for(let attempt=0;!encoded&&attempt<100;attempt++){
      const value=await rpc('Runtime.evaluate',{expression:'document.getElementById("result")?.textContent || ""',returnByValue:true},sessionId);
      encoded=value.result?.value||'';if(!encoded)await delay(100);
    }
    assert.ok(encoded,'browser produced layout measurements');
    assert.ok(!encoded.startsWith('ERROR:'),encoded);
  } finally {
    try {
      if(socket?.readyState!==WebSocket.OPEN){
        if(socket&&socket.readyState!==WebSocket.CLOSED)socket.terminate();
        const portFile=path.join(profile,'DevToolsActivePort');
        for(let attempt=0;!fs.existsSync(portFile)&&attempt<60;attempt++)await delay(50);
        if(fs.existsSync(portFile)){
          const [port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);
          assert.match(port,/^\d+$/);assert.ok(Number(port)>0&&Number(port)<65536);
          assert.match(browserPath,/^\/devtools\/browser\/[a-z0-9-]+$/i);
          socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);
          await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{socket.terminate();reject(Error('owned browser cleanup connection timed out'));},3000);
            socket.once('open',()=>{clearTimeout(timer);resolve();});
            socket.once('error',error=>{clearTimeout(timer);reject(error);});
          });
        }
      }
      if(socket?.readyState===WebSocket.OPEN){
        socket.send(JSON.stringify({id:999999,method:'Browser.close'}));
        await Promise.race([new Promise(resolve=>socket.once('close',resolve)),delay(2000)]);
      }
    } finally {
      if(socket&&socket.readyState!==WebSocket.CLOSED)socket.terminate();
      for(let attempt=0;child.pid&&child.exitCode===null&&child.signalCode===null&&attempt<20;attempt++)await delay(50);
      if(child.pid&&child.exitCode===null&&child.signalCode===null)await terminateSuiteProcessTree(child);
      for(let attempt=0;child.pid&&child.exitCode===null&&child.signalCode===null&&attempt<30;attempt++)await delay(100);
      assert.ok(!child.pid||child.exitCode!==null||child.signalCode!==null,'owned browser child exited');
    }
  }
  const {rows,sidebar,closedReferenceRestores}=JSON.parse(decodeURIComponent(encoded));
  const failures=[];
  for(const row of rows){
    if(!row.visible||row.overflow>1||!row.controlsInside) failures.push({...row,issue:'page or controls overflow'});
    if(row.page==='settings'&&row.pageOffset>1)failures.push({...row,issue:'settings leaves a centered gutter'});
    if(row.page==='agents'&&(row.shortHeight>380||row.cardWidth<Math.min(260,row.frameWidth-90)))failures.push({...row,issue:'agent stretches or columns ignore available pane width'});
  }
  console.log(JSON.stringify(failures.length?failures:rows));
  assert.deepEqual(failures,[],'responsive pages and controls fit, settings align left, short Agent cards retain content height');
  assert.deepEqual(sidebar,{initial:true,open:true,navigate:true,wide:true,resize:true},'mounted real sidebar: compact start, open, navigate, wide reopen and responsive collapse');
  assert.equal(closedReferenceRestores,true,'removing the last narrow reference restores main content');
  failed=false;console.log('PASS 23 real Chromium viewport/pane layouts, overflow and control reachability');
} finally {
  await vite.close();
  for(let attempt=0;;attempt++){
    try {finalizeSuiteSandbox({sandbox,failed});break;}
    catch(error){if(!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code)||attempt>=20)throw error;await delay(250);}
  }
}
