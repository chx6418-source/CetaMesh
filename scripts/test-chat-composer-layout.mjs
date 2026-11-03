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
  const { ChatComposer } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  const { messageOf } = await vite.ssrLoadModule('/src/app/PagePresentation.tsx');
  const unknownTransport = messageOf(Object.assign(new Error('private runtime diagnostic'), { code: 'SESSION_TRANSPORT_UNKNOWN' }));
  assert.match(unknownTransport, /旧会话.*无法确认/);
  assert.match(unknownTransport, /工作区/);
  assert.doesNotMatch(unknownTransport, /private runtime diagnostic/);
  const props = { busy: false, models: [], selectedModelKey: '["",""]', agentProviders: [], selectedAgent: 'codex', workspaces: [{ id: 'test-workspace', name: 'NexBox-main', status: 'ready' }], workspaceId: 'test-workspace', activeWorkspaceId: 'test-workspace', onWorkspaceChange() {}, onModelChange() {}, onAgentChange() {}, onSend() {}, onStop() {} };
  const render = changes => renderToStaticMarkup(React.createElement(ChatComposer, { ...props, ...changes }));
  const markup = render();
  assert.match(markup, /class="composer-context-trigger"/);
  assert.match(markup, /NexBox-main/);
  assert.match(markup, /aria-label="添加附件"/);
  assert.match(markup, /class="composer-submit"[^>]*aria-label="发送消息"[^>]*disabled/);
  assert.match(markup, /Codex 本机配置/);
  assert.match(markup, /aria-label="选择模型与推理"/);
  assert.match(markup, /aria-label="上下文与用量"/);
  assert.doesNotMatch(markup, /class="composer-footnote"|>发送<|麦克风|语音/);
  assert.match(render({ busy: true }), /aria-label="停止生成"/);
  assert.match(render({ selectedAgent: 'cetamesh', workspaceId: '', activeWorkspaceId: null }), /请先选择工作区/);
  const unverifiedAgent = { id: 'dsh', name: 'DSH', available: true, eligible: false,
    taskEligible: false, status: 'ready', reason: 'task-tools-unverified' };
  const refused = render({ selectedAgent: 'dsh', agentProviders: [unverifiedAgent] });
  assert.match(refused, /工具能力.*验证/,
    'a persisted unavailable selection must explain its actual execution condition before sending');
  const ready = render({ selectedAgent: 'dsh', agentProviders: [{ ...unverifiedAgent, taskEligible: true, reason: 'task-required' }] });
  assert.doesNotMatch(ready, /当前不能发送/);
  const missing = render({ selectedAgent: 'removed-provider', agentProviders: [] });
  assert.match(missing, /当前不能发送/, 'a persisted missing provider cannot silently fall back');
  const css = fs.readFileSync(uiRoot + 'src/app/harbor.css', 'utf8');
  assert.match(css, /\.composer-field\s*\{[^}]*border-radius: 28px/s);
  assert.match(css, /\.composer-field > textarea\s*\{[^}]*resize: none/s);
  const app = fs.readFileSync(uiRoot + 'src/app/HarborApp.tsx', 'utf8');
  assert.match(app, /scrollHeight/);
  assert.match(app, /nativeEvent\.isComposing/);
  console.log('PASS production composer compact controls, accessible send/stop, blank input disabled, workspace guard and automatic sizing');
} finally { await vite.close(); delete globalThis.window; }
