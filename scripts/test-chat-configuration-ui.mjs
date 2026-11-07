// Production Chat/Task components and typed bridge, with deterministic local DTOs.
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop-ui'), require = createRequire(path.join(root, 'package.json'));
const sandbox = createSuiteSandbox({ suiteId: 'chat-configuration-ui' });
let failed = true, server, browser, browserClosed, socket, closeBrowser;
try {
  const { build } = require('esbuild');
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{ChatPage}from'./src/app/HarborApp';import'./src/theme/tokens.css';import'./src/theme/global.css';
window.fixture={calls:[],errors:[]};window.addEventListener('error',e=>window.fixture.errors.push(e.message));
const skillRef={skillId:'skill:'+'a'.repeat(40),sourceRevision:'b'.repeat(64)};
const saved={revision:1,changeId:'saved',state:'saved',application:'next-turn',durable:true,runtime:'not-required',at:1,errorCode:null};
const session={id:'fixture-chat',title:'Fixture',taskId:null,configuration:saved,config:{mode:'chat',agentProvider:'none',workspaceId:null,modelProvider:null,model:'',reasoning:'off'}};
function reply(r){window.fixture.calls.push(structuredClone(r));if(r.method==='ui.events.next')return{events:[],instanceId:'fixture',cursor:0};
if(r.method==='ui.chat.catalog')return{models:[],modelProviders:[],agentProviders:[],modes:['chat'],defaultModelProvider:null,available:true,reason:null};
if(r.method==='ui.chat.history')return{id:session.id,total:1,messages:[{id:'historic-reference',role:'user',text:'Earlier selected reference',at:1,attachments:[],toolActivity:[],skillRefs:[{...skillRef}],error:null,cancelled:false}],hasMore:false,hasMoreAfter:false};
if(r.method==='ui.chat.status')return{id:session.id,taskId:null,state:'idle',requestId:null,statusMessage:null,retryCount:0,followState:'idle',followError:null,displayText:'',toolActivity:[],agentActivity:null,error:null,errorCode:null,approvalId:null,routing:{},configuration:saved};
if(r.method==='ui.memory.overview')return{memories:[],total:0,candidates:[]};if(r.method==='ui.approvals.list')return{approvals:[],operations:[],grants:[]};
if(r.method==='ui.chat.config.set')throw{code:'WORKSPACE_NOT_FOUND',message:'Fixture configuration refusal remains actionable'};
if(r.method==='ui.skills.list')return{indexRevision:'c'.repeat(64),entries:[{...skillRef,name:'fixture-reference',description:'A bounded test reference',sourceId:'workspace:fixture',sourceKind:'project'}],shadowed:[],omissions:[]};
if(r.method==='ui.skills.read')return{content:'LOW_TRUST_REFERENCE_BODY',sourceRevision:skillRef.sourceRevision,nextOffset:null,truncated:false};
if(r.method==='ui.chat.send'){if(window.fixture.rejectNextSend){window.fixture.rejectNextSend=false;throw{code:'FIXTURE_SEND_REFUSED',message:'Keep selected references and draft'};}return{userMessageId:r.params.clientMessageId};}
return r.method.includes('limits')?{limits:{}}:r.method.includes('capabilities')?{supported:false,status:'unknown'}:{};}
window.ipc={postMessage(raw){const r=JSON.parse(raw);setTimeout(()=>{try{window.__cetameshReceive({id:r.id,ok:true,result:reply(r)});}catch(e){window.__cetameshReceive({id:r.id,ok:false,error:e});}},r.method==='ui.events.next'?200:0);}};
createRoot(document.getElementById('root')).render(<main className='harbor-main fixture'><ChatPage session={session} workspaces={[{id:'ws-2',name:'Second',status:'ready'}]} activeWorkspaceId={null} onSessionUpdate={()=>{}} onNew={async()=>{}} onNewChat={async()=>{}} onOpenMemory={()=>{}} onConfigureModels={()=>{}} onReviewTask={()=>{}}/></main>);
  ` }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic', plugins: [{ name: 'production-chat-export', setup(build) { build.onLoad({ filter: /[\\/]HarborApp\.tsx$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8') + '\nexport {ChatPage};', loader: 'tsx', resolveDir: path.dirname(args.path) })); } }] });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end('<!doctype html><meta charset="utf-8"><style>' + css + 'html,body,#root{height:100%;margin:0}.fixture{height:100%;grid-row:auto;grid-column:auto}</style><div id="root"></div><script>' + js.replaceAll('</script', '<\\/script') + '</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(edge)) { console.log('NOT_RUN_ENVIRONMENT Chromium is required'); process.exitCode = 77; failed = false; }
  else {
    const profile = path.join(sandbox.root, 'profile'); browser = spawn(edge, ['--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    browserClosed = new Promise(resolve => browser.once('close', resolve));
    const portFile = path.join(profile, 'DevToolsActivePort'); for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100); assert.ok(fs.existsSync(portFile));
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/); socket = new WebSocket('ws://127.0.0.1:' + port + browserPath); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0; const pending = new Map(); socket.on('message', bytes => { const reply = JSON.parse(String(bytes)), entry = pending.get(reply.id); if (!entry) return; pending.delete(reply.id); clearTimeout(entry.timer); reply.error ? entry.reject(Error(reply.error.message)) : entry.resolve(reply.result); });
    const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); }); closeBrowser = () => rpc('Browser.close');
    const target = await rpc('Target.createTarget', { url: 'about:blank' }), { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true }); await rpc('Page.enable', {}, sessionId);
    const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    const until = async (expression, label) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(40); } throw Error('Timed out: ' + label + ' ' + JSON.stringify(await evaluate('({text:document.body.innerText.slice(0,2500),errors:window.fixture.errors,calls:window.fixture.calls.slice(-10).map(r=>r.method)})'))); };
    const click = label => evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent===' + JSON.stringify(label) + ')?.click()');
    await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sessionId);

    await until('!!document.querySelector("button.composer-context-trigger")&&!document.querySelector("button.composer-context-trigger").disabled','configuration control');
    await evaluate('document.querySelector("button.composer-context-trigger").click()');
    await until('!!document.querySelector("button[aria-label=任务工作区]")','workspace selector');
    await evaluate('document.querySelector("button[aria-label=任务工作区]").click()');await until('Array.from(document.querySelectorAll("[role=option]")).some(x=>x.textContent==="Second")','workspace option');await evaluate('Array.from(document.querySelectorAll("[role=option]")).find(x=>x.textContent==="Second").click()');
    await until('window.fixture.calls.some(r=>r.method==="ui.chat.config.set")','configuration rejected');
    await delay(250);
    const result=await evaluate('({configCalls:window.fixture.calls.filter(r=>r.method==="ui.chat.config.set").length,lastCalls:window.fixture.calls.slice(-8).map(r=>r.method),body:document.body.innerText,errorCards:document.querySelectorAll(".harbor-error").length,refusalRetained:document.body.innerText.includes("Fixture configuration refusal remains actionable"),errors:window.fixture.errors})');
    console.log(JSON.stringify(result,null,2));
    assert.equal(result.configCalls,1);assert.equal(result.refusalRetained,true,'a configuration refusal remains actionable after refreshed catalog and history');assert.equal(result.errorCards,1);assert.deepEqual(result.errors,[]);console.log('PASS production Chat configuration refusal survives snapshot refresh without duplicate dispatch');
    await until('!!document.querySelector(".message-skill-references summary")','persisted Skill references');
    await evaluate('document.querySelector(".message-skill-references summary").click()');
    await click('读取此版本参考');
    await until('document.querySelector(".message-skill-references pre")?.textContent==="LOW_TRUST_REFERENCE_BODY"','historical fixed-version body');
    const historyReads=await evaluate('window.fixture.calls.filter(r=>r.method==="ui.chat.history").length');
    await evaluate('window.__cetameshEvent({event:"chat.updated",data:{sessionId:"fixture-chat"}})');
    await until('window.fixture.calls.filter(r=>r.method==="ui.chat.history").length>'+historyReads,'normal history refresh');
    await delay(120);
    assert.equal(await evaluate('document.querySelector(".message-skill-references pre")?.textContent'),'LOW_TRUST_REFERENCE_BODY','equal persisted references keep the expanded preview across history refresh');
    await until('!!document.querySelector("button[aria-label=添加技能]")','shared Skill add entry');
    await evaluate('document.querySelector("button[aria-label=添加技能]").click()');
    await until('!!document.querySelector("input[aria-label=\\"选择 Skill fixture-reference\\"]")','actual shared Skill selector');
    await evaluate('document.querySelector("input[aria-label=\\"选择 Skill fixture-reference\\"]").click()');
    await click('关闭 Skill');
    const editDraft = value => evaluate('(()=>{const input=document.querySelector("textarea[aria-label=输入消息]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,' + JSON.stringify(value) + ');input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await editDraft('Use fixed Skill version');
    await until('!document.querySelector("button[aria-label=发送消息]").disabled','Skill send enabled');
    await evaluate('window.fixture.rejectNextSend=true;document.querySelector("button[aria-label=发送消息]").click()');
    await until('window.fixture.calls.filter(r=>r.method==="ui.chat.send").length===1','first owned send refusal');
    await until('!!document.querySelector("textarea[aria-label=输入消息]")&&!document.querySelector("button[aria-label=发送消息]").disabled','failed send settled');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=输入消息]").value'),'Use fixed Skill version');
    assert.equal(await evaluate('document.body.innerText.includes("已选 1 个技能")'),true,'a refused send keeps exact selected refs');
    await evaluate('document.querySelector("button[aria-label=发送消息]").click()');
    await until('window.fixture.calls.filter(r=>r.method==="ui.chat.send").length===2','same-id explicit send retry');
    await until('document.querySelector("textarea[aria-label=输入消息]").value===""','confirmed send clears only submitted draft');
    const sends=await evaluate('window.fixture.calls.filter(r=>r.method==="ui.chat.send").map(r=>r.params)');
    assert.equal(sends[0].clientMessageId,sends[1].clientMessageId,'retry preserves the message identity');
    assert.deepEqual(sends[0].skillRefs,[{skillId:'skill:'+'a'.repeat(40),sourceRevision:'b'.repeat(64)}]);
    assert.deepEqual(sends[1].skillRefs,sends[0].skillRefs);
    await editDraft('/');
    await until('!!document.querySelector("[data-skill-picker=slash]")','slash uses the same production picker');
    assert.equal(await evaluate('document.querySelectorAll("input[aria-label=\\"选择 Skill fixture-reference\\"]").length'),1);
    assert.deepEqual(await evaluate('window.fixture.errors'),[]);
    console.log('PASS production Chat add/slash Skill entry, exact typed references, refused-send draft preservation and same-id retry');
    failed=false;
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await closeBrowser(); } catch {} socket.terminate(); }
  // CDP close can acknowledge while the owned process is still exiting.
  if (browserClosed) await Promise.race([browserClosed, delay(3000)]);
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) await terminateSuiteProcessTree(browser);
  if (server) await new Promise(resolve => server.close(resolve));
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
