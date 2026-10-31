import {useEffect,useRef,useState} from 'react';
import {searchClient} from '../bridge/typed-client';
import {Dialog} from '../components/primitives/overlays';
import {Button,SearchInput} from '../components/primitives/inputs';
import {Icon,type IconName} from '../components/icons';

const pages: {id:string;label:string;icon:IconName;hint:string}[]=[
  {id:'chat',label:'Chat',icon:'chat',hint:'消息、附件和自然语言任务'},
  {id:'work',label:'Tasks / Workspace',icon:'work',hint:'任务、项目和 Git 工作台'},
  {id:'memory',label:'记忆',icon:'memory',hint:'偏好、项目知识和来源'},
  {id:'agents',label:'Agents',icon:'agents',hint:'连接、模型与执行能力'},
  {id:'devices',label:'设备与环境',icon:'device',hint:'设备连接与真实状态'},
  {id:'plugins',label:'插件中心',icon:'plugins',hint:'插件、工具和服务连接'},
  {id:'settings',label:'设置',icon:'settings',hint:'本机配置与外观'},
  {id:'about',label:'关于',icon:'help',hint:'版本与更新信息'}
];
export function QuickJump({open,onClose,onNavigate,onOpenSession,onOpenTask,onOpenWorkspace,workspaces}:{open:boolean;onClose():void;onNavigate(page:string):void;onOpenSession(id:string):void;onOpenTask(id:string):void;onOpenWorkspace(id:string):void;workspaces:{id:string;name:string}[]}){
  const [query,setQuery]=useState(''),[result,setResult]=useState<Awaited<ReturnType<typeof searchClient.search>>|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(open)requestAnimationFrame(()=>input.current?.focus());},[open]);
  useEffect(()=>{let current=true;setResult(null);setError('');if(!open||!query.trim()){setLoading(false);return;}setLoading(true);const timer=setTimeout(()=>{void searchClient.search(query.trim()).then(value=>{if(current)setResult(value);}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:'搜索暂时不可用');}).finally(()=>{if(current)setLoading(false);});},200);return()=>{current=false;clearTimeout(timer);};},[open,query]);
  const match=(text:string)=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const choose=(action:()=>void)=>{onClose();action();};
  return <Dialog open={open} title="快速跳转" onClose={onClose}><div className="quick-jump" onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-quick-target]')];if(!buttons.length)return;event.preventDefault();const current=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}}}>
    <SearchInput ref={input} label="搜索页面、任务和会话" placeholder="搜索页面、任务和会话…" value={query} onChange={event=>setQuery(event.target.value)}/>
    <p className="muted">Ctrl+K 打开 · ↑↓ 选择 · Enter 打开 · Esc 关闭</p>
    <div className="quick-jump-results"><h3>页面</h3>{pages.filter(row=>match(row.label+' '+row.hint)).map(row=><Button type="button" data-quick-target key={row.id} variant="ghost" onClick={()=>choose(()=>onNavigate(row.id))}><Icon name={row.icon}/><span><strong>{row.label}</strong><small>{row.hint}</small></span></Button>)}
      {workspaces.filter(row=>match(row.name)).length>0&&<h3>工作区</h3>}{workspaces.filter(row=>match(row.name)).slice(0,12).map(row=><Button type="button" data-quick-target key={row.id} variant="ghost" icon="folder" onClick={()=>choose(()=>onOpenWorkspace(row.id))}>{row.name}</Button>)}
      {loading&&<p role="status">正在搜索本机记录…</p>}{error&&<p role="alert">{error}。页面跳转仍可使用。</p>}
      {result?.sessions.map(row=><Button type="button" data-quick-target variant="ghost" key={'session'+row.id} icon="chat" onClick={()=>choose(()=>onOpenSession(row.id))}>{row.title||'新会话'}<small>会话</small></Button>)}
      {result?.tasks.map(row=><Button type="button" data-quick-target variant="ghost" key={'task'+row.id} icon="work" onClick={()=>choose(()=>onOpenTask(row.id))}>{row.title||row.goal}<small>任务</small></Button>)}
      {result?.plugins.map(row=><Button type="button" data-quick-target variant="ghost" key={'plugin'+row.id} icon="plugins" onClick={()=>choose(()=>onNavigate('plugins'))}>{row.name}<small>在插件中心查看</small></Button>)}
      {query&&!loading&&!error&&result&&!pages.some(row=>match(row.label+' '+row.hint))&&!result.sessions.length&&!result.tasks.length&&!result.plugins.length&&!workspaces.some(row=>match(row.name))&&<p>没有匹配项，换一个关键词试试。</p>}
    </div></div></Dialog>;
}
