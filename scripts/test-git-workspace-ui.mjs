// Production GitWorkspace + ApprovalCard + actual Workspace/Task/Capability/UI Core.
// The localhost HTTP adapter is test-only; this does not claim native WebView2 acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createTaskService } from '../src/task/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const { buildSync } = require('esbuild');
const sandbox = createSuiteSandbox({ suiteId: 'git-workspace-ui' });
let failed = true, child, socket, server, capabilityService, closeBrowser;
const calls = [];
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + path.join(sandbox.root, 'no-hooks'), ...args], { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const project = path.join(sandbox.root, 'project'), stateDir = path.join(sandbox.root, 'state');
  fs.mkdirSync(project); git(project, 'init', '-q', '-b', 'main'); git(project, 'config', 'core.autocrlf', 'false'); git(project, 'config', 'user.name', 'UI Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(project, 'a.txt'), 'baseline a\n'); fs.writeFileSync(path.join(project, 'user.txt'), 'baseline user\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'initial fixture');
  const baseline = git(project, 'rev-parse', 'HEAD');
  let taskService;
  const workspaceService = createWorkspaceService({ stateDir, getTask: id => taskService.runtime.get({ id }).task, listTasks: query => taskService.runtime.list(query).tasks });
  taskService = createTaskService({ stateDir, resolveWorkspace: id => workspaceService.describeWorkspace(id) });
  const { workspace } = await workspaceService.execute({ method: 'workspace.create', params: { name: 'Real Git project', root: project } });
  await workspaceService.execute({ method: 'workspace.open', params: { id: workspace.id } });
  taskService.runtime.create({ goal: 'Another actual Task', workspaceId: workspace.id });
  const selectedTask = taskService.runtime.create({ goal: 'Task selected in Git UI', workspaceId: workspace.id });
  capabilityService = createCapabilityService({ stateDir, workspaceService, taskRuntime: taskService.runtime });
  const ui = createDesktopUiService({ services: { workspaceService, taskService, capabilityService } });
  fs.writeFileSync(path.join(project, 'a.txt'), 'approved UI change\n'); fs.writeFileSync(path.join(project, 'user.txt'), 'unrelated user staged\n'); git(project, 'add', 'user.txt'); fs.writeFileSync(path.join(project, 'user.txt'), 'unrelated user unstaged\n'); fs.writeFileSync(path.join(project, 'loose.txt'), 'unrelated loose file\n');
  const initialStatus = git(project, 'status', '--porcelain'), initialIndex = git(project, 'show', ':user.txt');

  const bundle = buildSync({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {GitWorkspace} from './src/app/GitWorkspace';import {ApprovalCard} from './src/app/HarborApp';import {productToolsClient,approvalClient,workspaceClient} from './src/bridge/typed-client';
    const sourceId=${JSON.stringify(workspace.id)};
    async function transport(method,params){const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.message),{code:data.code});return data;}
    window.ipc={postMessage(raw){const request=JSON.parse(raw);transport(request.method,request.params).then(result=>window.__cetameshReceive({id:request.id,ok:true,result}),error=>window.__cetameshReceive({id:request.id,ok:false,error:{code:error.code||'FIXTURE',message:error.message}}));}};
    function Harness(){const [workspaces,setWorkspaces]=useState([{id:sourceId,name:'Real Git project'}]),[activeId,setActiveId]=useState(sourceId),[approvals,setApprovals]=useState([]),[error,setError]=useState('');
      async function refresh(){const [work,review]=await Promise.all([workspaceClient.list(),approvalClient.list()]);setWorkspaces(work.workspaces);setActiveId(work.activeId||sourceId);setApprovals(review.approvals);}
      async function decide(id,approve){setError('');try{let receipt=await approvalClient.decide(id,approve);for(let index=0;receipt.operationId&&['accepted','running'].includes(receipt.status)&&index<200;index++){await new Promise(resolve=>setTimeout(resolve,30));receipt=await approvalClient.operation(receipt.operationId);}window.lastDecision=receipt;await refresh();}catch(error){setError(error.message);window.lastDecision={status:'fixture-error',message:error.message};}}
      useEffect(()=>{void refresh().catch(error=>setError(error.message));},[]);
      window.fixture={approvals,refresh,sourceId};
      return <><GitWorkspace call={productToolsClient.call} workspaces={workspaces} activeWorkspaceId={activeId} onWorkspaceChanged={refresh}/><section id="existing-approvals" aria-label="既有 Owner 审批">{approvals.map(approval=><ApprovalCard key={approval.id} approval={approval} onDecide={decide}/>)}{error&&<p role="alert">{error}</p>}</section></>;
    }
    flushSync(()=>createRoot(document.getElementById('root')).render(<Harness/>));
    window.findButton=text=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===text);
    window.setControl=(selector,value)=>{const element=document.querySelector(selector);const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' } });
  const html = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0}#root{min-height:100vh}#existing-approvals{padding:24px}</style><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script>';
  server = http.createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 128 * 1024) throw new Error('Test bridge frame limit exceeded'); }
      const { method, params } = JSON.parse(body);
      if (!/^ui\.(?:workspace\.|approvals\.)/.test(method)) throw new Error('Test bridge only forwards Workspace and Owner approval UI methods');
      const record = { method, params }; calls.push(record);
      try { record.result = await ui.execute({ method, params }); } catch (error) { record.error = { code: error.code, message: error.message }; throw error; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(record.result));
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: error.code || 'FIXTURE', message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  assert.ok(fs.existsSync(edge), 'NOT_RUN_ENVIRONMENT: actual Chromium/Edge is required');
  const profile = path.join(sandbox.root, 'profile'); child = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort'); for (let index = 0; !fs.existsSync(portFile) && index < 100; index++) await delay(100); assert.ok(fs.existsSync(portFile));
  const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/); socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0; const pending = new Map();
  socket.on('message', bytes => { const message = JSON.parse(String(bytes)), entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); });
  const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  closeBrowser = () => rpc('Browser.close');
  const target = await rpc('Target.createTarget', { url: 'about:blank' }), { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await rpc('Runtime.enable', {}, sessionId); await rpc('Page.enable', {}, sessionId); await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sessionId);
  const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
  async function until(expression, label, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(40); } throw new Error('Timed out: ' + label + '\n' + await evaluate('document.body.innerText')); }
  const click = async text => { await until('!!window.findButton(' + JSON.stringify(text) + ')&&!window.findButton(' + JSON.stringify(text) + ').disabled', 'action available: ' + text); await evaluate('window.findButton(' + JSON.stringify(text) + ').click()'); await delay(40); };
  const input = async (selector, value) => { await evaluate('window.setControl(' + JSON.stringify(selector) + ',' + JSON.stringify(value) + ')'); await delay(40); };
  async function reviewRequest(capability) {
    await until('window.fixture.approvals.some(row=>row.capability===' + JSON.stringify(capability) + ')', capability + ' becomes pending');
    const row = capabilityService.broker.approvals.list().find(item => item.request.capability === capability); assert.ok(row);
    assert.deepEqual(row.request.actor, { kind: 'owner', id: 'desktop' }); assert.equal(row.request.taskId, selectedTask.id); assert.equal(row.request.workspaceId, workspace.id); assert.equal(Object.hasOwn(row.request.input, 'taskId'), false, 'Task is server-bound outside the tool input schema');
    return row;
  }
  async function approve(row) {
    await evaluate('window.lastDecision=null'); await click('批准一次');
    await until('window.lastDecision && !["accepted","running"].includes(window.lastDecision.status)', 'existing Owner decision settles');
    assert.equal(await evaluate('window.lastDecision.status'), 'completed', JSON.stringify(await evaluate('window.lastDecision')));
    assert.equal(capabilityService.broker.approvals.get(row.id).status, 'consumed');
    await click('刷新'); await until('!document.body.innerText.includes("正在读取 Git 状态")', 'Git refresh after approval');
  }
  async function selectTask() { await until('Array.from(document.querySelector("select[aria-label=\\"关联 Task\\"]")?.options||[]).some(option=>option.value===' + JSON.stringify(selectedTask.id) + ')', 'real Tasks loaded'); await input('select[aria-label="关联 Task"]', selectedTask.id); }
  await until('!!document.querySelector("input[aria-label=\\"新分支名称\\"]")', 'production GitWorkspace mount'); await selectTask();
  await click('Diff'); await until('document.querySelector(".git-diff")?.textContent.includes("approved UI change")', 'real working tree diff');
  await input('input[aria-label="新分支名称"]', 'codex/ui-branch'); await click('创建分支'); await click('确认创建');
  const branchApproval = await reviewRequest('git.branch.create');
  assert.equal(git(project, 'branch', '--list', 'codex/ui-branch'), ''); assert.equal(git(project, 'status', '--porcelain'), initialStatus); assert.equal(git(project, 'rev-parse', 'HEAD'), baseline);
  await approve(branchApproval); assert.equal(git(project, 'rev-parse', 'refs/heads/codex/ui-branch'), baseline); await click('分支 2'); await until('document.body.innerText.includes("codex/ui-branch")', 'approved branch visible');
  console.log('PASS production Task selection, real diff, pending branch without side effects, existing Owner approval and branch refresh');

  await selectTask(); await input('input[aria-label="新分支名称"]', 'codex/ui-worktree'); await click('创建 Worktree'); await click('确认创建');
  const worktreeApproval = await reviewRequest('git.worktree.create');
  assert.equal(fs.existsSync(path.join(stateDir, 'agent-worktrees')), false); assert.equal(git(project, 'branch', '--list', 'codex/ui-worktree'), '');
  await approve(worktreeApproval);
  const { workspaces } = await workspaceService.execute({ method: 'workspace.list' }); const managed = workspaces.find(item => item.id !== workspace.id); assert.ok(managed); assert.ok(path.relative(path.join(stateDir, 'agent-worktrees'), managed.root).split(path.sep).length === 1); assert.equal(git(managed.root, 'branch', '--show-current'), 'codex/ui-worktree'); assert.equal(fs.readFileSync(path.join(managed.root, 'a.txt'), 'utf8'), 'baseline a\n'); assert.equal(git(project, 'status', '--porcelain'), initialStatus);
  await click('Agent Worktree 2'); await until('document.body.innerText.includes("codex/ui-worktree")&&document.body.innerText.includes("Agent 隔离目录")', 'approved task Worktree visible');
  console.log('PASS pending Worktree creates no path/ref before approval and produces a real isolated registered Task worktree afterwards');

  await evaluate('Array.from(document.querySelectorAll("[role=tab]")).find(button=>button.textContent.startsWith("变更")).click()');
  await until('!!document.querySelector("input[aria-label=\\"提交 a.txt\\"]")', 'real file selection returns');
  await evaluate('document.querySelector("input[aria-label=\\"提交 a.txt\\"]").click()'); await input('#git-commit-message', 'approved exact Git UI commit'); await click('提交所选文件（1）');
  const commitApproval = await reviewRequest('git.commit'); assert.deepEqual(commitApproval.request.input.paths, ['a.txt']); assert.equal(commitApproval.request.input.expectedHead, baseline); assert.deepEqual(commitApproval.request.input.expectedHashes, { 'a.txt': crypto.createHash('sha256').update('approved UI change\n').digest('hex') });
  assert.equal(git(project, 'rev-parse', 'HEAD'), baseline); assert.equal(git(project, 'show', ':user.txt'), initialIndex); assert.equal(git(project, 'status', '--porcelain'), initialStatus);
  await approve(commitApproval); const committed = git(project, 'rev-parse', 'HEAD'); assert.notEqual(committed, baseline); assert.equal(git(project, 'diff-tree', '--no-commit-id', '--name-only', '-r', committed), 'a.txt'); assert.equal(git(project, 'show', ':user.txt'), initialIndex); assert.equal(fs.readFileSync(path.join(project, 'user.txt'), 'utf8'), 'unrelated user unstaged\n'); assert.equal(fs.readFileSync(path.join(project, 'loose.txt'), 'utf8'), 'unrelated loose file\n'); assert.equal(git(project, 'diff', '--cached', '--name-only'), 'user.txt');
  await click('提交记录'); await until('document.querySelector(".git-panel")?.innerText.includes("approved exact Git UI commit")', 'approved commit history refreshed');
  console.log('PASS selected-path/hash/HEAD commit remains inert while pending, then preserves unrelated staged/unstaged/untracked data and refreshes history');

  const staleTask = taskService.runtime.create({ goal: 'Task removed after UI snapshot', workspaceId: workspace.id });
  await click('刷新'); await until('Array.from(document.querySelectorAll("select option")).some(option=>option.value===' + JSON.stringify(staleTask.id) + ')', 'real Task appears before concurrent removal');
  await input('select[aria-label="关联 Task"]', staleTask.id); await input('input[aria-label="新分支名称"]', 'codex/stale-task-must-not-execute');
  taskService.runtime.remove({ id: staleTask.id, expectedRev: staleTask.rev });
  const priorFailureCalls = calls.length; await click('创建分支'); await click('确认创建');
  for (let index = 0; !calls.slice(priorFailureCalls).some(row => row.method === 'ui.workspace.git.branch.create' && row.error) && index < 100; index++) await delay(30);
  const failedRequest = calls.slice(priorFailureCalls).find(row => row.method === 'ui.workspace.git.branch.create' && row.error); assert.ok(failedRequest); assert.equal(failedRequest.error.code, 'TASK_NOT_AUTHORIZED');
  await delay(200); assert.equal(await evaluate('document.querySelector(".git-notice.error")?.textContent'), failedRequest.error.message, 'actual Core failure must remain visible after the request settles');
  assert.equal(git(project, 'branch', '--list', 'codex/stale-task-must-not-execute'), ''); assert.equal(capabilityService.broker.approvals.list().length, 0);
  console.log('PASS actual stale Task rejection remains visible in Git UI and cannot create a branch or approval');
  git(project, 'commit', '-qm', 'fixture staged baseline'); git(project, 'checkout', '-qb', 'fixture-conflict'); fs.writeFileSync(path.join(project, 'a.txt'), 'branch conflict\n'); git(project, 'commit', '-qam', 'branch conflict'); git(project, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(project, 'a.txt'), 'main conflict\n'); git(project, 'commit', '-qam', 'main conflict'); assert.throws(() => git(project, 'merge', 'fixture-conflict'));
  const conflicted = fs.readFileSync(path.join(project, 'a.txt'), 'utf8'); await click('刷新'); await until('document.body.innerText.includes("需要在项目中处理后刷新")', 'real conflict summary visible'); await evaluate('Array.from(document.querySelectorAll("[role=tab]")).find(button=>button.textContent.startsWith("变更")).click()');
  await until('document.body.innerText.includes("文件包含未解决的 Git 冲突")', 'actual conflict file visible'); assert.equal(await evaluate('document.querySelector("input[aria-label=\\"提交 a.txt\\"]").disabled'), true); assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), conflicted);
  assert.equal(calls.filter(row => row.method === 'ui.approvals.decide').length, 3); assert.ok(calls.filter(row => /^ui\.workspace\.git\.(?:commit|branch\.create|worktree\.create)$/.test(row.method)).every(row => !Object.hasOwn(row.params, 'actor') && !Object.hasOwn(row.params, 'approved')), 'renderer never supplies identity or approval authority');
  console.log('PASS real merge conflict visibility disables commit and preserves conflict bytes; renderer identity and authority are not forged');
  await closeBrowser(); await delay(750); failed = false; console.log('Git Workspace Chromium: PASS (actual Git, Core Broker and Owner approval UI; native host acceptance separate)');
} catch (error) { console.error(JSON.stringify(calls.slice(-15).map(row=>({method:row.method,params:row.params,status:row.result?.status,error:row.error})))); console.error(error.stack); throw error; } finally {
  if (closeBrowser && socket?.readyState === WebSocket.OPEN) { try { await closeBrowser(); } catch {} await delay(1000); }
  if (socket?.readyState === WebSocket.OPEN) socket.terminate();
  if (child?.pid && child.exitCode === null && child.signalCode === null) { await terminateSuiteProcessTree(child); await delay(250); }
  if (server) await new Promise(resolve => server.close(resolve)); await capabilityService?.close();
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
