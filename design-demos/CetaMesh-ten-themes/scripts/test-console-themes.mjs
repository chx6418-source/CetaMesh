import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/console.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'public/token-login.html'), 'utf8');
const start = html.indexOf('/* == theme-picker:start == */');
const end = html.indexOf('/* == theme-picker:end == */');
assert(start >= 0 && end > start, 'Theme picker must have an independently runnable controller');
const controller = html.slice(start, end);

function setup(savedTheme, reducedMotion = false, withViewTransition = true) {
  const buttons = [];
  const rootElement = { dataset: { theme: 'light' }, style: { setProperty() {} } };
  const store = new Map(savedTheme ? [['consoleTheme', savedTheme]] : []);
  const box = {
    hidden: true,
    appendChild(button) { buttons.push(button); },
    querySelectorAll() { return buttons; },
    addEventListener() {}
  };
  const trigger = { textContent: '', dataset: {}, listeners: {}, setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; } };
  const document = {
    documentElement: rootElement,
    getElementById(id) { return id === 'themeMenu' ? box : trigger; },
    createElement() { return { dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, listeners: {}, prepend() {}, setAttribute(k, v) { this[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; } }; },
    addEventListener() {},
    startViewTransition: withViewTransition ? fn => { fn(); return { finished: Promise.resolve() }; } : undefined
  };
  const context = { document, localStorage: { getItem(k) { return store.get(k) ?? null; }, setItem(k, v) { store.set(k, v); } }, window: { matchMedia() { return { matches: reducedMotion }; } }, setTimeout, clearTimeout };
  vm.runInNewContext(controller, context);
  return { buttons, rootElement, store, trigger, box };
}

const normal = setup('forest');
assert.equal(normal.buttons.length, 10, 'Show ten selectable themes');
assert.equal(normal.rootElement.dataset.theme, 'forest', 'Restore a saved theme');
assert.match(normal.trigger.textContent, /松林/, 'Show the selected theme in the compact control');
normal.buttons.find(b => b.dataset.theme === 'ink').listeners.click();
assert.equal(normal.rootElement.dataset.theme, 'ink', 'Switch theme on click');
assert.equal(normal.store.get('consoleTheme'), 'ink', 'Persist the selected theme');
assert.equal(normal.box.hidden, true, 'Close the menu after selection');

const reduced = setup('invalid', true, true);
assert.equal(reduced.rootElement.dataset.theme, 'light', 'Unknown themes fall back to the existing default');
reduced.buttons.find(b => b.dataset.theme === 'rose').listeners.click();
assert.equal(reduced.rootElement.dataset.theme, 'rose', 'Reduced motion still switches themes');

const fallback = setup(null, false, false);
fallback.buttons.find(b => b.dataset.theme === 'sand').listeners.click();
assert.equal(fallback.rootElement.dataset.theme, 'sand', 'Switch without the View Transitions API');

for (const button of normal.buttons) {
  assert(html.includes(`:root[data-theme="${button.dataset.theme}"]`), `Missing palette for ${button.dataset.theme}`);
  assert(login.includes(`${button.dataset.theme}:`), `Missing login color for ${button.dataset.theme}`);
}
console.log('Ten console themes, persistence, fallback, and login colors: OK');
