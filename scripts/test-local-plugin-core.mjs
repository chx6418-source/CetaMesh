import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {readJsonFile,writeJsonAtomic} from '../src/storage/json-file.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const base=fs.mkdtempSync(path.join(process.env.CETAMESH_PLUGIN_EVIDENCE_DIR??os.tmpdir(),'cm-plugins-core-')),project=path.join(base,'project');fs.mkdirSync(project);
writeJsonAtomic(path.join(project,'package.json'),{name:'plugin-proof',version:'1.0.0',main:'index.js'});
fs.writeFileSync(path.join(project,'index.js'),'exports.pluginProof = value => value + 7;\n');
const options={stateDir:path.join(base,'state'),dataRoot:path.join(base,'data'),
 sourceRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),resourceRoot:base,deferOptionalStart:true};
let services=createCetaMeshServices(options);
const ui=(method,params={})=>services.desktopUiService.execute({method:'ui.plugins.engines.'+method,params});
const broker=services.capabilityService.broker,rt=services.taskService.runtime;
let sessionId;
console.log('Isolated evidence: '+base);
try {
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Local plugin proof'}})).workspace;
 const task=rt.create({goal:'Use both project plugins through real Core approval.',workspaceId:workspace.id});
 const invoke=(capability,input={},extra={})=>broker.execute({actor:OWNER_ACTOR,taskId:task.id,workspaceId:workspace.id,capability,input,...extra});
 assert.deepEqual((await ui('list')).engines,[],'fresh Core projects no connected external plugins');
 await assert.rejects(invoke('agentos.env.list'),{code:'AGENTOS_NOT_CONFIGURED'});
 for(const [id,root] of [['agentos',process.env.CETAMESH_TEST_AGENTOS_ROOT],['reverselab',path.join(process.env.CETAMESH_TEST_REVERSELAB_RESOURCES,'plugins','reverselab')]]){
  const file=process.env[id==='agentos'?'CETAMESH_TEST_AGENTOS_PACKAGE':'CETAMESH_TEST_REVERSELAB_PACKAGE'];
  if(file){const review=await ui('package.review',{file});await ui('package.install',{id,token:review.token,reviewed:true,enable:true});}
  else{const review=await ui('review',{id,root,nodePath:process.execPath});await ui('enable',{id,token:review.token});}
  await ui('authorize-task',{id,taskId:task.id,expectedRev:task.rev});
 }
 assert.deepEqual((await ui('list')).engines.map(({id,enabled})=>[id,enabled]),[['agentos',true],['reverselab',true]]);
 const pending=await invoke('agentos.env.list');assert.equal(pending.status,'pending');
 const listed=await broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR});
 assert.deepEqual(listed.result.result.environments,[]);
 // A rejected native launch must not create a process or session directory.
 const rejected=await invoke('reverselab.session.open');await broker.decide({id:rejected.approvalId,approve:false,actor:OWNER_ACTOR});
 assert.equal(fs.existsSync(path.join(base,'state','reverselab','sessions')),false);
 const stale=await invoke('agentos.env.list');await ui('disable',{id:'agentos'});
 await assert.rejects(broker.decide({id:stale.approvalId,approve:true,actor:OWNER_ACTOR}));
 const savedAgentOs=services.localEngineService.getConfiguration('agentos');
 const newReview=await ui('review',{id:'agentos',root:savedAgentOs.root,nodePath:savedAgentOs.nodePath});await ui('enable',{id:'agentos',token:newReview.token});

 let step=0,received=false,driverError=null;const calls=[];
 services.modelRegistry.register({id:'local-plugin-driver',label:'Local protocol driver',defaultModel:'fixture',supportsTools:true,
  health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('stream only');},
  stream:async function*(request){
   try{
   const outputs=JSON.stringify(request.messages.filter(m=>m.role==='tool'));
   if(!sessionId){const match=outputs.match(/sessionId\\?":\\?"([a-f0-9-]{36})/);if(match)sessionId=match[1];}
   const sequence=[['agentos.call',{operation:'agentos.env.list',arguments:{}}],['reverselab.session.open',{}],
    ['reverselab.call',{sessionId,name:'analyze_javascript_application',arguments:{input_path:project,format:'directory',detail:'summary'}}],
    ['reverselab.call',{sessionId,name:'export_evidence_bundle',arguments:{path:path.join(project,'bundle.json'),overwrite:false}}],
    ['reverselab.prompt',{sessionId,name:'investigate_feature',arguments:{feature:'pluginProof'}}]];
   if(step<sequence.length){const [capabilityId,args]=sequence[step++];calls.push(capabilityId);
    console.log('Model request step '+step+': '+capabilityId);
    if(step>=3)assert.ok(sessionId,'Agent must receive the real session ID before dependent calls');
    yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'plugin-step-'+step,capabilityId,arguments:JSON.stringify(args)}]}};
   }else {received=outputs.includes('evidenceRef');assert.ok(received);assert.ok(outputs.includes('template')&&outputs.includes('pluginProof'),'Official prompt must reach the Agent as usable template content');yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Actual plugin results received; retained for review.'}]}}};}
   yield {type:'turn/end',data:{reason:{kind:'completed'}}};
   }catch(cause){driverError=cause;throw cause;}
  }});
 services.providerSecrets.set({provider:'local-plugin-driver',apiKey:'local-test-only'});
 const launched=await broker.execute({actor:OWNER_ACTOR,capability:'agent.run',taskId:task.id,workspaceId:workspace.id,
  input:{agentProvider:'cetamesh',modelProvider:'local-plugin-driver',model:'fixture',content:task.goal}});assert.equal(launched.result.accepted,true);
 const deadline=Date.now()+120000;let approvals=0;
 while(Date.now()<deadline){
  if(driverError)throw driverError;
  for(const row of broker.approvals.list().filter(a=>a.status==='pending')){
   assert.ok(row.request.capability.startsWith('agentos.')||row.request.capability.startsWith('reverselab.'));
   console.log('Approve exact request: '+row.request.capability);
   approvals++;const outcome=await services.capabilityService.execute({method:'capability.approval.decide',params:{id:row.id,approve:true}});
   console.log('Approval outcome: '+JSON.stringify({status:outcome.status,code:outcome.code}));
  }
  if(rt.get({id:task.id}).task.executionObservation?.state==='awaiting-review')break;
  await delay(20);
 }
 const current=rt.get({id:task.id}).task;
 assert.equal(current.executionObservation?.state,'awaiting-review',JSON.stringify(current.executionObservation));
 assert.equal(received,true);assert.equal(approvals,5);assert.equal(calls.length,5);
 const bundle=readJsonFile(path.join(project,'bundle.json'));assert.ok(JSON.stringify(bundle).includes('pluginProof'),'Second call must export actual Evidence retained from first call');
 const catalog=await invoke('reverselab.catalog',{sessionId});assert.equal(catalog.result.total,229);assert.equal(catalog.result.prompts.length,6);
 const completeCatalog=readJsonFile(path.join(base,'state','reverselab','sessions',sessionId,'catalog.json'));
 for(const tool of completeCatalog.tools){const validator=new Ajv2020({strict:false});addFormats(validator);assert.equal(typeof validator.compile(tool.inputSchema),'function',tool.name+' schema must be callable without narrowing');}
 await assert.rejects(invoke('reverselab.call',{sessionId,name:'invented',arguments:{}}),{code:'REVERSELAB_TOOL_UNKNOWN'});
 await assert.rejects(invoke('reverselab.call',{sessionId,name:'analyze_javascript_application',arguments:{invented:true}}),{code:'TOOL_ARGUMENTS_INVALID'});
 const foreign=rt.create({goal:'Foreign task cannot reuse analysis session',workspaceId:workspace.id});
 await assert.rejects(broker.execute({actor:OWNER_ACTOR,taskId:foreign.id,workspaceId:workspace.id,capability:'reverselab.catalog',input:{sessionId}}),{code:'REVERSELAB_SESSION_LOST'});
 const close=await invoke('reverselab.session.close',{sessionId});await broker.decide({id:close.approvalId,approve:true,actor:OWNER_ACTOR});
 assert.ok(fs.existsSync(path.join(base,'state','reverselab','sessions',sessionId,'mcp-stdout.jsonl')));
 const record=await invoke('reverselab.record',{sessionId,sequence:2});assert.ok(record.result.content.includes('records'));
 for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','extensionService','localEngineService','reverseLabAnalyzer','capabilityService'])await services[name]?.close();
 services=createCetaMeshServices(options);
 const restored=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,taskId:task.id,workspaceId:workspace.id,capability:'reverselab.record',input:{sessionId,sequence:2}});
 assert.equal(restored.result.sha256,record.result.sha256,'Core restart must retain the exact committed record without replay');
 await assert.rejects(services.capabilityService.broker.execute({actor:OWNER_ACTOR,taskId:task.id,workspaceId:workspace.id,capability:'reverselab.call',input:{sessionId,name:'export_evidence_bundle',arguments:{path:path.join(project,'no-replay.json')}}}),{code:'REVERSELAB_SESSION_LOST'});
 assert.equal(fs.existsSync(path.join(project,'no-replay.json')),false);
 writeJsonAtomic(path.join(base,'acceptance.json'),{status:'PASS',evidence:'actual Core + Managed Agent + local deterministic model + real AgentOS host + real REA',
  taskId:task.id,sessionId,approvals,toolCount:catalog.result.total,promptCount:catalog.result.prompts.length,
  limitations:['Guest execution not tested here','No real model or native WebView2 acceptance','229 tool discovery is not 229 tool execution']});
 console.log('PASS real project Agent invokes AgentOS and persistent REA through Core approvals; original Evidence, prompt, rejected launch, stale config, schema and foreign Task boundaries. '+base);
}finally{
 for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','extensionService','localEngineService','reverseLabAnalyzer','capabilityService'])await services[name]?.close();
}
