// Explicit opt-in acceptance: real Managed Provider and real installed external Agent.
// The model proposes generic task needs; Core alone chooses the executor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {OWNER_ACTOR} from '../src/capability/types.js';

if(process.env.WHALEBRIDGE_TEST_REAL_MANAGED!=='1'||process.env.WHALEBRIDGE_TEST_REAL_CODEX!=='1'){
 console.log('NOT_RUN_ENVIRONMENT: explicit real Managed Provider and Codex opt-in required');process.exit(77);
}
const extensionPackages=process.env.CETAMESH_TEST_EXTENSION_PACKS==='1';
const allowedPaths=extensionPackages?['EXT-01.md','EXT-02.md','math.mjs']:['math.mjs'];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-real-auto-'));
let services,taskId,preflightId;
const evidence={fixture:false,diagnostics:[],modelProvider:null,modelRequests:0,proposalCalls:0,approvals:[],history:[],fileVerified:false,testExitCode:null};
const hash=content=>crypto.createHash('sha256').update(content).digest('hex');
async function waitFor(read,predicate,label,timeout=180000){const until=Date.now()+timeout;let value;
 while(Date.now()<until){value=await read();if(predicate(value))return value;await delay(100);}throw Error(label+' timed out');}
try {
 const credentialsRoot=process.env.CETAMESH_TEST_PROVIDER_DATA_ROOT||path.join(process.env.LOCALAPPDATA||os.homedir(),'WhaleBridge');
 const existingCredentials=createProviderSecrets({root:credentialsRoot});
 // Credentials remain inside the existing Provider service. No test file, output or fixture contains a copied key.
 const credentials=Object.freeze({list:()=>existingCredentials.list(),raw:provider=>existingCredentials.raw(provider)});
 services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),providerSecrets:credentials,log:message=>{if(message.startsWith('Automatic delegation state: '))evidence.diagnostics.push(message.slice('Automatic delegation state: '.length));}});
 const providerId=process.env.CETAMESH_TEST_MANAGED_PROVIDER||'deepseek-official';
 const provider=services.modelRegistry.require(providerId);
 const configured=services.modelRuntime.listProviders().find(row=>row.id===providerId);
 if(configured?.hasKey!==true){console.log('NOT_RUN_ENVIRONMENT: configured Managed Provider is unavailable');process.exitCode=77;}
 else {
 const model=process.env.CETAMESH_TEST_MANAGED_MODEL||provider.defaultModel;
 assert.ok(model,'A configured Managed model is required');evidence.modelProvider=providerId;evidence.model=model;
 const originalStream=services.modelRuntime.stream;
 services.modelRuntime.stream=async function*(request){evidence.modelRequests++;
  for await(const event of originalStream(request)){
   if(event.type==='assistant/tool-calls')evidence.proposalCalls+=(event.data?.toolCalls??[]).filter(call=>call.capabilityId==='agent.delegate.propose').length;
   yield event;
  }};
 const project=path.join(root,'project');fs.mkdirSync(project);
 const files={'math.mjs':'export const add = (a, b) => a - b;\n','verify.mjs':"import assert from 'node:assert/strict'; import {add} from './math.mjs'; assert.equal(add(3,4),7); assert.equal(add(-2,5),3); console.log('REAL_AUTO_VERIFIED_4217');\n",
  'package.json':JSON.stringify({name:'cetamesh-real-auto-fixture',private:true,type:'module',scripts:{test:'node verify.mjs'}})+'\n'};
 if(extensionPackages) files['verify.mjs'] += "import fs from 'node:fs';for(const p of ['EXT-01.md','EXT-02.md']){const s=fs.readFileSync(p,'utf8');assert.ok(s.length>20);assert.match(s,/验收|acceptance/i);}\n";
 for(const [file,content]of Object.entries(files))fs.writeFileSync(path.join(project,file),content);
 const protectedHashes=Object.fromEntries(['verify.mjs','package.json'].map(file=>[file,hash(fs.readFileSync(path.join(project,file)))]));
 for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','synthetic baseline']])execFileSync('git',args,{stdio:'ignore'});
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Real autonomous development acceptance'}})).workspace;
 const health=await services.agentBroker.health('codex');assert.equal(health.available,true,'Real Codex must be available');assert.equal(health.authenticated,true);
 const security=await services.desktopUiService.execute({method:'ui.agent.security',params:{provider:'codex',workspaceId:workspace.id}});
 assert.equal(security.security.strictIsolationVerified,false,'Native execution must be disclosed honestly');
 const consent=await services.desktopUiService.execute({method:'ui.agent.authorize',params:{provider:'codex',workspaceId:workspace.id,fingerprint:security.fingerprint}});
 await services.capabilityService.execute({method:'capability.approval.decide',params:{id:consent.approvalId,approve:true}});
 // Native readiness preflight is separate from the subsequent automatic executor choice.
 const preflight=await services.desktopUiService.execute({method:'ui.task.create',params:{workspaceId:workspace.id,agentProvider:'codex',goal:'Read math.mjs and reply PREFLIGHT_READY_4217. Do not modify files or run project code.'}});
 preflightId=preflight.task.id;
 const ready=await waitFor(()=>services.taskService.runtime.get({id:preflightId}).task,task=>task.executionObservation?.state==='awaiting-review'||['blocked','failed'].includes(task.status),'native readiness preflight');
 if(ready.progress?.note==='CODEX_SANDBOX_UNAVAILABLE'){console.log('NOT_RUN_ENVIRONMENT: native Codex sandbox refused the readiness preflight');process.exitCode=77;}
 else {
 assert.match(ready.checkpoint?.summary??'',/PREFLIGHT_READY_4217/);assert.equal((await services.agentBroker.health('codex')).sandboxCapable,true);
 await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:preflightId,expectedRev:ready.rev}});
 await services.agentBroker.closeSession(ready.currentAgent);
 const rt=services.taskService.runtime;
 const goal=extensionPackages?'把本隔离工作区的插件 Extension 开发拆分为两个独立任务包 EXT-01.md 和 EXT-02.md，任务包含修复 math.mjs 的加法与运行现有 npm test；每包包括目标、文件范围和验收标准。开发交给 Codex 执行，Managed 不要自己修改源码。Codex 返回后由你独立核对差异、运行 npm test，验收通过后交付。仅可修改 math.mjs 和新增两个任务包，verify.mjs 和 package.json 不得修改，不安装依赖、不提交、不联网。':'请安排一个合适的开发执行者修复本项目中失败的加法测试，再由你独立检查差异、运行 npm test 并交付真实结果。只允许修改 math.mjs；已有 verify.mjs 和 package.json 必须保持原样。由 Core 根据真实能力与授权选择执行者。';
 let task=rt.create({goal,workspaceId:workspace.id,acceptanceCriteria:[extensionPackages?'Unchanged verification passes; exactly the two Extension task packages and math.mjs are delivered.':'Unchanged verification script passes and only math.mjs is modified.']});taskId=task.id;
 task=rt.setModelConfig({id:taskId,expectedRev:task.rev,modelProvider:providerId,model});
 services.capabilityService.grantTask(taskId,{capabilities:['filesystem.read','filesystem.search','git.status','git.diff','workspace.apply','test.run','operation.read','operation.continue','memory.read','context.evidence.read']});
 await services.capabilityService.execute({method:'capability.operation.prepare',params:{taskId,workspaceId:workspace.id,operationId:'independent-verification',capability:'test.run',input:{tool:'npm',args:['test'],timeoutMs:30000}}});
 task=(await services.capabilityService.execute({method:'capability.delegation.authorize',params:{taskId,expectedRev:task.rev,policy:{expiresAt:Date.now()+600000,maxDelegations:1,allowUnknownCost:true,verification:{kind:'code-tests',operationId:'independent-verification',acceptanceIds:task.acceptance.map(row=>row.id),allowedPaths,unchangedFiles:Object.entries(protectedHashes).map(([path,sha256])=>({path,sha256}))}}}})).task;
 const started=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,taskId,workspaceId:workspace.id,capability:'agent.run',input:{agentProvider:'cetamesh',modelProvider:providerId,model,content:goal}});
 assert.equal(started.result?.accepted,true);
 const until=Date.now()+600000;const approved=new Set();let current;
 while(Date.now()<until){
  for(const approval of services.capabilityService.broker.approvals.list()){
   if(approval.status!=='pending'||approval.request?.taskId!==taskId||approved.has(approval.id))continue;
   const request=approval.request;
   if(request.capability==='workspace.apply'){
    assert.deepEqual(request.input.changes.map(change=>change.path).sort(),allowedPaths);assert.ok(request.input.changes.every(change=>change.action==='write'));
    assert.ok(request.input.changes[0].content.length<5000);
   }else if(request.capability==='test.run'){
    assert.equal(request.input.tool,'npm');assert.deepEqual(request.input.args,['test']);
    for(const [file,expected]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.join(project,file))),expected,'original test remains unchanged');
   }else throw Error('Unexpected approval capability '+request.capability);
   approved.add(approval.id);evidence.approvals.push(request.capability);
   await services.capabilityService.execute({method:'capability.approval.decide',params:{id:approval.id,approve:true}});
  }
  current=rt.get({id:taskId}).task;
  if(current.executionObservation?.state==='awaiting-review'&&!current.delegationProposal)break;
  if(['needs-review','verified','blocked','unknown'].includes(current.delegationProposal?.state)||['blocked','failed','cancelled','completed'].includes(current.status))break;
  await delay(100);
 }
 evidence.taskStatus=current.status;evidence.delegationState=current.delegationProposal?.state??null;evidence.delegationError=current.delegationProposal?.code??null;evidence.progressCode=current.progress?.note??null;
 evidence.history=current.agentHistory.map(row=>row.provider);evidence.selectedProvider=current.delegationProposal?.selectedProvider??null;evidence.proposedRequirements=current.delegationProposal?.intent?.requiredTools??null;
 evidence.toolEvidence=(current.executionEvidence??[]).map(row=>({capability:row.capability,status:row.status,source:row.source??null,exitCode:row.exitCode??null}));
 assert.ok(evidence.modelRequests>0,'Real Managed Provider must be called');assert.ok(evidence.proposalCalls>0,'Real model must propose generic delegation');
 assert.equal(current.delegationProposal?.selectedProvider,'codex','Core selected the eligible real Codex without a target in the user prompt');
 for(const [file,expected]of Object.entries(protectedHashes))assert.equal(hash(fs.readFileSync(path.join(project,file))),expected);
 const changed=execFileSync('git',['-C',project,'diff','--name-only'],{encoding:'utf8'}).trim().split(/\r?\n/);assert.deepEqual(changed,['math.mjs']);
 const output=execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8',timeout:30000});assert.match(output,/REAL_AUTO_VERIFIED_4217/);evidence.fileVerified=true;
 assert.deepEqual(evidence.history,['cetamesh','codex','cetamesh']);
 assert.equal(evidence.delegationState,'verified','Owner machine contract must complete only after actual evidence checks');
 assert.equal(current.status,'completed');evidence.extensionPackages=extensionPackages;if(extensionPackages)evidence.packageHashes=Object.fromEntries(['EXT-01.md','EXT-02.md'].map(p=>[p,hash(fs.readFileSync(path.join(project,p)))]));
 evidence.verification=current.delegationProposal?.verification??null;
 const test=(current.executionEvidence??[]).findLast(row=>row.capability==='test.run'&&row.status==='completed');assert.equal(test?.exitCode,0,'Managed must independently execute the prepared test via Core');evidence.testExitCode=test.exitCode;
 console.log('PASS REAL: actual Managed Provider -> Core choice -> real Codex edit -> approved import -> Managed independent test and truthful delivery');
 }
 }
} catch(error){evidence.failure={code:error?.code??error?.name??'ACCEPTANCE_FAILED',message:String(error?.message??'failure').slice(0,500)};process.exitCode=1;}
finally{
 console.log(JSON.stringify({acceptanceEvidence:evidence}));
 if(process.env.CETAMESH_TEST_EVIDENCE_FILE)fs.writeFileSync(process.env.CETAMESH_TEST_EVIDENCE_FILE,JSON.stringify(evidence,null,2)+'\n');
 if(services){for(const id of [taskId,preflightId].filter(Boolean)){const task=services.taskService.runtime.get({id}).task;
  if(!['cancelled','completed','failed'].includes(task.status))try{await services.desktopUiService.execute({method:'ui.task.cancel',params:{id,expectedRev:task.rev}});}catch{}}
  await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}
 assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('cetamesh-real-auto-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
