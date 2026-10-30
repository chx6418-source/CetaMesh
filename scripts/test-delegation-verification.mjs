import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {normalizeDelegationVerification,verifyDelegationContract} from '../src/task/delegation-verification.js';
// Direct domain fixtures must satisfy the canonical Workspace-root contract.
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-delegation-verify-')));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
try {
 fs.writeFileSync(path.join(root,'math.mjs'),'original');fs.writeFileSync(path.join(root,'package.json'),'immutable package');fs.writeFileSync(path.join(root,'verify.mjs'),'immutable verification');
 for(const args of [['init','-q',root],['-C',root,'add','.'],['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','baseline']])execFileSync('git',args,{stdio:'ignore'});
 fs.writeFileSync(path.join(root,'math.mjs'),'verified output');
 const contract={kind:'code-tests',operationId:'prepared-tests',acceptanceIds:['acceptance-1'],allowedPaths:['math.mjs'],
  unchangedFiles:['package.json','verify.mjs'].map(file=>({path:file,sha256:hash(file)}))};
 assert.deepEqual(normalizeDelegationVerification(contract,[{id:'acceptance-1'}]),contract);
 assert.throws(()=>normalizeDelegationVerification({...contract,allowedPaths:['../escape']},[{id:'acceptance-1'}]));
 const task={status:'running',currentAgent:{provider:'cetamesh',sessionId:'return'},acceptance:[{id:'acceptance-1',met:false}],
  delegationPolicy:{verification:contract},delegationProposal:{verificationRunId:'verify-run'},executionEvidence:[
   {eventId:'import',capability:'workspace.apply',source:'core-import',status:'completed',changes:[{action:'write',path:'math.mjs',sha256:hash('math.mjs')}]},
   {eventId:'diff',capability:'git.diff',status:'completed',hasChanges:true},
   {eventId:'test',capability:'test.run',source:'core-test',status:'completed',exitCode:0,operationId:'prepared-tests',runId:'verify-run',provider:'cetamesh',sessionId:'return'}]};
 const result=await verifyDelegationContract(task,{workspaceRoot:root});assert.equal(result.status,'VERIFIED');assert.deepEqual(result.machineAcceptanceIds,['acceptance-1']);
 assert.equal(task.acceptance[0].met,false,'verification does not silently mutate authority');
 assert.equal((await verifyDelegationContract({...task,executionEvidence:task.executionEvidence.map(row=>row.source==='core-test'?{...row,source:'agent-report'}:row)},{workspaceRoot:root})).status,'NEEDS_REVIEW','an Agent report is not actual Core test execution');
 assert.equal((await verifyDelegationContract({...task,executionEvidence:task.executionEvidence.map(row=>row.source==='core-test'?{...row,runId:'old-run'}:row)},{workspaceRoot:root})).status,'NEEDS_REVIEW','old run cannot complete the current Task');
 fs.writeFileSync(path.join(root,'verify.mjs'),'tampered verifier');assert.equal((await verifyDelegationContract(task,{workspaceRoot:root})).status,'NEEDS_REVIEW');
 fs.writeFileSync(path.join(root,'verify.mjs'),'immutable verification');fs.writeFileSync(path.join(root,'extra.txt'),'outside scope');assert.equal((await verifyDelegationContract(task,{workspaceRoot:root})).status,'NEEDS_REVIEW');
 fs.rmSync(path.join(root,'extra.txt'));fs.mkdirSync(path.join(root,'新增目录'));fs.writeFileSync(path.join(root,'新增目录','变更.mjs'),'new scoped file');
 const nested='新增目录/变更.mjs',expanded={...task,delegationPolicy:{verification:{...contract,allowedPaths:[...contract.allowedPaths,nested]}},executionEvidence:[{...task.executionEvidence[0],changes:[...task.executionEvidence[0].changes,{action:'write',path:nested,sha256:hash(nested)}]},...task.executionEvidence.slice(1)]};
 assert.equal((await verifyDelegationContract(expanded,{workspaceRoot:root})).status,'VERIFIED','new nested Unicode files are evaluated by actual file paths rather than quoted or collapsed directory names');
 console.log('PASS Owner-bound machine acceptance requires actual Core tests, immutable verifier, scoped current file hashes and current run');
} finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
