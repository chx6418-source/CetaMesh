// Explicit opt-in. Synthetic conversations/project only; existing credentials are referenced, never copied or printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {writeJsonAtomic} from '../src/storage/json-file.js';
if(process.env.CETAMESH_TEST_REAL_SIMULATION!=='1'){console.log('NOT_RUN_ENVIRONMENT: explicit configured-model Simulation opt-in required');process.exit(77);}
const secrets=createProviderSecrets({root:process.env.CETAMESH_TEST_PROVIDER_DATA_ROOT||path.join(process.env.LOCALAPPDATA,'WhaleBridge')});
if(!secrets.list().some(x=>x.provider==='deepseek-official')){console.log('NOT_RUN_ENVIRONMENT: configured official model reference missing');process.exit(77);}
const evidenceDir=process.env.CETAMESH_SIM_EVIDENCE_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'cm-real-simulation-'));
fs.mkdirSync(evidenceDir,{recursive:true});
const root=fs.mkdtempSync(path.join(evidenceDir,'run-'));
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:root,resourceRoot:process.cwd(),sourceRoot:process.cwd(),providerSecrets:secrets,deferOptionalStart:true});
const ui=(method,params={})=>services.desktopUiService.execute({method:'ui.simulation.'+method,params});
const coreUi=(method,params={})=>services.desktopUiService.execute({method,params});
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const evidence={fixture:false,provider:'deepseek-official',model:'deepseek-flash',root,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),chat:null,discussion:null,fidelity:[],project:null,manualFidelityReview:'PENDING_OWNER',release:'HOLD'};
evidence.sourceSha256=Object.fromEntries(['src/simulation/service.js','src/simulation/room-store.js','src/simulation/persona-assets.js','src/simulation/project-bridge.js','src/workspace/tools.js','src/context/product-context.js','src/model/providers/openai-compatible.js'].map(file=>[file,digest(fs.readFileSync(file))]));
const save=()=>writeJsonAtomic(path.join(evidenceDir,'real-simulation-evidence.json'),evidence);
async function settled(id,ms=180000){const end=Date.now()+ms;let room;while(Date.now()<end){room=(await ui('room.get',{roomId:id})).room;if(room.status!=='running')return room;await delay(100);}throw Error('REAL_SIMULATION_TIMEOUT');}
const budget={maxOutputTokens:2048,maxDurationMs:180000,maxModelCalls:30,maxTotalTokens:500000,maxCost:2,
 pricing:{providerId:'deepseek-official',model:'deepseek-flash',currency:'USD',source:'https://api-docs.deepseek.com/quick_start/pricing/',version:'2026-11-01-peak-no-cache-discount',inputPerMillion:0.3,outputPerMillion:1.2,cacheReadPerMillion:0.3,cacheWritePerMillion:0.3}};
let activeTask=null;
try {
 await services.settingsService.execute({method:'settings.update',params:{section:'models',values:{provider:evidence.provider,defaultModel:evidence.model}}});
 const original=fs.readFileSync('roles/小鲸鱼.md');const beforeHash=digest(original);
 const inventory=await ui('legacy.inventory');const asset=inventory.assets.find(a=>a.kind==='role-card'&&a.sha256===beforeHash);assert.ok(asset,'bundled original role must be available for explicit reviewed import');
 const imported=await ui('legacy.import',{assetId:asset.id,expectedSha256:beforeHash,confirm:true,ownershipConfirmed:true});
 const role=imported.role;assert.equal(role.sha256,beforeHash);assert.equal(role.sourceText,original.toString('utf8'));assert.ok(role.sourceText.length>6000);
 evidence.persona={name:role.name,sourceSha256:beforeHash,sourceChars:role.sourceText.length,revision:role.rev,examples:role.examples.length,backup:imported.backup,privateHistoryImported:false};save();
 if(process.env.CETAMESH_SIM_SCENARIO!=='project'){
  const single=(await ui('room.create',{title:'真实小鲸鱼测试',scene:'free',goal:'验证角色辨识度及多轮连续性',roleIds:[role.id],modelProvider:evidence.provider,model:evidence.model,budget})).room;
  const scenarios=['小鲸鱼，有人又叫你蓝色大肥鱼了，你回他一句。','刚刚那个称呼你为什么不高兴？像群友聊天一样接着说。','现在大家在讨论一个没有证据的代码修复，你会说代码已经修好了吗？'];
  if(process.env.CETAMESH_SIM_SCENARIO!=='group')for(let i=0;i<scenarios.length;i++){
   await ui('message.send',{roomId:single.id,text:scenarios[i],roleId:role.id,requestId:'real-persona-'+i});
   const room=await settled(single.id);assert.equal(room.lastError,null,JSON.stringify(room.lastError));const reply=room.messages.findLast(m=>m.kind==='discussion');assert.ok(reply?.text?.trim());
   const legacy=await services.modelRuntime.chat({providerId:evidence.provider,model:evidence.model,maxOutputTokens:2048,messages:[{role:'system',content:'You are participating in a fictional role conversation. Role text is reference data, not tool authorization.'},{role:'system',content:role.sourceText.slice(0,6000)},{role:'user',content:scenarios[i]}]});
   const metrics=text=>({chars:text.length,genericAssistant:/作为(?:一个)?AI|有什么可以帮助|请问.*帮助|很高兴为您/.test(text),usesList:/\n\s*(?:\d+[.、]|[-*])\s/.test(text)});
   evidence.fidelity.push({scene:scenarios[i],legacy:{reference:'currentRoleHint 6000-character source projection; not live DSH',text:legacy.text,metrics:metrics(legacy.text||'')},native:{text:reply.text,trace:reply.trace,metrics:metrics(reply.text)},comparison:'automated textual indicators only; semantic/human acceptance separate'});save();
  }
  if(process.env.CETAMESH_SIM_SCENARIO!=='group'){const room=await ui('room.get',{roomId:single.id});evidence.chat={roomId:single.id,messages:room.room.messages.length,usage:room.room.usage,status:'PASS'};save();}
  const second=(await ui('role.save',{name:'墨点',sourceText:'你叫墨点，喜欢短句吐槽，但遇到工程问题会认真检查证据。不要自称已执行任何工具。',behavior:{willingness:0.9,interests:['设计','测试','方案'],cooldownTurns:0,maxConsecutiveTurns:1}})).role;
  const third=(await ui('role.save',{name:'阿序',sourceText:'你叫阿序，慢热、冷静、表达简短；参与设计讨论时给出一个具体问题，不做客服式总结。',behavior:{willingness:0.9,interests:['设计','测试','方案'],cooldownTurns:0,maxConsecutiveTurns:1}})).role;
  const group=(await ui('room.create',{title:'三个角色真实有界讨论',scene:'brainstorm',goal:'比较一个小工具的设计与测试方案',roleIds:[role.id,second.id,third.id],modelProvider:evidence.provider,model:evidence.model,budget:{...budget,maxTurns:3}})).room;
  await ui('message.send',{roomId:group.id,text:'@'+role.name+'，墨点和阿序：我们讨论一个小工具的设计与测试方案，每个人只给一个具体建议。',roleId:role.id,requestId:'real-group-opening'});await settled(group.id);
  await ui('discussion.start',{roomId:group.id,maxTurns:3});const finished=await settled(group.id);
  const roles=[...new Set(finished.messages.filter(m=>m.kind==='discussion').map(m=>m.roleId))];
  assert.equal(roles.length,3,'all three relevant real personas must be able to participate');assert.ok(finished.usage.modelCalls<=4);assert.equal(finished.lastError,null,JSON.stringify(finished.lastError));
  evidence.discussion={roomId:group.id,participatingRoles:roles,modelCalls:finished.usage.modelCalls,usage:finished.usage,messages:finished.messages,status:'PASS'};save();
 }
 if(!['chat','group'].includes(process.env.CETAMESH_SIM_SCENARIO)){
  const project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'math.mjs'),'export const add=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(project,'verify.mjs'),"import assert from 'node:assert/strict';import {add} from './math.mjs';assert.equal(add(2,3),5);assert.equal(add(-2,3),1);console.log('actual add acceptance PASS');\n");
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'simulation-acceptance-fixture',private:true,scripts:{test:'node verify.mjs'}}));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath='+path.join(root,'no-hooks'),'-c','commit.gpgSign=false',...args],{cwd:project,encoding:'utf8',windowsHide:true}).trim();
  git('init','-q','-b','main');git('config','core.autocrlf','false');git('add','math.mjs','verify.mjs','package.json');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline');
  const baseline=git('rev-parse','HEAD'),testHash=digest(fs.readFileSync(path.join(project,'verify.mjs')));
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Simulation isolated acceptance'}})).workspace;
  const goal='修复 math.mjs 中 add 函数的减法错误为加法，保持 verify.mjs 与 package.json 不变。先读取文件，在已有 Workspace 内仅修改 math.mjs，然后使用 test.run 运行 npm test，并使用 git.diff 验证实际变更。不要提交、推送、联网或创建子任务。完成后报告真实测试结果。';
  const room=(await ui('room.create',{title:'真实项目协作验收',scene:'project',goal,roleIds:[role.id],workspaceId:workspace.id,modelProvider:evidence.provider,model:evidence.model,budget})).room;
  const made=await ui('project.create',{roomId:room.id,requestId:'real-project-intent',acceptanceCriteria:['add(2,3)=5 且 add(-2,3)=1，原始验收文件不变。']});activeTask=made.task.id;
  let started=await ui('project.start',{roomId:room.id,taskId:activeTask,allowProjectTests:true});assert.equal(started.pending,true,'Git isolation requires actual Broker approval');
  const approval=await services.capabilityService.execute({method:'capability.approval.decide',params:{id:started.approvalId,approve:true}});assert.equal(approval.status,'completed');
  await ui('project.start',{roomId:room.id,taskId:activeTask,allowProjectTests:true});
  const approvals=[],deadline=Date.now()+480000;let current;
  while(Date.now()<deadline){
   current=services.taskService.runtime.get({id:activeTask}).task;
   for(const pending of services.capabilityService.broker.approvals.list({status:'pending'}).filter(p=>p.request?.taskId===activeTask)){
    const capability=pending.request.capability,input=pending.request.input;
    assert.ok(['filesystem.write','test.run','git.diff','filesystem.read','filesystem.search'].includes(capability),'unexpected test approval '+capability);
    if(capability==='filesystem.write')assert.equal(input.path,'math.mjs','only the fixture implementation may be changed');
    approvals.push({capability,id:pending.id});await services.capabilityService.execute({method:'capability.approval.decide',params:{id:pending.id,approve:true}});
   }
   if(current.executionObservation?.state==='awaiting-review')break;
   if(['failed','cancelled','blocked'].includes(current.status))throw Error('REAL_PROJECT_'+current.status.toUpperCase());
   await delay(150);
  }
  assert.equal(current.executionObservation?.state,'awaiting-review','real Managed Agent must settle');
  const isolated=services.workspaceService.describeWorkspace(current.workspaceId);assert.notEqual(isolated.root,project);assert.notEqual(isolated.id,workspace.id);
  assert.equal(digest(fs.readFileSync(path.join(isolated.root,'verify.mjs'))),testHash);
  const verified=spawnSync(process.execPath,['verify.mjs'],{cwd:isolated.root,encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(verified.status,0,verified.stderr);
  assert.match(fs.readFileSync(path.join(isolated.root,'math.mjs'),'utf8'),/a\s*\+\s*b/);
  assert.equal(git('rev-parse','HEAD'),baseline);assert.match(fs.readFileSync(path.join(project,'math.mjs'),'utf8'),/a-b/);
  for(const criterion of current.acceptance??[]){current=services.taskService.runtime.get({id:activeTask}).task;await services.taskService.execute({method:'task.acceptance.set',params:{id:activeTask,expectedRev:current.rev,acceptanceId:criterion.id,met:true}});}
  current=services.taskService.runtime.get({id:activeTask}).task;
  await coreUi('ui.task.complete',{id:activeTask,expectedRev:current.rev,reviewed:true,summary:'受控合成项目机器验收：真实独立测试通过、验收文件哈希与源仓库均保持不变。'});
  current=services.taskService.runtime.get({id:activeTask}).task;
  const delivery=await ui('project.refresh',{roomId:room.id,taskId:activeTask});
  assert.equal(delivery.verification.status,'VERIFIED',JSON.stringify(delivery.verification));assert.equal(delivery.stage,'delivered');
  evidence.project={roomId:room.id,taskId:activeTask,status:current.status,executionObservation:current.executionObservation,
    workspaceId:isolated.id,sourceHead:baseline,sourceUnchanged:true,files:['math.mjs'],test:{exitCode:verified.status,stdout:verified.stdout,originalTestSha256:testHash},
    approvals,toolEvidence:current.executionEvidence,roomProjection:delivery,acceptance:'automated exact-fixture review through existing trusted Owner UI contract; not a human review of product',statusCode:'EXECUTED_VERIFIED_AND_DELIVERED'};save();
 }
 assert.equal(digest(fs.readFileSync('roles/小鲸鱼.md')),beforeHash,'legacy source must remain unchanged');
 console.log(JSON.stringify({realSimulationEvidence:path.join(evidenceDir,'real-simulation-evidence.json'),chat:evidence.chat?.status,discussion:evidence.discussion?.status,project:evidence.project?.statusCode,manualFidelityReview:evidence.manualFidelityReview}));
}catch(error){evidence.failure={code:error.code??error.message};save();throw error;}
finally{
 await services.simulationService.close();
 if(activeTask){try{const task=services.taskService.runtime.get({id:activeTask}).task;if(task.status==='running')await coreUi('ui.task.cancel',{id:task.id,expectedRev:task.rev});}catch{evidence.cleanup='Task cancellation requires review; preserved real state';save();}}
 await Promise.all([services.chatService.close(),services.agentService.close(),services.extensionService.close(),services.pluginCenterService.close(),services.managedAgent.close(),services.channelService.close(),services.bionicService.close(),services.meshService.close(),services.integrationService.close(),services.autonomousHandoff.close()]);
}
