// Actual router + actual CLI process class + an owned Node JSONL peer. No model/account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CliAgentProcess} from '../../src/agent/cli-agent-process.js';
import {createCodexProviderRouter} from '../../src/agent/codex-provider-router.js';
import {createOwnedCodexProcessObserver} from './real-recovery-observation.mjs';

export async function checkOwnedCodexObservation() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-observer-shape-')),stagingRoot=path.join(root,'staging'),stage=path.join(stagingRoot,'fixture-stage');
  fs.mkdirSync(stage,{recursive:true});fs.writeFileSync(path.join(stage,'sum.js'),'exports.sum=(a,b)=>a+b;\n');
  const cli=new CliAgentProcess({name:'codex',executable:process.execPath,inspectNaturalExitImpl:()=>true});
  const chunks=[];let handle,originalArgs,observation;
  const originalStart=CliAgentProcess.prototype.startSession;
  const sessionId='fixture-owned-session';
  const legacy={id:'codex',label:'Controlled JSONL fixture only',eventProtocol:'fixture',capabilities:()=>({fixture:true}),
    createSession:async()=>({sessionId}),
    async send(){
      originalArgs=['-e',"const emit=o=>process.stdout.write(JSON.stringify(o)+'\\n');emit({type:'item.started',item:{id:'read',type:'command_execution',command:'Get-Content -Raw -LiteralPath sum.js'}});emit({type:'item.started',item:{id:'wait',type:'command_execution',command:'Start-Sleep -Seconds 30'}});setTimeout(()=>{},150);"];
      handle=cli.startSession({sessionId:sessionId+':fixture-turn',cwd:stage,args:originalArgs,input:'',onStdout:chunk=>chunks.push(chunk)});
      return{accepted:true};
    },shutdown:()=>cli.shutdown()};
  const router=createCodexProviderRouter({legacyProvider:legacy});
  try{
    assert.equal(router._sessions,undefined,'The real public router intentionally hides implementation session maps');
    observation=createOwnedCodexProcessObserver({stagingRoot,broker:{require:()=>router}});
    await router.createSession({taskId:'fixture-task',workspaceId:'fixture-workspace'});
    const request={provider:'codex',sessionId,phase:'user'};observation.beforeSend(request,'read-and-wait');
    const result=await router.send(request);assert.equal(result.accepted,true);
    const captured=observation.capture(request);assert.ok(captured.observer);
    const settled=await handle.done;assert.equal(settled.exitCode,0);
    assert.ok(chunks.join('').includes('command_execution'),'Core original stdout callback retains every JSONL byte');
    assert.deepEqual(captured.observer.facts.commands.map(row=>row.classification),['read-sum','wait-30s']);
    assert.equal(captured.observer.facts.unexpected,false);
    assert.ok(handle.child?.stdout,'The production CLI handle shape itself remains unchanged');
    assert.ok(originalArgs[0]==='-e'&&originalArgs.length===2,'Process arguments are retained');
    return{routedSessionMapExposed:false,ownedNodeProcess:true,originalCallbackPreserved:true,capturedCommands:2,realModelCalls:0};
  }finally{
    await cli.shutdown();observation?.restore();assert.equal(CliAgentProcess.prototype.startSession,originalStart,'Temporary test observer restores the prototype');
    assert.ok(path.basename(root).startsWith('cm-observer-shape-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
