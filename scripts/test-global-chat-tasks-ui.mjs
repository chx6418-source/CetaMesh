// Actual maintained Harbor components. These server-rendered checks supplement
// browser/native interaction suites; they do not claim Core execution or E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const uiRoot=path.resolve(import.meta.dirname,'../desktop-ui');
const require=createRequire(path.join(uiRoot,'package.json'));
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const vite=await createServer({configFile:false,root:uiRoot,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'});
globalThis.window={setTimeout,clearTimeout};
const base={id:'task-owned',title:'Preserve all review safeguards',goal:'Review exact source evidence',status:'running',currentPhase:'Inspect files',progress:{percent:null,note:'No measured percent'},workspaceId:null,agent:'codex',currentAgent:{provider:'codex',sessionId:'session-owned'},parentTaskId:null,verification:null,attemptCount:1,childOutputKind:null,attempts:[],children:[],createdAt:1,updatedAt:2,rev:8,checkpoint:{summary:'Stable evidence',nextAction:'Review'},result:null,artifacts:[],executionEvidence:[],agentHistory:[],failure:null};
const callbacks={onHandoff(){},onAction(){},onStart(){},onReconcile(){},onReview(){},onCreateChild(){},onComplete(){},onVerifyChild(){},onOpenChild(){}};
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
try{
 const ts=require('typescript'),source=fs.readFileSync(path.join(uiRoot,'src/app/HarborApp.tsx'),'utf8'),ast=ts.createSourceFile('HarborApp.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let inspectCode;function visit(node,owner=''){if(ts.isFunctionDeclaration(node)&&node.name?.text==='inspect'&&owner==='TaskRecoveryEvidence')inspectCode=node.getText(ast);if(ts.isFunctionDeclaration(node))owner=node.name?.text??owner;ts.forEachChild(node,child=>visit(child,owner));}visit(ast);assert.ok(inspectCode);
 let resolveInspection;const delayed=new Promise(resolve=>{resolveInspection=resolve;});let applied=0,errors=0;
 const inspectionEnv={identity:{current:'task-owned:8'},task:{id:'task-owned',rev:8},taskClient:{inspectRecovery:()=>delayed},setBusy(){},setInspection(){applied++;},setError(){errors++;},messageOf:error=>error.message};
 const inspect=new Function('env','with(env){return ('+inspectCode+')}')(inspectionEnv),pendingInspection=inspect();inspectionEnv.identity.current='task-owned:9';resolveInspection({taskRev:8,operations:[]});await pendingInspection;
 assert.equal(applied,0,'a late recovery inspection for an earlier Task revision cannot be shown as current proof');assert.equal(errors,0,'late revision inspection cannot overwrite current error state');
 console.log('PASS late read-only recovery proof is fenced by current Task revision');
 const ui=await vite.ssrLoadModule('/src/app/HarborApp.tsx');
 const createForm=render(ui.TaskCreateForm,{workspaces:[{id:'ws',name:'Synthetic project'}],activeWorkspaceId:'ws',providers:[
  {id:'codex',name:'Codex',eligible:true,reason:null},
  {id:'claude',name:'Claude',eligible:false,reason:'not_installed'},
  {id:'unknown',name:'Unavailable runtime',eligible:false,reason:'C:\\private-owner\\credential-SHOULD-NOT-APPEAR'}
 ],onCreated:async()=>{}});
 assert.match(createForm,/不可用执行者与恢复方法/,'Task form must expose the existing first rejection reason');
 assert.match(createForm,/Claude.*未安装/s,'uninstalled runtime must explain the actual first condition');
 assert.match(createForm,/重新检查.*重新打开/s,'safe rejection must include a usable next step');
 assert.doesNotMatch(createForm,/private-owner|SHOULD-NOT-APPEAR/,'unknown raw diagnostics cannot expose local paths');
 const readyForm=render(ui.TaskCreateForm,{workspaces:[],providers:[{id:'codex',name:'Codex',eligible:true,reason:null}],onCreated:async()=>{}});
 assert.doesNotMatch(readyForm,/不可用执行者与恢复方法/,'healthy providers do not acquire refusal diagnostics');
 const usage={inputTokens:81234,outputTokens:1234,totalTokens:82468,reasoningTokens:432,cacheReadTokens:null,cacheWriteTokens:null,cacheHitRate:null,requestCount:3,accountingComplete:false,cost:{status:'unknown',amount:null,knownAmount:0.1,currency:'USD',complete:false,sources:[],versions:[]}};
 const usageHtml=render(ui.UsageSummary,{usage,label:'会话累计用量'});
 assert.match(usageHtml,/<details[^>]*class="[^"]*usage-summary/,'usage details must be a disclosure');
 assert.doesNotMatch(usageHtml,/<details[^>]*\bopen(?:=|>)/,'usage is collapsed on first render');
 assert.match(usageHtml,/已知用量（不完整）/);assert.match(usageHtml,/缓存命中 未知/);assert.match(usageHtml,/已核算 USD 0.1/);
 assert.doesNotMatch(usageHtml,/缓存命中 0%/,'unknown usage remains unknown');
 console.log('PASS compact usage is initially collapsed and retains precise incomplete/cache/cost evidence');

 const tools=Array.from({length:1000},(_,i)=>({id:'internal-request-'+i,label:'filesystem.read',status:'completed',summary:'Receipt '+i,durationMs:1}));
 const toolHtml=render(ui.ToolActivity,{tools});
 assert.ok((toolHtml.match(/class="tool-call /g)||[]).length<=40,'1000 tools may not create an unbounded details list');
 assert.match(toolHtml,/已完成 1000/);assert.match(toolHtml,/下一组/,'remaining receipts must stay reachable');
 const opaque='958691c1-2135-4ac0-9b05-f204a14b1137:call_00_EfDxBFKAOxbMuCHGjLUj3155';
 const opaqueHtml=render(ui.ToolActivity,{tools:[{id:opaque,label:opaque,status:'failed',summary:'Exact parameter validation failed',durationMs:0}]});
 const visibleSummary=opaqueHtml.match(/<summary>(.*?)<\/summary>/s)?.[1];
 assert.ok(!visibleSummary.includes(opaque),'opaque ID must not become the visible tool name');assert.match(opaqueHtml,/调用标识/,'advanced diagnostic identity remains available');
 assert.match(opaqueHtml,/Exact parameter validation failed/);
 console.log('PASS large ToolCall receipts are paged; primary label excludes opaque IDs while diagnostic identity remains');

 const tasks=Array.from({length:1000},(_,i)=>({...base,id:'task-'+i,title:'Task '+i,status:i<500?'running':'completed'}));
 const list=render(ui.WorkTaskList,{tasks,workspaces:[],providers:[],onOpen(){},onAction(){}});
 assert.ok((list.match(/task-collaboration-card/g)||[]).length<=50,'attention Task DOM is paged');
 assert.ok((list.match(/class="task-history-row"/g)||[]).length<=50,'history Task DOM is paged');
 assert.match(list,/任务分页/);assert.match(list,/历史任务分页/);
 assert.match(list,/进度未报告/);assert.doesNotMatch(list,/aria-valuenow="0"/);
 console.log('PASS 1000 real-shape Task records render at most50 attention and50 history rows without invented percentages');

 const review={...base,execution:{state:'awaiting-review',hadToolActivity:false,hasEvidence:false},reviewReport:{eventId:'report-8',text:'Exact analysis-only report',sha256:'a'.repeat(64)}};
 const detail=render(ui.TaskDetails,{task:review,providers:[{id:'codex',name:'Codex',eligible:true}],...callbacks});
 for(const title of ['任务目标与进度','结果与交付','协作与子任务','执行证据','执行者与交接'])assert.ok(detail.includes(title),title+' remains reachable');
 assert.match(detail,/仅验收分析报告/);assert.match(detail,/Exact analysis-only report/);
 assert.match(detail,/<button[^>]*disabled=""[^>]*>确认结果/,'report-only result cannot be accepted without exact report review');
 const completed=render(ui.TaskDetails,{task:{...review,status:'completed',result:{summary:'VERIFIED_DELIVERY'}},providers:[],...callbacks});
 assert.ok(completed.indexOf('VERIFIED_DELIVERY')<completed.indexOf('任务累计用量'));assert.doesNotMatch(completed,/验收说明/);
 const recovery=render(ui.TaskDetails,{task:{...base,status:'blocked',currentAgent:null,progress:{percent:null,note:'needs-reconciliation: interrupted uncertain effect'}},providers:[{id:'codex',name:'Codex',eligible:true}],...callbacks});
 assert.match(recovery,/人工核对后恢复/);assert.match(recovery,/disabled=""[^>]*>确认核对并执行新指令/);
 assert.match(recovery,/不会重放中断前的工具调用/);
 console.log('PASS organized Task detail keeps result acceptance, explicit recovery and verified-result precedence safeguards');
}finally{await vite.close();delete globalThis.window;}
