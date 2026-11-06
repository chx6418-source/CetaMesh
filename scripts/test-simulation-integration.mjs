import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {SIMULATION_UI_METHODS} from '../src/simulation/ui-methods.js';
import {createSimulationService} from '../src/simulation/service.js';
import {createPersonaLibrary} from '../src/simulation/persona-assets.js';
const nativePolicy=fs.readFileSync(new URL('../desktop-shell/src/webview_policy.rs',import.meta.url),'utf8');
const nativeMethods=new Set([...nativePolicy.matchAll(/"(ui\.[a-zA-Z.]+)"/g)].map(m=>m[1]));
for(const method of SIMULATION_UI_METHODS)assert.ok(nativeMethods.has('ui.simulation.'+method),'Native WebView2 must allow the exact trusted Simulation method: '+method);
assert.ok(!nativePolicy.split('#[cfg(test)]')[0].includes('starts_with("ui.simulation.")'),'unknown Simulation native methods must remain denied');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-simulation-'));
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:root,resourceRoot:root,sourceRoot:root,deferOptionalStart:true});
const ui=(method,params={})=>services.desktopUiService.execute({method,params});
try {
  assert.ok(services.simulationService,'Native Simulation must be composed without QQ or DSH readiness');
  services.providerSecrets.set({provider:'deepseek-official',apiKey:'synthetic-not-used'});
  const officialProfile=services.modelRegistry.require('deepseek-official').contextCapabilities('deepseek-flash');
  assert.equal(officialProfile.outputTokenParameter,'max_tokens','official DeepSeek must honor explicit bounded Simulation output');
  let calls=0;const modelInputs=[];
  services.modelRegistry.register({id:'simulation-fixture',label:'Simulation local fixture',defaultModel:'fixture',supportsTools:false,
    health:async()=>({available:true}),listModels:async()=>[{id:'fixture'}],
    chat:async args=>{calls++;modelInputs.push(structuredClone(args.messages));assert.equal(args.tools,undefined);return {text:'鲸收到啦，这只是讨论，工程结果等真实验收。',usage:{inputTokens:100,outputTokens:20,totalTokens:120}};},
    stream:async function*(){throw Error('discussion must use existing model chat entry');}});
  services.providerSecrets.set({provider:'simulation-fixture',apiKey:'synthetic-local-only'});
  const saved=await ui('ui.simulation.role.save',{name:'鲸',sourceText:'你是鲸。保留口语习惯，不自称完成真实工程。'});
  const made=await ui('ui.simulation.room.create',{title:'本地仿真',scene:'free',roleIds:[saved.role.id],modelProvider:'simulation-fixture',model:'fixture'});
  const sent=await ui('ui.simulation.message.send',{roomId:made.room.id,text:'你好',requestId:'native-integration-1'});
  let room=sent.room;
  for(let i=0;i<100;i++){room=(await ui('ui.simulation.room.get',{roomId:room.id})).room;if(room.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(calls,1);assert.ok(room.messages.some(m=>m.roleId===saved.role.id&&m.text.includes('鲸收到')));
  assert.equal((await ui('ui.simulation.overview')).rooms.length,1);
  await ui('ui.simulation.message.send',{roomId:room.id,text:'你好',requestId:'native-integration-1'});assert.equal(calls,1);
  await assert.rejects(ui('ui.simulation.project.create',{roomId:room.id,requestId:'no-workspace'}),{code:'SIMULATION_WORKSPACE_REQUIRED'});
  const projectRoot=path.join(root,'project');fs.mkdirSync(path.join(projectRoot,'docs'),{recursive:true});
  fs.writeFileSync(path.join(projectRoot,'README.md'),'# Project fixture\nPROJECT_READ_PROOF_README\n');
  const plan='PROJECT_READ_PROOF_PLAN\nA bounded discussion can inspect this actual file.\n';
  fs.writeFileSync(path.join(projectRoot,'docs','plan.md'),plan);
  fs.writeFileSync(path.join(projectRoot,'.env'),'SIMULATION_PRIVATE_TOKEN_MUST_NOT_LEAK');
  fs.writeFileSync(path.join(projectRoot,'unused.txt'),'UNREQUESTED_FILE_BODY_MUST_NOT_BE_COPIED\n'.repeat(1000));
  fs.mkdirSync(path.join(projectRoot,'state'));fs.writeFileSync(path.join(projectRoot,'state','history.json'),'PRIVATE_STORED_CHAT_MUST_NOT_LEAK');
  fs.linkSync(path.join(projectRoot,'.env'),path.join(projectRoot,'public-alias.txt'));
  for(const extension of ['pem','key','pfx','p12'])fs.writeFileSync(path.join(projectRoot,'signing.'+extension),'PRIVATE_KEY_EXTENSION_MUST_NOT_LEAK');
  fs.writeFileSync(path.join(projectRoot,'assets.json'),JSON.stringify({title:'Project fixture',apiKey:'QUOTED_JSON_APIKEY_MUST_NOT_LEAK',access_token:'QUOTED_JSON_TOKEN_MUST_NOT_LEAK',password:'QUOTED_JSON_PASSWORD_MUST_NOT_LEAK'}));
  fs.writeFileSync(path.join(projectRoot,'notes.txt'),'Key example follows.\n-----BEGIN PRIVATE KEY-----\n'+('TRUNCATED_PEM_BODY_MUST_NOT_LEAK\n'.repeat(200)));
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'outside.txt'),'OUTSIDE_WORKSPACE_MUST_NOT_LEAK');
  fs.symlinkSync(outside,path.join(projectRoot,'outside-link'),process.platform==='win32'?'junction':'dir');
  const {workspace}=await services.workspaceService.execute({method:'workspace.create',params:{name:'Bound discussion project',root:projectRoot}});
  const workspaceCalls=[],workspaceExecute=services.workspaceService.execute.bind(services.workspaceService);
  services.workspaceService.execute=async request=>{workspaceCalls.push(structuredClone(request));return workspaceExecute(request);};
  async function sendRoom(id,text,requestId){await ui('ui.simulation.message.send',{roomId:id,text,requestId});for(let i=0;i<100;i++){const current=(await ui('ui.simulation.room.get',{roomId:id})).room;if(current.status!=='running')return current;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Project discussion did not settle');}
  const taskCount=services.taskService.runtime.countAll();
  const project=(await ui('ui.simulation.room.create',{title:'讨论',scene:'project',goal:'项目分析',workspaceId:workspace.id,
    roleIds:[saved.role.id],modelProvider:'simulation-fixture',model:'fixture'})).room;
  const inspected=await sendRoom(project.id,'是否能读到工作区？请查看 docs/plan.md。','project-read-evidence');
  const sentContext=JSON.stringify(modelInputs.at(-1));
  assert.match(sentContext,/PROJECT_READ_PROOF_PLAN/,'real project file content must reach the existing Model Runtime');
  assert.match(sentContext,/README.md/);assert.doesNotMatch(sentContext,/cannot execute tasks, access files/);
  assert.doesNotMatch(sentContext,/SIMULATION_PRIVATE_TOKEN|OUTSIDE_WORKSPACE_MUST_NOT_LEAK|UNREQUESTED_FILE_BODY_MUST_NOT_BE_COPIED/);
  assert.ok(modelInputs.at(-1).reduce((sum,row)=>sum+row.content.length,0)<=24000,'project evidence stays within the existing room context budget');
  const trace=inspected.messages.findLast(row=>row.kind==='discussion').trace.workspaceContext;
  assert.equal(trace.workspaceId,workspace.id);assert.equal(trace.access,'read-only');
  assert.ok(trace.files.some(row=>row.path==='docs/plan.md'&&row.fileSha256===crypto.createHash('sha256').update(plan).digest('hex')));
  assert.ok(!JSON.stringify(trace).includes(plan)&&!JSON.stringify(trace).includes(projectRoot),'public evidence has relative paths and hashes, not raw content or host paths');
  assert.equal(services.taskService.runtime.countAll(),taskCount,'discussion read context must not create an execution Task');
  assert.ok(workspaceCalls.some(row=>row.method==='workspace.read'&&row.params.id===workspace.id));
  const ordinary=(await ui('ui.simulation.room.create',{title:'Ordinary role',scene:'free',goal:'No project access',workspaceId:workspace.id,
    roleIds:[saved.role.id],modelProvider:'simulation-fixture',model:'fixture'})).room;
  const readsBefore=workspaceCalls.length;
  const ordinaryReply=await sendRoom(ordinary.id,'Read docs/plan.md and .env','ordinary-no-implicit-read');
  assert.equal(workspaceCalls.length,readsBefore,'a Workspace id in a non-project room grants no implicit reads');
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)),/PROJECT_READ_PROOF_PLAN|PROJECT_READ_PROOF_README/);
  assert.equal(ordinaryReply.messages.findLast(row=>row.kind==='discussion').trace.workspaceContext,undefined);
  await sendRoom(project.id,'Read ../outside/outside.txt and outside-link/outside.txt and .env','project-read-denied-paths');
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)),/SIMULATION_PRIVATE_TOKEN|OUTSIDE_WORKSPACE_MUST_NOT_LEAK/);
  await sendRoom(project.id,'Read state/history.json and public-alias.txt','project-read-private-state');
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)),/PRIVATE_STORED_CHAT_MUST_NOT_LEAK|SIMULATION_PRIVATE_TOKEN/);
  for(const extension of ['pem','key','pfx','p12']){
    await sendRoom(project.id,'Read signing.'+extension,'project-private-extension-'+extension);
    assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)),/PRIVATE_KEY_EXTENSION_MUST_NOT_LEAK/);
  }
  assert.ok(!workspaceCalls.some(row=>row.method==='workspace.read'&&/\.(pem|key|pfx|p12)$/i.test(row.params.path)),'private key file formats are rejected before reading');
  const sanitized=await sendRoom(project.id,'Read assets.json and notes.txt','project-credential-excerpts');
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)),/QUOTED_JSON_(APIKEY|TOKEN|PASSWORD)_MUST_NOT_LEAK|TRUNCATED_PEM_BODY_MUST_NOT_LEAK/);
  assert.equal(sanitized.messages.findLast(row=>row.kind==='discussion').trace.workspaceContext.files.filter(row=>row.redacted).length,2,'quoted JSON secrets and a PEM block truncated before END must be visibly redacted');
  const partial=await sendRoom(project.id,'Inspect unused.txt','project-bounded-partial');
  const partialEvidence=partial.messages.findLast(row=>row.kind==='discussion').trace.workspaceContext.files.find(row=>row.path==='unused.txt');
  assert.equal(partialEvidence.truncated,true);assert.equal(partialEvidence.fileSha256,null);
  assert.ok(partialEvidence.nextOffset<=2048&&partialEvidence.excerptSha256.length===64);
  let releaseRead,readEntered;
  const entered=new Promise(resolve=>{readEntered=resolve;});const hold=new Promise(resolve=>{releaseRead=resolve;});
  services.workspaceService.execute=async request=>{if(request.method==='workspace.file.search'){readEntered();await hold;}return workspaceExecute(request);};
  const callsBeforeEdit=calls;
  await ui('ui.simulation.message.send',{roomId:project.id,text:'Inspect docs/plan.md','requestId':'project-scope-race'});
  await entered;
  const editing=(await ui('ui.simulation.room.get',{roomId:project.id})).room;
  await ui('ui.simulation.room.update',{roomId:project.id,expectedRev:editing.rev,workspaceId:null});
  releaseRead();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(calls,callsBeforeEdit,'unbinding the Workspace during context reads prevents the stale model call');
  assert.equal((await ui('ui.simulation.room.get',{roomId:project.id})).room.messages.filter(row=>row.kind==='discussion').length,partial.messages.filter(row=>row.kind==='discussion').length);
  assert.ok(!workspaceCalls.some(row=>row.method==='workspace.write'||row.method==='workspace.test.run'));
  await services.simulationService.close();
  const restarted=createSimulationService({stateDir:path.join(root,'state'),personaLibrary:createPersonaLibrary({stateDir:path.join(root,'state'),legacyRoots:[]}),modelRuntime:{chat:async()=>{throw Error('history reload must not invoke a model');}}});
  try{
    const history=(await restarted.execute({method:'simulation.room.get',params:{roomId:project.id}})).room;
    assert.deepEqual(history.messages.find(row=>row.id===inspected.messages.findLast(row=>row.kind==='discussion').id).trace.workspaceContext,trace,'file provenance survives service restart in the existing room store');
    assert.equal(calls,callsBeforeEdit,'loading saved provenance does not make another model request');
  }finally{await restarted.close();}
  console.log('PASS actual Core project discussion reads scoped file evidence; ordinary rooms, secrets, outside paths and execution stay isolated.');
  console.log('PASS Core → trusted UI → Model Runtime Simulation without QQ/DSH; no persona tool execution or duplicate request.');
} finally {
  await services.simulationService?.close();
  await Promise.all([services.chatService.close(),services.agentService.close(),services.extensionService.close(),services.pluginCenterService.close(),services.managedAgent.close(),services.channelService.close(),services.bionicService.close(),services.meshService.close(),services.integrationService.close(),services.autonomousHandoff.close()]);
  fs.rmSync(root,{recursive:true,force:true});
}
