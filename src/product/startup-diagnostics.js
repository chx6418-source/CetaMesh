// Startup checks compose existing domain contracts; they never execute work or grant authority.
// Reports are local, explicitly whitelisted, bounded and independent of business data.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {readJsonFile,parseJsonText,writeJsonAtomic} from '../storage/json-file.js';
import {assertNoLinks} from '../migration/inventory.js';
import {assertTaskSchema} from '../task/store.js';
import {assertMemorySchema} from '../memory/store.js';
import {normalizeSettings,SETTINGS_SCHEMA_VERSION} from '../settings/schema.js';
import {buildDiagnostics} from './diagnostics.js';
import {buildFeedbackLinks} from './feedback-links.js';

export const DIAGNOSTIC_RETENTION=Object.freeze({maxReports:20,maxAgeDays:14,maxBytes:65536});
const REPORT_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const states=['PASS','DEGRADED','BLOCKED','NOT_RUN'];
const CODES=new Set(['CHECK_OK','CHECK_FAILED','CHECK_TIMEOUT','CHECK_BUDGET_EXHAUSTED','CHECK_CONTRACT_INVALID','CHECK_NOT_RUN','STORAGE_VALID','STORAGE_INVALID','STORAGE_CHANGED','CORE_COMPOSITION_FAILED','CORE_DEPENDENCY_BLOCKED','RECONCILIATION_REQUIRED','LOCAL_LIFECYCLE_ONLY','SESSION_PROBE_NOT_RUN','MODEL_REQUEST_NOT_RUN','MCP_STOPPED','MCP_NOT_CONFIGURED','MCP_DISCOVERY_ONLY','REMOTE_API_NOT_RUN','QQ_STOPPED','QQ_NOT_CONFIGURED','QQ_READ_ONLY_READY','BROWSER_EXECUTION_NOT_RUN','ENVIRONMENT_NOT_RUN','DATA_IPC_VALID','DATA_IPC_INVALID','IPC_AUTH_DENIED','UNSUPPORTED_VERSION','IPC_HANDSHAKE_INVALID','IPC_FRAME_INVALID','IPC_DISCONNECTED','PLUGIN_LAZY_NOT_RUN','DIAGNOSTIC_REPORT_INVALID']);
const fault=code=>Object.assign(new Error(code),{code});
const aggregate=checks=>checks.some(x=>x.status==='BLOCKED')?'BLOCKED':checks.some(x=>x.status==='DEGRADED')?'DEGRADED':'PASS';
const names={storage:'关键数据',settings:'设置与安全配置',tasks:'Task / Attempt',workspace:'Workspace',memory:'Memory',capability:'Capability Broker / Policy',approval:'Approval',journal:'执行账本与恢复',plugins:'Plugin Runtime',managed:'Managed Agent',agents:'外部 Agent',models:'Model Provider',mcp:'MCP',forge:'Git / GitHub / GitCode',qq:'OneBot / QQ / 旧版 Bionic',browser:'Browser Tools',environment:'Environment / AgentOS',dataIpc:'数据 IPC',uiIpc:'Native UI IPC'};
const instructions={storage:'保留原始数据，从可信备份核对或交由开发者分析；不要重置。',capability:'停止执行任务，检查安全策略和版本后重新检查。',approval:'保留审批数据并核对原始文件；不得绕过审批。',journal:'在 Task 恢复页面核对未知副作用后继续；不要盲目重试。',agents:'在 Agent 页面检查安装、连接和授权；自检不会创建付费会话。',models:'在设置中检查模型配置；自检不发送模型请求。',mcp:'在 Plugin Center 检查对应服务；自检不启动或调用工具。',qq:'在 Plugin Center 检查 QQ 与 Bionic；自检不发送消息。',dataIpc:'检查 Core 数据通信及版本，重新检查或重启已确认停止的 Core。',uiIpc:'检查原生 UI 通信及版本；保持当前报告供分析。'};
function result(check,status,code,durationMs=0,timedOut=false){
 const id=Object.hasOwn(names,check.id)?check.id:'core';
 code=CODES.has(code)?code:'CHECK_FAILED';
 return {id,stage:['storage','core','extensions','transport'].includes(check.stage)?check.stage:'core',status,code,
  reason:`${names[id]??'服务检查'}：${status==='PASS'?'只读契约响应有效':status==='NOT_RUN'?'未执行真实能力调用':timedOut?'检查超时':'当前检查未通过'}`,
  remediation:status==='PASS'?'无需操作。':instructions[id]??instructions.storage,timedOut,durationMs:Math.max(0,Math.round(durationMs))};
}
export async function runDiagnosticChecks(checks,{perCheckMs=1200,totalMs=15000}={}){
 const rows=[],deadline=Date.now()+totalMs;
 for(const check of checks){
  const start=Date.now(),budget=Math.min(check.timeoutMs??perCheckMs,deadline-start);
  if(budget<=0){rows.push(result(check,check.critical?'BLOCKED':'NOT_RUN','CHECK_BUDGET_EXHAUSTED',0,true));continue;}
  const controller=new AbortController();let timer;
  try{
   const value=await Promise.race([Promise.resolve().then(()=>check.run(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fault('CHECK_TIMEOUT'));},budget);})]);
   if(value!==true&&(!object(value)||!states.includes(value.status)))throw fault('CHECK_CONTRACT_INVALID');
   const status=value===true?'PASS':value.status;
   // Codes are defined by the check, never by exception messages or user data.
   const code=value===true?'CHECK_OK':CODES.has(value.code)?value.code:status==='PASS'?'CHECK_OK':'CHECK_NOT_RUN';
   rows.push(result(check,status,code,Date.now()-start));
  }catch(error){rows.push(result(check,check.critical?'BLOCKED':'DEGRADED',CODES.has(error?.code)?error.code:'CHECK_FAILED',Date.now()-start,error?.code==='CHECK_TIMEOUT'));}
  finally{clearTimeout(timer);controller.abort();}
 }
 return rows;
}

// Validate existing files before any Domain constructor can recover/write state.
// Reuse storage parsing, canonical no-link validation and the original domain schemas.
export async function preflightCriticalStorage({stateDir,timeoutMs=5000}={}){
 const checks=[];let totalBytes=0,unconfirmedEffects=false,activeFile='storage';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const validObject=v=>{if(!object(v))throw fault('STORAGE_INVALID');};
 const recordMap=v=>{validObject(v);if(Object.keys(v).length>50000||Object.values(v).some(row=>!object(row)))throw fault('STORAGE_INVALID');};
 const files=[
  ['settings/settings.json',v=>{if(v?.schemaVersion!==SETTINGS_SCHEMA_VERSION||!Number.isSafeInteger(v.revision)||v.revision<1)throw fault('STORAGE_INVALID');normalizeSettings(v.settings,{strict:true});}],
  ['tasks/tasks.json',v=>assertTaskSchema(v,'tasks')],['memory/memories.json',v=>assertMemorySchema(v,'memory')],
  ['workspaces.json',v=>{if(v?.version!==1||!['workspaces','pending','activity'].every(k=>Array.isArray(v[k])))throw fault('STORAGE_INVALID');const ids=new Set();for(const row of v.workspaces){if(!object(row)||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.root!=='string')throw fault('STORAGE_INVALID');ids.add(row.id);}}],
  ['capability/approvals.json',v=>{if(!Array.isArray(v)||v.length>1000||v.some(r=>!object(r)||typeof r.id!=='string'||!['pending','approved','consumed','rejected','cancelled','revoked','expired','active','executing','failed'].includes(r.status)))throw fault('STORAGE_INVALID');}],
  ['capability/task-grants.json',v=>{recordMap(v);for(const row of Object.values(v))if(!['capabilities','workspaceIds','taskIds','scopes','types'].every(k=>Array.isArray(row[k])&&row[k].every(x=>typeof x==='string')))throw fault('STORAGE_INVALID');}],
  ...['requests','dispatches','operations'].map(n=>[`capability/${n}.json`,v=>{recordMap(v);const allowed=n==='requests'?['in-flight','completed','failed']:n==='dispatches'?['prepared','started','completed','failed','failed-no-effect','outcome-unknown','compensated']:['accepted','running','waiting','unknown','completed','failed','cancelled','rejected'];if(Object.entries(v).some(([key,r])=>n==='dispatches'&&key.startsWith('operation-request:')?typeof r.operationKey!=='string'||!Object.hasOwn(v,r.operationKey)||typeof r.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(r.fingerprint):!allowed.includes(r.status)))throw fault('STORAGE_INVALID');}]),
  ...['tool-executions','tool-continuations'].map(n=>[`model/${n}.json`,recordMap]),
  ['continuity/policy.json',validObject],['continuity/monitor.json',validObject],['continuity/rollovers.json',v=>{if(!object(v)||(v.schemaVersion!==undefined&&![1,2].includes(v.schemaVersion))||!Array.isArray(v.rollovers)||(v.automaticBudgets!==undefined&&!object(v.automaticBudgets)))throw fault('STORAGE_INVALID');}],
  ['channel/delivery.json',v=>{if(v?.version!==1||!Array.isArray(v.events)||!object(v.consumers))throw fault('STORAGE_INVALID');for(const c of Object.values(v.consumers)){if(!object(c)||!object(c.deliveries)||!Number.isSafeInteger(c.cursor))throw fault('STORAGE_INVALID');for(const s of Object.values(c.deliveries)){if(!['in-flight','outcome-unknown','acknowledged','denied','retry-authorized'].includes(s))throw fault('STORAGE_INVALID');if(['in-flight','outcome-unknown','retry-authorized'].includes(s))unconfirmedEffects=true;}}}],
  ['qq-send-ledger.json',v=>{if(v?.version!==1||!Array.isArray(v.records)||v.records.some(r=>!object(r)||!['sent','acknowledged','outcome-unknown'].includes(r.status)))throw fault('STORAGE_INVALID');if(v.records.some(r=>r.status==='outcome-unknown'))unconfirmedEffects=true;}]
 ];
 async function inspect(relative,validate){
  const file=path.join(stateDir,relative);assertNoLinks(file);
  let handle;
  try{
   handle=await fs.promises.open(file,'r');const stat=await handle.stat();
   if(!stat.isFile()||stat.size>32*1024*1024||(totalBytes+=stat.size)>128*1024*1024)throw fault('STORAGE_INVALID');
   const bytes=await handle.readFile({signal:controller.signal});
   const value=parseJsonText(bytes.toString('utf8'));validate(value);
   // Domain stores carry their own durable truth. Only a boolean crosses diagnostic boundary.
   if(relative.endsWith('tasks.json')&&value.tasks.some(t=>(t.attempts??[]).some(a=>['unknown'].includes(a.state))||/needs-reconciliation/.test(t.progress?.note??'')))unconfirmedEffects=true;
   if(object(value)&&Object.values(value).some(r=>object(r)&&['in-flight','started','outcome-unknown','unknown','orphaned','prepared'].includes(r.status??r.state)))unconfirmedEffects=true;
   const after=await handle.stat();if(after.mtimeMs!==stat.mtimeMs||after.size!==stat.size)throw fault('STORAGE_CHANGED');
  }catch(error){if(error.code!=='ENOENT')throw error;}finally{await handle?.close();}
 }
 try{
  for(const [file,validate]of files){activeFile=file;if(controller.signal.aborted)throw fault('CHECK_TIMEOUT');await inspect(file,validate);}
  const txnDir=path.join(stateDir,'continuity/transactions');assertNoLinks(txnDir);
  let entries=[];try{entries=await fs.promises.readdir(txnDir);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(entries.length>5000)throw fault('STORAGE_INVALID');
  for(const entry of entries){if(!/^[A-Za-z0-9_.-]+\.json$/.test(entry))continue;await inspect('continuity/transactions/'+entry,v=>{if(!object(v)||!['prepared','committed','rolled-back','failed','reconciled'].includes(v.state))throw fault('STORAGE_INVALID');if(v.state==='prepared')unconfirmedEffects=true;});}
  checks.push(result({id:'storage',stage:'storage'},'PASS','STORAGE_VALID'));
 }catch(error){const domain=activeFile.startsWith('tasks/')?'tasks':activeFile.startsWith('memory/')?'memory':activeFile.startsWith('capability/')?'capability':activeFile.startsWith('settings/')?'settings':activeFile==='workspaces.json'?'workspace':'journal';checks.push(result({id:domain,stage:'storage'},'BLOCKED',controller.signal.aborted?'CHECK_TIMEOUT':'STORAGE_INVALID',0,controller.signal.aborted));unconfirmedEffects=null;}
 finally{clearTimeout(timer);}
 return {status:aggregate(checks),checks,unconfirmedEffects};
}

function reportDirectory(stateDir){const dir=path.join(stateDir,'diagnostics');assertNoLinks(dir);return dir;}
function normalizeReport(report){
 // Only our own strict generated reports are accepted from disk; arbitrary error text is never re-exported.
 if(report?.schemaVersion!==1||!REPORT_ID.test(report.id)||!['PASS','DEGRADED','BLOCKED'].includes(report.status)||!Array.isArray(report.checks)||report.checks.length>60)throw fault('DIAGNOSTIC_REPORT_INVALID');
 if(!Number.isFinite(Date.parse(report.generatedAt)))throw fault('DIAGNOSTIC_REPORT_INVALID');
 const identity=x=>typeof x==='string'&&/^[A-Za-z0-9.+_-]{1,100}$/.test(x)?x:null;
 const p=report.product??{},b=p.build??{},rt=p.runtime??{};
 const checks=report.checks.map(c=>result(c,states.includes(c.status)?c.status:'BLOCKED',/^[A-Z0-9_.-]{1,64}$/.test(c.code??'')?c.code:'DIAGNOSTIC_REPORT_INVALID',c.durationMs,c.timedOut===true));
 // Reconstruct from trusted configured link at read boundary, never arbitrary persisted URLs/text.
 return {schemaVersion:1,id:report.id,generatedAt:new Date(report.generatedAt).toISOString(),trigger:['startup','manual','runtime'].includes(report.trigger)?report.trigger:'manual',status:aggregate(checks),
  product:{version:identity(p.version),shellVersion:identity(p.shellVersion),build:{buildId:identity(b.buildId),commit:typeof b.commit==='string'&&/^[a-f0-9]{7,64}$/i.test(b.commit)?b.commit:null,buildTime:Number.isFinite(Date.parse(b.buildTime))?new Date(b.buildTime).toISOString():null},runtime:{platform:identity(rt.platform??rt.os),arch:identity(rt.arch),node:identity(rt.node),osVersion:identity(rt.osVersion)}},
  checks,unconfirmedEffects:typeof report.unconfirmedEffects==='boolean'?report.unconfirmedEffects:null,feedback:{url:null,configured:false},retention:{...DIAGNOSTIC_RETENTION},persisted:report.persisted===true};
}
export function createStartupDiagnostics({stateDir,aboutInfo=()=>null,releaseConfig=null,checks=()=>[],initialChecks=[],unconfirmedEffects=null,preflight=()=>preflightCriticalStorage({stateDir}),now=()=>Date.now(),publish=()=>{}}={}){
 let current=null,pending=null,closed=false,monitor=null,lastHealthSignature=null;
 const directory=()=>reportDirectory(stateDir);
 const projected=raw=>{const report=normalizeReport(raw);const links=buildFeedbackLinks({config:releaseConfig,aboutInfo:aboutInfo()});const url=links.entries.find(e=>e.id==='bug')?.url??null;report.feedback={url,configured:Boolean(url)};return report;};
 function reportFiles(){let names;try{names=fs.readdirSync(directory());}catch(e){if(e.code==='ENOENT')return [];throw e;}
  return names.filter(n=>REPORT_ID.test(n.replace(/\.json$/,''))&&n.endsWith('.json')).map(n=>{const file=path.join(directory(),n);const stat=fs.lstatSync(file);return {file,stat};}).filter(x=>x.stat.isFile()&&!x.stat.isSymbolicLink()).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
 }
 function history(){const list=[];for(const {file,stat}of reportFiles().slice(0,DIAGNOSTIC_RETENTION.maxReports)){if(stat.size>DIAGNOSTIC_RETENTION.maxBytes||stat.mtimeMs<now()-14*86400000)continue;try{list.push(projected(readJsonFile(file,{maxBytes:DIAGNOSTIC_RETENTION.maxBytes})));}catch{continue; /* A corrupt diagnostic is retained but cannot be displayed as trusted evidence. */}}return list;}
 function read(id){if(!REPORT_ID.test(id))throw fault('Invalid report id');const file=path.join(directory(),id+'.json');assertNoLinks(file);return projected(readJsonFile(file,{maxBytes:DIAGNOSTIC_RETENTION.maxBytes}));}
 function persist(report){
  try{
   const dir=directory();fs.mkdirSync(dir,{recursive:true});
   // Bounded retention touches only our UUID JSON diagnostics, never original business data.
   for(const {file,stat}of reportFiles().slice(DIAGNOSTIC_RETENTION.maxReports-1))fs.unlinkSync(file);
   for(const {file,stat}of reportFiles())if(stat.mtimeMs<now()-DIAGNOSTIC_RETENTION.maxAgeDays*86400000)fs.unlinkSync(file);
   report.persisted=true;if(Buffer.byteLength(JSON.stringify(report))>DIAGNOSTIC_RETENTION.maxBytes)throw fault('DIAGNOSTIC_TOO_LARGE');
   writeJsonAtomic(path.join(dir,report.id+'.json'),report);
  }catch{report.persisted=false;}
 }
 async function run(trigger='manual',{light=false}={}){
  if(pending)return pending;
  if(closed)throw fault('DIAGNOSTICS_CLOSED');
  pending=(async()=>{
   const storage=await preflight();
   unconfirmedEffects=storage.unconfirmedEffects;
   const rows=[...storage.checks,...initialChecks];
   if(storage.status!=='BLOCKED')rows.push(...await runDiagnosticChecks(await checks({light}),{totalMs:10000}));
   else for(const id of Object.keys(names).filter(id=>!rows.some(r=>r.id===id)))rows.push(result({id,stage:['dataIpc','uiIpc'].includes(id)?'transport':['plugins','managed','agents','models','mcp','forge','qq','browser','environment'].includes(id)?'extensions':'core'},'NOT_RUN','CORE_DEPENDENCY_BLOCKED'));
   if(rows.some(row=>row.code==='RECONCILIATION_REQUIRED'))unconfirmedEffects=true;
   const base=buildDiagnostics({aboutInfo:aboutInfo(),now});
   const links=buildFeedbackLinks({config:releaseConfig,aboutInfo:aboutInfo()});
   const bug=links.entries.find(e=>e.id==='bug');
   const report={schemaVersion:1,id:crypto.randomUUID(),generatedAt:new Date(now()).toISOString(),trigger:['startup','manual','runtime'].includes(trigger)?trigger:'manual',status:aggregate(rows),
    product:{version:base.product.version,shellVersion:base.product.shellVersion,build:base.build,runtime:{platform:base.platform.os,arch:base.platform.arch,node:base.platform.node,osVersion:os.release()}},checks:rows,
    unconfirmedEffects,feedback:{url:bug?.url??null,configured:Boolean(bug?.url)},retention:{...DIAGNOSTIC_RETENTION},persisted:false};
   report.summary=report.status==='PASS'?'核心只读检查通过。可选能力的真实执行仍以各自授权和状态为准。':report.status==='BLOCKED'?'核心通信、安全或数据检查未通过，已阻止正常工作。':'核心服务可用，部分功能受限；查看检查项后处理。';
   current=report;
   const signature=JSON.stringify([report.status,report.checks.map(c=>[c.id,c.status,c.code]),report.unconfirmedEffects]);
   if(trigger!=='runtime'||signature!==lastHealthSignature){persist(report);publish(report);}
   lastHealthSignature=signature;
   return structuredClone(report);
  })().finally(()=>{pending=null;});return pending;
 }
 return {run,history,read,status:()=>({report:current?structuredClone(current):null}),blocked:()=>current===null||current.status==='BLOCKED',
  startMonitoring(intervalMs=30000){
   if(monitor)return;
   const tick=async()=>{
    try{await run('runtime',{light:true});}
    catch{
     // Failed monitoring cannot leave a previous PASS open or leak raw errors.
     if(!closed&&current){current={...current,id:crypto.randomUUID(),generatedAt:new Date(now()).toISOString(),trigger:'runtime',status:'BLOCKED',unconfirmedEffects:null,persisted:false,
       checks:[result({id:'core',stage:'core'},'BLOCKED','CHECK_FAILED')]};persist(current);publish(current);}
    }
    if(!closed){monitor=setTimeout(tick,Math.max(1000,intervalMs));monitor.unref?.();}
   };
   monitor=setTimeout(tick,Math.max(1000,intervalMs));monitor.unref?.();
  },
  close(){closed=true;clearTimeout(monitor);},
  async execute({method,params={}}={}){const suffix=String(method).replace(/^ui\.diagnostics\./,'');const keys=Object.keys(params);if(keys.some(k=>k!=='id')||(!['read'].includes(suffix)&&keys.length))throw fault('INVALID_PARAMS');
   if(suffix==='status')return this.status();if(suffix==='run')return {report:await run('manual')};if(suffix==='history')return {reports:history()};if(suffix==='read')return {report:read(params.id)};throw fault('METHOD_NOT_FOUND');}
 };
}
