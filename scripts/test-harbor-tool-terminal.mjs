import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui');
const require = createRequire(path.join(uiRoot, 'package.json'));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const raw = { id: 'cancelled-tool-message', role: 'assistant', text: '', cancelled: true, toolActivity: [{ id: 'tool-write', label: 'filesystem.write', status: 'cancelled', durationMs: 4 }] };
const ui = createDesktopUiService({ services: { chatService: { execute: async () => ({ messages: [raw] }) } } });
globalThis.window = { setTimeout, clearTimeout };
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { MessageBubble } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  const projected = (await ui.execute({ method: 'ui.chat.history', params: { id: 'controlled-session' } })).messages[0];
  assert.equal(projected.toolActivity[0].status, 'cancelled', 'cancelled must survive the production Harbor projection');
  const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: projected }));
  assert.match(html, /已取消/, 'actual tool card must display cancellation even when a duration exists');
  raw.toolActivity[0].status = 'unrecognized-upstream-state';
  const unknown = (await ui.execute({ method: 'ui.chat.history', params: { id: 'controlled-session' } })).messages[0];
  assert.notEqual(unknown.toolActivity[0].status, 'completed', 'unknown status never fabricates successful execution');
  console.log('PASS production Harbor tool projection and actual React card preserve cancellation; unknown never becomes completed');
} finally { await vite.close(); delete globalThis.window; }
