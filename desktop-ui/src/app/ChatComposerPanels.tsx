import {useState} from 'react';
import type {ChatContextObservation, ChatModelProvider, ModelUsage, ChatModelCapabilities} from '../bridge/typed-client';
import {Popover} from '../components/primitives/overlays';
import {Icon} from '../components/icons';
import './chat-composer-panels.css';

const known=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const count=(value:unknown)=>known(value)?value.toLocaleString('en-US'):'未知';
const evidence=(status:string|undefined)=>status==='actual'?'实际':status==='estimated'?'估算':'未知';
const usageSourceLabels=new Map([['structured-provider-receipts','结构化供应商回执'],['explicit-usage-estimate','显式用量估算'],['unattributed-usage','来源未归属']]);
export function contextPresentation(context:ChatContextObservation|null|undefined){
  const usable=!!context&&context.schemaVersion===1&&context.status!=='unknown'&&known(context.inputTokens);
  const effective=!!context&&context.capacityStatus!=='unknown'&&known(context.windowTokens)&&known(context.reservedOutputTokens)&&context.windowTokens>context.reservedOutputTokens?context.windowTokens-context.reservedOutputTokens:null;
  const percent=usable&&effective!==null?context.inputTokens!*100/effective:null;
  return {effective,percent,inputTokens:usable?context.inputTokens:null};
}
export function configurationChangeBlocked(status:{state:string;followState?:string;errorCode?:string|null}){
  return ['starting','streaming','running','recovering','cancelling','waiting-approval','needs-reconciliation','outcome-unknown','interrupted','awaiting-reply'].includes(status.state)
    || ['recovering','reconnecting','connecting'].includes(status.followState??'')
    || /OUTCOME_UNKNOWN|NEEDS_RECONCILIATION|RECONCILIATION_REQUIRED|EXECUTION_UNKNOWN|EXIT_UNCONFIRMED/.test(status.errorCode??'');
}
function UsageLedger({usage,label}:{usage:ModelUsage|null|undefined;label:string}){
  const cost=usage?.cost;
  const completeCost=cost?.complete===true&&known(cost.amount)&&!!cost.currency&&['actual','estimated'].includes(cost.status);
  const hit=known(usage?.inputTokens)&&usage.inputTokens>0&&known(usage.cacheReadTokens)&&usage.cacheReadTokens<=usage.inputTokens?`${Math.round(usage.cacheReadTokens/usage.inputTokens*10000)/100}%`:'未知';
  return <section className="chat-usage-ledger"><div className="chat-panel-heading"><h4>{label}</h4><small>{usage?.accountingComplete===true?'核算完整':usage?.accountingComplete===false?'已知部分':'完整性未知'}</small></div>
    <p className="chat-context-caption">{evidence(usage?.measurement?.status)} · {usageSourceLabels.get(usage?.measurement?.source??'')||'来源未知'}</p>
    <dl className="chat-stat-grid">{[['输入',usage?.inputTokens],['输出',usage?.outputTokens],['推理',usage?.reasoningTokens],['缓存读取',usage?.cacheReadTokens],['缓存写入',usage?.cacheWriteTokens],['请求',usage?.requestCount]].map(([name,value])=><div key={String(name)}><dt>{name}</dt><dd>{count(value)}</dd></div>)}<div><dt>有效缓存命中</dt><dd>{hit}</dd></div></dl>
    <p className="chat-cost-line">{completeCost?`${evidence(cost.status)}费用 ${cost.currency} ${cost.amount}`:'费用未知'}{!completeCost&&known(cost?.knownAmount)&&cost?.currency&&<small>已核算 {cost.currency} {cost.knownAmount}，不代表总费用</small>}</p>
  </section>;
}
export function ChatUsageContent({context,turnUsage,sessionUsage}:{context?:ChatContextObservation|null;turnUsage?:ModelUsage|null;sessionUsage?:ModelUsage|null}){
  const view=contextPresentation(context);
  const title=context?.phase==='active-request'?'当前请求上下文':context?.phase==='last-request'?'最近请求上下文':'上下文未知';
  return <div className="chat-usage-panel"><div className="chat-panel-heading"><h3>{title}</h3><span className="chat-evidence-label">{evidence(context?.status)}</span></div>
    <div className="chat-context-numbers"><strong>{count(view.inputTokens)}<small>已用输入</small></strong><span>/</span><strong>{count(context?.windowTokens)}<small>模型总窗口</small></strong></div>
    {view.percent!==null?<><div className="chat-context-meter" role="progressbar" aria-label="可用于输入容量占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100,Math.round(view.percent))} aria-valuetext={`${Math.round(view.percent*10)/10}% · ${evidence(context?.status)}`}><span style={{width:`${Math.min(100,view.percent)}%`}} /></div><small className="chat-context-caption">{Math.round(view.percent*10)/10}% · 可用于输入容量 {count(view.effective)} · 输出预留 {count(context?.reservedOutputTokens)}</small></>:<p className="chat-context-caption">占用比例未知 · 输出预留 {count(context?.reservedOutputTokens)}</p>}
    <dl className="chat-context-composition">{(['messages','system','tools','other'] as const).map((key,index)=><div key={key}><dt>{['消息','系统提示','工具定义','其他'][index]}</dt><dd>{count(context?.composition?.[key]?.status==='estimated'?context.composition[key].tokens:null)} <small>{evidence(context?.composition?.[key]?.status)}</small></dd></div>)}</dl>
    {context?.phase==='last-request'&&<p className="chat-context-caption">这是最近一次请求的快照，尚未包含之后的编辑。</p>}
    <details className="chat-evidence-details"><summary>统计依据</summary><p>提供方 {context?.providerId||'未知'} · 模型 {context?.model||'未知'}</p><p>来源 {context?.source||'未知'} · 版本 {context?.version||'未知'}</p>{context?.estimator&&<p>构成估算 {context.estimator}</p>}<p>窗口依据 {context?.capacityStatus==='verified'?'已验证':context?.capacityStatus==='declared'?'服务声明':'未知'}</p>{known(context?.at)&&<p>记录时间 {new Date(context.at).toLocaleTimeString()}</p>}{context?.projection&&<p>请求投影 {context.projection.status==='observed'?`${count(context.projection.bytes)} / ${count(context.projection.maxBytes)} 字节`:'未知'} · 压缩 {context.projection.compacted===true?'已压缩':context.projection.compacted===false?'未压缩':'未知'} · 截断 {context.projection.truncated===true?'是':context.projection.truncated===false?'否':'未知'}</p>}</details>
    <UsageLedger label="本轮用量" usage={turnUsage}/><UsageLedger label="会话累计用量" usage={sessionUsage}/><p className="chat-context-caption">累计消耗不代表上下文占用。当前连接未提供额度与重置时间。</p>
  </div>;
}
export function ChatUsagePopover(props:{context?:ChatContextObservation|null;turnUsage?:ModelUsage|null;sessionUsage?:ModelUsage|null}){
  const view=contextPresentation(props.context);
  return <Popover avoidOverlapWith=".chat-composer" label="上下文与用量" className="chat-usage-popover" triggerClassName="composer-panel-trigger composer-usage-trigger" width={352} summary={<><span className={`chat-context-ring ${view.percent===null?'unknown':''}`} style={view.percent===null?undefined:{background:`conic-gradient(var(--accent) ${Math.min(100,view.percent)}%, var(--border) 0)`}} aria-hidden="true"/><span>{view.percent===null?'用量':`${props.context?.status==='estimated'?'≈':''}${Math.round(view.percent)}%`}</span></>}><ChatUsageContent {...props}/></Popover>;
}
const modelId=(model:ChatModelProvider['models'][number])=>model.id||model.name||model.modelName||'';
const modelName=(model:ChatModelProvider['models'][number])=>model.displayName||model.label||model.name||model.modelName||model.id||'默认模型';
export function supportedReasoning(capabilities:ChatModelCapabilities|undefined){return capabilities?.reasoning?.status==='declared'?[...new Set(capabilities.reasoning.levels)].filter(level=>['off','low','high','max'].includes(level)):[];}
function CapabilityLabel({name,capability}:{name:string;capability:ChatModelCapabilities['vision']|undefined}){
  const label=capability?.supported===true&&capability.status==='verified'?`${name}已验证`:capability?.supported===true&&capability.status==='declared'?`${name}声明支持`:capability?.supported===false&&capability.status!=='unknown'?`${name}不支持`:`${name}能力未知`;
  return <span title={capability?.source||'来源未知'} className={capability?.status==='verified'&&capability.supported===true?'verified':''}>{label}</span>;
}
export type ChatModelPickerProps={models:ChatModelProvider[];selectedModelKey:string;selectedAgent:string;agentLabel:string;selectedReasoning?:string;disabledReason?:string|null;query:string;onQueryChange(value:string):void;onModelChange(value:string):void;onReasoningChange(value:string):void;onConfigure():void;onClose():void};
export function ChatModelPickerContent({models,selectedModelKey,selectedAgent,agentLabel,selectedReasoning,disabledReason,query,onQueryChange,onModelChange,onReasoningChange,onConfigure,onClose}:ChatModelPickerProps){
  let providerId='',currentModel='';try{[providerId,currentModel]=JSON.parse(selectedModelKey);}catch{/* Unknown selections are displayed without inventing an alternative. */}
  const selectedProvider=models.find(provider=>provider.id===providerId);
  const selected=selectedProvider?.models.find(model=>modelId(model)===currentModel);
  const levels=supportedReasoning(selected?.capabilities);
  const external=selectedAgent==='codex';
  return <div className="chat-model-panel"><div className="chat-panel-heading"><h3>模型与推理</h3><span className="chat-evidence-label">{agentLabel}</span></div>
    <div className="chat-current-model"><small>当前提供方</small><strong>{external?'Codex 本机配置':selectedProvider?.label||providerId||'自动选择'}</strong><span>{external?'模型由本机 Agent 管理':selected?modelName(selected):currentModel||'默认模型'}</span><small>{external?'外部 Agent 能力需单独验证':selectedProvider?.configured?(selectedProvider.inferencing===true?'推理已验证':selectedProvider.authenticated===true?'认证已验证 · 推理未验证':'已配置 · 认证未验证'):'未配置或不可用'}</small>{!external&&<small>上下文窗口 {count(selected?.capabilities?.context?.contextWindowTokens)} · 最大输出 {count(selected?.capabilities?.context?.maxOutputTokens)}</small>}</div>
    {disabledReason&&<p className="chat-panel-lock" role="status">{disabledReason}</p>}
    {!external&&<><label className="chat-model-search"><Icon name="search" size={15}/><input aria-label="搜索模型" value={query} placeholder="搜索模型或提供方" onChange={event=>onQueryChange(event.target.value)}/></label><div className="chat-model-options" role="listbox" aria-label="可用模型">{models.map(provider=>{const options=provider.models.filter(model=>`${provider.label} ${modelName(model)} ${modelId(model)}`.toLowerCase().includes(query.toLowerCase()));if(!options.length)return null;return <div className="chat-model-group" key={provider.id}><h4>{provider.label}<small>{provider.configured?'已配置':'未配置'}</small></h4>{options.map(model=>{const value=JSON.stringify([provider.id,modelId(model)]);return <button type="button" role="option" aria-selected={value===selectedModelKey} disabled={!!disabledReason||!provider.configured||provider.catalogState==='error'} key={value} onClick={()=>{onModelChange(value);onClose();}}><span className="chat-model-option-name"><strong>{modelName(model)}</strong>{value===selectedModelKey&&<Icon name="check" size={15}/>}</span><span className="chat-model-capabilities"><CapabilityLabel name="视觉" capability={model.capabilities?.vision}/><CapabilityLabel name="工具" capability={model.capabilities?.tools}/></span></button>;})}</div>;})}{!models.some(provider=>provider.models.length)&&<p className="muted">暂无模型目录，请先配置服务。</p>}</div></>}
    {!external&&<section className="chat-reasoning"><div className="chat-panel-heading"><h4>推理强度</h4><small>{levels.length?'服务声明':'未启用 / 不可配置'}</small></div>{levels.length?<div className="chat-reasoning-levels">{levels.map(level=><button type="button" key={level} aria-label={`推理强度 ${level}`} aria-pressed={selectedReasoning===level} disabled={!!disabledReason} onClick={()=>onReasoningChange(level)}>{({off:'关闭',low:'低',high:'高',max:'最高'} as Record<string,string>)[level]||level}</button>)}</div>:<p className="chat-context-caption">该模型未声明可配置的推理等级。</p>}</section>}
    <button className="chat-panel-settings" type="button" onClick={()=>{onClose();onConfigure();}}><Icon name="settings" size={15}/>模型与服务设置<Icon name="right" size={14}/></button>
  </div>;
}
export function ChatModelPicker(props:Omit<ChatModelPickerProps,'query'|'onQueryChange'|'onClose'>){
  const [query,setQuery]=useState('');let providerId='',id='';try{[providerId,id]=JSON.parse(props.selectedModelKey);}catch{/* Preserve unknown selection. */}
  const selected=props.models.find(provider=>provider.id===providerId)?.models.find(model=>modelId(model)===id);
  return <Popover avoidOverlapWith=".chat-composer" label="选择模型与推理" className="chat-model-popover" triggerClassName="composer-panel-trigger composer-model-trigger" width={368} summary={<><Icon name="sparkles" size={14}/><span>{props.selectedAgent==='codex'?'Codex 本机配置':selected?modelName(selected):id||'选择模型'}</span><Icon name="down" size={13}/></>}>{close=><ChatModelPickerContent {...props} query={query} onQueryChange={setQuery} onClose={close}/>}</Popover>;
}
