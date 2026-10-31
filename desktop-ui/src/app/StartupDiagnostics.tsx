import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {bridge, diagnosticsClient, type DiagnosticsCheck, type DiagnosticsReport, type DiagnosticsState, type DiagnosticsSummary} from '../bridge/typed-client';
import {Button, Input, Select, Tabs} from '../components/primitives/inputs';
import {Sheet} from '../components/primitives/overlays';
import {Badge, LoadingState, Surface} from '../components/primitives/surfaces';
import {Icon} from '../components/icons';
import {WindowChrome} from './WindowChrome';
import {InteractionSuspensionContext} from '../components/primitives/interaction-suspension';
import './startup-diagnostics.css';

const statuses = new Set(['PASS', 'DEGRADED', 'BLOCKED', 'NOT_RUN']);
const labels = {PASS:'通过', DEGRADED:'功能受限', BLOCKED:'已阻止工作模式', NOT_RUN:'未检查'};
const stageLabels = {storage:'本地数据', core:'基础服务', extensions:'可选模块', transport:'本机通信'};
const titleOf = (check: DiagnosticsCheck) => {
  const known: Record<string,string> = {storage:'关键存储',workspace:'Workspace',task:'Task / Attempt',tasks:'Task / Attempt',capability:'Capability Broker',approval:'Policy / Approval',security:'权限与审批',memory:'Memory',journal:'事件与恢复',plugins:'Plugin Runtime',managed:'Managed Agent',agents:'外部 Agent',models:'模型服务',mcp:'MCP',git:'Git',forge:'GitHub / GitCode',qq:'QQ / Bionic',browser:'Browser Tools',environment:'Environment / AgentOS',shell:'Desktop Shell',ipc:'Native UI IPC',uiIpc:'Native UI IPC',data:'数据 IPC',dataIpc:'数据 IPC'};
  const key = check.id.split(/[.:-]/).find(part => Object.hasOwn(known,part));
  return (key && known[key]) || stageLabels[check.stage] || '服务检查';
};
const toneOf = (status: DiagnosticsCheck['status']) => status === 'PASS' ? 'success' : status === 'BLOCKED' ? 'danger' : status === 'DEGRADED' ? 'warning' : 'default';
const codeList = (report:DiagnosticsReport) => report.checks.filter(check=>check.status==='BLOCKED'||check.status==='DEGRADED').map(check=>check.code).filter(Boolean).join('\n') || 'PASS';
const stamp = (value:string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '时间未知';

/** Fail closed on a missing/stale host contract. A process existing is not readiness. */
export function validDiagnosticsState(value:unknown): value is DiagnosticsState {
  if(!value || typeof value !== 'object') return false;
  const state=value as DiagnosticsState, report=state.report;
  return typeof state.coreAvailable==='boolean' && !!report && report.schemaVersion===1 && typeof report.id==='string'
    && typeof report.generatedAt==='string' && ['PASS','DEGRADED','BLOCKED'].includes(report.status)
    && Array.isArray(report.checks) && report.checks.length>0 && report.checks.length<=100
    && report.checks.every(check=>check && typeof check.id==='string' && typeof check.code==='string' && typeof check.reason==='string' && typeof check.remediation==='string' && statuses.has(check.status))
    && !report.checks.some(check=>check.status==='BLOCKED'&&report.status!=='BLOCKED')
    && !report.checks.some(check=>check.status==='DEGRADED'&&report.status==='PASS')
    && !!report.feedback && typeof report.feedback.configured==='boolean';
}

export function diagnosticClientFailure(code:string, timedOut:boolean):DiagnosticsReport {
  return {schemaVersion:1,id:'client-bridge-unavailable',generatedAt:new Date().toISOString(),trigger:'runtime',status:'BLOCKED',
    product:{version:null,build:{buildId:null,commit:null,buildTime:null},runtime:{platform:null,arch:null,node:null}},
    checks:[{id:'ipc.renderer',stage:'transport',status:'BLOCKED',code,
      reason:timedOut?'等待本机诊断响应超时，尚未确认核心服务就绪。':'无法取得有效的本机诊断结果，尚未确认核心服务就绪。',
      remediation:'保留原始数据；重新检查本机连接，或通过官方反馈入口提交错误代码。不要重复执行结果未知的任务。',timedOut,durationMs:0}],
    unconfirmedEffects:null,feedback:{url:null,configured:false},retention:{maxReports:20,maxAgeDays:14,maxBytes:65536},persisted:false};
}

export async function boundedDiagnosticsRead(read:()=>Promise<DiagnosticsState>, timeoutMs=20000):Promise<DiagnosticsState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([read(), new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('diagnostic deadline'),{code:'DIAGNOSTICS_TIMEOUT'})),timeoutMs);})]);
    if(!validDiagnosticsState(result)) throw Object.assign(Error('invalid diagnostic contract'),{code:'DIAGNOSTICS_CONTRACT_INVALID'});
    return result;
  }finally{if(timer)clearTimeout(timer);}
}

type DiagnosticContextValue = {state:DiagnosticsState|null; busy:boolean; check(full?:boolean):Promise<void>; open():void};
const DiagnosticContext = createContext<DiagnosticContextValue|null>(null);

/** Contains the existing app; never initializes Core pages before a verified gate. */
export function StartupDiagnosticsBoundary({children}:{children:ReactNode}) {
  const [state,setState]=useState<DiagnosticsState|null>(null),[busy,setBusy]=useState(true),[open,setOpen]=useState(false),[admitted,setAdmitted]=useState(false);
  const active=useRef(true),flight=useRef<Promise<void>|null>(null),stateRef=useRef(state),revision=useRef(0),repeat=useRef(false);stateRef.current=state;
  const check=useCallback((full=false):Promise<void>=>{
    if(flight.current)return flight.current;
    setBusy(true);
    const startedRevision=revision.current;
    const task=(async()=>{
      try {
        const deadline=Date.now()+20000;
        let next=await boundedDiagnosticsRead(full?diagnosticsClient.run:diagnosticsClient.status);
        while(next.report?.checks.some(row=>row.code==='STARTUP_CHECKS_PENDING') && Date.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,300));
          if(!active.current)return;
          next=await boundedDiagnosticsRead(diagnosticsClient.status,Math.max(1,deadline-Date.now()));
        }
        if(next.report?.checks.some(row=>row.code==='STARTUP_CHECKS_PENDING'))throw Object.assign(Error('startup timeout'),{code:'DIAGNOSTICS_TIMEOUT'});
        // A previous PASS cannot admit a disconnected Core.
        if(!next.coreAvailable && next.report?.status!=='BLOCKED')next={report:diagnosticClientFailure('CORE_COMMUNICATION_LOST',false),coreAvailable:false};
        if(startedRevision!==revision.current){repeat.current=true;return;}
        if(active.current){setState(next);if(next.report?.status!=='BLOCKED' && next.coreAvailable)setAdmitted(true);}
      }catch(cause){
        const code=(cause as {code?:unknown})?.code;
        const known=code==='DIAGNOSTICS_TIMEOUT'||code==='DIAGNOSTICS_CONTRACT_INVALID'?code:'DIAGNOSTICS_IPC_UNAVAILABLE';
        if(startedRevision!==revision.current)repeat.current=true;
        else if(active.current)setState({report:diagnosticClientFailure(known,known==='DIAGNOSTICS_TIMEOUT'),coreAvailable:false});
      }finally{if(active.current)setBusy(false);flight.current=null;if(repeat.current&&active.current){repeat.current=false;queueMicrotask(()=>{if(active.current)void check();});}}
    })();
    flight.current=task;return task;
  },[]);
  useEffect(()=>{
    active.current=true;void check();
    const off=bridge.subscribe('core.status',data=>{
      revision.current++;
      if(data.ready===false&&stateRef.current)setState(previous=>({coreAvailable:false,report:previous?.report?.status==='BLOCKED'?previous.report:diagnosticClientFailure('CORE_COMMUNICATION_LOST',false)}));
      void check();
    });
    const changed=bridge.subscribe('diagnostics.updated',()=>{revision.current++;void check();});
    const restarted=bridge.subscribe('core.restarted',()=>{revision.current++;void check();});
    const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void check();},30000);
    return()=>{active.current=false;revision.current++;clearInterval(timer);off();changed();restarted();};
  },[check]);
  const report=state?.report;
  const blocked=report?.status==='BLOCKED'||state?.coreAvailable===false;
  const context={state,busy,check,open:()=>setOpen(true)};
  return <DiagnosticContext.Provider value={context}>
    {admitted&&<div className={`startup-normal ${blocked?'diagnostics-frozen':''}`} inert={blocked} aria-hidden={blocked||undefined}><InteractionSuspensionContext.Provider value={blocked}>{children}</InteractionSuspensionContext.Provider></div>}
    {!admitted&&!report&&<div className="diagnostics-startup"><WindowChrome/><main><LoadingState label="正在核对本机核心服务…"/><p>仅执行只读检查，不调用模型、不发送消息。</p></main></div>}
    {blocked&&report&&<div className="diagnostics-blocked"><WindowChrome/><main className="diagnostics-blocked-content"><header><span className="diagnostics-heading-icon"><Icon name="shield" size={25}/></span><div><p className="eyebrow">CETAMESH · STARTUP CHECK</p><h1>暂时无法进入工作模式</h1><p>核心通信或安全状态尚未可靠确认。原始数据保留，请先查看原因。</p></div></header><DiagnosticsPanel state={state} busy={busy} check={check} blocked/></main></div>}
    {!blocked&&!open&&report?.status==='DEGRADED'&&<aside className="diagnostics-status-bar" role="status"><Icon name="help" size={17}/><span>{report.checks.filter(row=>row.status==='DEGRADED').length} 项检查需要处理</span><Button compact variant="ghost" onClick={()=>setOpen(true)}>查看原因</Button></aside>}
    <Sheet open={open&&!blocked} onClose={()=>setOpen(false)} title="系统诊断"><DiagnosticsPanel state={state} busy={busy} check={check}/></Sheet>
  </DiagnosticContext.Provider>;
}

export function DiagnosticsEntry({label='系统诊断',compact=true}:{label?:string;compact?:boolean}) {
  const context=useContext(DiagnosticContext),[open,setOpen]=useState(false);
  return <><Button compact={compact} icon="shield" onClick={()=>context?context.open():setOpen(true)}>{label}</Button>{!context&&<Sheet open={open} onClose={()=>setOpen(false)} title="系统诊断"><DiagnosticsPanel/></Sheet>}</>;
}

export function FeedbackDeveloperButton({compact=true}:{compact?:boolean}) {
  const context=useContext(DiagnosticContext);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[url,setUrl]=useState<string|null>(null);
  async function openFeedback(){
    if(busy)return;setBusy(true);setNotice('');
    try{const result=await diagnosticsClient.feedback();setUrl(validOfficialUrl(result.url));setNotice(result.opened?'已交给系统默认浏览器。诊断资料由你自行决定是否提交。':result.url?'无法打开浏览器。请复制下方官方反馈地址，稍后访问。':'官方反馈地址尚未配置；本机报告仍保留。');}
    catch{setUrl(validOfficialUrl(context?.state?.report?.feedback.url));setNotice('反馈入口暂不可用。本机报告仍保留，请复制已配置的官方地址或在系统诊断中查看。');}
    finally{setBusy(false);}
  }
  return <span className="diagnostics-feedback-inline"><Button compact={compact} variant="ghost" icon="external" disabled={busy} onClick={()=>void openFeedback()}>反馈开发者</Button>{notice&&<small role="status">{notice}</small>}{url&&<Input aria-label="官方反馈地址" value={url} readOnly/>}</span>;
}

function validOfficialUrl(value:string|null|undefined){
  if(!value)return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.toString():null;}catch{return null;}
}

export function DiagnosticsReportView({report}:{report:DiagnosticsReport}) {
  const [filter,setFilter]=useState('attention'),[page,setPage]=useState(0);
  const issues=report.checks.filter(row=>row.status==='BLOCKED'||row.status==='DEGRADED');
  const rows=filter==='attention'?issues:report.checks;
  const current=Math.min(page,Math.max(0,Math.ceil(rows.length/20)-1));
  return <div className="diagnostics-report">
    <div className="diagnostics-report-summary"><Badge tone={toneOf(report.status)}>{labels[report.status]}</Badge><time dateTime={report.generatedAt}>{stamp(report.generatedAt)}</time><small>{report.trigger==='startup'?'启动检查':report.trigger==='runtime'?'运行中检查':'主动检查'}</small></div>
    {report.unconfirmedEffects!==false&&<p className="diagnostics-effects" role="note">{report.unconfirmedEffects?'存在尚未确认的执行副作用。请先核对任务与操作记录，避免重复执行。':'执行副作用状态尚未确认。诊断摘要不能替代任务的实际执行证据。'}</p>}
    <Tabs label="诊断检查范围" selected={filter} onChange={value=>{setFilter(value);setPage(0);}} items={[{id:'attention',label:`需要关注 ${issues.length}`},{id:'all',label:`全部检查 ${report.checks.length}`}]} />
    <div className="diagnostics-checks">{!rows.length&&<p className="muted">当前没有需要处理的故障。未检查的项目可在全部检查中查看。</p>}{rows.slice(current*20,current*20+20).map((row,index)=><Surface className="diagnostics-check" key={row.id+':'+index}><div className="diagnostics-check-heading"><strong>{titleOf(row)}</strong><Badge tone={toneOf(row.status)}>{row.timedOut?'检查超时':labels[row.status]}</Badge></div><p>{row.reason}</p>{row.status!=='PASS'&&row.remediation&&<p className="diagnostics-remediation">{row.remediation}</p>}<details><summary>错误代码与通信信息</summary><dl><dt>代码</dt><dd><code>{row.code}</code></dd><dt>检查项</dt><dd>{row.id}</dd><dt>阶段</dt><dd>{stageLabels[row.stage]||row.stage}</dd><dt>用时</dt><dd>{Number.isFinite(row.durationMs)?Math.round(row.durationMs)+' ms':'未知'}</dd></dl></details></Surface>)}</div>
    {rows.length>20&&<div className="diagnostics-pagination"><Button compact disabled={!current} onClick={()=>setPage(current-1)}>上一页</Button><small>{current*20+1}–{Math.min((current+1)*20,rows.length)} / {rows.length}</small><Button compact disabled={(current+1)*20>=rows.length} onClick={()=>setPage(current+1)}>下一页</Button></div>}
    <details className="diagnostics-metadata"><summary>版本与本机报告</summary><dl><dt>产品版本</dt><dd>{report.product?.version||'未取得'}</dd><dt>Shell 版本</dt><dd>{report.product?.shellVersion||'未取得'}</dd><dt>Build ID</dt><dd>{report.product?.build?.buildId||'未取得'}</dd><dt>Commit</dt><dd>{report.product?.build?.commit||'未取得'}</dd><dt>运行时</dt><dd>{[report.product?.runtime?.platform,report.product?.runtime?.arch,report.product?.runtime?.node,report.product?.runtime?.osVersion].filter(Boolean).join(' / ')||'未取得'}</dd><dt>运行标识</dt><dd>{report.id}</dd><dt>本机保存</dt><dd>{report.persisted?'已保存':report.id==='client-bridge-unavailable'?'尚未取得主机报告':'尚未存入历史；仍可导出当前报告'}</dd></dl></details>
  </div>;
}

export function DiagnosticsPanel({state:externalState,busy:externalBusy,check:externalCheck,blocked=false}:{state?:DiagnosticsState|null;busy?:boolean;check?:(full?:boolean)=>Promise<void>;blocked?:boolean}) {
  const context=useContext(DiagnosticContext),[local,setLocal]=useState<DiagnosticsState|null>(null),[ownBusy,setOwnBusy]=useState(false);
  const [selected,setSelected]=useState<DiagnosticsReport|null>(null),[history,setHistory]=useState<DiagnosticsSummary[]>([]),[notice,setNotice]=useState(''),[error,setError]=useState(''),[action,setAction]=useState(''),[feedbackUrl,setFeedbackUrl]=useState<string|null>(null);
  const alive=useRef(true),epoch=useRef(0),lock=useRef(false);
  const state=externalState??context?.state??local,busy=externalBusy??context?.busy??ownBusy,report=selected??state?.report;
  const currentCheck=externalCheck??context?.check;
  useEffect(()=>{alive.current=true;if(!currentCheck){setOwnBusy(true);void boundedDiagnosticsRead(diagnosticsClient.status).then(value=>{if(alive.current)setLocal(value);}).catch(()=>{if(alive.current)setLocal({report:diagnosticClientFailure('DIAGNOSTICS_IPC_UNAVAILABLE',false),coreAvailable:false});}).finally(()=>{if(alive.current)setOwnBusy(false);});}return()=>{alive.current=false;epoch.current++;};},[currentCheck]);
  async function run(){if(lock.current||busy)return;lock.current=true;epoch.current++;setSelected(null);setError('');setNotice('');setOwnBusy(true);try{if(currentCheck)await currentCheck(true);else{const value=await boundedDiagnosticsRead(diagnosticsClient.run);if(alive.current)setLocal(value);}}catch{if(alive.current)setError('检查未完成；上一份报告保留。请确认本机服务后重试。');}finally{if(alive.current)setOwnBusy(false);lock.current=false;}}
  async function loadHistory(){if(lock.current)return;lock.current=true;setAction('history');setError('');try{const value=await diagnosticsClient.history();if(alive.current)setHistory(Array.isArray(value.reports)?value.reports.slice(0,20):[]);}catch{if(alive.current)setError('历史报告暂时无法读取；当前诊断仍保留。');}finally{if(alive.current)setAction('');lock.current=false;}}
  async function selectReport(id:string){const request=++epoch.current;setAction('read');setError('');if(!id){setSelected(null);setAction('');return;}try{const value=await diagnosticsClient.read(id);if(alive.current&&request===epoch.current&&validDiagnosticsState({report:value.report,coreAvailable:false}))setSelected(value.report);}catch{if(alive.current&&request===epoch.current)setError('这份报告无法读取；当前报告未替换。');}finally{if(alive.current&&request===epoch.current)setAction('');}}
  async function copy(value:string){try{await navigator.clipboard.writeText(value);if(alive.current)setNotice('已复制。');}catch{if(alive.current)setError('剪贴板不可用。可选中下方内容后复制。');}}
  async function exportReport(){if(!report||report.id==='client-bridge-unavailable'||lock.current)return;lock.current=true;setAction('export');setError('');try{const result=await diagnosticsClient.export(report.id);if(alive.current)setNotice(result.exported?'已导出到你选择的本机文件。没有上传任何数据。':result.cancelled?'已取消导出；本机报告仍保留。':'未能导出；本机报告仍保留。');}catch{if(alive.current)setError('报告导出失败；本机原报告仍保留。');}finally{if(alive.current)setAction('');lock.current=false;}}
  async function feedback(){if(lock.current)return;lock.current=true;setAction('feedback');setError('');try{const result=await diagnosticsClient.feedback();if(alive.current){setFeedbackUrl(validOfficialUrl(result.url)||validOfficialUrl(report?.feedback.url));setNotice(result.opened?'已交给系统默认浏览器。你可以自行决定是否提交诊断报告。':result.url?'无法打开浏览器。请复制官方反馈地址，稍后访问。':'官方反馈页面尚未配置；请保留本机报告。');}}catch{if(alive.current){setFeedbackUrl(validOfficialUrl(report?.feedback.url));setError('无法打开浏览器。请复制已配置的官方地址，稍后访问。');}}finally{if(alive.current)setAction('');lock.current=false;}}
  const url=feedbackUrl||validOfficialUrl(report?.feedback.url);
  return <section className="diagnostics-panel" aria-label="系统诊断报告">
    <p className="diagnostics-intro">检查本机通信、关键存储与服务契约。不会发送 QQ 消息、调用付费模型、安装软件或创建虚拟机。</p>
    <div className="diagnostics-actions"><Button compact variant="primary" icon="refresh" disabled={busy||!!action} onClick={()=>void run()}>{busy?'正在检查…':'重新完整检查'}</Button><Button compact icon="clock" disabled={busy||!!action} onClick={()=>void loadHistory()}>历史诊断</Button><Button compact icon="update" disabled={busy||!!action||!report||report.id==='client-bridge-unavailable'} title={report?.id==='client-bridge-unavailable'?'尚未取得原生主机报告，请先重新检查':undefined} onClick={()=>void exportReport()}>导出诊断报告</Button><Button compact icon="external" disabled={!!action} onClick={()=>void feedback()}>反馈开发者</Button></div>
    {notice&&<p className="diagnostics-notice" role="status">{notice}</p>}{error&&<p className="diagnostics-error" role="alert">{error}</p>}
    {history.length>0&&<label className="diagnostics-history"><span>本机历史报告（最多 20 份）</span><Select label="选择诊断报告" value={selected?.id||''} disabled={!!action} onChange={event=>void selectReport(event.target.value)}><option value="">当前检查</option>{history.map(row=><option key={row.id} value={row.id}>{`${stamp(row.generatedAt)} · ${labels[row.status]}`}</option>)}</Select></label>}
    {busy&&!report?<LoadingState label="正在读取本机检查结果…"/>:report?<DiagnosticsReportView key={report.id} report={report}/>:<p role="status">尚未取得诊断报告。</p>}
    {report&&<div className="diagnostics-copy"><label><span>错误代码</span><Input aria-label="诊断错误代码" readOnly value={codeList(report).replaceAll('\n',', ')}/></label><Button compact disabled={!!action} onClick={()=>void copy(codeList(report))}>复制错误代码</Button></div>}
    {url&&<div className="diagnostics-copy"><label><span>官方反馈地址</span><Input aria-label="官方反馈地址" readOnly value={url}/></label><Button compact onClick={()=>void copy(url)}>复制反馈地址</Button></div>}
    <p className="diagnostics-privacy">报告默认仅保存在本机，包含白名单版本、状态和错误代码，不含聊天、Memory 正文或凭据。不会自动上传。{blocked?'核心状态恢复并通过检查后，才能返回工作模式。':''}</p>
  </section>;
}
