import {extensionError} from './types.js';
import {validateSchema} from '../model/input-schema.js';
export const isHttpDataManifest=manifest=>manifest.type==='external-api'&&/\.json$/i.test(manifest.entry??'');
const READ_METHODS=['GET','HEAD'];
const METHODS=[...READ_METHODS,'POST','PUT','PATCH','DELETE'];
const SECRET_KEY=/token|secret|password|api.?key|authorization/i;
const unknown=error=>Object.assign(extensionError('HTTP_OUTCOME_UNKNOWN','Remote write result is unknown; verify its effects before retrying'),{effectStatus:'unknown'});
export function validateHttpDefinition(manifest,source) {
 let definition;try{definition=JSON.parse(source);}catch{throw extensionError('HTTP_PLUGIN_INVALID','HTTP adapter entry must be JSON data');}
 const fail=()=>{throw extensionError('HTTP_PLUGIN_INVALID','HTTP adapter requires reviewed HTTPS endpoints, exact schema keys, allowed methods and credential references');};
 if(!manifest.permissions.includes('network')||definition.schemaVersion!==1||definition.protocol!=='http-json-v1'
  ||!Array.isArray(definition.endpoints)||definition.endpoints.length!==manifest.capabilities.length||definition.endpoints.length>30)fail();
 const seen=new Set();
 for(const row of definition.endpoints){
  const cap=manifest.capabilities.find(item=>item.id===row.capability);let url;try{url=new URL(row.url);}catch{fail();}
  if(!cap||seen.has(row.capability)||!cap.requires?.includes('network')||!cap.inputSchema||cap.inputSchema.type!=='object'||cap.inputSchema.additionalProperties!==false
   ||url.protocol!=='https:'||url.username||url.password||url.hash||row.url.length>1500||!manifest.network.hosts.includes(url.host)
   ||!METHODS.includes(row.method)||!['text','json'].includes(row.response)||!Array.isArray(row.queryKeys)
   ||Object.keys(row).some(key=>!['capability','url','method','response','queryKeys','bodyKeys','credentialRef'].includes(key))
   ||(row.credentialRef!==undefined&&(typeof row.credentialRef!=='string'||!/^plugin-[a-z0-9][a-z0-9._-]{0,55}$/.test(row.credentialRef)))
   ||(READ_METHODS.includes(row.method)?row.bodyKeys!==undefined:!Array.isArray(row.bodyKeys))
   ||[...url.searchParams.keys()].some(key=>SECRET_KEY.test(key)))fail();
  const keys=[...row.queryKeys,...(row.bodyKeys??[])];
  if(keys.length>40||new Set(keys).size!==keys.length||keys.some(key=>typeof key!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)||SECRET_KEY.test(key)||!Object.hasOwn(cap.inputSchema.properties??{},key)))fail();
  seen.add(row.capability);
 }
 return definition;
}
export function httpRequestFor(manifest,source,capabilityId,input){
 const definition=validateHttpDefinition(manifest,source),endpoint=definition.endpoints.find(row=>row.capability===capabilityId),cap=manifest.capabilities.find(row=>row.id===capabilityId);
 if(!cap||!endpoint)throw extensionError('CAPABILITY_NOT_DECLARED','Unknown data endpoint');validateSchema(cap.inputSchema,input);
 const url=new URL(endpoint.url);for(const key of endpoint.queryKeys)if(input[key]!==undefined){const value=input[key];if(!['string','number','boolean'].includes(typeof value)||String(value).length>2000)throw extensionError('INVALID_PARAMS','HTTP query needs bounded primitive values');url.searchParams.set(key,String(value));}
 const init={method:endpoint.method};
 if(!READ_METHODS.includes(endpoint.method)){
  init.body=JSON.stringify(Object.fromEntries(endpoint.bodyKeys.filter(key=>input[key]!==undefined).map(key=>[key,input[key]])));
  if(Buffer.byteLength(init.body)>65536)throw extensionError('INVALID_PARAMS','HTTP JSON body exceeds 64 KiB');
 }
 return {url:url.href,init,requireHttps:true,...(endpoint.credentialRef?{credentialRef:endpoint.credentialRef}:{})};
}
export function projectHttpResult(manifest,source,capabilityId,response){
 const endpoint=validateHttpDefinition(manifest,source).endpoints.find(row=>row.capability===capabilityId);
 try{
  if(!endpoint||!response||!Number.isInteger(response.statusCode))throw extensionError('HTTP_RESPONSE_INVALID','Missing transport status');
  if(response.statusCode<200||response.statusCode>=300)throw extensionError('HTTP_RESPONSE_ERROR','Endpoint returned status '+response.statusCode);
  if(response.truncated)throw extensionError('HTTP_RESPONSE_TRUNCATED','Response exceeds the permitted size');
  let data=response.body??'';if(endpoint.response==='json'&&endpoint.method!=='HEAD')try{data=JSON.parse(data);}catch{throw extensionError('HTTP_RESPONSE_INVALID','Endpoint returned invalid JSON');}
  return {capability:capabilityId,result:{statusCode:response.statusCode,data}};
 }catch(error){if(endpoint&&!READ_METHODS.includes(endpoint.method))throw unknown(error);throw error;}
}
/** Data-only HTTP host. Core owns approval, credentials, DNS and transport. */
export function createHttpExtensionHost({manifest,source,capabilityExecutor,timeoutMs=30000}={}) {
 validateHttpDefinition(manifest,source);const active=new Set();let closed=false;
 return {logs:[],available:()=>!closed,loadError:()=>null,health:()=>({provider:'http-json-v1',inflight:active.size,closed}),
  async invoke(capabilityId,input={}, {signal}={}) {
   if(closed)throw extensionError('EXTENSION_DISABLED','HTTP adapter is closed');
   const request=httpRequestFor(manifest,source,capabilityId,input);
   const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
   active.add(controller);const started=Date.now();
   try {
    combined.throwIfAborted();
    const response=await capabilityExecutor('network',request,{signal:combined});
    if(response?.status==='pending')return response;
    if(combined.aborted&&!READ_METHODS.includes(request.init.method))throw unknown();
    combined.throwIfAborted();
    const projected=response?.capability===capabilityId&&response.result&&Number.isInteger(response.result.statusCode) ? response : projectHttpResult(manifest,source,capabilityId,response);
    return {...projected,elapsedMs:Date.now()-started};
   }finally{active.delete(controller);}
  },
  shutdown(){closed=true;for(const controller of active)controller.abort(extensionError('INVOKE_CANCELLED','HTTP adapter closed'));}
 };
}
