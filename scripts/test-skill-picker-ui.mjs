// Production React picker + real owned Skill/Settings paths, exercised in Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
import { createSettingsService } from '../src/settings/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createSkillContentService } from '../src/context/skills.js';
import { createSkillSourceAuthorizer } from '../src/context/skill-source-authorization.js';

const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui'), require = createRequire(path.join(uiRoot, 'package.json'));
assert.ok(fs.existsSync(path.join(uiRoot, 'src/app/SkillPicker.tsx')), 'production shared SkillPicker exists');
const sandbox = createSuiteSandbox({ suiteId: 'skill-picker-ui' });
let failed = true, vite, browser, socket, server, closeBrowser;
try {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const { SkillPicker, SkillSourceSettings } = await vite.ssrLoadModule('/src/app/SkillPicker.tsx');
  const html = renderToStaticMarkup(React.createElement(SkillPicker, { chatId: 'owned-chat', client: {}, selectedRefs: [], onChange() {} }));
  assert.match(html, /低信任参考文本/); assert.match(html, /不授予工具或审批权限/);
  assert.match(renderToStaticMarkup(React.createElement(SkillSourceSettings, { client: {} })), /不会复制或删除/);
  await vite.close(); vite = null;
  const stateDir = path.join(sandbox.root, 'state'), project = path.join(sandbox.root, 'project'), library = path.join(sandbox.root, 'library');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const alpha = path.join(project, '.cetamesh/skills/alpha/SKILL.md');
  write(alpha, '---\nname: alpha\ndescription: Owned alpha reference\n---\n' + 'ALPHA_REFERENCE '.repeat(700));
  write(path.join(project, '.cetamesh/skills/omitted/SKILL.md'), '---\nname: omitted\n---\nNo description.');
  write(path.join(library, 'beta/SKILL.md'), '---\nname: beta\ndescription: Owned beta reference\n---\nBETA_REFERENCE');
  const settings = createSettingsService({ stateDir }), workspaceService = createWorkspaceService({ stateDir });
  const workspace = (await workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Owned picker project' } })).workspace;
  const capabilityService = createCapabilityService({ stateDir, workspaceService });
  const userSources = () => settings.store.get().settings.extensions.skillSources;
  const authority = createSkillSourceAuthorizer({ capabilityService, workspaceService, userSources });
  const skills = createSkillContentService({ workspaceService, userSources, authorizeSource: authority.authorizeSource });
  const requests = [];
  const { build } = require('esbuild');
  const bundle = await build({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{SkillPicker,SkillSourceSettings}from'./src/app/SkillPicker';
    const rpc=async(method,params={})=>{const data=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})}).then(r=>r.json());if(data.error)throw Object.assign(Error('Request refused'),data.error);return data.result;};
    const client={listSkills:p=>rpc('list',p),readSkill:p=>rpc('read',p),listSkillSources:()=>rpc('sources'),registerSkillSource:p=>rpc('register',p),setSkillSourceEnabled:p=>rpc('setEnabled',p),removeSkillSource:p=>rpc('remove',p)};
    function App(){const[refs,setRefs]=useState([]),[entry,setEntry]=useState('add');window.refs=refs;return <><button onClick={()=>setEntry('add')}>Add entry</button><button onClick={()=>setEntry('slash')}>Slash entry</button><SkillPicker key={entry} client={client} chatId="owned-chat" entryPoint={entry} selectedRefs={refs} onChange={setRefs}/><SkillSourceSettings client={client}/></>};
    createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
    window.button=text=>Array.from(document.querySelectorAll('button')).find(row=>row.textContent.trim()===text||row.getAttribute('aria-label')===text);
    window.input=(selector,value)=>{const element=document.querySelector(selector);if(!element)throw Error('Missing '+selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' } });
  const css = fs.readFileSync(path.join(uiRoot, 'src/app/skill-picker.css'), 'utf8');
  server = http.createServer(async (request, response) => {
    if (request.url !== '/rpc') { response.end('<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:12px;background:#f4f3ee;color:#242a25;font:14px sans-serif}' + css + '</style><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script>'); return; }
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const packet = JSON.parse(bytes); requests.push(packet.method);
    try {
      let result;
      if (packet.method === 'list' || packet.method === 'read') result = await skills[packet.method]({ ...packet.params, principal: authority.ownerPrincipal(), workspaceId: workspace.id });
      else if (packet.method !== 'sources') await settings.execute({ method: 'settings.skillSources.' + packet.method, params: packet.params, actor: { kind: 'owner', id: 'desktop' } });
      if (!result) { const current = settings.store.get(); result = { revision: current.revision, sources: current.settings.extensions.skillSources }; }
      response.end(JSON.stringify({ result }));
    } catch (error) { response.end(JSON.stringify({ error: { code: error.code || 'FIXTURE_REFUSED' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(edge)) { console.log('NOT_RUN_ENVIRONMENT Skill picker Chromium; production React SSR passed'); process.exitCode = 77; }
  else {
    const profile = path.join(sandbox.root, 'browser');
    browser = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await delay(100);
    assert.ok(fs.existsSync(portFile), 'owned Chromium starts');
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let seq = 0; const pending = new Map();
    socket.on('message', bytes => { const reply = JSON.parse(String(bytes)), row = pending.get(reply.id); if (!row) return; pending.delete(reply.id); clearTimeout(row.timer); reply.error ? row.reject(Error(reply.error.message)) : row.resolve(reply.result); });
    const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
    closeBrowser = () => rpc('Browser.close');
    const target = await rpc('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    const until = async (expression, label) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); } throw Error('Timed out: ' + label); };
    const click = async name => { await until('!!window.button(' + JSON.stringify(name) + ')&&!window.button(' + JSON.stringify(name) + ').disabled', name); await evaluate('window.button(' + JSON.stringify(name) + ').click()'); await delay(70); };
    const input = async (selector, value) => { await evaluate('window.input(' + JSON.stringify(selector) + ',' + JSON.stringify(value) + ')'); await delay(50); };
    await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sessionId);
    await until(`!!document.querySelector('input[aria-label="选择 Skill alpha"]')`, 'real project discovery');
    await evaluate("document.querySelector('.skill-omissions').open=true");
    assert.ok(await evaluate('document.body.innerText.includes("missing-description")'), 'omissions visible');
    await input('input[aria-label="搜索 Skill"]', 'missing');
    assert.equal(await evaluate('document.querySelectorAll("[data-skill-entry]").length'), 0);
    await input('input[aria-label="搜索 Skill"]', 'alpha');
    await evaluate(`document.querySelector('input[aria-label="选择 Skill alpha"]').click()`);
    await until('window.refs.length===1', 'exact selected identity');
    const selected = await evaluate('window.refs[0]'); assert.match(selected.sourceRevision, /^[a-f0-9]{64}$/);
    await click('预览 alpha'); await until('document.body.innerText.includes("ALPHA_REFERENCE")', 'actual body read');
    assert.ok(await evaluate('document.body.innerText.includes("已截断")'), 'page truncation visible');
    await click('Slash entry'); await until('document.querySelector("[data-skill-picker]").dataset.skillPicker==="slash"', 'same production picker mounted by slash');
    await until(`!!document.querySelector('input[aria-label="选择 Skill alpha"]')`, 'slash index');
    assert.equal(await evaluate(`document.querySelector('input[aria-label="选择 Skill alpha"]').checked`), true);
    write(alpha, '---\nname: alpha\ndescription: Changed owned alpha\n---\nCHANGED_ALPHA');
    await click('刷新 Skill'); await until('document.body.innerText.includes("来源已变化")', 'stale selected reference remains explicit');
    assert.equal((await evaluate('window.refs[0]')).sourceRevision, selected.sourceRevision, 'refresh never substitutes a current namesake');
    await input('input[aria-label="Skill 来源标识"]', 'owned-ui-library'); await input('input[aria-label="Skill 来源目录"]', library);
    await settings.execute({ method: 'settings.update', params: { section: 'general', values: { language: 'en-US' }, expectedRev: settings.store.get().revision } });
    await click('登记参考目录'); await until('document.body.innerText.includes("配置已变化")', 'real Settings CAS conflict');
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Skill 来源目录"]').value`), library, 'failed source mutation preserves the unsaved directory draft');
    await click('刷新参考来源'); await until('!document.querySelector("[role=alert]")', 'explicit source configuration recovery');
    await click('登记参考目录'); await until('document.body.innerText.includes("owned-ui-library")&&!!window.button("启用参考 owned-ui-library")', 'explicit disabled registration');
    assert.equal(userSources()[0].enabled, false);
    await click('启用参考 owned-ui-library'); await until('!!window.button("停用参考 owned-ui-library")', 'explicit source enablement');
    await click('刷新 Skill'); await until(`!!document.querySelector('input[aria-label="选择 Skill beta"]')`, 'registered enabled library in same index');
    await evaluate(`document.querySelector('input[aria-label="选择 Skill beta"]').click()`); await until('window.refs.length===2', 'multi selection across sources');
    await click('取消登记 owned-ui-library'); await until('!window.button("取消登记 owned-ui-library")', 'remove registration');
    assert.equal(fs.existsSync(path.join(library, 'beta/SKILL.md')), true);
    await click('刷新 Skill'); await until('document.body.innerText.includes("来源不可用")', 'removed source does not silently lose selection');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: false }, sessionId);
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'production picker/source settings fit narrow viewport');
    assert.ok(requests.includes('read') && requests.filter(row => row === 'list').length >= 4);
    console.log('PASS production SkillPicker + SkillSourceSettings: SSR/Chromium, shared add/slash index, exact multirefs, actual paged body, stale/removed recovery, explicit real Settings registration and narrow layout');
    await closeBrowser(); closeBrowser = null;
    // Wait for the owned root's actual exit before any forced tree cleanup.
    // A Browser.close acknowledgement alone is not a process exit event.
    for (let i = 0; browser.exitCode === null && browser.signalCode === null && i < 100; i++) await delay(50);
    failed = false;
  }
} finally {
  await vite?.close();
  if (closeBrowser && socket?.readyState === WebSocket.OPEN) { try { await closeBrowser(); } catch {} await delay(250); }
  if (socket?.readyState === WebSocket.OPEN) socket.terminate();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) await terminateSuiteProcessTree(browser);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  finalizeSuiteSandbox({ sandbox, failed });
}
