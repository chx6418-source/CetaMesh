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
 const exact=(value,max=256)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
 let invalidAdvertisement=false;
 const selector=(value,perModel=false)=>{
  if(!value||!Array.isArray(value.options))return null;
  const strict=perModel&&value.options.some(option=>option&&typeof option==='object'
    &&(Object.hasOwn(option,'reasoningOptions')||Object.hasOwn(option,'defaultReasoningEffort')));
  if(strict&&value.options.length>256){invalidAdvertisement=true;return null;}
  const seen=new Set();const options=[];
  for(const option of value.options.slice(0,256)){
   const id=exact(option?.value);
   if(!id||id!==option.value||seen.has(id)){
    if(strict){invalidAdvertisement=true;return null;}
    continue;
   }
   const projected={value:id,label:label(option.label??option.name,256)||id};
   if(perModel&&Object.hasOwn(option,'reasoningOptions')){
    const choices=option.reasoningOptions;
    if(!Array.isArray(choices)||choices.length>32){invalidAdvertisement=true;return null;}
    const efforts=new Set();projected.reasoningOptions=[];
    for(const choice of choices){
     const effort=exact(choice?.value),name=exact(choice?.label);
     if(!effort||!name||efforts.has(effort)){invalidAdvertisement=true;return null;}
     efforts.add(effort);projected.reasoningOptions.push({value:effort,label:name});
    }
    if(Object.hasOwn(option,'defaultReasoningEffort')){
     if(!efforts.has(exact(option.defaultReasoningEffort))){invalidAdvertisement=true;return null;}
     projected.defaultReasoningEffort=option.defaultReasoningEffort;
    }
   }else if(perModel&&Object.hasOwn(option,'defaultReasoningEffort')){invalidAdvertisement=true;return null;}
   seen.add(id);options.push(projected);
  }
  return{...(Object.hasOwn(value,'configId')?{configId:label(value.configId,80)}:{}),options};
 };
 const projectSelection=selection=>selection&&typeof selection==='object'?{
  model:exact(selection.model),reasoningEffort:exact(selection.reasoningEffort),
  modelProvider:exact(selection.modelProvider,80)}:null;
 const selection=projectSelection(value.selection);
 const projected={status:['available','unsupported','unknown'].includes(value.status)?value.status:'unknown',
  source:label(value.source,80),runtimeVersion:label(value.runtimeVersion,80),
  application:['runtime-confirmed','next-turn','requires-new-session'].includes(value.application)?value.application:null,
  ...(['runtime-confirmed','next-turn','requires-new-session'].includes(value.changeApplication)?{changeApplication:value.changeApplication}:{}),
  selection,model:selector(value.model,true),reasoning:selector(value.reasoning),
  ...(value.requested?{requested:projectSelection(value.requested)}:{}),
  ...(value.lastRequest?.source==='cli-argv'?{lastRequest:{...projectSelection(value.lastRequest),source:'cli-argv',turnId:label(value.lastRequest.turnId,160)}}:{})};
 return invalidAdvertisement||Buffer.byteLength(JSON.stringify(projected))>128*1024?null:projected;
}
import { safeRequestDiagnostics, MAX_REQUEST_DIAGNOSTICS } from '../model/request-diagnostics.js';

/** Display-only observations; no raw request, endpoint, receipt identity or authority crosses this DTO. */
export function projectModelUsageObservation(value) {
  const metric = number => Number.isFinite(number) && number >= 0 ? number : null;
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number : null;
  const coverage = value?.cacheCoverage;
  let cacheCoverage = null;
  if (count(coverage?.totalRequests) !== null && count(coverage?.inputReportedRequests) !== null
    && coverage.inputReportedRequests <= coverage.totalRequests) {
    const part = (input, read) => {
      if (count(input?.reportedRequests) === null || input.reportedRequests > coverage.totalRequests
        || count(input?.inputReportedRequests) === null || input.inputReportedRequests > input.reportedRequests
        || input.inputReportedRequests > coverage.inputReportedRequests) return null;
      const knownInputTokens = metric(input.knownInputTokens), matchedReadTokens = metric(input.matchedReadTokens);
      const producerRate = metric(input.reportedHitRate);
      return {reportedRequests: input.reportedRequests, inputReportedRequests: input.inputReportedRequests,
        knownInputTokens, knownTokens: metric(input.knownTokens), ...(read ? {matchedReadTokens,
          // A null producer rate may mean an individual receipt was invalid even
          // when the summed ratio looks valid. Do not repair that lost evidence.
          reportedHitRate: producerRate !== null && producerRate <= 1 && knownInputTokens > 0
            && matchedReadTokens !== null && matchedReadTokens <= knownInputTokens
            && Math.abs(producerRate - matchedReadTokens / knownInputTokens) < 1e-12 ? producerRate : null} : {})};
    };
    const read = part(coverage.read, true), write = part(coverage.write, false);
    if (read && write) cacheCoverage = {totalRequests: coverage.totalRequests,
      inputReportedRequests: coverage.inputReportedRequests, knownInputTokens: metric(coverage.knownInputTokens), read, write};
  }
  const observation = value?.requestDiagnostics;
  let requestDiagnostics = null;
  if (['totalRequests','retainedRequests','omittedRequests','unreportedRequests'].every(key => count(observation?.[key]) !== null)
    && observation.retainedRequests <= MAX_REQUEST_DIAGNOSTICS
    && observation.retainedRequests + observation.omittedRequests + observation.unreportedRequests === observation.totalRequests) {
    const changes = new Set(['first-request','unknown','unchanged','provider-changed','endpoint-changed','protocol-changed',
      'model-changed','response-model-changed','tools-changed','system-changed','history-changed','parameters-changed','projection-changed']);
    requestDiagnostics = {totalRequests: observation.totalRequests, retainedRequests: observation.retainedRequests,
      omittedRequests: observation.omittedRequests, unreportedRequests: observation.unreportedRequests,
      latest: observation.retainedRequests > 0 ? safeRequestDiagnostics(observation.latest) : null,
      changes: Array.isArray(observation.changes) ? [...new Set(observation.changes.filter(code => changes.has(code)))].slice(0, 13) : []};
  }
  return {cacheCoverage, requestDiagnostics};
}
