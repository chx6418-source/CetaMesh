import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(uiRoot + 'package.json');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const app = read('desktop-ui/src/app/HarborApp.tsx');
assert.match(app, /<WindowChrome\s*\/>/);
assert.doesNotMatch(app, /className="(?:topbar|brand-lockup|breadcrumb)"/);
const css = read('desktop-ui/src/app/harbor.css');
assert.match(css, /grid-template-rows: 40px minmax\(0, 1fr\)/);
assert.match(css, /\.harbor-main\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\);/s);
const host = read('desktop-shell/src/webview_ui.rs');
assert.match(host, /with_decorations\(false\)/);
assert.match(host, /WindowAction::Close =>[\s\S]*?WM_CLOSE/);
assert.match(host, /WindowEvent::CloseRequested/);
console.log('PASS window chrome layout and existing close lifecycle wiring');
globalThis.window = { setTimeout, clearTimeout };
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { WindowChrome, createWindowDragGesture } = await vite.ssrLoadModule('/src/app/WindowChrome.tsx');
  const gesture = createWindowDragGesture();
  for (let click = 0; click < 2; click++) {
    gesture.begin(20, 20, 1);
    assert.equal(gesture.move(21, 21, 1, 1), false, 'stationary double click never starts native capture');
    gesture.end();
  }
  gesture.begin(20, 20, 1);
  assert.equal(gesture.move(30, 20, 2, 1), false, 'another pointer cannot start the drag');
  assert.equal(gesture.move(25, 20, 1, 1), true, 'movement starts native drag once');
  assert.equal(gesture.move(40, 20, 1, 1), false);
  gesture.begin(20, 20, 1);
  assert.equal(gesture.move(40, 20, 1, 0), false, 'released button cannot start dragging');
  const { hostClient } = await vite.ssrLoadModule('/src/bridge/typed-client.ts');
  const markup = renderToStaticMarkup(React.createElement(WindowChrome));
  assert.match(markup, /<strong>CetaMesh<\/strong>/);
  assert.doesNotMatch(markup, /<img|Desktop · UX|sparkles/);
  for (const label of ['最小化', '最大化', '关闭窗口']) assert.ok(markup.includes(`aria-label="${label}"`));
  assert.equal((markup.match(/window-resize edge-/g) ?? []).length, 8);
  const requests = [];
  window.ipc = { postMessage(raw) {
    const request = JSON.parse(raw);
    requests.push(request);
    queueMicrotask(() => window.__cetameshReceive({ id: request.id, ok: true, result: { maximized: request.params.action === 'maximize' } }));
  } };
  for (const action of ['state', 'drag', 'minimize', 'maximize', 'close', 'resizeNorth', 'resizeSouthEast']) {
    const result = await hostClient.windowAction(action);
    assert.deepEqual(requests.at(-1).params, { action });
    assert.equal(requests.at(-1).method, 'app.windowAction');
    assert.equal(result.maximized, action === 'maximize');
  }
  window.ipc.postMessage = raw => {
    const { id } = JSON.parse(raw);
    queueMicrotask(() => window.__cetameshReceive({ id, ok: false, error: { code: 'HOST_ERROR', message: 'fixture: cannot drag' } }));
  };
  await assert.rejects(hostClient.windowAction('drag'), /fixture: cannot drag/);
  console.log('PASS real React chrome rendering, fixed Host requests, and Host error propagation');
} finally {
  await vite.close();
  delete globalThis.window;
}
