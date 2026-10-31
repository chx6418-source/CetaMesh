// Production ForgeTools in Chromium with scoped, synthetic IPC replies only.
// No remote service, account, credentials or remote writes are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {createSuiteSandbox,finalizeSuiteSandbox} from '../src/testing/suite-sandbox.js';
import {terminateSuiteProcessTree} from '../src/testing/suite-process.js';
import {createIntegrationService} from '../src/integrations/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {createTaskService} from '../src/task/service.js';

const uiRoot=fileURLToPath(new URL('../desktop-ui/',import.meta.url)),require=createRequire(path.join(uiRoot,'package.json'));
const sandbox=createSuiteSandbox({suiteId:'forge-connections-ui'});
let failed=true,child,socket,server,closeBrowser,integrationService;
try{
  integrationService=createIntegrationService({stateDir:path.join(sandbox.root,'integrations')});
  const taskService=createTaskService({stateDir:path.join(sandbox.root,'tasks'),resolveWorkspace:id=>({id,root:sandbox.root})});
  taskService.runtime.create({goal:'Parent fixture task',workspaceId:'workspace-parent-fixture'});
  const ui=createDesktopUiService({services:{integrationService,taskService}});
  const projected=await ui.execute({method:'ui.plugins.integration.list',params:{}}),parentOverview=await ui.execute({method:'ui.task.overview',params:{}});
  const parentPack=projected.integrations.find(row=>row.kind==='tool-pack');assert.ok(parentPack,'actual Core projection retains the canonical tool-pack kind');
  // Negative controls change only this in-memory bundle/payload, never product files.
  const omitParentTasks=process.env.CETAMESH_TEST_FORGE_PARENT_OMIT_TASKS==='1';
  const parentIntegrations=projected.integrations.map(row=>process.env.CETAMESH_TEST_FORGE_PARENT_OMIT_KIND==='1'?{...row,kind:undefined}:row);
  const {build}=require('esbuild');
  const bundle=await build({stdin:{resolveDir:uiRoot,loader:'tsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {ForgeTools} from './src/app/ForgeTools';import {PluginsPage} from './src/app/HarborApp';
    const parentIntegrations=${JSON.stringify(parentIntegrations)},parentOverview=${JSON.stringify(parentOverview)};
    const reads=['repository.get','branches.list','issues.list','pulls.list','builds.list','builds.jobs','releases.list'];
    const writes=['branch.create','issue.create','pull.create','workflow.dispatch','release.draft'];
    const repositories=[{owner:'fixture',repo:'project',credentialRef:'plugin-forge-github',actions:[...reads,...writes],branchPrefixes:['codex/'],workflows:[{id:'ci.yml',refs:['codex/probe'],inputs:{candidate:['false']}}]}];
    const doc={revision:1,providers:[{provider:'github',endpoint:'https://api.github.com',repositories,actions:[...reads,...writes],unsupported:[],credentialConfigured:true,credentialSavingAvailable:true,credentialUpdatedAt:null},{provider:'gitcode',endpoint:'https://api.gitcode.com',repositories:[],actions:[...reads,...writes],unsupported:['workflow.dispatch','release.draft'],credentialConfigured:false,credentialSavingAvailable:true,credentialUpdatedAt:null}]};
    window.fixture={calls:[],fault:'',describeFault:'',saveFault:false,parentTaskFault:false,doc};
    const failure=(code,message)=>Object.assign(new Error(message),{code});
    async function call(method,params){
      window.fixture.calls.push({method,params:method.endsWith('credentials.save')?{provider:params.provider,expectedRevision:params.expectedRevision}:structuredClone(params)});
      if(method==='ui.developer.forge.describe'){if(window.fixture.describeFault)throw failure(window.fixture.describeFault,'Forge request failed');return structuredClone(doc);}
      if(method==='ui.developer.forge.credentials.save'){if(window.fixture.saveFault)throw failure('FORGE_CREDENTIAL_SAVE_FAILED','Dedicated credential could not be saved');doc.revision++;doc.providers.find(row=>row.provider===params.provider).credentialConfigured=true;return {configured:true};}
      if(method==='ui.developer.forge.save'){if(window.fixture.saveFault)throw failure('FORGE_CONFIG_CONFLICT','Forge configuration changed; reload before saving');doc.revision++;doc.providers.find(row=>row.provider===params.provider).repositories=params.repositories;return structuredClone(doc);}
      if(method==='ui.developer.forge.invoke'){if(window.fixture.fault)throw failure(window.fixture.fault,window.fixture.fault==='FORGE_HTTP_ERROR'?'Forge returned HTTP 403':'Forge request failed');return params.action.endsWith('.create')||params.action==='workflow.dispatch'||params.action==='release.draft'?{status:'pending',approvalId:'fixture-approval'}:{status:'completed',result:{items:[{name:'fixture-reply',sha:'a'.repeat(40)}]}};}
      if(method==='ui.plugins.catalog')return {available:true,configured:true,offline:false,reason:null,plugins:[]};
      if(method==='ui.plugins.status')return {catalogAvailable:true,configured:true,offline:false,developerMode:false,plugins:[],installed:[],integrations:parentIntegrations,mcp:[]};
      if(method==='ui.plugins.integration.list')return {integrations:parentIntegrations};
      if(method==='ui.mcp.list')return {servers:[]};
      if(method==='ui.approvals.list')return {approvals:[],operations:[],grants:[]};
      if(method==='ui.task.overview'){if(window.fixture.parentTaskFault)throw failure('FIXTURE_TASK_UNAVAILABLE','Synthetic task list unavailable');return parentOverview;}
      if(method==='ui.events.next'){await new Promise(resolve=>setTimeout(resolve,200));return {instanceId:'forge-parent-fixture',events:[],cursor:0};}
      throw new Error('Fixture rejected an out-of-scope method');
    }
    window.ipc={postMessage(raw){const request=JSON.parse(raw);call(request.method,request.params).then(result=>window.__cetameshReceive({id:request.id,ok:true,result}),error=>window.__cetameshReceive({id:request.id,ok:false,error:{code:error.code||'FIXTURE',message:error.message}}));}};
    const root=createRoot(document.getElementById('root'));root.render(<ForgeTools call={call} tasks={[{id:'task-fixture',title:'Fixture task',workspaceId:'workspace-fixture',status:'running'}]}/>);
    window.showPlugins=()=>root.render(<MemoryRouter><PluginsPage/></MemoryRouter>);
    window.button=text=>Array.from((document.querySelector('dialog[open]')||document).querySelectorAll('button')).find(row=>row.textContent.trim()===text||row.getAttribute('aria-label')===text);
    window.setControl=(selector,value)=>{const element=document.querySelector(selector);if(!element)throw Error('Missing '+selector);const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
  `},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'empty'},plugins:omitParentTasks?[{name:'omit-parent-task-prop-negative-control',setup(builder){builder.onLoad({filter:/[\\/]HarborApp\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('tasks={forgeTasks}','tasks={[]}'),loader:'tsx',resolveDir:path.dirname(args.path)}));}}]:[]});
  const css=['src/theme/tokens.css','src/theme/global.css','src/theme/motion.css','src/app/ForgeTools.css'].filter(file=>fs.existsSync(path.join(uiRoot,file))).map(file=>fs.readFileSync(path.join(uiRoot,file),'utf8')).join('\n');
  server=http.createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html;charset=utf-8'});response.end('<!doctype html><meta charset="utf-8"><style>'+css+' body{overflow:auto}#root{height:auto;min-height:100vh}</style><div id="root"></div><script>'+bundle.outputFiles[0].text+'</script>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const edge=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');
  if(!fs.existsSync(edge)){console.log('NOT_RUN_ENVIRONMENT Forge connections UI: Chromium/Edge unavailable');process.exitCode=77;}else{
    const profile=path.join(sandbox.root,'profile');child=spawn(edge,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;!fs.existsSync(portFile)&&i<100;i++)await delay(100);assert.ok(fs.existsSync(portFile));
    const [port,browserPath]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);socket=new WebSocket('ws://127.0.0.1:'+port+browserPath);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    let sequence=0;const pending=new Map();socket.on('message',bytes=>{const reply=JSON.parse(String(bytes)),entry=pending.get(reply.id);if(!entry)return;pending.delete(reply.id);clearTimeout(entry.timer);reply.error?entry.reject(Error(reply.error.message)):entry.resolve(reply.result);});
    const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
    closeBrowser=()=>rpc('Browser.close');const target=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    await rpc('Runtime.enable',{},sessionId);await rpc('Page.enable',{},sessionId);
    const evaluate=async expression=>{const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;};
    async function until(expression,label){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(40);}throw Error('Timed out: '+label);}
    const click=async text=>{await until('!!window.button('+JSON.stringify(text)+')&&!window.button('+JSON.stringify(text)+').disabled',text);await evaluate('window.button('+JSON.stringify(text)+').click()');await delay(50);};
    const input=async(selector,value)=>{await evaluate('window.setControl('+JSON.stringify(selector)+','+JSON.stringify(value)+')');await delay(40);};
    async function choose(label,text){
      await evaluate('document.querySelector('+JSON.stringify('button[aria-label="'+label+'"]')+').scrollIntoView({block:"center"})');await delay(100);await evaluate('document.querySelector('+JSON.stringify('button[aria-label="'+label+'"]')+').click()');await delay(100);
      assert.ok(await evaluate('Array.from(document.querySelectorAll("[role=option]")).some(row=>row.textContent.trim()==='+JSON.stringify(text)+')'),'controlled Select receives its required option: '+text);
      const point=await evaluate('(()=>{const option=Array.from(document.querySelectorAll("[role=option]")).find(row=>row.textContent.trim()==='+JSON.stringify(text)+');const rect=option.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;return {x,y,reachable:option.contains(document.elementFromPoint(x,y))};})()');
      assert.ok(point.reachable,'Select options are pointer reachable inside the native modal top layer');
      assert.equal(await evaluate('document.querySelector("[role=listbox]:not([aria-hidden=true])").parentElement===document.body'),!await evaluate('!!document.querySelector("dialog[open]")'),'normal Select keeps its body portal; modal Select stays in the active dialog');
      await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1},sessionId);await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1},sessionId);await delay(50);
    }
    await rpc('Page.navigate',{url:'http://127.0.0.1:'+server.address().port},sessionId);await until('!!window.fixture&&document.querySelectorAll(".forge-connection-card").length===2','uniform provider cards');
    assert.ok(await evaluate('document.querySelector(".forge-connection-card[data-provider=github]").textContent.includes("凭据待验证")'),'saved credential is not authentication evidence');
    assert.ok(await evaluate('document.querySelector(".forge-connection-card[data-provider=gitcode]").textContent.includes("未配置")'));
    assert.equal(await evaluate('!!document.querySelector("input[type=password]")'),false,'main page hides PAT form');
    await click('读取仓库信息');await until('document.querySelector(".forge-connection-card[data-provider=github]").textContent.includes("已连接")','successful read verifies only the current connection');
    await evaluate('window.fixture.doc.revision++;window.fixture.doc.providers[0].credentialConfigured=false');await click('刷新连接状态');
    assert.ok(await evaluate('document.querySelector(".forge-connection-card[data-provider=github]").textContent.includes("未配置")'),'refresh invalidates connection evidence after an external credential/configuration change');
    await evaluate('window.fixture.doc.revision++;window.fixture.doc.providers[0].credentialConfigured=true');await click('刷新连接状态');
    await evaluate('window.fixture.fault="FORGE_HTTP_ERROR"');await click('读取仓库信息');await until('document.querySelector(".forge-connection-card[data-provider=github]").textContent.includes("未授权")','403 evidence');
    await evaluate('window.fixture.fault="FORGE_NETWORK_ERROR"');await click('读取仓库信息');await until('document.querySelector(".forge-connection-card[data-provider=github]").textContent.includes("离线")','network failure');
    await evaluate('window.fixture.fault="FORGE_RESPONSE_INVALID"');await click('读取仓库信息');await until('document.querySelector(".forge-connection-card[data-provider=github]").textContent.includes("加载失败")','malformed response remains failure');
    await evaluate('window.fixture.fault=""');
    await click('CI');await choose('CI 读取内容','构建任务');await input('input[aria-label="构建运行 ID"]','fixture-run');await click('读取构建任务');
    assert.ok(await evaluate('window.fixture.calls.some(row=>row.params?.action==="builds.jobs"&&row.params.input.runId==="fixture-run")'),'CI job reads retain their exact required input');
    await evaluate('document.querySelector("button[aria-label=\\"管理 GitHub 连接\\"]").click()');await input('input[aria-label="GitHub 专用 Token"]','synthetic-fixture-credential');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"GitHub 专用 Token\\"]").type'),'password');
    await evaluate('window.fixture.saveFault=true');await click('保存专用凭据');await until('document.querySelector("dialog[open]")?.textContent.includes("could not be saved")','credential failure visible');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"GitHub 专用 Token\\"]").value'),'','failed save clears sensitive draft');
    await input('input[aria-label="GitHub 专用 Token"]','synthetic-fixture-credential');await click('关闭');await evaluate('document.querySelector("button[aria-label=\\"管理 GitHub 连接\\"]").click()');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"GitHub 专用 Token\\"]").value'),'','closing clears sensitive draft');
    await evaluate('window.fixture.saveFault=false');await input('input[aria-label="GitHub 专用 Token"]','synthetic-fixture-credential');await click('显示');assert.equal(await evaluate('document.querySelector("input[aria-label=\\"GitHub 专用 Token\\"]").type'),'text');await click('保存专用凭据');await until('document.querySelector("dialog[open]")?.textContent.includes("专用凭据已保存")','credential save receipt');assert.equal(await evaluate('document.querySelector("input[aria-label=\\"GitHub 专用 Token\\"]").value'),'', 'successful save clears sensitive draft');assert.equal(await evaluate('document.querySelector("input[aria-label=\\"GitHub 专用 Token\\"]").type'),'password','successful save restores masking');
    await evaluate('window.fixture.saveFault=true');
    await click('仓库范围');await click('添加仓库');await input('input[aria-label="Owner / 组织"]','fixture');await input('input[aria-label="仓库名称"]','draft-preserved');await click('下一步：权限范围');await click('保存仓库权限');await until('document.querySelector("dialog[open]")?.textContent.includes("configuration changed")','scope conflict visible');
    await click('上一步');assert.equal(await evaluate('document.querySelector("input[aria-label=\\"仓库名称\\"]").value'),'draft-preserved','failed save preserves non-sensitive draft');await click('关闭');
    await click('Issues');await click('创建 Issue');await input('input[aria-label="Issue 标题"]','preserved issue');await input('textarea[aria-label="内容"]','preserved body');await choose('关联任务','Fixture task');
    async function key(value){await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:value,code:value},sessionId);await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:value,code:value},sessionId);await delay(50);}
    await evaluate('document.querySelector("button[aria-label=\\"关联任务\\"]").focus()');await key('ArrowUp');await key('ArrowUp');await key('Enter');assert.equal(await evaluate('document.querySelector("button[aria-label=\\"关联任务\\"]").textContent.trim()'),'选择未结束任务','modal Select keyboard changes use the same controlled value');
    await key('ArrowDown');await key('ArrowDown');await key('Enter');assert.equal(await evaluate('document.querySelector("button[aria-label=\\"关联任务\\"]").textContent.trim()'),'Fixture task');
    await key('ArrowDown');await key('Escape');await until('document.querySelector("dialog[open]") && document.querySelector("button[aria-label=\\"关联任务\\"]").getAttribute("aria-expanded")==="false"','Escape closes the Select before its owning dialog');
    await evaluate('window.fixture.fault="FORGE_NETWORK_ERROR"');await click('提交审批');await until('document.querySelector("dialog[open]")?.textContent.includes("Forge request failed")','action error visible');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"Issue 标题\\"]").value'),'preserved issue');
    await evaluate('window.fixture.fault=""');await click('提交审批');await until('document.body.innerText.includes("fixture-approval")','pending approval shown');
    const writes=await evaluate('window.fixture.calls.filter(row=>row.params?.action==="issue.create")');assert.equal(writes.length,2);assert.equal(writes[0].params.operationId,writes[1].params.operationId,'retry retains logical operation identity');assert.equal(writes[0].params.taskId,'task-fixture');assert.equal(writes[0].params.workspaceId,'workspace-fixture');assert.equal(Object.hasOwn(writes[0].params,'approved'),false);
    await click('关闭');await input('input[aria-label="搜索已配置仓库"]','no-match');assert.ok(await evaluate('document.body.innerText.includes("没有匹配的仓库")'));await input('input[aria-label="搜索已配置仓库"]','');
    await click('查看 GitCode 仓库');await click('添加仓库');await input('input[aria-label="Owner / 组织"]','fixture');await input('input[aria-label="仓库名称"]','gitcode-public');await evaluate('document.querySelector("dialog[open] input[type=checkbox]").click()');await click('下一步：权限范围');
    assert.equal(await evaluate('Array.from(document.querySelectorAll("dialog[open] fieldset:last-of-type input")).every(row=>row.disabled)'),true,'public read does not offer enabled write grants');
    await evaluate('window.fixture.saveFault=false');await click('保存仓库权限');await until('document.querySelector("dialog[open]")?.textContent.includes("仓库权限范围已保存")','public scope save');await click('关闭');await click('Releases');
    assert.equal(await evaluate('window.button("创建 Release 草稿").disabled'),true);assert.ok(await evaluate('document.body.innerText.includes("GitCode API 不支持未发布的 Release 草稿")'));
    await click('CI');assert.equal(await evaluate('window.button("运行 GitHub 工作流").disabled'),true);assert.ok(await evaluate('document.body.innerText.includes("此平台暂不支持该操作")'));
    await evaluate('window.fixture.describeFault="FORGE_CONFIG_INVALID"');await click('刷新连接状态');await until('document.querySelector(".forge-connection-card[data-provider=gitcode]").textContent.includes("加载失败")','describe failures retain existing scopes');assert.ok(await evaluate('document.body.innerText.includes("fixture/gitcode-public")'),'load failure preserves previously read non-sensitive configuration');
    await evaluate('window.fixture.describeFault="";window.fixture.doc.providers[1].credentialConfigured=null;window.fixture.doc.providers[1].repositories=[];window.fixture.doc.revision++');await click('刷新连接状态');await until('document.querySelector(".forge-connection-card[data-provider=gitcode]").textContent.includes("状态待确认")','unknown credentials remain unknown');
    for(const width of [480,819,1024,1440]){
      await rpc('Emulation.setDeviceMetricsOverride',{width,height:768,deviceScaleFactor:1,mobile:false},sessionId);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'connection page has no horizontal overflow at '+width);
      await evaluate('document.querySelector("button[aria-label=\\"管理 GitCode 连接\\"]").click()');await delay(100);
      assert.ok(await evaluate('(()=>{const rect=document.querySelector("dialog[open]").getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight;})()'),'connection modal fits the viewport at '+width);await click('关闭');
    }
    await rpc('Emulation.setDeviceMetricsOverride',{width:480,height:768,deviceScaleFactor:1,mobile:false},sessionId);await click('添加仓库');await input('input[aria-label="Owner / 组织"]','fixture');await input('input[aria-label="仓库名称"]','long-name-'+('repository-'.repeat(8)));await click('下一步：权限范围');
    await evaluate('window.button("保存仓库权限").scrollIntoView({block:"center"})');await delay(100);
    assert.ok(await evaluate('(()=>{const button=window.button("保存仓库权限"),rect=button.getBoundingClientRect();return rect.bottom<=innerHeight&&button.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));})()'),'narrow permissions form scrolls its save action into pointer reach');await click('关闭');
    assert.equal(await evaluate('location.href.includes("synthetic-fixture")||document.body.innerText.includes("synthetic-fixture")'),false,'credential never appears in page text or URL');
    await rpc('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},sessionId);
    await evaluate('window.fixture.parentTaskFault=true;window.showPlugins()');await until('!!document.querySelector("[role=tablist][aria-label=\\"插件视图\\"]")','actual PluginsPage parent mount');
    await click('连接');await until('document.body.innerText.includes("任务列表读取失败：Synthetic task list unavailable")','actual parent exposes Task overview failure');
    await evaluate('window.fixture.parentTaskFault=false');await click('重试');await until('!document.body.innerText.includes("任务列表读取失败")&&document.querySelectorAll(".forge-connection-card").length===2','parent retry restores projected Task DTOs');
    assert.ok(await evaluate('window.fixture.calls.some(row=>row.method==="ui.task.overview")'),'actual parent requests Task overview through the product bridge');
    await click('Issues');await click('创建 Issue');await input('input[aria-label="Issue 标题"]','parent-wired issue');await input('textarea[aria-label="内容"]','parent-wired body');await choose('关联任务','Parent fixture task');
    assert.equal(await evaluate('window.button("提交审批").disabled'),false,'parent-provided real Task DTO makes authorized writes reachable');await click('提交审批');await until('document.querySelector("dialog[open]")?.textContent.includes("fixture-approval")','actual parent forwards controlled write to the existing bridge');
    const parentWrite=await evaluate('window.fixture.calls.findLast(row=>row.params?.input?.title==="parent-wired issue")');assert.equal(parentWrite.params.taskId,parentOverview.tasks[0].id);assert.equal(parentWrite.params.workspaceId,parentOverview.tasks[0].workspaceId);assert.equal(Object.hasOwn(parentWrite.params,'approved'),false);await click('关闭');
    assert.equal(await evaluate('document.querySelector(".connection-list").textContent.includes('+JSON.stringify(parentPack.name)+')'),false,'canonical tool pack is absent from Connections');
    await click('开发工具');await until('!!document.querySelector(".connection-list")','actual parent development tools group');assert.ok(await evaluate('document.querySelector(".connection-list").textContent.includes('+JSON.stringify(parentPack.name)+')'),'actual Integration Service -> Core UI DTO -> PluginsPage keeps tool packs in Development Tools');
    console.log('PASS actual PluginsPage parent: Task overview failure/retry, real projected Task binding, controlled pending write and authoritative tool-pack grouping');
    console.log('PASS Forge connections Chromium: honest state evidence, progressive credentials/scopes, secret clearing, failure draft preservation, scoped approval identity, search and narrow layout');
    await closeBrowser();await delay(300);failed=false;
  }
}catch(error){console.error(error.stack);throw error;}finally{
  if(closeBrowser&&socket?.readyState===WebSocket.OPEN){try{await closeBrowser();}catch{}await delay(1000);}
  if(socket?.readyState===WebSocket.OPEN)socket.terminate();
  if(child?.pid&&child.exitCode===null&&child.signalCode===null)await terminateSuiteProcessTree(child);
  if(server)await new Promise(resolve=>server.close(resolve));await integrationService?.close?.();finalizeSuiteSandbox({sandbox,failed,keepFailed:failed});
}
