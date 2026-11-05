import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCodexAgentProvider} from '../../src/agent/codex-agent-provider.js';
import {projectAgentModelControl} from '../../src/desktop/chat-telemetry.js';

// Protocol and argv fixtures only. No real account, CLI execution or inference.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-codex-model-control-'));
const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
const cliHelp='--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check exec resume [SESSION_ID]';
let failures=0;
async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+': '+error.stack);}}
try{
 await check('exec changes remain next-turn requests and a running turn retains its model',async()=>{
  const completion=Promise.withResolvers(),runs=[];
  const cli={executable:()=>process.execPath,probe:args=>({available:true,stdout:args[0]==='--version'?'codex-cli 0.163.0-alpha.11.1':args[0]==='login'?'Logged in':cliHelp,stderr:''}),
   startSession:request=>{runs.push(request);return{done:completion.promise,cancel:()=>({requested:true}),terminationConfirmed:()=>true,cleanupPermitted:()=>true};},shutdown:async()=>{}};
  const provider=createCodexAgentProvider({cliProcess:cli,environment:{},codexHome:path.join(root,'isolated-exec-home'),stateDir:path.join(root,'exec-state'),stagingRoot:path.join(root,'exec-staging'),
   resolveTaskWorkspace:({taskId,workspaceId})=>({task:{id:taskId,workspaceId,goal:'synthetic model request'},workspace:{id:workspaceId,root:workspace}})});
  const session=await provider.createSession({taskId:'task',workspaceId:'workspace',model:'fixture-initial',reasoningEffort:'medium'});
  try{
   const changed=await provider.selectModel({...session,model:'fixture-next',reasoningEffort:'xhigh'});
   assert.equal(changed.confirmed,false);assert.equal(changed.modelControl.application,'next-turn');assert.equal(changed.modelControl.selection,null);
   assert.deepEqual(changed.modelControl.requested,{model:'fixture-next',reasoningEffort:'xhigh',modelProvider:null});
   assert.deepEqual(projectAgentModelControl(changed.modelControl).requested,changed.modelControl.requested,'UI exposes pending requests without relabeling them as current selection');
   assert.equal((await provider.status(session)).modelControl.application,'next-turn');
   await provider.send({...session,content:'synthetic request only'});
   await assert.rejects(provider.selectModel({...session,model:'must-not-apply'}),{code:'TURN_BUSY'});
   const status=await provider.status(session);assert.equal(status.modelControl.requested.model,'fixture-next');assert.equal(status.modelControl.selection,null);
   assert.equal(status.modelControl.lastRequest.model,'fixture-next');assert.equal(status.modelControl.lastRequest.source,'cli-argv');
   assert.equal(runs[0].args[runs[0].args.indexOf('--model')+1],'fixture-next');assert.ok(runs[0].args.includes('model_reasoning_effort="xhigh"'));
  }finally{completion.resolve({exitCode:0,processTreeExitConfirmed:true});await provider.closeSession(session);await provider.shutdown();}
 });
}finally{
 if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('cm-codex-model-control-'))throw Error('fixture cleanup boundary');
 fs.rmSync(root,{recursive:true,force:true});
}
if(failures)process.exitCode=1;
