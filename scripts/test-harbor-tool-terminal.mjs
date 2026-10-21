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
  const { MessageBubble, isChatTurnCancellable, ChatComposer } = await vite.ssrLoadModule('/src/app/HarborApp.tsx');
  assert.equal(isChatTurnCancellable('waiting-approval'), true, 'pending local approval still exposes the real stop action');
  assert.equal(isChatTurnCancellable('idle'), false);
  const composer = renderToStaticMarkup(React.createElement(ChatComposer, {
    busy: isChatTurnCancellable('waiting-approval'), models: [], agentProviders: [], workspaces: [],
    selectedModelKey: '', selectedAgent: 'none', workspaceId: '', activeWorkspaceId: '',
    onWorkspaceChange() {}, onModelChange() {}, onAgentChange() {}, onSend() {}, onStop() {}
  }));
  assert.match(composer, /停止/, 'actual production composer renders stop while waiting for approval');
  const projected = (await ui.execute({ method: 'ui.chat.history', params: { id: 'controlled-session' } })).messages[0];
  assert.equal(projected.toolActivity[0].status, 'cancelled', 'cancelled must survive the production Harbor projection');
  const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: projected }));
  assert.match(html, /已取消/, 'actual tool card must display cancellation even when a duration exists');
  raw.toolActivity[0].status = 'unrecognized-upstream-state';
  const unknown = (await ui.execute({ method: 'ui.chat.history', params: { id: 'controlled-session' } })).messages[0];
  assert.notEqual(unknown.toolActivity[0].status, 'completed', 'unknown status never fabricates successful execution');
  const tools = [...Array.from({length:12},(_,index)=>({id:'done-'+index,label:'Codex completed '+index,status:'completed',durationMs:15,summary:'Fixture receipt '+index})),
    {id:'active',label:'Active command',status:'running',durationMs:null,summary:''},
    {id:'failed',label:'Failed command',status:'failed',durationMs:3,summary:'Fixture failure'},
    {id:'cancelled',label:'Cancelled command',status:'cancelled',durationMs:4,summary:''},
    {id:'unknown',label:'Unknown command',status:'unrecognized-state',durationMs:null,summary:''}];
  const grouped = renderToStaticMarkup(React.createElement(MessageBubble,{message:{...projected,text:'Actual answer',toolActivity:tools}}));
  assert.match(grouped,/工具活动/);
  assert.match(grouped,/已完成 12/);
  assert.match(grouped,/运行中 1/);
  assert.match(grouped,/失败 1/);
  assert.match(grouped,/已取消 1/);
  assert.match(grouped,/待核验 1/);
  assert.match(grouped,/<details class="tool-completed">/,'completed calls are collapsed by default');
  assert.doesNotMatch(grouped,/<details class="tool-completed" open/);
  const visiblePrefix=grouped.split('<details class="tool-completed">')[0];
  for(const label of ['Active command','Failed command','Cancelled command','Unknown command'])assert.ok(visiblePrefix.includes(label),label+' stays outside the collapsed completed group');
  for(let index=0;index<12;index++)assert.equal(grouped.split('Codex completed '+index+'<').length-1,1,'each receipt is kept exactly once');
  assert.match(grouped,/Fixture receipt 11/,'full detail remains available on expansion');
  console.log('PASS production Harbor tool projection and actual React card preserve cancellation; unknown never becomes completed');
} finally { await vite.close(); delete globalThis.window; }
