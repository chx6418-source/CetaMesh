// Actual production React/CSS in owned Chromium. DTOs are fixed synthetic display
// fixtures: this suite proves layout/interaction, never Core, Provider or native E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const uiRoot = path.join(repository, 'desktop-ui');
const require = createRequire(path.join(uiRoot, 'package.json'));
const { build } = require('esbuild');
// A private archive may have an unrelated node_modules in an ancestor. Resolve
// both historical and current sources through the same maintained UI packages.
const dependencyAliases = Object.fromEntries(Object.keys(require(path.join(uiRoot, 'package.json')).dependencies).map(name => [name, path.join(uiRoot, 'node_modules', name)]));
const evidenceDir = process.env.CETAMESH_UI_EVIDENCE_DIR ? path.resolve(process.env.CETAMESH_UI_EVIDENCE_DIR) : null;
const baselineDir = process.env.CETAMESH_UI_BASELINE_DIR ? path.resolve(process.env.CETAMESH_UI_BASELINE_DIR) : null;
const omitRefreshFix = process.env.CETAMESH_UI_TEST_OMIT_GIT_REFRESH_FIX === '1';
const refreshRegressionOnly = process.env.CETAMESH_UI_REFRESH_REGRESSION_ONLY === '1';
if (evidenceDir) {
  const relative = path.relative(repository, evidenceDir);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'UI evidence belongs outside the repository');
  fs.mkdirSync(evidenceDir, { recursive: true });
}
const sandbox = createSuiteSandbox({ suiteId: 'ui-productization-layout' });
const scenarios = [{ width: 1024, height: 768, zoom: 1 }, { width: 1440, height: 900, zoom: 1 }, { width: 1920, height: 1080, zoom: 1 }, { width: 1440, height: 900, zoom: 1.25 }, { width: 1280, height: 800, zoom: 1, dpr: 1.25, sidebarExpanded: true, workspaceName: '原生验收 · 1501 个真实变更' }];
const rows = [], screenshots = [], baselineFailures = [], refreshButtons = [];
let child, socket, server, rpc, failed = true;

async function bundle(root) {
  // Historical private Harbor functions are exported only in this test bundle;
  // neither the archived source nor maintained source is changed by the harness.
  const result = await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';
      import './src/theme/tokens.css';import './src/theme/global.css';
      import {WorkPage,PluginsPage,ChatComposer} from './src/app/HarborApp';
      import {WindowChrome} from './src/app/WindowChrome';import {GitWorkspace} from './src/app/GitWorkspace';import {ForgeTools} from './src/app/ForgeTools';import {WorkspaceSidebar} from './src/app/WorkspaceSidebar';
      const workspace={id:'layout-project',name:'CetaMesh · synthetic-layout-project-with-a-long-project-name',status:'ready',lastActivity:1793404800000};
      const projectTasks=Array.from({length:105},(_,index)=>({id:'layout-task-'+index,title:'Synthetic project task '+index,goal:'Review project output '+index,status:'queued',workspaceId:workspace.id,rev:1,agent:null,currentAgent:null,agentHistory:[],artifacts:[],children:[],attempts:[],progress:{percent:null,note:''},currentPhase:'',createdAt:1793404800000,updatedAt:1793404800000}));
      const sha='8'.repeat(40),longBranch='codex/layout-'+('long-branch-name-'.repeat(7));
      const entries=Array.from({length:1500},(_,index)=>({x:index%3===0?'M':' ',y:index%3===0?' ':'M',path:'src/'+('long-directory-name/'.repeat(index%5===0?7:1))+'module-'+String(index).padStart(4,'0')+'.ts',conflict:false,commitEligible:true,sha256:'7'.repeat(64)}));
      const overview={workspaceId:workspace.id,git:{isRepo:true,branch:longBranch,headSha:sha,dirty:true,entries},conflicts:[],history:[{sha,parents:['6'.repeat(40)],committedAt:1793404800000,subject:'Synthetic display fixture: preserve bounded review and explicit authorization'}],branches:[{name:longBranch,headSha:sha,current:true,upstream:'origin/'+longBranch,taskId:'task-unavailable',baselineHead:null},{name:'main',headSha:'6'.repeat(40),current:false,upstream:'origin/main',taskId:null,baselineHead:null}],worktrees:[{workspaceId:workspace.id,name:workspace.name,branch:longBranch,headSha:sha,current:true,managed:false,locked:false,prunable:false,taskId:'task-unavailable',parentWorkspaceId:null,baselineHead:null},{workspaceId:null,name:'Unbound external worktree · '+('long-directory-'.repeat(5)),branch:'feature/unbound-external-review',headSha:'6'.repeat(40),current:false,managed:false,locked:true,prunable:true,taskId:null,parentWorkspaceId:null,baselineHead:null}],tasks:[],worktreeRelation:null,truncated:false};
      const actions=['repository.get','branches.list','issues.list','pulls.list','builds.list','builds.jobs','releases.list','branch.create','issue.create','pull.create','workflow.dispatch','release.draft'];
      const scope={owner:'synthetic-owner',repo:'display-fixture-'+('long-name-'.repeat(4)),credentialRef:'',publicRead:true,actions:actions.slice(0,7),branchPrefixes:['codex/'],workflows:[]};
      const description={revision:1,providers:['github','gitcode'].map(provider=>({provider,endpoint:provider==='github'?'https://api.github.com':'https://api.gitcode.com',repositories:provider==='github'?[scope]:[],actions,unsupported:provider==='gitcode'?['release.draft']:[],credentialConfigured:provider==='github'?null:false,credentialSavingAvailable:true,credentialUpdatedAt:null}))};
      const plugins=['Code review','Project notes','Workspace tools','Local knowledge'].map((name,index)=>({id:'synthetic-plugin-'+index,name,summary:'Fixed synthetic plugin card for layout review. No extension is installed or executed.',description:'Display fixture',developer:'Synthetic fixture',version:'1.0.0',status:index===0?'enabled':'available',category:index%2?'效率':'开发工具',kind:'extension',featured:index===0,installed:index===0,enabled:index===0,available:true,configured:true,eligible:true,reason:null,lastError:null,icon:'layers',permissions:[],changelog:[],compatibility:{minimum:null,maximum:null},screenshotCount:0,warning:null}));
      const integrations=[{id:'synthetic-offline-connection',name:'Synthetic offline connection',kind:'connector',status:'error',enabled:true,available:false,eligible:false,configured:true,reason:'connection-pending',lastError:'Synthetic network unavailable'},{id:'synthetic-tool-pack',name:'Synthetic development tools',kind:'tool-pack',status:'disabled',enabled:false,available:true,eligible:false,configured:true,reason:null,lastError:null}];
      const servers=[{id:'synthetic-mcp',name:'Synthetic MCP connection',status:'stopped',enabled:false,running:false,available:false,toolCallable:false,eligible:false,configured:true,source:'external',toolCount:0,discoveredToolCount:0,transport:'stdio',reason:'not-checked',lastError:null}];
      window.fixtureCalls=[];window.fixtureErrors=[];
      window.addEventListener('error',event=>window.fixtureErrors.push(event.message));window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason)));
      async function call(method,params={}){window.fixtureCalls.push({method,params});
        if(method==='app.windowAction')return {maximized:false};
        if(method==='ui.workspace.git.overview')return overview;
        if(method==='ui.workspace.git.diff')return {output:'diff --git a/'+params.path+' b/'+params.path+'\\n--- a/'+params.path+'\\n+++ b/'+params.path+'\\n@@ -1 +1 @@\\n-old value\\n+new value',cached:false,truncated:false,hasChanges:true};
        if(method==='ui.developer.forge.describe')return description;
        if(method==='ui.developer.forge.invoke')throw Object.assign(new Error('Synthetic network unavailable; connection was not verified.'),{code:'FORGE_NETWORK_ERROR'});
        if(method==='ui.plugins.catalog')return {available:true,configured:true,offline:false,reason:null,plugins};
        if(method==='ui.plugins.status')return {catalogAvailable:true,configured:true,offline:false,developerMode:true,plugins,installed:plugins.filter(row=>row.installed),integrations,mcp:servers};
        if(method==='ui.plugins.integration.list')return {integrations};
        if(method==='ui.mcp.list')return {servers};
        if(method==='ui.approvals.list')return {approvals:[],operations:[],grants:[]};
        if(method==='ui.agent.list')return {agents:[]};
        if(method==='ui.task.overview'){const tasks=projectTasks.filter(task=>(!params.workspaceId||task.workspaceId===params.workspaceId)&&(!params.status||task.status===params.status)&&(!params.query||task.title.includes(params.query))),offset=params.offset||0,limit=params.limit||100;return {tasks:tasks.slice(offset,offset+limit),total:tasks.length,offset,limit,nextOffset:offset+limit<tasks.length?offset+limit:null,counts:{queued:105},needsAttention:[]};}
        if(method.startsWith('ui.workshop.'))return {proposals:[]};
        if(method==='ui.workspace.list')return {workspaces:[workspace],activeId:workspace.id};
        if(method==='ui.workspace.open')return {activeId:workspace.id,workspace};
        if(method==='ui.chat.attachment.limits')return {imageMiB:20,documentMiB:100,archiveMiB:200,messageMiB:250,count:20,storageMiB:2048,reserveMiB:256,incompleteHours:24};
        if(method==='ui.chat.attachment.list')return {files:[]};
        if(method==='ui.chat.attachment.capabilities')return {supported:false,status:'unknown'};
        throw Object.assign(new Error('Display fixture blocks this operation: '+method),{code:'FIXTURE_READ_ONLY'});
      }
      window.ipc={postMessage(raw){const request=JSON.parse(raw);call(request.method,request.params).then(result=>window.__cetameshReceive({id:request.id,ok:true,result}),error=>window.__cetameshReceive({id:request.id,ok:false,error:{code:error.code||'FIXTURE',message:error.message}}));}};
      function Fixture(){const [page,setPage]=useState('git'),[sidebarExpanded,setSidebarExpanded]=useState(false);window.fixture={show:setPage,setSidebarExpanded,overview,workspace};
        return <div className={'harbor-shell '+(sidebarExpanded?'':'sidebar-collapsed')} data-fixture-page={page}><WindowChrome/><WorkspaceSidebar page={page==='git'?'work':page==='forge'?'plugins':page} workspaces={[workspace]} sessions={[]} activeWorkspaceId={workspace.id} activeSessionId="layout-session" taskCount={0} hostStatus="ready" collapsed={!sidebarExpanded} onToggle={()=>setSidebarExpanded(value=>!value)} onNavigate={setPage} onOpenWorkspace={()=>{}} onOpenSession={()=>{}} onNewSession={()=>setPage('chat')} onAllSessions={()=>{}} renderSessionActions={()=>null}/><main className="harbor-main"><main className={'page-frame page-'+(page==='git'?'work':page)}>
          {page==='git'?<GitWorkspace call={call} workspaces={[workspace]} activeWorkspaceId={workspace.id}/>:page==='forge'?<div className="content-page"><ForgeTools call={call} tasks={[]}/></div>:page==='work'?<WorkPage workspaces={[workspace]} activeWorkspaceId={workspace.id} onRefreshWorkspaces={async()=>{}} reviewTaskId={null} onReviewTaskOpened={()=>{}}/>:page==='plugins'?<PluginsPage/>:<div className="chat-workspace"><section className="conversation-pane"><div className="conversation-toolbar"><h1>Chat</h1></div><div/><div className="message-stream"><div className="harbor-empty"><strong>Synthetic display fixture</strong></div></div><div className="composer-dock"><ChatComposer sessionId="layout-session" busy={false} models={[]} selectedModelKey="" agentProviders={[]} selectedAgent="none" workspaces={[workspace]} workspaceId={workspace.id} activeWorkspaceId={workspace.id} onWorkspaceChange={()=>{}} onModelChange={()=>{}} onAgentChange={()=>{}} onSend={()=>false} onStop={()=>{}}/></div></section></div>}
        </main></main></div>;}
      createRoot(document.getElementById('root')).render(<MemoryRouter><Fixture/></MemoryRouter>);
    ` },
    bundle: true, write: false, outdir: path.join(sandbox.root, 'bundle'), format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [path.join(uiRoot, 'node_modules')], alias: dependencyAliases,
    plugins: [{ name: 'private-page-exports', setup(builder) { builder.onLoad({ filter: /[\\/]HarborApp\.tsx$/ }, async args => { let contents = fs.readFileSync(args.path, 'utf8'); for (const name of ['WorkPage', 'PluginsPage']) if (!new RegExp('export\\s+function\\s+' + name + '\\b').test(contents)) contents += '\nexport {' + name + '};\n'; return { contents, loader: 'tsx', resolveDir: path.dirname(args.path) }; }); } }]
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  let css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  if(root===uiRoot&&omitRefreshFix){const rule=/\.git-toolbar\s*>\s*\.cm-button\s*\{[^}]*\}/g;assert.ok(rule.test(css),'test-only mutation finds the production refresh-button fix');css=css.replace(rule,'');}
  assert.ok(js, 'production fixture bundle exists');
  return '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><title>CetaMesh synthetic UI display fixture</title><style>' + css + '</style><div id="root"></div><script>' + js.replaceAll('</script', '<\\/script') + '</script></html>';
}

try {
  const pages = { after: await bundle(uiRoot) };
  if (baselineDir&&!refreshRegressionOnly) { assert.ok(fs.existsSync(path.join(baselineDir, 'src/app/HarborApp.tsx')), 'saved baseline UI exists'); pages.before = await bundle(baselineDir); }
  server = http.createServer((request, response) => { response.writeHead(pages[request.url?.slice(1)] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(pages[request.url?.slice(1)] || 'Unknown fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(edge)) { console.log('NOT_RUN_ENVIRONMENT: actual Chromium/Edge required for responsive UI rendering'); process.exitCode = 77; failed = false; }
  else {
    const profile = path.join(sandbox.root, 'profile');
    child = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let launchError; child.on('error', error => { launchError = error; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let index = 0; !fs.existsSync(portFile) && !launchError && index < 100; index++) await delay(100);
    assert.equal(launchError, undefined); assert.ok(fs.existsSync(portFile), 'owned Chromium exposes its temporary endpoint');
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    assert.match(port, /^\d+$/); assert.match(browserPath, /^\/devtools\/browser\/[a-z0-9-]+$/i);
    socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0; const pending = new Map(), browserErrors = [];
    socket.on('message', bytes => { const result = JSON.parse(String(bytes)); if(result.method==='Runtime.exceptionThrown')browserErrors.push(result.params?.exceptionDetails?.exception?.description||result.params?.exceptionDetails?.text);const entry = pending.get(result.id); if (!entry) return; pending.delete(result.id); clearTimeout(entry.timer); result.error ? entry.reject(new Error(result.error.message)) : entry.resolve(result.result); });
    rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
    const target = await rpc('Target.createTarget', { url: 'about:blank' }), { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await rpc('Runtime.enable', {}, sessionId); await rpc('Page.enable', {}, sessionId);
    const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    async function until(expression, label) { for (let index = 0; index < 150; index++) { if (await evaluate(expression)) return; await delay(40); } throw new Error('Timed out: ' + label + '\n' + await evaluate('document.body.innerText.slice(0,3000)') + '\n' + browserErrors.join('\n')); }
    async function click(selector) { assert.ok(await evaluate('(()=>{const node=document.querySelector(' + JSON.stringify(selector) + ');if(!node)return false;node.click();return true;})()'), 'reachable ' + selector); await delay(120); }
    async function fill(selector, value) { await evaluate('(()=>{const node=document.querySelector(' + JSON.stringify(selector) + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(node,' + JSON.stringify(value) + ');node.dispatchEvent(new Event("input",{bubbles:true}));})()'); await delay(80); }
    async function capture(version, scenario, name) {
      if (!evidenceDir) return;
      // Spring sheets can expose their text before reaching the final opacity
      // and position. Capture the settled product, not an animation midpoint.
      let previous = '', stable = 0;
      for(let attempt=0;attempt<40;attempt++){
        const state=await evaluate('(()=>{const nodes=[...document.querySelectorAll(".cm-sheet,.cm-sheet-backdrop,[data-motion-popup]")].filter(node=>!node.inert&&node.checkVisibility());return {settled:nodes.every(node=>Number(getComputedStyle(node).opacity)>.999),signature:nodes.map(node=>{const style=getComputedStyle(node);return style.opacity+":"+style.transform}).join("|")};})()');
        stable=state.settled&&state.signature===previous?stable+1:0;previous=state.signature;if(stable>=2)break;await delay(40);
        if(attempt===39)throw new Error('Rendered overlay did not settle for '+name);
      }
      const filename = version + '-' + scenario.width + 'x' + scenario.height + '-content-' + Math.round(scenario.zoom * 100) + (scenario.dpr?'-dpr-'+Math.round(scenario.dpr*100):'') + (scenario.sidebarExpanded?'-sidebar-expanded':'') + '-' + name + '.png';
      const result = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      fs.writeFileSync(path.join(evidenceDir, filename), Buffer.from(result.data, 'base64')); screenshots.push(filename);
    }
    async function measureSection(version, scenario, name) {
      const geometry = await evaluate('(()=>{const frame=document.querySelector(".page-frame"),main=document.querySelector(".harbor-main");return {documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,mainOverflow:main.scrollWidth-main.clientWidth,frameOverflow:frame.scrollWidth-frame.clientWidth,visible:frame.getBoundingClientRect().width>200,errors:window.fixtureErrors};})()');
      rows.push({version,...scenario,page:name,...geometry});await capture(version,scenario,name);
      assert.equal(geometry.visible,true,name+' is visible');assert.ok(geometry.documentOverflow<=1&&geometry.mainOverflow<=1&&geometry.frameOverflow<=1,name+' has no root horizontal overflow: '+JSON.stringify(geometry));assert.deepEqual(geometry.errors,[],'production React has no rendering errors');
    }
    async function checkGitRefresh(scenario, location) {
      const geometry=await evaluate('(()=>{const button=document.querySelector(".git-toolbar > button"),rect=button.getBoundingClientRect(),style=getComputedStyle(button),range=document.createRange();range.selectNodeContents(button);const lines=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0),canvas=document.createElement("canvas"),context=canvas.getContext("2d");context.font=style.font;const textWidth=context.measureText(button.textContent.trim()).width,contentWidth=button.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),at=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return {label:button.textContent.trim(),lineCount:new Set(lines.map(rect=>Math.round(rect.top))).size,textWidth,contentWidth,buttonWidth:rect.width,buttonHeight:rect.height,visible:button.checkVisibility()&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1&&(at===button||button.contains(at)),sidebarExpanded:!!document.querySelector("#workspace-panel"),viewportWidth:innerWidth,viewportHeight:innerHeight,dpr:devicePixelRatio};})()');
      refreshButtons.push({...scenario,location,...geometry});
      assert.equal(geometry.lineCount,1,'Git refresh label remains on one rendered line: '+JSON.stringify(geometry));
      assert.ok(geometry.contentWidth>=geometry.textWidth-1,'Git refresh button retains enough visible width for its label: '+JSON.stringify(geometry));
      assert.equal(geometry.visible,true,'Git refresh button is visible and hit testable: '+JSON.stringify(geometry));
      if(scenario.sidebarExpanded)assert.equal(geometry.sidebarExpanded,true,'native-observed regression runs with the real workspace sidebar expanded');
    }
    for (const version of baselineDir&&!refreshRegressionOnly ? ['before', 'after'] : ['after']) {
      await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' + version }, sessionId);
      await until('!!window.fixture', 'production React ' + version + ' mounted');
      for (const scenario of scenarios.filter(scenario=>!refreshRegressionOnly||scenario.sidebarExpanded)) {
        await rpc('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: scenario.dpr??1, mobile: false }, sessionId);
        await evaluate('(()=>{const root=document.getElementById("root");root.style.zoom=' + scenario.zoom + ';root.style.width=' + JSON.stringify(100 / scenario.zoom + 'vw') + ';root.style.height=' + JSON.stringify(100 / scenario.zoom + 'vh') + ';})()');
        await evaluate('window.fixture.workspace.name='+JSON.stringify(scenario.workspaceName??'CetaMesh · synthetic-layout-project-with-a-long-project-name')+';window.fixture.setSidebarExpanded('+Boolean(scenario.sidebarExpanded)+')');
        for (const page of refreshRegressionOnly?['work']:['work', 'plugins', 'git', 'forge', 'chat']) {
          await evaluate('window.fixture.show(' + JSON.stringify(page) + ')');
          await until('document.querySelector("[data-fixture-page]")?.getAttribute("data-fixture-page")===' + JSON.stringify(page), page + ' page');
          await delay(220);
          if (page === 'git') await until('document.querySelectorAll(".git-file").length>0', 'Git fixture data');
          if (page === 'forge') await until('document.body.innerText.includes("synthetic-owner")', 'Forge fixture data');
          const geometry = await evaluate('(()=>{const frame=document.querySelector(".page-frame"),main=document.querySelector(".harbor-main");return {documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,mainOverflow:main.scrollWidth-main.clientWidth,frameOverflow:frame.scrollWidth-frame.clientWidth,visible:frame.getBoundingClientRect().width>200,errors:window.fixtureErrors};})()');
          rows.push({ version, ...scenario, page, ...geometry });
          if (version === 'after') { assert.equal(geometry.visible, true, page + ' is visible'); assert.ok(geometry.documentOverflow <= 1 && geometry.mainOverflow <= 1 && geometry.frameOverflow <= 1, page + ' has no root horizontal overflow: ' + JSON.stringify(geometry)); assert.deepEqual(geometry.errors, [], 'production React has no rendering errors'); }
          else if (geometry.documentOverflow > 1 || geometry.mainOverflow > 1 || geometry.frameOverflow > 1) baselineFailures.push({ page, ...scenario, ...geometry });
          if (version === 'after' && page === 'git') {
            await checkGitRefresh(scenario,'standalone-git');
            const count = await evaluate('document.querySelectorAll(".git-file").length'); assert.ok(count > 0 && count <= 50, '1500 files render at most 50 rows');
            assert.equal(await evaluate('document.querySelectorAll("[role=tablist][aria-label=\\"Git 视图\\"] [role=tab]").length'), 4, 'Git has four views');
            const reachable = await evaluate('(()=>{const node=document.querySelector(".git-commit .primary");node.scrollIntoView({block:"center"});const rect=node.getBoundingClientRect();const at=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1&&(at===node||node.contains(at));})()');
            assert.ok(reachable, 'commit action can be scrolled into view and hit tested');
            await evaluate('document.querySelector(".page-frame").scrollTop=0');
          }
          if (version === 'after' && page === 'chat') { assert.equal(await evaluate('document.querySelectorAll("button[aria-label=添加附件]").length'), 1, 'empty production Composer has one attachment entry'); assert.equal(await evaluate('document.querySelector(".composer-dock").innerText.includes("MiB")'), false, 'empty Composer keeps limits behind help'); assert.equal(await evaluate('Array.from(document.querySelectorAll("input[type=file]")).some(node=>node.checkVisibility())'), false, 'native file controls are hidden'); }
          await capture(version, scenario, page);
          if(version==='after'&&page==='work'){
            assert.equal(await evaluate('document.querySelectorAll(".git-workspace").length'),0,'default task view contains no inline Git form');
            await click('[role=tablist][aria-label="工作与工作区"] [role=tab]:nth-child(2)');await until('!!document.querySelector(".workspace-card")','actual Workspace section');await measureSection(version,scenario,'workspace-projects');
            await evaluate('Array.from(document.querySelectorAll(".workspace-card button")).find(node=>node.textContent.trim()==="查看任务").click()');
            await until('document.querySelector("[role=tablist][aria-label=\\"工作与工作区\\"] [role=tab][aria-selected=true]")?.innerText==="任务"&&window.fixtureCalls.some(row=>row.method==="ui.task.overview"&&row.params.workspaceId==="layout-project")','Workspace card opens its project Tasks');
            assert.equal(await evaluate('document.querySelector("button[aria-label=\\"任务项目范围\\"]").textContent.trim()'), await evaluate('window.fixture.workspace.name'), 'project scope displays the real project name');
            const taskControls = await evaluate('(()=>{const search=document.querySelector(".work-controls .cm-search").getBoundingClientRect();return [...document.querySelectorAll(".work-controls [role=tab]")].map(node=>{const rect=node.getBoundingClientRect();return {label:node.textContent,left:rect.left,right:rect.right,overlapsSearch:rect.left<search.right&&rect.right>search.left&&rect.top<search.bottom&&rect.bottom>search.top};});})()');
            assert.ok(taskControls.every(control=>control.left>=0&&control.right<=scenario.width+1&&!control.overlapsSearch), 'project/status/search controls stay readable without overlap: '+JSON.stringify(taskControls));
            await measureSection(version,scenario,'workspace-tasks');
            await evaluate('Array.from(document.querySelectorAll("button")).find(node=>node.textContent.trim()==="下一页任务").click()');
            await until('window.fixtureCalls.some(row=>row.method==="ui.task.overview"&&row.params.offset===50)&&document.querySelector(".task-card h3")?.textContent==="Synthetic project task 50"','project Task second page is fetched');
            await evaluate('Array.from(document.querySelectorAll("button")).find(node=>node.textContent.trim()==="下一页任务").click()');
            await until('window.fixtureCalls.some(row=>row.method==="ui.task.overview"&&row.params.offset===100)&&document.querySelectorAll(".task-card").length===5','project Task final page beyond100 is fetched');
            await measureSection(version,scenario,'workspace-tasks-last-page');
            assert.ok(await evaluate('document.querySelector("nav[aria-label=\\"全部匹配任务分页\\"]").textContent.includes("101–105 / 105")'), 'Task pager retains the real total on the final page');
            await evaluate('document.querySelector("nav[aria-label=\\"全部匹配任务分页\\"]").scrollIntoView({block:"center"})');
            await capture(version,scenario,'workspace-task-pagination');
            await evaluate('document.querySelector(".page-frame").scrollTop=0');
            await click('[role=tablist][aria-label="工作与工作区"] [role=tab]:nth-child(2)');await until('!!document.querySelector(".workspace-card")','Workspace cards remain reachable');
            await evaluate('Array.from(document.querySelectorAll(".workspace-card button")).find(node=>node.textContent.trim()==="Git 工作台").click()');await until('document.querySelector("[role=tablist][aria-label=\\"工作与工作区\\"] [role=tab][aria-selected=true]")?.innerText==="Git 工作台"&&document.querySelectorAll(".git-file").length>0','Workspace card opens Git workbench');await measureSection(version,scenario,'workspace-git');
            await checkGitRefresh(scenario,'production-workpage-git');
          }
          if(version==='after'&&page==='plugins'){
            assert.equal(await evaluate('document.querySelectorAll(".forge-tools").length'),0,'plugin catalog contains no raw Forge form');
            await click('[role=tablist][aria-label="插件视图"] [role=tab]:nth-child(2)');await until('document.querySelectorAll(".forge-connection-card").length===2','Plugin Center connections host both providers');await measureSection(version,scenario,'plugin-connections');
            await click('[role=tablist][aria-label="插件视图"] [role=tab]:nth-child(3)');await until('document.querySelector(".connection-list")?.innerText.includes("Synthetic development tools")','tool-pack occupies development-tools section');assert.equal(await evaluate('document.querySelectorAll(".forge-tools").length'),0,'development tools section contains no duplicate Forge form');await measureSection(version,scenario,'plugin-tools');
            await click('[role=tablist][aria-label="插件视图"] [role=tab]:nth-child(4)');await until('document.querySelector(".connection-list")?.innerText.includes("Synthetic MCP connection")','MCP occupies its existing section');await measureSection(version,scenario,'plugin-mcp');
          }
          if (version === 'after' && page === 'git') {
            await click('[role=tablist][aria-label="Git 视图"] [role=tab]:nth-child(3)'); await fill('input[aria-label="搜索分支"]', 'long-branch'); assert.equal(await evaluate('document.querySelectorAll(".git-detail-link").length'), 1, 'branch search narrows the long branch');
            await click('.git-detail-link'); await until('document.querySelector("aside[aria-label=\\"分支详情\\"]")?.innerText.includes("未知")', 'missing task/Agent detail stays unknown'); await capture(version, scenario, 'branch-detail'); await click('aside[aria-label="分支详情"] button[aria-label=关闭]'); await delay(250);
            await click('[role=tablist][aria-label="Git 视图"] [role=tab]:nth-child(4)'); await fill('input[aria-label="搜索工作树"]', 'unbound'); assert.equal(await evaluate('document.querySelectorAll(".git-detail-link").length'), 1, 'worktree search narrows unbound directory'); await click('.git-detail-link'); await until('document.querySelector("aside[aria-label=\\"工作树详情\\"]")?.innerText.includes("未关联")', 'unbound worktree does not invent ownership'); await capture(version, scenario, 'worktree-detail'); await click('aside[aria-label="工作树详情"] button[aria-label=关闭]'); await delay(250);
          }
          if (version === 'after' && page === 'forge') {
            await evaluate('Array.from(document.querySelectorAll(".forge-tools button")).find(node=>node.textContent.trim()==="读取仓库信息")?.click()'); await until('document.querySelector(".forge-feedback.error")?.innerText.includes("Synthetic network unavailable")', 'synthetic connection error rendered'); await capture(version, scenario, 'forge-offline');
          }
          if(version==='after'&&page==='chat'){
            await click('button[aria-label=添加附件]');await until('!!document.querySelector("[role=menu][aria-label=添加附件]")','single attachment menu opens');
            const menuInside=await evaluate('(()=>{const node=document.querySelector("[role=menu][aria-label=添加附件]"),rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1;})()');assert.ok(menuInside,'attachment menu stays within the available viewport');await capture(version,scenario,'chat-attachment-menu');await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
          }
        }
      }
    }
    assert.equal(await evaluate('window.fixtureCalls.some(row=>/ui\\.(?:workspace\\.git\\.(?:commit|branch\\.create|worktree\\.create)|chat\\.send)/.test(row.method))'), false, 'display acceptance never performs a commit, branch creation or model send');
    console.log('PASS production responsive layout and controls: ' + rows.filter(row => row.version === 'after').length + ' page/scenario measurements, 1500-file pagination, details, offline state and single Composer attachment entry');
    if (evidenceDir) console.log('Private rendered screenshots: ' + screenshots.length + '; metadata: ' + path.join(evidenceDir, 'ui-productization-layout-evidence.json'));
    failed = false;
  }
} finally {
  if (rpc && socket?.readyState === WebSocket.OPEN) { try { await rpc('Browser.close'); } catch {} await delay(600); }
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  if (child?.pid && child.exitCode === null && child.signalCode === null) { await terminateSuiteProcessTree(child); await delay(200); }
  if (server) await new Promise(resolve => server.close(resolve));
  // Persist failed geometry too, so a RED mutation run cannot leave an older
  // passing evidence index next to its newly captured failure screenshot.
  if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, 'ui-productization-layout-evidence.json'), JSON.stringify({ status:process.exitCode===77?'NOT_RUN_ENVIRONMENT':failed?'FAIL':'PASS', evidenceKind: 'Actual Chromium production React/CSS; fixed synthetic DTO fixture; not Core/native E2E', baselineDependencies: 'Historical and current source bundles use the maintained UI dependency set to avoid unrelated ancestor packages', zoomMeaning: 'CSS content zoom on fixture root; viewport unchanged; portaled controls retain viewport coordinates; expanded-sidebar 1280x800 case also emulates DPR 1.25; no system DPI/settings change', testOnlyOmittedRefreshFix:omitRefreshFix, rows, baselineFailures, refreshButtons, screenshots }, null, 2));
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
