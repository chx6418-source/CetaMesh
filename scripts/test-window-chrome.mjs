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
assert.match(css, /grid-template-rows: var\(--window-chrome-height, 36px\) minmax\(0, 1fr\)/);
assert.match(css, /data-window-chrome=['"]native['"][^}]*--window-chrome-height:\s*0px/s, 'native caption consumes no duplicate client row');
assert.match(css, /\.harbor-main\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\);/s);
const host = read('desktop-shell/src/webview_ui.rs');
assert.match(host, /with_decorations\(true\)/, 'retain native resize, system caption and Windows Snap');
assert.match(host, /let caption_enabled = std::env::var\("CETAMESH_NATIVE_CHAT_CAPTION"\)\.as_deref\(\) != Ok\("0"\)/, 'accepted caption defaults on in debug and release; explicit 0 retains the native fallback');
assert.match(host, /if caption_enabled \{[\s\S]*?ChatCaption::install[\s\S]*?\.ok\(\) \} else \{ None \}/, 'adapter installation failure or explicit opt-out retains the decorated window');
assert.match(host, /__CETAMESH_NATIVE_CHROME__/, 'native capability is known before the first UI frame');
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
  const { hostClient, bridgeRequestBudget } = await vite.ssrLoadModule('/src/bridge/typed-client.ts');
  assert.equal(bridgeRequestBudget('ui.plugins.engines.package.review'),130000);
  assert.equal(bridgeRequestBudget('ui.plugins.engines.package.install'),130000);
  for(const method of ['ui.plugins.engines.enable','ui.chat.send','app.status','app.diagnostics.run'])assert.equal(bridgeRequestBudget(method),32000,'ordinary requests retain their existing budget');
  assert.equal(bridgeRequestBudget('app.pickExtensionPackage'),300000,'native file selection keeps its existing budget');
  const { captionPalette } = await vite.ssrLoadModule('/src/theme/appearance.ts');
  const colors = { '--background-soft':'#ffffff', '--surface-hover':'#eeeeee', '--accent-soft':'#d0e0f0', '--text-primary':'#222222', '--text-secondary':'#666666', '--accent-hover':'#558877' };
  const palette = captionPalette(colors, false);
  assert.deepEqual(palette, ['#ffffff','#eeeeee','#d0e0f0','#222222','#666666','#558877','#eeeeee']);
  assert.equal(captionPalette(colors, true)[0], '#9c9f9d', 'native caption uses the same modal shade as the client backdrop');
  const markup = renderToStaticMarkup(React.createElement(WindowChrome));
  assert.match(markup, /CetaMesh/);
  assert.match(markup, /window-brand-icon/,'fallback chrome has a compact brand icon');
  assert.doesNotMatch(markup, /Desktop · UX|sparkles/);
  for (const label of ['最小化', '最大化', '关闭窗口']) assert.ok(markup.includes(`aria-label="${label}"`));
  assert.equal((markup.match(/window-resize edge-/g) ?? []).length, 8);
  window.__CETAMESH_NATIVE_CHROME__=true;
  const nativeMarkup=renderToStaticMarkup(React.createElement(WindowChrome));
  assert.doesNotMatch(nativeMarkup,/window-controls|window-chrome|window-resize/,'native caption never duplicates client controls');
  delete window.__CETAMESH_NATIVE_CHROME__;
  const {ChatModeControl}=await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  window.__CETAMESH_NATIVE_CHAT_MODES__=true;
  assert.equal(renderToStaticMarkup(React.createElement(ChatModeControl,{mode:'simulation',onChange(){}})),'','native modes suppress duplicate client selector');
  assert.match(renderToStaticMarkup(React.createElement(ChatModeControl,{mode:'simulation',native:false,onChange(){}})),/仿真聊天/,'a failed native mode sync restores the inline selector even on a capable host');
  delete window.__CETAMESH_NATIVE_CHAT_MODES__;
  assert.match(renderToStaticMarkup(React.createElement(ChatModeControl,{mode:'simulation',onChange(){}})),/仿真聊天/,'older hosts retain a functional selector');

  const requests = [];
  window.ipc = { postMessage(raw) {
    const request = JSON.parse(raw);
    requests.push(request);
    queueMicrotask(() => window.__cetameshReceive({ id: request.id, ok: true, result: { maximized: request.params.action === 'maximize' } }));
  } };
  for (const action of ['state', 'drag', 'minimize', 'maximize', 'close', 'resizeNorth', 'resizeSouthEast', 'chatModeChat', 'chatModeSimulation', 'chatModeProject', 'chatModeHidden']) {
    const result = await hostClient.windowAction(action);
    assert.deepEqual(requests.at(-1).params, { action });
    assert.equal(requests.at(-1).method, 'app.windowAction');
    assert.equal(result.maximized, action === 'maximize');
  }
  await hostClient.windowAction('appearanceLight', { palette, modal: true });
  assert.deepEqual(requests.at(-1).params, { action: 'appearanceLight', palette, modal: true }, 'native palette uses the existing strictly scoped Host command');
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
