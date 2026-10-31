import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tabs } from '../primitives/inputs';
import './diff-viewer.css';

export type DiffLine = { kind: 'meta' | 'hunk' | 'context' | 'add' | 'remove'; text: string; oldLine: number | null; newLine: number | null };
export type ParsedDiff = { lines: DiffLine[]; additions: number; deletions: number; binary: boolean; clipped: boolean };
export type SplitDiffRow = { left: DiffLine | null; right: DiffLine | null; meta?: DiffLine };
const MAX_CHARACTERS = 1024 * 1024, MAX_LINES = 20000, PAGE_SIZE = 200;

/** Parse only for presentation: text never becomes HTML, a file read or an operation. */
export function parseUnifiedDiff(output: string): ParsedDiff {
  const input = String(output ?? '');
  const source = input.slice(0, MAX_CHARACTERS).split(/\r?\n/);
  const clipped = input.length > MAX_CHARACTERS || source.length > MAX_LINES;
  const lines: DiffLine[] = []; let additions = 0, deletions = 0, oldLine = 0, newLine = 0, inHunk = false;
  for (const text of source.slice(0, MAX_LINES)) {
    if (text === '' && lines.length === source.length - 1) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; lines.push({kind:'hunk',text,oldLine:null,newLine:null}); continue; }
    if (/^(?:diff --|Binary files |GIT binary patch)/.test(text)) inHunk = false;
    if (inHunk && text.startsWith('+')) { additions++; lines.push({kind:'add',text,oldLine:null,newLine:newLine++}); }
    else if (inHunk && text.startsWith('-')) { deletions++; lines.push({kind:'remove',text,oldLine:oldLine++,newLine:null}); }
    else if (inHunk && text.startsWith(' ')) lines.push({kind:'context',text,oldLine:oldLine++,newLine:newLine++});
    else lines.push({kind:'meta',text,oldLine:null,newLine:null});
  }
  return {lines,additions,deletions,binary:/^(?:Binary files |GIT binary patch)/m.test(input),clipped};
}

export function splitDiffRows(lines: DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'remove' || line.kind === 'add') {
      const removed: DiffLine[] = [], added: DiffLine[] = [];
      while (index < lines.length && lines[index].kind === 'remove') removed.push(lines[index++]);
      while (index < lines.length && lines[index].kind === 'add') added.push(lines[index++]);
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) rows.push({left:removed[offset] ?? null,right:added[offset] ?? null});
    } else { rows.push(line.kind === 'context' ? {left:line,right:line} : {left:null,right:null,meta:line}); index++; }
  }
  return rows;
}

export type DiffViewerProps = { output: string; path?: string; loading?: boolean; error?: string; truncated?: boolean; onRetry?(): void; onExplain?(path: string, output: string): void | Promise<void> };

export function DiffViewer({output,path='',loading=false,error='',truncated=false,onRetry,onExplain}:DiffViewerProps) {
  const parsed = useMemo(() => parseUnifiedDiff(output), [output]);
  const [view,setView] = useState('unified'), [page,setPage] = useState(0), [notice,setNotice] = useState(''), [actionError,setActionError] = useState('');
  const actionGeneration=useRef(0);
  const explainLock=useRef(false);
  const [explaining,setExplaining]=useState(false);
  const rows = useMemo(() => splitDiffRows(parsed.lines), [parsed]);
  const count = view === 'split' ? rows.length : parsed.lines.length;
  const lastPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1), currentPage = Math.min(page,lastPage), start=currentPage*PAGE_SIZE;
  useEffect(() => { actionGeneration.current++; setPage(0); setNotice(''); setActionError(''); return()=>{actionGeneration.current++;}; }, [output,path]);
  async function copyPath() {
    const generation=actionGeneration.current;
    setActionError(''); setNotice('');
    try { if (!globalThis.navigator?.clipboard?.writeText) throw Error('当前环境不允许直接复制；可选中上方路径手动复制。'); await navigator.clipboard.writeText(path); if(actionGeneration.current===generation)setNotice('已复制相对路径'); }
    catch (cause) { if(actionGeneration.current===generation)setActionError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function explain() { if(explainLock.current||!onExplain)return;explainLock.current=true;setExplaining(true);const generation=actionGeneration.current;setActionError('');try{await onExplain(path,output);}catch(cause){if(actionGeneration.current===generation)setActionError(cause instanceof Error?cause.message:String(cause));}finally{explainLock.current=false;setExplaining(false);} }
  return <section className="cm-diff-viewer" aria-label="代码差异审阅">
    <div className="diff-toolbar"><Tabs label="Diff 显示方式" selected={view} onChange={value=>{setView(value);setPage(0);}} items={[{id:'unified',label:'Unified · 统一'},{id:'split',label:'Split · 并排'}]} /><div className="diff-statistics" aria-label="已加载差异统计"><span className="diff-added">新增 {parsed.additions} 行</span><span className="diff-removed">删除 {parsed.deletions} 行</span>{(truncated||parsed.clipped)&&<span>仅统计已加载内容</span>}</div></div>
    {path&&<div className="diff-file-heading"><code>{path}</code><Button compact variant="ghost" onClick={()=>void copyPath()}>复制路径</Button><Button compact variant="ghost" aria-busy={explaining} disabled={!onExplain||explaining||loading||!!error||!output} title={!onExplain?'尚未连接 Chat 解释入口；不会自动发送文件内容。':undefined} onClick={()=>void explain()}>{explaining?'正在准备草稿…':'AI 解释'}</Button></div>}
    {notice&&<p role="status" className="diff-feedback">{notice}</p>}{actionError&&<p role="alert" className="diff-feedback error">{actionError}</p>}
    {loading?<p role="status" className="diff-empty">正在读取 Diff…</p>:error?<div className="diff-feedback error" role="alert">{error}{onRetry&&<Button compact onClick={onRetry}>重试读取差异</Button>}</div>:<>
      {(truncated||parsed.clipped)&&<p className="diff-feedback">Diff 已截断，审阅与统计只覆盖已加载部分；提交前请检查完整文件。</p>}
      {parsed.binary&&<p className="diff-feedback">二进制文件：此视图保留 Git 返回信息，不将其伪装成文本行变化。</p>}
      {!output?<p className="diff-empty">当前来源没有已跟踪文件的差异。未跟踪文件尚无 Git Diff。</p>:<div className={'diff-scroll '+(view==='split'?'is-split':'')} tabIndex={0} aria-label={view==='split'?'并排差异内容':'统一差异内容'}>
        {view==='unified'?parsed.lines.slice(start,start+PAGE_SIZE).map((line,index)=><div className={'diff-line '+line.kind} key={start+index}><span className="diff-number">{line.oldLine}</span><span className="diff-number">{line.newLine}</span><code>{line.text}</code></div>):rows.slice(start,start+PAGE_SIZE).map((row,index)=>row.meta?<div className={'diff-split-meta '+row.meta.kind} key={start+index}><code>{row.meta.text}</code></div>:<div className="diff-split-row" key={start+index}>{[row.left,row.right].map((line,column)=><div className={'diff-split-cell '+(line?.kind??'empty')} key={column}><span className="diff-number">{column?line?.newLine:line?.oldLine}</span><code>{line?.text.slice(1)??''}</code></div>)}</div>)}
      </div>}
      {count>PAGE_SIZE&&<nav className="diff-pagination" aria-label="Diff 内容分页"><Button compact disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>上一页</Button><small>{start+1}–{Math.min(start+PAGE_SIZE,count)} / {count} 行</small><Button compact disabled={currentPage>=lastPage} onClick={()=>setPage(currentPage+1)}>下一页</Button></nav>}
    </>}
  </section>;
}
