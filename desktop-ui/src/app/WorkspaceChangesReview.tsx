import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, SearchInput, Select } from '../components/primitives/inputs';
import { DiffViewer } from '../components/product/DiffViewer';
import type { GitDiff } from './GitWorkspace';

type ReviewPage = {workspaceId:string;entries:{path:string;x:string;y:string;conflict:boolean}[];nextCursor:string|null;totalKnown:number};

export type WorkspaceChangesReviewProps = { workspaceId: string; call(method: string, params: Record<string, unknown>): Promise<unknown> };
/** Read-only current Workspace projection. It does not certify attribution to a Task. */
export function WorkspaceChangesReview({workspaceId,call}:WorkspaceChangesReviewProps) {
  const [result,setResult]=useState<(ReviewPage&{isRepo:boolean})|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [selected,setSelected]=useState(''),[query,setQuery]=useState(''),[cached,setCached]=useState(false);
  const [paging,setPaging]=useState<{workspaceId:string;index:number;cursors:(string|null)[]}>({workspaceId,index:0,cursors:[null]});
  const [diff,setDiff]=useState<(GitDiff&{workspaceId:string;path:string;cached:boolean})|null>(null),[diffError,setDiffError]=useState('');
  const callRef=useRef(call);callRef.current=call;const currentWorkspace=useRef(workspaceId);currentWorkspace.current=workspaceId;
  const selectedWorkspace=useRef<string|null>(null);
  useEffect(()=>{selectedWorkspace.current=null;setSelected('');setQuery('');setPaging({workspaceId,index:0,cursors:[null]});setCached(false);},[workspaceId]);
  const page=paging.workspaceId===workspaceId?paging.index:0;
  const cursor=paging.workspaceId===workspaceId?paging.cursors[page]:null;
  useEffect(()=>{let current=true;setResult(null);setError('');setLoading(true);
    void (async()=>{
      const context=await callRef.current('ui.workspace.git.context',{id:workspaceId}) as {workspaceId:string;git:{isRepo:boolean}};
      if(context.workspaceId!==workspaceId)throw Error('工作区响应身份不匹配。');
      if(!current||currentWorkspace.current!==workspaceId)return;
      if(!context.git.isRepo)return {workspaceId,isRepo:false,entries:[],nextCursor:null,totalKnown:0};
      const data=await callRef.current('ui.workspace.git.status.page',{id:workspaceId,limit:50,...(cursor?{cursor}:{})}) as ReviewPage;
      if(data.workspaceId!==workspaceId)throw Error('工作区响应身份不匹配。');
      return {...data,isRepo:true};
    })().then(value=>{if(value&&current&&currentWorkspace.current===workspaceId){setResult(value);setSelected(previous=>value.entries.some(row=>row.path===previous)?previous:'');}}).catch(cause=>{if(current&&currentWorkspace.current===workspaceId)setError((cause instanceof Error?cause.message:String(cause))+'；请刷新工作区修改后重试。');}).finally(()=>{if(current)setLoading(false);});
    return()=>{current=false;};
  },[workspaceId,revision,cursor]);
  function refresh(){setPaging({workspaceId,index:0,cursors:[null]});setRevision(value=>value+1);}
  function movePage(index:number,next:string|null){if(loading)return;setSelected('');setPaging(previous=>({workspaceId,index,cursors:[...previous.cursors.slice(0,index),next]}));}
  useEffect(()=>{let current=true;setDiff(null);setDiffError('');if(!selected||selectedWorkspace.current!==workspaceId)return;
    void callRef.current('ui.workspace.git.diff',{id:workspaceId,path:selected,cached}).then(value=>{if(current&&currentWorkspace.current===workspaceId)setDiff({...value as GitDiff,workspaceId,path:selected,cached});}).catch(cause=>{if(current)setDiffError(cause instanceof Error?cause.message:String(cause));});return()=>{current=false;};
  },[workspaceId,selected,cached,revision]);
  const valid=result?.workspaceId===workspaceId?result:null;
  const entries=useMemo(()=>valid?.entries.filter(row=>row.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))??[],[valid,query]);
  const shownDiff=diff?.workspaceId===workspaceId&&diff.path===selected&&diff.cached===cached?diff:null;
  return <section className="workspace-changes-review" aria-label="工作区当前修改"><h3>工作区当前修改</h3><p>显示工作区此刻的 Git 差异，可能包括用户或其他任务的修改，不作为本任务成果归属或验收证据。此处仅审阅，不暂存或提交。</p>
    <Button compact onClick={refresh} disabled={loading}>刷新工作区修改</Button>
    {loading?<p role="status">正在读取工作区修改…</p>:error?<p role="alert" className="diff-feedback error">{error}</p>:valid&&!valid.isRepo?<p>此工作区不是 Git 仓库。</p>:valid&&<>
      <SearchInput label="搜索审阅文件" placeholder="仅筛选当前页的文件路径…" value={query} onChange={event=>setQuery(event.target.value)} />
      <p>搜索仅覆盖当前服务端页；翻页查看其余文件。列表不读取文件内容，也不构成操作审批。</p>
      <div className="workspace-review-files" aria-label="工作区修改文件">{entries.map(row=><Button compact variant="ghost" aria-pressed={selected===row.path} key={row.path} onClick={()=>{selectedWorkspace.current=workspaceId;setSelected(row.path);}}>{row.path}<span> · {row.conflict?'冲突':row.x==='?'?'未跟踪':row.x+row.y}</span></Button>)}{!entries.length&&<p>{valid.entries.length?'当前页没有匹配的文件。':'当前没有文件修改。'}</p>}</div>
      <nav className="diff-pagination" aria-label="审阅文件分页"><Button compact disabled={loading||!page} onClick={()=>movePage(page-1,paging.cursors[page-1])}>上一页文件</Button><small>第 {page+1} 页 · 共 {valid.totalKnown} 项{valid.nextCursor?' · 还有更多':''}</small><Button compact disabled={loading||!valid.nextCursor} onClick={()=>movePage(page+1,valid.nextCursor)}>下一页文件</Button></nav>
      {selected&&<><Select label="审阅 Diff 来源" value={cached?'cached':'working'} onChange={event=>setCached(event.target.value==='cached')}><option value="working">工作目录</option><option value="cached">暂存区</option></Select><DiffViewer path={selected} output={shownDiff?.output??''} loading={!shownDiff&&!diffError} error={diffError} truncated={shownDiff?.truncated} onRetry={()=>setRevision(value=>value+1)} /></>}
    </>}
  </section>;
}
