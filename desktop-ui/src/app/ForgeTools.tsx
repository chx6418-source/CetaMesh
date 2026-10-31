import {useEffect, useRef, useState} from 'react';
import {Button, Input, SearchInput, Select, Tabs, Textarea} from '../components/primitives/inputs';
import {Dialog} from '../components/primitives/overlays';
import {Badge, Card} from '../components/primitives/surfaces';
import './ForgeTools.css';

type ProviderId = 'github' | 'gitcode';
type Scope = {owner:string; repo:string; credentialRef?:string; publicRead?:boolean; actions:string[]; branchPrefixes?:string[]; workflows?:{id:string; refs:string[]; inputs:Record<string,string[]>}[]};
type Provider = {provider:ProviderId; endpoint:string; repositories:Scope[]; actions:string[]; unsupported:string[]; credentialConfigured:boolean|null; credentialSavingAvailable:boolean; credentialUpdatedAt:string|null};
type Description = {revision:number; providers:Provider[]};
type Reply = {status:string; approvalId?:string; result?:Record<string,unknown>; replayed?:boolean};
type Evidence = {kind:'connected'|'unauthorized'|'offline'|'failure'; repository:string};
export type ForgeToolsProps = {call(method:string,params:Record<string,unknown>):Promise<unknown>; tasks?:{id:string; title:string; workspaceId:string|null; status:string}[]; onConfigureCredentials?():void};

const providerNames = {github:'GitHub',gitcode:'GitCode'};
const labels:Record<string,string> = {'repository.get':'仓库信息','branches.list':'分支','issues.list':'Issues','pulls.list':'Pull Requests / Merge Requests','builds.list':'构建记录','builds.jobs':'构建任务','releases.list':'Releases','branch.create':'创建分支','issue.create':'创建 Issue','pull.create':'创建 Pull Request / Merge Request','workflow.dispatch':'运行 GitHub 工作流','release.draft':'创建 Release 草稿'};
const reads = ['repository.get','branches.list','issues.list','pulls.list','builds.list','builds.jobs','releases.list'];
const writes = ['branch.create','issue.create','pull.create','workflow.dispatch','release.draft'];
const categories = [
  {id:'repository',label:'概览',read:'repository.get'},
  {id:'branches',label:'分支',read:'branches.list',write:'branch.create'},
  {id:'issues',label:'Issues',read:'issues.list',write:'issue.create'},
  {id:'pulls',label:'PR / MR',read:'pulls.list',write:'pull.create'},
  {id:'ci',label:'CI',read:'builds.list',write:'workflow.dispatch'},
  {id:'releases',label:'Releases',read:'releases.list',write:'release.draft'}
];
const scopeId = (row:Scope) => row.owner+'/'+row.repo;
const blank = (provider:ProviderId):Scope => ({owner:'',repo:'',credentialRef:'plugin-forge-'+provider,actions:[...reads],branchPrefixes:['codex/'],workflows:[]});
const initialFields = {branch:'codex/',sha:'',title:'',body:'',head:'codex/',base:'main',workflow:'ci.yml',ref:'',tag:'',name:'',runId:''};
function message(error:unknown, secret='') {
  const raw = error instanceof Error ? error.message : String(error);
  return (secret ? raw.split(secret).join('[已隐藏]') : raw)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'[已隐藏]')
    .replace(/\b(token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi,'$1=[已隐藏]').slice(0,600);
}
function failureKind(error:unknown):Evidence['kind'] {
  const code = typeof error === 'object' && error ? String((error as {code?:unknown}).code ?? '') : '';
  if (/FORGE_(?:CREDENTIAL_DENIED|SCOPE_DENIED)|NETWORK_CREDENTIAL_DENIED|TASK_NOT_AUTHORIZED/.test(code) || /HTTP (?:401|403)\b/.test(message(error))) return 'unauthorized';
  if (/FORGE_(?:NETWORK_ERROR|TIMEOUT)|IPC_(?:UNAVAILABLE|TIMEOUT)/.test(code) || /桌面主机连接不可用|桌面主机响应超时/.test(message(error))) return 'offline';
  return 'failure';
}
function connectionStatus(row:Provider|undefined,evidence:Evidence|undefined,loadError:unknown,loading:boolean):{label:string; tone:'default'|'success'|'warning'|'danger'; detail:string} {
  if (loadError) return failureKind(loadError)==='offline' ? {label:'离线',tone:'warning',detail:'连接服务暂时不可达，重试以读取最新状态。'} : {label:'加载失败',tone:'danger',detail:'无法读取连接设置；已有配置未被覆盖。'};
  if (loading || !row) return {label:'状态待确认',tone:'default',detail:'正在读取本机连接设置。'};
  if (evidence?.kind==='connected') return {label:'已连接',tone:'success',detail:'本次已成功读取 '+evidence.repository+'；其他仓库权限仍按各自范围校验。'};
  if (evidence?.kind==='unauthorized') return {label:'未授权',tone:'danger',detail:evidence.repository+' 的访问被拒绝，请核对凭据与仓库权限。'};
  if (evidence?.kind==='offline') return {label:'离线',tone:'warning',detail:'无法连接 '+evidence.repository+'，请检查网络后重试。'};
  if (evidence?.kind==='failure') return {label:'加载失败',tone:'danger',detail:evidence.repository+' 未能返回可用数据，请重试。'};
  if (row.credentialConfigured) return {label:'凭据待验证',tone:'warning',detail:'专用凭据已保存；读取一个仓库后才能确认实际访问权限。'};
  if (row.repositories.some(scope=>scope.publicRead)) return {label:'仓库待验证',tone:'warning',detail:'已配置公共只读范围，尚未读取远程数据。'};
  if (row.credentialConfigured===null) return {label:'状态待确认',tone:'default',detail:'凭据状态未知，不能确认账号已连接。'};
  return {label:'未配置',tone:'default',detail:row.repositories.length ? '已保存仓库范围，请添加专用凭据或使用公共只读连接。' : '添加仓库范围，并选择公共只读或专用凭据。'};
}

/** Network, secret storage and approval authority remain in the existing Owner Core IPC. */
export function ForgeTools({call,tasks=[]}:ForgeToolsProps) {
  const [description,setDescription] = useState<Description|null>(null), [provider,setProvider] = useState<ProviderId>('github');
  const [scopeKey,setScopeKey] = useState(''), [query,setQuery] = useState(''), [repositoryLimit,setRepositoryLimit] = useState(12);
  const [category,setCategory] = useState('repository'), [ciRead,setCiRead] = useState('builds.list');
  const [modal,setModal] = useState<'connection'|'action'|null>(null), [connectionTab,setConnectionTab] = useState('credentials');
  const [scopeStep,setScopeStep] = useState<'list'|'identity'|'permissions'>('list');
  const [draft,setDraft] = useState<Scope>(()=>blank('github')), [editing,setEditing] = useState('');
  const [workflowInputs,setWorkflowInputs] = useState('{}'), [workflowRef,setWorkflowRef] = useState(''), [workflowId,setWorkflowId] = useState('ci.yml');
  const [writeAction,setWriteAction] = useState('branch.create'), [taskId,setTaskId] = useState(''), [fields,setFields] = useState<Record<string,string>>(initialFields);
  const [busy,setBusy] = useState<string|null>('describe'), [loadError,setLoadError] = useState<unknown>(null);
  const [error,setError] = useState(''), [dialogError,setDialogError] = useState(''), [notice,setNotice] = useState(''), [dialogNotice,setDialogNotice] = useState('');
  const [reply,setReply] = useState<Reply|null>(null), [evidence,setEvidence] = useState<Partial<Record<ProviderId,Evidence>>>({});
  const [reveal,setReveal] = useState(false), [credentialEntered,setCredentialEntered] = useState(false);
  const credentialInput = useRef<HTMLInputElement>(null), callRef = useRef(call); callRef.current=call;
  const generation=useRef(0), operation=useRef(0), intent=useRef<{key:string;operationId:string;requestId:string}|null>(null);
  const current=description?.providers.find(row=>row.provider===provider), scopes=current?.repositories??[];
  const scope=scopes.find(row=>scopeId(row)===scopeKey)??scopes[0];
  const activeCategory=categories.find(row=>row.id===category)??categories[0], action=category==='ci'?ciRead:activeCategory.read;
  const writableTasks=tasks.filter(task=>task.workspaceId&&!['completed','failed','cancelled'].includes(task.status)), task=writableTasks.find(row=>row.id===taskId);
  const matches=scopes.filter(row=>scopeId(row).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const live=(epoch:number)=>generation.current===epoch;
  function clearCredential() { if(credentialInput.current)credentialInput.current.value='';setCredentialEntered(false);setReveal(false); }
  function closeModal() { clearCredential();setModal(null); }
  async function refresh() {
    const epoch=generation.current,request=++operation.current;setBusy('describe');setLoadError(null);
    try {
      const result=await callRef.current('ui.developer.forge.describe',{}) as Description;
      if(live(epoch)&&request===operation.current){
        if(JSON.stringify(result)!==JSON.stringify(description)){setEvidence({});setReply(null);setError('');setNotice('');intent.current=null;}
        setDescription(result);
      }
    }
    catch(cause){if(live(epoch)&&request===operation.current)setLoadError(cause);}
    finally{if(live(epoch)&&request===operation.current)setBusy(null);}
  }
  useEffect(()=>{generation.current++;void refresh();return()=>{generation.current++;if(credentialInput.current)credentialInput.current.value='';};},[]);
  function selectProvider(value:ProviderId) {
    if(provider===value)return;clearCredential();setProvider(value);setScopeKey('');setQuery('');setRepositoryLimit(12);setReply(null);setError('');setNotice('');setDialogError('');setDialogNotice('');setDraft(blank(value));setEditing('');setScopeStep('list');intent.current=null;
  }
  function openConnection(value:ProviderId,tab='credentials') {selectProvider(value);clearCredential();setConnectionTab(tab);setModal('connection');}
  function editScope(row?:Scope) {
    setDraft(row?structuredClone(row):blank(provider));setEditing(row?scopeId(row):'');setWorkflowId(row?.workflows?.[0]?.id??'ci.yml');setWorkflowRef(row?.workflows?.[0]?.refs.join(', ')??'');setWorkflowInputs(JSON.stringify(row?.workflows?.[0]?.inputs??{},null,2));setScopeStep('identity');setDialogError('');setDialogNotice('');
  }
  function allowedReason(targetAction:string) {
    if(current?.unsupported.includes(targetAction))return provider==='gitcode'&&targetAction==='release.draft'?'GitCode API 不支持未发布的 Release 草稿。':'此平台暂不支持该操作。';
    if(!scope?.actions.includes(targetAction))return '此仓库尚未授权该操作，请在仓库范围中配置。';
    if(writes.includes(targetAction)&&scope.publicRead)return '公共只读连接不能执行写入。';return '';
  }
  async function saveCredential() {
    const token=credentialInput.current?.value??'';clearCredential();if(!description||!current||!token)return;
    const epoch=generation.current;setBusy('credential');setDialogError('');setDialogNotice('');
    try {
      await callRef.current('ui.developer.forge.credentials.save',{provider,expectedRevision:description.revision,token});if(!live(epoch))return;
      setEvidence(rows=>({...rows,[provider]:undefined}));setReply(null);intent.current=null;setDialogNotice('专用凭据已保存，输入已清空。读取仓库后才能验证实际权限；此前的操作审批已失效。');
      const next=await callRef.current('ui.developer.forge.describe',{}) as Description;if(live(epoch)){setDescription(next);setLoadError(null);}
    }catch(cause){if(live(epoch))setDialogError(message(cause,token));}finally{if(live(epoch)){clearCredential();setBusy(null);}}
  }
  async function saveScope() {
    if(!description||!current)return;const epoch=generation.current;setBusy('scope');setDialogError('');setDialogNotice('');
    try {
      const workflows=draft.actions.includes('workflow.dispatch')?[{id:workflowId,refs:workflowRef.split(',').map(value=>value.trim()).filter(Boolean),inputs:JSON.parse(workflowInputs) as Record<string,string[]>},...(draft.workflows?.slice(1)??[])]:[];
      const row={...draft,owner:draft.owner.trim(),repo:draft.repo.trim(),credentialRef:draft.publicRead?'':draft.credentialRef?.trim()??'',workflows};
      const next=scopes.filter(item=>scopeId(item)!==(editing||scopeId(row)));next.push(row);
      const result=await callRef.current('ui.developer.forge.save',{provider,expectedRevision:description.revision,repositories:next}) as Description;if(!live(epoch))return;
      setDescription(result);setLoadError(null);setEditing(scopeId(row));setScopeKey(scopeId(row));setQuery('');setReply(null);setEvidence(rows=>({...rows,[provider]:undefined}));intent.current=null;setDialogNotice('仓库权限范围已保存。请读取仓库以验证访问权限。');setScopeStep('list');
    }catch(cause){if(live(epoch))setDialogError(message(cause));}finally{if(live(epoch))setBusy(null);}
  }
  async function invoke(targetAction:string) {
    if(!scope||allowedReason(targetAction))return;const epoch=generation.current,write=writes.includes(targetAction),repository=scopeId(scope);
    setBusy('invoke');setError('');setNotice('');setDialogError('');setDialogNotice('');setReply(null);
    try {
      const input:Record<string,unknown>={owner:scope.owner,repo:scope.repo};
      const byAction:Record<string,string[]>={'builds.jobs':['runId'],'branch.create':['branch','sha'],'issue.create':['title','body'],'pull.create':['title','head','base','body'],'workflow.dispatch':['workflow','ref'],'release.draft':['tag','sha','name','body']};
      for(const key of byAction[targetAction]??[])input[key]=fields[key]??'';
      if(targetAction==='workflow.dispatch'){const allowed=scope.workflows?.find(row=>row.id===fields.workflow);if(!allowed)throw new Error('请先保存此工作流允许使用的分支和输入。');input.inputs=Object.fromEntries(Object.entries(allowed.inputs).map(([key,values])=>[key,values[0]]));}
      if(write&&!task)throw new Error('请选择关联的未结束任务。');const params:Record<string,unknown>={provider,action:targetAction,input};
      if(write){const key=JSON.stringify({provider,targetAction,input,taskId:task!.id});if(intent.current?.key!==key)intent.current={key,operationId:crypto.randomUUID(),requestId:crypto.randomUUID()};Object.assign(params,{taskId:task!.id,workspaceId:task!.workspaceId,operationId:intent.current.operationId,requestId:intent.current.requestId});}
      const result=await callRef.current('ui.developer.forge.invoke',params) as Reply;if(!live(epoch))return;setReply(result);
      if(!write&&result.status==='completed')setEvidence(rows=>({...rows,[provider]:{kind:'connected',repository}}));
      let detail='';if(result.status==='pending')detail='待审批：'+(result.approvalId??'')+'。请在待审批列表核对仓库、动作和内容；批准前不会发送写入请求。';else if(result.result?.accepted)detail='工作流触发请求已接收。读取构建记录后才能确认真实运行及对应提交。';else if(write&&result.status==='completed')detail=result.replayed?'显示此操作已保存的回执。':'远程操作已完成，回执如下。';else if(result.status!=='completed')detail='操作状态：'+result.status+'。尚未确认完成。';setNotice(detail);if(write)setDialogNotice(detail);
    }catch(cause){
      if(!live(epoch))return;
      if(!write)setEvidence(rows=>({...rows,[provider]:{kind:failureKind(cause),repository}}));
      setError(message(cause));if(write)setDialogError(message(cause));
    }
    finally{if(live(epoch))setBusy(null);}
  }
  function openAction(targetAction:string) {setWriteAction(targetAction);setModal('action');setDialogError('');setDialogNotice('');if(targetAction==='workflow.dispatch')setFields(row=>({...row,workflow:scope?.workflows?.[0]?.id??'ci.yml',ref:scope?.workflows?.[0]?.refs[0]??''}));}
  const field=(name:string,label:string,multiline=false)=><label className="forge-field" key={name}><span>{label}</span>{multiline?<Textarea aria-label={label} rows={4} value={fields[name]??''} disabled={!!busy} onChange={event=>setFields(row=>({...row,[name]:event.target.value}))}/>:<Input aria-label={label} value={fields[name]??''} disabled={!!busy} onChange={event=>setFields(row=>({...row,[name]:event.target.value}))}/>}</label>;
  const items=Array.isArray(reply?.result?.items)?reply.result.items as Record<string,unknown>[]:reply?.result?[reply.result]:[];
  const writeLabel=(id:string)=>id==='pull.create'?provider==='gitcode'?'创建 Merge Request':'创建 Pull Request':labels[id];
  const permissionLabel=(id:string)=>id==='pulls.list'?provider==='gitcode'?'Merge Requests':'Pull Requests':writeLabel(id);

  return <section className="forge-tools" aria-label="代码托管连接">
    <div className="forge-heading"><div><h2>代码托管连接</h2><p>管理 GitHub / GitCode 的仓库访问与协作。</p></div><Button compact disabled={!!busy} onClick={()=>void refresh()}>{busy==='describe'?'正在刷新…':'刷新连接状态'}</Button></div>
    <div className="forge-connections">{(['github','gitcode'] as ProviderId[]).map(id=>{
      const row=description?.providers.find(item=>item.provider===id),status=connectionStatus(row,evidence[id],loadError,busy==='describe');
      return <Card key={id} className={'forge-connection-card '+(provider===id?'selected':'')} data-provider={id}>
        <div className="forge-heading"><h3>{providerNames[id]}</h3><Badge tone={status.tone}>{status.label}</Badge></div><p className="forge-status-detail">{status.detail}</p><div className="forge-connection-meta"><span>{row?.repositories.length??'—'} 个仓库</span><span>固定 API · {id==='github'?'api.github.com':'api.gitcode.com'}</span></div>
        <div className="forge-buttons"><Button compact variant={provider===id?'primary':'default'} disabled={!!busy||!row} aria-pressed={provider===id} onClick={()=>selectProvider(id)}>查看 {providerNames[id]} 仓库</Button><Button compact aria-label={'管理 '+providerNames[id]+' 连接'} disabled={!!busy||!row} onClick={()=>openConnection(id)}>管理连接</Button></div>
      </Card>;
    })}</div>
    {loadError!=null&&<p className="forge-feedback error" role="alert">{message(loadError)}</p>}
    <Card className="forge-repositories"><div className="forge-heading"><div><h3>{providerNames[provider]} 仓库</h3><p>只显示已配置范围；每次操作仍由 Core 校验权限。</p></div><Button compact disabled={!!busy||!current} onClick={()=>{openConnection(provider,'repositories');editScope();}}>添加仓库</Button></div>
      {scopes.length>0&&<SearchInput label="搜索已配置仓库" placeholder="搜索 Owner / 仓库名称" value={query} disabled={!!busy} onChange={event=>{setQuery(event.target.value);setRepositoryLimit(12);}}/>}
      <div className="forge-repository-options">{matches.slice(0,repositoryLimit).map(row=><Button key={scopeId(row)} compact disabled={!!busy} aria-pressed={scopeId(scope!)===scopeId(row)} onClick={()=>{setScopeKey(scopeId(row));setReply(null);setError('');setNotice('');intent.current=null;}}><span>{scopeId(row)}</span>{row.publicRead&&<Badge>公共只读</Badge>}</Button>)}</div>
      {!scopes.length&&<p className="forge-empty">尚未配置仓库。添加仓库后，可读取分支、Issues、PR / MR、CI 与 Releases。</p>}{scopes.length>0&&!matches.length&&<p className="forge-empty">没有匹配的仓库，试试其他名称。</p>}
      {matches.length>repositoryLimit&&<Button compact variant="ghost" disabled={!!busy} onClick={()=>setRepositoryLimit(value=>value+12)}>显示更多仓库（{repositoryLimit} / {matches.length}）</Button>}
    </Card>
    {scope&&<Card className="forge-workspace"><div className="forge-heading"><div className="forge-repository-title"><h3>{scopeId(scope)}</h3><Badge tone={scope.publicRead?'default':'accent'}>{scope.publicRead?'公共只读':'受控访问'}</Badge></div><Button compact disabled={!!busy} onClick={()=>{openConnection(provider,'repositories');editScope(scope);}}>仓库权限</Button></div>
      <Tabs label="仓库操作分类" items={categories} selected={category} onChange={value=>{if(!busy){setCategory(value);setReply(null);setError('');setNotice('');}}}/>
      <div className="forge-action-toolbar"><div className="forge-read-action">{category==='ci'&&<Select label="CI 读取内容" value={ciRead} disabled={!!busy} onChange={event=>{setCiRead(event.target.value);setReply(null);}}><option value="builds.list">构建记录</option><option value="builds.jobs">构建任务</option></Select>}<Button compact variant="primary" disabled={!!busy||!!allowedReason(action)} title={allowedReason(action)} onClick={()=>void invoke(action)}>{busy==='invoke'&&modal!=='action'?'正在读取…':'读取'+permissionLabel(action)}</Button></div>
        {activeCategory.write&&<div className="forge-write-entry"><Button compact disabled={!!busy||!!allowedReason(activeCategory.write)} title={allowedReason(activeCategory.write)} onClick={()=>openAction(activeCategory.write!)}>{writeLabel(activeCategory.write)}</Button>{allowedReason(activeCategory.write)&&<small>{allowedReason(activeCategory.write)}</small>}</div>}
      </div>
      {category==='ci'&&action==='builds.jobs'&&field('runId','构建运行 ID')}{allowedReason(action)&&<p className="forge-help">{allowedReason(action)}</p>}
      {error&&<p className="forge-feedback error" role="alert">{error}</p>}{notice&&<p className="forge-feedback" role="status">{notice}</p>}
      <div className="forge-data" aria-live="polite">{items.length?<table className="forge-results"><caption className="sr-only">{scopeId(scope)} · {permissionLabel(action)}读取结果</caption><thead><tr><th>资源</th><th>状态</th><th>标识 / 提交</th></tr></thead><tbody>{items.map((item,index)=><tr key={index}><td>{String(item.title||item.name||item.repository||'回执')}</td><td>{String(item.state||item.status||item.conclusion||(item.draft===true?'草稿':'—'))}</td><td><code>{String(item.sha||item.sourceCommit||item.number||item.id||'—')}</code></td></tr>)}</tbody></table>:<p className="forge-empty">{reply?.status==='pending'?'待审批：'+(reply.approvalId??''):reply?'当前没有返回记录。':'选择分类并读取数据，结果会显示在这里。'}</p>}</div>
    </Card>}
    <Dialog open={modal!==null} title={modal==='action'?writeLabel(writeAction):providerNames[provider]+' 连接设置'} onClose={closeModal}>
      {modal&&<div className="forge-dialog-body">
        {modal==='connection'&&<><Tabs label="连接设置步骤" items={[{id:'credentials',label:'访问凭据'},{id:'repositories',label:'仓库范围'}]} selected={connectionTab} onChange={value=>{if(!busy){clearCredential();setConnectionTab(value);}}}/>
          {connectionTab==='credentials'?<div className="forge-form"><p>使用专用 Personal Access Token，保存到本机凭据库。凭据仅发送到固定的 {current?.endpoint} API。</p><Badge tone={current?.credentialConfigured?'warning':'default'}>{current?.credentialConfigured?'已保存 · 权限待验证':current?.credentialConfigured===false?'尚未保存凭据':'凭据状态未知'}</Badge>
            <label className="forge-field"><span>{providerNames[provider]} 专用 Token</span><div className="forge-secret-control"><Input ref={credentialInput} aria-label={providerNames[provider]+' 专用 Token'} type={reveal?'text':'password'} autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={!!busy||!current?.credentialSavingAvailable} placeholder={current?.credentialConfigured?'输入新 Token 以替换':'输入专用 Token'} onChange={event=>setCredentialEntered(!!event.target.value)}/><Button compact aria-label={reveal?'隐藏 Token':'显示 Token'} aria-pressed={reveal} disabled={!!busy||!credentialEntered} onClick={()=>setReveal(value=>!value)}>{reveal?'隐藏':'显示'}</Button></div></label>
            <p className="forge-help">关闭或提交后清空 Token。账号权限以实际仓库读取为准。{current?.credentialUpdatedAt?' 最近保存：'+current.credentialUpdatedAt:''}</p>{!current?.credentialSavingAvailable&&<p className="forge-help">当前主机的专用凭据存储不可用。</p>}
            <Button variant="primary" disabled={!!busy||!description||!current?.credentialSavingAvailable||!credentialEntered} onClick={()=>void saveCredential()}>{busy==='credential'?'正在保存…':'保存专用凭据'}</Button>
          </div>:<div className="forge-form">
            {scopeStep==='list'?<><p>为每个仓库单独设置可读内容和写入范围。</p><div className="forge-scope-list">{scopes.map(row=><Button key={scopeId(row)} disabled={!!busy} onClick={()=>editScope(row)}>{scopeId(row)} · 编辑权限</Button>)}</div>{!scopes.length&&<p className="forge-help">尚未配置仓库。</p>}<Button disabled={!!busy} onClick={()=>editScope()}>添加仓库</Button></>:<>
              <div className="forge-heading"><Badge tone="accent">{scopeStep==='identity'?'1 / 2 · 选择仓库':'2 / 2 · 权限范围'}</Badge><Button compact variant="ghost" disabled={!!busy} onClick={()=>setScopeStep('list')}>返回仓库列表</Button></div>
              {scopeStep==='identity'?<><label className="forge-field"><span>Owner / 组织</span><Input aria-label="Owner / 组织" value={draft.owner} disabled={!!busy} onChange={event=>setDraft(row=>({...row,owner:event.target.value}))}/></label><label className="forge-field"><span>仓库名称</span><Input aria-label="仓库名称" value={draft.repo} disabled={!!busy} onChange={event=>setDraft(row=>({...row,repo:event.target.value}))}/></label><label className="forge-check"><Input type="checkbox" checked={draft.publicRead===true} disabled={!!busy} onChange={event=>setDraft(row=>({...row,publicRead:event.target.checked,credentialRef:event.target.checked?'':'plugin-forge-'+provider,actions:event.target.checked?row.actions.filter(item=>reads.includes(item)):row.actions}))}/><span>公共仓库只读连接</span></label><p className="forge-help">{draft.publicRead?'不发送凭据，也不允许远程写入。':'使用 '+providerNames[provider]+' 专用凭据；这里只保存凭据引用。'}</p><Button variant="primary" disabled={!!busy||!draft.owner.trim()||!draft.repo.trim()} onClick={()=>setScopeStep('permissions')}>下一步：权限范围</Button></>:<>
                <p className="forge-scope-summary">{scopeId(draft)} · {draft.publicRead?'公共只读':'专用凭据'}</p>
                <fieldset className="forge-permissions"><legend>可读取的内容</legend>{reads.map(item=><label className="forge-check" key={item}><Input type="checkbox" disabled={!!busy||current?.unsupported.includes(item)} checked={draft.actions.includes(item)&&!current?.unsupported.includes(item)} onChange={event=>setDraft(row=>({...row,actions:event.target.checked?[...row.actions,item]:row.actions.filter(value=>value!==item)}))}/><span>{permissionLabel(item)}</span></label>)}</fieldset>
                <fieldset className="forge-permissions"><legend>允许提交审批的写入</legend>{writes.map(item=><label className="forge-check" key={item}><Input type="checkbox" disabled={!!busy||current?.unsupported.includes(item)||draft.publicRead} checked={draft.actions.includes(item)&&!current?.unsupported.includes(item)} onChange={event=>setDraft(row=>({...row,actions:event.target.checked?[...row.actions,item]:row.actions.filter(value=>value!==item)}))}/><span>{permissionLabel(item)}{current?.unsupported.includes(item)?'（此平台暂不支持）':draft.publicRead?'（公共只读不可用）':''}</span></label>)}</fieldset>
                {draft.actions.includes('branch.create')&&<label className="forge-field"><span>允许创建的分支前缀</span><Input value={draft.branchPrefixes?.join(', ')??''} placeholder="codex/" disabled={!!busy} onChange={event=>setDraft(row=>({...row,branchPrefixes:event.target.value.split(',').map(value=>value.trim()).filter(Boolean)}))}/></label>}
                {draft.actions.includes('workflow.dispatch')&&provider==='github'&&<div className="forge-workflow-fields"><label className="forge-field"><span>允许的工作流</span><Input value={workflowId} disabled={!!busy} onChange={event=>setWorkflowId(event.target.value)}/></label><label className="forge-field"><span>允许的远程分支（逗号分隔）</span><Input value={workflowRef} disabled={!!busy} onChange={event=>setWorkflowRef(event.target.value)}/></label><label className="forge-field"><span>允许的输入值（JSON 对象，每项为字符串数组）</span><Textarea rows={3} value={workflowInputs} disabled={!!busy} onChange={event=>setWorkflowInputs(event.target.value)}/></label></div>}
                <p className="forge-help">保存范围不会执行远程写入；写入仍需关联任务并逐次审批。</p><div className="forge-buttons"><Button disabled={!!busy} onClick={()=>setScopeStep('identity')}>上一步</Button><Button variant="primary" disabled={!!busy||!description} onClick={()=>void saveScope()}>{busy==='scope'?'正在保存…':'保存仓库权限'}</Button></div>
              </>}
            </>}
          </div>}
        </>}
        {modal==='action'&&<div className="forge-form"><p className="forge-scope-summary">{scope&&scopeId(scope)}</p><p>写入关联任务并逐次进入审批，批准前不会发送写入请求。</p><label className="forge-field"><span>关联任务</span><Select label="关联任务" value={taskId} disabled={!!busy} onChange={event=>setTaskId(event.target.value)}><option value="">选择未结束任务</option>{writableTasks.map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</Select></label>{!writableTasks.length&&<p className="forge-help">请先创建或选择有工作区的未结束任务。</p>}
          {writeAction==='branch.create'&&<>{field('branch','新分支名称')}{field('sha','基线提交 SHA')}</>}{writeAction==='issue.create'&&<>{field('title','Issue 标题')}{field('body','内容',true)}</>}{writeAction==='pull.create'&&<>{field('title',provider==='gitcode'?'Merge Request 标题':'Pull Request 标题')}{field('head','来源分支')}{field('base','目标分支')}{field('body','说明',true)}</>}{writeAction==='workflow.dispatch'&&<>{field('workflow','工作流文件名')}{field('ref','已授权的远程分支')}<p className="forge-help">输入使用已保存范围中逐项允许的第一个值。实际运行状态需读取构建记录。</p></>}{writeAction==='release.draft'&&<>{field('tag','Tag 名称')}{field('sha','目标提交 SHA')}{field('name','Release 名称')}{field('body','草稿内容',true)}</>}
          <Button variant="primary" disabled={!!busy||!task||!!allowedReason(writeAction)} title={allowedReason(writeAction)} onClick={()=>void invoke(writeAction)}>{busy==='invoke'?'正在提交…':'提交审批'}</Button>
        </div>}
        {dialogError&&<p className="forge-feedback error" role="alert">{dialogError}</p>}{dialogNotice&&<p className="forge-feedback" role="status">{dialogNotice}</p>}
      </div>}
    </Dialog>
  </section>;
}
