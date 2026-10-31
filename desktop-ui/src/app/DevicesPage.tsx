import {useCallback,useEffect,useState} from 'react';
import {deviceClient,type DeviceOverview,type DevicePeer} from '../bridge/typed-client';
import {Button,SearchInput,Tabs} from '../components/primitives/inputs';
import {Badge,Banner,Card,LoadingState,Surface} from '../components/primitives/surfaces';
import {Sheet} from '../components/primitives/overlays';
const labels:Record<string,string>={online:'在线',offline:'离线',blocked:'已阻止',trusted:'已信任',pending:'待确认',unknown:'未知',desktop:'桌面',mobile:'移动设备'};
export function DevicesPage(){
  const [data,setData]=useState<DeviceOverview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[page,setPage]=useState(0),[selected,setSelected]=useState<DevicePeer|null>(null);
  const refresh=useCallback(async()=>{setBusy(true);try{setData(await deviceClient.overview());setError('');}catch(cause){setError(cause instanceof Error?cause.message:'设备状态加载失败');}finally{setBusy(false);}},[]);
  useEffect(()=>{void refresh();},[refresh]);
  const peers=(data?.peers??[]).filter(row=>(filter==='all'||row.presence===filter||row.trust===filter)&&(row.name+' '+row.role).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const current=Math.min(page,Math.max(0,Math.ceil(peers.length/50)-1));
  return <div className="content-page devices-page"><header className="page-heading"><div><p className="eyebrow">DEVICES & ENVIRONMENTS</p><h1>设备与环境</h1><p className="page-description">查看真实连接状态和已授予能力。</p></div><Button icon="refresh" disabled={busy} onClick={()=>void refresh()}>{busy?'正在刷新…':'刷新状态'}</Button></header>
    <Banner>信任与能力授权相互独立；设备在线不代表可以执行任务，也不代表环境测试通过。</Banner>
    {error&&<p role="alert" className="inline-error">{error}。已读取的状态仍保留。</p>}
    {busy&&!data?<LoadingState label="正在读取设备…"/>:data&&<><Surface className="device-local"><div><strong>{data.local?.name||'本机节点'}</strong><p>{data.enabled===true?'设备网格已启用':data.enabled===false?'设备网格已停用':'网格状态未知'}</p></div><Badge tone={data.enabled===true?'accent':'warning'}>{data.available?'Core 已返回状态':'服务未接入'}</Badge></Surface>
    <div className="row between work-controls"><Tabs label="设备状态筛选" items={[{id:'all',label:'全部'},{id:'online',label:'在线'},{id:'offline',label:'离线'},{id:'blocked',label:'已阻止'}]} selected={filter} onChange={value=>{setFilter(value);setPage(0);}}/><SearchInput label="搜索设备" placeholder="搜索名称或类型" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></div>
    <div className="device-grid">{peers.slice(current*50,current*50+50).map(row=><Card key={row.id}><div className="row between"><h3>{row.name||'未命名设备'}</h3><Badge tone={row.presence==='online'?'success':row.trust==='blocked'?'danger':'default'}>{labels[row.presence]||'状态未知'}</Badge></div><p>{labels[row.role]||row.role} · {labels[row.trust]||'信任未知'}</p><small>{row.grants.length} 项已授予能力</small>{row.lastError&&<p className="inline-error">{row.lastError}</p>}<Button compact variant="ghost" onClick={()=>setSelected(row)}>查看设备详情</Button></Card>)}</div>
    {!peers.length&&<Surface className="cm-empty"><h3>{query?'没有匹配设备':'尚无设备记录'}</h3><p>{data.enabled===false?'在设置中启用设备网格后，使用现有配对流程连接设备。':'连接与能力验证成功后才会显示实际就绪状态。'}</p></Surface>}
    {peers.length>50&&<nav className="row between" aria-label="设备分页"><Button disabled={!current} onClick={()=>setPage(current-1)}>上一页</Button><span>{current+1} / {Math.ceil(peers.length/50)}</span><Button disabled={(current+1)*50>=peers.length} onClick={()=>setPage(current+1)}>下一页</Button></nav>}
    {data.truncated&&<p role="status">仅显示服务返回的前 500 条设备记录。</p>}
    <Surface className="environment-summary"><h2>执行环境与验收</h2><Badge tone="warning">未关联验收证据</Badge><p>设备连接不是 Windows Guest 或 AgentOS 测试结果。执行环境的权限、日志、取消与恢复仍通过现有任务流程管理；只有实际报告可以证明测试通过。</p><details><summary>最近连接诊断</summary>{data.audit.length?data.audit.map((row,index)=><p key={index}><code>{row.code||'未知事件'}</code> · {row.at?new Date(row.at).toLocaleString():'时间未知'}</p>):<p>暂无诊断记录。</p>}</details></Surface></>}
    <Sheet open={!!selected} title="设备详情" onClose={()=>setSelected(null)}>{selected&&<div className="detail-stack"><h3>{selected.name}</h3><p>{labels[selected.trust]||selected.trust} · {labels[selected.presence]||selected.presence}</p><h4>已授予能力</h4>{selected.grants.length?<ul>{selected.grants.map(cap=><li key={cap}><code>{cap}</code></li>)}</ul>:<p>没有授予额外能力。</p>}<p>最近在线：{selected.lastSeenAt?new Date(selected.lastSeenAt).toLocaleString():'未知'}</p><details><summary>身份与诊断</summary><code>{selected.id}</code>{selected.lastError&&<p>{selected.lastError}</p>}</details></div>}</Sheet>
  </div>;
}
