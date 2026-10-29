import {extensionError} from './types.js';
import {validateSchema} from '../model/input-schema.js';
import {validateEventRequest} from './event-transport.js';
export const isEventDataManifest=manifest=>manifest.type==='channel-adapter'&&/\.json$/i.test(manifest.entry??'');
export function validateEventDefinition(manifest,source){
 let definition;try{definition=JSON.parse(source);}catch{throw extensionError('EVENT_PLUGIN_INVALID','Event adapter entry must be JSON');}
 if(definition.schemaVersion!==1||definition.protocol!=='cetamesh-events-v1'||!Array.isArray(definition.endpoints)
  ||definition.endpoints.length!==manifest.capabilities.length||definition.endpoints.length>20
  ||!manifest.permissions.includes('network')||!manifest.permissions.includes('storage'))throw extensionError('EVENT_PLUGIN_INVALID','Reviewed event protocol and private receipt storage required');
 const seen=new Set();
 for(const row of definition.endpoints){
  const cap=manifest.capabilities.find(cap=>cap.id===row.capability);const url=validateEventRequest(row);
  if(!cap||seen.has(row.capability)||!cap.requires?.includes('network')||!cap.requires?.includes('storage')
    ||cap.inputSchema?.type!=='object'||cap.inputSchema.additionalProperties!==false||Object.keys(cap.inputSchema.properties||{}).length
    ||!manifest.network.hosts.includes(url.host)||Object.keys(row).some(key=>!['capability','transport','url','credentialRef','limit','timeoutMs','responseSchema','subscription'].includes(key)))
    throw extensionError('EVENT_PLUGIN_INVALID','Events require exact hosts, empty caller input and reviewed schemas');
  seen.add(row.capability);
 }
 return definition;
}
export function eventRequestFor(manifest,source,capability,input){
 const definition=validateEventDefinition(manifest,source),cap=manifest.capabilities.find(cap=>cap.id===capability);
 const endpoint=definition.endpoints.find(row=>row.capability===capability);
 if(!cap||!endpoint)throw extensionError('CAPABILITY_NOT_DECLARED','Unknown event endpoint');
 validateSchema(cap.inputSchema,input);const {capability:ignored,...request}=endpoint;return request;
}
export function projectEventResult(manifest,source,capability,result,storage){
 const endpoint=validateEventDefinition(manifest,source).endpoints.find(row=>row.capability===capability);
 if(!endpoint||result?.protocolVersion!==1||!Array.isArray(result.events)||result.events.length!==endpoint.limit)throw extensionError('EVENT_SCHEMA_INVALID','Invalid event result');
 const now=Date.now(),old=storage.get('event-receipts-v1')||{},receipts=Object.fromEntries(Object.entries(old).filter(([,at])=>Number.isSafeInteger(at)&&at>now-300000));
 for(const event of result.events){
  if(!event||typeof event.id!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(event.id)||!Number.isSafeInteger(event.timestamp)||Math.abs(now-event.timestamp)>300000)throw extensionError('EVENT_SCHEMA_INVALID','Invalid received event');
  validateSchema(endpoint.responseSchema,event.data);
  const key=endpoint.transport+':'+endpoint.url+':'+event.id;
  if(Object.hasOwn(receipts,key))throw extensionError('EVENT_REPLAY','Event was already delivered; it must not trigger duplicate work');receipts[key]=event.timestamp;
 }
 if(Object.keys(receipts).length>2000)throw extensionError('EVENT_RECEIPTS_FULL','Active event replay window is full');
 storage.set('event-receipts-v1',receipts);
 return {capability,result:{events:result.events}};
}
export function createEventExtensionHost({manifest,source,storage,capabilityExecutor}={}){
 validateEventDefinition(manifest,source);const active=new Set();let closed=false;
 return {logs:[],available:()=>!closed,loadError:()=>null,health:()=>({provider:'cetamesh-events-v1',inflight:active.size,closed}),
  async invoke(capability,input={}, {signal}={}){
   if(closed)throw extensionError('EXTENSION_DISABLED','Event adapter is closed');
   const request=eventRequestFor(manifest,source,capability,input),controller=new AbortController();active.add(controller);
   const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
   try{const result=await capabilityExecutor('network',request,{signal:combined});if(result?.status==='pending'||result?.capability===capability)return result;return projectEventResult(manifest,source,capability,result,storage);}
   finally{active.delete(controller);}
  },
  shutdown(){closed=true;for(const controller of active)controller.abort();}
 };
}
