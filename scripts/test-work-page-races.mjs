// Real production Task approval component in Chromium, with explicitly synthetic
// IPC. No Core, provider, external service, or actual approval is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const { buildSync } = require('esbuild');
const sandbox = createSuiteSandbox({ suiteId: 'work-page-races' });
let child, socket, failed = true;
try {
  const bundle = buildSync({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {TaskApprovals,WorkPage} from './src/app/WorkPage';
    import './src/theme/tokens.css';import './src/theme/global.css';import './src/app/harbor.css';import './src/app/chat-tasks.css';
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const approval={id:'approval-a',taskId:'task-a',title:'Synthetic pending approval',summary:'Test only',capability:'filesystem.write',risk:'high',status:'pending',createdAt:1,expiresAt:null};
    const state={status:'pending',holdNext:false,held:null,slowApprovalReads:2,slowReleases:[],failNextApprovalRead:false,failNextDecision:false,decisions:[],calls:[],holdNextOverview:false,holdAllOverviews:false,overviewReleases:[],holdNextGet:false,getRelease:null,holdNextCreate:false,createRelease:null};
    const task=(id,workspaceId,title)=>({id,rev:1,title,goal:title,status:'queued',currentPhase:'',progress:{percent:0,note:''},workspaceId,agent:null,currentAgent:null,parentTaskId:null,verification:null,attemptCount:0,childOutputKind:null,attempts:[],children:[],createdAt:1,updatedAt:1,checkpoint:null,result:null,artifacts:[],executionEvidence:[],agentHistory:[],failure:null});
    const recovery={...task('recover','a','Recovery parent'),rev:3,status:'blocked',currentAgent:{provider:'none',sessionId:'fixture'},progress:{percent:null,note:'needs-reconciliation: synthetic uncertain effect'},execution:{state:'needs-reconciliation',hadToolActivity:true,hasEvidence:true},recovery:{operations:[{operationId:'test-operation',capability:'filesystem.write',status:'UNKNOWN',executorId:'none',blocker:'needs-reconciliation'}],omitted:0},children:[{id:'child',title:'Child result',status:'completed',agent:'none',supersedesChildId:null,verification:'NEEDS_REVIEW',attemptCount:1,usage:null}]};
    const childTask={...task('child','a','Child result'),parentTaskId:'recover',status:'completed'};
    state.tasks=[recovery,...Array.from({length:55},(_,i)=>task('a-'+i,'a','Alpha task '+i)),task('b-1','b','Beta one'),task('b-2','b','Beta two')];
    window.confirm=message=>{if(!message.startsWith('取消任务'))throw Error('Unexpected confirmation');return true;};
    window.ipc={postMessage(raw){const request=JSON.parse(raw);void (async()=>{
      let result;if(request.method!=='ui.events.next')state.calls.push({method:request.method,params:request.params});
      if(request.method==='ui.approvals.list'){
        if(state.failNextApprovalRead){state.failNextApprovalRead=false;throw Error('Synthetic approval read failed');}
        const snapshot={approvals:[{...approval,status:state.status}],operations:[],grants:[]};
        if(state.slowApprovalReads>0){state.slowApprovalReads--;await new Promise(resolve=>state.slowReleases.push(resolve));}
        if(state.holdNext){state.holdNext=false;await new Promise(resolve=>state.held=resolve);}
        result=snapshot;
      }else if(request.method==='ui.approvals.decide'){
        if(state.failNextDecision){state.failNextDecision=false;throw Error('Synthetic approval refusal failed');}
        state.decisions.push(request.params);state.status='rejected';result={status:'completed',approvalId:request.params.id};
      }else if(request.method==='ui.task.overview'){
        const rows=state.tasks.filter(row=>(!request.params.workspaceId||row.workspaceId===request.params.workspaceId)&&(!request.params.status||row.status===request.params.status)&&(!request.params.query||row.goal.toLowerCase().includes(request.params.query.toLowerCase())));
        const offset=request.params.offset||0,limit=request.params.limit||50,snapshot={tasks:structuredClone(rows.slice(offset,offset+limit)),total:rows.length,counts:{},offset,limit,nextOffset:offset+limit<rows.length?offset+limit:null};
        if(state.holdNextOverview||state.holdAllOverviews){state.holdNextOverview=false;await new Promise(resolve=>state.overviewReleases.push(resolve));}
        result=snapshot;
      }else if(request.method==='ui.task.get'){
        const row=request.params.id==='child'?childTask:state.tasks.find(item=>item.id===request.params.id);if(!row)throw Error('Unknown synthetic Task');const snapshot=structuredClone(row);
        if(state.holdNextGet){state.holdNextGet=false;await new Promise(resolve=>state.getRelease=resolve);}result={task:snapshot};
      }else if(request.method==='ui.task.create'){
        const row=task(state.holdNextCreate?'created-cross':'created',request.params.workspaceId,request.params.goal);state.tasks.unshift(row);
        if(state.holdNextCreate){state.holdNextCreate=false;await new Promise(resolve=>state.createRelease=resolve);}else state.holdAllOverviews=true;
        result={task:structuredClone(row)};
      }else if(request.method==='ui.task.cancel'){
        const row=state.tasks.find(item=>item.id===request.params.id);if(!row||row.rev!==request.params.expectedRev)throw Error('Synthetic revision mismatch');row.status='cancelled';row.rev++;result={task:structuredClone(row)};
      }else if(request.method==='ui.task.recovery.inspect'){
        result={taskId:'recover',taskRev:3,operations:[{operationId:'test-operation',capability:'filesystem.write',status:'UNKNOWN',verified:false,code:'RECONCILIATION_REQUIRED'}],omitted:0};
      }else if(request.method==='ui.task.reconcile'){
        const row=state.tasks.find(item=>item.id===request.params.id);if(!row||row.rev!==request.params.expectedRev||request.params.reviewed!==true)throw Error('Synthetic review mismatch');row.rev++;row.progress.note='Owner reviewed interrupted effect';result={task:structuredClone(row)};
      }else if(request.method==='ui.agent.list')result={agents:[]};
      else if(request.method==='ui.settings.get')result={settings:{agents:{defaultAgentProvider:'auto'}}};
      else if(request.method==='ui.workspace.version')result={isRepo:false,headSha:null,changes:[],total:0,truncated:false,branch:null};
      else if(request.method.startsWith('ui.workshop.'))result={proposals:[]};
      else if(request.method==='ui.events.next'){
        await wait(100);result={instanceId:'synthetic',cursor:0,events:[]};
      }else throw Error('Unexpected fixture route '+request.method);
      window.__cetameshReceive({id:request.id,ok:true,result});
    })().catch(error=>window.__cetameshReceive({id:request.id,ok:false,error:{message:String(error)}}));}};
    const root=createRoot(document.getElementById('root'));root.render(<TaskApprovals taskId="task-a"/>);
    async function until(predicate,label){for(let i=0;i<100;i++){if(predicate())return;await wait(50);}throw Error('Timed out: '+label);}
    (async()=>{const result={};try{
      await until(()=>state.slowReleases.length===2,'overlapping slow approval reads');state.slowReleases[0]();await wait(200);
      result.slowApprovalShown=document.body.innerText.includes('Synthetic pending approval');state.slowReleases[1]();
      await until(()=>document.body.innerText.includes('Synthetic pending approval'),'initial pending approval');
      const readsBeforeFailure=state.calls.filter(row=>row.method==='ui.approvals.list').length;state.failNextApprovalRead=true;
      await until(()=>document.body.innerText.includes('Synthetic approval read failed'),'approval read error');
      await until(()=>state.calls.filter(row=>row.method==='ui.approvals.list').length>=readsBeforeFailure+2,'newer successful approval read');await wait(150);
      result.approvalReadRecovered=!document.body.innerText.includes('Synthetic approval read failed');
      state.failNextDecision=true;[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='拒绝').click();
      await until(()=>document.body.innerText.includes('Synthetic approval refusal failed'),'approval decision failure');
      const readsAfterDecisionFailure=state.calls.filter(row=>row.method==='ui.approvals.list').length;
      await until(()=>state.calls.filter(row=>row.method==='ui.approvals.list').length>readsAfterDecisionFailure,'approval read after decision failure');await wait(150);
      result.decisionErrorRetained=document.body.innerText.includes('Synthetic approval refusal failed');
      state.holdNext=true;await until(()=>state.held,'older pending list held');
      [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='拒绝').click();
      await until(()=>state.decisions.length===1&&!document.body.innerText.includes('Synthetic pending approval'),'refusal acknowledged');
      result.decision=state.decisions[0];state.held();await wait(350);
      result.oldPendingReappeared=document.body.innerText.includes('Synthetic pending approval');
      const workspaces=[{id:'a',name:'Alpha',status:'clean'},{id:'b',name:'Beta',status:'clean'}];
      const workPage=active=><WorkPage activeWorkspaceId={active} workspaces={workspaces} onRefreshWorkspaces={async()=>{}} reviewTaskId={null} onReviewTaskOpened={()=>{}}/>;
      root.render(workPage('a'));
      const button=text=>[...document.querySelectorAll('button')].find(row=>row.textContent.trim()===text&&!row.disabled);
      const click=text=>{const node=button(text);if(!node)throw Error('Missing enabled button '+text);node.click();};
      const card=title=>[...document.querySelectorAll('.task-card')].find(row=>row.querySelector('h3')?.textContent===title);
      const openCard=title=>{const node=card(title);if(!node)throw Error('Missing card '+title);[...node.querySelectorAll('button')].find(row=>row.textContent.trim()==='详情').click();};
      const choose=async label=>{document.querySelector('button[aria-label="任务项目范围"]').click();await until(()=>document.querySelector('[role=listbox][aria-label="任务项目范围"]'),'workspace popup');const item=[...document.querySelectorAll('[role=listbox][aria-label="任务项目范围"] [role=option]')].find(row=>row.textContent.trim()===label);if(!item)throw Error('Missing workspace '+label);item.click();};
      const close=async()=>{document.querySelector('.cm-sheet button[aria-label="关闭"]').click();await until(()=>!document.querySelector('.cm-sheet:not([aria-hidden=true])'),'drawer closed');};
      const fill=(label,value)=>{const node=document.querySelector('textarea[aria-label="'+label+'"]');if(!node)throw Error('Missing field '+label);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));};
      await until(()=>card('Recovery parent')&&button('下一页任务'),'first page loaded');
      state.holdNextOverview=true;click('下一页任务');await until(()=>state.overviewReleases.length>0,'old page held');
      await choose('Beta');await until(()=>card('Beta one')&&card('Beta two'),'new Workspace loaded');
      state.overviewReleases.splice(0).forEach(resolve=>resolve());await wait(200);
      result.oldPageRejected=!!card('Beta one')&&!card('Recovery parent');
      state.holdNextGet=true;openCard('Beta one');await until(()=>state.getRelease,'old detail held');openCard('Beta two');
      await until(()=>document.querySelector('.cm-sheet h2')?.textContent==='Beta two','new detail loaded');state.getRelease();await wait(200);
      result.newSelectionPreserved=document.querySelector('.cm-sheet h2')?.textContent==='Beta two';await close();
      await choose('Alpha');await until(()=>card('Recovery parent'),'Alpha restored');click('新建任务');await until(()=>document.querySelector('.task-create-form textarea[aria-label="任务目标"]'),'cross-scope creation form');
      const crossGoal='Cross scope '+('W'.repeat(120));fill('任务目标',crossGoal);await until(()=>button('开始任务'),'cross-scope submit enabled');state.holdNextCreate=true;click('开始任务');await until(()=>state.createRelease,'creation response held');
      root.render(workPage('b'));await until(()=>card('Beta one')&&document.querySelector('button[aria-label="任务项目范围"]')?.textContent.includes('Beta'),'workspace prop switched');state.createRelease();
      await until(()=>document.body.innerText.includes('已创建任务“Cross scope '),'cross-scope creation notice');
      const notice=[...document.querySelectorAll('section[role=status]')].find(row=>row.textContent.includes('已创建任务'));
      result.noticeNoOverflow=notice.scrollWidth<=notice.clientWidth+1;
      result.crossScopeNotice=!!card('Beta one')&&!card(crossGoal);click('查看任务');await until(()=>document.querySelector('.cm-sheet h2')?.textContent.startsWith('Cross scope '),'notice opens the exact Task');await close();
      await choose('Alpha');await until(()=>card('Recovery parent'),'Alpha restored again');click('新建任务');await until(()=>document.querySelector('.task-create-form textarea[aria-label="任务目标"]'),'creation form');
      fill('任务目标','Immediately visible synthetic task');await until(()=>button('开始任务'),'synthetic submit enabled');click('开始任务');
      await until(()=>document.querySelector('.cm-sheet h2')?.textContent==='Immediately visible synthetic task','created Task detail');
      result.createdVisibleWhileOverviewPending=!!card('Immediately visible synthetic task')&&state.overviewReleases.length>0;
      state.holdAllOverviews=false;state.overviewReleases.splice(0).forEach(resolve=>resolve());
      await until(()=>button('取消任务'),'cancel control');click('取消任务');await until(()=>state.calls.some(row=>row.method==='ui.task.cancel'),'synthetic cancellation');
      result.cancelCall=state.calls.find(row=>row.method==='ui.task.cancel')?.params;await until(()=>document.querySelector('.cm-sheet .task-detail-overview')?.textContent.includes('已取消'),'cancelled state shown');await close();
      await until(()=>card('Recovery parent'),'recovery card');openCard('Recovery parent');await until(()=>document.querySelector('.cm-sheet h2')?.textContent==='Recovery parent','recovery detail');
      result.recoveryRequiresReview=!!document.querySelector('textarea[aria-label="核对结果"]')&&button('确认核对并执行新指令')===undefined;
      click('核对已记录结果（只读）');await until(()=>state.calls.some(row=>row.method==='ui.task.recovery.inspect'),'read-only inspection');
      click('Child result');await until(()=>document.querySelector('.cm-sheet h2')?.textContent==='Child result','child detail');click('返回父任务');await until(()=>document.querySelector('.cm-sheet h2')?.textContent==='Recovery parent','parent detail');
      fill('核对结果','人工核对了合成证据');fill('新的执行指令','仅测试合成恢复请求');await until(()=>button('确认核对并执行新指令'),'review fields enable explicit recovery');click('确认核对并执行新指令');
      await until(()=>state.calls.some(row=>row.method==='ui.task.reconcile'),'synthetic reconciliation');result.reconcileCall=state.calls.find(row=>row.method==='ui.task.reconcile')?.params;
      result.unexpectedExecutionCalls=state.calls.filter(row=>['ui.task.start','ui.task.resume','ui.chat.send'].includes(row.method)).length;root.unmount();
    }catch(error){result.error=String(error.message)}finally{document.getElementById('result').textContent=encodeURIComponent(JSON.stringify(result));}})();
  ` }, bundle: true, write: false, outdir:path.join(sandbox.root,'bundle'), minify: true, format: 'iife', platform: 'browser', jsx: 'automatic' });
  const file = path.join(sandbox.root, 'fixture.html');
  const js=bundle.outputFiles.find(item=>item.path.endsWith('.js'))?.text,css=bundle.outputFiles.filter(item=>item.path.endsWith('.css')).map(item=>item.text).join('\n');
  assert.ok(js&&css,'production scripts and styles are bundled');
  fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><style>'+css+'</style><div id="root"></div><pre id="result"></pre><script>' + js + '</script>');
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  const profile = path.join(sandbox.root, 'profile');
  child = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await delay(100);
  assert.ok(fs.existsSync(portFile), 'Chromium debugging endpoint must start');
  const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let seq = 0; const pending = new Map();
  socket.on('message', data => { const reply = JSON.parse(String(data)), item = pending.get(reply.id); if (item) { pending.delete(reply.id); clearTimeout(item.timer); reply.error ? item.reject(Error(reply.error.message)) : item.resolve(reply.result); } });
  const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await rpc('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await rpc('Runtime.enable', {}, sessionId); await rpc('Page.enable', {}, sessionId); await rpc('Emulation.setDeviceMetricsOverride',{width:480,height:768,deviceScaleFactor:1,mobile:false},sessionId); await rpc('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
  let encoded;
  for (let i = 0; i < 200; i++) { const reply = await rpc('Runtime.evaluate', { expression: 'document.getElementById("result")?.textContent', returnByValue: true }, sessionId); encoded = reply.result?.value; if (encoded) break; await delay(100); }
  assert.ok(encoded, 'production React fixture must finish');
  const result = JSON.parse(decodeURIComponent(encoded));
  console.log(JSON.stringify(result));
  await rpc('Browser.close'); await delay(750);
  assert.equal(result.error, undefined);
  assert.equal(result.slowApprovalShown, true, 'a successful slow approval read must not starve while a newer read is pending');
  assert.equal(result.approvalReadRecovered, true, 'a newer successful approval read clears only the obsolete read error');
  assert.equal(result.decisionErrorRetained, true, 'a successful background read must not erase a failed refusal');
  assert.deepEqual(result.decision, { id: 'approval-a', approve: false, reuse: false }, 'refusal stays scoped and never grants reuse');
  assert.equal(result.oldPendingReappeared, false, 'late pre-refusal response must not revive a rejected approval');
  assert.equal(result.oldPageRejected, true, 'old page cannot overwrite the selected Workspace');
  assert.equal(result.newSelectionPreserved, true, 'late detail cannot replace a newer selection');
  assert.equal(result.crossScopeNotice, true, 'late cross-Workspace creation is discoverable without contaminating the current list');
  assert.equal(result.noticeNoOverflow, true, 'long created Task titles wrap within the narrow Workspace notice');
  assert.equal(result.createdVisibleWhileOverviewPending, true, 'created Task appears before a delayed overview');
  assert.deepEqual(result.cancelCall, { id: 'created', expectedRev: 1 }, 'cancellation carries the actual Task identity and revision');
  assert.equal(result.recoveryRequiresReview, true, 'uncertain effects require explicit review and new instruction');
  assert.equal(result.reconcileCall?.id, 'recover');assert.equal(result.reconcileCall?.expectedRev, 3);assert.equal(result.reconcileCall?.reviewed, true);
  assert.equal(result.unexpectedExecutionCalls, 0, 'fixture must not dispatch a model or silently resume');
  failed = false;
  console.log('PASS Chromium refusal retains the newer approval state after a stale response');
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.terminate();
  if (child?.pid && child.exitCode === null && child.signalCode === null) { await terminateSuiteProcessTree(child); await delay(250); }
  finalizeSuiteSandbox({ sandbox, failed });
}
