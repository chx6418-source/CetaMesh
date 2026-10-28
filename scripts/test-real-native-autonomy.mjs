// Opt-in: built Desktop + Core, actual WebView2 bridge, real Managed Provider and Codex.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {openNativeProduct,nativeGoal,sha256,until} from './helpers/native-product-session.mjs';
import {readJsonFile,writeJsonAtomic} from '../src/storage/json-file.js';
import {loadReleaseVersion,releaseArtifactDirectory} from '../src/release/version.js';
if(process.platform!=='win32'||process.env.WHALEBRIDGE_TEST_NATIVE_PRODUCT!=='1'||process.env.WHALEBRIDGE_TEST_REAL_MANAGED!=='1'||process.env.WHALEBRIDGE_TEST_REAL_CODEX!=='1'){console.log('NOT_RUN_ENVIRONMENT: explicit real native product/Managed/Codex opt-ins required');process.exit(77);}
const packagedDir=process.env.CETAMESH_NATIVE_RC_DIR||releaseArtifactDirectory({rootDir:process.cwd(),...loadReleaseVersion({rootDir:process.cwd()})});
const scenario=process.env.CETAMESH_NATIVE_SCENARIO||'complete';assert.ok(['complete','cancel'].includes(scenario));
let session,evidence;
try{
 session=await openNativeProduct({packagedDir,shellOverride:process.env.CETAMESH_NATIVE_SHELL||null,onReady:async ready=>{
  if(process.env.CETAMESH_NATIVE_READY_FILE)writeJsonAtomic(process.env.CETAMESH_NATIVE_READY_FILE,{executable:ready.executable,pid:ready.pid,root:ready.root,data:ready.data,sourceCommit:ready.evidence.sourceCommit});
  if(process.env.CETAMESH_NATIVE_GO_FILE)await until(()=>fs.existsSync(process.env.CETAMESH_NATIVE_GO_FILE),Boolean,'test coordinator native-window observation',45000);
 }});evidence=session.evidence;
 const {evaluate,click,fill,task,project,data}=session;
 // Ordinary navigation remains production UI. Count it separately from the eight Round5 task controls.
 await until(()=>evaluate('!!document.querySelector(".harbor-shell")'),Boolean,'production native application rendered');
 if(!(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="新建任务")'))){
  await evaluate('(()=>{const b=Array.from(document.querySelectorAll("button,a")).find(b=>b.getAttribute("aria-label")==="Work");if(!b)throw Error("Work navigation missing");b.click();})()');evidence.navigationActions=['Work'];
 }
 await click('新建任务');await until(()=>evaluate('!!document.querySelector("textarea[aria-label=\\"任务目标\\"]")'),Boolean,'native task form');
 await fill('任务目标',nativeGoal);
 if(process.env.CETAMESH_NATIVE_MANUAL_WORKSPACE==='1'&&(await evaluate('document.querySelector("button[aria-label=工作区]").textContent.trim()'))==='选择工作区'){
  await evaluate('document.querySelector("button[aria-label=工作区]").click()');evidence.actions.push('打开工作区选择');
  await until(()=>evaluate('document.querySelectorAll("[role=listbox][aria-label=工作区] [role=option]").length>1'),Boolean,'native Workspace options');
  await evaluate('(()=>{const rows=Array.from(document.querySelectorAll("[role=listbox][aria-label=工作区] [role=option]")).filter(o=>o.textContent.trim()!=="选择工作区");if(rows.length!==1)throw Error("single Workspace baseline required");rows[0].click();})()');evidence.actions.push('选择唯一工作区');await delay(150);
 }

 await evaluate('Array.from(document.querySelectorAll("summary")).find(e=>e.textContent.includes("协作与验收设置")).click()');evidence.actions.push('展开协作与验收设置');await delay(150);
 for(const text of ['允许费用未知','以现有项目测试']){await evaluate('Array.from(document.querySelectorAll("label")).find(e=>e.textContent.includes('+JSON.stringify(text)+')).querySelector("input").click()');evidence.actions.push('选择 '+text);await delay(100);}
 await fill('允许修改的文件','math.mjs');await fill('已有验收文件','verify.mjs');await click('开始任务');
 const approved=new Set(),end=Date.now()+600000;let current;
 while(Date.now()<end){
  current=task();if(current)evidence.taskId=current.id;
  if(evidence.unexpectedDialogs?.length)throw Error('Unexpected native confirmation dialog');
  if(scenario==='cancel'&&current?.delegationProposal?.state==='awaiting-result'&&current.currentAgent?.provider!=='cetamesh'&&current.executionEvidence.some(row=>row.provider===current.currentAgent.provider&&row.runId===current.executionObservation?.runId)){
   evidence.cancelObserved={provider:current.currentAgent.provider,runId:current.executionObservation.runId,operationEvidenceSeen:true};
   await evaluate('(()=>{const button=Array.from(document.querySelectorAll(".task-details button")).find(row=>row.textContent.trim()==="取消任务");if(!button)throw Error("Task cancel control missing");button.click();})()');evidence.actions.push('取消任务');
   current=await until(task,row=>row?.status==='cancelled','native Task cancellation',30000);await delay(1500);current=task();break;
  }
  const rows=readJsonFile(path.join(data,'state','capability','approvals.json'),{missing:[]});
  for(const approval of rows.filter(row=>row.status==='pending'&&row.request?.taskId===current?.id)){
   if(approved.has(approval.id))continue;const request=approval.request;
   if(request.capability==='agent.execution.authorize'){assert.ok(request.input.delegationRequestId);assert.ok(request.input.provider);assert.match(request.reason,/不能拦截直接 OS/);}
   else if(request.capability==='workspace.apply'){assert.deepEqual(request.input.changes.map(row=>row.path),['math.mjs']);assert.equal(request.input.changes[0].action,'write');}
   else if(request.capability==='test.run'){assert.equal(request.input.tool,'npm');assert.deepEqual(request.input.args,['test']);}
   else throw Error('Unexpected native-flow approval '+request.capability);
   for(const[file,expected]of Object.entries(evidence.protectedFiles))assert.equal(sha256(fs.readFileSync(path.join(project,file))),expected);
   const title=request.capability==='agent.execution.authorize'?'确认外部 Agent 的原生执行范围':request.capability==='workspace.apply'?'导入工作区改动':'运行项目测试';
   await until(()=>evaluate('Array.from(document.querySelectorAll(".approval-card")).some(e=>e.textContent.includes('+JSON.stringify(title)+'))'),Boolean,'native UI approval '+title);
   await evaluate('(()=>{const e=Array.from(document.querySelectorAll(".approval-card")).find(e=>e.textContent.includes('+JSON.stringify(title)+'));Array.from(e.querySelectorAll("button")).find(b=>b.textContent.trim()==="批准一次").click();})()');
   evidence.approvals.push({id:approval.id,capability:request.capability,title});approved.add(approval.id);await delay(300);
  }
  if(current&&(['completed','failed','cancelled','blocked'].includes(current.status)||['needs-review','unknown','blocked'].includes(current.delegationProposal?.state)))break;
  if(current?.executionObservation?.state==='awaiting-review'&&!current.delegationProposal)break;
  await delay(100);
 }
 assert.ok(current,'ordinary native form must create the authoritative Task');
 evidence.taskStatus=current.status;evidence.delegationState=current.delegationProposal?.state;evidence.history=current.agentHistory.map(row=>row.provider);evidence.selectedProvider=current.delegationProposal?.selectedProvider;
 evidence.executionEvidence=current.executionEvidence;evidence.verification=current.delegationProposal?.verification;
 const usages=readJsonFile(path.join(data,'state','model','usage-ledger.json'),{missing:{receipts:[]}}).receipts.filter(row=>row.taskId===current.id);
 evidence.modelRequests=usages.length;evidence.usageReceipts=usages;evidence.modelToolCalls=(current.executionEvidence??[]).map(row=>({capability:row.capability,status:row.status,runId:row.runId}));
 if(scenario==='cancel'){
  assert.ok(evidence.cancelObserved,'cancel scenario must observe actual external run evidence');assert.equal(current.status,'cancelled');assert.notEqual(current.delegationProposal?.state,'verified');assert.equal(sha256(fs.readFileSync(path.join(project,'math.mjs'))),evidence.originalCodeSha256,'cancel cannot import staged external edits');
  const pending=readJsonFile(path.join(data,'state','capability','approvals.json'),{missing:[]}).filter(row=>row.status==='pending'&&row.request?.taskId===current.id);assert.equal(pending.length,0,'cancel invalidates outstanding authority');
  await until(()=>evaluate('document.body.innerText.includes("已取消")'),Boolean,'native cancelled Task presentation');evidence.cancel={passed:true,noImport:true,noPendingAuthority:true,stateStable:true};
  if(process.env.CETAMESH_TEST_SCREENSHOT)await session.capture(process.env.CETAMESH_TEST_SCREENSHOT);if(process.env.CETAMESH_NATIVE_TASK_EXPORT)writeJsonAtomic(process.env.CETAMESH_NATIVE_TASK_EXPORT,current);
  if(process.env.CETAMESH_NATIVE_RESTART==='1'){const ids=usages.map(row=>row.requestId);await session.restart();const restored=task();assert.equal(restored.id,current.id);assert.equal(restored.status,'cancelled');assert.equal(sha256(fs.readFileSync(path.join(project,'math.mjs'))),evidence.originalCodeSha256);assert.deepEqual(readJsonFile(path.join(data,'state','model','usage-ledger.json')).receipts.filter(row=>row.taskId===current.id).map(row=>row.requestId),ids);evidence.restart={passed:true,status:restored.status,noNewModelRequests:true,noImport:true};}
  if(!evidence.restart)evidence.restart={status:'NOT_RUN',reason:'explicit restart opt-in required'};
  console.log('PASS NATIVE CANCEL: real external run -> production Task cancel/confirmation -> no import, no pending authority'+(evidence.restart.passed?' -> same cancelled Task after application restart':''));
 }else{
 assert.ok(usages.length>0,'real model usage receipts must be persisted by actual Core');assert.deepEqual(evidence.history,['cetamesh','codex','cetamesh']);assert.equal(current.status,'completed');assert.equal(current.delegationProposal.state,'verified');
 assert.equal(evidence.approvals.filter(row=>row.capability==='agent.execution.authorize').length,1);
 for(const[file,expected]of Object.entries(evidence.protectedFiles))assert.equal(sha256(fs.readFileSync(path.join(project,file))),expected);
 assert.deepEqual(execFileSync('git',['-C',project,'diff','--name-only'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/),['math.mjs']);
 assert.match(execFileSync(process.execPath,['verify.mjs'],{cwd:project,encoding:'utf8',windowsHide:true}),/REAL_UI_VERIFIED_5281/);
 assert.equal(current.executionEvidence.findLast(row=>row.capability==='test.run'&&row.source==='core-test')?.exitCode,0);
 await until(()=>evaluate('document.body.textContent.includes("机器验收通过")'),Boolean,'native result presentation');
 evidence.resultShownInUi=true;evidence.fileVerified=true;evidence.resultSha256=sha256(fs.readFileSync(path.join(project,'math.mjs')));
 const ms=v=>typeof v==='number'?v:Date.parse(v);evidence.taskElapsedMs=ms(current.updatedAt)-ms(current.createdAt);evidence.flowCompletedAt=new Date().toISOString();
 if(process.env.CETAMESH_TEST_SCREENSHOT)await session.capture(process.env.CETAMESH_TEST_SCREENSHOT);
 const memory=await until(()=>session.call('ui.memory.overview',{scope:'workspace:'+current.workspaceId}),row=>row.candidates.some(candidate=>candidate.status==='pending'&&candidate.type==='workspace'),'verified native outcome Memory candidate');evidence.memoryCandidateCount=memory.candidates.filter(candidate=>candidate.status==='pending'&&candidate.type==='workspace').length;
 if(process.env.CETAMESH_NATIVE_RESTART==='1'){
  const beforeIds=usages.map(row=>row.requestId),beforeEvidence=current.executionEvidence.map(row=>row.eventId),restartStarted=Date.now();
  await session.restart();const restored=session.task();assert.equal(restored.id,current.id);assert.equal(restored.status,'completed');assert.deepEqual(restored.executionEvidence.map(row=>row.eventId),beforeEvidence);assert.equal(sha256(fs.readFileSync(path.join(project,'math.mjs'))),evidence.resultSha256);
  await evaluate('document.querySelector("button[aria-label=Work]").click()');await until(()=>evaluate('document.body.textContent.includes("历史任务")'),Boolean,'restored native Task history');
  const afterUsage=readJsonFile(path.join(data,'state','model','usage-ledger.json')).receipts.filter(row=>row.taskId===current.id);assert.deepEqual(afterUsage.map(row=>row.requestId),beforeIds,'restart must not repeat a completed Task model run');
  evidence.restart={passed:true,taskId:restored.id,status:restored.status,noNewModelRequests:true,evidencePreserved:true,elapsedMs:Date.now()-restartStarted,uiHistoryShown:true};
 }


 if(process.env.CETAMESH_NATIVE_TASK_EXPORT)writeJsonAtomic(process.env.CETAMESH_NATIVE_TASK_EXPORT,current);
 if(process.env.CETAMESH_NATIVE_DONE_FILE){writeJsonAtomic(process.env.CETAMESH_NATIVE_DONE_FILE,{taskId:current.id,desktopPid:evidence.desktopPid});if(process.env.CETAMESH_NATIVE_CLOSE_FILE)await until(()=>fs.existsSync(process.env.CETAMESH_NATIVE_CLOSE_FILE),Boolean,'native final screenshot observation',45000);}
 console.log('PASS NATIVE PRODUCT: actual Desktop/Core + WebView2 -> real Managed proposal -> selected Codex -> actual edit -> Managed return -> independent Core verification -> native UI');
 }
}catch(error){if(session){try{session.evidence.failureUiText=(await session.evaluate('document.body.innerText')).slice(0,1800);if(process.env.CETAMESH_TEST_SCREENSHOT)await session.capture(process.env.CETAMESH_TEST_SCREENSHOT);}catch{}}evidence=evidence??error.nativeEvidence??{};evidence.failure={code:error.code||error.name,message:String(error.message).slice(0,800)};process.exitCode=1;}
finally{
 if(session){try{await session.close({failed:!!process.exitCode});}catch(error){evidence.cleanupFailure={code:error.code||error.name,message:String(error.message).slice(0,300)};process.exitCode=1;}}
 if(process.env.CETAMESH_TEST_EVIDENCE_FILE)writeJsonAtomic(process.env.CETAMESH_TEST_EVIDENCE_FILE,evidence??{});
 console.log(JSON.stringify({nativeAcceptanceEvidence:evidence}));
}