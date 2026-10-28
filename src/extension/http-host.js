import {extensionError} from './types.js';
import {validateSchema} from '../model/input-schema.js';
export const isHttpDataManifest=manifest=>manifest.type==='external-api'&&/\.json$/i.test(manifest.entry??'');
export function validateHttpDefinition(manifest,source) {
 let definition;try{definition=JSON.parse(source);}catch{throw extensionError('HTTP_PLUGIN_INVALID','HTTP adapter entry must be JSON data');}
 const fail=()=>{throw extensionError('HTTP_PLUGIN_INVALID','HTTP adapter needs reviewed HTTPS endpoints, declared schemas and exact query keys; credentials and unsupported methods are not accepted');};
 if(!manifest.permissions.includes('network')||definition.schemaVersion!==1||definition.protocol!=='http-json-v1'
  ||!Array.isArray(definition.endpoints)||definition.endpoints.length!==manifest.capabilities.length||definition.endpoints.length>30)fail();
 const seen=new Set();
 for(const row of definition.endpoints){
  const cap=manifest.capabilities.find(item=>item.id===row.capability);let url;try{url=new URL(row.url);}catch{fail();}
  if(!cap||seen.has(row.capability)||!cap.requires?.includes('network')||!cap.inputSchema||cap.inputSchema.type!=='object'||cap.inputSchema.additionalProperties!==false
   ||url.protocol!=='https:'||url.username||url.password||url.hash||row.url.length>1500||!manifest.network.hosts.includes(url.host)
   ||!['GET','HEAD'].includes(row.method)||!['text','json'].includes(row.response)||!Array.isArray(row.queryKeys)||row.queryKeys.length>20
   ||new Set(row.queryKeys).size!==row.queryKeys.length
   ||row.queryKeys.some(key=>typeof key!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)||/token|secret|password|api.?key|authorization/i.test(key)||!Object.hasOwn(cap.inputSchema.properties??{},key))
   ||[...url.searchParams.keys()].some(key=>/token|secret|password|api.?key|authorization/i.test(key)))fail();
  seen.add(row.capability);
 }
 return definition;
}
/** Data-only HTTP host. Transport, DNS and redirect authorization remain in Core. */
export function createHttpExtensionHost({manifest,source,capabilityExecutor,timeoutMs=30000}={}) {
 const definition=validateHttpDefinition(manifest,source),active=new Set();let closed=false;
 return {logs:[],available:()=>!closed,loadError:()=>null,health:()=>({provider:'http-json-v1',inflight:active.size,closed}),
  async invoke(capabilityId,input={}, {signal}={}) {
   if(closed)throw extensionError('EXTENSION_DISABLED','HTTP adapter is closed');
   const cap=manifest.capabilities.find(row=>row.id===capabilityId),endpoint=definition.endpoints.find(row=>row.capability===capabilityId);
   if(!cap||!endpoint)throw extensionError('CAPABILITY_NOT_DECLARED','Undeclared HTTP endpoint');validateSchema(cap.inputSchema,input);
   const url=new URL(endpoint.url);
   for(const key of endpoint.queryKeys)if(input[key]!==undefined){const value=input[key];
    if(!['string','number','boolean'].includes(typeof value)||String(value).length>2000)throw extensionError('INVALID_PARAMS','HTTP query needs bounded primitive values');
    url.searchParams.set(key,String(value));}
   const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
   active.add(controller);const started=Date.now();
   try {
    combined.throwIfAborted();
    const response=await capabilityExecutor('network',{url:url.href,init:{method:endpoint.method},requireHttps:true},{signal:combined});combined.throwIfAborted();
    if(!response||!Number.isInteger(response.statusCode))throw extensionError('HTTP_RESPONSE_INVALID','HTTP transport returned no status');
    if(response.statusCode<200||response.statusCode>=300)throw extensionError('HTTP_RESPONSE_ERROR','HTTP endpoint returned status '+response.statusCode);
    if(response.truncated)throw extensionError('HTTP_RESPONSE_TRUNCATED','HTTP response exceeds the permitted size');
    let data=response.body??'';if(endpoint.response==='json'&&endpoint.method!=='HEAD')try{data=JSON.parse(data);}catch{throw extensionError('HTTP_RESPONSE_INVALID','Endpoint returned invalid JSON');}
    return {capability:capabilityId,result:{statusCode:response.statusCode,data},elapsedMs:Date.now()-started};
   }finally{active.delete(controller);}
  },
  shutdown(){closed=true;for(const controller of active)controller.abort(extensionError('INVOKE_CANCELLED','HTTP adapter closed'));}
 };
}
