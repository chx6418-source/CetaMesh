import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProcess } from '../src/agent/cli-agent-process.js';
import { prepareCodexOwnedLaunch } from '../src/agent/codex-process-supervisor.js';

if(process.env.WHALEBRIDGE_TEST_NATIVE_PRODUCT!=='1'){
  console.log('NOT_RUN_ENVIRONMENT: owned supervisor requires explicit native product opt-in');process.exit(77);
}
if(process.platform!=='win32'){console.log('NOT_RUN_ENVIRONMENT: Windows owned Job supervisor');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-owned-supervisor-'));
try {
  let starts=0;
  const missing=new CliAgentProcess({name:'fixture',executable:process.execPath,ownedTreeStateDir:root,
    ownedTreeSupervisor:path.join(root,'missing.exe'),spawnImpl:()=>{starts++;throw Error('must not spawn');}});
  assert.throws(()=>missing.startSession({cwd:root}),{code:'AGENT_SUPERVISOR_UNAVAILABLE'});
  assert.equal(starts,0,'unavailable supervisor cannot fall back to unsupervised execution');
  assert.throws(()=>prepareCodexOwnedLaunch({stateDir:root,supervisorExecutable:process.execPath,
    executable:process.execPath,args:[],cwd:root,sessionId:'mismatch'}),{code:'AGENT_SUPERVISOR_UNAVAILABLE'});
  const grandchild=path.join(root,'child.mjs'),parent=path.join(root,'parent.mjs'),marker=path.join(root,'child-exited.txt');
  fs.writeFileSync(grandchild,"import fs from 'node:fs';setTimeout(()=>{fs.writeFileSync(process.argv[2],'owned child ended');},600);");
  fs.writeFileSync(parent,"import {spawn} from 'node:child_process';const c=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore',windowsHide:true,detached:true});c.unref();");
  const cli=new CliAgentProcess({name:'fixture',executable:process.execPath,ownedTreeStateDir:root});
  const run=cli.startSession({cwd:root,args:[parent,grandchild,marker],sessionId:'owned-descendant'});
  const result=await run.done;
  assert.equal(result.exitCode,0);
  assert.equal(result.processTreeExitConfirmed,true,'normal completion needs the owned Job empty receipt');
  assert.equal(fs.readFileSync(marker,'utf8'),'owned child ended','helper waits for the child that outlives its root');
  const sleeping=cli.startSession({cwd:root,args:['-e','setTimeout(()=>{},30000)'],sessionId:'cancel-owned'});
  sleeping.cancel();const cancelled=await sleeping.done;
  assert.equal(cancelled.terminationConfirmed,true);
  assert.equal(cancelled.cancelled,true);
  assert.equal(cli.sessions.size,0);
  await cli.shutdown();
  console.log('PASS owned Windows Job waits for descendants, confirms exact cancellation and refuses missing/mismatched helper');
} finally {
  const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('cetamesh-owned-supervisor-'));
  fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
