// Production onboarding, typed UI DTOs and Core services against a local synthetic model catalog.
// This exercises Chromium transport adaptation, not the native Shell or an external account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider } from '../src/model/index.js';
import { createOnboardingService } from '../src/onboarding/index.js';
import { createProviderSecrets } from '../src/providers/secrets.js';
import { createSettingsService } from '../src/settings/index.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createModelConfiguration } from '../src/model/configuration.js';

const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui');
const require = createRequire(path.join(uiRoot, 'package.json'));
const sandbox = createSuiteSandbox({ suiteId: 'onboarding-ui' });
const evidence = process.env.CETAMESH_ONBOARDING_EVIDENCE_DIR ? path.resolve(process.env.CETAMESH_ONBOARDING_EVIDENCE_DIR) : null;
const syntheticKey = 'synthetic-onboarding-key-no-account';
const selectedProvider = 'openai-compatible';
const syntheticModel = 'onboarding-synthetic-model';
const fixtures = [], calls = [], catalogFacts = [], providerRequests = [];
let failed = true, server, browser, socket, closeBrowser, activeFixture, js, css;

function fixture(name) {
  const dataRoot = path.join(sandbox.root, name), stateDir = path.join(dataRoot, 'state');
  const providerSecrets = createProviderSecrets({ root: dataRoot });
  const settings = createSettingsService({ stateDir });
  const registry = createModelProviderRegistry({ providers: [
    createOpenAiCompatibleModelProvider({ id: 'openai', label: 'Other unconfigured provider', baseUrl: '', secrets: providerSecrets }),
    createOpenAiCompatibleModelProvider({ id: selectedProvider, label: 'Local synthetic provider', baseUrl: '', secrets: providerSecrets })
  ] });
  const modelRuntime = createModelRuntimeService({ registry, secrets: providerSecrets,
    preferredProviderId: () => settings.store.get().settings.models.provider });
  // Keep the cache clock fixed: the UI must not depend on waiting out its 30-second TTL.
  const chatService = createChatService({ stateDir, modelRuntime, now: () => 1_800_000_000_000,
    defaultModelConfig: () => settings.store.get().settings.models });
  const onboarding = createOnboardingService({ stateDir, providerSecrets, modelRuntime, settingsService: settings });
  const ui = createDesktopUiService({ services: { chatService }, system: { onboarding } });
  const value = { dataRoot, stateDir, providerSecrets, settings, modelRuntime, chatService, onboarding, ui };
  fixtures.push(value);
  return value;
}

function currentCoreFixture(name) {
  const dataRoot = path.join(sandbox.root, name), stateDir = path.join(dataRoot, 'state');
  const core = createCetaMeshServices({ dataRoot, stateDir, sourceRoot: dataRoot, resourceRoot: dataRoot, deferOptionalStart: true });
  const value = { dataRoot, stateDir, core, providerSecrets: core.providerSecrets, settings: core.settingsService,
    modelRuntime: core.modelRuntime, modelConfiguration: core.modelConfiguration,
    chatService: core.chatService, onboarding: core.onboardingService, ui: core.desktopUiService };
  fixtures.push(value);
  return value;
}

async function execute(target, method, params = {}) {
  const result = await target.ui.execute({ method, params });
  if (method === 'ui.chat.catalog') catalogFacts.push({ refresh: params.refresh === true,
    providers: result.modelProviders.map(row => ({ id: row.id, configured: row.configured, models: row.models.map(model => model.id) })) });
  return result;
}

try {
  server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/models-api/models') {
        const authenticated = request.headers.authorization === 'Bearer ' + syntheticKey;
        providerRequests.push({ method: request.method, authenticated });
        response.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
        response.end(JSON.stringify(authenticated ? { data: [{ id: syntheticModel, owned_by: 'local-test' }] } : { error: 'synthetic authentication refused' }));
        return;
      }
      if (request.url === '/rpc' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 16_384) throw Error('fixture request too large'); }
        const input = JSON.parse(body);
        assert.ok(['ui.onboarding.status', 'ui.onboarding.start', 'ui.onboarding.completeStep', 'ui.onboarding.skipStep',
          'ui.onboarding.testProvider', 'ui.onboarding.setModel', 'ui.onboarding.finish', 'ui.chat.catalog',
          'ui.models.configuration.get', 'ui.models.configuration.discover', 'ui.models.configuration.commit',
          'ui.models.configuration.edit', 'ui.models.configuration.update'].includes(input.method));
        // Record only non-secret routing facts; never retain API-key inputs or headers.
        calls.push({ method: input.method, ...(input.params.provider ? { provider: input.params.provider } : {}),
          ...(input.method === 'ui.chat.catalog' ? { refresh: input.params.refresh === true } : {}) });
        let reply;
        try { reply = { id: input.id, ok: true, result: await execute(activeFixture, input.method, input.params) }; }
        catch (error) { reply = { id: input.id, ok: false, error: { code: error.code || 'FIXTURE_ERROR', message: 'Local fixture operation failed' } }; }
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply)); return;
      }
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><style>' + css + 'html,body,#root{min-height:100%;margin:0}.onboarding-page{min-height:100vh}</style><div id="root"></div><script>' + js.replaceAll('</script', '<\\/script') + '</script>');
    } catch { response.writeHead(500); response.end('Local fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, baseUrl = url + '/models-api';

  // Independent Core witness verifies that new credential identity invalidates a prior empty catalog.
  const witness = fixture('cache-witness');
  const before = await execute(witness, 'ui.chat.catalog');
  assert.equal(before.modelProviders.find(row => row.id === selectedProvider).configured, false);
  assert.equal(providerRequests.length, 0, 'unconfigured providers do not contact a model endpoint');
  await execute(witness, 'ui.onboarding.completeStep', { stepId: 'welcome' });
  const tested = await execute(witness, 'ui.onboarding.testProvider', { provider: selectedProvider, apiKey: syntheticKey, baseUrl });
  assert.equal(tested.ok, true); assert.equal(tested.inferencing, null, 'catalog validation is not inference');
  assert.equal(witness.modelRuntime.hasKey(selectedProvider), true, 'successful candidate credentials are actually persisted');
  const cached = await execute(witness, 'ui.chat.catalog');
  assert.deepEqual(cached.modelProviders.find(row => row.id === selectedProvider).models.map(row => row.id), [syntheticModel]);
  assert.equal(cached.modelProviders.find(row => row.id === selectedProvider).configured, true,
    'credential changes invalidate the prior unconfigured catalog immediately');
  const fresh = await execute(witness, 'ui.chat.catalog', { refresh: true });
  assert.deepEqual(fresh.modelProviders.find(row => row.id === selectedProvider).models.map(row => row.id), [syntheticModel]);
  assert.equal(fresh.modelProviders.find(row => row.id === selectedProvider).configured, true);
  console.log('PASS real Core witness: saved credentials invalidate the prior empty catalog; explicit refresh preserves the current local model');

  activeFixture = currentCoreFixture('production-page');
  const { build } = require('esbuild');
  const bundle = await build({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{OnboardingPage}from'./src/app/HarborApp';
    import'./src/theme/tokens.css';import'./src/theme/global.css';
    window.fixtureErrors=[];window.fixtureCompleted=0;
    window.addEventListener('error',event=>window.fixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason)));
    window.ipc={postMessage(raw){fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:raw})
      .then(response=>response.json()).then(reply=>window.__cetameshReceive(reply));}};
    createRoot(document.getElementById('root')).render(<OnboardingPage onComplete={async()=>{window.fixtureCompleted++;}}/>);
  ` }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic' });
  js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  if (!fs.existsSync(edge)) { console.log('NOT_RUN_ENVIRONMENT Chromium is required for production onboarding'); process.exitCode = 77; failed = false; }
  else {
    const profile = path.join(sandbox.root, 'profile');
    browser = spawn(edge, ['--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    let launchError; browser.once('error', error => { launchError = error; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile) && !launchError; i++) await delay(100);
    assert.equal(launchError, undefined); assert.ok(fs.existsSync(portFile), 'owned Chromium exposes its temporary endpoint');
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let sequence = 0; const pending = new Map();
    socket.on('message', bytes => { const reply = JSON.parse(String(bytes)), entry = pending.get(reply.id); if (!entry) return;
      pending.delete(reply.id); clearTimeout(entry.timer); reply.error ? entry.reject(Error(reply.error.message)) : entry.resolve(reply.result); });
    const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15_000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
    closeBrowser = () => rpc('Browser.close');
    const target = await rpc('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await rpc('Page.enable', {}, sessionId);
    const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    const until = async (expression, label) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(40); }
      throw Error('Timed out: ' + label + ' ' + JSON.stringify(await evaluate('({text:document.body.innerText.slice(0,1600),errors:window.fixtureErrors})'))); };
    const click = label => evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent===' + JSON.stringify(label) + ')?.click()');
    const input = async (label, value) => {
      const selector = JSON.stringify('input[aria-label="' + label + '"]');
      await until('(()=>{const input=document.querySelector('+selector+');return !!input?.checkVisibility()&&!input.disabled;})()', 'visible editable field ' + label);
      await evaluate('(()=>{const input=document.querySelector('+selector+');input.focus();input.select();if(document.activeElement!==input)throw Error("Input focus failed: "+'+JSON.stringify(label)+');})()');
      await rpc('Input.insertText', { text: value }, sessionId);
    };
    const shot = async name => { if (!evidence) return; fs.mkdirSync(evidence, { recursive: true });
      const result = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(result.data, 'base64')); };

    await rpc('Page.navigate', { url }, sessionId);
    await until('document.body.innerText.includes("继续设置")', 'first-run welcome');
    await click('继续设置');
    await until('Array.from(document.querySelectorAll("button")).some(row=>row.textContent==="添加模型连接"&&!row.disabled)', 'current model configuration panel');
    await click('添加模型连接');
    await input('连接名称', 'Local synthetic provider');
    await evaluate('(()=>{const field=document.querySelector("select[aria-label=\\"模型服务类型\\"]");field.value="openai-compatible-v1";field.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await until('document.querySelector("select[aria-label=\\"模型服务类型\\"]")?.value==="openai-compatible-v1"', 'selected model protocol');
    await evaluate('document.querySelector("[data-model-connection-advanced] summary").click()');
    await until('document.querySelector("[data-model-connection-advanced]")?.open===true', 'advanced connection fields');
    await input('连接标识', selectedProvider);
    await input('模型 API Key', 'synthetic-invalid-key'); await input('模型服务地址', baseUrl);
    await click('测试并保存连接'); await until('!!document.querySelector("form[aria-label=\\"模型连接表单\\"] [role=alert]")', 'failed candidate authentication');
    assert.ok(providerRequests.some(row => row.authenticated === false), 'the failed candidate reaches the controlled endpoint and is rejected there');
    assert.equal(activeFixture.modelRuntime.hasKey(selectedProvider), false, 'failed candidate does not save a credential');
    assert.equal(activeFixture.onboarding.status().currentStepId, 'provider', 'failed authentication does not advance setup');
    assert.equal(await evaluate('document.querySelector("input[aria-label=\\"模型 API Key\\"]").value'), '', 'candidate key is cleared after submit');
    await input('模型 API Key', syntheticKey); await click('测试并保存连接');
    await until('Array.from(document.querySelectorAll("button")).some(row=>row.textContent==="使用已选默认模型继续"&&!row.disabled)', 'default-model step');
    await shot('model-step');
    assert.equal(activeFixture.onboarding.status().currentStepId, 'model');
    assert.equal(activeFixture.modelRuntime.hasKey(selectedProvider), true);
    assert.equal(await evaluate('document.body.innerText.includes("Local synthetic provider")'), true, 'successful configuration exposes the chosen connection');
    const defaultButton = 'button[aria-label="设为默认模型 ' + syntheticModel + '"]';
    const enableButton = 'button[aria-label="启用模型 ' + syntheticModel + '"]';
    assert.equal(await evaluate('document.querySelector('+JSON.stringify(defaultButton)+').disabled'), true, 'discovery does not automatically enable or select the model');
    await evaluate('document.querySelector('+JSON.stringify(enableButton)+').click()');
    await until('document.querySelector('+JSON.stringify(defaultButton)+')?.disabled===false', 'explicitly enabled model can be selected');
    assert.notEqual(activeFixture.modelConfiguration.get().defaults.model, syntheticModel, 'enabling a model does not silently make it the default');
    await evaluate('document.querySelector('+JSON.stringify(defaultButton)+').click()');
    await until('document.body.innerText.includes("全局默认")', 'explicit default selection is saved');
    await click('使用已选默认模型继续'); await until('document.body.innerText.includes("稍后设置")', 'saved model advances setup');
    assert.equal(activeFixture.modelConfiguration.get().defaults.provider, selectedProvider);
    assert.equal(activeFixture.modelConfiguration.get().defaults.model, syntheticModel);
    await click('稍后设置'); await until('document.body.innerText.includes("Plugins 页面完成")', 'optional integration');
    await click('稍后设置'); await until('document.body.innerText.includes("完成并进入 Chat")', 'ready to finish');
    await click('完成并进入 Chat'); await until('window.fixtureCompleted===1', 'setup complete callback');
    assert.equal(activeFixture.onboarding.status().status, 'completed');
    const reloadedSettings = createSettingsService({ stateDir: activeFixture.stateDir });
    const reloaded = createOnboardingService({ stateDir: activeFixture.stateDir, settingsService: reloadedSettings, modelRuntime: activeFixture.modelRuntime });
    assert.equal(reloaded.status().status, 'completed');
    const reloadedConfiguration = createModelConfiguration({ settingsStore: reloadedSettings.store,
      secrets: activeFixture.providerSecrets, registry: activeFixture.core.modelRegistry });
    assert.equal(reloadedConfiguration.get().defaults.model, syntheticModel, 'default survives service restart');
    assert.equal(activeFixture.modelRuntime.hasKey('openai'), false, 'the other account remains unconfigured');
    assert.ok(providerRequests.every(row => row.method === 'GET'), 'onboarding never performs inference');
    assert.deepEqual(await evaluate('window.fixtureErrors'), []);
    await shot('completed');
    console.log('PASS production Chromium onboarding: failed credentials stay uncommitted, explicit provider/model selection persists and setup finishes without inference');
    failed = false;
  }
} finally {
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({
    scope: 'Production React + typed bridge + real local Core services + synthetic loopback model catalog; not native or external-account acceptance',
    passed: !failed && process.exitCode !== 77, calls, catalogFacts, providerRequests }, null, 2)); }
  if (closeBrowser) await closeBrowser().catch(() => {});
  if (socket) socket.close();
  if (browser) await terminateSuiteProcessTree(browser, { timeoutMs: 5000 }).catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  for (const value of fixtures) {
    if (value.core) {
      for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await value.core[name].close();
    } else await value.chatService.close();
  }
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
