import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'comm-managed-turns-'));
const workspaceRoot=path.join(root,'workspace');fs.mkdirSync(workspaceRoot);
const diagnostics=[];
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),
  log:message=>diagnostics.push(String(message))});
const emitted=new Set(),requests=[];
async function until(read,predicate,label) {
  const deadline=Date.now()+7000;let last;
  while(Date.now()<deadline) {last=await read();if(predicate(last))return last;await delay(5);}
  assert.fail(label+': '+JSON.stringify(last)+' diagnostics='+diagnostics.slice(-8).join(' | '));
}
try {
  services.modelRegistry.register({id:'comm-managed',label:'Synthetic managed model',defaultModel:'fixture',supportsTools:true,
    health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>({text:'unused'}),
    stream:async function*(request) {
      requests.push(structuredClone({...request,signal:undefined}));
      const text=[...request.messages].reverse().find(m=>m.role==='user')?.content??'';
      const turn=String(text).match(/COMM_TURN_[123]/)?.[0];
      if(!turn)throw new Error('Synthetic model received an unrecognized user turn');
      if(!emitted.has(turn)&&turn==='COMM_TURN_1') {
        emitted.add(turn);
        yield {type:'assistant/tool-calls',data:{toolCalls:[
          {id:'write-a',capabilityId:'filesystem.write',arguments:JSON.stringify({path:'a.txt',content:'approved A'})},
          {id:'write-b',capabilityId:'filesystem.write',arguments:JSON.stringify({path:'b.txt',content:'approved B'})}
        ]}};
      } else if(!emitted.has(turn)&&turn==='COMM_TURN_2') {
        emitted.add(turn);
        yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'read-a',capabilityId:'filesystem.read',arguments:JSON.stringify({path:'a.txt'})}]}};
      } else {
        yield {type:'assistant/message',data:{message:{content:[{type:'text',text:turn+' report after observed tool results.'}]}}};
      }
      yield {type:'turn/end',data:{reason:{kind:'completed'}}};
      // Duplicate terminal at the synthetic model leaf must not create another Agent report.
      yield {type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  services.providerSecrets.set({provider:'comm-managed',apiKey:'synthetic-not-a-real-key'});
  const ws=(await services.workspaceService.execute({method:'workspace.create',params:{name:'COMM managed fixture',root:workspaceRoot}})).workspace;
  const ui=services.desktopUiService;
  const session=await ui.execute({method:'ui.chat.sessions.create',params:{title:'COMM managed turns'}});
  await ui.execute({method:'ui.chat.config.set',params:{id:session.id,config:{mode:'chat',workspaceId:ws.id,modelProvider:'comm-managed',model:'fixture',agentProvider:'cetamesh'}}});
  const status=()=>services.chatService.execute({method:'chat.status',params:{id:session.id}});
  const task=async()=>services.taskService.runtime.get({id:(await status()).taskId}).task;
  async function send(n) {await ui.execute({method:'ui.chat.send',params:{id:session.id,text:'COMM_TURN_'+n+' inspect this isolated project.'}});}
  await send(1);
  await until(status,s=>s.state==='waiting-approval'||s.waitingForApproval||s.approvalId||s.turn?.approvalId,'first approval');
  const row1=await until(()=>services.capabilityService.broker.approvals.list(),rows=>rows.length===1,'first approval row');
  const task1=await task();
  assert.equal(task1.currentAgent.provider,'cetamesh');
  const agentSession=task1.currentAgent.sessionId;
  async function progressWhilePending() {
    for(let i=0;i<3;i++) {const current=await task();await services.taskService.execute({method:'task.update',params:{id:current.id,expectedRev:current.rev,progress:{percent:i+1,note:'concurrent progress'}}});}
  }
  async function decide(id) {
    await progressWhilePending();
    const accepted=await ui.execute({method:'ui.approvals.decide',params:{id,approve:true}});
    assert.equal(accepted.status,'accepted');assert.equal(typeof accepted.operationId,'string');
    const operation=await until(()=>ui.execute({method:'ui.approvals.operation',params:{id:accepted.operationId}}),
      op=>['completed','waiting','failed','unknown','cancelled'].includes(op.status),'approval operation');
    assert.ok(['completed','waiting'].includes(operation.status),JSON.stringify(operation));
    assert.equal(operation.turnResumed,true);
    return operation;
  }
  assert.equal(fs.existsSync(path.join(workspaceRoot,'a.txt')),false);
  assert.equal(fs.existsSync(path.join(workspaceRoot,'b.txt')),false);
  const first=await decide(row1[0].id);
  assert.equal(first.status,'waiting');assert.equal(first.resumePending,true);
  assert.equal(fs.readFileSync(path.join(workspaceRoot,'a.txt'),'utf8'),'approved A');
  assert.equal(fs.existsSync(path.join(workspaceRoot,'b.txt')),false,'second high risk tool requires separate approval');
  const row2=await until(()=>services.capabilityService.broker.approvals.list(),rows=>rows.length===1&&rows[0].id!==row1[0].id,'second approval row');
  const second=await decide(row2[0].id);
  assert.equal(second.status,'completed');
  assert.equal(fs.readFileSync(path.join(workspaceRoot,'b.txt'),'utf8'),'approved B');
  await until(status,s=>!s.turn,'first chat completion');
  await until(task,t=>t.agentReports?.length===1,'first TaskFollow report');
  assert.equal(services.capabilityService.completionBlocker((await task()).id),null,'settled continuation chain must not remain blocked by historical waiting operation');
  const settledFirst=await ui.execute({method:'ui.approvals.operation',params:{id:first.operationId}});
  assert.equal(settledFirst.status,'completed');assert.equal(settledFirst.resumePending,false);
  console.log('PASS managed turn 1 two separate approvals survive concurrent task progress and write only after approval');
  for(const n of [2,3]) {
    await send(n);await until(status,s=>!s.turn,'chat turn '+n);
    const current=await until(task,t=>t.agentReports?.length===n,'TaskFollow report '+n);
    assert.equal(current.currentAgent.sessionId,agentSession,'three turns reuse their actual ManagedAgent Session');
    assert.equal(current.status,'running');
  }
  const final=await task();
  assert.equal(final.id,task1.id);
  assert.equal(final.agentReports.length,3);
  assert.equal(new Set(final.agentReports.map(r=>r.eventId)).size,3);
  assert.equal(new Set(final.agentReports.map(r=>r.runId)).size,3);
  assert.ok(final.agentReports.every(r=>r.runId&&r.phase==='user'));
  assert.ok(final.agentReports.every(r=>r.verified===false));
  const outcomes=final.executionEvidence??[];
  assert.equal(outcomes.filter(o=>o.capability==='filesystem.write'&&o.status==='completed').length,2);
  assert.equal(outcomes.filter(o=>o.capability==='filesystem.read'&&o.status==='completed').length,1);
  const history=await ui.execute({method:'ui.chat.history',params:{id:session.id}});
  assert.equal(history.messages.filter(m=>m.role==='assistant').length,3,'duplicate model terminals cannot add Chat replies');
  for(const n of [1,2,3])assert.ok(history.messages.some(m=>m.role==='assistant'&&m.text.includes('COMM_TURN_'+n+' report')));
  const memories=await until(()=>services.memoryService.runtime.list({principal:{kind:'user',id:'desktop'},scope:'task:'+final.id,types:['working']}),
    page=>page.memories.length===1&&page.memories[0].content.includes('filesystem.read'),'working memory');
  const working=JSON.parse(memories.memories[0].content);
  assert.ok(working.evidence.some(row=>row.runId&&row.phase==='user'));
  assert.equal(working.evidence.filter(row=>row.status==='completed').length,3);
  assert.ok(final.memoryRefs.some(ref=>ref.memoryId===memories.memories[0].id));
  assert.ok(!services.capabilityService.principalForTask(final.id).grants.capabilities.includes('memory.write'),'Core working Memory does not broaden Agent grants');
  assert.equal(services.capabilityService.broker.approvals.list().length,0);
  assert.ok(!diagnostics.some(line=>line.includes('follow-retrying')),'normal completion cannot hide a TaskFollow failure');
  console.log('PASS managed 3 user turns preserve Chat reports, TaskFollow outcomes, run provenance and scoped working Memory');
} finally {
  await services.chatService.close();
  await services.managedAgent.close();
  await services.capabilityService.close();
  services.agentBroker.close();
  await services.integrationService.close();
  fs.rmSync(root,{recursive:true,force:true});
}
