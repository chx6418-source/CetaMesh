// Source/SSR-only report presentation regression; no browser or native automation.
import assert from 'node:assert/strict';import path from 'node:path';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
const root=path.resolve(import.meta.dirname,'../desktop-ui'),require=createRequire(path.join(root,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const vite=await createServer({configFile:false,root,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'});
globalThis.window={setTimeout,clearTimeout};
try{
 const {diagnosticClientFailure,DiagnosticsReportView,DiagnosticsPanel}=await vite.ssrLoadModule('/src/app/StartupDiagnostics.tsx');
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const report=diagnosticClientFailure('DIAGNOSTICS_IPC_UNAVAILABLE',false);
 const cascadeReport={...report,checks:[{...report.checks[0],code:'STORAGE_CORRUPT'},...Array.from({length:18},(_,index)=>({...report.checks[0],id:'downstream.'+index,status:'NOT_RUN',code:'DOWNSTREAM_NOT_RUN_'+index,reason:'后续检查尚未执行',remediation:''}))]};
 const cascadeHtml=renderToStaticMarkup(React.createElement(DiagnosticsReportView,{report:cascadeReport}));
 assert.match(cascadeHtml,/需要关注 1</,'only the root BLOCKED fault counts as attention');
 assert.match(cascadeHtml,/全部检查 19</,'the All tab retains every not-run check');
 assert.equal((cascadeHtml.match(/class="cm-surface diagnostics-check"/g)||[]).length,1,'default view renders only one actionable root fault');
 assert.doesNotMatch(cascadeHtml,/DOWNSTREAM_NOT_RUN|后续检查尚未执行/,'downstream NOT_RUN checks do not flood default faults');
 const cascadePanel=renderToStaticMarkup(React.createElement(DiagnosticsPanel,{state:{report:cascadeReport,coreAvailable:false}}));
 assert.match(cascadePanel,/value="STORAGE_CORRUPT"/,'copy/display fault list excludes skipped downstream checks');
 const noFaultHtml=renderToStaticMarkup(React.createElement(DiagnosticsReportView,{report:{...cascadeReport,status:'PASS',checks:cascadeReport.checks.slice(1)}}));
 assert.match(noFaultHtml,/当前没有需要处理的故障/,'an empty attention view does not fall back to all checks');
 assert.doesNotMatch(noFaultHtml,/class="cm-surface diagnostics-check"/);
 console.log('PASS source/SSR-only: attention contains one BLOCKED fault; All tab retains 19 checks; NOT_RUN excluded from fault/copy list; empty attention stays empty');
}finally{await vite.close();delete globalThis.window;}
