import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(root + 'package.json');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { SettingsLayout } = await vite.ssrLoadModule('/src/app/SettingsLayout.tsx');
  const items = [{ id: 'general', label: '常规' }, { id: 'models', label: '模型' }, { id: 'advanced', label: '高级' }];
  const html = renderToStaticMarkup(React.createElement(SettingsLayout, { items, selected: 'models', onChange() {} }, React.createElement('p', null, '真实设置内容')));
  assert.match(html, /<nav[^>]*aria-label="设置类别"/);
  assert.match(html, /aria-current="page"[^>]*><svg[\s\S]*?<span>模型<\/span>/);
  for (const item of items) assert.ok(html.includes(item.label));
  assert.ok(html.includes('真实设置内容'));
  assert.doesNotMatch(html, /role="tab"|role="tablist"/);
  const app = fs.readFileSync(root + 'src/app/HarborApp.tsx', 'utf8');
  assert.doesNotMatch(app, /<footer className="harbor-footer"/);
  assert.ok(app.includes('sidebarCollapsed || page === \'settings\''));
  assert.match(app, /<SettingsLayout items=\{settingPages\}/);
  assert.match(app, /保存设置/);
  assert.match(app, /setApprovalOperations\(result.operations \?\? \[\]\)/);
  assert.match(app, /<ApprovalOperationSummary operations=\{approvalOperations\}/);
  const { ApprovalOperationSummary, FeedbackLinkRow } = await vite.ssrLoadModule('/src/app/StatusPresentation.tsx');
  const operations = [
    ...Array.from({ length: 7 }, (_, index) => ({ operationId: 'done-' + index, status: 'completed' })),
    { operationId: 'active', status: 'running' }, { operationId: 'wait', status: 'waiting' },
    { operationId: 'error', status: 'failed', code: 'TEST_FAILURE' }, { operationId: 'unknown', status: 'unknown' }
  ];
  const summary = renderToStaticMarkup(React.createElement(ApprovalOperationSummary, { operations, onCancel() {} }));
  assert.match(summary, /历史操作 · 7/);
  assert.doesNotMatch(summary, /<details[^>]*open/);
  const visible = summary.slice(0, summary.indexOf('<details'));
  for (const text of ['执行中', '等待后续审批', '失败', '结果未知', 'TEST_FAILURE']) assert.ok(visible.includes(text));
  assert.equal((summary.match(/请求停止/g) || []).length, 1);
  assert.equal(renderToStaticMarkup(React.createElement(ApprovalOperationSummary, { operations: [], onCancel() {} })), '');
  const url = 'https://cetamesh.com/feedback?version=1.0.0&build=long-value';
  const link = renderToStaticMarkup(React.createElement(FeedbackLinkRow, { entry: { id: 'bug', label: 'Bug 反馈', description: '功能异常、崩溃。', kind: 'feedback', url }, onVisit() {} }));
  assert.match(link, /class="about-link-copy"/);
  assert.match(link, /class="feedback-destination">cetamesh.com</);
  assert.doesNotMatch(link, /build=long-value/);
  const css = fs.readFileSync(root + 'src/app/status-presentation.css', 'utf8');
  assert.match(css, /\.about-link-copy\s*\{[^}]*display:\s*grid/);
  assert.match(css, /white-space:\s*normal/);
  console.log('PASS operation history collapsed, active and uncertain results visible, compact feedback links');
  console.log('PASS vertical settings navigation, selected category, preserved content, no footer and settings-only workspace collapse');
} finally { await vite.close(); }
