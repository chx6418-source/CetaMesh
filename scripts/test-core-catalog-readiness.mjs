import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createCetaMeshServices } from '../src/app/service-container.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6c-catalog-'));
const services = createCetaMeshServices({ dataRoot: root, stateDir: path.join(root, 'state'), sourceRoot: root, resourceRoot: root });
let broken = false;
const provider = 'm6c-controlled-model';
services.modelRegistry.register({ id: provider, label: 'Controlled catalog', defaultModel: 'controlled', supportsTools: true,
  listModels: async () => { if (broken) throw new Error('controlled catalog disconnected'); return [{ id: 'controlled' }]; },
  health: async () => ({}), chat: async () => ({ text: 'controlled' }), stream: async function* () {} });
services.providerSecrets.set({ provider, apiKey: 'synthetic-not-a-real-key' });
const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui');
const uiRequire = createRequire(path.join(uiRoot, 'package.json'));
const React = uiRequire('react');
const { renderToStaticMarkup } = uiRequire('react-dom/server');
const { createServer } = await import(pathToFileURL(uiRequire.resolve('vite')).href);
globalThis.window = { setTimeout, clearTimeout };
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { ChatCatalogStatus } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  const healthy = await services.desktopUiService.execute({ method: 'ui.chat.catalog', params: { refresh: true } });
  const entry = healthy.modelProviders.find(row => row.id === provider);
  assert.equal(entry.catalogState, 'loaded');
  assert.equal(healthy.available, true, 'the selected Model Runtime catalog is available independently of optional DSH');
  assert.equal(healthy.reason, null, 'an unrelated DSH catalog cannot supply the selected model catalog error');
  assert.equal(renderToStaticMarkup(React.createElement(ChatCatalogStatus, { catalog: healthy })), '<span>CetaMesh Desktop</span>', 'actual Harbor toolbar must not show optional DSH failure for a loaded direct model catalog');
  assert.equal(entry.inferencing, null, 'catalog discovery never proves model inference');
  const alternate = 'm6c-alternate-model';
  services.modelRegistry.register({ id: alternate, label: 'Alternate catalog', defaultModel: 'alternate', supportsTools: true,
    listModels: async () => [{ id: 'alternate' }], health: async () => ({}), chat: async () => ({ text: 'alternate' }), stream: async function* () {} });
  services.providerSecrets.set({ provider: alternate, apiKey: 'synthetic-not-a-real-key' });
  broken = true;
  const failed = await services.desktopUiService.execute({ method: 'ui.chat.catalog', params: { refresh: true } });
  assert.equal(failed.modelProviders.find(row => row.id === provider).catalogState, 'error');
  assert.equal(failed.available, false, 'configured credentials without a usable catalog must not fabricate availability');
  assert.ok(failed.reason);
  assert.equal(failed.defaultModelProvider, provider);
  assert.equal(failed.modelProviders.find(row => row.id === alternate).catalogState, 'loaded');
  assert.notEqual(renderToStaticMarkup(React.createElement(ChatCatalogStatus, { catalog: failed })), '<span>CetaMesh Desktop</span>');
  assert.equal(failed.modelProviders.find(row => row.id === provider).inferencing, null, 'catalog failure does not invent an inference result');
  broken = false;
  const recovered = await services.desktopUiService.execute({ method: 'ui.chat.catalog', params: { refresh: true } });
  assert.equal(recovered.available, true, 'refresh recovers the selected catalog after the connection recovers');
  assert.equal(recovered.reason, null, 'the prior failure cannot remain after a successful catalog refresh');
  assert.equal(recovered.modelProviders.find(row => row.id === provider).inferencing, null);
  console.log('PASS actual Core catalog assembly: optional DSH failure cannot poison healthy models; failed catalogs and inference remain truthful');
} finally {
  await vite.close(); delete globalThis.window;
  await services.chatService.close(); await services.agentService.close(); await services.managedAgent.close();
  await services.capabilityService.close(); await services.pluginCenterService.close(); await services.extensionService.close();
  await services.channelService.close(); await services.bionicService.close();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('m6c-catalog-')) throw Error('fixture cleanup boundary');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
