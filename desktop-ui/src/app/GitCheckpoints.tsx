import {useEffect,useRef,useState} from 'react';
import {Button,Input,Select} from '../components/primitives/inputs';
import {Surface} from '../components/primitives/surfaces';
import {approvalClient} from '../bridge/typed-client';

type Checkpoint={workspaceId:string;id:string;label:string;head:string;headRef:string|null;paths:string[];bytes:number;createdAt:number};
type Review=Record<string,unknown>&{workspaceId:string;checkpointId:string;mode:'saved'|'head';paths:string[]};
type Preview={workspaceId:string;checkpointId:string;path:string;content:string;binary:boolean;deleted:boolean;truncated:boolean;byteLength:number};
type Props={workspaceId:string;call(method:string,params:Record<string,unknown>):Promise<unknown>;disabled:boolean;dirtySwitch:boolean;revision:number;onPending(value:boolean):void;onChanged():void|Promise<void>};
const fields=['checkpointId','checkpointSha256','mode','paths','expectedHead','expectedHeadRef','expectedRepositoryIdentity','indexIdentity','expectedHashes','expectedDirtyIdentity','expectedWorkingModes'];
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);

/** UI state only. Artifacts and effect evidence remain owned by Workspace/Core. */
export function GitCheckpoints(props:Props){
 const {workspaceId,disabled,revision,dirtySwitch}=props,latest=useRef(props);latest.current=props;
 const epoch=useRef(0),request=useRef(0),inFlight=useRef(false);
 const [items,setItems]=useState<Checkpoint[]>([]),[selected,setSelected]=useState(''),[label,setLabel]=useState('');
 const [review,setReview]=useState<Review|null>(null),[preview,setPreview]=useState<Preview|null>(null),[pending,setPending]=useState<{id:string;mode:'saved'|'head'}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{epoch.current++;request.current++;inFlight.current=false;setBusy(false);setItems([]);setSelected('');setLabel('');setReview(null);setPreview(null);setPending(null);setError('');setNotice('');latest.current.onPending(false);return()=>{epoch.current++;request.current++;};},[workspaceId]);
 useEffect(()=>{let current=true;const id=++request.current;setReview(null);void latest.current.call('ui.workspace.git.checkpoint.list',{id:workspaceId}).then(value=>{const result=value as {workspaceId:string;entries:Checkpoint[]};if(current&&request.current===id&&latest.current.workspaceId===workspaceId){if(result.workspaceId!==workspaceId)throw Error('检查点工作区身份不匹配。');setItems(result.entries);setSelected(previous=>result.entries.some(row=>row.id===previous)?previous:result.entries[0]?.id??'');}}).catch(cause=>{if(current&&request.current===id)setError(message(cause));});return()=>{current=false;};},[workspaceId,revision,reload]);
 useEffect(()=>{if(!pending)return;let current=true,timer:ReturnType<typeof setTimeout>|undefined;const target=workspaceId;
  async function poll(){try{const result=await approvalClient.list();if(!current||latest.current.workspaceId!==target)return;
   const operation=result.operations?.find(row=>row.approvalId===pending!.id),approval=result.approvals.find(row=>row.id===pending!.id);
   if(operation&&!['accepted','running','waiting'].includes(operation.status)){
    const success=operation.status==='completed'&&operation.decision==='approved';setNotice(success?(pending!.mode==='head'?'已完成准备切换；请重新审查目标分支，再单独批准切换。':'已恢复保存内容；工作文件和独立暂存索引已核验。'):operation.status==='unknown'?'恢复结果未知；原文件与事务日志已保留，不能再次执行或继续切换。':'恢复未执行或未完成；请核对审批记录后重新审查。');
    setPending(null);setReview(null);latest.current.onPending(false);setReload(value=>value+1);await latest.current.onChanged();return;
   }
   const expires=approval?.expiresAt==null?null:typeof approval.expiresAt==='number'?approval.expiresAt:Date.parse(approval.expiresAt);
   if(!operation&&(!approval||expires!==null&&expires<=Date.now())){setPending(null);setReview(null);latest.current.onPending(false);setNotice('审批已过期或不再待决；没有完成回执。请重新审查后显式申请。');return;}
  }catch(cause){if(current)setError(message(cause));}if(current)timer=setTimeout(()=>void poll(),1000);}
  void poll();return()=>{current=false;if(timer)clearTimeout(timer);};
 },[pending,workspaceId]);
 async function action(work:(target:string)=>Promise<void>){if(disabled||pending||inFlight.current)return;inFlight.current=true;setBusy(true);setError('');const generation=epoch.current;try{await work(workspaceId);}catch(cause){if(epoch.current===generation)setError(message(cause));}finally{if(epoch.current===generation){inFlight.current=false;setBusy(false);}}}
 const current=(target:string,id:number)=>latest.current.workspaceId===target&&request.current===id;
 async function capture(prepare=false){await action(async target=>{const id=++request.current;setReview(null);const saved=await latest.current.call('ui.workspace.git.checkpoint.capture',{id:target,label}) as Checkpoint;if(!current(target,id))return;if(saved.workspaceId!==target)throw Error('保存检查点工作区不匹配。');setItems(previous=>[saved,...previous.filter(row=>row.id!==saved.id)]);setSelected(saved.id);setPreview(null);setNotice('已保存检查点；项目文件和索引未改变。');if(prepare){const result=await latest.current.call('ui.workspace.git.checkpoint.review',{id:target,checkpointId:saved.id,mode:'head'}) as Review;if(current(target,id)&&result.workspaceId===target&&result.checkpointId===saved.id)setReview(result);}});}
 async function inspect(mode:'saved'|'head'){await action(async target=>{const id=++request.current;setReview(null);const value=await latest.current.call('ui.workspace.git.checkpoint.review',{id:target,checkpointId:selected,mode}) as Review;if(current(target,id)){if(value.workspaceId!==target||value.checkpointId!==selected||value.mode!==mode)throw Error('检查点审查范围已变化。');setReview(value);}});}
 async function showFile(path:string){await action(async target=>{const id=++request.current;setPreview(null);const value=await latest.current.call('ui.workspace.git.checkpoint.preview',{id:target,checkpointId:selected,path}) as Preview;if(current(target,id)){if(value.workspaceId!==target||value.checkpointId!==selected||value.path!==path)throw Error('检查点预览范围已变化。');setPreview(value);}});}
 async function submit(){if(!review||review.workspaceId!==workspaceId||review.checkpointId!==selected)return;const source=review;await action(async target=>{const id=++request.current;const result=await latest.current.call('ui.workspace.git.checkpoint.restore',{id:target,...Object.fromEntries(fields.map(key=>[key,source[key]]))}) as {status?:string;approvalId?:string};if(!current(target,id))return;if(result.status!=='pending'||!result.approvalId)throw Error('恢复请求尚无待决审批，请检查操作记录。');setPending({id:result.approvalId,mode:source.mode});setReview(null);latest.current.onPending(true);setNotice('检查点恢复等待一次性审批；待决不代表文件已经改变。');await latest.current.onChanged();});}
 const chosen=items.find(row=>row.id===selected),locked=disabled||busy||!!pending;
 return <Surface className="git-checkpoints" aria-label="Git 检查点"><h2>Git 检查点</h2><p>保存全部有界脏文件与独立暂存索引，包含未跟踪和二进制文件；ignored 文件未备份。这不是完整项目备份。</p><small>恢复保存内容要求原分支和原 HEAD；请先显式切回原分支，不会跨分支自动合并。最多 100 个文件、20 个保留检查点。</small>
  <Input aria-label="检查点备注" value={label} disabled={locked} maxLength={120} placeholder="可选保存备注" onChange={event=>setLabel(event.target.value)}/><Button compact disabled={locked} onClick={()=>void capture()}>保存 Git 检查点</Button>{dirtySwitch&&<Button compact disabled={locked} onClick={()=>void capture(true)}>保存检查点并准备切换</Button>}
  <Button compact disabled={busy} onClick={()=>{request.current++;setReview(null);setReload(value=>value+1);}}>刷新检查点</Button>
  {!!items.length&&<><Select label="已保存检查点" value={selected} disabled={locked} onChange={event=>{request.current++;setSelected(event.target.value);setReview(null);setPreview(null);}}>{items.map(row=><option key={row.id} value={row.id}>{(row.label||row.id)+' · '+row.paths.length+' 个文件'}</option>)}</Select>{chosen&&<><code>{chosen.headRef??'Detached HEAD'} · {chosen.head}</code><ul>{chosen.paths.map(path=><li key={path}><Button compact variant="ghost" disabled={locked} onClick={()=>void showFile(path)}>预览保存文件 {path}</Button></li>)}</ul><Button compact disabled={locked} onClick={()=>void inspect('saved')}>审查恢复保存内容</Button><Button compact disabled={locked} onClick={()=>void inspect('head')}>审查准备切换</Button></>}</>}
  {preview&&<pre className="git-checkpoint-preview" style={{maxHeight:320,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{preview.path}{'\n'}{preview.deleted?'保存时文件不存在':preview.binary?'二进制文件 · '+preview.byteLength+' bytes':preview.content}{preview.truncated?'\n仅显示前 64000 bytes':''}</pre>}
  {review&&<section className="git-checkpoint-review"><strong>{review.mode==='head'?'将已保存的精确脏文件恢复到原 HEAD，再单独审查分支切换':'恢复保存的工作文件与独立暂存内容'}</strong><p>{review.paths.length} 个文件；审批绑定当前文件、HEAD 和索引，后续编辑会使请求失效。</p><Button compact disabled={locked} onClick={()=>void submit()}>请求一次性恢复审批</Button></section>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 </Surface>;
}
