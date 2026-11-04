// Production Chat/Task components and typed bridge, with deterministic local DTOs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
const root = path.resolve(import.meta.dirname, '../desktop-ui'), require = createRequire(path.join(root, 'package.json'));
const sandbox = createSuiteSandbox({ suiteId: 'chat-failure-feedback-ui' });
let failed = true, server, browser, socket, closeBrowser;
try {
  const { build } = require('esbuild');
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{ChatPage,WorkPage}from'./src/app/HarborApp';import{useUi}from'./src/stores/ui';import{diagnosticClientFailure}from'./src/app/StartupDiagnostics';import'./src/theme/tokens.css';import'./src/theme/global.css';
    window.fixture={calls:[],opened:[],errors:[],mode:'history',pendingSend:null};window.addEventListener('error',e=>window.fixture.errors.push(e.message));
    const failure={id:'failed-request',role:'system',text:'',at:1,requestId:'request-busy',attachments:[],toolActivity:[],agentActivity:null,error:'private error body',errorCode:'TASK_WORKSPACE_BUSY',failureStage:'pre-dispatch',routing:{blockingTaskId:'task-owner'},cancelled:false};
    const task={id:'task-owner',title:'Occupied project',goal:'Review safely',status:'paused',currentPhase:'',progress:{percent:null,note:'Localized progress copy'},workspaceId:null,agent:'codex',currentAgent:{provider:'codex',sessionId:'old-session'},parentTaskId:null,verification:null,attemptCount:0,childOutputKind:null,attempts:[],children:[],createdAt:1,updatedAt:1,rev:7,checkpoint:null,result:null,artifacts:[],executionEvidence:[],agentHistory:[],failure:null};
    window.fixture.preview={taskId:task.id,taskRev:7,operations:[],omitted:0,reviewToken:'review-token-7',expiresAt:Date.now()+60000,session:{state:'not-found',stopped:true,provider:'codex',sessionId:'old-session',code:'SESSION_NOT_FOUND'},workspace:{kind:'directory',sha256:'a'.repeat(64),fileCount:0},blockers:[],reviewOperationIds:[],canResume:true,canRelease:true,ownership:{taskId:task.id,provider:'codex',taskStatus:'paused',reason:'SESSION_NOT_FOUND',unconfirmedOperations:0,safeActions:['resume','release']}};
    function reply(r){window.fixture.calls.push(structuredClone(r));if(r.method==='ui.events.next')return{events:[],instanceId:'failure-fixture',cursor:0};if(r.method==='ui.chat.catalog')return{models:[],modelProviders:[],agentProviders:[],modes:['chat'],defaultModelProvider:null,available:true,reason:null};
    if(r.method==='ui.chat.history')return{id:r.params.id,total:window.fixture.mode==='history'?1:0,messages:window.fixture.mode==='history'?[failure]:[],hasMore:false,hasMoreAfter:false};
    if(r.method==='ui.chat.status')return{id:r.params.id,taskId:null,state:window.fixture.mode==='preparing'?'starting':window.fixture.mode==='history'?'error':'idle',requestId:window.fixture.mode==='history'?'request-busy':null,statusMessage:null,retryCount:0,followState:'idle',followError:null,displayText:'',toolActivity:[],agentActivity:null,error:window.fixture.mode==='history'?failure.error:null,errorCode:failure.errorCode,failureStage:failure.failureStage,approvalId:null,routing:failure.routing};
    if(r.method==='ui.memory.overview')return{memories:[],total:0,candidates:[]};if(r.method==='ui.approvals.list')return{approvals:[],operations:[],grants:[]};if(r.method==='ui.agent.list')return{agents:[{id:'codex',name:'Codex',taskEligible:true,reason:null}]};if(r.method==='ui.task.get')return{task};if(r.method==='ui.task.overview')return{tasks:[task],total:1,offset:0,limit:50,counts:{paused:1},needsAttention:[]};
    if(r.method==='ui.workshop.proposals')return{proposals:[],total:0};if(r.method==='ui.task.recovery.inspect')return structuredClone(window.fixture.preview);if(r.method==='ui.agent.execution.scope')return{required:false};if(r.method==='ui.task.reconcile')throw{code:'RECOVERY_PREVIEW_STALE',message:'Recovery preview changed; inspect again'};
    if(r.method.startsWith('app.diagnostics.'))return{report:diagnosticClientFailure('FIXTURE_DIAGNOSTIC',false),coreAvailable:true};return r.method.includes('limits')?{limits:{}}:r.method.includes('capabilities')?{supported:false,status:'unknown'}:{};}
    window.ipc={postMessage(raw){const r=JSON.parse(raw);if(r.method==='ui.chat.send'){window.fixture.calls.push(r);window.fixture.pendingSend=r;return;}setTimeout(()=>{try{window.__cetameshReceive({id:r.id,ok:true,result:reply(r)});}catch(e){window.__cetameshReceive({id:r.id,ok:false,error:e});}},r.method==='ui.events.next'?200:0);}};
    const app=createRoot(document.getElementById('root'));let seq=0;window.showChat=mode=>{window.fixture.mode=mode;const id='chat-'+ ++seq;useUi.getState().setChatDraft(id,mode==='send'?'Preserve failed draft':'');app.render(<main className="harbor-main fixture"><ChatPage key={id} session={{id,title:'Failure fixture',taskId:null,config:{mode:'chat',agentProvider:'none',workspaceId:null,modelProvider:null,model:'',reasoning:'off'}}} workspaces={[]} activeWorkspaceId={null} onSessionUpdate={()=>{}} onNew={async()=>{}} onNewChat={async()=>{}} onOpenMemory={()=>{}} onConfigureModels={()=>{}} onReviewTask={id=>window.fixture.opened.push(id)}/></main>);};
    window.rejectSend=()=>{const r=window.fixture.pendingSend;window.fixture.pendingSend=null;window.__cetameshReceive({id:r.id,ok:false,error:{code:'TASK_RECOVERY_REVIEW_REQUIRED',message:'private rejected detail'}});};
    window.showTask=()=>app.render(<main className="harbor-main fixture"><WorkPage workspaces={[]} activeWorkspaceId={null} onRefreshWorkspaces={async()=>{}} reviewTaskId="task-owner" onReviewTaskOpened={()=>{}}/></main>);window.showChat('history');
  ` }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic', plugins: [{ name: 'production-chat-export', setup(build) { build.onLoad({ filter: /[\\/]HarborApp\.tsx$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8') + '\nexport {ChatPage};', loader: 'tsx', resolveDir: path.dirname(args.path) })); } }] });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text, css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end('<!doctype html><meta charset="utf-8"><style>' + css + 'html,body,#root{height:100%;margin:0}.fixture{height:100%;grid-row:auto;grid-column:auto}</style><div id="root"></div><script>' + js.replaceAll('</script', '<\\/script') + '</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(edge)) { console.log('NOT_RUN_ENVIRONMENT Chromium is required'); process.exitCode = 77; failed = false; }
  else {
    const profile = path.join(sandbox.root, 'profile'); browser = spawn(edge, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort'); for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100); assert.ok(fs.existsSync(portFile));
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/); socket = new WebSocket('ws://127.0.0.1:' + port + browserPath); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0; const pending = new Map(); socket.on('message', bytes => { const reply = JSON.parse(String(bytes)), entry = pending.get(reply.id); if (!entry) return; pending.delete(reply.id); clearTimeout(entry.timer); reply.error ? entry.reject(Error(reply.error.message)) : entry.resolve(reply.result); });
    const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); }); closeBrowser = () => rpc('Browser.close');
    const target = await rpc('Target.createTarget', { url: 'about:blank' }), { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true }); await rpc('Page.enable', {}, sessionId);
    const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    const until = async (expression, label) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(40); } throw Error('Timed out: ' + label + ' ' + JSON.stringify(await evaluate('({text:document.body.innerText.slice(0,2500),errors:window.fixture.errors,calls:window.fixture.calls.slice(-10).map(r=>r.method)})'))); };
    const click = label => evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent===' + JSON.stringify(label) + ')?.click()');
    await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sessionId);
    await until('document.querySelectorAll(".chat-failure-card").length===1', 'single canonical failure'); await delay(100);
    assert.equal(await evaluate('document.querySelectorAll(".chat-failure-card").length'), 1); assert.equal(await evaluate('document.querySelectorAll(".chat-message.assistant").length'), 0);
    await click('查看占用任务'); assert.deepEqual(await evaluate('window.fixture.opened'), ['task-owner']); await click('诊断'); await until('!!document.querySelector(".diagnostics-panel")', 'working diagnostic panel');
    await evaluate('window.showChat("preparing")'); await until('!!document.querySelector(".chat-request-pending")', 'request preparation'); assert.equal(await evaluate('document.querySelectorAll(".chat-message.assistant").length'), 0);
    await evaluate('window.showChat("send")'); await until('document.querySelector("textarea")?.value==="Preserve failed draft"', 'draft');
    await evaluate('document.querySelector(".composer-submit").click();document.querySelector(".composer-submit").click()'); await until('!!window.fixture.pendingSend', 'pending send');
    assert.equal(await evaluate('window.fixture.calls.filter(row=>row.method==="ui.chat.send").length'), 1); await evaluate('window.rejectSend()');
    await until('document.querySelectorAll(".chat-failure-card").length===1', 'failed send notice'); assert.equal(await evaluate('document.querySelector("textarea").value'), 'Preserve failed draft'); assert.equal(await evaluate('document.querySelectorAll(".harbor-error").length'), 0);
    await evaluate('window.showTask()'); await until('document.body.textContent.includes("尚未读取恢复检查")', 'Task recovery entry');
    await click('核对已记录结果（只读）'); await until('document.body.textContent.includes("SESSION_NOT_FOUND")', 'current recovery preview');
    const setText = async (label, value) => { await evaluate('document.querySelector('+JSON.stringify('textarea[aria-label="'+label+'"]')+').focus()'); await rpc('Input.insertText', { text: value }, sessionId); };
    await setText('核对结果', 'Checked old process and workspace without assuming success'); await setText('新的执行指令', 'Continue only with a new instruction');
    await click('确认核对并释放占用'); await until('window.fixture.calls.some(row=>row.method==="ui.task.reconcile")', 'reconcile bridge call');
    const sent = await evaluate('window.fixture.calls.find(row=>row.method==="ui.task.reconcile").params'); assert.equal(sent.action, 'release'); assert.equal(sent.reviewToken, 'review-token-7'); assert.equal(sent.expectedRev, 7); assert.deepEqual(sent.reviewedOperationIds, []);
    await until('document.body.textContent.includes("Recovery preview changed")', 'stale preview error');
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).filter(button=>/确认核对并/.test(button.textContent)).every(button=>button.disabled)'), true, 'stale/consumed token cannot be resubmitted');
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=核对结果]").value'), 'Checked old process and workspace without assuming success');
    assert.deepEqual(await evaluate('window.fixture.errors'), []);
    console.log('PASS production Chat dedup, pending request, draft/single send, diagnostics, blocking Task navigation and preview-bound release'); failed = false;
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await closeBrowser(); } catch {} socket.terminate(); await delay(200); }
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) await terminateSuiteProcessTree(browser);
  if (server) await new Promise(resolve => server.close(resolve));
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
