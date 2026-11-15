import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
import {readJsonFile,writeJsonAtomic} from '../src/storage/json-file.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'reverselab-boundary-')),project=path.join(base,'project');
for(const name of ['apps','results','unreviewed'])fs.mkdirSync(path.join(project,name),{recursive:true});
fs.mkdirSync(path.join(base,'outside'));
const services=createCetaMeshServices({stateDir:path.join(base,'state'),dataRoot:path.join(base,'data'),sourceRoot:ROOT,resourceRoot:base});
const tool='extension.org.cetamesh.reverselab.analyze_javascript_application',ext=services.extensionService;
try{
  const ws=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Scoped ReverseLab'}})).workspace;
  const source=path.join(base,'plugin');fs.cpSync(path.join(ROOT,'extensions','cetamesh-reverselab'),source,{recursive:true});
  const manifest=readJsonFile(path.join(source,'extension.json'));manifest.scope={workspace:ws.id,paths:['apps','results']};
  writeJsonAtomic(path.join(source,'extension.json'),manifest);
  const review=await ext.execute({method:'ext.review',params:{sourceDir:source}});
  await ext.execute({method:'ext.install',params:{sourceDir:source,approval:{approved:true,token:review.review.token}}});
  await ext.execute({method:'ext.enable',params:{id:manifest.id}});
  assert.equal(services.reverseLabAnalyzer.health().status,'PROVIDER_MISSING','Optional engine absence must not prevent Core startup');
  async function refused(input,code){
    const task=services.taskService.runtime.create({goal:'Boundary negative test',workspaceId:ws.id});
    const pending=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,capability:tool,taskId:task.id,workspaceId:ws.id,input});
    assert.equal(pending.status,'pending');
    await assert.rejects(services.capabilityService.broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR}),{code});
    assert.equal(services.reverseLabAnalyzer.health().active,0,'Refusal must occur before REA launch');
  }
  await refused({path:'../outside',outputPath:'results/one'},'REVERSELAB_SCOPE_DENIED');
  await refused({path:'unreviewed',outputPath:'results/two'},'REVERSELAB_SCOPE_DENIED');
  fs.symlinkSync(path.join(project,'unreviewed'),path.join(project,'apps','other'),'junction');
  await refused({path:'apps/other',outputPath:'results/three'},'REVERSELAB_SCOPE_DENIED');
  fs.symlinkSync(path.join(project,'unreviewed'),path.join(project,'results','other'),'junction');
  await refused({path:'apps',outputPath:'results/other/four'},'REVERSELAB_SCOPE_DENIED');
  fs.symlinkSync(path.join(base,'outside'),path.join(project,'apps','outside'),'junction');
  await refused({path:'apps/outside',outputPath:'results/five'},'BOUNDARY_ESCAPE');
  await assert.rejects(services.capabilityService.broker.execute({actor:OWNER_ACTOR,capability:'analysis.static',workspaceId:ws.id,
    scope:{plugin:manifest.id,pluginChain:[{id:manifest.id,descriptorVersion:'forged'}]},input:{path:'apps',outputPath:'results/forged'}}));
  const task=services.taskService.runtime.create({goal:'Pending disable test',workspaceId:ws.id});
  const pending=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,capability:tool,taskId:task.id,workspaceId:ws.id,
    input:{path:'apps',outputPath:'results/disabled'}});
  await ext.execute({method:'ext.disable',params:{id:manifest.id}});
  await assert.rejects(services.capabilityService.broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR}));
  assert.ok(!fs.existsSync(path.join(project,'results','disabled')));
  console.log('PASS real Core missing-engine startup, exact plugin scope, inside/outside Workspace junctions, forged direct adapter and disabled pending approval refusal');
}finally{
  for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','extensionService','reverseLabAnalyzer','capabilityService'])await services[name]?.close();
  // Junctions are removed explicitly before deleting only this test-owned temporary directory.
  for(const relative of ['apps/other','apps/outside','results/other']){const p=path.join(project,relative);if(fs.existsSync(p))fs.unlinkSync(p);}
  assert.ok(path.basename(base).startsWith('reverselab-boundary-'));fs.rmSync(base,{recursive:true,force:true});
}
