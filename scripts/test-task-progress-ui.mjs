import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(root + 'package.json');
const ts = require('typescript');
const source = fs.readFileSync(root + 'src/app/HarborApp.tsx', 'utf8');
const ast = ts.createSourceFile('HarborApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let code, finishCode, openCode, rememberCode;
function walk(node, owner = '') {
  if (owner === 'WorkPage' && ts.isFunctionDeclaration(node) && node.name?.text === 'openTask') openCode = node.getText(ast);
  if (owner === 'WorkPage' && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'rememberTask') rememberCode = node.initializer.arguments[0].getText(ast);
  if (owner === 'WorkPage' && ts.isFunctionDeclaration(node) && node.name?.text === 'finishTask') finishCode = node.getText(ast);
  if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? owner;
  if (owner === 'WorkPage' && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'refresh') code = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, child => walk(child, owner));
}
walk(ast); assert.ok(code);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const task = (rev, percent, id = 'T') => ({ id, rev, status: percent === 100 ? 'completed' : 'running', progress: { percent } });
function harness(client, initial = [], selected = null) {
  const state = { tasks: initial, selected, error: '', loading: false };
  const env = { query: '', filter: '', selectedTaskIdRef: { current: selected?.id ?? '' }, taskNavigationRef: { current: 0 }, taskRefreshRef: { current: 0 }, taskQueryRef: { current: '\u0000' },
    setLoading: v => { state.loading=v; }, setError: v => { state.error=v; },
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
    const card=renderToStaticMarkup(React.createElement(ChatContextPanel,{task:reviewTask,memories:[],approvals:[],onOpenMemory(){}}));assert.ok(card.includes('待验收'),'settled run must not say still running');
    const detail=renderToStaticMarkup(React.createElement(TaskDetails,{task:reviewTask,providers:[],onHandoff(){},onAction(){},onStart(){},onReconcile(){},onReview(){},onCreateChild(){},onComplete(){},onVerifyChild(){}}));assert.ok(detail.includes('Exact report to review'));assert.ok(detail.includes('仅验收分析报告'));assert.match(detail,/<input[^>]*type="checkbox"/);assert.doesNotMatch(detail,/<input[^>]*checked=""/);
  }finally {await vite.close();delete globalThis.window;}
});
await check('production CSS closure defines progress track dimensions and fill',async()=>{
  const seen=new Set(),styles=[];function visit(file) {if(seen.has(file))return;seen.add(file);const content=fs.readFileSync(file,'utf8');if(file.endsWith('.css')) {styles.push(content);return;}const ast=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true);for(const node of ast.statements){if(!ts.isImportDeclaration(node)||!node.moduleSpecifier?.text.startsWith('.'))continue;const base=path.resolve(path.dirname(file),node.moduleSpecifier.text);const resolved=[base,...['.ts','.tsx','.js','/index.ts','/index.tsx'].map(ext=>base+ext)].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());if(resolved)visit(resolved);}}
  visit(root+'src/main.tsx');const rules=[];require('postcss').parse(styles.join('\n')).walkRules(rule=>{if(rule.selector.split(',').some(s=>s.trim()==='.progress-track'))rules.push(...rule.nodes.filter(n=>n.type==='decl').map(n=>[n.prop,n.value]));});
  assert.ok(rules.some(([prop,value])=>prop==='height'&&value!=='0'));assert.ok(rules.some(([prop])=>prop==='background'));
});
assert.equal(failures.length,0,failures.join('; '));
