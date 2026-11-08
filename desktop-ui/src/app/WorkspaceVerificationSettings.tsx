import {useEffect,useRef,useState} from 'react';
import {bridge,workspaceVerificationClient,type WorkspaceVerificationConfig,type WorkspaceVerificationView} from '../bridge/typed-client';
import {Button,Input,Textarea} from '../components/primitives/inputs';
import {messageOf} from './PagePresentation';

const defaults:WorkspaceVerificationConfig={enabled:false,tool:'npm',args:['test'],includeExtensions:['.js','.ts','.mjs'],timeoutMs:30000,maxRunsPerTurn:1};
const labels:Record<string,string>={pending:'待独立测试审批',running:'测试运行中',passed:'测试通过',failed:'测试失败',unknown:'测试结果未知','not-run':'未运行'};
export function WorkspaceVerificationSettings({workspaceId,onOpenTask}:{workspaceId:string;onOpenTask?:(id:string)=>void}) {
  const [view,setView]=useState<WorkspaceVerificationView|null>(null),[draft,setDraft]=useState(defaults);
  const [args,setArgs]=useState('["test"]'),[extensions,setExtensions]=useState(defaults.includeExtensions.join(', '));
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[retryBusy,setRetryBusy]=useState(false);
  const scope=useRef(workspaceId),generation=useRef(0),saving=useRef(false),retrying=useRef(false);scope.current=workspaceId;
  const apply=(value:WorkspaceVerificationView)=>{setView(value);setDraft(value.config??defaults);setArgs(JSON.stringify(value.config?.args??defaults.args));setExtensions((value.config?.includeExtensions??defaults.includeExtensions).join(', '));};
  useEffect(()=>{let alive=true,statusRequest=0;setView(null);setError('');setNotice('');setBusy(false);setRetryBusy(false);saving.current=false;retrying.current=false;generation.current++;
    void workspaceVerificationClient.get(workspaceId).then(value=>{if(alive)apply(value);}).catch(cause=>{if(alive)setError(messageOf(cause));});
    const refresh=()=>{const request=++statusRequest;void workspaceVerificationClient.get(workspaceId).then(value=>{if(alive&&request===statusRequest)setView(current=>current?{...current,checks:value.checks}:current);}).catch(()=>{});};
    const subscriptions=[bridge.subscribe('task.updated',refresh),bridge.subscribe('approval.pending',refresh),bridge.subscribe('approval.resolved',refresh),bridge.subscribe('approval.operation',refresh)];
    return()=>{alive=false;for(const unsubscribe of subscriptions)unsubscribe();};},[workspaceId]);
  async function save(){if(!view||saving.current)return;const currentScope=workspaceId,epoch=generation.current;saving.current=true;setBusy(true);setError('');setNotice('');
    try{const parsed:unknown=JSON.parse(args);if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=='string'))throw Error('测试参数必须是字符串 JSON 数组');
      const result=await workspaceVerificationClient.update(workspaceId,{...draft,args:parsed,includeExtensions:extensions.split(',').map(value=>value.trim()).filter(Boolean)},view.configDigest);
      if(scope.current===currentScope&&generation.current===epoch){apply(result);setNotice('配置已保存；后续检查仍需独立审批。');}}
    catch(cause){if(scope.current===currentScope&&generation.current===epoch)setError(messageOf(cause));}finally{if(scope.current===currentScope&&generation.current===epoch){saving.current=false;setBusy(false);}}}
  async function reload(){setError('');try{const value=await workspaceVerificationClient.get(workspaceId);if(scope.current===workspaceId)apply(value);}catch(cause){setError(messageOf(cause));}}
  async function retry(taskId:string,approvalId:string){if(retrying.current||saving.current)return;const currentScope=workspaceId,epoch=generation.current;
    retrying.current=true;setRetryBusy(true);setError('');setNotice('');
    try {await workspaceVerificationClient.retry(workspaceId,taskId,approvalId);const value=await workspaceVerificationClient.get(workspaceId);
      if(scope.current===currentScope&&generation.current===epoch){setView(current=>current?{...current,checks:value.checks}:current);setNotice('已重新申请独立审批；尚未执行测试。');}}
    catch(cause){if(scope.current===currentScope&&generation.current===epoch)setError(messageOf(cause));}
    finally{if(scope.current===currentScope&&generation.current===epoch){retrying.current=false;setRetryBusy(false);}}}
  return <section aria-label="写后验证设置" className="task-detail-section">
    <h3>写入与导入后的验证</h3><p>保存配置不会执行测试，也不会授予测试权限。每次测试使用独立审批；测试通过仍需人工确认目标。记录对应当时的检查，当前文件需另行核验。</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!view?<p>正在读取配置…</p>:<fieldset disabled={busy}>
      <label><input type="checkbox" aria-label="启用写后验证" checked={draft.enabled} onChange={event=>setDraft({...draft,enabled:event.target.checked})}/>启用写后验证</label>
      <label>测试工具<select aria-label="测试工具" value={draft.tool} onChange={event=>setDraft({...draft,tool:event.target.value as 'npm'|'cargo'})}><option value="npm">npm</option><option value="cargo">cargo</option></select></label>
      <label>测试参数（JSON 数组）<Textarea aria-label="测试参数" value={args} onChange={event=>setArgs(event.target.value)}/></label>
      <label>匹配扩展名（逗号分隔）<Input aria-label="匹配扩展名" value={extensions} onChange={event=>setExtensions(event.target.value)}/></label>
      <label>超时毫秒<Input aria-label="超时毫秒" type="number" min={1000} max={600000} value={draft.timeoutMs} onChange={event=>setDraft({...draft,timeoutMs:Number(event.target.value)})}/></label>
      <label>每轮检查上限<select aria-label="每轮检查上限" value={draft.maxRunsPerTurn} onChange={event=>setDraft({...draft,maxRunsPerTurn:Number(event.target.value)})}><option value={0}>0（不请求）</option><option value={1}>1</option><option value={2}>2</option></select></label>
      <div className="row"><Button compact onClick={()=>void save()}>保存验证配置</Button><Button compact variant="ghost" onClick={()=>void reload()}>重新载入配置</Button></div>
    </fieldset>}
    <div aria-label="验证检查记录">{view?.checks.map(check=><details key={check.eventId}>
      <summary>{labels[check.state]??check.state} · {check.currentRun?'当前运行':'历史运行'} · {check.provider}</summary>
      <p>任务 {check.taskId} · 测试退出码 {check.exitCode??'未取得'}</p>
      {check.code&&<p>{check.code==='APPROVAL_EXPIRED'?'审批已过期，测试未运行。重新申请会核验原检查的源、配置与当前权限。':check.code==='POST_WRITE_TEST_GRANT_REQUIRED'?'任务缺少 test.run 请求权限；请由 Owner 为该任务明确配置权限，再对新检查独立审批。':check.code}</p>}
      {check.approvalId&&<p>审批编号 {check.approvalId}{check.state==='pending'?'；请在审批中心作出独立决定。':'；保留历史记录。'}</p>}
      {check.canRetry&&check.approvalId&&<Button compact disabled={retryBusy||busy} onClick={()=>void retry(check.taskId,check.approvalId!)}>重新申请检查</Button>}
      {check.diagnostics&&<pre>{check.diagnostics.stdout}{check.diagnostics.stderr}</pre>}
      {onOpenTask&&<Button compact onClick={()=>onOpenTask(check.taskId)}>查看任务与检查证据</Button>}
    </details>)}{view&&!view.checks.length&&<p>尚无检查记录；没有运行测试。</p>}</div>
  </section>;
}
