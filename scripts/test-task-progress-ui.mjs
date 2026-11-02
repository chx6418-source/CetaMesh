import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(root + 'package.json');
const ts = require('typescript');
const harbor = fs.readFileSync(root + 'src/app/HarborApp.tsx', 'utf8');
assert.match(harbor, /import \{ WorkPage \} from '\.\/WorkPage'/);
assert.match(harbor, /export \{ WorkPage \} from '\.\/WorkPage'/);
const source = fs.readFileSync(root + 'src/app/WorkPage.tsx', 'utf8');
const ast = ts.createSourceFile('WorkPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let code, finishCode, openCode, rememberCode, createdCode;
function walk(node, owner = '') {
  if (owner === 'WorkPage' && ts.isFunctionDeclaration(node) && node.name?.text === 'showCreatedTask') createdCode=node.getText(ast);
  if (owner === 'WorkPage' && ts.isFunctionDeclaration(node) && node.name?.text === 'openTask') openCode = node.getText(ast);
  if (owner === 'WorkPage' && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'rememberTask') rememberCode = node.initializer.arguments[0].getText(ast);
  if (owner === 'WorkPage' && ts.isFunctionDeclaration(node) && node.name?.text === 'finishTask') finishCode = node.getText(ast);
  if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? owner;
  if (owner === 'WorkPage' && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'refresh') code = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, child => walk(child, owner));
}
walk(ast); assert.ok(code); assert.ok(createdCode,'new Task completion needs a navigation-epoch-aware handler');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const task = (rev, percent, id = 'T') => ({ id, rev, status: percent === 100 ? 'completed' : 'running', progress: { percent } });
function harness(client, initial = [], selected = null, scope = { workspaceId: '', offset: 0 }) {
  const state = { tasks: initial, selected, error: '', loading: false, total: 0, counts: {}, offset: scope.offset };
  const env = { query: '', filter: '', taskWorkspaceId: scope.workspaceId, taskOffset: scope.offset,
    selectedTaskIdRef: { current: selected?.id ?? '' }, taskNavigationRef: { current: 0 }, taskRefreshRef: { current: 0 }, taskQueryRef: { current: ['', '', scope.workspaceId, scope.offset].join('\u0000') },
    setLoading: v => { state.loading=v; }, setError: v => { state.error=v; },
    setTaskTotal: v => { state.total=v; }, setTaskCounts: v => { state.counts=v; }, setTaskOffset: v => { state.offset=v; },
    setTasks: v => { state.tasks=typeof v === 'function' ? v(state.tasks) : v; },
    setSelectedTask: v => { state.selected=typeof v === 'function' ? v(state.selected) : v; },
    messageOf: String, taskClient: client };
  const snapshots = new Map(initial.map(row => [row.id,row]));if(selected)snapshots.set(selected.id,selected);
  if(rememberCode) { const js=ts.transpileModule('const callback = '+rememberCode,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;env.rememberTask=new Function('taskSnapshotsRef',js+';return callback;')({current:snapshots}); }
  const javascript = ts.transpileModule('const callback = ' + code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { state, env, refresh: new Function(...Object.keys(env), javascript + '; return callback;')(...Object.values(env)) };
}
const failures=[];
async function check(name, run) { try { await run(); console.log('PASS',name); } catch(e) { failures.push(name); console.error('FAIL',name, e.message); } }
await check('late overview cannot replace newer revision', async () => {
  const replies=[deferred(),deferred()]; let i=0; const h=harness({overview:()=>replies[i++].promise});
  const old=h.refresh(true), fresh=h.refresh(true);
  replies[1].resolve({tasks:[task(8,100)]}); await fresh; replies[0].resolve({tasks:[task(7,0)]}); await old;
  assert.equal(h.state.tasks[0].progress.percent,100);
});
await check('snapshot revision fence permits newer retry progress', async () => {
  const replies=[{tasks:[task(7,0)]},{tasks:[task(9,10)]}]; const h=harness({overview:async()=>replies.shift()},[task(8,100)]);
  await h.refresh(true); assert.equal(h.state.tasks[0].rev,8);
  await h.refresh(true); assert.equal(h.state.tasks[0].progress.percent,10);
});
for (const next of ['B','']) await check(`late detail cannot override navigation to ${next || 'closed'}`,async()=>{
  const read=deferred();const h=harness({overview:async()=>({tasks:[]}),get:()=>read.promise},[],task(1,0,'A'));
  const pending=h.refresh(true); await tick(); h.env.taskNavigationRef.current++; h.env.selectedTaskIdRef.current=next; h.state.selected=next?task(2,70,next):null;
  read.resolve({task:task(1,0,'A')});await pending;assert.equal(h.state.selected?.id??'',next);
});
await check('late error and query responses do not leak into new filter',async()=>{
  const read=deferred();const h=harness({overview:()=>read.promise});const pending=h.refresh();h.env.taskQueryRef.current='new\u0000running';read.reject(new Error('old query failed'));await pending;assert.equal(h.state.error,'');
});
for (const next of [{ workspaceId: 'ws-next', offset: 0 }, { workspaceId: 'ws-first', offset: 50 }]) await check(`late Task overview cannot replace the next ${next.offset ? 'page' : 'project'}`, async () => {
  const read = deferred();
  const h = harness({ overview: () => read.promise }, [task(1, 10, 'current')], null, { workspaceId: 'ws-first', offset: 0 });
  const pending = h.refresh(true);
  h.env.taskQueryRef.current = ['', '', next.workspaceId, next.offset].join('\u0000');
  h.state.tasks = [task(2, 20, 'next-selection')];
  read.resolve({ tasks: [task(3, 30, 'stale')], total: 105, counts: { running: 105 } });
  await pending;
  assert.equal(h.state.tasks[0].id, 'next-selection'); assert.equal(h.state.total, 0);
});
await check('Task refresh requests the selected project and page and retains the server total', async () => {
  let requested;
  const h = harness({ overview: async (query, status, page) => { requested = page; return { tasks: [task(1, 20)], total: 105, counts: { running: 105 } }; } }, [], null, { workspaceId: 'ws-first', offset: 100 });
  await h.refresh(true);
  assert.deepEqual(requested, { workspaceId: 'ws-first', offset: 100, limit: 50 });
  assert.equal(h.state.total, 105); assert.equal(h.state.counts.running, 105); assert.equal(h.state.tasks.length, 1);
});
await check('selected task revision cannot regress',async()=>{
  const h=harness({overview:async()=>({tasks:[]}),get:async()=>({task:task(6,0)})},[],task(7,100));await h.refresh(true);assert.equal(h.state.selected.rev,7);
});
await check('newer overview remains in detail when background get fails',async()=>{
  const h=harness({overview:async()=>({tasks:[task(8,100)]}),get:async()=>{throw new Error('offline');}},[task(7,0)],task(7,0));
  await h.refresh(true);assert.equal(h.state.selected.rev,8);assert.equal(h.state.selected.progress.percent,100);
});
for(const failed of [false,true]) await check(`detail open ${failed?'fallback':'reply'} respects newer overview snapshot`,async()=>{
  const read=deferred();const h=harness({get:()=>read.promise,overview:async()=>({tasks:[task(8,100,'A')]})},[task(7,0,'A')]);
  const env={...h.env,setTaskOperationError(){}};const js=ts.transpileModule(openCode,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const open=new Function(...Object.keys(env),js+';return openTask;')(...Object.values(env));const pending=open(task(7,0,'A'));await h.refresh(true);
  if(failed)read.reject(new Error('temporary read failure'));else read.resolve({task:task(7,0,'A')});await pending;assert.equal(h.state.selected.rev,8);assert.equal(h.state.selected.progress.percent,100);
});
await check('action results preserve higher detail revision and update list before polling',async()=>{
  const h=harness({},[task(7,0)],task(9,100));const env={...h.env,taskClient:{complete:async()=>({task:task(8,100)})},setTaskOperationError(){},taskOperationErrorMessage:String,refresh:async()=>{}};
  const js=ts.transpileModule(finishCode,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const finish=new Function(...Object.keys(env),js+';return finishTask;')(...Object.values(env));await finish(task(7,0),'Reviewed');assert.equal(h.state.selected.rev,9);assert.equal(h.state.tasks[0].rev,9);
});
await check('progress widths and accessible values match exact percentages',async()=>{
  const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
  globalThis.window={setTimeout,clearTimeout};const vite=await createServer({configFile:false,root,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},appType:'custom',logLevel:'error'});
  try {const {ChatContextPanel,WorkTaskList,TaskDetails}=await vite.ssrLoadModule('/src/app/HarborApp.tsx');
    for(const percent of [0,1,40,88,99,100,null]) {
      const fixture={...task(1,percent),status:'running',title:'Progress test',goal:'test',agent:null,artifacts:[],agentHistory:[],children:[],attempts:[],updatedAt:1,progress:{percent,note:''}};
      const outputs=[renderToStaticMarkup(React.createElement(ChatContextPanel,{task:fixture,memories:[],approvals:[],onOpenMemory(){}})),renderToStaticMarkup(React.createElement(WorkTaskList,{tasks:[fixture],workspaces:[],providers:[],onOpen(){},onAction(){}}))];
      for(const html of outputs) { if(percent===null) {assert.doesNotMatch(html,/aria-valuenow=/);assert.ok(html.includes('未报告'));} else {assert.ok(html.includes(`aria-valuenow="${percent}"`));assert.ok(html.includes(`width:${percent}%`),`${percent}% uses exact width`);} }
    }
    const reviewTask={...task(9,0),title:'Review report',goal:'Analysis only',agent:null,currentAgent:{provider:'codex',sessionId:'s'},artifacts:[],agentHistory:[],children:[],attempts:[],executionEvidence:[],progress:{percent:0,note:''},execution:{state:'awaiting-review',hadToolActivity:false,hasEvidence:false},reviewReport:{eventId:'report-1',text:'Exact report to review',sha256:'a'.repeat(64)}};
    const card=renderToStaticMarkup(React.createElement(ChatContextPanel,{task:reviewTask,memories:[],approvals:[],onOpenMemory(){}}));assert.ok(card.includes('待验收'),'settled run must not say still running');assert.ok(card.includes('执行已结束，待验收'));assert.doesNotMatch(card,/aria-valuenow="0"/,'review stage must not misrepresent an unreported percent as zero');
    const detail=renderToStaticMarkup(React.createElement(TaskDetails,{task:reviewTask,providers:[],onHandoff(){},onAction(){},onStart(){},onReconcile(){},onReview(){},onCreateChild(){},onComplete(){},onVerifyChild(){}}));assert.ok(detail.includes('Exact report to review'));assert.ok(detail.includes('仅验收分析报告'));assert.match(detail,/<input[^>]*type="checkbox"/);assert.doesNotMatch(detail,/<input[^>]*checked=""/);
    const completed={...reviewTask,status:'completed',result:{summary:'PROVEN_RESULT_DELIVERY'}};
    const completedHtml=renderToStaticMarkup(React.createElement(TaskDetails,{task:completed,providers:[],onHandoff(){},onAction(){},onStart(){},onReconcile(){},onReview(){},onCreateChild(){},onComplete(){},onVerifyChild(){}}));
    assert.doesNotMatch(completedHtml,/验收说明/,'completed Task must not ask for a disabled manual acceptance');assert.ok(completedHtml.includes('PROVEN_RESULT_DELIVERY'));assert.ok(completedHtml.indexOf('PROVEN_RESULT_DELIVERY')<completedHtml.indexOf('任务累计用量'),'verified result precedes execution internals');
  }finally {await vite.close();delete globalThis.window;}
});
await check('production CSS closure defines progress track dimensions and fill',async()=>{
  const seen=new Set(),styles=[];function visit(file) {if(seen.has(file))return;seen.add(file);const content=fs.readFileSync(file,'utf8');if(file.endsWith('.css')) {styles.push(content);return;}const ast=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true);for(const node of ast.statements){if(!ts.isImportDeclaration(node)||!node.moduleSpecifier?.text.startsWith('.'))continue;const base=path.resolve(path.dirname(file),node.moduleSpecifier.text);const resolved=[base,...['.ts','.tsx','.js','/index.ts','/index.tsx'].map(ext=>base+ext)].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());if(resolved)visit(resolved);}}
  visit(root+'src/main.tsx');const rules=[];require('postcss').parse(styles.join('\n')).walkRules(rule=>{if(rule.selector.split(',').some(s=>s.trim()==='.progress-track'))rules.push(...rule.nodes.filter(n=>n.type==='decl').map(n=>[n.prop,n.value]));});
  assert.ok(rules.some(([prop,value])=>prop==='height'&&value!=='0'));assert.ok(rules.some(([prop])=>prop==='background'));
});
await check('ordinary project navigation retains selected and blocked isolation without deleting registrations', async () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  globalThis.window = { setTimeout, clearTimeout };
  const vite = await createServer({ configFile: false, root, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { projectWorkspaceChoices, WorkspaceSidebar } = await vite.ssrLoadModule('/src/app/WorkspaceSidebar.tsx');
    const workspaces = [
      { id: 'project', name: 'Owner project', status: 'clean' },
      { id: 'isolated', name: 'Task isolation', status: 'clean', managedIsolation: true, recovery: { status: 'ready', code: null } },
      { id: 'blocked', name: 'Recovery isolation', status: 'recovery-required', managedIsolation: true, recovery: { status: 'blocked', code: 'WORKSPACE_RECOVERY_REQUIRED' } }
    ];
    assert.deepEqual(projectWorkspaceChoices(workspaces).map(row => row.id), ['project', 'blocked']);
    assert.deepEqual(projectWorkspaceChoices(workspaces, ['isolated']).map(row => row.id), ['project', 'isolated', 'blocked']);
    const sidebar = renderToStaticMarkup(React.createElement(WorkspaceSidebar, { page: 'work', workspaces, sessions: [], activeWorkspaceId: 'isolated', activeSessionId: '', taskCount: 0, hostStatus: 'ready', collapsed: false, onToggle() {}, onNavigate() {}, onOpenWorkspace() {}, onOpenSession() {}, onNewSession() {}, onAllSessions() {}, renderSessionActions() { return null; } }));
    assert.ok(sidebar.includes('Task isolation')); assert.ok(sidebar.includes('Recovery isolation')); assert.ok(sidebar.includes('待恢复'));
    assert.equal(workspaces.length, 3, 'navigation filtering does not delete registrations');
  } finally { await vite.close(); delete globalThis.window; }
});
assert.equal(failures.length,0,failures.join('; '));

{
 const navigation={current:5},state={selected:'newer-selection',sheet:true,refreshes:0,tasks:[]},env={taskNavigationRef:navigation,selectedTaskIdRef:{current:'newer-selection'},taskRefreshRef:{current:0},taskQueryRef:{current:['','','',0].join('\u0000')},query:'',filter:'',taskWorkspaceId:'',taskOffset:0,setTasks:v=>{state.tasks=typeof v==='function'?v(state.tasks):v;},setTaskSheet:v=>{state.sheet=v;},setSelectedTask:v=>{state.selected=v.id;},rememberTask:v=>v,refresh:async()=>{state.refreshes++;}};
 const javascript=ts.transpileModule(createdCode,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const reveal=new Function(...Object.keys(env),javascript+';return showCreatedTask;')(...Object.values(env));
 await reveal({id:'late-created'},4);assert.equal(state.selected,'newer-selection');assert.equal(state.sheet,true);assert.equal(navigation.current,5);
 await reveal({id:'current-created'},5);assert.equal(state.selected,'current-created');assert.equal(state.sheet,false);assert.equal(navigation.current,6);
 console.log('PASS late Task creation cannot reopen a closed sheet or replace newer navigation');
}

for (const scenario of [
  { name:'matching current project and first page', workspace:'ws-a', filter:'', query:'', offset:0, visible:true },
  { name:'different project', workspace:'ws-b', filter:'', query:'', offset:0, visible:false },
  { name:'different status', workspace:'ws-a', filter:'completed', query:'', offset:0, visible:false },
  { name:'active search whose full Core matching data is not projected', workspace:'ws-a', filter:'', query:'something', offset:0, visible:false },
  { name:'later page', workspace:'ws-a', filter:'', query:'', offset:50, visible:false }
]) {
 const waiting=deferred(),state={tasks:[task(4,20,'existing')],selected:null},navigation={current:5};
 const env={taskNavigationRef:navigation,taskRefreshRef:{current:0},taskQueryRef:{current:[scenario.query,scenario.filter,scenario.workspace,scenario.offset].join('\u0000')},selectedTaskIdRef:{current:''},taskWorkspaceId:scenario.workspace,filter:scenario.filter,query:scenario.query,taskOffset:scenario.offset,
   setTaskSheet(){},setSelectedTask:v=>{state.selected=v;},setTasks:v=>{state.tasks=typeof v==='function'?v(state.tasks):v;},rememberTask:v=>v,refresh:()=>waiting.promise};
 const js=ts.transpileModule(createdCode,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const reveal=new Function(...Object.keys(env),js+';return showCreatedTask;')(...Object.values(env));
 const created={...task(1,0,'new-task'),status:'queued',workspaceId:'ws-a'};
 const pending=reveal(created,5);
 assert.equal(state.selected?.id,'new-task','created Task opens immediately');
 assert.equal(state.tasks.some(row=>row.id==='new-task'),scenario.visible,scenario.name+' uses a truthful list scope while the Core refresh is pending');
 waiting.resolve();await pending;
}
console.log('PASS created Task is visible immediately without leaking into another list scope');

{
 const state={tasks:[{id:'beta-task',rev:2}],selected:'beta-task',refreshes:0,sheet:true,notice:null};
 const env={taskNavigationRef:{current:5},taskRefreshRef:{current:7},taskQueryRef:{current:['','','workspace-b',0].join('\u0000')},selectedTaskIdRef:{current:'beta-task'},taskWorkspaceId:'workspace-a',filter:'',query:'',taskOffset:0,
   setTaskSheet:v=>{state.sheet=v;},setCreatedTaskNotice:v=>{state.notice=v;},setSelectedTask:v=>{state.selected=v.id;},setTasks:v=>{state.tasks=typeof v==='function'?v(state.tasks):v;},rememberTask:v=>v,refresh:async()=>{state.refreshes++;env.taskRefreshRef.current++;}};
 const js=ts.transpileModule(createdCode,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const reveal=new Function(...Object.keys(env),js+';return showCreatedTask;')(...Object.values(env));
 await reveal({...task(1,0,'alpha-created'),status:'queued',workspaceId:'workspace-a'},5);
 assert.equal(state.selected,'beta-task','old creation cannot replace a selection in the new Workspace');
 assert.deepEqual(state.tasks.map(row=>row.id),['beta-task'],'old creation cannot enter the new Workspace list');
 assert.equal(state.notice?.id,'alpha-created','successful creation remains discoverable without switching scope');assert.equal(state.sheet,false);
 assert.equal(state.refreshes,0,'old scope must not supersede the active Workspace refresh');
 assert.equal(env.taskRefreshRef.current,7);
 console.log('PASS late Task creation respects a changed Workspace scope and its active refresh');
}
