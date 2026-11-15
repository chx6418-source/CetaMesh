import {extensionError} from '../extension/types.js';
import {requestFingerprint} from '../capability/approval.js';
import {validateSchema} from '../model/input-schema.js';
import {REVERSELAB_ID,REVERSELAB_TOOL,ANALYSIS_INPUT,HEALTH_INPUT} from './contracts.js';

export const isReverseLabManifest=manifest=>manifest.id===REVERSELAB_ID&&manifest.type==='tool'&&manifest.entry==='analysis.json';
export function validateReverseLabDefinition(manifest,source){
  let definition;try{definition=JSON.parse(source);}catch{throw extensionError('REVERSELAB_PLUGIN_INVALID','ReverseLab entry must be declarative JSON.');}
  const caps=manifest.capabilities??[],analyze=caps.find(c=>c.id===REVERSELAB_TOOL),health=caps.find(c=>c.id==='health');
  if(!isReverseLabManifest(manifest)||definition.schemaVersion!==1||definition.protocol!=='reverselab-static-v1'
    ||definition.operation!==REVERSELAB_TOOL||Object.keys(definition).length!==3||manifest.permissions.length!==1
    ||manifest.permissions[0]!=='analysis.static'||caps.length!==2||!analyze||!health
    ||!analyze.requires?.includes('analysis.static')||!health.requires?.includes('analysis.static')
    ||requestFingerprint({input:analyze.inputSchema})!==requestFingerprint({input:ANALYSIS_INPUT})
    ||requestFingerprint({input:health.inputSchema})!==requestFingerprint({input:HEALTH_INPUT}))
    throw extensionError('REVERSELAB_PLUGIN_INVALID','ReverseLab P1 supports only its reviewed static analysis profile.');
  return definition;
}
export function reverseLabRequestFor(manifest,source,capability,input){
  validateReverseLabDefinition(manifest,source);
  if(capability!==REVERSELAB_TOOL)throw extensionError('CAPABILITY_NOT_DECLARED','Unsupported ReverseLab child operation.');
  validateSchema(ANALYSIS_INPUT,input);return {path:input.path,outputPath:input.outputPath};
}
export const projectReverseLabResult=(parent,result)=>({capability:REVERSELAB_TOOL,result});
export function createReverseLabExtensionHost({manifest,source,capabilityExecutor,health=()=>({status:'PROVIDER_MISSING'})}){
  validateReverseLabDefinition(manifest,source);let closed=false;const active=new Set();
  return {logs:[],available:()=>!closed,loadError:()=>null,
    health:()=>({provider:'reverselab-static-v1',closed,inflight:active.size,engine:health()}),
    async invoke(capability,input={}, {signal}={}){
      if(closed)throw extensionError('EXTENSION_DISABLED','ReverseLab plugin is disabled.');
      if(capability==='health'){validateSchema(HEALTH_INPUT,input);return {capability,result:health()};}
      const request=reverseLabRequestFor(manifest,source,capability,input),controller=new AbortController();
      const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])]);active.add(controller);
      try{combined.throwIfAborted();const result=await capabilityExecutor('analysis.static',request,{signal:combined});
        if(result?.status==='pending')return result;
        combined.throwIfAborted();return result?.capability===REVERSELAB_TOOL?result:projectReverseLabResult(null,result);
      }finally{active.delete(controller);}
    },
    shutdown(){closed=true;for(const controller of active)controller.abort(extensionError('INVOKE_CANCELLED','ReverseLab stopped.'));}
  };
}
