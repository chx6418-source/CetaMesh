// Versioned display projections over existing Runtime observations. No prompt or
// tool payload is permitted across this numeric-only boundary.
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER?v:null;
const label=(v,n=300)=>typeof v==='string'&&!/[\x00-\x1f]/.test(v)?v.slice(0,n):null;
export function projectChatContext(value,phase='last-request'){
 if(value?.schemaVersion!==1)return null;
 const status=['actual','estimated','unknown'].includes(value.status)?value.status:'unknown';
 const bucket=v=>({tokens:v?.status==='estimated'?count(v.tokens):null,status:v?.status==='estimated'&&count(v.tokens)!==null?'estimated':'unknown'});
 const p=value.projection;
 return {schemaVersion:1,providerId:label(value.providerId,80),model:label(value.model,200),at:count(value.at),phase,
  status,inputTokens:status==='unknown'?null:count(value.inputTokens),windowTokens:count(value.windowTokens),reservedOutputTokens:count(value.reservedOutputTokens),
  capacityStatus:['verified','declared'].includes(value.capacityStatus)?value.capacityStatus:'unknown',source:label(value.source),version:label(value.version,128),estimator:label(value.estimator,100),
  composition:Object.fromEntries(['messages','system','tools','other'].map(key=>[key,bucket(value.composition?.[key])])),
  ...(count(value.cycle)!==null?{cycle:value.cycle}:{}),...(label(value.requestId,200)?{requestId:label(value.requestId,200)}:{}),
  projection:{status:p?.status==='observed'?'observed':'unknown',bytes:count(p?.bytes),maxBytes:count(p?.maxBytes),
   compacted:typeof p?.compacted==='boolean'?p.compacted:null,compactionCount:count(p?.compactionCount),truncated:typeof p?.truncated==='boolean'?p.truncated:null}};
}
export function projectModelCapabilities(value){
 const feature=v=>({supported:['verified','declared','unsupported'].includes(v?.status)&&typeof v?.supported==='boolean'?v.supported:null,status:['verified','declared','unsupported','unknown'].includes(v?.status)?v.status:'unknown',source:label(v?.source)});
 return {vision:feature(value?.vision),tools:feature(value?.tools),reasoning:{levels:value?.reasoning?.status==='declared'&&Array.isArray(value?.reasoning?.levels)?[...new Set(value.reasoning.levels.filter(v=>label(v,256)===v&&v))].slice(0,32):[],
  status:['declared','unsupported'].includes(value?.reasoning?.status)?value.reasoning.status:'unknown',source:label(value?.reasoning?.source)},
  context:{status:['verified','declared'].includes(value?.context?.status)?value.context.status:'unknown',contextWindowTokens:count(value?.context?.contextWindowTokens),maxOutputTokens:count(value?.context?.maxOutputTokens),defaultOutputTokens:count(value?.context?.defaultOutputTokens),outputTokenParameter:label(value?.context?.outputTokenParameter,80),source:label(value?.context?.source),version:label(value?.context?.version,128)}};
}

// Only the Agent adapter's model controls cross this boundary. Mode, tool and
// permission selectors are deliberately absent; native values retain identity.
export function projectAgentModelControl(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const selector=value=>{
  if(!value||!Array.isArray(value.options))return null;
  const seen=new Set();const options=[];
  for(const option of value.options.slice(0,256)){
   const id=label(option?.value,256);
   if(!id||id!==option.value||seen.has(id))continue;
   seen.add(id);options.push({value:id,label:label(option.label??option.name,200)||id});
  }
  return{configId:label(value.configId,80),options};
 };
 const projectSelection=selection=>selection&&typeof selection==='object'?{
  model:label(selection.model,256),reasoningEffort:label(selection.reasoningEffort,256),
  modelProvider:label(selection.modelProvider,80)}:null;
 const selection=projectSelection(value.selection);
 return{status:['available','unsupported','unknown'].includes(value.status)?value.status:'unknown',
  source:label(value.source,80),runtimeVersion:label(value.runtimeVersion,80),
  application:['runtime-confirmed','next-turn','requires-new-session'].includes(value.application)?value.application:null,
  selection,model:selector(value.model),reasoning:selector(value.reasoning),
  ...(value.requested?{requested:projectSelection(value.requested)}:{}),
  ...(value.lastRequest?.source==='cli-argv'?{lastRequest:{...projectSelection(value.lastRequest),source:'cli-argv',turnId:label(value.lastRequest.turnId,160)}}:{})};
}
