import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(root + 'package.json');
const React = require('react');
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { SettingsLayout } = await vite.ssrLoadModule('/src/app/SettingsLayout.tsx');
  const items = [{ id: 'general', label: '常规' }, { id: 'models', label: '模型' }, { id: 'advanced', label: '高级' }];
  const html = renderToStaticMarkup(React.createElement(SettingsLayout, { items, selected: 'models', onChange() {}, search: React.createElement('input', {type:'search', 'aria-label':'搜索设置'}) }, React.createElement('p', null, '真实设置内容')));
  assert.match(html, /<nav[^>]*aria-label="设置类别"/);
  assert.match(html, /aria-current="page"[^>]*><svg[\s\S]*?<span>模型<\/span>/);
  for (const item of items) assert.ok(html.includes(item.label));
  assert.ok(html.includes('真实设置内容'));
  assert.doesNotMatch(html, /role="tab"|role="tablist"/);
  const app = fs.readFileSync(root + 'src/app/HarborApp.tsx', 'utf8');
  assert.doesNotMatch(app, /<footer className="harbor-footer"/);
  assert.ok(app.includes('collapsed={sidebarCollapsed}'), 'all pages use the navigation-aware hook, without overriding manual state');
  const ast=ts.createSourceFile('HarborApp.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),layouts=[];
  function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(ast)==='SettingsLayout')layouts.push(node);ts.forEachChild(node,visit);}visit(ast);
  assert.equal(layouts.length,1);
  const props=new Map(layouts[0].attributes.properties.filter(ts.isJsxAttribute).map(prop=>[prop.name.getText(ast),prop.initializer?.getText(ast)]));
  for(const [name,value] of Object.entries({items:'{settingPages}',selected:'{activeSection}',onChange:'{setActiveSection}'}))assert.equal(props.get(name),value);
  assert.ok(props.has('search'));assert.match(html,/aria-label="搜索设置"/);
  assert.match(app, /保存设置/);
  // The operation inbox moved with the Plugins page; keep both its host and data flow covered.
  const plugins = fs.readFileSync(root + 'src/app/PluginsPage.tsx', 'utf8');
  assert.match(app, /<PluginsPage\s*\/>/);
  assert.match(plugins, /setApprovalOperations\(result.operations \?\? \[\]\)/);
  assert.match(plugins, /<ApprovalOperationSummary operations=\{approvalOperations\}/);
  const { ApprovalOperationSummary, FeedbackLinkRow, approvalOperationsNeedingAttention } = await vite.ssrLoadModule('/src/app/StatusPresentation.tsx');
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
  assert.equal(typeof approvalOperationsNeedingAttention,'function','Chat needs an attention-only projection without changing stored operation history');
  const attention=approvalOperationsNeedingAttention([...operations,{operationId:'cancelled',status:'cancelled'},{operationId:'rejected',status:'rejected'}]);
  const chatSummary=renderToStaticMarkup(React.createElement(ApprovalOperationSummary,{operations:attention,onCancel(){}}));
  assert.doesNotMatch(chatSummary,/历史操作|approval-operation-history/,'Chat has no history bar');
  for(const text of ['执行中','等待后续审批','失败','结果未知','TEST_FAILURE'])assert.ok(chatSummary.includes(text),'Chat keeps attention state '+text);
  assert.equal(renderToStaticMarkup(React.createElement(ApprovalOperationSummary,{operations:approvalOperationsNeedingAttention(operations.filter(row=>row.status==='completed')),onCancel(){}})),'','settled-only Chat has no empty operation wrapper');
  assert.match(app,/if \(attentionOperations\.length\) rows\.push/,'settled operations never allocate a blank virtual Chat row');
  assert.doesNotMatch(app,/className="diagnostics-settings-entry"/,'Settings uses the shared navigation and About feedback entries');
  const appearance=await vite.ssrLoadModule('/src/theme/appearance.ts');
  assert.deepEqual(appearance.APPEARANCE_SCHEMES.slice(0,3).map(row=>row.id),['original','white','black'],'keep original and add explicit white and black schemes');
  assert.ok(appearance.APPEARANCE_SCHEMES.length>=6);
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const preference={...appearance.DEFAULT_APPEARANCE,scheme:'blue',strength:25,blur:3};
  appearance.writeAppearance(preference,storage);assert.deepEqual(appearance.readAppearance(storage),preference);
  assert.equal(appearance.normalizeAppearance({scheme:'bad',image:'https://untrusted.invalid/image.png',strength:Infinity}).image,null,'custom background never accepts a remote URL');
  assert.equal(appearance.normalizeAppearance({scheme:'bad'}).scheme,'original');
  assert.throws(()=>appearance.writeAppearance(preference,{setItem(){throw Error('quota');}}),/quota/,'failed local preference persistence is reported');
  assert.equal(appearance.appearanceColors({...preference,scheme:'white'},false)['--background'],'#ffffff');
  assert.equal(appearance.appearanceColors({...preference,scheme:'black'},true)['--background'],'#000000');
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
