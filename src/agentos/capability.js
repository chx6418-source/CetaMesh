import path from 'node:path';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import contract from './managed-v1.json' with {type:'json'};
import {createAgentOsHost,signAgentOsGrant} from './host.js';
import {capabilityError} from '../capability/types.js';
import {validateSchema} from '../model/input-schema.js';

export const AGENTOS_INPUTS=Object.fromEntries(contract.oneOf.map(branch=>[branch.properties.capability.const,branch.properties.input]));
const inputValidators=Object.fromEntries(Object.entries(AGENTOS_INPUTS).map(([id,schema])=>[id,new Ajv2020({strict:false}).compile(schema)]));
const READS=new Set(['agentos.backend.list','agentos.env.list','agentos.env.status','agentos.file.read','agentos.snapshot.list','agentos.env.logs']);
export function registerAgentOsCapabilities({broker,stateDir,engines}){
  const hosts=new Map();let closed=false;
  const definitions=[],register=definition=>definitions.push({...definition,catalogOwner:'local-engine:agentos'});
  const active=new Set();
  async function getHost(config,scope){
    if(closed)throw capabilityError('AGENTOS_CLOSED','AgentOS adapter is closed.');
    if(hosts.get(scope)?.host?.stopped)hosts.delete(scope);
    if(hosts.has(scope))return hosts.get(scope).ready;
    if(hosts.size>=4){
      const idle=[...hosts].find(([key])=>!active.has(key));
      if(!idle)throw capabilityError('AGENTOS_CAPACITY','Four project operations are currently active.');
      await idle[1].ready;await idle[1].host.close();hosts.delete(idle[0]);
    }
    const row={key:crypto.randomBytes(32).toString('hex'),host:null,ready:null};hosts.set(scope,row);
    row.ready=(async()=>{
      row.host=createAgentOsHost({root:config.root,nodePath:config.nodePath,home:path.join(stateDir,'agentos',scope),sessionKey:row.key});
      try{const hello=await row.host.hello();if(hello.protocol!=='cetamesh.agentos.managed.v1'||hello.namespace!=='cetamesh-managed')
        throw capabilityError('AGENTOS_PROTOCOL_MISMATCH','Unsupported managed host protocol.');}
      catch(error){await row.host.close();hosts.delete(scope);throw error;}
      return row;
    })();
    return row.ready;
  }
  function admission(request,capability){
    const config=engines.getConfiguration('agentos');
    if(!config?.enabled)throw capabilityError('AGENTOS_NOT_CONFIGURED','Enable a reviewed AgentOS runtime in Plugins.');
    if(!request.taskId||!request.workspaceId)throw capabilityError('TASK_REQUIRED','AgentOS requires an existing project Task.');
    if(request.actor.kind!=='owner'&&request.actor.kind!=='agent')throw capabilityError('PERMISSION_DENIED','Only project Task principals may use AgentOS.');
    if(request.agentOsRevision!==undefined&&request.agentOsRevision!==config.revision)
      throw capabilityError('APPROVAL_EXPIRED','AgentOS configuration changed; review the operation again.');
    request.agentOsRevision=config.revision;
    if(!inputValidators[capability]?.(request.input))throw capabilityError('TOOL_ARGUMENTS_INVALID','Arguments do not match the exact AgentOS managed contract.');
    if(capability==='agentos.env.create'&&request.input.backend==='wsl')throw capabilityError('AGENTOS_BACKEND_UNSUPPORTED','Managed WSL creation is not supported by this host.');
    return config;
  }
  function definition(id,inputSchema,modelCallable=false,resolveId=()=>id){return {id,permission:'extension.invoke',provider:'agentos',
    risk:READS.has(id)?'high':'critical',effect:READS.has(id)?'read-only':'unknown',workspace:true,requiresTask:true,
    modelCallable,inputSchema,description:`AgentOS project-owned Guest operation ${id}. Use agentos.catalog to read exact operation inputs. Core approval required; never controls standalone user environments.`,
    validate:request=>{if(id==='agentos.call')validateSchema(inputSchema,request.input);return admission(operationRequest(request),resolveId(request));},
    async execute(request){
      request=operationRequest(request);const capability=resolveId(request);
      const config=admission(request,capability),release=engines.acquire('agentos',config.revision);
      const scope=crypto.createHash('sha256').update(request.taskId+'\0'+request.workspaceId).digest('hex');
      if(active.has(scope)){release();throw capabilityError('AGENTOS_BUSY','A project Guest operation is still in flight.');}
      active.add(scope);
      try{
        await engines.verifyConfiguration('agentos',config);
        const connection=await getHost(config,scope);admission(request,capability);request.signal?.throwIfAborted();
        const operationId='cm-'+crypto.createHash('sha256').update(request.requestId).digest('hex');
        const contextRef=crypto.createHash('sha256').update(request.taskId+'\0'+request.workspaceId).digest('hex');
        const grant={namespace:'cetamesh-managed',operationId,contextRef,capability,
          scopeId:contextRef,taskId:request.taskId,workspaceId:request.workspaceId,environmentId:request.input.id??null,
          inputDigest:crypto.createHash('sha256').update(JSON.stringify(request.input)).digest('hex'),
          expiresAt:Date.now()+60000,destructiveApproved:['agentos.env.delete','agentos.snapshot.restore'].includes(capability),
          limits:{maxOutputBytes:32768,maxTimeoutMs:120000,maxMemoryMb:4096,maxDiskGb:64}};
        const result=await connection.host.request({operationId,contextRef,capability,input:request.input,grant:signAgentOsGrant(grant,connection.key)},
          {signal:request.signal,timeoutMs:150000});
        if(result.operationId!==operationId)throw capabilityError('AGENTOS_RESPONSE_MISMATCH','Response does not belong to this operation.');
        if(!result.ok)throw capabilityError(/^[A-Z_]{1,80}$/.test(result.code??'')?result.code:'AGENTOS_FAILED','AgentOS refused or could not settle this operation.');
        return {operationId,taskId:request.taskId,workspaceId:request.workspaceId,capability,result:result.result,truncated:result.truncated===true};
      }finally{active.delete(scope);release();}
    }};
    function operationRequest(request){
      if(id!=='agentos.call')return request;
      // Keep the approved envelope untouched; bind the configuration revision back to it.
      const projected={...request,input:request.input.arguments,agentOsOperation:request.input.operation};
      if(!Object.hasOwn(AGENTOS_INPUTS,projected.agentOsOperation))throw capabilityError('AGENTOS_OPERATION_UNKNOWN','Unknown managed operation.');
      const config=admission(projected,projected.agentOsOperation);request.agentOsRevision=config.revision;return projected;
    }
  }
  for(const [id,inputSchema] of Object.entries(AGENTOS_INPUTS))register(definition(id,inputSchema));
  register(definition('agentos.call',{type:'object',additionalProperties:false,required:['operation','arguments'],properties:{
    operation:{type:'string',enum:Object.keys(AGENTOS_INPUTS)},arguments:{type:'object',additionalProperties:true}}},true,
    request=>request.agentOsOperation??request.input.operation));
  register({id:'agentos.catalog',permission:'extension.invoke',provider:'agentos',risk:'low',effect:'read-only',workspace:true,requiresTask:true,modelCallable:true,
    inputSchema:{type:'object',additionalProperties:false,properties:{operation:{type:'string',enum:Object.keys(AGENTOS_INPUTS)}}},
    description:'List all 15 managed Guest operations or read the exact input schema of one operation. Invoke via agentos.call after Core approval.',
    validate:request=>{if(!engines.getConfiguration('agentos')?.enabled)throw capabilityError('AGENTOS_NOT_CONFIGURED','Enable AgentOS first.');},
    execute:async request=>request.input.operation?{operation:request.input.operation,inputSchema:AGENTOS_INPUTS[request.input.operation]}:{operations:Object.keys(AGENTOS_INPUTS)}});
  async function stop(){for(const [scope,row] of hosts){await row.ready.catch(()=>null);await row.host?.close();hosts.delete(scope);}}
  function refresh(){const config=engines.getConfiguration('agentos');broker.registry.replaceProviderEntries('local-engine:agentos',definitions.map(row=>({...row,
    available:config?.enabled===true,availability:config?.enabled?'available':'disabled',descriptorVersion:config?.revision??'disabled'})));}
  refresh();
  return {refresh,status:()=>({hosts:hosts.size,active:active.size,protocol:'cetamesh.agentos.managed.v1'}),
    async disconnect(){if(active.size)throw capabilityError('AGENTOS_BUSY','Wait for owned operations before changing configuration.');await stop();},
    async close(){closed=true;await stop();}};
}
