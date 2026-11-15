import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {writeJsonAtomic,readJsonFile} from '../src/storage/json-file.js';
import {prepareReverseLabPlugin} from './reverselab/prepare-plugin.mjs';

// Only the model leaf is deterministic. Core, Agent, install/approval, REA, NTFS and Evidence are real.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=fs.mkdtempSync(path.join(process.env.CETAMESH_REVERSELAB_EVIDENCE_DIR??os.tmpdir(),'reverselab-core-'));
const project=path.join(base,'project');fs.mkdirSync(path.join(project,'apps','sample'),{recursive:true});
fs.mkdirSync(path.join(project,'results'));
writeJsonAtomic(path.join(project,'apps','sample','package.json'),{name:'real-reverselab-sample',version:'1.0.0',type:'module',main:'main.js'});
fs.writeFileSync(path.join(project,'apps','sample','main.js'),'export function nativeReverseLabProof(value) { return value.trim().toUpperCase(); }\n');
const services=createCetaMeshServices({stateDir:path.join(base,'state'),dataRoot:path.join(base,'data'),sourceRoot:ROOT,
  resourceRoot:process.env.CETAMESH_TEST_REVERSELAB_RESOURCES});
const tool='extension.org.cetamesh.reverselab.analyze_javascript_application';
const rt=services.taskService.runtime,seen=new Set();let approvals=0,actualResult=false;
try{
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'ReverseLab P1'}})).workspace;
  const pluginSource=path.join(base,'plugin');
  prepareReverseLabPlugin({workspaceService:services.workspaceService,workspaceId:workspace.id,paths:['apps','results'],outputRoot:pluginSource});
  const manifest=readJsonFile(path.join(pluginSource,'extension.json'));
  const ext=(method,params)=>services.extensionService.execute({method,params});
  const reviewed=await ext('ext.review',{sourceDir:pluginSource});
  assert.equal(reviewed.scan.ok,true);
  await ext('ext.install',{sourceDir:pluginSource,approval:{approved:true,token:reviewed.review.token}});
  await ext('ext.enable',{id:manifest.id});
  assert.ok(services.capabilityService.broker.registry.has(tool));
  assert.equal(services.capabilityService.broker.registry.require('analysis.static').modelCallable,false);
  await assert.rejects(services.capabilityService.broker.execute({actor:OWNER_ACTOR,workspaceId:workspace.id,
    capability:'analysis.static',input:{path:'apps/sample',outputPath:'results/direct'}}));

  services.modelRegistry.register({id:'reverselab-local-driver',label:'Deterministic local test driver',supportsTools:true,defaultModel:'fixture',
    health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('stream expected');},
    stream:async function*(request){
      const user=[...request.messages].reverse().find(m=>m.role==='user'),key=JSON.stringify(user?.content);
      if(!seen.has(key)){seen.add(key);const continueEvidence=key.includes('REVERSELAB_REVIEW_COMMITTED_EVIDENCE');
        yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'real-analysis-'+seen.size,capabilityId:continueEvidence?'filesystem.read':tool,
          arguments:JSON.stringify(continueEvidence?{path:'results/run-1/index.json'}:{path:'apps/sample',outputPath:'results/run-'+seen.size})}]}};}
      else{actualResult=JSON.stringify(request.messages.filter(m=>m.role==='tool')).includes('analysisRunId');
        assert.ok(actualResult,'Managed Agent must receive the actual committed result receipt');
        yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Actual REA evidence is ready for Owner review.'}]}}};}
      yield {type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  services.providerSecrets.set({provider:'reverselab-local-driver',apiKey:'local-synthetic-only'});
  const task=rt.create({goal:'Analyze apps/sample with installed ReverseLab and retain actual Evidence.',workspaceId:workspace.id});
  services.capabilityService.grantTask(task.id,{capabilities:[tool,'analysis.static','filesystem.read']});
  const accepted=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,capability:'agent.run',taskId:task.id,workspaceId:workspace.id,
    input:{agentProvider:'cetamesh',modelProvider:'reverselab-local-driver',model:'fixture',content:task.goal}});
  assert.equal(accepted.result.accepted,true);
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    for(const approval of services.capabilityService.broker.approvals.list().filter(r=>r.status==='pending')){
      assert.ok([tool,'analysis.static'].includes(approval.request.capability),'Only the plugin and its exact static operation may request approval');
      assert.deepEqual(approval.request.input,{path:'apps/sample',outputPath:'results/run-1'});
      approvals++;
      await services.capabilityService.execute({method:'capability.approval.decide',params:{id:approval.id,approve:true}});
    }
    const current=rt.get({id:task.id}).task;
    if(current.executionObservation?.state==='awaiting-review')break;
    await delay(20);
  }
  const current=rt.get({id:task.id}).task;
  assert.equal(current.executionObservation?.state,'awaiting-review',JSON.stringify(current.executionObservation));
  assert.equal(actualResult,true);
  assert.equal(current.status,'running','Model completion must not fake Task completion');
  assert.equal(approvals,2,'Existing data-host policy separately approves the plugin and concrete filesystem effect');
  const artifact=current.artifacts.find(a=>a.ref==='results/run-1/index.json');
  assert.ok(artifact,'Production adapter must register a real Task artifact, not the test');
  const index=readJsonFile(path.join(project,artifact.ref)),bundle=readJsonFile(index.bundlePath);
  assert.ok(JSON.stringify(bundle).includes('nativeReverseLabProof'));
  assert.ok(index.evidenceIds.every(id=>bundle.records.some(r=>r.evidence_id===id)));
  const read=await services.workspaceService.execute({method:'workspace.read',params:{id:workspace.id,path:artifact.ref}});
  assert.ok(JSON.stringify(read).includes(index.analysisRunId),'Existing Workspace read sees the committed artifact');
  const checkpoint=rt.setCheckpoint({id:task.id,expectedRev:rt.get({id:task.id}).task.rev,
    summary:'Committed ReverseLab Evidence '+index.evidenceIds.join(', '),nextAction:'Read the committed index; do not rerun analysis.'});
  const paused=await services.desktopUiService.execute({method:'ui.task.pause',params:{id:task.id,expectedRev:checkpoint.rev}});
  assert.equal(paused.task.status,'paused');
  const resumed=await services.desktopUiService.execute({method:'ui.task.resume',params:{id:task.id,expectedRev:paused.task.rev,
    requestId:'reverselab-evidence-continuation',nextInstruction:'REVERSELAB_REVIEW_COMMITTED_EVIDENCE: read results/run-1/index.json and retain its original Evidence references.'}});
  assert.equal(resumed.task.id,task.id);
  const resumeDeadline=Date.now()+30000;
  while(Date.now()<resumeDeadline){const row=rt.get({id:task.id}).task;
    if(row.executionObservation?.state==='awaiting-review'&&row.executionEvidence.some(e=>e.capability==='filesystem.read'&&e.status==='completed'))break;
    await delay(20);}
  const continued=rt.get({id:task.id}).task;
  assert.ok(continued.executionEvidence.some(e=>e.capability==='filesystem.read'&&e.status==='completed'),'Resumed Agent actually reads the previously committed Evidence index');
  assert.equal(continued.executionObservation?.state,'awaiting-review');
  assert.equal(continued.executionEvidence.filter(e=>e.capability===tool&&e.status==='completed').length,1,'Continuation must not repeat completed analysis');
  assert.equal(readJsonFile(index.indexPath).bundleSha256,index.bundleSha256);
  const stopRequest=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,taskId:task.id,workspaceId:workspace.id,
    capability:tool,input:{path:'apps/sample',outputPath:'results/interrupted'}});
  const stopChild=await services.capabilityService.broker.decide({id:stopRequest.approvalId,approve:true,actor:OWNER_ACTOR});
  const interrupted=services.capabilityService.broker.decide({id:stopChild.approvalId,approve:true,actor:OWNER_ACTOR})
    .then(()=>null,error=>error);
  const stopDeadline=Date.now()+30000;
  while(!fs.existsSync(path.join(project,'results','interrupted','mcp-stdout.jsonl'))&&Date.now()<stopDeadline)await delay(10);
  assert.ok(fs.existsSync(path.join(project,'results','interrupted','mcp-stdout.jsonl')),'A real Worker run must have started');
  await ext('ext.disable',{id:manifest.id});
  assert.ok(await interrupted,'Interrupted run must not be reported as completed');
  assert.ok(!fs.existsSync(path.join(project,'results','interrupted','index.json')),'Interrupted run must not publish a success commit index');
  assert.equal(services.capabilityService.broker.registry.has(tool),false);
  assert.equal(services.reverseLabAnalyzer.health().active,0);
  await ext('ext.enable',{id:manifest.id});
  await ext('ext.uninstall',{id:manifest.id});
  assert.equal(services.capabilityService.broker.registry.has(tool),false);
  assert.ok(fs.existsSync(index.bundlePath),'Uninstall must preserve original user Evidence');
  writeJsonAtomic(path.join(base,'acceptance.json'),{evidence:'source-Core/real-Managed-Agent/deterministic-model/real-REA',taskId:task.id,
    workspaceId:workspace.id,approvals,actualResult,artifact,index,pauseResume:'safe-boundary/actual-index-read/no-analysis-replay',limitations:['No real paid model','No native WebView or clean Windows VM acceptance','No arbitrary in-engine resume']});
  console.log('PASS install/enable -> Managed Agent -> existing two scoped approvals -> real REA -> original Evidence -> Task artifact -> Workspace read -> disable/reinstall/uninstall; '+base);
}finally{
  for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','extensionService','reverseLabAnalyzer','capabilityService'])await services[name]?.close();
}
