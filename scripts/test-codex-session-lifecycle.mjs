import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexSessionLifecycle } from '../src/agent/codex-session-lifecycle.js';
import { createCodexAgentProvider } from '../src/agent/codex-agent-provider.js';
import { createCodexProviderRouter } from '../src/agent/codex-provider-router.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-codex-lifecycle-'));
const binding = {sessionId:'session-a',taskId:'task-a',workspaceId:'workspace-a',transport:'exec',snapshotId:'snapshot-a',attemptId:null};
try {
  let lifecycle = createCodexSessionLifecycle({stateDir:root});
  lifecycle.create(binding);
  assert.equal(lifecycle.read(binding.sessionId).receipt.evidence,'never-started');
  lifecycle = createCodexSessionLifecycle({stateDir:root});
  assert.equal(lifecycle.read(binding.sessionId).receipt.evidence,'never-started','Core restart preserves a trusted no-launch receipt');
  const first = lifecycle.begin({...binding,runId:'run-a',turnId:'turn-a'});
  assert.equal(first.generation,1);
  assert.equal(lifecycle.read(binding.sessionId).receipt,null,'dispatch invalidates prior receipt before process launch');
  lifecycle.settle({...binding,generation:first.generation,runId:'run-a',proof:'process-tree-exit',staging:'retained'});
  const stopped = createCodexSessionLifecycle({stateDir:root}).read(binding.sessionId);
  assert.equal(stopped.state,'stopped');
  assert.equal(stopped.receipt.runId,'run-a');
  assert.equal(stopped.staging,'retained','a stop receipt never deletes or imports staging');
  const second = lifecycle.begin({...binding,runId:'run-b',turnId:'turn-b'});
  assert.equal(second.generation,2);
  assert.throws(()=>lifecycle.settle({...binding,generation:1,runId:'run-a',proof:'process-tree-exit'}),{code:'CODEX_LIFECYCLE_CONFLICT'});
  assert.equal(lifecycle.read(binding.sessionId).receipt,null,'late old run cannot certify a new execution');
  lifecycle.unknown({...binding,generation:2,runId:'run-b'});
  assert.equal(createCodexSessionLifecycle({stateDir:root}).read(binding.sessionId).state,'unknown');
  assert.throws(()=>lifecycle.settle({...binding,generation:2,runId:'run-b',proof:'root-process-exit'}),{code:'CODEX_STOP_PROOF_INVALID'});
  assert.equal(lifecycle.read(binding.sessionId).receipt,null,'a raw root exit is not a process-tree receipt');
  assert.throws(()=>lifecycle.settle({...binding,taskId:'another-task',generation:2,runId:'run-b',proof:'process-tree-exit'}),{code:'TASK_WORKSPACE_MISMATCH'});
  lifecycle.settle({...binding,generation:2,runId:'run-b',proof:'process-tree-exit',staging:'retained'});
  lifecycle.close({...binding});
  assert.equal(createCodexSessionLifecycle({stateDir:root}).read(binding.sessionId).state,'closed');
  assert.equal(lifecycle.read('missing'),null,'absence is never a stopped record');
  lifecycle.create({...binding,sessionId:'app-server-session',transport:'app-server'});
  assert.equal(lifecycle.read('app-server-session').receipt,null,'a persistent app-server is not stopped by creating its native session');
  fs.writeFileSync(path.join(root,'agent','codex-session-lifecycle.json'),'{invalid');
  assert.throws(()=>createCodexSessionLifecycle({stateDir:root}).read(binding.sessionId),{code:'CODEX_LIFECYCLE_STORE_INVALID'});
  console.log('PASS durable exact-generation Codex receipts; unknown, root-only exit, stale and corrupt proof rejected');

  const integration=path.join(root,'integration');fs.mkdirSync(integration);
  const workspace=path.join(integration,'project');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'source.txt'),'owned fixture');
  let task={id:'provider-task',workspaceId:'provider-workspace',goal:'synthetic native fixture',attempts:[]};
  let launches=0, pendingResolve, stopConfirmed=false;
  const fakeCli={executable:()=>process.execPath,probe(args){return {available:true,stdout:args[0]==='--version'?'codex-cli 9.9.9-fixture'
    :args[0]==='login'?'Logged in':'--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check exec resume [SESSION_ID]',stderr:''};},
    startSession({onStdout}){launches++;onStdout('{"type":"thread.started","thread_id":"fixture"}\n{"type":"turn.completed"}\n');
      return {done:launches===1?Promise.resolve({exitCode:0,processTreeExitConfirmed:true}):new Promise(resolve=>{pendingResolve=resolve;}),
        cancel:()=>({requested:true}),terminationConfirmed:()=>stopConfirmed};},async shutdown(){}};
  const options={stateDir:path.join(integration,'state'),stagingRoot:path.join(integration,'staging'),codexHome:path.join(integration,'home'),
    cliProcess:fakeCli,resolveTaskWorkspace:()=>({task,workspace:{id:task.workspaceId,root:workspace}})};
  const original=createCodexAgentProvider(options);
  const created=await original.createSession({taskId:task.id,workspaceId:task.workspaceId});
  task.currentAgent={provider:'codex',sessionId:created.sessionId};
  await original.send({...created,content:'synthetic read',runId:'provider-run-one'});
  task.executionObservation={runId:'provider-run-one'};
  for(let i=0;i<100&&(await original.status(created)).running;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await original.status(created)).running,false);
  const restored=createCodexAgentProvider(options), restartedRouter=createCodexProviderRouter({legacyProvider:restored});
  await assert.rejects(restartedRouter.status(created),{code:'SESSION_TRANSPORT_UNKNOWN'});
  const scope={taskId:task.id,workspaceId:task.workspaceId,sessionId:created.sessionId};
  const proof=await restored.verifyStoppedTask(scope);
  assert.equal(proof.stopped,true,'actual provider stop receipt survives in-memory transport loss');
  assert.equal(proof.evidence,'process-tree-exit');assert.equal(proof.runId,'provider-run-one');
  assert.equal((await restored.verifyStoppedTask({...scope,taskId:'wrong-task'})).stopped,false);
  task.executionObservation={runId:'wrong-run'};
  assert.equal((await restored.verifyStoppedTask(scope)).stopped,false,'same Session cannot borrow another Task run receipt');
  task.executionObservation={runId:'provider-run-two'};
  await original.send({...created,content:'second synthetic read',runId:'provider-run-two'});
  assert.equal((await restored.verifyStoppedTask(scope)).stopped,false,'new dispatch invalidates persisted proof before native execution');
  pendingResolve({exitCode:null,terminationConfirmed:false,effectStatus:'unknown'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await restored.verifyStoppedTask(scope)).stopped,false);
  await assert.rejects(original.closeSession(created),{code:'PROVIDER_CLOSE_UNKNOWN'});
  assert.equal(fs.existsSync(created.cwd),true,'unknown execution keeps its staging and ownership');
  stopConfirmed=true;await original.closeSession(created);
  assert.equal((await restored.verifyStoppedTask(scope)).stopped,true,'later trusted whole-tree confirmation replaces unknown proof');
  const orphan = { sessionId: 'created-before-attach', taskId: task.id, workspaceId: task.workspaceId,
    transport: 'app-server', snapshotId: 'orphan-snapshot', attemptId: null };
  original._sessionLifecycle.create(orphan);
  assert.equal((await restored.verifyStoppedTask(scope)).stopped, false, 'another unconfirmed native startup blocks even a stopped current assignment');
  assert.equal((await restored.verifyTaskQuiescence({ taskId: task.id, workspaceId: task.workspaceId })).stopped, false);
  original._sessionLifecycle.settle({ ...orphan, proof: 'supervisor-close' });
  assert.equal((await restored.verifyTaskQuiescence({ taskId: task.id, workspaceId: task.workspaceId })).stopped, true);
  task.progress={note:'STAGING_READ_FAILED'};task.currentAgent.sessionId='never-created';
  assert.equal((await restored.verifyStoppedTask({...scope,sessionId:'never-created'})).stopped,false,'Owner or Task prose never substitutes for a receipt');
  console.log('PASS provider completion survives Core transport loss; run mismatch, active generation and unknown tree cannot recover');
} finally {
  const target=path.resolve(root);
  assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('cetamesh-codex-lifecycle-'));
  fs.rmSync(target,{recursive:true,force:true});
}
