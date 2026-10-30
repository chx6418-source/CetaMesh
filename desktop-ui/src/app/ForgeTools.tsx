import {useEffect,useRef,useState} from 'react';

type Scope={owner:string;repo:string;credentialRef?:string;publicRead?:boolean;actions:string[];branchPrefixes?:string[];workflows?:{id:string;refs:string[];inputs:Record<string,string[]>}[]};
type Provider={provider:'github'|'gitcode';endpoint:string;repositories:Scope[];actions:string[];unsupported:string[];credentialConfigured:boolean|null;credentialSavingAvailable:boolean;credentialUpdatedAt:string|null};
type Description={revision:number;providers:Provider[]};
type Reply={status:string;approvalId?:string;result?:Record<string,unknown>;replayed?:boolean};
export type ForgeToolsProps={call(method:string,params:Record<string,unknown>):Promise<unknown>;tasks?:{id:string;title:string;workspaceId:string|null;status:string}[];onConfigureCredentials?():void};
const labels:Record<string,string>={'repository.get':'仓库信息','branches.list':'分支','issues.list':'Issues','pulls.list':'Pull Requests','builds.list':'构建记录','builds.jobs':'构建任务','releases.list':'Releases','branch.create':'创建分支','issue.create':'创建 Issue','pull.create':'创建 Pull Request','workflow.dispatch':'运行 GitHub 工作流','release.draft':'创建 Release 草稿'};
const reads=['repository.get','branches.list','issues.list','pulls.list','builds.list','builds.jobs','releases.list'];
const writes=['branch.create','issue.create','pull.create','workflow.dispatch','release.draft'];
const blank=():Scope=>({owner:'',repo:'',credentialRef:'plugin-forge-github',actions:[...reads],branchPrefixes:['codex/'],workflows:[]});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const css=`.forge-tools{padding:24px;overflow:auto;height:100%;color:var(--text-primary,#303c36)}.forge-tools *{box-sizing:border-box}.forge-tools h1{font-size:24px;margin:0}.forge-tools h2{font-size:16px;margin:0 0 14px}.forge-tools p{font-size:13px;line-height:1.6;color:var(--text-secondary,#727b70)}.forge-tools label{display:grid;gap:6px;font-size:12px;min-width:0}.forge-tools button,.forge-tools input,.forge-tools textarea,.forge-tools select{font:inherit;color:inherit;border:1px solid var(--border,#dbe1d5);border-radius:8px;padding:8px 10px;background:var(--surface,#fffef9);max-width:100%;min-width:0}.forge-tools button{cursor:pointer}.forge-tools button:disabled{opacity:.45;cursor:default}.forge-tools textarea{width:100%;resize:vertical}.forge-tools .forge-primary{background:#4d6952;color:#fff;border-color:#4d6952}.forge-header,.forge-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.forge-header{justify-content:space-between;margin-bottom:20px}.forge-layout{display:grid;grid-template-columns:minmax(250px,340px) minmax(0,1fr);gap:18px}.forge-panel{padding:18px;border:1px solid var(--border,#dbe1d5);border-radius:12px;background:var(--surface,#fffef9);min-width:0}.forge-fields{display:grid;gap:12px}.forge-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.forge-tools .forge-check{display:flex;gap:6px;align-items:center;font-size:11px}.forge-scope{display:block;width:100%;text-align:left;margin:8px 0}.forge-scope[aria-pressed=true]{border-color:#4d6952;background:#edf1e7}.forge-notice{padding:12px;border-radius:8px;background:#edf1e7;font-size:13px;margin:12px 0;overflow-wrap:anywhere}.forge-error{background:#fff1e7;color:#925536}.forge-results{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px}.forge-results td,.forge-results th{padding:10px 7px;border-bottom:1px solid var(--border,#e7eadf);text-align:left;overflow-wrap:anywhere}.forge-results code{font-size:10px}.forge-data{overflow:auto}.forge-empty{padding:24px 0;color:var(--text-secondary,#727b70);font-size:13px}.forge-action-form{margin-top:20px;padding-top:18px;border-top:1px solid var(--border,#dbe1d5)}@media(max-width:1000px){.forge-layout{grid-template-columns:minmax(0,1fr)}}@media(max-width:600px){.forge-tools{padding:15px}.forge-checks{grid-template-columns:minmax(0,1fr)}}`;

/** All network and credential work remains in Owner Core IPC. */
export function ForgeTools({call,tasks=[]}:ForgeToolsProps){
  const [description,setDescription]=useState<Description|null>(null),[provider,setProvider]=useState<'github'|'gitcode'>('github');
  const [draft,setDraft]=useState<Scope>(blank),[selected,setSelected]=useState(''),[scopeKey,setScopeKey]=useState('');
  const [action,setAction]=useState('repository.get'),[writeAction,setWriteAction]=useState('branch.create'),[taskId,setTaskId]=useState('');
  const [fields,setFields]=useState<Record<string,string>>({branch:'codex/',sha:'',title:'',body:'',head:'codex/',base:'main',workflow:'ci.yml',ref:'',tag:'',name:'',runId:''});
  const [workflowInputs,setWorkflowInputs]=useState('{}'),[workflowRef,setWorkflowRef]=useState(''),[workflowId,setWorkflowId]=useState('ci.yml');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reply,setReply]=useState<Reply|null>(null);
  const callRef=useRef(call);callRef.current=call;const generation=useRef(0);const intent=useRef<{key:string;operationId:string;requestId:string}|null>(null);
  const credentialInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{const epoch=++generation.current;void callRef.current('ui.developer.forge.describe',{}).then(result=>{if(generation.current===epoch)setDescription(result as Description);}).catch(cause=>{if(generation.current===epoch)setError(message(cause));});return()=>{generation.current++;};},[]);
  const current=description?.providers.find(row=>row.provider===provider),scopes=current?.repositories??[];
  const scope=scopes.find(row=>`${row.owner}/${row.repo}`===scopeKey)??scopes[0];
  const writableTasks=tasks.filter(task=>task.workspaceId&&!['completed','failed','cancelled'].includes(task.status));
  const task=writableTasks.find(row=>row.id===taskId);
  const resetProvider=(value:'github'|'gitcode')=>{if(credentialInput.current)credentialInput.current.value='';setProvider(value);setDraft({...blank(),credentialRef:`plugin-forge-${value}`});setSelected('');setScopeKey('');setReply(null);setError('');setNotice('');intent.current=null;};
  const edit=(row:Scope)=>{setDraft(structuredClone(row));setSelected(`${row.owner}/${row.repo}`);setWorkflowId(row.workflows?.[0]?.id??'ci.yml');setWorkflowRef(row.workflows?.[0]?.refs.join(', ')??'');setWorkflowInputs(JSON.stringify(row.workflows?.[0]?.inputs??{},null,2));};
  async function saveCredential(){
    const token=credentialInput.current?.value??'';if(credentialInput.current)credentialInput.current.value='';
    if(!description||!current||!token)return;setBusy(true);setError('');setNotice('');
    try{
      await callRef.current('ui.developer.forge.credentials.save',{provider,expectedRevision:description.revision,token});
      setDescription(await callRef.current('ui.developer.forge.describe',{}) as Description);
      setDraft(row=>({...row,credentialRef:`plugin-forge-${provider}`}));
      setNotice('专用凭据已保存，输入已清空。请读取仓库验证实际权限；此前的操作审批已失效。');
    }catch(cause){setError(message(cause));}finally{if(credentialInput.current)credentialInput.current.value='';setBusy(false);}
  }
  async function save(){
    if(!description||!current)return;setBusy(true);setError('');setNotice('');
    try{
      const workflows=draft.actions.includes('workflow.dispatch')?[{id:workflowId,refs:workflowRef.split(',').map(x=>x.trim()).filter(Boolean),inputs:JSON.parse(workflowInputs) as Record<string,string[]>}]:[];
      const row={...draft,owner:draft.owner.trim(),repo:draft.repo.trim(),credentialRef:draft.credentialRef?.trim()??'',workflows};
      const next=scopes.filter(item=>`${item.owner}/${item.repo}`!==(selected||`${row.owner}/${row.repo}`));next.push(row);
      const result=await callRef.current('ui.developer.forge.save',{provider,expectedRevision:description.revision,repositories:next}) as Description;
      setDescription(result);setSelected(`${row.owner}/${row.repo}`);setScopeKey(`${row.owner}/${row.repo}`);setNotice('仓库权限范围已保存。可立即读取已授权的数据。');
    }catch(cause){setError(message(cause));}finally{setBusy(false);}
  }
  async function invoke(targetAction:string){
    if(!scope)return;const write=writes.includes(targetAction);setBusy(true);setError('');setNotice('');setReply(null);
    try{
      const input:Record<string,unknown>={owner:scope.owner,repo:scope.repo};
      const byAction:Record<string,string[]>={'builds.jobs':['runId'],'branch.create':['branch','sha'],'issue.create':['title','body'],'pull.create':['title','head','base','body'],'workflow.dispatch':['workflow','ref'],'release.draft':['tag','sha','name','body']};
      for(const key of byAction[targetAction]??[])input[key]=fields[key]??'';
      if(targetAction==='workflow.dispatch'){
        const allowed=scope.workflows?.find(row=>row.id===fields.workflow);if(!allowed)throw new Error('请先保存此工作流允许使用的分支和输入。');
        input.inputs=Object.fromEntries(Object.entries(allowed.inputs).map(([key,values])=>[key,values[0]]));
      }
      if(write&&!task)throw new Error('请选择关联的未结束任务。');
      const params:Record<string,unknown>={provider,action:targetAction,input};
      if(write){
        const key=JSON.stringify({provider,targetAction,input,taskId:task!.id});
        if(intent.current?.key!==key)intent.current={key,operationId:crypto.randomUUID(),requestId:crypto.randomUUID()};
        Object.assign(params,{taskId:task!.id,workspaceId:task!.workspaceId,operationId:intent.current.operationId,requestId:intent.current.requestId});
      }
      const result=await callRef.current('ui.developer.forge.invoke',params) as Reply;setReply(result);
      if(result.status==='pending')setNotice('操作已提交审批。请在待审批列表核对仓库、动作和内容；批准前不会发送写入请求。');
      else if(result.result?.accepted)setNotice('工作流触发请求已接收。请读取构建记录核对真实运行及对应提交。');
      else if(write)setNotice(result.replayed?'显示此操作已保存的回执。':'远程操作已完成，回执如下。');
    }catch(cause){setError(message(cause));}finally{setBusy(false);}
  }
  const field=(name:string,label:string,multiline=false)=><label key={name}>{label}{multiline?<textarea rows={4} value={fields[name]??''} onChange={event=>setFields({...fields,[name]:event.target.value})}/>:<input value={fields[name]??''} onChange={event=>setFields({...fields,[name]:event.target.value})}/>}</label>;
  const items=Array.isArray(reply?.result?.items)?reply!.result!.items as Record<string,unknown>[]:reply?.result?[reply.result]:[];
  return <div className="forge-tools"><style>{css}</style><header className="forge-header"><div><h1>开发者工具</h1><p>连接仓库，查看分支、协作记录与云端构建。</p></div><select aria-label="代码托管平台" value={provider} disabled={busy} onChange={event=>resetProvider(event.target.value as 'github'|'gitcode')}><option value="github">GitHub</option><option value="gitcode">GitCode</option></select></header>
    {error&&<div className="forge-notice forge-error" role="alert">{error}</div>}{notice&&<div className="forge-notice" role="status">{notice}</div>}
    <div className="forge-layout"><section className="forge-panel"><h2>仓库连接</h2><p>{current?.endpoint??'正在读取连接设置…'}</p>{scopes.map(row=><button className="forge-scope" type="button" key={`${row.owner}/${row.repo}`} aria-pressed={selected===`${row.owner}/${row.repo}`} disabled={busy} onClick={()=>edit(row)}>{row.owner}/{row.repo}</button>)}
      <div className="forge-fields"><label>Owner / 组织<input value={draft.owner} onChange={event=>setDraft({...draft,owner:event.target.value})}/></label><label>仓库名称<input value={draft.repo} onChange={event=>setDraft({...draft,repo:event.target.value})}/></label><label className="forge-check"><input type="checkbox" checked={draft.publicRead===true} onChange={event=>setDraft({...draft,publicRead:event.target.checked,credentialRef:event.target.checked?'':`plugin-forge-${provider}`,actions:event.target.checked?draft.actions.filter(action=>reads.includes(action)):draft.actions})}/>公共仓库只读连接</label><label>专用凭据引用<input disabled={draft.publicRead} placeholder={`plugin-forge-${provider}`} value={draft.credentialRef??''} readOnly/></label><p>{draft.publicRead?'公共只读连接不发送凭据，不能执行远程写入。':`专用 Token 仅保存到本机凭据库 ${`plugin-forge-${provider}`}，固定绑定上方 API。仓库设置仅保存引用。`}</p>
      <label>{provider==='github'?'GitHub':'GitCode'} 专用 Token<input ref={credentialInput} type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={busy||!current?.credentialSavingAvailable} placeholder={current?.credentialConfigured?'输入新 Token 以替换':'输入专用 Token'}/></label><p>{current?.credentialConfigured?'已保存，尚需验证仓库权限':current?.credentialConfigured===false?'尚未保存专用凭据':'凭据状态尚未确认'}{current?.credentialUpdatedAt?` · ${current.credentialUpdatedAt}`:''}</p><button type="button" disabled={busy||!description||!current?.credentialSavingAvailable} onClick={()=>void saveCredential()}>保存专用凭据</button>
      <label>允许创建的分支前缀<input value={draft.branchPrefixes?.join(', ')??''} placeholder="codex/" onChange={event=>setDraft({...draft,branchPrefixes:event.target.value.split(',').map(x=>x.trim()).filter(Boolean)})}/></label><div className="forge-checks">{[...reads,...writes].map(item=><label className="forge-check" key={item}><input type="checkbox" disabled={current?.unsupported.includes(item)||(draft.publicRead===true&&writes.includes(item))} checked={draft.actions.includes(item)&&!current?.unsupported.includes(item)} onChange={event=>setDraft({...draft,actions:event.target.checked?[...draft.actions,item]:draft.actions.filter(x=>x!==item)})}/>{labels[item]}{current?.unsupported.includes(item)?'（暂不支持）':''}</label>)}</div>
      {draft.actions.includes('workflow.dispatch')&&provider==='github'&&<><label>允许的工作流<input value={workflowId} onChange={event=>setWorkflowId(event.target.value)}/></label><label>允许的远程分支（逗号分隔）<input value={workflowRef} onChange={event=>setWorkflowRef(event.target.value)}/></label><label>允许的输入值（JSON 对象，每项为字符串数组）<textarea rows={3} value={workflowInputs} onChange={event=>setWorkflowInputs(event.target.value)}/></label></>}
      <button className="forge-primary" type="button" disabled={busy||!description||!draft.owner||!draft.repo} onClick={()=>void save()}>保存仓库权限</button><button type="button" disabled={busy} onClick={()=>{setDraft({...blank(),credentialRef:`plugin-forge-${provider}`});setSelected('');}}>新增连接</button></div></section>
    <section className="forge-panel"><h2>仓库数据</h2><div className="forge-row"><select aria-label="已配置仓库" disabled={busy||!scopes.length} value={scope?`${scope.owner}/${scope.repo}`:''} onChange={event=>{setScopeKey(event.target.value);setReply(null);}}>{!scopes.length&&<option value="">请先添加连接</option>}{scopes.map(row=><option key={`${row.owner}/${row.repo}`} value={`${row.owner}/${row.repo}`}>{row.owner}/{row.repo}</option>)}</select><select aria-label="读取内容" value={action} disabled={busy} onChange={event=>setAction(event.target.value)}>{reads.map(item=><option key={item} value={item}>{labels[item]}</option>)}</select><button type="button" disabled={busy||!scope?.actions.includes(action)} onClick={()=>void invoke(action)}>{busy?'处理中…':'读取'}</button></div>{action==='builds.jobs'&&field('runId','构建运行 ID')}
      <div className="forge-data">{items.length?<table className="forge-results"><thead><tr><th>资源</th><th>状态</th><th>标识 / 提交</th></tr></thead><tbody>{items.map((item,index)=><tr key={index}><td>{String(item.title||item.name||item.repository||'回执')}</td><td>{String(item.state||item.conclusion||(item.draft===true?'草稿':''))}</td><td><code>{String(item.sha||item.sourceCommit||item.number||item.id||'—')}</code></td></tr>)}</tbody></table>:<div className="forge-empty">{reply?.status==='pending'?`待审批：${reply.approvalId??''}`:reply?'当前没有返回记录。':'读取结果会显示在这里。'}</div>}</div>
      <div className="forge-action-form"><h2>受控写入</h2><p>写入关联任务，并逐次进入审批。GitCode 不提供未发布 Release 草稿接口。</p><div className="forge-fields"><label>操作<select value={writeAction} disabled={busy} onChange={event=>setWriteAction(event.target.value)}>{writes.map(item=><option key={item} value={item} disabled={current?.unsupported.includes(item)}>{labels[item]}</option>)}</select></label><label>关联任务<select value={taskId} disabled={busy} onChange={event=>setTaskId(event.target.value)}><option value="">选择未结束任务</option>{writableTasks.map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      {writeAction==='branch.create'&&<>{field('branch','新分支名称')}{field('sha','基线提交 SHA')}</>}{writeAction==='issue.create'&&<>{field('title','Issue 标题')}{field('body','内容',true)}</>}{writeAction==='pull.create'&&<>{field('title','Pull Request 标题')}{field('head','来源分支')}{field('base','目标分支')}{field('body','说明',true)}</>}{writeAction==='workflow.dispatch'&&<>{field('workflow','工作流文件名')}{field('ref','已授权的远程分支')}<p>输入使用连接设置中逐项允许的第一个值。读取构建记录后才能确认实际运行。</p></>}{writeAction==='release.draft'&&<>{field('tag','Tag 名称')}{field('sha','目标提交 SHA')}{field('name','Release 名称')}{field('body','草稿内容',true)}</>}
      <button className="forge-primary" type="button" disabled={busy||!task||!scope?.actions.includes(writeAction)||current?.unsupported.includes(writeAction)} onClick={()=>void invoke(writeAction)}>提交审批</button></div></div></section></div></div>;
}
