// Production React -> typed Owner IPC -> real isolated Settings/Secrets and a
// synthetic loopback catalog. No account, paid request or production state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createSuiteSandbox, finalizeSuiteSandbox, registerSuiteSecret } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createSettingsStore } from '../src/settings/store.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { createModelConfiguration, createModelProviderRegistry, createOpenAiCompatibleModelProvider } from '../src/model/index.js';

const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
assert.ok(fs.existsSync(path.join(uiRoot, 'src/app/ModelConnectionForm.tsx')), 'production shared ModelConnectionForm exists');
assert.ok(fs.existsSync(path.join(uiRoot, 'src/app/ModelConnectionsPanel.tsx')), 'production model management remains reachable with all connections disabled');
const require = createRequire(path.join(uiRoot, 'package.json'));
const sandbox = createSuiteSandbox({ suiteId: 'model-connection-form-ui' });
let failed = true, child, socket, server, catalog, closeBrowser;
try {
  let catalogStatus = 200;
  catalog = http.createServer((request, response) => {
    assert.ok(request.url.endsWith('/models'), 'connection testing uses only the catalog endpoint');
    response.writeHead(catalogStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify(catalogStatus === 200 ? { data: Array.from({ length: 165 }, (_, index) => ({
      id: `catalog-${String(index).padStart(3, '0')}`, capabilities: { tools: true, reasoning: true }
    })) } : { error: 'SYNTHETIC_PRIVATE_CANDIDATE_MUST_NOT_ECHO' }));
  });
  await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${catalog.address().port}/v1`;
  const settingsStore = createSettingsStore({ stateDir: path.join(sandbox.root, 'state') });
  const secrets = createProviderSecrets({ root: sandbox.root });
  registerSuiteSecret({ sandbox, file: secrets.filePath });
  const registry = createModelProviderRegistry({ providers: [createOpenAiCompatibleModelProvider({
    id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', secrets
  })] });
  const configuration = createModelConfiguration({ settingsStore, secrets, registry });
  for (const id of ['fixture-a', 'fixture-b']) await configuration.testAndCommitConnection({ expectedRevision: configuration.get().revision,
    connection: { id, label: id === 'fixture-a' ? 'First saved connection' : 'Second saved connection', protocolProfile: 'openai-chat-v1', enabled: true, models: [] },
    candidate: { apiKey: 'SYNTHETIC_EXISTING_MODEL_SECRET', baseUrl } });
  await configuration.testAndCommitConnection({ expectedRevision: configuration.get().revision,
    connection: { id: 'fixture-compatible', label: 'Compatible parameter opt-in', protocolProfile: 'openai-compatible-v1', enabled: true, models: [{ id: 'catalog-000', enabled: true }] },
    candidate: { apiKey: 'SYNTHETIC_COMPATIBLE_MODEL_SECRET', baseUrl } });
  configuration.update({ expectedRevision: configuration.get().revision,
    connections: settingsStore.get().settings.models.connections.map(row => ({ ...row, enabled: false })),
    modelPreferences: Array.from({ length: 140 }, (_, index) => ({ connectionId: 'fixture-a', modelId: `catalog-${String(index).padStart(3, '0')}`, reasoningEffort: 'low' })) });
  const initial = configuration.get(), events = [], requests = [];
  const ui = createDesktopUiService({ services: { modelConfiguration: configuration }, emit: (event, data) => events.push({ event, data }) });
  const { build } = require('esbuild');
  const bundle = await build({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ModelConnectionsPanel} from './src/app/ModelConnectionsPanel';
    window.pendingModelCalls=0;
    window.ipc={postMessage(raw){const request=JSON.parse(raw);window.pendingModelCalls++;fetch('/fixture-rpc',{method:'POST',body:raw}).then(r=>r.json()).then(reply=>window.__cetameshReceive({id:request.id,...reply})).finally(()=>window.pendingModelCalls--);}};
    createRoot(document.getElementById('root')).render(<React.StrictMode><ModelConnectionsPanel/></React.StrictMode>);
    window.button=text=>Array.from(document.querySelectorAll('button')).find(row=>row.textContent.trim()===text||row.getAttribute('aria-label')===text);
    window.setControl=(selector,value)=>{const element=document.querySelector(selector);if(!element)throw Error('Missing '+selector);const proto=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' } });
  const css = ['src/theme/tokens.css', 'src/theme/global.css'].map(file => fs.readFileSync(path.join(uiRoot, file), 'utf8')).join('\n');
  server = http.createServer(async (request, response) => {
    if (request.url === '/fixture-rpc') {
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const packet = JSON.parse(bytes);
      // Test evidence records shape only for credential-bearing writes.
      requests.push({ method: packet.method, params: packet.method.endsWith('.commit') || packet.method.endsWith('.discover')
        ? { ...packet.params, ...(packet.params.candidate ? { candidate: Object.fromEntries(Object.keys(packet.params.candidate).map(key => [key, '[write-only]'])) } : {}) } : packet.params });
      response.setHeader('content-type', 'application/json');
      try { response.end(JSON.stringify({ ok: true, result: await ui.execute({ method: packet.method, params: packet.params }) })); }
      catch (error) { response.end(JSON.stringify({ ok: false, error: { code: error.code || 'FIXTURE_FAILED', message: 'Synthetic request failed; repair and retry.' } })); }
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><style>' + css + 'body{overflow:auto}#root{height:auto;min-height:100vh;padding:12px}</style><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(edge)) { console.log('NOT_RUN_ENVIRONMENT model connection UI: Chromium/Edge unavailable'); process.exitCode = 77; }
  else {
    const profile = path.join(sandbox.root, 'profile');
    child = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await delay(100);
    assert.ok(fs.existsSync(portFile), 'owned Chromium fixture starts');
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0; const pending = new Map();
    socket.on('message', bytes => { const reply = JSON.parse(String(bytes)), entry = pending.get(reply.id); if (!entry) return; pending.delete(reply.id); clearTimeout(entry.timer); reply.error ? entry.reject(Error(reply.error.message)) : entry.resolve(reply.result); });
    const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
    closeBrowser = () => rpc('Browser.close');
    const target = await rpc('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await rpc('Runtime.enable', {}, sessionId); await rpc('Page.enable', {}, sessionId);
    const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    async function until(expression, label) { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(40); } throw Error('Timed out: ' + label); }
    const click = async text => { await until('!!window.button(' + JSON.stringify(text) + ')&&!window.button(' + JSON.stringify(text) + ').disabled', text); await evaluate('window.button(' + JSON.stringify(text) + ').click()'); await delay(70); await until('window.pendingModelCalls===0', 'actual model IPC completion'); };
    const input = async (selector, value) => { await until('!!document.querySelector(' + JSON.stringify(selector) + ')&&!document.querySelector(' + JSON.stringify(selector) + ').disabled', 'editable ' + selector); await evaluate('window.setControl(' + JSON.stringify(selector) + ',' + JSON.stringify(value) + ')'); await delay(40); };
    await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sessionId);
    await until('document.body.innerText.includes("First saved connection")&&!!window.button("管理连接 fixture-a")', 'all-disabled model management');
    assert.ok(await evaluate('document.body.innerText.includes("尚无启用的模型")'), 'all-disabled state retains actionable management');
    await click('管理连接 fixture-b'); await until('!!window.button("启用连接 fixture-b")', 'independent second connection');
    await click('管理连接 fixture-a'); await click('启用连接 fixture-a');
    await click('启用模型 catalog-000');
    assert.equal(configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'catalog-000').enabled, true);
    assert.deepEqual(configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'catalog-164'), initial.connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'catalog-164'));
    assert.deepEqual(configuration.get().connections.find(row => row.id === 'fixture-b'), initial.connections.find(row => row.id === 'fixture-b'));
    await click('下一页模型'); await until('!!window.button("启用模型 catalog-050")', 'server model page');
    assert.ok(requests.some(row => row.method === 'ui.models.configuration.get' && row.params.connectionId === 'fixture-a' && row.params.modelOffset === 50));
    await input('input[aria-label="搜索本页模型"]', 'catalog-059'); await click('启用本页筛选模型');
    assert.equal(configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'catalog-059').enabled, true);
    assert.equal(configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'catalog-058').enabled, false, 'enable reviewed rows does not enable hidden or filtered models');
    await input('input[aria-label="搜索本页模型"]', ''); await click('上一页模型');
    await evaluate('document.querySelector("details[data-model-id=\\"catalog-000\\"]").open=true');
    await input('select[aria-label="catalog-000 手动工具调用"]', 'false');
    await click('保存能力 catalog-000'); await until('document.querySelector("details[data-model-id=\\"catalog-000\\"]").textContent.includes("手动声明")', 'honest manual capability source');
    const manual = configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'catalog-000');
    assert.equal(manual.manualCapabilities.tools, false); assert.equal(manual.capabilities.tools.source, 'manual');
    await input('select[aria-label="catalog-000 模型思考设置"]', 'high'); await click('保存思考设置 catalog-000');
    assert.equal(configuration.get().modelPreferences.find(row => row.connectionId === 'fixture-a' && row.modelId === 'catalog-000').reasoningEffort, 'high');
    assert.deepEqual(configuration.get().modelPreferences.filter(row => row.modelId !== 'catalog-000'), initial.modelPreferences.filter(row => row.modelId !== 'catalog-000'));
    await click('下一页模型'); await click('下一页模型');
    assert.equal(await evaluate('document.querySelector("select[aria-label=\\"catalog-130 模型思考设置\\"]").value'), '', 'unloaded preference is not presented as a known global default');
    await click('读取更多模型偏好');
    await until('document.querySelector("select[aria-label=\\"catalog-130 模型思考设置\\"]").value==="low"', 'later preference page updates the controlled row');
    await click('上一页模型'); await click('上一页模型');
    await click('设为默认模型 catalog-000'); await input('select[aria-label="全局思考强度"]', 'max'); await click('保存全局思考设置');
    assert.deepEqual(configuration.get().defaults, { provider: 'fixture-a', model: 'catalog-000', reasoningEffort: 'max' });
    await input('input[aria-label="手动模型 ID"]', 'organization/exact-manual'); await click('添加手动模型');
    assert.equal(configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'organization/exact-manual').enabled, false);
    await click('发现模型'); await until('document.body.innerText.includes("发现 165 个模型")', 'read-only discovery preview');
    await click('测试并保存发现结果');
    assert.equal(configuration.get().connections.find(row => row.id === 'fixture-a').models.find(row => row.id === 'organization/exact-manual').enabled, false, 'catalog refresh retains unseen manual models');
    await click('编辑连接'); await until('!!document.querySelector("input[aria-label=\\"模型 API Key\\"]")', 'shared existing connection form');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"模型 API Key\\"]").value'), '', 'saved secrets never round-trip');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"模型服务地址\\"]").value'), '', 'saved endpoints never round-trip');
    await input('input[aria-label="连接名称"]', 'Draft retained after failure');
    await input('input[aria-label="模型 API Key"]', 'SYNTHETIC_PRIVATE_CANDIDATE_MUST_NOT_ECHO');
    const beforeFailure = configuration.get(), keyBytes = fs.readFileSync(secrets.filePath, 'utf8'); catalogStatus = 401;
    await click('测试并保存连接'); await until('!!document.querySelector("[role=alert]")', 'candidate rejection');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"连接名称\\"]").value'), 'Draft retained after failure');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"模型 API Key\\"]").value'), '', 'failed completion clears uncontrolled secret');
    assert.deepEqual(configuration.get(), beforeFailure); assert.equal(fs.readFileSync(secrets.filePath, 'utf8'), keyBytes);
    assert.equal(await evaluate('document.body.innerText.includes("SYNTHETIC_PRIVATE")||location.href.includes("SYNTHETIC_PRIVATE")'), false);
    catalogStatus = 200; await click('测试并保存连接'); await until('document.body.innerText.includes("Draft retained after failure")&&!document.querySelector("input[aria-label=\\"模型 API Key\\"]")', 'explicit repair retry');
    const commit = requests.findLast(row => row.method === 'ui.models.configuration.commit');
    assert.equal(Object.hasOwn(commit.params.connection, 'models'), false, 'connection form never submits a clipped catalog');
    await click('添加模型连接'); await until('!!document.querySelector("input[aria-label=\\"模型 API Key\\"]")', 'shared new connection form');
    await input('input[aria-label="连接标识"]', 'fixture-added'); await input('input[aria-label="连接名称"]', 'Added connection');
    await input('input[aria-label="模型服务地址"]', baseUrl); await input('input[aria-label="模型 API Key"]', 'SYNTHETIC_NEW_MODEL_SECRET');
    await click('测试并保存连接'); await until('!!window.button("管理连接 fixture-added")', 'new connection saved');
    assert.ok(configuration.get().connections.find(row => row.id === 'fixture-added').models.every(row => row.enabled === false));
    // Actual settings race: stale renderer revision must fail without overwriting it.
    configuration.update({ expectedRevision: configuration.get().revision, defaults: { reasoningEffort: 'low' } });
    await click('启用模型 catalog-000'); await until('document.body.innerText.includes("配置已变化")', 'CAS race remains visible');
    assert.equal(configuration.get().connections.find(row => row.id === 'fixture-added').models[0].enabled, false);
    await click('刷新模型配置'); await until('!document.querySelector("[role=alert]")', 'refresh recovers stale revision');
    await click('管理连接 fixture-compatible');
    assert.equal(await evaluate('document.querySelector("select[aria-label=\\"catalog-000 模型思考设置\\"]").disabled'), true, 'a protocol declaration cannot bypass the compatible reasoning parameter opt-in');
    assert.equal(await evaluate('window.button("保存思考设置 catalog-000").disabled'), true);
    await input('select[aria-label="catalog-000 手动思考"]', 'true'); await click('保存能力 catalog-000');
    await until('!document.querySelector("select[aria-label=\\"catalog-000 模型思考设置\\"]").disabled', 'explicit per-model opt-in enables effective adapter levels');
    await input('select[aria-label="catalog-000 模型思考设置"]', 'high'); await click('保存思考设置 catalog-000');
    assert.equal(configuration.get().modelPreferences.find(row => row.connectionId === 'fixture-compatible' && row.modelId === 'catalog-000').reasoningEffort, 'high');
    assert.equal(settingsStore.get().settings.models.openaiCompatibleReasoningEffort, false, 'UI per-model opt-in leaves the global switch unchanged');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: false }, sessionId);
    await click('编辑连接');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'shared form stays within a narrow viewport');
    assert.equal(await evaluate('document.querySelector("details[data-model-connection-advanced]").open'), false, 'advanced fields start collapsed');
    assert.ok(requests.filter(row => /\.(?:edit|commit|update)$/.test(row.method)).every(row => Number.isSafeInteger(row.params.expectedRevision)), 'every mutation carries a revision CAS');
    console.log('PASS production ModelConnectionsPanel + shared form: real paged IPC, disabled recovery, partial edits, manual provenance, defaults/preferences, discovery, multiple connections, failed candidate repair, revision race and narrow layout');
    await closeBrowser(); await delay(250); failed = false;
  }
} finally {
  try {
  if (closeBrowser && socket?.readyState === WebSocket.OPEN) { try { await closeBrowser(); } catch {} await delay(250); }
  if (socket?.readyState === WebSocket.OPEN) socket.terminate();
  for (let attempt = 0; child?.pid && child.exitCode === null && child.signalCode === null && attempt < 50; attempt++) await delay(100);
  if (child?.pid && child.exitCode === null && child.signalCode === null) await terminateSuiteProcessTree(child);
  } finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (catalog) { catalog.closeAllConnections(); await new Promise(resolve => catalog.close(resolve)); }
  // The fixture contains synthetic keys. Never retain its credential/profile tree.
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: false });
  }
}
