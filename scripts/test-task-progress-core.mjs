import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { createAgentEventBuffer } from '../src/agent/protocol/agent-event-buffer.js';
import { createTaskService } from '../src/task/service.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'task-progress-'));
const service=createTaskService({stateDir});const rt=service.runtime;const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const failures=[];const capabilities=[];
async function check(name,run){try{await run();console.log('PASS',name);}catch(e){failures.push(name);console.error('FAIL',name,e.stack);}}
let serial=0;
function start(goal='Review task '+(++serial)){let t=rt.create({goal,workspaceId:'ws'});return rt.start({id:t.id,expectedRev:t.rev,provider:'codex',sessionId:'session-'+t.id}).task;}
function begin(t,runId='run-1'){assert.equal(typeof rt.beginExecutionObservation,'function','Core must invalidate prior review before dispatch');return rt.beginExecutionObservation({id:t.id,...t.currentAgent,runId,phase:'user'});}
async function follow(t,events,runId='run-1'){
 const cap=createCapabilityService({taskRuntime:rt,agentBroker:{capabilities:()=>({workspaceBoundary:'native-staged'}),follow:async function*(){yield* events.map((e,i)=>({seq:i+1,...e,data:{requestId:'turn-'+runId,runId,phase:'user',...e.data}}));}}});capabilities.push(cap);
 cap.trackTaskAgent({taskId:t.id,...t.currentAgent});for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));return rt.get({id:t.id}).task;
}
const report=[{type:'assistant/message',data:{message:{content:[{type:'text',text:'Analysis of the supplied text only.'}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}}];
function uiWith(status={running:false,lastRunStatus:'completed'},capabilityService={}){return createDesktopUiService({services:{taskService:service,agentBroker:{status:async()=>status},capabilityService}});}
function complete(ui,t,extra={}){return ui.execute({method:'ui.task.complete',params:{id:t.id,expectedRev:t.rev,reviewed:true,summary:'Owner reviewed',...extra}});}
try{
 await check('actual Broker dispatch invalidates review before native send and Follow settles exact run',async()=>{
  const buffer=createAgentEventBuffer();let seq=0,t;
  const registry=createAgentProviderRegistry();registry.register(defineAgentProvider({id:'fixture',label:'Fixture',eventProtocol:'agent-turn-events-v1',capabilityExtras:{workspaceBoundary:'native-staged'},methods:{
   createSession:async()=>({sessionId:'broker-session'}),send:async({runId,phase})=>{
    assert.equal(rt.get({id:t.id}).task.executionObservation.runId,runId,'observation precedes effects');
    for(const e of report)buffer.push({type:'event',seq:++seq,event:{...e,data:{...e.data,requestId:'native-'+runId,runId,phase}}});
    return {accepted:true,requestId:'native-'+runId};
   },status:async()=>({running:false,lastRunStatus:'completed'}),cancel:async()=>({cancelled:true}),async *follow({signal,sinceSequence}){yield* buffer.follow({signal,sinceSequence});}
  }}));
  const broker=createAgentBroker({registry,resolveExecutionTask:id=>rt.get({id}).task});
  const cap=createCapabilityService({taskRuntime:rt,agentBroker:broker});capabilities.push(cap);
  t=rt.create({goal:'broker lifecycle '+(++serial),workspaceId:'ws'});const session=await broker.createSession('fixture',{taskId:t.id,workspaceId:'ws'});t=rt.start({id:t.id,expectedRev:t.rev,provider:'fixture',sessionId:session.sessionId}).task;
  await broker.send({...t.currentAgent,runId:'dispatch-1',content:'analysis only'});for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
  t=rt.get({id:t.id}).task;assert.equal(t.executionObservation.state,'awaiting-review');assert.equal(t.agentReports.at(-1).runId,'dispatch-1');
  await broker.send({...t.currentAgent,runId:'dispatch-2',content:'new analysis'});for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
  t=rt.get({id:t.id}).task;assert.equal(t.executionObservation.state,'awaiting-review');assert.equal(t.agentReports.at(-1).runId,'dispatch-2');assert.equal(t.executionEvidence.length,0);
 });
 await check('terminal report is awaiting review, never Task completion or fake percent',async()=>{let t=begin(start());t=await follow(t,report);assert.equal(t.status,'running');assert.equal(t.progress.percent,0);assert.equal(t.executionObservation.state,'awaiting-review');assert.equal(t.executionEvidence.length,0);const dto=(await uiWith().execute({method:'ui.task.get',params:{id:t.id}})).task;assert.equal(dto.execution.state,'awaiting-review');assert.equal(dto.reviewReport.sha256,digest('Analysis of the supplied text only.'));});
 await check('activity remains non-evidence and cannot use report-only review',async()=>{let t=begin(start());t=await follow(t,[{type:'tool/activity',data:{activity:{id:'n',capability:'codex.native.command',status:'completed'}}},...report]);assert.equal(t.executionEvidence.length,0);assert.equal(t.executionObservation.hadToolActivity,true);await assert.rejects(complete(uiWith(),t,{reviewKind:'report-only',reportEventId:t.agentReports[0].eventId,reportSha256:digest(t.agentReports[0].text)}),{code:'TASK_REPORT_ONLY_NOT_ALLOWED'});});
 await check('report-only requires explicit exact current report; persists review not fabricated evidence',async()=>{let t=begin(start());t=await follow(t,report);await assert.rejects(complete(uiWith(),t),{code:'TASK_EVIDENCE_REQUIRED'});await assert.rejects(complete(uiWith(),t,{reviewKind:'report-only',reportEventId:t.agentReports[0].eventId,reportSha256:'0'.repeat(64)}),{code:'TASK_REPORT_CHANGED'});const done=await complete(uiWith(),t,{reviewKind:'report-only',reportEventId:t.agentReports[0].eventId,reportSha256:digest(t.agentReports[0].text)});assert.equal(done.task.status,'completed');const raw=rt.get({id:t.id}).task;assert.equal(raw.executionEvidence.length,0);assert.equal(raw.result.ownerReview.kind,'report-only');assert.equal(raw.result.ownerReview.reportSha256,digest(t.agentReports[0].text));});
 await check('stale run success and failure cannot restore prior review after new dispatch',async()=>{let t=begin(start());t=await follow(t,report);t=begin(t,'run-2');t=await follow(t,[...report,{type:'turn/end',data:{reason:{kind:'error',error:{code:'OLD_FAILURE'}}}}],'run-1');assert.equal(t.status,'running');assert.equal(t.executionObservation.runId,'run-2');assert.equal(t.executionObservation.state,'running');await assert.rejects(complete(uiWith(),t),{code:'TASK_EXECUTION_UNCONFIRMED'});});
 await check('completion rejects active provider, unknown effects, pending approval and stale revision',async()=>{let t=begin(start());t=await follow(t,[{type:'tool/result',data:{eventId:'core-result',capability:'filesystem.read',status:'completed'}},...report]);for(const status of [{running:true},{running:false,waitingForApproval:true},{running:false,state:'unknown'},{running:false,lastRunStatus:'cancel-unconfirmed'}])await assert.rejects(complete(uiWith(status),t),{code:'TASK_EXECUTION_UNCONFIRMED'});await assert.rejects(complete(uiWith(undefined,{completionBlocker:()=> 'TASK_APPROVAL_PENDING'}),t),{code:'TASK_APPROVAL_PENDING'});rt.update({id:t.id,expectedRev:t.rev,note:'Changed'});await assert.rejects(complete(uiWith(),t),{code:'TASK_CONFLICT'});});
 await check('newer failed tool outcome cannot be hidden by older successful evidence',async()=>{let t=begin(start());t=await follow(t,[{type:'tool/result',data:{eventId:'ok',capability:'filesystem.read',status:'completed'}},{type:'tool/result',data:{eventId:'unknown',capability:'filesystem.write',status:'outcome-unknown'}},...report]);await assert.rejects(complete(uiWith(),t),{code:'TASK_EFFECT_UNCONFIRMED'});});
 await check('objective edits and resumed runs cannot accept a prior report',async()=>{let t=begin(start());t=await follow(t,report);t=rt.update({id:t.id,expectedRev:t.rev,goal:'Changed goal '+(++serial)});assert.equal(t.executionObservation,null);await assert.rejects(complete(uiWith(),t),{code:'TASK_EXECUTION_UNCONFIRMED'});});
 await check('late explicit unknown effects from prior run remain fenced',async()=>{let t=begin(start());t=begin(t,'next-run');t=await follow(t,[{type:'turn/end',data:{reason:{kind:'error',error:{code:'OUTCOME_UNKNOWN'}}}}],'run-1');assert.equal(t.status,'blocked');assert.match(t.progress.note,/needs-reconciliation/);});
 await check('restart and reassignment invalidate current execution review',async()=>{let t=begin(start());t=await follow(t,report);rt.recoverInterrupted();t=rt.get({id:t.id}).task;assert.equal(t.executionObservation.state,'unknown');t=rt.attachAgent({id:t.id,expectedRev:t.rev,provider:'codex',sessionId:'replacement'}).task;assert.equal(t.executionObservation,null);});
 await check('legacy task with evidence but no settled observation stays unknown',async()=>{let t=start();rt.recordToolOutcome({id:t.id,...t.currentAgent,eventId:'legacy',capability:'filesystem.read',status:'completed'});t=rt.get({id:t.id}).task;await assert.rejects(complete(uiWith(),t),{code:'TASK_EXECUTION_UNCONFIRMED'});});
}finally{for(const cap of capabilities)await cap.close();fs.rmSync(stateDir,{recursive:true,force:true});}
assert.equal(failures.length,0,failures.join('; '));
