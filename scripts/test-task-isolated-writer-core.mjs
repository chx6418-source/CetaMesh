import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {OWNER_ACTOR} from '../src/capability/types.js';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-isolated-writer-core-')));
const project = path.join(base, 'repo'); fs.mkdirSync(project);
const git = (...args) => execFileSync('git', args, {cwd:project, encoding:'utf8',windowsHide:true}).trim();
git('init','-b','main'); git('config','user.name','Controlled fixture'); git('config','user.email','fixture@example.invalid');
fs.mkdirSync(path.join(project,'src')); fs.writeFileSync(path.join(project,'src','proof.txt'),'baseline\n');
fs.writeFileSync(path.join(project,'outside.txt'),'outside scope\n'); git('add','.'); git('commit','-m','baseline');
const baseline = git('rev-parse','HEAD');
const services = createCetaMeshServices({stateDir:path.join(base,'state'),dataRoot:path.join(base,'data'),resourceRoot:base,sourceRoot:base});
const ui = (method,params) => services.desktopUiService.execute({method,params});
async function until(read,predicate,label) {
  for(let n=0;n<1200;n++){const value=await read();if(predicate(value))return value;await delay(10);}
  console.error('Controlled Task states:',JSON.stringify(services.taskService.runtime.list({limit:20}).tasks.map(task=>({id:task.id,
    status:task.status,progress:task.progress,observation:task.executionObservation,evidence:task.executionEvidence?.slice(-3)}))));
  assert.fail(label);
}
try {
  const workspace=(await services.workspaceService.execute({method:'workspace.create',params:{root:project,name:'writer source'}})).workspace;
  const parent=services.taskService.runtime.create({goal:'Isolated controlled writers',workspaceId:workspace.id});
  const prepared=[];
  for(const name of ['a','b']) {
    const operationId='worktree-'+name;
    const requested=await ui('ui.workspace.git.worktree.create',{id:workspace.id,taskId:parent.id,operationId,branch:'codex/'+name,expectedHead:baseline});
    assert.equal(requested.status,'pending');
    const accepted=await ui('ui.approvals.decide',{id:requested.approvalId,approve:true});
    const settled = await until(()=>ui('ui.approvals.operation',{id:accepted.operationId}),row=>!['accepted','running','waiting'].includes(row.status),'worktree approval completion');
    assert.equal(settled.status,'completed',JSON.stringify(settled));
    const created=(await services.workspaceService.execute({method:'workspace.list'})).workspaces.find(row=>row.gitWorktree?.branch==='codex/'+name);
    assert.ok(created?.id);
    const childParams={parentTaskId:parent.id,expectedParentRev:parent.rev,requestId:'child-'+name,
      goal:'Write '+name,workspaceId:created.id,provisionOperationId:operationId,
      contract:{mode:'isolated-write',outputKind:'changes',readScope:['src'],writeScope:['src'],expectedEvidence:['filesystem.write']}};
    const child=await ui('ui.task.child.create',childParams);
    prepared.push({name,workspace:created,task:child.task,childParams});
  }
  assert.notEqual(prepared[0].workspace.root,prepared[1].workspace.root);
  for(const row of prepared) {
    assert.throws(()=>services.capabilityService.grantTask(row.task.id),{code:'TASK_CHILD_GRANT_REQUIRED'});
    await ui('ui.task.child.create',{...row.childParams,capabilities:['filesystem.read','filesystem.write']});
    const request={actor:OWNER_ACTOR,taskId:row.task.id,workspaceId:row.workspace.id};
    await assert.rejects(services.capabilityService.broker.execute({...request,capability:'filesystem.write',input:{path:'outside.txt',content:'forbidden'}}),{code:'TASK_CHILD_SCOPE_DENIED'});
    await assert.rejects(services.capabilityService.broker.execute({...request,capability:'test.run',input:{tool:'npm',args:['test']}}),{code:'TASK_CHILD_CAPABILITY_DENIED'});
  }
  let releaseBarrier;
  const barrier=new Promise(resolve=>{releaseBarrier=resolve;}), entered=new Set(), firstTurns=new Set(), writes=new Set();
  services.modelRegistry.register({id:'writer-fixture',label:'Local deterministic writer',supportsTools:true,defaultModel:'fixture',
    health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>{throw Error('Streaming expected');},
    stream:async function*(request) {
      const text=JSON.stringify([...request.messages].reverse().find(row=>row.role==='user')?.content);
      const name=text.includes('Write a')?'a':'b';
      if(!firstTurns.has(name)) {
        firstTurns.add(name);entered.add(name);if(entered.size===2)releaseBarrier();
        await barrier;
        yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'read-'+name,capabilityId:'filesystem.read',arguments:JSON.stringify({path:'src/proof.txt'})}]}};
      } else if(!writes.has(name)) {
        const read=request.messages.find(row=>row.role==='tool'&&row.tool_call_id==='read-'+name);
        const result=JSON.parse(read.content);assert.equal(result.status,'completed',read.content);
        const expectedHash=result.result.expectedHash;assert.match(expectedHash,/^[a-f0-9]{64}$/);
        writes.add(name);
        yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'write-'+name,capabilityId:'filesystem.write',
          arguments:JSON.stringify({path:'src/proof.txt',content:'written '+name+'\n',expectedHash})}]}};
      } else {
        const results=request.messages.filter(row=>row.role==='tool');
        console.log('Controlled model tool result:',name,JSON.stringify(results));
        yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'Completed the scoped file write.'}]}}};
      }
      yield {type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  services.providerSecrets.set({provider:'writer-fixture',apiKey:'synthetic-local-only'});
  await Promise.all(prepared.map(row=>ui('ui.task.start',{id:row.task.id,expectedRev:row.task.rev,requestId:'run-'+row.name,
    agentProvider:'cetamesh',modelProvider:'writer-fixture',model:'fixture'})));
  await until(()=>entered.size,value=>value===2,'both real Managed Runs must enter the concurrent barrier');
  assert.equal(prepared.filter(row=>services.taskService.runtime.get({id:row.task.id}).task.status==='running').length,2);
  for(const row of [...prepared].reverse()) {
    const approval=await until(async()=> (await ui('ui.approvals.list',{})).approvals.find(item=>item.taskId===row.task.id
      &&item.capability==='filesystem.write'&&item.status==='pending'),Boolean,'independent file approval');
    const accepted=await ui('ui.approvals.decide',{id:approval.id,approve:true});
    const settled=await until(()=>ui('ui.approvals.operation',{id:accepted.operationId}),item=>!['accepted','running','waiting'].includes(item.status),'file approval settlement');
    assert.equal(settled.status,'completed',JSON.stringify(settled));
  }
  for(const row of prepared) {
    const task=await until(()=>services.taskService.runtime.get({id:row.task.id}).task,
      value=>value.attempts.at(-1)?.state==='completed'&&value.executionObservation?.state==='awaiting-review','actual child Run settlement');
    assert.equal(fs.readFileSync(path.join(row.workspace.root,'src','proof.txt'),'utf8'),'written '+row.name+'\n');
    const complete=await ui('ui.task.child.complete',{id:task.id,expectedRev:task.rev,summary:'Review actual isolated bytes'});
    assert.equal(complete.task.verification,'VERIFIED','Core must verify current bytes against the exact Run write receipt');
  }
  assert.equal(fs.readFileSync(path.join(project,'src','proof.txt'),'utf8'),'baseline\n','child effects never enter parent directory');
  assert.equal(git('rev-parse','HEAD'),baseline);
  console.log('PASS real Core approved worktrees, two Managed Runs, independent scoped write approvals and byte verification; synthetic model only');
} finally {
  for(const name of ['autonomousHandoff','chatService','agentService','managedAgent','capabilityService','extensionService']) await services[name].close();
  fs.rmSync(base,{recursive:true,force:true});
}
