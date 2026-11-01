// Production Chat activity presentation: bounded receipts and real Chromium keyboard/layout checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { buildSync } = require('esbuild');
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const sandbox = createSuiteSandbox({ suiteId: 'chat-activity' });
let failed = true, browser, socket;
const tool = (status = 'running', changes = {}) => ({ id: 'raw-call-identity', label: 'test.run', status, durationMs: 1200, summary: 'Fixture receipt', ...changes });
try {
  const { ChatActivity, ToolActivity } = await vite.ssrLoadModule('/src/app/ChatActivity.tsx');
  const render = props => renderToStaticMarkup(React.createElement(ChatActivity, props));
  const primary = html => html.match(/<summary class="chat-activity-summary">(.*?)<\/summary>/s)?.[1] ?? '';
  const running = render({ tools: [tool()], state: 'running', taskId: 'raw-task-identity' });
  assert.match(primary(running), /正在运行测试/);
  assert.doesNotMatch(primary(running), /test\.run|raw-call-identity|raw-task-identity|Fixture receipt/);
  assert.doesNotMatch(running, /<details[^>]*\bopen(?:=|>)/, 'one compact card is collapsed by default');
  assert.match(primary(render({ tools: [tool('running', { label: 'filesystem.write', capability: 'filesystem.read' })] })), /正在读取文件/, 'exact capability wins over a display label');
  assert.match(primary(render({ tools: [tool('running', { label: 'read_everything_and_proclaim_success', summary: '已全部交付', reasoning: 'hidden-reasoning-fixture' })] })), /工具活动进行中/);
  for (const unknown of ['constructor', 'toString', '__proto__']) {
    assert.match(primary(render({ tools: [tool('running', { label: unknown })] })), /工具活动进行中/, 'prototype names cannot become a capability label');
    assert.match(primary(render({ tools: [tool(unknown)], state: unknown })), /状态待核验/, 'prototype names cannot become a known lifecycle state');
  }
  for (const [status, label] of [['pending', '等待处理'], ['running', '运行中'], ['retrying', '正在重试'], ['waiting-approval', '等待审批'], ['completed', '已结束'], ['failed', '失败'], ['cancelled', '已取消'], ['outcome-unknown', '结果待核验'], ['unknown', '状态待核验']]) {
    const html = render({ tools: [tool(status)] });
    assert.ok(primary(html).includes(label), status + ' remains distinct in the compact card');
  }
  const unknown = render({ tools: [tool('new-upstream-state')] });
  assert.match(primary(unknown), /状态待核验/); assert.doesNotMatch(primary(unknown), /已结束|已完成/);
  const completed = render({ tools: [tool('completed')], state: 'done', taskId: 'task-fixture' });
  assert.match(primary(completed), /工具调用已结束/); assert.doesNotMatch(primary(completed), /任务已完成|交付已核验/);
  assert.equal(render({ tools: [], state: 'idle' }), '', 'idle without any structured activity remains quiet');
  const many = Array.from({ length: 1000 }, (_, index) => tool(index < 500 ? 'running' : 'completed', { id: 'call-' + index, label: 'filesystem.read', summary: 'Receipt ' + index }));
  const rows = renderToStaticMarkup(React.createElement(ToolActivity, { tools: many }));
  assert.equal((rows.match(/class="tool-call /g) ?? []).length, 40, 'each of the two existing receipt groups renders at most20 rows');
  assert.match(rows, /下一组/); assert.match(rows, /已完成 500/);
  const detailed = renderToStaticMarkup(React.createElement(ToolActivity, { tools: [tool('failed', { summary: 'Exact failure receipt', filePath: 'src/fixture.ts', exitCode: 2, reasoning: 'hidden-reasoning-fixture' })] }));
  assert.match(detailed, /test\.run/); assert.match(detailed, /Exact failure receipt/); assert.match(detailed, /1\.2 秒/); assert.match(detailed, /src\/fixture.ts/); assert.match(detailed, /退出码 2/);
  assert.ok(detailed.indexOf('raw-call-identity') > detailed.indexOf('高级详情'), 'raw identity is confined to the advanced disclosure');
  assert.doesNotMatch(detailed, /hidden-reasoning-fixture/);
  console.log('PASS activity summaries use exact structured capabilities/statuses; unknown, receipt details and20-row groups remain truthful');
  await vite.close();

  const fixtureTools = many.map(item => ({ ...item, label: 'provider_tool_' + 'long_'.repeat(20), summary: 'Receipt ' + item.id + ' ' + 'long-receipt-'.repeat(60) }));
  const bundle = buildSync({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{ChatActivity}from'./src/app/ChatActivity';
    const fixtures=${JSON.stringify(fixtureTools)};window.openedTasks=[];
    function Harness(){const[tools,setTools]=useState(fixtures);window.updateActivity=next=>flushSync(()=>setTools(next));return <main><article className="chat-message"><div className="message-body"><ChatActivity tools={tools} taskId="task-fixture" agentActivity={{providerId:'codex',label:'Codex',status:'running'}} onOpenTask={id=>window.openedTasks.push(id)}/></div></article></main>;}
    flushSync(()=>createRoot(document.getElementById('root')).render(<Harness/>));
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' } });
  const styles = ['src/theme/tokens.css', 'src/theme/global.css', 'src/app/chat-activity.css', 'src/app/harbor.css'].map(file => fs.readFileSync(path.join(uiRoot, file), 'utf8')).join('\n');
  const file = path.join(sandbox.root, 'fixture.html');
  fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><style>' + styles + 'html,body{margin:0}main{padding:12px;max-width:760px;margin:auto}</style><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script>');
  const executable = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(executable)) throw Object.assign(new Error('Chromium/Edge required for activity keyboard/layout fixture; React assertions passed'), { code: 'NOT_RUN_ENVIRONMENT' });
  const profile = path.join(sandbox.root, 'profile');
  browser = spawn(executable, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let index = 0; index < 100 && !fs.existsSync(portFile); index++) await delay(100);
  assert.ok(fs.existsSync(portFile));
  const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0; const pending = new Map();
  socket.on('message', bytes => { const message = JSON.parse(String(bytes)), entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); });
  const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await rpc('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await rpc('Runtime.enable', {}, sessionId); await rpc('Page.enable', {}, sessionId);
  await rpc('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
  const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
  const until = async expression => { for (let index = 0; index < 100; index++) { if (await evaluate(expression)) return; await delay(40); } throw new Error('Activity fixture did not converge: ' + expression + '\n' + JSON.stringify(await evaluate('({html:document.querySelector("main").innerHTML.slice(0,1800),focused:document.activeElement.outerHTML.slice(0,300),count:document.querySelectorAll(".tool-call").length})'))); };
  await until('!!document.querySelector(".chat-activity-summary")');
  assert.equal(await evaluate('document.querySelectorAll(".tool-call").length'), 0, 'collapsed card does not mount1000 receipt rows');
  await evaluate('document.querySelector(".chat-activity-summary").focus()');
  const key = async (name, code) => { const virtualKey = name === 'Enter' ? 13 : 27; await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }, sessionId); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey }, sessionId); };
  await key('Enter', 'Enter'); await until('document.querySelectorAll(".tool-call").length===40');
  await evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="下一组").click()');
  await until('document.querySelector(".tool-call code").textContent==="call-20"');
  await evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="查看任务").click()');
  assert.deepEqual(await evaluate('window.openedTasks'), ['task-fixture']);
  for (const theme of ['light', 'dark']) for (const width of [320, 534, 1024]) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';document.documentElement.style.zoom="1.5"');
    await delay(30);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'), true, theme + ' at ' + width + 'px and150% zoom cannot overflow horizontally');
    assert.ok(await evaluate('document.querySelector(".chat-activity-copy").getBoundingClientRect().width>=80'), theme + ' at ' + width + 'px must retain readable text width rather than one-character vertical wrapping');
    assert.ok(await evaluate('document.querySelector(".chat-tool-name").getBoundingClientRect().width>=80'), theme + ' at ' + width + 'px must retain readable receipt tool names');
  }
  await evaluate('document.querySelector(".tool-call > summary").click();document.querySelector(".tool-call .tool-diagnostic > summary").click();document.querySelector(".tool-call .tool-diagnostic > summary").focus()');
  await key('Escape', 'Escape');
  assert.equal(await evaluate('document.querySelector(".tool-call .tool-diagnostic").open'), false);
  assert.equal(await evaluate('document.activeElement===document.querySelector(".tool-call .tool-diagnostic > summary")'), true, 'Escape restores advanced disclosure trigger focus');
  await key('Escape', 'Escape');
  assert.equal(await evaluate('document.querySelector(".tool-call").open'), false, 'a second Escape closes the containing receipt');
  await key('Escape', 'Escape'); await until('document.querySelectorAll(".tool-call").length===0');
  assert.equal(await evaluate('document.activeElement===document.querySelector(".chat-activity-summary")'), true, 'Escape restores compact card trigger focus');
  await evaluate('window.updateActivity([{id:"fresh",label:"filesystem.write",status:"waiting-approval",durationMs:null,summary:""}])');
  assert.match(await evaluate('document.querySelector(".chat-activity-summary").innerText'), /等待审批/);
  if (process.env.CETAMESH_TEST_CHAT_ACTIVITY_CAPTURE_DIR) {
    const directory = path.resolve(process.env.CETAMESH_TEST_CHAT_ACTIVITY_CAPTURE_DIR); fs.mkdirSync(directory, { recursive: true });
    for (const [name, width, theme, zoom, expanded] of [['collapsed-light', 1024, 'light', '1', false], ['expanded-dark-narrow', 320, 'dark', '1.5', true]]) {
      await rpc('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false }, sessionId);
      await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';document.documentElement.style.zoom=' + JSON.stringify(zoom) + ';document.querySelector(".chat-activity-card").open=' + expanded);
      await delay(100);
      const capture = await rpc('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(capture.data, 'base64'));
    }
  }
  await rpc('Browser.close');
  if (browser.exitCode === null && browser.signalCode === null) await new Promise(resolve => {
    const finished = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { browser.off('close', finished); resolve(); }, 5000);
    browser.once('close', finished);
  });
  failed = false;
  console.log('PASS actual activity card keyboard expansion,20-row paging, nested Escape/focus, live status and light/dark narrow150% layout');
} catch (error) {
  if (error.code !== 'NOT_RUN_ENVIRONMENT') throw error;
  failed = false; process.exitCode = 77; console.log('NOT_RUN_ENVIRONMENT: ' + error.message);
} finally {
  await vite.close();
  if (socket?.readyState === WebSocket.OPEN) socket.terminate();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) { await terminateSuiteProcessTree(browser); await delay(250); }
  finalizeSuiteSandbox({ sandbox, failed });
}
