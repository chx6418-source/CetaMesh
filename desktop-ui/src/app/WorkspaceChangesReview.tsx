import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, SearchInput, Select } from '../components/primitives/inputs';
import { DiffViewer } from '../components/product/DiffViewer';
import type { GitDiff, GitOverview } from './GitWorkspace';

export type WorkspaceChangesReviewProps = { workspaceId: string; call(method: string, params: Record<string, unknown>): Promise<unknown> };
/** Read-only current Workspace projection. It does not certify attribution to a Task. */
export function WorkspaceChangesReview({workspaceId,call}:WorkspaceChangesReviewProps) {
  const [overview,setOverview]=useState<GitOverview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [selected,setSelected]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(0),[cached,setCached]=useState(false);
  const [diff,setDiff]=useState<(GitDiff&{workspaceId:string;path:string;cached:boolean})|null>(null),[diffError,setDiffError]=useState('');
  const callRef=useRef(call);callRef.current=call;const currentWorkspace=useRef(workspaceId);currentWorkspace.current=workspaceId;
  const selectedWorkspace=useRef<string|null>(null);
  useEffect(()=>{selectedWorkspace.current=null;setSelected('');setQuery('');setPage(0);setCached(false);},[workspaceId]);
  useEffect(()=>{let current=true;setOverview(null);setError('');setLoading(true);
    void callRef.current('ui.workspace.git.overview',{id:workspaceId}).then(value=>{if(current&&currentWorkspace.current===workspaceId){const result=value as GitOverview;if(result.workspaceId!==workspaceId)throw Error('工作区响应身份不匹配。');setOverview(result);setSelected(previous=>result.git.entries.some(row=>row.path===previous)?previous:'');}}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:String(cause));}).finally(()=>{if(current)setLoading(false);});
    return()=>{current=false;};
  },[workspaceId,revision]);
  useEffect(()=>{let current=true;setDiff(null);setDiffError('');if(!selected||selectedWorkspace.current!==workspaceId)return;
    void callRef.current('ui.workspace.git.diff',{id:workspaceId,path:selected,cached}).then(value=>{if(current&&currentWorkspace.current===workspaceId)setDiff({...value as GitDiff,workspaceId,path:selected,cached});}).catch(cause=>{if(current)setDiffError(cause instanceof Error?cause.message:String(cause));});return()=>{current=false;};
  },[workspaceId,selected,cached,revision]);
  const valid=overview?.workspaceId===workspaceId?overview:null;
  const entries=useMemo(()=>valid?.git.entries.filter(row=>row.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))??[],[valid,query]);
  const currentPage=Math.min(page,Math.max(0,Math.ceil(entries.length/50)-1));
  const shownDiff=diff?.workspaceId===workspaceId&&diff.path===selected&&diff.cached===cached?diff:null;
  return <section className="workspace-changes-review" aria-label="工作区当前修改"><h3>工作区当前修改</h3><p>显示工作区此刻的 Git 差异，可能包括用户或其他任务的修改，不作为本任务成果归属或验收证据。此处仅审阅，不暂存或提交。</p>
    <Button compact onClick={()=>setRevision(value=>value+1)} disabled={loading}>刷新工作区修改</Button>
    {loading?<p role="status">正在读取工作区修改…</p>:error?<p role="alert" className="diff-feedback error">{error}</p>:valid&&!valid.git.isRepo?<p>此工作区不是 Git 仓库。</p>:valid&&<>
      <SearchInput label="搜索审阅文件" placeholder="按文件路径筛选…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}} />
      {valid.truncated&&<p>仅显示服务返回的有界变更；请在完整工作区核对其余文件。</p>}
      <div className="workspace-review-files" aria-label="工作区修改文件">{entries.slice(currentPage*50,(currentPage+1)*50).map(row=><Button compact variant="ghost" aria-pressed={selected===row.path} key={row.path} onClick={()=>{selectedWorkspace.current=workspaceId;setSelected(row.path);}}>{row.path}<span> · {row.conflict?'冲突':row.x==='?'?'未跟踪':row.x+row.y}</span></Button>)}{!entries.length&&<p>{valid.git.entries.length?'没有匹配的文件。':'当前没有文件修改。'}</p>}</div>
      {entries.length>50&&<nav className="diff-pagination" aria-label="审阅文件分页"><Button compact disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>上一页文件</Button><small>{currentPage*50+1}–{Math.min((currentPage+1)*50,entries.length)} / {entries.length}</small><Button compact disabled={(currentPage+1)*50>=entries.length} onClick={()=>setPage(currentPage+1)}>下一页文件</Button></nav>}
      {selected&&<><Select label="审阅 Diff 来源" value={cached?'cached':'working'} onChange={event=>setCached(event.target.value==='cached')}><option value="working">工作目录</option><option value="cached">暂存区</option></Select><DiffViewer path={selected} output={shownDiff?.output??''} loading={!shownDiff&&!diffError} error={diffError} truncated={shownDiff?.truncated} onRetry={()=>setRevision(value=>value+1)} /></>}
    </>}
  </section>;
}
