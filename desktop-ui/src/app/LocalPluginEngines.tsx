import {useEffect,useRef,useState} from 'react';
import {hostClient,taskClient,uiCall,type Task} from '../bridge/typed-client';
import {Button,Select} from '../components/primitives/inputs';
import {Badge,Card} from '../components/primitives/surfaces';
import {Sheet} from '../components/primitives/overlays';
import {Icon} from '../components/icons';
import {ErrorNotice,messageOf} from './PagePresentation';

type PluginId='agentos'|'reverselab';
export const externalPluginCategory='外部插件';
export type ExternalPlugin={id:PluginId;name:string;enabled:boolean;root:string;nodePath:string;version:string;summary:string[];active:number;package?:{managed:boolean};workbench?:{available:boolean;open:boolean;dataScope:'standalone'}};
export type ExternalPluginInventory={engines:ExternalPlugin[];errorCode?:string|null};
export type ExternalPackageReview={id:PluginId;name:string;token:string;version:string;digest:string;sourceSha256:string;files:number;bytes:number;installed:boolean;installable:boolean;summary:string[]};
export async function reviewExternalPackage(file:string){return uiCall<ExternalPackageReview>('ui.plugins.engines.package.review',{file});}

export function ExternalPluginCard({plugin,onOpen}:{plugin:ExternalPlugin;onOpen():void}){
 const[opening,setOpening]=useState(false),[error,setError]=useState('');
 async function openWorkbench(){setOpening(true);setError('');try{await uiCall('ui.plugins.engines.workbench.open');}catch(cause){setError(messageOf(cause));}finally{setOpening(false);}}
 return <Card className="plugin-card"><button type="button" className="plugin-card-main" onClick={onOpen}>
  <span className="plugin-icon"><Icon name="plugins" size={20}/></span><span className="plugin-card-copy"><strong>{plugin.name}</strong><small>外部插件 · v{plugin.version}</small></span>
  <Badge tone={plugin.enabled?'success':'default'}>{plugin.enabled?'已启用':'已停用'}</Badge>
 </button><div className="plugin-card-actions"><Button compact variant="ghost" onClick={onOpen}>管理插件</Button>{plugin.id==='agentos'&&<Button compact disabled={!plugin.enabled||opening} onClick={()=>void openWorkbench()}>{opening?'正在打开…':'打开工作台'}</Button>}</div>{error&&<ErrorNotice error={error}/>}</Card>;
}
export function ExternalPluginPanel({plugin,packageReview,onClose,onChange}:{plugin:ExternalPlugin|null;packageReview?:ExternalPackageReview;onClose():void;onChange():Promise<void>}){
 const[registered,setRegistered]=useState(plugin),[review,setReview]=useState<ExternalPackageReview|null>(packageReview??null);
 const[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[remove,setRemove]=useState(false);
 const[tasks,setTasks]=useState<Task[]>([]),[taskId,setTaskId]=useState('');
 const currentReview=useRef(review),alive=useRef(true);currentReview.current=review;
 const enabled=registered?.enabled===true;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;const token=currentReview.current?.token;if(token)void uiCall('ui.plugins.engines.package.cancel',{token}).catch(()=>{/* Core also cleans its owned stages on shutdown. */});};},[]);
 useEffect(()=>{if(!enabled)return;let active=true;void taskClient.overview('','queued').then(result=>{if(active)setTasks(result.tasks.filter(task=>!task.currentAgent&&!task.parentTaskId));}).catch(cause=>{if(active)setError(messageOf(cause));});return()=>{active=false;};},[enabled]);
 async function run(action:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await action();}catch(cause){if(alive.current)setError(messageOf(cause));}finally{if(alive.current)setBusy(false);}}
 async function refresh(id:PluginId){const result=await uiCall<ExternalPluginInventory>('ui.plugins.engines.list');if(alive.current)setRegistered(result.engines.find(row=>row.id===id)??null);await onChange();}
 async function cancelReview(){const token=currentReview.current?.token;if(token)await uiCall('ui.plugins.engines.package.cancel',{token});currentReview.current=null;setReview(null);}
 async function choosePackage(){const picked=await hostClient.pickExtensionPackage();if(!picked.path)return;const next=await reviewExternalPackage(picked.path);
  if(registered&&registered.id!==next.id){await uiCall('ui.plugins.engines.package.cancel',{token:next.token});throw Error('请选择当前插件的更新包。');}
  await cancelReview();if(alive.current)setReview(next);
 }
 async function install(){if(!review)return;await uiCall('ui.plugins.engines.package.install',{id:review.id,token:review.token,reviewed:true,enable:true});currentReview.current=null;setReview(null);await refresh(review.id);if(alive.current)setNotice('插件已安装并启用。项目 Agent 可按任务授权请求调用。');}
 async function toggle(){if(!registered)return;
  if(registered.enabled)await uiCall('ui.plugins.engines.disable',{id:registered.id});
  else{const checked=await uiCall<{token:string}>('ui.plugins.engines.review',{id:registered.id,root:registered.root,nodePath:registered.nodePath});await uiCall('ui.plugins.engines.enable',{id:registered.id,token:checked.token});}
  await refresh(registered.id);
 }
 async function authorize(){const task=tasks.find(row=>row.id===taskId);if(!task||!registered)return;await uiCall('ui.plugins.engines.authorize-task',{id:registered.id,taskId,expectedRev:task.rev});setNotice('已为该任务开放插件调用请求，实际工具操作仍需审批。');}
 return <Sheet open title={registered?.name??review?.name??'安装外部插件'} onClose={()=>{if(!busy)void run(async()=>{await cancelReview();onClose();});}}><div className="plugin-detail">
  {error&&<ErrorNotice error={error}/>} {notice&&<p role="status">{notice}</p>}
  {!registered&&!review&&<><p>选择插件 ZIP 安装包，程序会自动识别插件并准备运行环境。</p><Button variant="primary" disabled={busy} onClick={()=>void run(choosePackage)}>选择插件压缩包</Button></>}
  {review&&<section aria-label="插件安装审查"><h3>{review.name} <small>v{review.version}</small></h3><p>文件已核验，安装目录与运行环境将自动配置。</p><ul>{review.summary.map(line=><li key={line}>{line}</li>)}</ul><details><summary>安装包信息</summary><p>{review.files} 个文件 · {(review.bytes/1024/1024).toFixed(1)} MB</p><code style={{overflowWrap:'anywhere'}}>SHA-256 {review.sourceSha256}</code></details>
   <div className="row detail-actions"><Button disabled={busy} onClick={()=>void run(cancelReview)}>取消</Button><Button disabled={busy} onClick={()=>void run(choosePackage)}>重新选择安装包</Button><Button variant="primary" disabled={busy||!review.installable} onClick={()=>void run(install)}>{busy?'正在安装…':review.installed?'确认更新并启用':'确认安装并启用'}</Button></div></section>}
  {registered&&!review&&<><p><Badge tone={enabled?'success':'default'}>{enabled?'已启用':'已停用'}</Badge> <span className="muted">v{registered.version} · 进行中的操作 {registered.active}</span></p><ul>{registered.summary.map(line=><li key={line}>{line}</li>)}</ul>
   {registered.id==='agentos'&&<section><h3>AgentOS 工作台</h3><p>使用插件自带的原生工作台管理独立环境、系统镜像和下载。任务的受管系统继续由 Core 授权管理，不会自动接管或混入这里。</p><Button disabled={busy||!enabled} onClick={()=>void run(async()=>{await uiCall('ui.plugins.engines.workbench.open');await refresh('agentos');setNotice('已打开 AgentOS 原生工作台。关闭工作台后可更新、停用或卸载插件。');})}>打开工作台</Button>{registered.workbench?.available===false&&<p className="muted">当前安装包没有完整 Windows 工作台文件；请导入包含工作台的插件更新 ZIP。</p>}</section>}
   <div className="row detail-actions"><Button variant="primary" disabled={busy||registered.active>0} onClick={()=>void run(toggle)}>{enabled?'停用':'启用'}</Button><Button disabled={busy||registered.active>0} onClick={()=>void run(choosePackage)}>导入更新包</Button><Button variant="danger" disabled={busy||registered.active>0} onClick={()=>setRemove(true)}>卸载</Button></div>
   {registered.active>0&&<p className="muted">等待当前操作结束后，可更新、停用或卸载。</p>}
   {remove&&<section><p>卸载插件程序文件，保留历史任务、分析记录和虚拟机数据。</p><div className="row"><Button disabled={busy} onClick={()=>setRemove(false)}>取消</Button><Button variant="danger" disabled={busy} onClick={()=>void run(async()=>{await uiCall('ui.plugins.engines.uninstall',{id:registered.id});await onChange();onClose();})}>确认卸载</Button></div></section>}
   {enabled&&<section><h3>项目 Agent 调用</h3><p>选择待启动的项目任务，开放本插件的调用请求。</p><Select label="待启动任务" value={taskId} disabled={busy} onChange={event=>setTaskId(event.target.value)}><option value="">选择待启动任务</option>{tasks.map(task=><option key={task.id} value={task.id}>{task.title||task.goal}</option>)}</Select><Button disabled={busy||!taskId} onClick={()=>void run(authorize)}>允许任务请求调用</Button></section>}
   <details><summary>安装位置</summary><p style={{overflowWrap:'anywhere'}}>{registered.root}</p></details>
  </>}
 </div></Sheet>;
}
