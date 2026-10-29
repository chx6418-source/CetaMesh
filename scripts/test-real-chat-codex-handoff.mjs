// Real ordinary Chat entrance; source Core + installed Codex, never Release Desktop.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {OWNER_ACTOR} from '../src/capability/types.js';
if(process.env.WHALEBRIDGE_TEST_REAL_CODEX!=='1'){console.log('NOT_RUN_ENVIRONMENT: real Codex opt-in required');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-real-chat-codex-'));let services,taskId,sessionId;
const evidence={fixture:false,entrance:'production Chat service (source Core, not Native WebView2)',approvals:[],history:[],verified:false};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
try{
 const project=path.join(root,'project');fs.mkdirSync(project);
 const files={'extension.mjs':'export const normalizeName = value => value;\n','verify.mjs':"import assert from 'node:assert/strict';import fs from 'node:fs';import {normalizeName} from './extension.mjs';assert.equal(normalizeName(' Example '),'example');for(const p of ['EXT-01.md','EXT-02.md']){const s=fs.readFileSync(p,'utf8');assert.ok(s.length>20);assert.match(s,/验收|acceptance/i);}console.log('EXTENSION_HANDOFF_VERIFIED');\n",'package.json':JSON.stringify({private:true,type:'module',scripts:{test:'node verify.mjs'}})};
 for(const [p,s]of Object.entries(files))fs.writeFileSync(path.join(project,p),s);
 for(const args of [['init','-q',project],['-C',project,'add','.'],['-C',project,'-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','synthetic baseline']])execFileSync('git',args,{stdio:'ignore'});
 services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),agentStagingRoot:path.join(root,'staging'),log:()=>{}});
 const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'GIT-QQ-BRIDGE synthetic Extension task'}})).workspace;
 await services.workspaceService.execute({method:'workspace.settings',params:{id:workspace.id,patch:{testCommand:'npm test'}}});
 const health=await services.agentBroker.health('codex');assert.equal(health.available,true);assert.equal(health.authenticated,true);evidence.readiness={available:health.available,authenticated:health.authenticated};
 const sec=await services.desktopUiService.execute({method:'ui.agent.security',params:{provider:'codex',workspaceId:workspace.id}});assert.equal(sec.security.strictIsolationVerified,false);assert.equal(sec.authorized,false);
 const consent=await services.desktopUiService.execute({method:'ui.agent.authorize',params:{provider:'codex',workspaceId:workspace.id,fingerprint:sec.fingerprint}});
 assert.equal(consent.status,'pending');await services.capabilityService.execute({method:'capability.approval.decide',params:{id:consent.approvalId,approve:true}});evidence.approvals.push('agent.execution.authorize');
 const session=await services.chatService.execute({method:'chat.sessions.create',params:{title:'Explicit Codex Extension handoff'}});sessionId=session.id;
 await services.chatService.execute({method:'chat.config.set',params:{id:sessionId,config:{workspaceId:workspace.id,agentProvider:null,modelProvider:'deepseek-official',model:'deepseek-flash',mode:'chat'}}});
 const goal='把本隔离工作区的插件（Extension）开发拆分为可独立执行的任务包。先创建 EXT-01.md 与 EXT-02.md，每包写目标、文件范围和验收标准。随后执行这两个小任务：第一包只修改 extension.mjs，使 normalizeName 返回 trim 后的小写字符串；第二包运行已有 npm test 并报告结果。只允许新增两个任务包与修改 extension.mjs，不修改 verify.mjs 和 package.json，不安装依赖、不提交、不联网，不改工作区外文件，交给 Codex 执行。';
 await services.chatService.execute({method:'chat.send',params:{id:sessionId,text:goal}});
 const approved=new Set();let state,task;
 const until=Date.now()+360000;
 while(Date.now()<until){
  const current=(await services.chatService.execute({method:'chat.sessions.list',params:{}})).sessions.find(s=>s.id===sessionId);taskId=current?.taskId;
  for(const a of services.capabilityService.broker.approvals.list()){
   if(a.status!=='pending'||a.request?.taskId!==taskId||approved.has(a.id))continue;
   assert.equal(a.request.capability,'workspace.apply','only exact staged import may be approved');
   for(const c of a.request.input.changes){assert.ok(['EXT-01.md','EXT-02.md','extension.mjs'].includes(c.path));assert.equal(c.action,'write');assert.ok(c.content.length<12000);}
   approved.add(a.id);await services.capabilityService.execute({method:'capability.approval.decide',params:{id:a.id,approve:true}});evidence.approvals.push('workspace.apply');
  }
  state=await services.desktopUiService.execute({method:'ui.chat.status',params:{id:sessionId}});
  if(taskId)task=services.taskService.runtime.get({id:taskId}).task;
  if(task&&['idle','error','failed','needs-reconciliation'].includes(state.state))break;
  await delay(100);
 }
 assert.ok(taskId,'ordinary Chat must create the authoritative Task');
 evidence.chatState=state.state;evidence.history=task.agentHistory.map(a=>a.provider);evidence.progress=task.progress;evidence.error=state.errorCode??null;
 assert.ok(evidence.history.length>0&&evidence.history.every(provider=>provider==='codex'),'explicit delegation must not execute development with Managed; same-provider recovery remains allowed');assert.equal(state.state,'idle');
 for(const p of ['verify.mjs','package.json'])assert.equal(sha(fs.readFileSync(path.join(project,p))),sha(files[p]));
 assert.deepEqual(execFileSync('git',['-C',project,'diff','--name-only'],{encoding:'utf8'}).trim().split(/\r?\n/),['extension.mjs']);
 const result=await services.capabilityService.broker.execute({actor:OWNER_ACTOR,taskId,workspaceId:workspace.id,capability:'test.run',input:{tool:'npm',args:['test'],timeoutMs:30000},reason:'Independent acceptance of the explicit Codex task packages'});
 assert.equal(result.status,'pending');const verified=await services.capabilityService.execute({method:'capability.approval.decide',params:{id:result.approvalId,approve:true}});evidence.approvals.push('test.run');assert.equal(verified.status,'completed');assert.equal(verified.result.exitCode,0);evidence.independentExitCode=verified.result.exitCode;
 const output=execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8',timeout:30000});assert.match(output,/EXTENSION_HANDOFF_VERIFIED/);
 const history=await services.desktopUiService.execute({method:'ui.chat.history',params:{id:sessionId}});assert.ok(history.messages.some(m=>m.role==='assistant'&&m.text));
 evidence.toolLabels=history.messages.flatMap(m=>m.toolActivity??[]).map(t=>t.label);assert.ok(evidence.toolLabels.some(n=>n.includes('Codex')||n.includes('codex')));
 const rt=services.taskService.runtime;
 task=rt.get({id:taskId}).task;
 const completed=await services.desktopUiService.execute({method:'ui.task.complete',params:{id:taskId,expectedRev:task.rev,reviewed:true,summary:'Owner independently verified Extension package files and unchanged acceptance test; npm test exit 0'}});
 assert.equal(completed.task.status,'completed');assert.equal(completed.task.progress.percent,100);evidence.taskStatus=completed.task.status;evidence.progress=completed.task.progress;
 evidence.hashes=Object.fromEntries(['EXT-01.md','EXT-02.md','extension.mjs'].map(p=>[p,sha(fs.readFileSync(path.join(project,p)))]));evidence.verified=true;console.log('PASS real ordinary Chat -> explicit Codex -> Extension task packages -> native execution -> approved import -> independent Core acceptance');
}catch(error){evidence.failure={code:error.code??error.name,message:String(error.message).slice(0,500)};process.exitCode=1;}
finally{
 console.log(JSON.stringify({acceptanceEvidence:evidence}));
 if(services){if(taskId){const t=services.taskService.runtime.get({id:taskId}).task;if(!['cancelled','completed','failed'].includes(t.status))try{await services.desktopUiService.execute({method:'ui.task.cancel',params:{id:taskId,expectedRev:t.rev}});}catch{}}
 await services.autonomousHandoff.close();await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.extensionService.close();}
 assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('cm-real-chat-codex-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
