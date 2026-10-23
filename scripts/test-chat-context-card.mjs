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
const vite = await createServer({ configFile: false, root: uiRoot, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { ChatContextPanel } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  assert.equal(typeof ChatContextPanel, 'function', 'production card is renderable');
  const task = { id: 'fixture-task', title: '分析项目', status: 'blocked', agent: 'codex', workspaceId: 'fixture-workspace', currentPhase: '等待核对', progress: { percent: 25, note: '' }, goal: 'fixture', artifacts: [] };
  const render = (props = {}) => renderToStaticMarkup(React.createElement(ChatContextPanel, { task, memories: [], approvals: [], onOpenMemory() {}, ...props }));
  const compact = render();
  assert.match(compact, /^<details class="chat-context-card"/);
  assert.doesNotMatch(compact, /^<details[^>]*\sopen(?:[\s=>])/);
  const summary = compact.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? '';
  for (const value of ['分析项目', '25%', '审批 0', '交付物 0']) assert.ok(summary.includes(value), value);
  assert.doesNotMatch(compact, /暂无交付物|没有找到相关记忆|当前没有待处理审批|<aside/);
  assert.equal(render({ task: null }), '', 'ordinary empty chats have no context placeholder');
  const populated = render({ task: { ...task, artifacts: [{ id: 'artifact-fixture', kind: 'text', label: 'result.txt' }] }, memories: [{ id: 'memory-fixture', title: '项目约定', scope: 'workspace', updatedAt: Date.now() }], approvals: [{ id: 'approval-fixture', title: '待审批操作', summary: '写入测试工作区文件', capability: 'filesystem.write' }] });
  for (const value of ['审批 1', '交付物 1', '待审批操作', '项目约定', 'result.txt']) assert.ok(populated.includes(value), value);
  assert.ok(render({ task: null, approvals: [{ id: 'approval-fixture', title: '独立审批', summary: 'fixture', capability: 'filesystem.write' }] }).includes('独立审批'));
  const app = fs.readFileSync(uiRoot + 'src/app/HarborApp.tsx', 'utf8');
  assert.match(app, /className="composer-dock"><ChatContextPanel[^>]+\/>\s*<ChatComposer/);
  assert.doesNotMatch(app, /contextCollapsed|harbor:chat-context:/);
  const css = fs.readFileSync(uiRoot + 'src/app/harbor.css', 'utf8');
  assert.match(css, /\.chat-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.doesNotMatch(css, /\.chat-context\s*\{/);
  if (process.env.CETAMESH_CONTEXT_PREVIEW) {
    const styles = ['theme/tokens.css', 'theme/global.css', 'app/harbor.css'].map(file => fs.readFileSync(uiRoot + 'src/' + file, 'utf8')).join('\n');
    fs.writeFileSync(process.env.CETAMESH_CONTEXT_PREVIEW, '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>任务卡片 · 合成数据布局验收</title><style>' + styles + '</style><body><div id="root" style="height:100vh;max-width:1060px;margin:auto;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--background)"><header class="conversation-toolbar"><div><p class="eyebrow">CETAMESH · CHAT</p><h1>项目分析</h1><small class="muted">界面验收 · 合成测试数据</small></div></header><section style="padding:30px"><article class="chat-message assistant"><div class="message-body"><p>项目分析结果会显示在这里。</p><p>任务信息已整理到输入框上方，点击卡片即可展开。</p></div></article></section><div class="composer-dock">' + populated + '<div class="composer-field"><textarea aria-label="输入消息" placeholder="告诉 CetaMesh 你想做什么。" style="width:100%;resize:none;background:transparent;color:inherit;border:0;padding:10px" rows="3"></textarea><div class="composer-bottom"><span class="muted">测试工作区 · Codex</span><button class="cm-button">发送</button></div></div></div></div></body></html>');
  }
  console.log('PASS production compact context card, closed default, live counts, real detail links, no empty placeholders, and in-flow composer placement');
} finally { await vite.close(); delete globalThis.window; }
