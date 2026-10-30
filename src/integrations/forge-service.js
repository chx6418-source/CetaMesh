import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {OWNER_ACTOR,capabilityError} from '../capability/types.js';
import {createForgeAdapter,FORGE_ACTIONS,FORGE_WRITE_ACTIONS} from './forge-adapter.js';
import {registerForgeCapabilities} from './developer-tools.js';

const providers=['github','gitcode'];
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const only=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const empty=()=>({version:1,revision:0,providers:{github:[],gitcode:[]}});

/** Owner configuration contains endpoint-bound credential references only. The
 * existing secret store and Capability Broker remain the sole authorities. */
export function createForgeService({stateDir,broker,resolveCredential,secretStore=null,getCredentialRevision=null,transportOptions={},invokeCapability=null}={}){
  if(typeof stateDir!=='string'||!broker?.registry||!broker?.execute)throw capabilityError('FORGE_INVALID_CONFIG','Forge service requires the existing state directory and Broker');
  const filePath=path.join(stateDir,'integrations','forge.json');
  let loadedSignature=null;
  const credentialRef=provider=>`plugin-forge-${provider}`;
  const credentialBase=provider=>provider==='github'?'https://api.github.com':'https://api.gitcode.com/api';
  const make=(provider,repositories,resolver=resolveCredential)=>createForgeAdapter({provider,repositories,resolveCredential:resolver,...transportOptions});
  function credentialMetadata(reference){
    try{
      const row=typeof secretStore?.list==='function'?secretStore.list().find(entry=>entry.provider===reference):null;
      const revision=typeof getCredentialRevision==='function'?getCredentialRevision(reference):row?.revision??row?.updatedAt??null;
      if(revision!==null&&!['string','number'].includes(typeof revision))throw Error();
      if(typeof revision==='string'&&(revision.length>160||/[\u0000-\u001f]/.test(revision)))throw Error();
      return {known:typeof secretStore?.list==='function'||typeof getCredentialRevision==='function',configured:row?row.configured===true:revision!==null,
        revision,updatedAt:typeof row?.updatedAt==='string'?row.updatedAt.slice(0,80):null,baseUrl:typeof row?.baseUrl==='string'?row.baseUrl.slice(0,512):null};
    }catch{throw capabilityError('FORGE_CREDENTIAL_METADATA_UNAVAILABLE','Dedicated credential metadata cannot be verified');}
  }
  function credentialSnapshot(provider,repositories){
    return [...new Set([credentialRef(provider),...repositories.filter(row=>row.publicRead!==true).map(row=>row.credentialRef)])].sort()
      .map(reference=>({reference,...credentialMetadata(reference)}));
  }
  function currentSignature(doc){return JSON.stringify({doc,credentials:providers.map(provider=>credentialSnapshot(provider,doc.providers[provider]))});}
  function read(){
    let doc;try{doc=readJsonFile(filePath,{missing:empty(),maxBytes:256*1024});}catch{throw capabilityError('FORGE_CONFIG_INVALID','Forge configuration cannot be read');}
    if(!only(doc,['version','revision','providers'])||doc.version!==1||!Number.isSafeInteger(doc.revision)||doc.revision<0||!only(doc.providers,providers)
      ||providers.some(provider=>!Array.isArray(doc.providers[provider])))throw capabilityError('FORGE_CONFIG_INVALID','Forge configuration is invalid');
    return doc;
  }
  function adapters(doc){
    const signature=JSON.stringify(doc);
    return providers.map(provider=>{
      const metadata=credentialSnapshot(provider,doc.providers[provider]),credentialSignature=JSON.stringify(metadata);
      const checkCurrent=()=>{
        if(JSON.stringify(read())!==signature)throw capabilityError('FORGE_CONFIG_CHANGED','Forge configuration changed; refresh before requesting approval');
        if(JSON.stringify(credentialSnapshot(provider,doc.providers[provider]))!==credentialSignature)throw capabilityError('FORGE_CREDENTIAL_CHANGED','Dedicated credential changed; obtain a new approval');
      };
      const resolver=async(...args)=>{checkCurrent();const value=await resolveCredential?.(...args);checkCurrent();return value;};
      let adapter;try{adapter=make(provider,doc.providers[provider],resolver);}catch{throw capabilityError('FORGE_INVALID_CONFIG','Repository scope or credential reference configuration is invalid');}
      return {...adapter,descriptorVersion:adapter.descriptorVersion+`:r${doc.revision}:c`+crypto.createHash('sha256').update(credentialSignature).digest('hex').slice(0,16),validate(action,input){
        checkCurrent();
        if(FORGE_WRITE_ACTIONS.includes(action)){
          const reference=doc.providers[provider].find(row=>row.owner===input?.owner&&row.repo===input?.repo)?.credentialRef;
          const entry=metadata.find(row=>row.reference===reference);
          if(entry&&!entry.known)throw capabilityError('FORGE_CREDENTIAL_METADATA_UNAVAILABLE','Writes require trusted credential revision metadata');
        }
        return adapter.validate(action,input);
      },execute(action,input,options){
        checkCurrent();
        return adapter.execute(action,input,options);
      }};
    });
  }
  function refresh(){
    const doc=read(),signature=currentSignature(doc);if(loadedSignature===signature)return doc;
    registerForgeCapabilities({broker,forgeAdapters:adapters(doc),replace:true});loadedSignature=signature;return doc;
  }
  function describe(){
    const doc=refresh();return {revision:doc.revision,providers:providers.map(provider=>{const metadata=credentialMetadata(credentialRef(provider));return {provider,repositories:structuredClone(doc.providers[provider]),
      actions:[...FORGE_ACTIONS],unsupported:provider==='gitcode'?['workflow.dispatch','release.draft']:[],endpoint:provider==='github'?'https://api.github.com':'https://api.gitcode.com',
      credentialConfigured:metadata.known?metadata.configured&&metadata.baseUrl===credentialBase(provider):typeof resolveCredential==='function'?null:false,
      credentialUpdatedAt:metadata.updatedAt,credentialSavingAvailable:typeof secretStore?.set==='function',credentialStatus:metadata.known?(metadata.configured?'configured-unverified':'not-configured'):'not-checked'};})};
  }
  function saveCredentials(params){
    if(!only(params,['provider','token','expectedRevision'])||!providers.includes(params.provider)||!Number.isSafeInteger(params.expectedRevision)
      ||typeof params.token!=='string'||params.token.trim().length<8||params.token.trim().length>512||/[\u0000-\u0020\u007f]/.test(params.token))throw capabilityError('FORGE_INVALID_CONFIG','A supported Forge provider, bounded dedicated token and expected revision are required');
    if(typeof secretStore?.set!=='function')throw capabilityError('FORGE_CREDENTIAL_UNAVAILABLE','Dedicated credential storage is unavailable');
    const doc=read();if(doc.revision!==params.expectedRevision)throw capabilityError('FORGE_CONFIG_CONFLICT','Forge configuration changed; reload before saving');
    if(doc.revision>=Number.MAX_SAFE_INTEGER)throw capabilityError('FORGE_INVALID_CONFIG','Forge configuration revision limit reached');
    // Expire approvals first. A failed second write may leave the old key, but
    // can never leave a replacement key executable under an old approval.
    const next={...doc,revision:doc.revision+1};writeJsonAtomic(filePath,next);loadedSignature=null;refresh();
    let result;try{result=secretStore.set({provider:credentialRef(params.provider),apiKey:params.token,baseUrl:credentialBase(params.provider)});}catch{throw capabilityError('FORGE_CREDENTIAL_SAVE_FAILED','Dedicated credential could not be saved');}
    loadedSignature=null;refresh();
    return {configured:result?.configured===true,updatedAt:typeof result?.updatedAt==='string'?result.updatedAt.slice(0,80):null};
  }
  function save(params){
    if(!only(params,['provider','repositories','expectedRevision'])||!providers.includes(params.provider)||!Number.isSafeInteger(params.expectedRevision)||!Array.isArray(params.repositories))throw capabilityError('FORGE_INVALID_CONFIG','Provider, repository scopes and expected revision are required');
    const doc=read();if(doc.revision!==params.expectedRevision)throw capabilityError('FORGE_CONFIG_CONFLICT','Forge configuration changed; reload before saving');
    // Validation runs before storage. Unknown fields (including keys, URLs and
    // headers) are rejected by the adapter; nothing private is copied blindly.
    try{make(params.provider,params.repositories);}catch{throw capabilityError('FORGE_INVALID_CONFIG','Repository scope or credential reference configuration is invalid');}
    const next={version:1,revision:doc.revision+1,providers:{...doc.providers,[params.provider]:structuredClone(params.repositories)}};
    if(Buffer.byteLength(JSON.stringify(next))>256*1024)throw capabilityError('FORGE_INVALID_CONFIG','Forge configuration exceeds its limit');
    adapters(next);writeJsonAtomic(filePath,next);loadedSignature=null;refresh();return describe();
  }
  async function invoke(params,{signal}={}){
    if(!only(params,['provider','action','input','taskId','workspaceId','operationId','requestId'])||!providers.includes(params.provider)||!FORGE_ACTIONS.includes(params.action))throw capabilityError('FORGE_INVALID_INPUT','A bounded Forge action is required');
    refresh();
    const request={actor:OWNER_ACTOR,capability:`forge.${params.provider}.${params.action}`,input:params.input,
      ...(params.taskId?{taskId:params.taskId}:{}),...(params.workspaceId?{workspaceId:params.workspaceId}:{}),
      ...(params.operationId?{operationId:params.operationId}:{}),...(params.requestId?{requestId:params.requestId}:{}),
      reason:FORGE_WRITE_ACTIONS.includes(params.action)?'Owner requested a scoped Forge write':'Owner requested a scoped Forge read'};
    return typeof invokeCapability==='function'?invokeCapability(request,{signal}):broker.execute(request,{signal});
  }
  refresh();
  return Object.freeze({filePath,describe,save,saveCredentials,refresh,invoke,
    execute({method,params={}},context={}){
      switch(method){
        case 'ui.developer.forge.describe':return describe();
        case 'ui.developer.forge.save':return save(params);
        case 'ui.developer.forge.credentials.save':return saveCredentials(params);
        case 'ui.developer.forge.invoke':return invoke(params,context);
        default:throw capabilityError('METHOD_NOT_FOUND','Unknown Forge service method');
      }
    }});
}
