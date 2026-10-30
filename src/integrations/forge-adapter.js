import {capabilityError} from '../capability/types.js';
import {redactText} from '../logging/redact.js';
import {createForgeTransport} from './forge-transport.js';
import crypto from 'node:crypto';

// GitCode API contracts: https://docs.gitcode.com/docs/apis/ . Its Issue create
// is owner-scoped, branches use branch_name/refs, and Actions reads use v8.
// GitCode Release exposes pre/latest, not an unpublished draft; never substitute pre.
const segment={type:'string',minLength:1,maxLength:100,pattern:'^[A-Za-z0-9][A-Za-z0-9._-]*$'};
const branch={type:'string',minLength:1,maxLength:200};
const sha={type:'string',pattern:'^[a-f0-9]{40,64}$',maxLength:64};
const text=(maxLength,minLength=0)=>({type:'string',minLength,maxLength});
const paged={page:{type:'integer',minimum:1,maximum:1000},perPage:{type:'integer',minimum:1,maximum:100}};
const definitions={
  'repository.get':{},'branches.list':{...paged},'issues.list':{...paged},'pulls.list':{...paged},'releases.list':{...paged},
  'builds.list':{...paged},'builds.jobs':{runId:{type:'string',pattern:'^[A-Za-z0-9_-]{1,80}$',maxLength:80},...paged},
  'branch.create':{branch,sha},'issue.create':{title:text(240,1),body:text(16000)},
  'pull.create':{title:text(240,1),head:branch,base:branch,body:text(16000)},
  'workflow.dispatch':{workflow:{type:'string',pattern:'^[A-Za-z0-9_.-]{1,100}$',maxLength:100},ref:branch,inputs:{type:'object',additionalProperties:{type:'string',maxLength:1000},maxProperties:20}},
  'release.draft':{tag:branch,sha,name:text(240,1),body:text(16000)}
};
export const FORGE_ACTIONS=Object.freeze(Object.keys(definitions));
export const FORGE_WRITE_ACTIONS=Object.freeze(FORGE_ACTIONS.filter(action=>/\.(create|dispatch|draft)$/.test(action)));
const required={ 'builds.jobs':['runId'],'branch.create':['branch','sha'],'issue.create':['title','body'],'pull.create':['title','head','base','body'],'workflow.dispatch':['workflow','ref','inputs'],'release.draft':['tag','sha','name','body']};
export function forgeInputSchema(action){
  if(!Object.hasOwn(definitions,action))throw capabilityError('FORGE_UNSUPPORTED','Unsupported Forge action');
  return {type:'object',additionalProperties:false,properties:{owner:segment,repo:segment,...definitions[action]},required:['owner','repo',...(required[action]??[])]};
}
function invalid(){throw capabilityError('FORGE_INVALID_INPUT','Forge input does not match the bounded action schema');}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function validateSchema(value,schema){
  if(schema.type==='object'){
    if(!object(value)||Object.keys(value).length>(schema.maxProperties??30))invalid();
    for(const key of schema.required??[])if(!Object.hasOwn(value,key))invalid();
    for(const [key,child]of Object.entries(value)){
      if(['__proto__','constructor','prototype'].includes(key))invalid();
      const childSchema=schema.properties?.[key]??schema.additionalProperties;
      if(!childSchema||childSchema===true)invalid();validateSchema(child,childSchema);
    }
  }else if(schema.type==='string'){
    if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??1000)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||(schema.pattern&&!new RegExp(schema.pattern).test(value)))invalid();
  }else if(schema.type==='integer'&&(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum))invalid();
}
function validRef(value){return typeof value==='string'&&value.length>0&&value.length<=200&&!/[\s~^:?*\[\\\u0000-\u001f\u007f]/.test(value)&&!value.includes('..')&&!value.includes('@{')&&!value.startsWith('/')&&!value.endsWith('/')&&!value.endsWith('.')&&value.split('/').every(part=>part&&!part.startsWith('.')&&!part.endsWith('.lock'));}
function scrub(value,secret){let result=redactText(String(value??''));if(secret)result=result.split(secret).join('[REDACTED]');return result.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'[REDACTED]').slice(0,240);}
function id(value){return (Number.isSafeInteger(value)&&value>=0)||typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value)?String(value):null;}
function resolveSecret(resolveCredential,reference,target,{signal,deadline}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>finish(capabilityError('FORGE_ABORTED','Forge request cancelled'));
    const timer=setTimeout(()=>finish(capabilityError('FORGE_TIMEOUT','Forge credential resolution timed out')),Math.max(1,deadline-Date.now()));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
    Promise.resolve().then(()=>resolveCredential(reference,target)).then(value=>finish(null,value),()=>finish(capabilityError('FORGE_CREDENTIAL_DENIED','Dedicated Forge credential is not bound to this endpoint')));
  });
}

export function createForgeAdapter({provider,repositories=[],resolveCredential,...transportOptions}={}){
  if(!['github','gitcode'].includes(provider)||!Array.isArray(repositories)||repositories.length>100)throw capabilityError('FORGE_INVALID_CONFIG','Invalid Forge provider or repository configuration');
  const origin=provider==='github'?'https://api.github.com':'https://api.gitcode.com';
  const configs=repositories.map(row=>{
    if(!object(row)||Object.keys(row).some(key=>!['owner','repo','credentialRef','publicRead','actions','branchPrefixes','workflows'].includes(key)))throw capabilityError('FORGE_INVALID_CONFIG','Unknown repository configuration field');
    validateSchema({owner:row.owner,repo:row.repo},{type:'object',properties:{owner:segment,repo:segment},required:['owner','repo']});
    const publicRead=row.publicRead===true;
    if(row.publicRead!==undefined&&typeof row.publicRead!=='boolean')throw capabilityError('FORGE_INVALID_CONFIG','Public read mode must be explicit');
    if((publicRead?!!row.credentialRef:!/^plugin-[a-z0-9][a-z0-9._-]{0,55}$/.test(row.credentialRef??''))||!Array.isArray(row.actions)||row.actions.length>FORGE_ACTIONS.length||row.actions.some(a=>!FORGE_ACTIONS.includes(a)||(publicRead&&FORGE_WRITE_ACTIONS.includes(a))))throw capabilityError('FORGE_INVALID_CONFIG','Public reads cannot write; authenticated actions require a dedicated credential reference');
    if(row.branchPrefixes!==undefined&&(!Array.isArray(row.branchPrefixes)||row.branchPrefixes.length>20||row.branchPrefixes.some(p=>typeof p!=='string'||!p.endsWith('/')||!validRef(p.slice(0,-1)))))throw capabilityError('FORGE_INVALID_CONFIG','Explicit valid branch prefixes required');
    if(row.workflows!==undefined&&(!Array.isArray(row.workflows)||row.workflows.length>20))throw capabilityError('FORGE_INVALID_CONFIG','Bounded workflow allowlist required');
    for(const workflow of row.workflows??[]){
      if(!object(workflow)||Object.keys(workflow).some(key=>!['id','refs','inputs'].includes(key)))throw capabilityError('FORGE_INVALID_CONFIG','Unknown workflow configuration field');
      validateSchema(workflow.id,definitions['workflow.dispatch'].workflow);
      if(!Array.isArray(workflow.refs)||!workflow.refs.length||workflow.refs.length>20||workflow.refs.some(ref=>!validRef(ref))||!object(workflow.inputs)||Object.keys(workflow.inputs).length>20)throw capabilityError('FORGE_INVALID_CONFIG','Workflow refs and input values must be explicitly allowlisted');
      for(const [key,values]of Object.entries(workflow.inputs))if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)||/token|secret|password|credential|api.?key/i.test(key)||!Array.isArray(values)||!values.length||values.length>20||values.some(v=>typeof v!=='string'||v.length>1000||redactText(v)!==v||/\b(?:gh[pousr]_|github_pat_)/.test(v)))throw capabilityError('FORGE_INVALID_CONFIG','Invalid workflow input allowlist');
    }
    return structuredClone(row);
  });
  if(new Set(configs.map(c=>c.owner+'/'+c.repo)).size!==configs.length)throw capabilityError('FORGE_INVALID_CONFIG','Duplicate repository configuration');
  const transport=createForgeTransport(transportOptions);
  function validate(action,input){
    validateSchema(input,forgeInputSchema(action));
    const config=configs.find(row=>row.owner===input.owner&&row.repo===input.repo);
    if(!config||!config.actions.includes(action))throw capabilityError('FORGE_SCOPE_DENIED','Repository action is not explicitly authorized');
    if(provider==='gitcode'&&['workflow.dispatch','release.draft'].includes(action))throw capabilityError('FORGE_UNSUPPORTED','This action has no supported safe GitCode equivalent');
    for(const key of ['branch','head','base','ref','tag'])if(input[key]!==undefined&&!validRef(input[key]))invalid();
    if(action==='branch.create'&&(!config.branchPrefixes?.some(p=>input.branch.startsWith(p))||['main','master'].includes(input.branch)))throw capabilityError('FORGE_SCOPE_DENIED','New branch must belong to an approved review namespace');
    if(action==='pull.create'&&input.head===input.base)invalid();
    if(action==='workflow.dispatch'){
      const workflow=config.workflows?.find(w=>w.id===input.workflow);
      if(!workflow?.refs.includes(input.ref)||Object.keys(input.inputs).length!==Object.keys(workflow.inputs).length||Object.entries(input.inputs).some(([key,value])=>!workflow.inputs[key]?.includes(value)))throw capabilityError('FORGE_SCOPE_DENIED','Workflow, ref and exact input values must be approved');
    }
    return config;
  }
  function route(action,input){
    const repo=`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const prefix=provider==='github'?'':'/api/v5';
    const read={'repository.get':'','branches.list':'/branches','issues.list':'/issues','pulls.list':'/pulls','releases.list':'/releases'};
    if(Object.hasOwn(read,action))return {path:prefix+repo+read[action],paged:action!=='repository.get'};
    if(action==='builds.list'||action==='builds.jobs')return {path:(provider==='github'?'':'/api/v8')+repo+'/actions/runs'+(action==='builds.jobs'?'/'+encodeURIComponent(input.runId)+'/jobs':''),paged:provider==='github'||action==='builds.list'};
    if(action==='branch.create')return {path:prefix+repo+(provider==='github'?'/git/refs':'/branches'),body:provider==='github'?{ref:'refs/heads/'+input.branch,sha:input.sha}:{branch_name:input.branch,refs:input.sha}};
    if(action==='issue.create')return {path:prefix+(provider==='github'?repo+'/issues':`/repos/${encodeURIComponent(input.owner)}/issues`),body:{...(provider==='gitcode'?{repo:input.repo}:{}),title:input.title,body:input.body}};
    if(action==='pull.create')return {path:prefix+repo+'/pulls',body:{title:input.title,head:input.head,base:input.base,body:input.body,...(provider==='github'?{draft:true}: {})}};
    if(action==='workflow.dispatch')return {path:repo+'/actions/workflows/'+encodeURIComponent(input.workflow)+'/dispatches',body:{ref:input.ref,inputs:input.inputs}};
    return {path:repo+'/releases',body:{tag_name:input.tag,target_commitish:input.sha,name:input.name,body:input.body,draft:true,prerelease:true,generate_release_notes:false}};
  }
  async function execute(action,input,{signal}={}){
    const config=validate(action,input);if(signal?.aborted)throw capabilityError('FORGE_ABORTED','Forge request cancelled');
    const deadline=Date.now()+(transportOptions.timeoutMs??10000);
    const request=route(action,input),url=new URL(request.path,origin);
    if(request.paged){url.searchParams.set('per_page',String(input.perPage??20));url.searchParams.set('page',String(input.page??1));}
    if(config.publicRead!==true&&typeof resolveCredential!=='function')throw capabilityError('FORGE_CREDENTIAL_UNAVAILABLE','Dedicated Forge credential resolver unavailable');
    const secret=config.publicRead===true?undefined:await resolveSecret(resolveCredential,config.credentialRef,url.href,{signal,deadline});
    if(config.publicRead!==true&&(typeof secret!=='string'||secret.length<8||secret.length>512||/[\s\u0000-\u001f]/.test(secret)))throw capabilityError('FORGE_CREDENTIAL_DENIED','Invalid dedicated Forge credential');
    const raw=await transport(url,{method:request.body?'POST':'GET',body:request.body,secret,signal,deadline});
    const result={provider,repository:input.owner+'/'+input.repo,action};
    if(action==='workflow.dispatch')return {...result,accepted:true,runVerified:false};
    if(action==='repository.get'){
      if(!object(raw)||typeof raw.full_name!=='string'||raw.full_name.toLowerCase()!==result.repository.toLowerCase())throw capabilityError('FORGE_RESPONSE_INVALID','Forge repository response scope mismatch');
      return {...result,id:id(raw.id),defaultBranch:scrub(raw.default_branch,secret),private:raw.private===true};
    }
    const project=row=>{
      if(!object(row))throw capabilityError('FORGE_RESPONSE_INVALID','Invalid Forge resource row');
      if(action.startsWith('branch'))return {name:scrub(row.name??row.ref?.replace(/^refs\/heads\//,''),secret),sha:/^[a-f0-9]{40,64}$/.test(row.commit?.sha??row.object?.sha??'')?(row.commit?.sha??row.object?.sha):null};
      const resourceId=id(row.id??row.workflow_run_id),number=id(row.number);
      return {id:resourceId,...(number?{number}:{}),title:scrub(row.title??row.name??row.workflow_name??'',secret),state:scrub(row.state??row.status??'',secret),
        ...(row.conclusion!==undefined?{conclusion:scrub(row.conclusion,secret)}:{}),...(row.head_sha&&/^[a-f0-9]{40,64}$/.test(row.head_sha)?{sourceCommit:row.head_sha}:{}),
        ...(typeof row.draft==='boolean'?{draft:row.draft}: {})};
    };
    if(FORGE_WRITE_ACTIONS.includes(action)){
      if(action==='release.draft'&&raw?.draft!==true)throw capabilityError('FORGE_RESPONSE_INVALID','Unpublished release draft was not confirmed');
      const receipt=project(raw);
      if(action==='branch.create'&&(receipt.name!==input.branch||receipt.sha!==input.sha))throw capabilityError('FORGE_RESPONSE_INVALID','Created branch does not match the reviewed branch and source commit');
      if(action!=='branch.create'&&(!receipt.id||(['issue.create','pull.create'].includes(action)&&!receipt.number)))throw capabilityError('FORGE_RESPONSE_INVALID','Forge write receipt is missing its resource identity');
      return {...result,...receipt};
    }
    const rows=Array.isArray(raw)?raw:action==='builds.list'?raw?.workflow_runs:action==='builds.jobs'?raw?.jobs:null;
    if(!Array.isArray(rows))throw capabilityError('FORGE_RESPONSE_INVALID','Forge resource list required');
    return {...result,items:rows.slice(0,input.perPage??20).map(project),page:input.page??1,hasMore:rows.length>=(input.perPage??20)};
  }
  return Object.freeze({provider,actions:FORGE_ACTIONS,validate,execute,configured:configs.length>0,
    descriptorVersion:'forge-v1:'+crypto.createHash('sha256').update(JSON.stringify(configs)).digest('hex').slice(0,24),
    available:action=>configs.some(c=>c.actions.includes(action))&&!(provider==='gitcode'&&['workflow.dispatch','release.draft'].includes(action)),
    repositories:()=>configs.map(c=>({owner:c.owner,repo:c.repo,actions:c.actions.filter(action=>!(provider==='gitcode'&&['workflow.dispatch','release.draft'].includes(action)))}))});
}
