// Owned synthetic peer for the observed legacy roster and dsh-v0.2.2-rc.1 read contract.
// Interface evidence: upstream packages/preset/agent-preset-registry/src/{types,index}.ts
// at 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db. No upstream implementation is vendored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createDshCoreConnector } from '../../src/agent/dsh-core-connector.js';
import { createDshConfiguration } from '../../src/agent/dsh-configuration.js';
import { createDshPresetPolicy, inspectDshPresetContent } from '../../src/agent/dsh-preset-policy.js';
import { createDshAgentProvider } from '../../src/agent/dsh-agent-provider.js';
import { createStagedDshAgentProvider } from '../../src/agent/staged-dsh-agent-provider.js';
import { createDesktopUiService } from '../../src/desktop/ui-service.js';
import { createStagingWorkspace } from '../../src/workspace/staging.js';

const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cetamesh-dsh-native-presets-'));
const home=path.join(root,'home');
const persona='- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: "Owned synthetic fixture, never a model instruction."\n';
fs.mkdirSync(path.join(home,'.agent-presets','local-coding'),{recursive:true});
fs.writeFileSync(path.join(home,'.agent-presets','local-coding','agent.cordis.yml'),persona);
let legacyRoster=false,readMode='valid',brokenValue='fixture activation failure';const calls=[];
const server=http.createServer(async(request,response)=>{
 let raw='';for await(const chunk of request)raw+=chunk;
 const message=JSON.parse(raw),endpoint=request.url.slice('/api/'.length),args=message.payload?.args??{};
 calls.push({endpoint,args});let value={};
 if(endpoint==='agentPresets/list')value={presets:[{id:'standard',isDefault:true,...(legacyRoster?{trust:'system'}:{})},{id:'local-coding',isDefault:false},{id:'broken-native',isDefault:false,broken:brokenValue}]};
 if(endpoint==='agentPresets/read')value={agentPreset:readMode==='mismatch'?'another-preset':args.agentPreset,
  content:readMode==='invalid'?'not: a-preset':readMode==='empty'?persona.replace('"Owned synthetic fixture, never a model instruction."','""'):readMode==='shadow'?persona.replace('Owned synthetic fixture, never a model instruction.','Different backend composition, never a model instruction.'):persona};
 if(endpoint==='session/list')value={items:[]};
 if(endpoint==='session/modelCatalog')value={default:{provider:'fixture-model',model:'fixture'},routableProviders:['fixture-model'],groups:[{id:'fixture-model',name:'Synthetic',models:[{id:'fixture',name:'Synthetic'}]}],failures:[]};
 if(endpoint==='session/create')value={sessionId:'synthetic-created'};
 response.writeHead(200,{'content-type':'application/json'});
 response.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl='http://127.0.0.1:'+server.address().port;
try{
 let scopeCase=0;
 async function rejectsDifferentHome(pinned,candidate){
  for(const authenticated of [false,true]){
   let nativeReads=0;
   const configuration=createDshConfiguration({legacy:{homeDir:pinned,baseUrl,authCookie:authenticated?'synthetic-private-cookie':null},
    stateDir:path.join(root,`scope-${++scopeCase}`),env:{}});
   configuration.bindNativePresets({list(local){nativeReads++;return local;},async inspect(){nativeReads++;return {compatible:true};}});
   await configuration.listPresets({homeDir:candidate});
   assert.equal(nativeReads,0,'another home cannot borrow the pinned native catalog');
   await assert.rejects(async()=>configuration.configure({homeDir:candidate,codingPreset:'standard'}),
    {code:authenticated?'DSH_AUTH_SCOPE_CHANGE_REQUIRES_REVIEW':'DSH_PRESET_INCOMPATIBLE'});
   assert.equal(nativeReads,0,'another home cannot borrow native validation or credentials');
   assert.equal(configuration.describe().revision,0);
  }
 }
 const otherHome=path.join(root,'other-home');fs.mkdirSync(otherHome);
 await rejectsDifferentHome(home,otherHome);
 const caseRoot=path.join(root,'case-distinct');fs.mkdirSync(caseRoot);
 if(process.platform==='win32'){
  // Only this owned temporary directory is changed; no volume or global setting.
  spawnSync('fsutil.exe',['file','setCaseSensitiveInfo',caseRoot,'enable'],{windowsHide:true,timeout:2000,stdio:'pipe'});
 }
 const upperHome=path.join(caseRoot,'Home'),lowerHome=path.join(caseRoot,'home');
 fs.mkdirSync(upperHome,{recursive:true});fs.mkdirSync(lowerHome,{recursive:true});
 const upperStat=fs.statSync(upperHome,{bigint:true}),lowerStat=fs.statSync(lowerHome,{bigint:true});
 if(upperStat.dev!==lowerStat.dev||upperStat.ino!==lowerStat.ino){
  await rejectsDifferentHome(upperHome,lowerHome);
  console.log('PASS case-distinct real directory identities cannot share native catalog, validation or credentials');
 }else console.log('NOT_RUN_ENVIRONMENT case-distinct directory subcase: this filesystem did not enable case-sensitive names');
 const aliasHome=path.join(root,'home-alias');
 fs.symlinkSync(home,aliasHome,process.platform==='win32'?'junction':'dir');
 await rejectsDifferentHome(home,aliasHome);
 const concurrent=createDshConfiguration({legacy:{homeDir:home,baseUrl},stateDir:path.join(root,'concurrent'),env:{}});
 let finishValidation;
 concurrent.bindNativePresets({inspect:()=>new Promise(resolve=>{finishValidation=resolve;})});
 const staleSave=concurrent.configure({codingPreset:'standard'});
 const currentSave=concurrent.configure({codingPreset:null});
 finishValidation({compatible:true,verification:'native-persona-only'});
 await assert.rejects(staleSave,{code:'DSH_CONFIG_CONFLICT'});
 assert.equal(concurrent.describe().revision,currentSave.configuration.revision,'async native validation cannot overwrite the newer save');
 assert.equal(concurrent.describe().pending.codingPreset,null);
 const project=path.join(root,'close-project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'proof.txt'),'owned close fixture');
 let enterValidation,releaseValidation;
 const validationEntered=new Promise(resolve=>{enterValidation=resolve;}),validationGate=new Promise(resolve=>{releaseValidation=resolve;});
 const closeCalls=[],stages=[];
 const closeApi={async *openRemoteStream(){},async callEndpoint(endpoint){
  closeCalls.push(endpoint);
  if(endpoint==='session/create')return {sessionId:'owned-close-fixture'};
  if(endpoint==='session/list')return {items:[{sessionId:'owned-close-fixture',running:false}]};
  return {};
 }};
 const closeNative=createDshAgentProvider({api:closeApi,presetPolicy:createDshPresetPolicy({coding:'local-coding',dshHome:home,nativePresets:{async inspect(){
  enterValidation();await validationGate;return {...inspectDshPresetContent(persona,'native-persona-only'),loaded:true};
 }}})});
 const closingStaged=createStagedDshAgentProvider({provider:closeNative,stagingRoot:path.join(root,'close-stages'),
  createStage:async options=>{const stage=await createStagingWorkspace(options);stages.push(stage);return stage;},
  resolveTaskWorkspace:()=>({task:{id:'close-task',workspaceId:'close-workspace'},workspace:{id:'close-workspace',root:project}}),
  applyChanges:async()=>({status:'completed'})});
 const lateCreation=closingStaged.createSession({taskId:'close-task',workspaceId:'close-workspace'});
 lateCreation.catch(()=>{});
 await validationEntered;
 const closing=closingStaged.shutdown();closing.catch(()=>{});
 releaseValidation();await closing;
 await assert.rejects(lateCreation,{code:'PROVIDER_SHUTTING_DOWN'},'close fences a pending verified-preset read before any remote creation');
 assert.equal(closeCalls.includes('session/create'),false);assert.equal(closeCalls.includes('session/modelCatalog'),false);
 assert.equal(closingStaged._sessions.size,0);assert.ok(stages.every(stage=>!fs.existsSync(stage.root)));
 await assert.rejects(closingStaged.createSession({taskId:'close-task',workspaceId:'close-workspace'}),{code:'PROVIDER_SHUTTING_DOWN'});
 await assert.rejects(closeNative.createSession({purpose:'coding'}),{code:'PROVIDER_SHUTTING_DOWN'});
 for(const uncertain of [false,'running','missing','duplicate']){
  let enterCreate,releaseCreate;
  const createEntered=new Promise(resolve=>{enterCreate=resolve;}),createGate=new Promise(resolve=>{releaseCreate=resolve;});
  const id=`owned-late-${uncertain}`,remoteCalls=[],remoteStages=[];let visible=uncertain!=='missing',running=uncertain==='running',duplicate=uncertain==='duplicate';
  const remoteApi={async *openRemoteStream(){},async callEndpoint(endpoint,args){
   remoteCalls.push({endpoint,args});
   if(endpoint==='session/create'){enterCreate();await createGate;return {sessionId:id};}
   if(endpoint==='session/list')return {items:[{sessionId:'unrelated-user-session',running:true},...(visible?[{sessionId:id,running}]:[]),...(duplicate?[{sessionId:id,running:true}]:[])]};
   return {};
  }};
  const remoteNative=createDshAgentProvider({api:remoteApi});
  const remoteStaged=createStagedDshAgentProvider({provider:remoteNative,stagingRoot:path.join(root,`remote-close-${uncertain}`),
   createStage:async options=>{const stage=await createStagingWorkspace(options);remoteStages.push(stage);return stage;},
   resolveTaskWorkspace:()=>({task:{id:'close-task',workspaceId:'close-workspace'},workspace:{id:'close-workspace',root:project}}),applyChanges:async()=>({status:'completed'})});
  const pending=remoteStaged.createSession({taskId:'close-task',workspaceId:'close-workspace'});pending.catch(()=>{});
  await createEntered;const stopped=remoteStaged.shutdown();stopped.catch(()=>{});releaseCreate();
  await assert.rejects(pending,{code:'PROVIDER_SHUTTING_DOWN'},'an already-dispatched remote creation can never return Ready after close');
  assert.equal(remoteCalls.some(row=>row.endpoint==='session/modelCatalog'),false);
  if(uncertain){
   await assert.rejects(stopped,{code:'PROVIDER_CLOSE_UNKNOWN'});
   assert.equal(remoteStaged._sessions.size,1);assert.equal(remoteNative._unclaimedSessions.has(id),true);
   assert.ok(remoteStages.every(stage=>fs.existsSync(stage.root)),'stop uncertainty retains stage and exact Session ownership');
   visible=true;running=false;duplicate=false;await remoteStaged.shutdown();
  }else await stopped;
  assert.equal(remoteStaged._sessions.size,0);assert.equal(remoteStaged._pendingCreations.size,0);
  assert.ok(remoteStages.every(stage=>!fs.existsSync(stage.root)));
  assert.ok(remoteCalls.filter(row=>['session/cancel','workspace/archiveSession'].includes(row.endpoint)).every(row=>row.args.request.sessionId===id),'cleanup never cancels or archives an unrelated user Session');
 }
 let enterBounded,releaseBounded;
 const boundedEntered=new Promise(resolve=>{enterBounded=resolve;}),boundedGate=new Promise(resolve=>{releaseBounded=resolve;});
 const boundedStages=[],boundedCalls=[];
 const boundedNative=createDshAgentProvider({shutdownTimeoutMs:40,api:{async *openRemoteStream(){},async callEndpoint(endpoint){boundedCalls.push(endpoint);return {};}},
  presetPolicy:{inspect:()=>({compatible:true,id:'local-coding'}),async requireVerified(){enterBounded();await boundedGate;return 'local-coding';}}});
 const boundedStaged=createStagedDshAgentProvider({provider:boundedNative,shutdownTimeoutMs:40,stagingRoot:path.join(root,'bounded-close'),
  createStage:async options=>{const stage=await createStagingWorkspace(options);boundedStages.push(stage);return stage;},
  resolveTaskWorkspace:()=>({task:{id:'close-task',workspaceId:'close-workspace'},workspace:{id:'close-workspace',root:project}}),applyChanges:async()=>({status:'completed'})});
 const boundedCreation=boundedStaged.createSession({taskId:'close-task',workspaceId:'close-workspace'});boundedCreation.catch(()=>{});
 await boundedEntered;await assert.rejects(boundedStaged.shutdown(),{code:'PROVIDER_CLOSE_UNKNOWN'});
 assert.equal(boundedStaged._pendingCreations.size,1);assert.ok(boundedStages.every(stage=>fs.existsSync(stage.root)));
 releaseBounded();await assert.rejects(boundedCreation,{code:'PROVIDER_SHUTTING_DOWN'});
 await new Promise(setImmediate);await boundedStaged.shutdown();
 assert.equal(boundedCalls.length,0);assert.ok(boundedStages.every(stage=>!fs.existsSync(stage.root)));
 let ackStopped=false;
 const ackStages=[];
 const ackOnly=createStagedDshAgentProvider({provider:{id:'owned-ack-leaf',label:'Owned zero-model leaf',capabilities:()=>({}),async *follow(){},async createSession(){return {sessionId:'owned-ack'};},async closeSession(){return {closed:true,stopped:ackStopped};}},
  stagingRoot:path.join(root,'ack-only-close'),createStage:async options=>{const stage=await createStagingWorkspace(options);ackStages.push(stage);return stage;},
  resolveTaskWorkspace:()=>({task:{id:'close-task',workspaceId:'close-workspace'},workspace:{id:'close-workspace',root:project}}),applyChanges:async()=>({status:'completed'})});
 const ackSession=await ackOnly.createSession({taskId:'close-task',workspaceId:'close-workspace'});
 await assert.rejects(ackOnly.closeSession(ackSession),{code:'PROVIDER_CLOSE_UNKNOWN'});
 assert.equal(ackOnly._sessions.size,1);assert.ok(ackStages.every(stage=>fs.existsSync(stage.root)),'a close ACK alone never removes staging');
 ackStopped=true;await ackOnly.closeSession(ackSession);await ackOnly.shutdown();
 assert.equal(ackOnly._sessions.size,0);assert.ok(ackStages.every(stage=>!fs.existsSync(stage.root)));
 const idCalls=[];let nativeCreateCount=0;
 const idNative=createDshAgentProvider({api:{async *openRemoteStream(){},async callEndpoint(endpoint,args){
  idCalls.push({endpoint,args});
  if(endpoint==='session/create')return {sessionId:++nativeCreateCount<=2?'owned-existing-A':'owned-unique-B'};
  if(endpoint==='session/selectModel')return {selected:{provider:args.request.provider,model:args.request.model}};
  if(endpoint==='session/modelCatalog')return {default:{provider:'fixture-id',model:'model-a'},routableProviders:['fixture-id'],groups:[{id:'fixture-id',models:[{id:'model-a'},{id:'model-b'}]}],failures:[]};
  if(endpoint==='session/list')return {items:[{sessionId:'owned-existing-A',running:false},{sessionId:'owned-unique-B',running:false}]};
  return {};
 }}});
 const idA=await idNative.createSession({modelProvider:'fixture-id',model:'model-a'});
 const configurationA=(await idNative.status(idA)).modelControl;
 const beforeConflict=idCalls.length;
 await assert.rejects(idNative.createSession({modelProvider:'fixture-id',model:'model-b'}),error=>error.code==='DSH_SESSION_ID_CONFLICT'&&error.sessionId===undefined,'raw duplicate create identity is rejected before rebinding or cleanup of A');
 assert.equal(idCalls.slice(beforeConflict).some(row=>['session/selectModel','session/prompt','session/cancel','workspace/archiveSession'].includes(row.endpoint)),false);
 assert.deepEqual((await idNative.status(idA)).modelControl,configurationA,'A retains its confirmed model binding');
 assert.equal(idNative._pendingCreations.size,1,'the conflicting remote create outcome stays owned without borrowing A identity');
 const uniqueNative=await idNative.createSession({modelProvider:'fixture-id',model:'model-b'});
 assert.equal(uniqueNative.sessionId,'owned-unique-B');assert.equal(uniqueNative.model,'model-b');
 await assert.rejects(idNative.shutdown(),{code:'PROVIDER_CLOSE_UNKNOWN'});
 assert.equal(idCalls.some(row=>['session/cancel','workspace/archiveSession'].includes(row.endpoint)),false,'shutdown of the unidentified conflict does not cancel A');
 const duplicateStages=[],duplicateCalls=[];let duplicateCreateCount=0;
 const duplicateStaged=createStagedDshAgentProvider({provider:{id:'owned-duplicate-leaf',label:'Owned zero-model duplicate fixture',capabilities:()=>({}),async *follow(){},
  async createSession(){duplicateCalls.push('create');return {sessionId:++duplicateCreateCount<=2?'staged-existing-A':'staged-unique-B'};},
  async closeSession({sessionId}){duplicateCalls.push(`close:${sessionId}`);return {closed:true,stopped:true};}},
  stagingRoot:path.join(root,'duplicate-id-stages'),createStage:async options=>{const stage=await createStagingWorkspace(options);duplicateStages.push(stage);return stage;},
  resolveTaskWorkspace:({taskId})=>({task:{id:taskId,workspaceId:'close-workspace'},workspace:{id:'close-workspace',root:project}}),applyChanges:async()=>({status:'completed'})});
 const stagedA=await duplicateStaged.createSession({taskId:'task-A',workspaceId:'close-workspace'});
 const ownedA=duplicateStaged._sessions.get(stagedA.sessionId),stageA=ownedA.stage;
 const contentsA=fs.readFileSync(path.join(stageA.root,'proof.txt'),'utf8');
 await assert.rejects(duplicateStaged.createSession({taskId:'task-B-conflict',workspaceId:'close-workspace'}),error=>error.code==='DSH_SESSION_ID_CONFLICT'&&error.sessionId===undefined,'staged duplicate create identity cannot inherit or close Task A');
 assert.equal(duplicateStaged._sessions.get(stagedA.sessionId),ownedA);assert.equal(ownedA.taskId,'task-A');assert.equal(ownedA.stage,stageA);
 assert.equal(fs.readFileSync(path.join(stageA.root,'proof.txt'),'utf8'),contentsA);
 assert.equal(duplicateCalls.filter(row=>row.startsWith('close:')).length,0);
 assert.ok(fs.existsSync(duplicateStages[1].root));
 assert.equal([...duplicateStaged._pendingCreations].some(row=>row.stage===duplicateStages[1]&&row.sessionId===null),true,'B stage stays attached to unknown creation ownership');
 const stagedUnique=await duplicateStaged.createSession({taskId:'task-B-unique',workspaceId:'close-workspace'});
 assert.equal(stagedUnique.sessionId,'staged-unique-B');assert.equal(duplicateStaged._sessions.get(stagedUnique.sessionId).taskId,'task-B-unique');
 await assert.rejects(duplicateStaged.shutdown(),{code:'PROVIDER_CLOSE_UNKNOWN'});
 assert.ok(fs.existsSync(duplicateStages[1].root),'unknown B stage survives shutdown even after other owned Sessions stop');
 console.log('PASS DSH close fences, owned late remote creation, unconfirmed-stop retention, bounded shutdown/retry and first-create positive loop');
 for(const legacy of [true,false]){
  legacyRoster=legacy;readMode='valid';
  const stateDir=path.join(root,legacy?'legacy':'current');
  const options={config:{dsh:{homeDir:home,baseUrl,authCookie:'synthetic-private-cookie'}},stateDir,env:{}};
  if(process.platform==='win32'){
   const caseHome=path.join(path.dirname(home),'HOME');
   const actual=fs.statSync(home,{bigint:true}),variant=fs.statSync(caseHome,{bigint:true});
   assert.ok(actual.dev!==0n&&actual.ino!==0n&&actual.dev===variant.dev&&actual.ino===variant.ino,'the Windows positive fixture is the same real directory');
   for(const authenticated of [false,true]){
    const caseConnector=createDshCoreConnector({...options,stateDir:path.join(root,`case-${legacy}-${authenticated}`)});
    const caseConfiguration=authenticated?caseConnector.configuration:createDshConfiguration({legacy:{homeDir:home,baseUrl},stateDir:path.join(root,`case-auto-auth-${legacy}`),env:{}});
    if(!authenticated)caseConfiguration.bindNativePresets(caseConnector.presetConfig.nativePresets);
    const caseCatalog=await caseConfiguration.listPresets({homeDir:caseHome});
    assert.equal(caseCatalog.presets.some(row=>row.id==='standard'&&row.compatible),true,'case-only spelling of the same real Windows home retains native discovery');
    const savedCase=await caseConfiguration.configure({homeDir:caseHome,codingPreset:'standard'});
    assert.equal(savedCase.configuration.pending.codingPreset,'standard','same-directory casing preserves native validation and pinned credentials');
   }
  }
  const connector=createDshCoreConnector(options);
  const ui=createDesktopUiService({services:{agentService:{execute:({method,params})=>{
   assert.equal(method,'agent.presets.list');return connector.configuration.listPresets(params);
  }}}});
  const catalog=await ui.execute({method:'ui.agent.presets',params:{provider:'dsh'}});
  assert.equal(catalog.presets.find(row=>row.id==='standard')?.compatible,true,'registered native documents use the same persona parser even without local files or trust metadata');
  assert.equal(catalog.presets.find(row=>row.id==='standard')?.verification,'native-persona-only','the Owner selector receives the exact verification class');
  assert.equal(catalog.presets.find(row=>row.id==='broken-native')?.compatible,false);
  assert.equal(connector.configuration.active.codingPreset,null,'discovery never selects the DSH default for the Owner');
  const saved=await connector.configuration.configure({codingPreset:'standard'});
  assert.equal(saved.applied,false);assert.equal(saved.restartRequired,true);
  assert.equal(connector.configuration.active.codingPreset,null);
  assert.equal(saved.configuration.pending.codingPreset,'standard');
  assert.doesNotMatch(fs.readFileSync(path.join(stateDir,'dsh-connector.json'),'utf8'),/synthetic-private-cookie/);
  const restored=createDshCoreConnector(options);
  assert.equal(restored.configuration.active.codingPreset,'standard');
  const provider=createDshAgentProvider({api:restored.api,presetPolicy:createDshPresetPolicy(restored.presetConfig)});
  const health=await provider.health();
  assert.equal(health.preset.compatible,true);assert.equal(health.preset.loaded,true);
  assert.equal(health.preset.verification,'native-persona-only');
  const staged=createStagedDshAgentProvider({provider,resolveTaskWorkspace:()=>{throw Error('native policy must be checked before Task access');},applyChanges:async()=>({status:'completed'})});
  const stagedHealth=await staged.health();
  assert.equal(stagedHealth.taskEligible,false,'native persona/schema compatibility does not verify the Shell/tool boundary');
  assert.equal(stagedHealth.reason,'native-tool-policy-unverified');
  await assert.rejects(staged.createSession({taskId:'fixture-task',workspaceId:'fixture-workspace'}),{code:'AGENT_BOUNDARY_UNSUPPORTED'});
  await staged.shutdown();
  const revision=restored.configuration.describe().revision;
  for(const mode of ['mismatch','invalid','empty']){
   readMode=mode;
   await assert.rejects(async()=>restored.configuration.configure({codingPreset:'standard'}),{code:'DSH_PRESET_INCOMPATIBLE'});
   assert.equal(restored.configuration.describe().revision,revision);
  }
  readMode='valid';
  await assert.rejects(async()=>restored.configuration.configure({codingPreset:'broken-native'}),{code:'DSH_PRESET_INCOMPATIBLE'});
  for(const invalidBroken of [false,null]){
   brokenValue=invalidBroken;
   const malformed=await provider.health();
   assert.equal(malformed.ready,false,'broken is an optional string, never a permissive boolean/null flag');
   assert.equal(malformed.reason,'native-preset-discovery-unavailable','malformed rows are a protocol failure rather than an activation failure');
  }
  brokenValue='fixture activation failure';
  await restored.configuration.configure({codingPreset:'local-coding'});
  const local=createDshCoreConnector(options);
  const localProvider=createDshAgentProvider({api:local.api,presetPolicy:createDshPresetPolicy(local.presetConfig)});
  assert.equal((await localProvider.health()).preset.verification,'local-persona-only');
  const localStaged=createStagedDshAgentProvider({provider:localProvider,resolveTaskWorkspace:()=>{throw Error('unused fixture Task resolver');},applyChanges:async()=>({status:'completed'})});
  readMode='shadow';
  const beforeShadow=calls.filter(row=>row.endpoint==='session/create').length;
  const shadowHealth=await localStaged.health();
  assert.equal(shadowHealth.taskEligible,false,'a local same-ID preset cannot authorize a different backend composition');
  assert.equal(shadowHealth.reason,'native-preset-document-mismatch');
  await assert.rejects(localProvider.createSession({purpose:'coding',requireLocalPreset:true}),{code:'DSH_PRESET_INCOMPATIBLE'});
  assert.equal(calls.filter(row=>row.endpoint==='session/create').length,beforeShadow,'the final create boundary rechecks the backend document without creating a Session');
  readMode='valid';
  assert.equal((await localStaged.health()).taskEligible,true,'matching local/backend documents retain the existing local preset loop');
  await localProvider.createSession({purpose:'coding'});
  assert.equal(calls.filter(row=>row.endpoint==='session/create').at(-1).args.request.agentPreset,'local-coding','the existing explicitly selected local preset loop stays usable');
  await localProvider.shutdown();
 }
 assert.equal(calls.filter(row=>row.endpoint==='session/create').length,2,'native schema discovery and configuration never create a native Session');
 assert.ok(calls.every(row=>['settings/describe','session/list','session/modelCatalog','agentPresets/list','agentPresets/read','session/create'].includes(row.endpoint)));
 console.log('PASS legacy/current native preset discovery, exact document identity, Owner selection persistence, native tool refusal and existing local preset loop');
}finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
