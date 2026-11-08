// Production React picker + real owned Skill/Settings paths, exercised in Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createPluginCatalogFixture } from './test-support/plugin-catalog-fixture.mjs';

const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui'), require = createRequire(path.join(uiRoot, 'package.json'));
assert.ok(fs.existsSync(path.join(uiRoot, 'src/app/SkillPicker.tsx')), 'production shared SkillPicker exists');
const sandbox = createSuiteSandbox({ suiteId: 'skill-picker-ui' });
let failed = true, vite, browser, socket, server, closeBrowser, services, catalogFixture, modelServer;
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
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = (id, version = '1.0.0', content = true) => ({ manifestVersion: 1, id, name: id, publisher: 'Owned fixture', version,
    type: 'workflow', entry: content ? 'SKILL.md' : 'index.js', ...(content ? { contentProfile: 'skill-reference-v1' } : {}),
    minCetaMeshVersion: '1.0.0-rc.2', permissions: content ? ['skill.read'] : [],
    capabilities: [{ id: 'reference', kind: content ? 'skill-reference' : 'workflow', requires: content ? ['skill.read'] : [] }] });
  const packages = new Map(), catalogRows = [];
  for (const [id, isContent] of [['owned-reference', true], ['owned-executable', false], ['owned-changing', true], ['owned-failure', true], ['owned-stale-chat', true], ['owned-enable-race', true]]) {
    const raw = manifest(id, '1.0.0', isContent);
    const bytes = zipSync({ 'extension.json': strToU8(JSON.stringify(raw)), [raw.entry]: strToU8(isContent
      ? `---\nname: ${id}\ndescription: Owned reviewed content\n---\nINSTALLED_SKILL_WIRE_${id}` : 'throw Error("must never execute");') });
    packages.set('/packages/' + id + '.zip', bytes);
    catalogRows.push({ id, name: id, summary: 'Skill reference candidate (catalog hint)', description: 'Owned fixture', publisher: 'Owned fixture',
      version: '1.0.0', category: 'Workflow', manifestUrl: 'https://plugins.example.test/manifests/' + id + '.json',
      packageUrl: 'https://plugins.example.test/packages/' + id + '.zip', packageBytes: bytes.byteLength, packageSha256: digest(bytes),
      permissions: raw.permissions, capabilities: ['reference'], minCetaMeshVersion: '1.0.0-rc.2' });
  }
  const bytesV2 = zipSync({ 'extension.json': strToU8(JSON.stringify(manifest('owned-reference', '1.1.0'))),
    'SKILL.md': strToU8('---\nname: owned-reference\ndescription: Owned version two\n---\nINSTALLED_SKILL_VERSION_TWO') });
  packages.set('/packages/owned-reference-v2.zip', bytesV2);
  let catalogUnavailable = false;
  catalogFixture = await createPluginCatalogFixture({ getCatalog: () => {
    if (catalogUnavailable) throw Error('Owned offline fixture');
    return { schemaVersion: 1, generatedAt: '2026-11-08T00:00:00Z', plugins: catalogRows };
  }, packages });
  const modelCalls = [];
  modelServer = http.createServer(async (request, response) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    if (request.url !== '/v1/chat/completions') { response.statusCode = 404; return response.end('{}'); }
    const wire = JSON.parse(bytes); modelCalls.push(wire);
    if (wire.stream) {
      response.setHeader('content-type', 'text/event-stream');
      return response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Reviewed reference observed.' }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    }
    response.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: 'Reviewed reference observed.' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  services = createCetaMeshServices({ stateDir, dataRoot: path.join(sandbox.root, 'data'), deferOptionalStart: true,
    pluginCatalogUrl: catalogFixture.catalogUrl, pluginCatalogAllowedHosts: catalogFixture.allowedHosts,
    pluginCenterFetchImpl: (input, init) => { const url = new URL(input); assert.equal(url.origin, 'https://plugins.example.test');
      return fetch(catalogFixture.loopbackOrigin + url.pathname, init); } });
  const ui = (method, params = {}) => services.desktopUiService.execute({ method, params });
  const settings = services.settingsService, workspaceService = services.workspaceService;
  const workspace = (await workspaceService.execute({ method: 'workspace.create', params: { root: project, name: 'Owned picker project' } })).workspace;
  const userSources = () => settings.store.get().settings.extensions.skillSources;
  const chat = await ui('ui.chat.sessions.create', { title: 'Owned picker Chat' });
  const otherChat = await ui('ui.chat.sessions.create', { title: 'Other picker Chat' });
  await ui('ui.models.configuration.commit', { expectedRevision: (await ui('ui.models.configuration.get')).revision,
    connection: { id: 'picker-fixture', label: 'Owned peer', protocolProfile: 'openai-compatible-v1', enabled: true,
      models: [{ id: 'fixture', enabled: true, manualCapabilities: { tools: false, streaming: true, reasoning: false } }] },
    candidate: { apiKey: 'OWNED_PICKER_FIXTURE', baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/v1' } });
  for (const row of [chat, otherChat]) await ui('ui.chat.config.set', { id: row.id,
    config: { agentProvider: 'none', workspaceId: workspace.id, modelProvider: 'picker-fixture', model: 'fixture' } });
  const requests = [];
  let pauseInstall = false, releaseInstall, pausedInstall, pauseStage = false, releaseStage, pausedStage;
  const { build } = require('esbuild');
  const bundle = await build({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{SkillPicker,SkillSourceSettings}from'./src/app/SkillPicker';
    const rpc=async(method,params={})=>{const data=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})}).then(r=>r.json());if(data.error)throw Object.assign(Error('Request refused'),data.error);return data.result;};
    const client={listSkills:p=>rpc('list',p),readSkill:p=>rpc('read',p),listSkillSources:()=>rpc('sources'),registerSkillSource:p=>rpc('register',p),setSkillSourceEnabled:p=>rpc('setEnabled',p),removeSkillSource:p=>rpc('remove',p),
      installer:{catalog:()=>rpc('catalog'),stage:id=>rpc('stage',{id}),install:stageId=>rpc('install',{stageId,reviewed:true}),enable:(id,expectedSkillPackage)=>rpc('enable',{id,expectedSkillPackage,reviewed:true})}};
    const legacyClient={listSkills:client.listSkills,readSkill:client.readSkill};
    function App(){const[refs,setRefs]=useState([]),[entry,setEntry]=useState('add'),[chatId,setChat]=useState(${JSON.stringify(chat.id)}),[open,setOpen]=useState(true),[legacy,setLegacy]=useState(false);window.refs=refs;window.chatId=chatId;return <><button onClick={()=>setEntry('add')}>Add entry</button><button onClick={()=>setEntry('slash')}>Slash entry</button><button onClick={()=>{setChat(${JSON.stringify(otherChat.id)});setRefs([])}}>Other Chat</button><button onClick={()=>setChat(${JSON.stringify(chat.id)} )}>Original Chat</button><button onClick={()=>setOpen(true)}>Reopen picker</button><button onClick={()=>setLegacy(value=>!value)}>Toggle legacy</button>{open&&<SkillPicker key={entry} client={legacy?legacyClient:client} chatId={chatId} entryPoint={entry} selectedRefs={refs} onChange={setRefs} onClose={()=>setOpen(false)}/>}<SkillSourceSettings client={client}/></>};
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
      if (packet.method === 'list' || packet.method === 'read') result = await ui('ui.skills.' + packet.method, packet.params);
      else if (['catalog', 'stage', 'install', 'enable'].includes(packet.method)) {
        result = await ui('ui.plugins.' + packet.method, packet.params);
        if (packet.method === 'install' && pauseInstall) {
          pausedInstall = result;
          await new Promise(resolve => { releaseInstall = resolve; });
        }
        if (packet.method === 'stage' && pauseStage) { pausedStage = result; await new Promise(resolve => { releaseStage = resolve; }); }
      }
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
    assert.equal(catalogFixture.requests.some(row => row.path.startsWith('/packages/')), false, 'opening picker never downloads a package');
    await click('浏览可安装参考');
    await until('document.body.innerText.includes("owned-reference")', 'actual catalog candidates');
    assert.equal(catalogFixture.requests.some(row => row.path.startsWith('/packages/')), false, 'catalog browsing never downloads packages');
    const grantFile = path.join(stateDir, 'capability/task-grants.json'), approvalsFile = path.join(stateDir, 'capability/approvals.json');
    const bytesOrAbsent = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const grantsBefore = bytesOrAbsent(grantFile), approvalsBefore = bytesOrAbsent(approvalsFile);
    await evaluate(`document.querySelector('input[aria-label="选择 Skill alpha"]').click()`);
    await until('window.refs.length===1', 'existing reference retained across installer cancellation/failure');
    const initialRefs = await evaluate('window.refs');
    await click('查看实际包 owned-reference');
    await until('!!document.querySelector("[aria-label=\\"Skill 安装审查\\"]")', 'actual strict content review');
    assert.ok(await evaluate('document.body.innerText.includes("skill-reference-v1")&&document.body.innerText.includes("skill.read")'), 'actual content profile and scope visible');
    assert.match(await evaluate('document.querySelector(".skill-install-review code").textContent'), /^[a-f0-9]{64}$/, 'actual reviewed package fingerprint visible');
    await click('取消安装参考');
    assert.deepEqual(await evaluate('window.refs'), initialRefs);
    assert.equal(services.extensionService.runtime.list().extensions?.length ?? services.extensionService.runtime.list().length, 0, 'cancel does not install or enable');
    await click('查看实际包 owned-executable');
    await until('document.body.innerText.includes("不是可安装的严格 Skill 内容包")', 'catalog Skill hint cannot authorize executable installation');
    assert.equal(await evaluate('!!window.button("同意安装、启用并选择此版本")'), false);
    assert.deepEqual(await evaluate('window.refs'), initialRefs);
    pauseStage = true; await click('查看实际包 owned-reference');
    for (let i = 0; !pausedStage && i < 100; i++) await delay(20);
    assert.ok(pausedStage?.contentReview);
    await click('关闭 Skill'); releaseStage(); pauseStage = false; await delay(100);
    assert.equal(await evaluate('!!document.querySelector("[data-skill-picker]")'), false, 'closing really unmounts picker');
    await click('Reopen picker'); await until('!!window.button("浏览可安装参考")', 'reopened picker');
    assert.equal(await evaluate('!!window.button("同意安装、启用并选择此版本")'), false, 'late stage never opens review on replacement mount');
    assert.deepEqual(await evaluate('window.refs'), initialRefs);
    await click('浏览可安装参考');
    // A real changed catalog trust row invalidates the original staged review.
    await click('查看实际包 owned-changing');
    await until('!!window.button("同意安装、启用并选择此版本")', 'changed-catalog review staged');
    catalogRows.find(row => row.id === 'owned-changing').packageSha256 = '0'.repeat(64);
    await ui('ui.plugins.refresh');
    await click('同意安装、启用并选择此版本');
    await until('document.body.innerText.includes("安装、启用或来源核验未完成")', 'changed trust refuses install');
    assert.deepEqual(await evaluate('window.refs'), initialRefs);
    // A different manifest in a digest-matching archive is still refused by Core.
    const failure = catalogRows.find(row => row.id === 'owned-failure');
    failure.name = 'Catalog identity mismatch'; await ui('ui.plugins.refresh'); await click('浏览可安装参考');
    await click('查看实际包 Catalog identity mismatch');
    await until('document.body.innerText.includes("包下载或审查未完成")', 'actual manifest mismatch refuses review');
    assert.deepEqual(await evaluate('window.refs'), initialRefs);
    // A content-only review may never enable a replacement package. Replace
    // the disabled installation while its response is delayed, using a second
    // explicitly reviewed, controlled content package and the real Runtime.
    await click('查看实际包 owned-enable-race'); await until('!!window.button("同意安装、启用并选择此版本")', 'enable identity review');
    pauseInstall = true; pausedInstall = null;
    await click('同意安装、启用并选择此版本');
    for (let i = 0; !pausedInstall && i < 100; i++) await delay(20);
    assert.ok(pausedInstall?.installed);
    const raceSource = path.join(sandbox.root, 'reviewed-replacement');
    write(path.join(raceSource, 'extension.json'), JSON.stringify(manifest('owned-enable-race', '1.1.0')));
    write(path.join(raceSource, 'SKILL.md'), '---\nname: owned-enable-race\ndescription: Replacement reference\n---\nREPLACEMENT_NOT_AUTHORIZED_BY_FIRST_REVIEW');
    const replacementReview = services.extensionService.runtime.review({ sourceDir: raceSource });
    await services.extensionService.runtime.update({ sourceDir: raceSource, approval: { approved: true, token: replacementReview.review.token } });
    releaseInstall(); pauseInstall = false;
    await until('!window.button("浏览可安装参考").disabled', 'replacement enable attempt settled');
    assert.equal(services.extensionService.runtime.get({ id: 'owned-enable-race' }).availability.enabled, false, 'old content review must not enable a different reviewed package');
    assert.deepEqual(await evaluate('window.refs'), initialRefs, 'replacement never becomes an implicit selection');
    await click('查看实际包 owned-reference'); await until('!!window.button("同意安装、启用并选择此版本")', 'review selected content');
    const reviewedFingerprint = await evaluate('document.querySelector(".skill-install-review code").textContent');
    await click('同意安装、启用并选择此版本');
    await until('document.body.innerText.includes("来源已就绪 · 已选择受审版本")', 'actual install enable discover exact select');
    const installedRef = await evaluate('window.refs[1]');
    const actualIndex = await ui('ui.skills.list', { chatId: chat.id });
    const actualEntry = actualIndex.entries.find(row => row.sourceId === 'extension:owned-reference');
    assert.equal(actualEntry.packageRevision, reviewedFingerprint);
    assert.equal(installedRef.skillId, actualEntry.skillId); assert.equal(installedRef.sourceRevision, actualEntry.sourceRevision);
    assert.equal(services.extensionService.runtime.get({ id: 'owned-reference' }).availability.loaded, true);
    await ui('ui.chat.send', { id: chat.id, text: 'Read the explicitly selected content reference.', skillRefs: [installedRef], clientMessageId: 'picker-install-wire-1' });
    for (let i = 0; i < 200; i++) {
      const status = await ui('ui.chat.status', { id: chat.id });
      if (!['starting', 'running', 'streaming', 'thinking', 'waiting'].includes(status.state)) { assert.equal(status.error, null); break; }
      await delay(20);
    }
    assert.equal(modelCalls.length, 1, 'real next authorized Chat makes one local model request');
    assert.match(JSON.stringify(modelCalls[0].messages), /INSTALLED_SKILL_WIRE_owned-reference/);
    assert.match(JSON.stringify(modelCalls[0].messages), /untrusted/);
    assert.equal(bytesOrAbsent(grantFile), grantsBefore, 'reference install and model use do not change Task grants');
    assert.equal(bytesOrAbsent(approvalsFile), approvalsBefore, 'reference shortcut does not change approval policy or Task approvals');
    // An install already accepted by Core may finish; a switched Chat must not
    // receive that reference, nor initiate a new enable request afterward.
    await click('查看实际包 owned-stale-chat'); await until('!!window.button("同意安装、启用并选择此版本")', 'stale Chat review');
    pauseInstall = true; pausedInstall = null;
    await click('同意安装、启用并选择此版本');
    for (let i = 0; !pausedInstall && i < 100; i++) await delay(20);
    assert.ok(pausedInstall?.installed, 'Core installation actually finished before response delay');
    const enablesBefore = requests.filter(row => row === 'enable').length;
    await click('Other Chat'); releaseInstall(); pauseInstall = false;
    await until('window.chatId===' + JSON.stringify(otherChat.id), 'Chat switched'); await delay(150);
    assert.deepEqual(await evaluate('window.refs'), []);
    assert.equal(requests.filter(row => row === 'enable').length, enablesBefore, 'stale continuation issues no new enable');
    assert.equal(services.extensionService.runtime.get({ id: 'owned-stale-chat' }).availability.enabled, false, 'already installed package truthfully remains disabled');
    await click('Original Chat');
    await until(`!!document.querySelector('input[aria-label="选择 Skill owned-reference"]')`, 'return to original Chat');
    await evaluate(`document.querySelector('input[aria-label="选择 Skill owned-reference"]').click()`);
    await until('window.refs.length===1', 'explicit installed selection');
    await ui('ui.plugins.disable', { id: 'owned-reference' }); await click('刷新 Skill');
    await until('document.body.innerText.includes("来源不可用")', 'disabled installed source invalidates reference');
    await assert.rejects(ui('ui.skills.read', { chatId: chat.id, ...installedRef }), { code: 'SKILL_SOURCE_UNAVAILABLE' });
    await ui('ui.plugins.enable', { id: 'owned-reference', reviewed: true }); await click('刷新 Skill');
    await until('document.body.innerText.includes("来源已变化")', 'reenable creates different source generation');
    assert.equal((await evaluate('window.refs[0]')).sourceRevision, installedRef.sourceRevision, 'refresh never silently substitutes a generation');
    const versionRow = catalogRows.find(row => row.id === 'owned-reference');
    Object.assign(versionRow, { version: '1.1.0', packageUrl: 'https://plugins.example.test/packages/owned-reference-v2.zip',
      packageSha256: digest(bytesV2), packageBytes: bytesV2.byteLength });
    await ui('ui.plugins.refresh');
    const stagedV2 = await ui('ui.plugins.stage', { id: 'owned-reference' });
    await ui('ui.plugins.install', { stageId: stagedV2.stageId, reviewed: true });
    await ui('ui.plugins.enable', { id: 'owned-reference', reviewed: true });
    await click('刷新 Skill'); await until('document.body.innerText.includes("v1.1.0")', 'actual version two discovered');
    assert.equal((await evaluate('window.refs[0]')).sourceRevision, installedRef.sourceRevision, 'version update retains explicit old selection');
    await assert.rejects(ui('ui.skills.read', { chatId: chat.id, ...installedRef }), { code: 'SKILL_SOURCE_STALE' });
    await click('重新选择 owned-reference');
    const versionTwoRef = await evaluate('window.refs[0]');
    const versionTwoEntry = (await ui('ui.skills.list', { chatId: chat.id })).entries.find(row => row.sourceId === 'extension:owned-reference');
    assert.equal(versionTwoEntry.packageRevision, stagedV2.contentReview.packageRevision);
    assert.equal(versionTwoEntry.packageVersion, '1.1.0'); assert.equal(versionTwoRef.sourceRevision, versionTwoEntry.sourceRevision);
    versionRow.blockedVersions = ['1.1.0']; await ui('ui.plugins.refresh'); await click('刷新 Skill');
    await until('document.body.innerText.includes("来源不可用")', 'actual catalog revocation withdraws source');
    await assert.rejects(ui('ui.skills.read', { chatId: chat.id, ...versionTwoRef }), { code: 'SKILL_SOURCE_UNAVAILABLE' });
    await assert.rejects(ui('ui.plugins.enable', { id: 'owned-reference', reviewed: true }), { code: 'PLUGIN_REVOKED' });
    await ui('ui.plugins.uninstall', { id: 'owned-reference' });
    await assert.rejects(ui('ui.skills.read', { chatId: chat.id, ...versionTwoRef }), { code: 'SKILL_SOURCE_UNAVAILABLE' });
    await click('移除引用');
    catalogUnavailable = true; await ui('ui.plugins.refresh'); await click('浏览可安装参考');
    await until('document.body.innerText.includes("插件目录离线")', 'actual cached offline catalog is explicit');
    assert.ok(await evaluate('!!document.querySelector(\'input[aria-label="选择 Skill alpha"]\')'), 'local source remains usable offline');
    await click('Toggle legacy'); await until('!window.button("浏览可安装参考")', 'legacy client has no installer');
    assert.ok(await evaluate('!!document.querySelector(\'input[aria-label="选择 Skill alpha"]\')'), 'legacy local reference discovery remains usable');
    await click('Toggle legacy');
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
    console.log('PASS production SkillPicker + SkillSourceSettings: real composed Core/Chromium/reviewed zip/local model wire; explicit catalog/download/review/cancel/install/enable/exact package+source selection; executable/cross-manifest/catalog-change refusals; switched Chat blocks new enable/select; disabled/reenabled source invalidation; grants unchanged; shared add/slash, real Settings and narrow layout');
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
  if (services) {
    for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[name].close();
    await services.pluginCenterService.close();
  }
  await catalogFixture?.close();
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); }
  finalizeSuiteSandbox({ sandbox, failed });
}
