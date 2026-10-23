import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(uiRoot + 'package.json');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
globalThis.window = { setTimeout, clearTimeout };
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', plugins: [{
    name: 'memory-fixture-exports', enforce: 'pre',
    transform(code, id) { if (id.replaceAll('\\', '/').endsWith('/app/HarborApp.tsx')) return code + '\nexport { MemoryManager, MemoryPage };'; }
  }] });
try {
  const { MemoryManager, MemoryPage, ChatComposer } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  const memory = { id: 'synthetic-memory', type: 'working', scope: 'task:fixture', title: '整理项目入口',
    summary: '检查点摘要（待核验）：已找到主要入口，下一步核对目录结构。',
    content: '{"schemaVersion":1,"taskId":"fixture","goal":"整理项目入口"}',
    tags: ['core-task-working-v1'], pinned: false, rev: 1, createdAt: Date.now(), updatedAt: Date.now() };
  const render = props => renderToStaticMarkup(React.createElement(MemoryManager, { initial: [memory], onChanged() {}, ...props }));
  const html = render();
  const visible = html.replace(/<details class="memory-item-details">[\s\S]*?<\/details>/g, '');
  assert.ok(visible.includes('整理项目入口') && visible.includes('待核验'));
  assert.doesNotMatch(visible, /schemaVersion|taskId/, 'serialized state stays inside explicit details');
  assert.match(html, /<details class="memory-item-details"><summary>查看完整记录<\/summary><pre>/);
  assert.match(html, /<details class="memory-create-panel"><summary>/, 'creation editor is closed initially');
  assert.doesNotMatch(html, /type="search"/, 'manager does not introduce a second search field');
  assert.match(html, /class="memory-item-actions"/);
  for (const label of ['编辑记忆', '固定记忆', '删除记忆']) assert.ok(html.includes(label));
  const page = renderToStaticMarkup(React.createElement(MemoryPage));
  assert.equal((page.match(/type="search"/g) ?? []).length, 1);
  assert.match(page, /class="memory-toolbar"/);
  const hostile = render({ initial: [{ ...memory, content: '<script>bad()</script>', summary: '<img src=x onerror=bad()>', title: '<b>unsafe</b>' }] });
  assert.doesNotMatch(hostile, /<script>|<img src=x|<b>unsafe<\/b>/, 'Memory text never becomes active HTML');
  if (process.env.CETAMESH_MEMORY_LAYOUT_PREVIEW) {
    const styles = ['theme/tokens.css', 'theme/global.css', 'app/harbor.css'].map(file => fs.readFileSync(uiRoot + 'src/' + file, 'utf8')).join('\n');
    const fixture = render({ initial: [memory, { ...memory, id: 'preference', type: 'user', scope: 'user:desktop', title: '回答偏好', summary: '使用简洁中文，先列出操作结果，再说明需要我决定的事项。', content: '使用简洁中文，先列出操作结果，再说明需要我决定的事项。' }] });
    const composer = renderToStaticMarkup(React.createElement(ChatComposer, { busy: false, models: [], selectedModelKey: '["",""]', agentProviders: [], selectedAgent: 'codex', workspaces: [{ id: 'w', name: 'NexBox-main', status: 'ready' }], workspaceId: 'w', activeWorkspaceId: 'w', onWorkspaceChange() {}, onModelChange() {}, onAgentChange() {}, onSend() {}, onStop() {} }));
    fs.writeFileSync(process.env.CETAMESH_MEMORY_LAYOUT_PREVIEW, '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆与输入区 · 合成布局验收</title><style>' + styles + '</style><body style="overflow:auto"><main class="content-page memory-page"><header class="page-heading"><div><p class="eyebrow">MEMORY</p><h1>记忆</h1><p class="page-description">合成数据 · 紧凑卡片布局验收</p></div></header>' + page.match(/<div class="memory-toolbar">[\s\S]*?<\/label><\/div>/)?.[0] + fixture + '</main><section class="composer-dock">' + composer + '</section></body></html>');
    fs.writeFileSync(process.env.CETAMESH_MEMORY_LAYOUT_PREVIEW.replace(/\.html$/, '-composer.html'), '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>输入区 · 合成布局验收</title><style>' + styles + '</style><body><main style="height:100vh;display:grid;grid-template-rows:minmax(0,1fr) auto"><section style="max-width:960px;width:100%;margin:auto;padding:24px"><p class="muted">合成布局验收 · 输入框随内容自动增高</p></section><section class="composer-dock">' + composer + '</section></main></body></html>');
  }
  console.log('PASS readable Memory previews, collapsed full records and creation, single search, preserved actions and escaped content');
} finally { await vite.close(); delete globalThis.window; }
