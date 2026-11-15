import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {writeJsonAtomic} from '../src/storage/json-file.js';

const image=process.env.CETAMESH_TEST_AGENTOS_IMAGE,root=process.env.CETAMESH_TEST_AGENTOS_ROOT;
assert.ok(image&&root,'Explicit existing-image opt-in and prepared runtime required');
assert.ok(fs.existsSync(path.join(root,'cetamesh-adaptation.json')),'Use prepared local-image runtime; no downloads are permitted');
const docker=process.platform==='win32'?'C:/Program Files/Docker/Docker/resources/bin/docker.exe':'docker';
const before=execFileSync(docker,['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8',windowsHide:true}).trim();
assert.ok(before.startsWith('sha256:'));
const base=fs.mkdtempSync(path.join(process.env.CETAMESH_PLUGIN_EVIDENCE_DIR??os.tmpdir(),'cm-agentos-guest-'));
const project=path.join(base,'project');fs.mkdirSync(project);
const services=createCetaMeshServices({stateDir:path.join(base,'state'),dataRoot:path.join(base,'data'),resourceRoot:base,
 sourceRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),deferOptionalStart:true});
const broker=services.capabilityService.broker,rt=services.taskService.runtime;
let envId,task,ws,step=0,observed=false,driverError=null;const approvals=[];
const ui=(method,params)=>services.desktopUiService.execute({method:'ui.plugins.engines.'+method,params});
async function approved(operation,args){const pending=await broker.execute({actor:OWNER_ACTOR,taskId:task.id,workspaceId:ws.id,capability:'agentos.call',input:{operation,arguments:args}});
 assert.equal(pending.status,'pending');return (await broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR})).result;}
try {
 ws=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'AgentOS Guest test'}})).workspace;
 task=rt.create({goal:'Read and write only the test Guest through AgentOS.',workspaceId:ws.id});
 const review=await ui('review',{id:'agentos',root,nodePath:process.execPath});await ui('enable',{id:'agentos',token:review.token});
 await ui('authorize-task',{id:'agentos',taskId:task.id,expectedRev:task.rev});
 // A valid create must reach real approval before execution, including enum-only schema fields.
 const denied=await broker.execute({actor:OWNER_ACTOR,taskId:task.id,workspaceId:ws.id,capability:'agentos.call',input:{operation:'agentos.env.create',arguments:{backend:'docker',image,memMb:128}}});
 assert.equal(denied.status,'pending');await broker.decide({id:denied.approvalId,approve:false,actor:OWNER_ACTOR});
 services.modelRegistry.register({id:'guest-local-driver',label:'No-cost Guest driver',supportsTools:true,defaultModel:'fixture',
  health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('stream only');},
  stream:async function*(request){
   try{
    const results=request.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
    const creation=results.find(r=>r.result?.capability==='agentos.env.create');
    envId??=creation?.result?.result?.env?.id;
    const actions=[['agentos.env.create',{backend:'docker',image,memMb:128}],
     ['agentos.file.write',{id:envId,path:'/tmp/cetamesh-proof.txt',content:'project-agent-guest-proof\n'}],
     ['agentos.file.read',{id:envId,path:'/tmp/cetamesh-proof.txt'}],
     ['agentos.exec',{id:envId,command:'test "$(cat /tmp/cetamesh-proof.txt)" = project-agent-guest-proof && printf verified-guest-proof',timeoutMs:10000}]];
    if(step<actions.length){const [operation,args]=actions[step++];if(step>1)assert.ok(envId,'Actual returned Guest ID required');
     yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'guest-step-'+step,capabilityId:'agentos.call',arguments:JSON.stringify({operation,arguments:args})}]}};
    }else{observed=JSON.stringify(results).includes('verified-guest-proof');assert.ok(observed);
     yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Real Guest write, read and command verified.'}]}}};}
    yield {type:'turn/end',data:{reason:{kind:'completed'}}};
   }catch(cause){driverError=cause;throw cause;}
  }});
 services.providerSecrets.set({provider:'guest-local-driver',apiKey:'local-test-only'});
 await broker.execute({actor:OWNER_ACTOR,capability:'agent.run',taskId:task.id,workspaceId:ws.id,
  input:{agentProvider:'cetamesh',modelProvider:'guest-local-driver',model:'fixture',content:task.goal}});
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){
  if(driverError)throw driverError;
  for(const row of broker.approvals.list().filter(a=>a.status==='pending')){
   assert.equal(row.request.capability,'agentos.call');approvals.push(row.request.input.operation);
   console.log('Approving Guest operation '+row.request.input.operation);
   await services.capabilityService.execute({method:'capability.approval.decide',params:{id:row.id,approve:true}});
  }
  if(rt.get({id:task.id}).task.executionObservation?.state==='awaiting-review')break;
  await delay(30);
 }
 if(driverError)throw driverError;
 assert.ok(observed);assert.equal(approvals.length,4);
 const container=JSON.parse(execFileSync(docker,['inspect','agentos-'+envId],{encoding:'utf8',windowsHide:true}))[0];
 assert.equal(container.Config.Labels['cetamesh.agentos.env'],envId);assert.equal(container.HostConfig.NetworkMode,'none');assert.equal(container.Mounts.length,0);
 assert.equal(container.HostConfig.Privileged,false);assert.ok(container.HostConfig.CapDrop.includes('ALL'));
 const other=rt.create({goal:'Foreign Guest negative',workspaceId:ws.id});
 const forbidden=await broker.execute({actor:OWNER_ACTOR,taskId:other.id,workspaceId:ws.id,capability:'agentos.call',input:{operation:'agentos.file.read',arguments:{id:envId,path:'/tmp/cetamesh-proof.txt'}}});
 await assert.rejects(broker.decide({id:forbidden.approvalId,approve:true,actor:OWNER_ACTOR}),{code:'SCOPE_DENIED'});
 const failed=await approved('agentos.exec',{id:envId,command:'exit 7',timeoutMs:10000});assert.equal(failed.result.code,7);
 await approved('agentos.env.stop',{id:envId});await approved('agentos.env.start',{id:envId});
 const reread=await approved('agentos.file.read',{id:envId,path:'/tmp/cetamesh-proof.txt'});assert.ok(JSON.stringify(reread).includes('project-agent-guest-proof'));
 const removed=await approved('agentos.env.delete',{id:envId});assert.equal(removed.result.result.deleted,true);
 const removedId=envId;envId=null;
 assert.equal(execFileSync(docker,['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8',windowsHide:true}).trim(),before);
 writeJsonAtomic(path.join(base,'acceptance.json'),{status:'PASS',taskId:task.id,environmentId:removedId,imageId:before,approvals,
  evidence:'Real project Managed Agent + local synthetic model + Core approvals + real Docker Guest',
  checks:['write/read/exec','network-none','no-host-mount','foreign-task-denied','nonzero-exit-preserved','stop/start/read','owned-delete'],limitations:['QEMU not tested','No real model or native Desktop acceptance']});
 console.log('PASS actual project Agent controls real isolated Guest; cleanup confirmed. '+base);
}finally{
 if(envId){try{await approved('agentos.env.delete',{id:envId});console.log('Removed only owned test Guest '+envId);}catch(cause){console.error('TEST_GUEST_RETAINED',envId,cause.code);}}
 for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','localEngineService','extensionService','reverseLabAnalyzer','capabilityService'])await services[name]?.close();
}
